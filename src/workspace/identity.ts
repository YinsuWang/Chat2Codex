import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { hostname } from "node:os";
import { basename } from "node:path";
import { promisify } from "node:util";
import { realpath } from "node:fs/promises";

import type { WorkspaceRecord } from "../config/types.js";

const execFileAsync = promisify(execFile);

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
  });
  return stdout.trim();
}

function sanitizeGitRemote(remote: string): string {
  if (!/^https?:\/\//i.test(remote)) {
    return remote;
  }

  try {
    const url = new URL(remote);
    url.username = "";
    url.password = "";
    return url.toString();
  } catch {
    return remote;
  }
}

async function readOriginRemote(gitRoot: string): Promise<string | null> {
  try {
    const remote = await git(["config", "--get", "remote.origin.url"], gitRoot);
    return remote ? sanitizeGitRemote(remote) : null;
  } catch {
    return null;
  }
}

export async function discoverWorkspace(root: string): Promise<WorkspaceRecord> {
  const canonicalInput = await realpath(root);
  const gitRootRaw = await git(["rev-parse", "--show-toplevel"], canonicalInput);
  const gitRoot = await realpath(gitRootRaw);

  return {
    workspace_id: `ws_${randomBytes(8).toString("hex")}`,
    workspace_name: basename(gitRoot),
    machine: hostname(),
    root: gitRoot,
    git_root: gitRoot,
    git_remote: await readOriginRemote(gitRoot),
    created_at: new Date().toISOString(),
    policy: {
      allow_current_working_tree: false,
    },
  };
}
