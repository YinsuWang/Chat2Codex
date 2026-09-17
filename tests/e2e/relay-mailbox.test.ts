import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";

import type { WorkspaceRecord } from "../../src/config/types.js";
import { ControlService } from "../../src/control/service.js";
import { formatControlText, parseControlText } from "../../src/protocol/text-format.js";
import type { ExecutedMessage, PlanMessage, ReviewMessage } from "../../src/protocol/types.js";
import { parseRelayFrame, serializeRelayFrame, type RelayFrame } from "../../src/relay/protocol.js";
import { startRelayServer, type RelayRuntime } from "../../src/relay/runtime.js";
import { RelayTokenStore } from "../../src/relay/token-store.js";
import { TaskService } from "../../src/task/service.js";
import { TaskStore } from "../../src/task/store.js";

const WORKSPACE = "ws_0123456789abcdef";
const EXTENSION = "ext-e2e-relay";

let stateDir: string;
let control: ControlService;
let tokenStore: RelayTokenStore;
let runtime: RelayRuntime;
let sockets: WebSocket[];

beforeEach(async () => {
  stateDir = await mkdtemp(join(tmpdir(), "chat2codex-relay-mailbox-"));
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
  for (const socket of sockets) socket.terminate();
  if (runtime.server.listening) await runtime.close();
  delete process.env.CHAT2CODEX_STATE_DIR;
  await rm(stateDir, { recursive: true, force: true });
});

class FrameQueue {
  private readonly received: RelayFrame[] = [];
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
    const queued = this.received.shift();
    if (queued) return queued;
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

async function connectAndAuthenticate(token: string): Promise<{ socket: WebSocket; queue: FrameQueue }> {
  const socket = new WebSocket(`ws://127.0.0.1:${runtime.port}/relay`);
  sockets.push(socket);
  const queue = new FrameQueue(socket);
  await new Promise<void>((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("error", reject);
  });
  socket.send(serializeRelayFrame({
    type: "hello",
    workspace_id: WORKSPACE,
    token,
    extension_id: EXTENSION,
  }));
  expect(await queue.next()).toMatchObject({ type: "hello_ok", workspace_id: WORKSPACE });
  return { socket, queue };
}

async function sendAssistantControl(
  socket: WebSocket,
  queue: FrameQueue,
  text: string,
  fingerprint: string,
): Promise<void> {
  socket.send(serializeRelayFrame({
    type: "assistant_control",
    workspace_id: WORKSPACE,
    text,
    fingerprint,
  }));
  expect(await queue.next()).toEqual({
    type: "assistant_ingested",
    workspace_id: WORKSPACE,
    fingerprint,
  });
}

function expectOutboundExecuted(frame: RelayFrame, envelopeId: string): void {
  expect(frame).toMatchObject({
    type: "outbound_control",
    workspace_id: WORKSPACE,
    envelope_id: envelopeId,
  });
  if (frame.type !== "outbound_control") throw new Error("EXPECTED_OUTBOUND_CONTROL");
  expect(parseControlText(frame.text)).toEqual(executed);
}

function workspace(): WorkspaceRecord {
  return {
    workspace_id: WORKSPACE,
    workspace_name: "Relay E2E",
    machine: "test",
    root: stateDir,
    git_root: stateDir,
    git_remote: null,
    created_at: new Date(0).toISOString(),
    policy: { allow_current_working_tree: false },
  };
}

async function consumeInbound(taskService: TaskService): Promise<void> {
  const envelope = await control.receiveInbound();
  expect(envelope).not.toBeNull();
  if (!envelope) throw new Error("EXPECTED_INBOUND_CONTROL");
  await taskService.acceptControlMessage(envelope.message);
  await control.acknowledgeInbound(envelope.id);
}

const plan: PlanMessage = {
  kind: "PLAN",
  workspace_id: WORKSPACE,
  task_id: "task_relay_plan",
  iteration: 1,
  implementation_mode: "guided",
  goal: "verify durable relay",
  instructions: ["preserve mailbox semantics"],
  constraints: [],
  acceptance_criteria: ["one logical PLAN transition"],
};

const executed: ExecutedMessage = {
  kind: "EXECUTED",
  workspace_id: WORKSPACE,
  task_id: "task_relay_review",
  iteration: 1,
  exit_code: 0,
  changed_files: 1,
  tests_summary: "relay e2e passed",
};

const review: ReviewMessage = {
  kind: "REVIEW",
  workspace_id: WORKSPACE,
  task_id: "task_relay_review",
  iteration: 1,
  decision: "PASS",
  findings: [],
};

describe("durable mailbox relay E2E", () => {
  it("keeps a chat-first PLAN to one logical PLANNED transition across replay", async () => {
    const token = await tokenStore.issue(WORKSPACE, EXTENSION);
    const taskStore = new TaskStore();
    const taskService = new TaskService(taskStore, workspace());
    const first = await connectAndAuthenticate(token);

    await sendAssistantControl(
      first.socket,
      first.queue,
      formatControlText(plan),
      "sha256:e2e-plan-replay",
    );
    await consumeInbound(taskService);

    const planned = await taskStore.get(plan.task_id);
    expect(planned.state).toBe("PLANNED");
    expect(planned.history.filter((entry) => entry.to === "PLANNED")).toHaveLength(1);

    first.socket.terminate();
    const second = await connectAndAuthenticate(token);
    await sendAssistantControl(
      second.socket,
      second.queue,
      formatControlText(plan),
      "sha256:e2e-plan-replay",
    );

    expect(await control.receiveInbound()).toBeNull();
    const replayed = await taskStore.get(plan.task_id);
    expect(replayed.state).toBe("PLANNED");
    expect(replayed.history.filter((entry) => entry.to === "PLANNED")).toHaveLength(1);
  });

  it("redelivers EXECUTED after reconnect and acknowledges it only after matching REVIEW", async () => {
    const envelope = await control.publishOutbound(executed);
    const token = await tokenStore.issue(WORKSPACE, EXTENSION);
    const first = await connectAndAuthenticate(token);

    expectOutboundExecuted(await first.queue.next(), envelope.id);
    first.socket.send(serializeRelayFrame({
      type: "outbound_sent",
      workspace_id: WORKSPACE,
      envelope_id: envelope.id,
    }));
    expect((await control.next())?.id).toBe(envelope.id);

    first.socket.terminate();
    const second = await connectAndAuthenticate(token);
    expectOutboundExecuted(await second.queue.next(), envelope.id);

    await sendAssistantControl(
      second.socket,
      second.queue,
      formatControlText(review),
      "sha256:e2e-review-pass",
    );

    expect(await control.next()).toBeNull();
    const inbound = await control.receiveInbound();
    expect(inbound?.message).toEqual(review);
  });

  it("survives extension memory loss with one logical transition when replay happens before mailbox consumption", async () => {
    const token = await tokenStore.issue(WORKSPACE, EXTENSION);
    const taskStore = new TaskStore();
    const taskService = new TaskService(taskStore, workspace());
    const first = await connectAndAuthenticate(token);
    const fingerprint = "sha256:e2e-service-worker-restart";

    await sendAssistantControl(first.socket, first.queue, formatControlText(plan), fingerprint);
    first.socket.terminate();

    const restarted = await connectAndAuthenticate(token);
    await sendAssistantControl(restarted.socket, restarted.queue, formatControlText(plan), fingerprint);

    await consumeInbound(taskService);
    expect(await control.receiveInbound()).toBeNull();
    const task = await taskStore.get(plan.task_id);
    expect(task.state).toBe("PLANNED");
    expect(task.history.filter((entry) => entry.to === "PLANNED")).toHaveLength(1);
  });
});
