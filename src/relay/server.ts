import { createServer, type Server } from "node:http";

import { WebSocket, WebSocketServer, type RawData } from "ws";

import type { ControlService } from "../control/service.js";
import type { ControlEnvelope } from "../control/transport.js";
import { formatControlText, parseControlText } from "../protocol/text-format.js";
import type { ControlMessage } from "../protocol/types.js";
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

export function createRelayServer(options: RelayServerOptions): RelayServerHost {
  const tokenStore = options.tokenStore ?? new RelayTokenStore();
  const statusStore = options.statusStore ?? new RelayStatusStore();
  const server = createServer((_request, response) => {
    response.statusCode = 404;
    response.setHeader("content-type", "application/json; charset=utf-8");
    response.end(JSON.stringify({ error: "NOT_FOUND" }));
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
        await statusStore.recordHeartbeat(options.workspaceId, context.extension_id, null);
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
