import { execFile } from "node:child_process";
import { access, mkdir, readFile, realpath, rename, rm, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import { getStateDir } from "../config/paths.js";
import type { WorkspaceRecord } from "../config/types.js";
import type { TaskRecord } from "../task/store.js";

const execFileAsync = promisify(execFile);

export interface TaskWorktree {
  path: string;
  branch: string;
  base_sha: string;
  created: boolean;
}

interface WorktreeMetadata {
  workspace_id: string;
  task_id: string;
  workspace_root: string;
  path: string;
  branch: string;
  base_sha: string;
  created_at: string;
}

function assertSafeId(value: string, label: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) {
    throw new Error(`INVALID_${label.toUpperCase()}: ${value}`);
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function runGit(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
  });
  return stdout.trim();
}

async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temporary, path);
}

export class WorktreeManager {
  private worktreeRoot(workspaceId: string): string {
    assertSafeId(workspaceId, "workspace_id");
    return join(getStateDir(), "worktrees", workspaceId);
  }

  private worktreePath(workspaceId: string, taskId: string): string {
    assertSafeId(taskId, "task_id");
    return join(this.worktreeRoot(workspaceId), taskId);
  }

  private metadataPath(workspaceId: string, taskId: string): string {
    assertSafeId(taskId, "task_id");
    return join(this.worktreeRoot(workspaceId), `${taskId}.json`);
  }

  async validateBase(task: TaskRecord, workspace: WorkspaceRecord): Promise<string> {
    if (task.workspace_id !== workspace.workspace_id) {
      throw new Error(`WORKSPACE_MISMATCH: ${task.workspace_id} != ${workspace.workspace_id}`);
    }

    const currentHead = await runGit(workspace.git_root, ["rev-parse", "HEAD"]);
    const baseSha = task.base_sha ?? currentHead;
    try {
      await runGit(workspace.git_root, ["cat-file", "-e", `${baseSha}^{commit}`]);
    } catch {
      throw new Error(`STALE_BASE: commit not found: ${baseSha}`);
    }

    if (
      (task.implementation_mode === "guided" || task.implementation_mode === "patch") &&
      task.base_sha &&
      currentHead !== task.base_sha
    ) {
      throw new Error(`STALE_BASE: expected ${task.base_sha}, current ${currentHead}`);
    }

    return baseSha;
  }

  async create(task: TaskRecord, workspace: WorkspaceRecord): Promise<TaskWorktree> {
    const baseSha = await this.validateBase(task, workspace);
    const path = this.worktreePath(workspace.workspace_id, task.task_id);
    const metadataPath = this.metadataPath(workspace.workspace_id, task.task_id);
    const branch = `chat2codex/${task.task_id}`;

    if (await pathExists(metadataPath)) {
      const metadata = JSON.parse(await readFile(metadataPath, "utf8")) as WorktreeMetadata;
      const workspaceRoot = await realpath(workspace.git_root);
      if (
        metadata.workspace_id !== workspace.workspace_id ||
        metadata.task_id !== task.task_id ||
        metadata.base_sha !== baseSha ||
        metadata.branch !== branch ||
        metadata.workspace_root !== workspaceRoot ||
        metadata.path !== path
      ) {
        throw new Error(`WORKTREE_IDENTITY_MISMATCH: ${task.task_id}`);
      }
      if (!(await pathExists(path))) {
        throw new Error("WORKTREE_IDENTITY_MISMATCH: metadata exists but worktree is missing");
      }
      const actualRoot = await realpath(await runGit(path, ["rev-parse", "--show-toplevel"]));
      const actualBranch = await runGit(path, ["rev-parse", "--abbrev-ref", "HEAD"]);
      if (actualRoot !== (await realpath(path)) || actualBranch !== branch) {
        throw new Error("WORKTREE_IDENTITY_MISMATCH: existing worktree does not match metadata");
      }
      return { path, branch, base_sha: baseSha, created: false };
    }

    if (await pathExists(path)) {
      throw new Error(`WORKTREE_IDENTITY_MISMATCH: unmanaged path exists: ${path}`);
    }

    await mkdir(dirname(path), { recursive: true });
    try {
      await runGit(workspace.git_root, ["worktree", "add", "-b", branch, path, baseSha]);
    } catch (error) {
      await rm(path, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }

    const metadata: WorktreeMetadata = {
      workspace_id: workspace.workspace_id,
      task_id: task.task_id,
      workspace_root: await realpath(workspace.git_root),
      path,
      branch,
      base_sha: baseSha,
      created_at: new Date().toISOString(),
    };
    await atomicWriteJson(metadataPath, metadata);
    return { path, branch, base_sha: baseSha, created: true };
  }

  async remove(task: TaskRecord, workspace: WorkspaceRecord, force = false): Promise<void> {
    if (task.workspace_id !== workspace.workspace_id) {
      throw new Error(`WORKSPACE_MISMATCH: ${task.workspace_id} != ${workspace.workspace_id}`);
    }
    const path = this.worktreePath(workspace.workspace_id, task.task_id);
    const metadataPath = this.metadataPath(workspace.workspace_id, task.task_id);
    if (!(await pathExists(path))) {
      await unlink(metadataPath).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
      return;
    }

    const status = await runGit(path, ["status", "--porcelain"]);
    if (status.length > 0 && !force) {
      throw new Error(`DIRTY_WORKTREE: ${task.task_id}`);
    }

    const args = ["worktree", "remove"];
    if (force) args.push("--force");
    args.push(path);
    await runGit(workspace.git_root, args);

    const branch = `chat2codex/${task.task_id}`;
    await runGit(workspace.git_root, ["branch", "-D", branch]).catch(() => undefined);
    await unlink(metadataPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}
