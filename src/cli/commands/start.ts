import { Command } from "commander";

import { startBridge } from "../../bridge/runtime.js";
import { CodexCLIAdapter } from "../../codex/cli-adapter.js";
import { startDaemon } from "../../supervisor/daemon.js";
import { Supervisor } from "../../supervisor/supervisor.js";
import { findWorkspaceByRoot } from "../../workspace/registry.js";

export function createStartCommand(): Command {
  return new Command("start")
    .description("Start the Chat2Codex Supervisor and read-only MCP bridge")
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
          const bridge = await startBridge({ workspace });
          if (options.json) {
            process.stdout.write(
              `${JSON.stringify({
                workspace_id: workspace.workspace_id,
                status: "starting",
                bridge_host: bridge.host,
                bridge_port: bridge.port,
              })}\n`,
            );
          }
          return () => bridge.close();
        },
      });
    });
}
