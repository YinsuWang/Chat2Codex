import { Command } from "commander";

import { startBridge as startBridgeRuntime } from "../../bridge/runtime.js";
import { CodexCLIAdapter } from "../../codex/cli-adapter.js";
import type { WorkspaceRecord } from "../../config/types.js";
import type { ControlService } from "../../control/service.js";
import { startRelayServer as startRelayRuntime } from "../../relay/runtime.js";
import { startDaemon } from "../../supervisor/daemon.js";
import { Supervisor } from "../../supervisor/supervisor.js";
import { findWorkspaceByRoot } from "../../workspace/registry.js";

export interface RuntimeServiceHandle {
  host: "127.0.0.1";
  port: number;
  close(): Promise<void>;
}

export interface StartRuntimeServiceDependencies {
  startBridge?: (options: { workspace: WorkspaceRecord }) => Promise<RuntimeServiceHandle>;
  startRelayServer?: (options: {
    workspaceId: string;
    controlService: ControlService;
  }) => Promise<RuntimeServiceHandle>;
}

export interface RuntimeServices {
  bridge: RuntimeServiceHandle;
  relay: RuntimeServiceHandle;
  close(): Promise<void>;
}

const defaultRuntimeDependencies: Required<StartRuntimeServiceDependencies> = {
  startBridge: async ({ workspace }) => startBridgeRuntime({ workspace }),
  startRelayServer: async ({ workspaceId, controlService }) =>
    startRelayRuntime({ workspaceId, controlService }),
};

export async function startRuntimeServices(
  workspace: WorkspaceRecord,
  controlService: ControlService,
  dependencies: StartRuntimeServiceDependencies = {},
): Promise<RuntimeServices> {
  const startBridge = dependencies.startBridge ?? defaultRuntimeDependencies.startBridge;
  const startRelayServer =
    dependencies.startRelayServer ?? defaultRuntimeDependencies.startRelayServer;

  const bridge = await startBridge({ workspace });
  let relay: RuntimeServiceHandle;
  try {
    relay = await startRelayServer({
      workspaceId: workspace.workspace_id,
      controlService,
    });
  } catch (error) {
    await bridge.close();
    throw error;
  }

  let closed = false;
  return {
    bridge,
    relay,
    close: async () => {
      if (closed) return;
      closed = true;
      try {
        await relay.close();
      } finally {
        await bridge.close();
      }
    },
  };
}

export function createStartCommand(): Command {
  return new Command("start")
    .description("Start the Chat2Codex Supervisor, MCP bridge, and browser relay")
    .option("-w, --workspace <path>", "workspace path", process.cwd())
    .option("--json", "emit startup information as JSON")
    .action(async (options: { workspace: string; json?: boolean }) => {
      const workspace = await findWorkspaceByRoot(options.workspace);
      if (!workspace) throw new Error("WORKSPACE_NOT_REGISTERED");
      const supervisor = new Supervisor(workspace, {
        codexAdapter: new CodexCLIAdapter(),
      });

      await startDaemon(supervisor, {
        onAcquired: async () => {
          const services = await startRuntimeServices(workspace, supervisor.controlService);
          if (options.json) {
            process.stdout.write(
              `${JSON.stringify({
                workspace_id: workspace.workspace_id,
                status: "starting",
                bridge_host: services.bridge.host,
                bridge_port: services.bridge.port,
                relay_host: services.relay.host,
                relay_port: services.relay.port,
              })}\n`,
            );
          }
          return services.close;
        },
      });
    });
}
