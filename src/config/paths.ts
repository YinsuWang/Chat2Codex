import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

export function getStateDir(): string {
  const override = process.env.CHAT2CODEX_STATE_DIR;
  if (override) {
    return isAbsolute(override) ? override : resolve(override);
  }

  if (process.platform === "win32") {
    const base = process.env.LOCALAPPDATA;
    if (!base) {
      throw new Error("LOCALAPPDATA is required on Windows");
    }
    return join(base, "Chat2Codex");
  }

  const base = process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state");
  return join(base, "chat2codex");
}

export function getWorkspacesDir(): string {
  return join(getStateDir(), "workspaces");
}

export function getWorkspaceIndexPath(): string {
  return join(getWorkspacesDir(), "index.json");
}

export function getWorkspaceRecordPath(workspaceId: string): string {
  return join(getWorkspacesDir(), `${workspaceId}.json`);
}
