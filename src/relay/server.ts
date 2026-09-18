import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";

import { WebSocket, WebSocketServer, type RawData } from "ws";

import type { ControlService } from "../control/service.js";
import type { ControlEnvelope } from "../control/transport.js";
import { formatControlText, parseControlText } from "../protocol/text-format.js";
import type { ControlMessage } from "../protocol/types.js";
import { RelayPairingService } from "./pairing.js";
import {
  MAX_FRAME_BYTES,
  parseRelayFrame,
  serializeRelayFrame,
  type RelayFrame,
} from "./protocol.js";
import { RelayStatusStore } from "./status.js";
import { RelayTokenStore } from "./token-store.js";

export interface RelayServerOptions {
  workspaceId: string;
  controlService: ControlService;
  tokenStore?: RelayTokenStore;
  statusStore?: RelayStatusStore;
}

export interface RelayServerHost {
  server: Server;
  closeWebSockets(): Promise<void>;
}

interface RelayConnectionContext {
  authenticated: boolean;
  extension_id: string | null;
  relay_token: string | null;
  pending: ControlEnvelope | null;
}

const CLIENT_FRAME_TYPES = new Set([
  "hello",
  "keepalive",
  "outbound_sent",
  "assistant_control",
  "tab_heartbeat",
]);
const HTTP_BODY_LIMIT = 8 * 1024;
const PAIRING_RATE_LIMIT = 10;
const PAIRING_RATE_WINDOW_MS = 60_000;
const WORKSPACE_ID_PATTERN = /^ws_[a-f0-9]{16}$/;

function isClientFrame(frame: RelayFrame): boolean {
  return CLIENT_FRAME_TYPES.has(frame.type);
}

function sameIdentity(left: ControlMessage, right: ControlMessage): boolean {
  return (
    left.workspace_id === right.workspace_id &&
    left.task_id === right.task_id &&
    left.iteration === right.iteration
  );
}

function confirmsPending(pending: ControlEnvelope | null, incoming: ControlMessage): boolean {
  if (!pending) return false;
  return (
    pending.message.kind === "EXECUTED" &&
    incoming.kind === "REVIEW" &&
    sameIdentity(pending.message, incoming)
  );
}

function textFromRawData(data: RawData): string {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  return data.toString("utf8");
}

function sendFrame(socket: WebSocket, frame: RelayFrame): void {
  if (socket.readyState === WebSocket.OPEN) socket.send(serializeRelayFrame(frame));
}

function rejectAndClose(socket: WebSocket, code: string, detail: string): void {
  if (socket.readyState !== WebSocket.OPEN) return;
  const frame = serializeRelayFrame({ type: "relay_error", code, detail });
  socket.send(frame, () => socket.close(1008, code.slice(0, 123)));
}

function writeJson(response: ServerResponse, status: number, value: unknown): void {
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.end(JSON.stringify(value));
}

function isLoopbackRemote(request: IncomingMessage): boolean {
  const remote = request.socket.remoteAddress;
  return remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1";
}

function hasProxyHeaders(request: IncomingMessage): boolean {
  return Object.keys(request.headers).some((name) => (
    name === "forwarded" ||
    name === "x-real-ip" ||
    name.startsWith("x-forwarded-")
  ));
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > HTTP_BODY_LIMIT) throw new Error("HTTP_BODY_TOO_LARGE");
    chunks.push(buffer);
  }
  if (size === 0) throw new Error("HTTP_BODY_REQUIRED");
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new Error("HTTP_JSON_INVALID");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function pairingRequest(value: unknown): {
  workspace_id: string;
  code: string;
  extension_id: string;
} | null {
  if (!isRecord(value)) return null;
  const { workspace_id, code, extension_id } = value;
  if (
    typeof workspace_id !== "string" || !WORKSPACE_ID_PATTERN.test(workspace_id) ||
    typeof code !== "string" || code.length !== 8 ||
    typeof extension_id !== "string" || extension_id.length < 1 || extension_id.length > 256
  ) return null;
  return { workspace_id, code, extension_id };
}

function unpairRequest(value: unknown): {
  workspace_id: string;
  extension_id: string;
  token: string;
} | null {
  if (!isRecord(value)) return null;
  const { workspace_id, extension_id, token } = value;
  if (
    typeof workspace_id !== "string" || !WORKSPACE_ID_PATTERN.test(workspace_id) ||
    typeof extension_id !== "string" || extension_id.length < 1 || extension_id.length > 256 ||
    typeof token !== "string" || token.length < 1 || token.length > 256
  ) return null;
  return { workspace_id, extension_id, token };
}

export function createRelayServer(options: RelayServerOptions): RelayServerHost {
  const tokenStore = options.tokenStore ?? new RelayTokenStore();
  const statusStore = options.statusStore ?? new RelayStatusStore();
  const pairingService = new RelayPairingService(tokenStore);
  const pairingRateByRemote = new Map<string, { count: number; resetAt: number }>();
  const pairingRateAllowed = (request: IncomingMessage): boolean => {
    const remote = request.socket.remoteAddress ?? "loopback";
    const now = Date.now();
    const entry = pairingRateByRemote.get(remote);
    if (!entry || now > entry.resetAt) {
      pairingRateByRemote.set(remote, { count: 1, resetAt: now + PAIRING_RATE_WINDOW_MS });
      return true;
    }
    if (entry.count >= PAIRING_RATE_LIMIT) return false;
    entry.count += 1;
    return true;
  };
  const server = createServer((request, response) => {
    void (async () => {
      let pathname: string;
      try {
        pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
      } catch {
        writeJson(response, 400, { error: "INVALID_REQUEST" });
        return;
      }

      if (request.method !== "POST" || (pathname !== "/pair" && pathname !== "/unpair")) {
        writeJson(response, 404, { error: "NOT_FOUND" });
        return;
      }
      if (!isLoopbackRemote(request) || hasProxyHeaders(request)) {
        writeJson(response, 403, { error: "LOOPBACK_ONLY" });
        return;
      }

      let body: unknown;
      try {
        body = await readJsonBody(request);
      } catch {
        writeJson(response, 400, { error: "INVALID_REQUEST" });
        return;
      }

      if (pathname === "/pair") {
        const parsed = pairingRequest(body);
        if (!parsed || parsed.workspace_id !== options.workspaceId) {
          writeJson(response, 400, { error: "INVALID_PAIRING_REQUEST" });
          return;
        }
        if (!pairingRateAllowed(request)) {
          writeJson(response, 429, { error: "PAIRING_RATE_LIMITED" });
          return;
        }
        try {
          const { token } = await pairingService.exchange(
            parsed.workspace_id,
            parsed.code,
            parsed.extension_id,
          );
          writeJson(response, 200, { workspace_id: parsed.workspace_id, token });
        } catch {
          writeJson(response, 401, { error: "PAIRING_REJECTED" });
        }
        return;
      }

      const parsed = unpairRequest(body);
      if (!parsed || parsed.workspace_id !== options.workspaceId) {
        writeJson(response, 400, { error: "INVALID_UNPAIR_REQUEST" });
        return;
      }
      let verified = false;
      try {
        verified = await tokenStore.verify(
          parsed.workspace_id,
          parsed.extension_id,
          parsed.token,
        );
      } catch {
        verified = false;
      }
      if (!verified) {
        writeJson(response, 401, { error: "AUTH_FAILED" });
        return;
      }
      await tokenStore.revokeWorkspace(parsed.workspace_id);
      writeJson(response, 200, { workspace_id: parsed.workspace_id, unpaired: true });
    })().catch(() => {
      if (!response.headersSent) writeJson(response, 500, { error: "RELAY_HTTP_ERROR" });
      else response.end();
    });
  });
  const webSockets = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES });
  const inFlight = new Set<Promise<void>>();
  let closing = false;

  server.on("upgrade", (request, socket, head) => {
    if (closing) {
      socket.destroy();
      return;
    }

    let pathname: string;
    try {
      pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    } catch {
      socket.destroy();
      return;
    }
    if (pathname !== "/relay") {
      socket.destroy();
      return;
    }
    webSockets.handleUpgrade(request, socket, head, (webSocket) => {
      webSockets.emit("connection", webSocket, request);
    });
  });

  webSockets.on("connection", (socket) => {
    const context: RelayConnectionContext = {
      authenticated: false,
      extension_id: null,
      relay_token: null,
      pending: null,
    };
    let chain = Promise.resolve();

    const sendPending = async (): Promise<void> => {
      if (!context.authenticated || context.pending) return;
      const envelope = await options.controlService.next(options.workspaceId);
      if (!envelope) return;
      context.pending = envelope;
      sendFrame(socket, {
        type: "outbound_control",
        workspace_id: options.workspaceId,
        envelope_id: envelope.id,
        text: formatControlText(envelope.message),
      });
    };

    const handleAuthenticated = async (frame: RelayFrame): Promise<void> => {
      if (!context.authenticated || !context.extension_id || !context.relay_token) {
        throw new Error("RELAY_NOT_AUTHENTICATED");
      }
      if (!("workspace_id" in frame) || frame.workspace_id !== options.workspaceId) {
        throw new Error("WORKSPACE_MISMATCH");
      }

      const stillAuthorized = await tokenStore.verify(
        options.workspaceId,
        context.extension_id,
        context.relay_token,
      );
      if (!stillAuthorized) {
        context.authenticated = false;
        context.relay_token = null;
        rejectAndClose(socket, "AUTH_REVOKED", "Relay authorization was revoked");
        return;
      }

      if (frame.type === "keepalive") {
        await sendPending();
        return;
      }

      if (frame.type === "tab_heartbeat") {
        await statusStore.recordTabHeartbeat(
          options.workspaceId,
          context.extension_id,
          frame.conversation_id,
        );
        await sendPending();
        return;
      }

      if (frame.type === "outbound_sent") {
        if (!context.pending || context.pending.id !== frame.envelope_id) {
          throw new Error("OUTBOUND_ENVELOPE_MISMATCH");
        }
        return;
      }

      if (frame.type === "assistant_control") {
        const message = parseControlText(frame.text);
        if (message.workspace_id !== options.workspaceId) {
          throw new Error("WORKSPACE_MISMATCH");
        }

        const duplicate = await statusStore.hasFingerprint(
          options.workspaceId,
          frame.fingerprint,
        );
        if (!duplicate) {
          await options.controlService.ingest(frame.text);
          await statusStore.recordFingerprint(
            options.workspaceId,
            context.extension_id,
            frame.fingerprint,
          );
        }

        if (confirmsPending(context.pending, message)) {
          const pendingId = context.pending?.id;
          if (pendingId) {
            await options.controlService.acknowledgeOutbound(pendingId);
            context.pending = null;
          }
        }

        sendFrame(socket, {
          type: "assistant_ingested",
          workspace_id: options.workspaceId,
          fingerprint: frame.fingerprint,
        });
        return;
      }

      throw new Error("INVALID_CLIENT_FRAME");
    };

    const handleMessage = async (data: RawData, isBinary: boolean): Promise<void> => {
      if (isBinary) {
        rejectAndClose(socket, "BINARY_FRAME_REJECTED", "Relay frames must be UTF-8 text");
        return;
      }

      let frame: RelayFrame;
      try {
        frame = parseRelayFrame(textFromRawData(data));
      } catch {
        rejectAndClose(socket, "INVALID_FRAME", "Relay frame validation failed");
        return;
      }
      if (!isClientFrame(frame)) {
        rejectAndClose(socket, "INVALID_FRAME", "Server relay frames are not accepted from clients");
        return;
      }

      if (!context.authenticated) {
        if (frame.type !== "hello" || frame.workspace_id !== options.workspaceId) {
          rejectAndClose(socket, "AUTH_FAILED", "Relay authentication failed");
          return;
        }
        const verified = await tokenStore.verify(
          options.workspaceId,
          frame.extension_id,
          frame.token,
        );
        if (!verified) {
          rejectAndClose(socket, "AUTH_FAILED", "Relay authentication failed");
          return;
        }
        context.authenticated = true;
        context.extension_id = frame.extension_id;
        context.relay_token = frame.token;
        await statusStore.markAuthenticated(options.workspaceId, frame.extension_id);
        sendFrame(socket, {
          type: "hello_ok",
          workspace_id: options.workspaceId,
          server_time: new Date().toISOString(),
        });
        await sendPending();
        return;
      }

      if (frame.type === "hello") {
        rejectAndClose(socket, "INVALID_FRAME", "Relay is already authenticated");
        return;
      }
      await handleAuthenticated(frame);
    };

    socket.on("message", (data, isBinary) => {
      const task = chain
        .then(() => handleMessage(data, isBinary))
        .catch(() => {
          rejectAndClose(socket, "RELAY_PROTOCOL_ERROR", "Relay message could not be processed");
        });
      chain = task;
      inFlight.add(task);
      void task.finally(() => {
        inFlight.delete(task);
      });
    });
  });

  return {
    server,
    closeWebSockets: async () => {
      closing = true;
      for (const client of webSockets.clients) client.terminate();
      while (inFlight.size > 0) {
        await Promise.allSettled([...inFlight]);
      }
      await new Promise<void>((resolve) => webSockets.close(() => resolve()));
    },
  };
}
