import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import type { ControlService } from "../../src/control/service.js";
import type { WorkspaceRecord } from "../../src/config/types.js";
import {
  startRuntimeServices,
  type StartRuntimeServiceDependencies,
} from "../../src/cli/commands/start.js";
import { startDaemon } from "../../src/supervisor/daemon.js";

const workspace: WorkspaceRecord = {
  workspace_id: "ws_0123456789abcdef",
  workspace_name: "test-workspace",
  machine: "test-machine",
  root: "/tmp/test-workspace",
  git_root: "/tmp/test-workspace",
  git_remote: null,
  created_at: "2026-09-14T00:00:00.000Z",
  policy: { allow_current_working_tree: false },
};

function dependencySet(events: string[]): StartRuntimeServiceDependencies {
  return {
    startBridge: async () => {
      events.push("bridge-start");
      return {
        host: "127.0.0.1",
        port: 41001,
        close: async () => {
          events.push("bridge-close");
        },
      };
    },
    startRelayServer: async () => {
      events.push("relay-start");
      return {
        host: "127.0.0.1",
        port: 41002,
        close: async () => {
          events.push("relay-close");
        },
      };
    },
  };
}

describe("start relay lifecycle", () => {
  it("starts bridge then relay and closes relay before bridge", async () => {
    const events: string[] = [];
    const services = await startRuntimeServices(
      workspace,
      {} as ControlService,
      dependencySet(events),
    );

    expect(events).toEqual(["bridge-start", "relay-start"]);
    expect(services.bridge).toMatchObject({ host: "127.0.0.1", port: 41001 });
    expect(services.relay).toMatchObject({ host: "127.0.0.1", port: 41002 });

    await services.close();
    expect(events).toEqual([
      "bridge-start",
      "relay-start",
      "relay-close",
      "bridge-close",
    ]);
  });

  it("closes an already-started bridge when relay startup fails", async () => {
    const events: string[] = [];
    const dependencies = dependencySet(events);
    dependencies.startRelayServer = async () => {
      events.push("relay-start");
      throw new Error("RELAY_START_FAILED");
    };

    await expect(
      startRuntimeServices(workspace, {} as ControlService, dependencies),
    ).rejects.toThrow(/RELAY_START_FAILED/);
    expect(events).toEqual(["bridge-start", "relay-start", "bridge-close"]);
  });

  it("runs integrated cleanup when the Supervisor loop exits with an error", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "c2c-start-relay-state-"));
    process.env.CHAT2CODEX_STATE_DIR = stateDir;
    const events: string[] = [];
    const services = await startRuntimeServices(
      workspace,
      {} as ControlService,
      dependencySet(events),
    );
    const fakeSupervisor = {
      workspace,
      recoverInterruptedTasks: async () => {
        throw new Error("SUPERVISOR_LOOP_FAILED");
      },
      tick: async () => undefined,
    } as unknown as Parameters<typeof startDaemon>[0];

    try {
      await expect(
        startDaemon(fakeSupervisor, {
          onAcquired: async () => services.close,
        }),
      ).rejects.toThrow(/SUPERVISOR_LOOP_FAILED/);
      expect(events).toEqual([
        "bridge-start",
        "relay-start",
        "relay-close",
        "bridge-close",
      ]);
    } finally {
      delete process.env.CHAT2CODEX_STATE_DIR;
      await rm(stateDir, { recursive: true, force: true });
    }
  });
});
