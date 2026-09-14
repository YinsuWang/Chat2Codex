import { Command } from "commander";

import { RelayPairingService } from "../../relay/pairing.js";
import { getRelayRuntime } from "../../relay/runtime.js";
import { RelayStatusStore } from "../../relay/status.js";
import { RelayTokenStore } from "../../relay/token-store.js";
import { findWorkspaceByRoot } from "../../workspace/registry.js";

export interface RelayPairResult {
  workspace_id: string;
  pairing_code: string;
  expires_at: string;
  attempts_remaining: number;
}

export interface RelayCliStatus {
  workspace_id: string;
  paired: boolean;
  extension_id: string | null;
  relay_running: boolean;
  host: "127.0.0.1" | null;
  port: number | null;
  pid: number | null;
  bound_tab_seen: boolean;
  last_heartbeat_at: string | null;
}

async function requireWorkspace(workspacePath: string) {
  const workspace = await findWorkspaceByRoot(workspacePath);
  if (!workspace) throw new Error("WORKSPACE_NOT_REGISTERED");
  return workspace;
}

export async function pairRelay(workspacePath: string): Promise<RelayPairResult> {
  const workspace = await requireWorkspace(workspacePath);
  const session = await new RelayPairingService().create(workspace.workspace_id);
  return {
    workspace_id: workspace.workspace_id,
    pairing_code: session.code,
    expires_at: session.expires_at,
    attempts_remaining: session.attempts_remaining,
  };
}

export async function relayStatus(workspacePath: string): Promise<RelayCliStatus> {
  const workspace = await requireWorkspace(workspacePath);
  const [authorization, runtime, status] = await Promise.all([
    new RelayTokenStore().status(workspace.workspace_id),
    getRelayRuntime(workspace.workspace_id),
    new RelayStatusStore().get(workspace.workspace_id),
  ]);
  return {
    workspace_id: workspace.workspace_id,
    paired: authorization.paired,
    extension_id: authorization.extension_id,
    relay_running: runtime !== null,
    host: runtime?.host ?? null,
    port: runtime?.port ?? null,
    pid: runtime?.pid ?? null,
    bound_tab_seen: status?.bound_tab_seen ?? false,
    last_heartbeat_at: status?.last_heartbeat_at ?? null,
  };
}

export async function unpairRelay(
  workspacePath: string,
): Promise<{ workspace_id: string; paired: false }> {
  const workspace = await requireWorkspace(workspacePath);
  await new RelayTokenStore().revokeWorkspace(workspace.workspace_id);
  return { workspace_id: workspace.workspace_id, paired: false };
}

function writeJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

export function createRelayCommand(): Command {
  const command = new Command("relay").description("Manage the local browser relay");

  command
    .command("pair")
    .description("Create a one-time browser extension pairing code")
    .option("-w, --workspace <path>", "workspace path", process.cwd())
    .option("--json", "emit JSON")
    .action(async (options: { workspace: string; json?: boolean }) => {
      const result = await pairRelay(options.workspace);
      if (options.json) {
        writeJson(result);
      } else {
        process.stdout.write(
          `Workspace: ${result.workspace_id}\n` +
            `Pairing code: ${result.pairing_code}\n` +
            `Expires: ${result.expires_at}\n` +
            `Attempts: ${result.attempts_remaining}\n`,
        );
      }
    });

  command
    .command("status")
    .description("Show browser relay pairing and runtime status")
    .option("-w, --workspace <path>", "workspace path", process.cwd())
    .option("--json", "emit JSON")
    .action(async (options: { workspace: string; json?: boolean }) => {
      const result = await relayStatus(options.workspace);
      if (options.json) {
        writeJson(result);
      } else {
        process.stdout.write(
          `Workspace: ${result.workspace_id}\n` +
            `Paired: ${result.paired ? "yes" : "no"}\n` +
            `Relay: ${result.relay_running ? `${result.host}:${result.port}` : "stopped"}\n` +
            `Bound tab seen: ${result.bound_tab_seen ? "yes" : "no"}\n` +
            `Last heartbeat: ${result.last_heartbeat_at ?? "none"}\n`,
        );
      }
    });

  command
    .command("unpair")
    .description("Revoke the current browser relay authorization")
    .option("-w, --workspace <path>", "workspace path", process.cwd())
    .option("--json", "emit JSON")
    .action(async (options: { workspace: string; json?: boolean }) => {
      const result = await unpairRelay(options.workspace);
      if (options.json) writeJson(result);
      else process.stdout.write(`Unpaired ${result.workspace_id}\n`);
    });

  return command;
}
