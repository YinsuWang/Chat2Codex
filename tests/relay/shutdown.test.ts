import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import WebSocket from "ws";

import { ControlService } from "../../src/control/service.js";
import { parseRelayFrame, serializeRelayFrame } from "../../src/relay/protocol.js";
import { startRelayServer } from "../../src/relay/runtime.js";
import { RelayStatusStore } from "../../src/relay/status.js";
import { RelayTokenStore } from "../../src/relay/token-store.js";

const WORKSPACE = "ws_0123456789abcdef";
const EXTENSION = "ext-test";

class BlockingStatusStore extends RelayStatusStore {
  private heartbeatStartedResolve!: () => void;
  private heartbeatReleaseResolve!: () => void;
  readonly heartbeatStarted = new Promise<void>((resolve) => {
    this.heartbeatStartedResolve = resolve;
  });
  private readonly heartbeatRelease = new Promise<void>((resolve) => {
    this.heartbeatReleaseResolve = resolve;
  });

  releaseHeartbeat(): void {
    this.heartbeatReleaseResolve();
  }

  override async recordHeartbeat(
    workspaceId: string,
    extensionId: string,
    conversationId: string | null,
  ): Promise<void> {
    this.heartbeatStartedResolve();
    await this.heartbeatRelease;
    await super.recordHeartbeat(workspaceId, extensionId, conversationId);
  }
}

function openSocket(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    socket.once("open", () => resolve(socket));
    socket.once("error", reject);
  });
}

function nextFrame(socket: WebSocket): Promise<ReturnType<typeof parseRelayFrame>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("FRAME_TIMEOUT")), 1000);
    socket.once("message", (data, isBinary) => {
      clearTimeout(timer);
      if (isBinary) {
        reject(new Error("UNEXPECTED_BINARY_FRAME"));
        return;
      }
      resolve(parseRelayFrame(data.toString()));
    });
  });
}

it("waits for an in-flight authenticated frame before relay close resolves", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "chat2codex-relay-shutdown-"));
  process.env.CHAT2CODEX_STATE_DIR = stateDir;
  const control = new ControlService(WORKSPACE, stateDir);
  const tokenStore = new RelayTokenStore();
  const statusStore = new BlockingStatusStore(stateDir);
  const token = await tokenStore.issue(WORKSPACE, EXTENSION);
  const runtime = await startRelayServer({
    workspaceId: WORKSPACE,
    controlService: control,
    tokenStore,
    statusStore,
    port: 0,
  });
  let socket: WebSocket | null = null;

  try {
    socket = await openSocket(`ws://127.0.0.1:${runtime.port}/relay`);
    const hello = nextFrame(socket);
    socket.send(
      serializeRelayFrame({
        type: "hello",
        workspace_id: WORKSPACE,
        token,
        extension_id: EXTENSION,
      }),
    );
    expect(await hello).toMatchObject({ type: "hello_ok", workspace_id: WORKSPACE });

    socket.send(
      serializeRelayFrame({
        type: "tab_heartbeat",
        workspace_id: WORKSPACE,
        conversation_id: "chat-closing",
      }),
    );
    await statusStore.heartbeatStarted;

    const closing = runtime.close();
    const closeOutcome = await Promise.race([
      closing.then(() => "closed" as const),
      new Promise<"blocked">((resolve) => setTimeout(() => resolve("blocked"), 75)),
    ]);

    statusStore.releaseHeartbeat();
    await closing;

    expect(closeOutcome).toBe("blocked");
    expect((await statusStore.get(WORKSPACE))?.conversation_id).toBe("chat-closing");
  } finally {
    statusStore.releaseHeartbeat();
    socket?.terminate();
    if (runtime.server.listening) await runtime.close();
    delete process.env.CHAT2CODEX_STATE_DIR;
    await rm(stateDir, { recursive: true, force: true });
  }
});
