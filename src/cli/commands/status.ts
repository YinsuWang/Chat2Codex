import { Command } from "commander";

import { getBridgeRuntime } from "../../bridge/runtime.js";
import { getDaemonLock } from "../../supervisor/daemon.js";
import { TaskStore } from "../../task/store.js";
import { findWorkspaceByRoot } from "../../workspace/registry.js";

export function createStatusCommand(): Command {
  return new Command("status")
    .description("Show Chat2Codex workspace and task status")
    .option("-w, --workspace <path>", "workspace path", process.cwd())
    .option("--json", "emit JSON")
    .action(async (options: { workspace: string; json?: boolean }) => {
      const workspace = await findWorkspaceByRoot(options.workspace);
      if (!workspace) throw new Error("WORKSPACE_NOT_REGISTERED");
      const tasks = (await new TaskStore().list()).filter(
        (task) => task.workspace_id === workspace.workspace_id,
      );
      const active =
        tasks
          .filter((task) => !["DONE", "FAILED", "CANCELLED"].includes(task.state))
          .sort((a, b) => b.updated_at.localeCompare(a.updated_at))[0] ?? null;
      const [lock, bridge] = await Promise.all([
        getDaemonLock(workspace.workspace_id),
        getBridgeRuntime(workspace.workspace_id),
      ]);
      const result = {
        workspace_id: workspace.workspace_id,
        workspace_name: workspace.workspace_name,
        daemon_pid: lock?.pid ?? null,
        bridge: bridge ? { host: bridge.host, port: bridge.port, pid: bridge.pid } : null,
        active_task: active
          ? { task_id: active.task_id, state: active.state, iteration: active.iteration }
          : null,
      };
      if (options.json) {
        process.stdout.write(`${JSON.stringify(result)}\n`);
      } else {
        process.stdout.write(
          `${workspace.workspace_name} (${workspace.workspace_id})\n` +
            `Daemon: ${result.daemon_pid ?? "stopped"}\n` +
            `Bridge: ${bridge ? `${bridge.host}:${bridge.port}` : "stopped"}\n` +
            `Task: ${active ? `${active.task_id} ${active.state} #${active.iteration}` : "none"}\n`,
        );
      }
    });
}
