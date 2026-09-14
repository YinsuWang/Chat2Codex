import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ControlService } from "../../src/control/service.js";
import {
  getRelayRuntime,
  startRelayServer,
} from "../../src/relay/runtime.js";
import { RelayTokenStore } from "../../src/relay/token-store.js";

const WORKSPACE = "ws_0123456789abcdef";
let stateDir: string;

beforeEach(async () => {
  stateDir = await mkdtemp(join(tmpdir(), "chat2codex-relay-runtime-"));
  process.env.CHAT2CODEX_STATE_DIR = stateDir;
});

afterEach(async () => {
  delete process.env.CHAT2CODEX_STATE_DIR;
  await rm(stateDir, { recursive: true, force: true });
});

describe("relay runtime", () => {
  it("binds loopback, persists validated runtime metadata, and removes only its own state", async () => {
    const runtime = await startRelayServer({
      workspaceId: WORKSPACE,
      controlService: new ControlService(WORKSPACE, stateDir),
      tokenStore: new RelayTokenStore(),
      port: 0,
    });

    try {
      expect(runtime.host).toBe("127.0.0.1");
      expect(runtime.port).toBeGreaterThan(0);
      expect(await getRelayRuntime(WORKSPACE)).toMatchObject({
        workspace_id: WORKSPACE,
        host: "127.0.0.1",
        port: runtime.port,
        pid: process.pid,
      });
    } finally {
      await runtime.close();
    }

    expect(await getRelayRuntime(WORKSPACE)).toBeNull();
  });
});
