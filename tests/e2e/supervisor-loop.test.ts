import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import type { CodexAdapter, CodexRunHandle } from "../../src/codex/adapter.js";
import { ControlService } from "../../src/control/service.js";
import { formatControlText } from "../../src/protocol/text-format.js";
import { Supervisor } from "../../src/supervisor/supervisor.js";
import { registerWorkspace } from "../../src/workspace/registry.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

class EditingFakeCodex implements CodexAdapter {
  starts = 0;

  async start(input: Parameters<CodexAdapter["start"]>[0]): Promise<CodexRunHandle> {
    this.starts += 1;
    await writeFile(join(input.worktree_path, "app.txt"), "changed by codex\n");
    await input.onEvent?.({ type: "file_change", path: "app.txt" });
    return {
      execution_id: `fake-${this.starts}`,
      pid: 101,
      completion: Promise.resolve({
        execution_id: `fake-${this.starts}`,
        pid: 101,
        exit_code: 0,
        signal: null,
        stderr: "",
      }),
    };
  }

  async cancel(): Promise<void> {}
}

describe("Chat2Codex end-to-end loop", () => {
  it("executes in a worktree and reaches DONE after ChatGPT review PASS", async () => {
    const state = await mkdtemp(join(tmpdir(), "c2c-state-"));
    process.env.CHAT2CODEX_STATE_DIR = state;
    const repo = await mkdtemp(join(tmpdir(), "c2c-repo-"));
    git(repo, "init");
    git(repo, "config", "user.email", "test@example.com");
    git(repo, "config", "user.name", "Test");
    await writeFile(join(repo, "app.txt"), "original\n");
    git(repo, "add", ".");
    git(repo, "commit", "-m", "base");

    const workspace = await registerWorkspace(repo);
    const base = git(repo, "rev-parse", "HEAD");
    const control = new ControlService(workspace.workspace_id, state);
    const codex = new EditingFakeCodex();
    const supervisor = new Supervisor(workspace, { codexAdapter: codex, controlService: control });

    await control.ingest(
      formatControlText({
        kind: "PLAN",
        workspace_id: workspace.workspace_id,
        task_id: "e2e_001",
        iteration: 1,
        implementation_mode: "guided",
        base_sha: base,
        goal: "Edit app.txt",
        instructions: ["Replace the content"],
        constraints: [],
        acceptance_criteria: ["app.txt changes only in the task worktree"],
      }),
    );
    await supervisor.tick();

    expect((await supervisor.taskStore.get("e2e_001")).state).toBe("REVIEWING");
    expect(await readFile(join(repo, "app.txt"), "utf8")).toBe("original\n");
    const executed = await control.next();
    expect(executed?.message.kind).toBe("EXECUTED");
    if (executed) await control.acknowledgeOutbound(executed.id);

    await control.ingest(
      formatControlText({
        kind: "REVIEW",
        workspace_id: workspace.workspace_id,
        task_id: "e2e_001",
        iteration: 1,
        decision: "PASS",
        findings: [],
      }),
    );
    await supervisor.tick();

    const done = await supervisor.taskStore.get("e2e_001");
    expect(done.state).toBe("DONE");
    expect(done.review_approved).toBe(true);
    expect(codex.starts).toBe(1);
    expect(await readFile(join(repo, "app.txt"), "utf8")).toBe("original\n");
  });
});
