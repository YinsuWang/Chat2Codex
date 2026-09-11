import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import type { CodexAdapter, CodexRunHandle } from "../../src/codex/adapter.js";
import { ControlService } from "../../src/control/service.js";
import { formatControlText } from "../../src/protocol/text-format.js";
import { Supervisor } from "../../src/supervisor/supervisor.js";
import { TaskStore } from "../../src/task/store.js";
import { registerWorkspace } from "../../src/workspace/registry.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

class FakeCodex implements CodexAdapter {
  async start(input: Parameters<CodexAdapter["start"]>[0]): Promise<CodexRunHandle> {
    await writeFile(join(input.worktree_path, "changed.txt"), "changed\n");
    await input.onEvent?.({ type: "fake.completed" });
    return {
      execution_id: "fake-1",
      pid: 123,
      completion: Promise.resolve({
        execution_id: "fake-1",
        pid: 123,
        exit_code: 0,
        signal: null,
        stderr: "",
      }),
    };
  }

  async cancel(): Promise<void> {}
}

describe("Supervisor", () => {
  it("runs PLAN through execution and publishes EXECUTED after evidence", async () => {
    const state = await mkdtemp(join(tmpdir(), "c2c-state-"));
    process.env.CHAT2CODEX_STATE_DIR = state;
    const repo = await mkdtemp(join(tmpdir(), "c2c-repo-"));
    git(repo, "init");
    git(repo, "config", "user.email", "test@example.com");
    git(repo, "config", "user.name", "Test");
    await writeFile(join(repo, "README.md"), "base\n");
    git(repo, "add", ".");
    git(repo, "commit", "-m", "base");

    const workspace = await registerWorkspace(repo);
    const base = git(repo, "rev-parse", "HEAD");
    const control = new ControlService(workspace.workspace_id, state);
    await control.ingest(
      formatControlText({
        kind: "PLAN",
        workspace_id: workspace.workspace_id,
        task_id: "task_001",
        iteration: 1,
        implementation_mode: "guided",
        base_sha: base,
        goal: "change",
        instructions: ["edit"],
        constraints: [],
        acceptance_criteria: ["done"],
      }),
    );

    const supervisor = new Supervisor(workspace, {
      codexAdapter: new FakeCodex(),
      controlService: control,
      taskStore: new TaskStore(),
    });
    await supervisor.tick();

    const task = await supervisor.taskStore.get("task_001");
    expect(task.state).toBe("REVIEWING");
    expect(task.history.map((entry) => entry.to)).toEqual([
      "PLANNED",
      "DISPATCHED",
      "EXECUTING",
      "EXECUTED",
      "REVIEWING",
    ]);
    const outbound = await control.next();
    expect(outbound?.message.kind).toBe("EXECUTED");
    const summary = JSON.parse(
      await readFile(
        join(state, "tasks", "task_001", "iterations", "001", "execution-summary.json"),
        "utf8",
      ),
    ) as { status: string };
    expect(summary.status).toBe("completed");
  });
});
