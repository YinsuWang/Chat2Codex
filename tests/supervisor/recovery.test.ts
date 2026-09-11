import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import type { CodexAdapter } from "../../src/codex/adapter.js";
import { Supervisor } from "../../src/supervisor/supervisor.js";
import { TaskService } from "../../src/task/service.js";
import { TaskStore } from "../../src/task/store.js";
import { registerWorkspace } from "../../src/workspace/registry.js";

const never: CodexAdapter = {
  async start() {
    throw new Error("not used");
  },
  async cancel() {},
};

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

describe("Supervisor recovery", () => {
  it("blocks interrupted EXECUTING tasks", async () => {
    const state = await mkdtemp(join(tmpdir(), "c2c-state-"));
    process.env.CHAT2CODEX_STATE_DIR = state;
    const repo = await mkdtemp(join(tmpdir(), "c2c-repo-"));
    git(repo, "init");
    git(repo, "config", "user.email", "test@example.com");
    git(repo, "config", "user.name", "Test");
    await writeFile(join(repo, "x"), "x");
    git(repo, "add", ".");
    git(repo, "commit", "-m", "base");

    const workspace = await registerWorkspace(repo);
    const store = new TaskStore();
    const service = new TaskService(store, workspace);
    await service.acceptControlMessage({
      kind: "PLAN",
      workspace_id: workspace.workspace_id,
      task_id: "task_002",
      iteration: 1,
      implementation_mode: "delegate",
      goal: "x",
      instructions: [],
      constraints: [],
      acceptance_criteria: [],
    });
    await store.update("task_002", { state: "DISPATCHED", reason: "test" });
    await store.update("task_002", { state: "EXECUTING", reason: "test" });

    const supervisor = new Supervisor(workspace, {
      codexAdapter: never,
      taskStore: store,
      taskService: service,
    });
    await supervisor.recoverInterruptedTasks();

    const task = await store.get("task_002");
    expect(task.state).toBe("BLOCKED");
    expect(task.history.at(-1)?.reason).toBe("INTERRUPTED_EXECUTION");
  });
});
