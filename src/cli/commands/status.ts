import { Command } from "commander";

import { getBridgeRuntime } from "../../bridge/runtime.js";
import { getRelayRuntime } from "../../relay/runtime.js";
import { RelayStatusStore } from "../../relay/status.js";
import { RelayTokenStore } from "../../relay/token-store.js";
import { getDaemonLock } from "../../supervisor/daemon.js";
import { TaskStore } from "../../task/store.js";
import { findWorkspaceByRoot } from "../../workspace/registry.js";

export async function getWorkspaceStatus(workspacePath: string) {
  const workspace = await findWorkspaceByRoot(workspacePath);
  if (!workspace) throw new Error("WORKSPACE_NOT_REGISTERED");
  const tasks = (await new TaskStore().list()).filter(
    (task) => task.workspace_id === workspace.workspace_id,
  );
  const active =
    tasks
      .filter((task) => !["DONE", "FAILED", "CANCELLED"].includes(task.state))
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at))[0] ?? null;
  const [lock, bridge, relayRuntime, relayAuthorization, relayStatus] = await Promise.all([
    getDaemonLock(workspace.workspace_id),
    getBridgeRuntime(workspace.workspace_id),
    getRelayRuntime(workspace.workspace_id),
    new RelayTokenStore().status(workspace.workspace_id),
    new RelayStatusStore().get(workspace.workspace_id),
  ]);
  const activeReason = active?.history.at(-1)?.reason ?? null;
  return {
    workspace_id: workspace.workspace_id,
    workspace_name: workspace.workspace_name,
    daemon_pid: lock?.pid ?? null,
    bridge: bridge ? { host: bridge.host, port: bridge.port, pid: bridge.pid } : null,
    relay: relayRuntime
      ? {
          host: relayRuntime.host,
          port: relayRuntime.port,
          pid: relayRuntime.pid,
          paired: relayAuthorization.paired,
          bound_tab_seen: relayStatus?.bound_tab_seen ?? false,
          last_heartbeat_at: relayStatus?.last_heartbeat_at ?? null,
        }
      : null,
    active_task: active
      ? {
          task_id: active.task_id,
          state: active.state,
          iteration: active.iteration,
          reason: activeReason,
        }
      : null,
  };
}

export function createStatusCommand(): Command {
  return new Command("status")
    .description("Show Chat2Codex workspace and task status")
    .option("-w, --workspace <path>", "workspace path", process.cwd())
    .option("--json", "emit JSON")
    .action(async (options: { workspace: string; json?: boolean }) => {
      const result = await getWorkspaceStatus(options.workspace);
      if (options.json) {
        process.stdout.write(`${JSON.stringify(result)}\n`);
      } else {
        const reason = result.active_task?.reason ? ` (${result.active_task.reason})` : "";
        process.stdout.write(
          `${result.workspace_name} (${result.workspace_id})\n` +
            `Daemon: ${result.daemon_pid ?? "stopped"}\n` +
            `Bridge: ${result.bridge ? `${result.bridge.host}:${result.bridge.port}` : "stopped"}\n` +
            `Relay: ${
              result.relay
                ? `${result.relay.host}:${result.relay.port} ` +
                  `[${result.relay.paired ? "paired" : "unpaired"}, ${result.relay.bound_tab_seen ? "tab seen" : "no tab"}]`
                : "stopped"
            }\n` +
            `Task: ${
              result.active_task
                ? `${result.active_task.task_id} ${result.active_task.state} #${result.active_task.iteration}${reason}`
                : "none"
            }\n`,
        );
      }
    });
}
