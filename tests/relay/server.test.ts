import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";

import { ControlService } from "../../src/control/service.js";
import { formatControlText, parseControlText } from "../../src/protocol/text-format.js";
import type { ExecutedMessage, PlanMessage, ReviewMessage } from "../../src/protocol/types.js";
import { RelayPairingService } from "../../src/relay/pairing.js";
import { parseRelayFrame, serializeRelayFrame, type RelayFrame } from "../../src/relay/protocol.js";
import { startRelayServer, type RelayRuntime } from "../../src/relay/runtime.js";
import { RelayStatusStore, type RelayStatusState } from "../../src/relay/status.js";
import { RelayTokenStore } from "../../src/relay/token-store.js";

const WORKSPACE = "ws_0123456789abcdef";
const EXTENSION = "ext-test";

let stateDir: string;
let control: ControlService;
let tokenStore: RelayTokenStore;
let runtime: RelayRuntime;
let sockets: WebSocket[];

beforeEach(async () => {
  stateDir = await mkdtemp(join(tmpdir(), "chat2codex-relay-server-"));
  process.env.CHAT2CODEX_STATE_DIR = stateDir;
  control = new ControlService(WORKSPACE, stateDir);
  tokenStore = new RelayTokenStore();
  sockets = [];
  runtime = await startRelayServer({
    workspaceId: WORKSPACE,
    controlService: control,
    tokenStore,
    port: 0,
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const socket of sockets) socket.terminate();
  if (runtime.server.listening) await runtime.close();
  delete process.env.CHAT2CODEX_STATE_DIR;
  await rm(stateDir, { recursive: true, force: true });
});

function connect(): Promise<{ socket: WebSocket; queue: FrameQueue }> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${runtime.port}/relay`);
    sockets.push(socket);
    const queue = new FrameQueue(socket);
    socket.once("open", () => resolve({ socket, queue }));
    socket.once("error", reject);
  });
}

async function authenticate(socket: WebSocket, queue: FrameQueue, token: string): Promise<void> {
  socket.send(
    serializeRelayFrame({
      type: "hello",
      workspace_id: WORKSPACE,
      token,
      extension_id: EXTENSION,
    }),
  );
  expect(await queue.next()).toMatchObject({ type: "hello_ok", workspace_id: WORKSPACE });
}

async function postJson(
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  return fetch(`http://127.0.0.1:${runtime.port}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

async function waitForConversation(
  conversationId: string,
  timeoutMs = 1000,
): Promise<RelayStatusState> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = await new RelayStatusStore().get(WORKSPACE);
    if (status?.conversation_id === conversationId) return status;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`HEARTBEAT_STATUS_TIMEOUT: ${conversationId}`);
}

class FrameQueue {
  readonly received: RelayFrame[] = [];
  private readonly waiters: Array<(frame: RelayFrame) => void> = [];

  constructor(socket: WebSocket) {
    socket.on("message", (data, isBinary) => {
      if (isBinary) return;
      const frame = parseRelayFrame(data.toString());
      const waiter = this.waiters.shift();
      if (waiter) waiter(frame);
      else this.received.push(frame);
    });
  }

  async next(timeoutMs = 1000): Promise<RelayFrame> {
    const already = this.received.shift();
    if (already) return already;
    return new Promise<RelayFrame>((resolve, reject) => {
      const waiter = (frame: RelayFrame) => {
        clearTimeout(timer);
        resolve(frame);
      };
      const timer = setTimeout(() => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(new Error("FRAME_TIMEOUT"));
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }
}

const executed: ExecutedMessage = {
  kind: "EXECUTED",
  workspace_id: WORKSPACE,
  task_id: "task_001",
  iteration: 1,
  exit_code: 0,
  changed_files: 2,
  tests_summary: "2 passed",
};

const review: ReviewMessage = {
  kind: "REVIEW",
  workspace_id: WORKSPACE,
  task_id: "task_001",
  iteration: 1,
  decision: "PASS",
  findings: [],
};

const plan: PlanMessage = {
  kind: "PLAN",
  workspace_id: WORKSPACE,
  task_id: "task_chat_first",
  iteration: 1,
  implementation_mode: "guided",
  goal: "change greeting",
  instructions: ["implement safely"],
  constraints: [],
  acceptance_criteria: ["tests pass"],
};

describe("loopback relay server", () => {
  it("does not expose outbound mailbox data before authentication", async () => {
    await control.publishOutbound(executed);
    const { queue } = await connect();
    await new Promise((resolve) => setTimeout(resolve, 75));
    expect(queue.received).toHaveLength(0);
  });

  it("rejects a wrong relay token and closes the client", async () => {
    await tokenStore.issue(WORKSPACE, EXTENSION);
    const { socket, queue } = await connect();
    socket.send(
      serializeRelayFrame({
        type: "hello",
        workspace_id: WORKSPACE,
        token: "wrong-token",
        extension_id: EXTENSION,
      }),
    );

    expect(await queue.next()).toMatchObject({ type: "relay_error", code: "AUTH_FAILED" });
    await new Promise<void>((resolve) => socket.once("close", () => resolve()));
  });

  it("rejects an already-authenticated session on the first frame after unpair", async () => {
    const token = await tokenStore.issue(WORKSPACE, EXTENSION);
    const { socket, queue } = await connect();
    await authenticate(socket, queue, token);
    await tokenStore.revokeWorkspace(WORKSPACE);

    socket.send(
      serializeRelayFrame({
        type: "keepalive",
        workspace_id: WORKSPACE,
        at: new Date().toISOString(),
      }),
    );

    expect(await queue.next()).toMatchObject({ type: "relay_error", code: "AUTH_REVOKED" });
    await new Promise<void>((resolve) => socket.once("close", () => resolve()));
  });

  it("delivers the durable outbound envelope semantically but does not ack on outbound_sent", async () => {
    const envelope = await control.publishOutbound(executed);
    const token = await tokenStore.issue(WORKSPACE, EXTENSION);
    const { socket, queue } = await connect();
    await authenticate(socket, queue, token);

    const delivered = await queue.next();
    expect(delivered).toMatchObject({
      type: "outbound_control",
      workspace_id: WORKSPACE,
      envelope_id: envelope.id,
    });
    if (delivered.type !== "outbound_control") throw new Error("expected outbound_control");
    expect(parseControlText(delivered.text)).toEqual(executed);

    socket.send(
      serializeRelayFrame({
        type: "outbound_sent",
        workspace_id: WORKSPACE,
        envelope_id: envelope.id,
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect((await control.next())?.id).toBe(envelope.id);
  });

  it("ingests chat-first PLAN exactly once for a duplicate fingerprint", async () => {
    const token = await tokenStore.issue(WORKSPACE, EXTENSION);
    const { socket, queue } = await connect();
    await authenticate(socket, queue, token);
    const frame = {
      type: "assistant_control" as const,
      workspace_id: WORKSPACE,
      text: formatControlText(plan),
      fingerprint: "sha256:plan-1",
    };

    socket.send(serializeRelayFrame(frame));
    expect(await queue.next()).toEqual({
      type: "assistant_ingested",
      workspace_id: WORKSPACE,
      fingerprint: frame.fingerprint,
    });
    const first = await control.receiveInbound();
    expect(first?.message).toEqual(plan);

    socket.send(serializeRelayFrame(frame));
    expect(await queue.next()).toEqual({
      type: "assistant_ingested",
      workspace_id: WORKSPACE,
      fingerprint: frame.fingerprint,
    });
    if (!first) throw new Error("expected inbound PLAN");
    await control.acknowledgeInbound(first.id);
    expect(await control.receiveInbound()).toBeNull();
  });

  it("acks pending EXECUTED only after a matching assistant REVIEW is ingested", async () => {
    const envelope = await control.publishOutbound(executed);
    const token = await tokenStore.issue(WORKSPACE, EXTENSION);
    const { socket, queue } = await connect();
    await authenticate(socket, queue, token);
    expect(await queue.next()).toMatchObject({ type: "outbound_control", envelope_id: envelope.id });

    socket.send(
      serializeRelayFrame({
        type: "outbound_sent",
        workspace_id: WORKSPACE,
        envelope_id: envelope.id,
      }),
    );
    expect((await control.next())?.id).toBe(envelope.id);

    socket.send(
      serializeRelayFrame({
        type: "assistant_control",
        workspace_id: WORKSPACE,
        text: formatControlText(review),
        fingerprint: "sha256:review-1",
      }),
    );
    expect(await queue.next()).toMatchObject({
      type: "assistant_ingested",
      fingerprint: "sha256:review-1",
    });
    expect(await control.next()).toBeNull();
    expect((await control.receiveInbound())?.message).toEqual(review);
  });

  it("records tab heartbeat without putting browser data in the control mailbox", async () => {
    const token = await tokenStore.issue(WORKSPACE, EXTENSION);
    const { socket, queue } = await connect();
    await authenticate(socket, queue, token);
    socket.send(
      serializeRelayFrame({
        type: "tab_heartbeat",
        workspace_id: WORKSPACE,
        conversation_id: "chat-123",
      }),
    );

    expect(await waitForConversation("chat-123")).toMatchObject({
      workspace_id: WORKSPACE,
      extension_id: EXTENSION,
      conversation_id: "chat-123",
    });
    expect(await control.receiveInbound()).toBeNull();
  });

  it("rejects binary WebSocket frames", async () => {
    const token = await tokenStore.issue(WORKSPACE, EXTENSION);
    const { socket, queue } = await connect();
    await authenticate(socket, queue, token);
    socket.send(Buffer.from("not-text"));

    expect(await queue.next()).toMatchObject({ type: "relay_error", code: "BINARY_FRAME_REJECTED" });
    await new Promise<void>((resolve) => socket.once("close", () => resolve()));
  });

  it("exchanges a one-time pairing code through POST /pair", async () => {
    const pairing = new RelayPairingService(tokenStore);
    const session = await pairing.create(WORKSPACE);

    const response = await postJson("/pair", {
      workspace_id: WORKSPACE,
      code: session.code,
      extension_id: EXTENSION,
    });
    expect(response.status).toBe(200);
    const payload = await response.json() as { workspace_id: string; token: string };
    expect(payload.workspace_id).toBe(WORKSPACE);
    expect(payload.token.length).toBeGreaterThanOrEqual(43);
    expect(await tokenStore.verify(WORKSPACE, EXTENSION, payload.token)).toBe(true);

    const replay = await postJson("/pair", {
      workspace_id: WORKSPACE,
      code: session.code,
      extension_id: EXTENSION,
    });
    expect(replay.status).toBe(401);
  });

  it("rejects proxy headers without consuming the pairing code", async () => {
    const pairing = new RelayPairingService(tokenStore);
    const session = await pairing.create(WORKSPACE);

    const proxied = await postJson("/pair", {
      workspace_id: WORKSPACE,
      code: session.code,
      extension_id: EXTENSION,
    }, { "x-forwarded-for": "203.0.113.7" });
    expect(proxied.status).toBe(403);

    const direct = await postJson("/pair", {
      workspace_id: WORKSPACE,
      code: session.code,
      extension_id: EXTENSION,
    });
    expect(direct.status).toBe(200);
  });

  it("enforces pairing attempt exhaustion through the HTTP surface", async () => {
    const pairing = new RelayPairingService(tokenStore);
    const session = await pairing.create(WORKSPACE);

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await postJson("/pair", {
        workspace_id: WORKSPACE,
        code: "AAAAAAAA",
        extension_id: EXTENSION,
      });
      expect(response.status).toBe(401);
    }

    const exhausted = await postJson("/pair", {
      workspace_id: WORKSPACE,
      code: session.code,
      extension_id: EXTENSION,
    });
    expect(exhausted.status).toBe(401);
  });

  it("enforces pairing TTL through the HTTP surface", async () => {
    const pairing = new RelayPairingService(tokenStore);
    const session = await pairing.create(WORKSPACE);
    const realNow = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(realNow + 5 * 60 * 1000 + 1);

    const response = await postJson("/pair", {
      workspace_id: WORKSPACE,
      code: session.code,
      extension_id: EXTENSION,
    });
    expect(response.status).toBe(401);
  });

  it("revokes workspace authorization through authenticated POST /unpair", async () => {
    const token = await tokenStore.issue(WORKSPACE, EXTENSION);

    const rejected = await postJson("/unpair", {
      workspace_id: WORKSPACE,
      extension_id: EXTENSION,
      token: "wrong-token",
    });
    expect(rejected.status).toBe(401);
    expect(await tokenStore.verify(WORKSPACE, EXTENSION, token)).toBe(true);

    const response = await postJson("/unpair", {
      workspace_id: WORKSPACE,
      extension_id: EXTENSION,
      token,
    });
    expect(response.status).toBe(200);
    expect(await tokenStore.verify(WORKSPACE, EXTENSION, token)).toBe(false);
  });
});
