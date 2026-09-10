import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { WorkspaceRecord } from "../../src/config/types.js";
import type { TaskRecord } from "../../src/task/store.js";
import { WorktreeManager } from "../../src/workspace/worktree.js";

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd, encoding: "utf8" });
  return stdout.trim();
}

describe("WorktreeManager", () => {
  let stateDir: string;
  let repo: string;
  let workspace: WorkspaceRecord;
  let base: string;
  const previousStateDir = process.env.CHAT2CODEX_STATE_DIR;

  beforeEach(async () => {
    stateDir = await mkdtemp(join(tmpdir(), "chat2codex-state-"));
    process.env.CHAT2CODEX_STATE_DIR = stateDir;
    repo = join(await mkdtemp(join(tmpdir(), "chat2codex-repo-")), "repo");
    await mkdir(repo, { recursive: true });
    await git(repo, ["init"]);
    await git(repo, ["config", "user.email", "tests@example.com"]);
    await git(repo, ["config", "user.name", "Chat2Codex Tests"]);
    await writeFile(join(repo, "README.md"), "base\n", "utf8");
    await git(repo, ["add", "README.md"]);
    await git(repo, ["commit", "-m", "base"]);
    base = await git(repo, ["rev-parse", "HEAD"]);
    workspace = {
      workspace_id: "ws_abc123",
      workspace_name: "repo",
      machine: "test",
      root: await realpath(repo),
      git_root: await realpath(repo),
      git_remote: null,
      created_at: new Date().toISOString(),
      policy: { allow_current_working_tree: false },
    };
  });

  afterEach(() => {
    if (previousStateDir === undefined) delete process.env.CHAT2CODEX_STATE_DIR;
    else process.env.CHAT2CODEX_STATE_DIR = previousStateDir;
  });

  function task(overrides: Partial<TaskRecord> = {}): TaskRecord {
    return {
      workspace_id: workspace.workspace_id,
      task_id: "task_001",
      implementation_mode: "guided",
      base_sha: base,
      goal: "test",
      instructions: [],
      constraints: [],
      acceptance_criteria: [],
      created_at: new Date().toISOString(),
      state: "PLANNED",
      iteration: 1,
      review_approved: false,
      last_review_findings: [],
      updated_at: new Date().toISOString(),
      history: [],
      ...overrides,
    };
  }

  it("creates and reuses an isolated deterministic task worktree", async () => {
    const manager = new WorktreeManager();
    const first = await manager.create(task(), workspace);
    expect(first.created).toBe(true);
    expect(first.branch).toBe("chat2codex/task_001");
    expect(first.base_sha).toBe(base);
    expect(await realpath(first.path)).not.toBe(await realpath(repo));
    expect(dirname(first.path)).toContain(join("worktrees", workspace.workspace_id));
    expect(await git(first.path, ["rev-parse", "HEAD"])).toBe(base);

    const second = await manager.create(task(), workspace);
    expect(second).toEqual({ ...first, created: false });
  });

  it("rejects a guided task when the registered repository HEAD has drifted", async () => {
    await writeFile(join(repo, "next.txt"), "next\n", "utf8");
    await git(repo, ["add", "next.txt"]);
    await git(repo, ["commit", "-m", "next"]);

    await expect(new WorktreeManager().create(task(), workspace)).rejects.toThrow("STALE_BASE");
  });

  it("refuses dirty cleanup unless force is explicit", async () => {
    const manager = new WorktreeManager();
    const created = await manager.create(task(), workspace);
    await writeFile(join(created.path, "dirty.txt"), "dirty\n", "utf8");

    await expect(manager.remove(task(), workspace)).rejects.toThrow("DIRTY_WORKTREE");
    await manager.remove(task(), workspace, true);
    await expect(git(repo, ["show-ref", "--verify", "refs/heads/chat2codex/task_001"])).rejects.toThrow();
  });
});
