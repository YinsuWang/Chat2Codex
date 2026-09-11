import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
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

class CountingCodex implements CodexAdapter {
  starts = 0;
  async start(): Promise<CodexRunHandle> {
    this.starts += 1;
    throw new Error("must not start");
  }
  async cancel(): Promise<void> {}
}

describe("stale base guard", () => {
  it("rejects an outdated patch base before Codex starts", async () => {
    const state = await mkdtemp(join(tmpdir(), "c2c-state-"));
    process.env.CHAT2CODEX_STATE_DIR = state;
    const repo = await mkdtemp(join(tmpdir(), "c2c-repo-"));
    git(repo, "init");
    git(repo, "config", "user.email", "test@example.com");
    git(repo, "config", "user.name", "Test");
    await writeFile(join(repo, "x.txt"), "A\n");
    git(repo, "add", ".");
    git(repo, "commit", "-m", "A");
    const commitA = git(repo, "rev-parse", "HEAD");
    const workspace = await registerWorkspace(repo);

    await writeFile(join(repo, "x.txt"), "B\n");
    git(repo, "add", ".");
    git(repo, "commit", "-m", "B");

    const control = new ControlService(workspace.workspace_id, state);
    const codex = new CountingCodex();
    const supervisor = new Supervisor(workspace, { codexAdapter: codex, controlService: control });
    await control.ingest(
      formatControlText({
        kind: "PLAN",
        workspace_id: workspace.workspace_id,
        task_id: "stale_001",
        iteration: 1,
        implementation_mode: "patch",
        base_sha: commitA,
        goal: "Apply a stale patch",
        instructions: [],
        constraints: [],
        acceptance_criteria: [],
        patch: "--- a/x.txt\n+++ b/x.txt\n@@\n-A\n+C\n",
      }),
    );

    await expect(supervisor.tick()).rejects.toThrow("STALE_BASE");
    expect(codex.starts).toBe(0);
    expect((await supervisor.taskStore.get("stale_001")).state).toBe("PLANNED");
  });
});
