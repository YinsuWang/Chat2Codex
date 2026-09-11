import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { ControlService } from "../../src/control/service.js";
import { formatControlText } from "../../src/protocol/text-format.js";
import { TaskStore } from "../../src/task/store.js";
import { registerWorkspace } from "../../src/workspace/registry.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

describe("workspace binding", () => {
  it("rejects a PLAN for another workspace before persistence", async () => {
    const state = await mkdtemp(join(tmpdir(), "c2c-state-"));
    process.env.CHAT2CODEX_STATE_DIR = state;
    const repo = await mkdtemp(join(tmpdir(), "c2c-repo-"));
    git(repo, "init");
    git(repo, "config", "user.email", "test@example.com");
    git(repo, "config", "user.name", "Test");
    await writeFile(join(repo, "x.txt"), "x\n");
    git(repo, "add", ".");
    git(repo, "commit", "-m", "base");

    const workspace = await registerWorkspace(repo);
    const control = new ControlService(workspace.workspace_id, state);
    const wrongWorkspace = "ws_ffffffffffffffff";

    await expect(
      control.ingest(
        formatControlText({
          kind: "PLAN",
          workspace_id: wrongWorkspace,
          task_id: "wrong_001",
          iteration: 1,
          implementation_mode: "guided",
          goal: "must not run",
          instructions: [],
          constraints: [],
          acceptance_criteria: [],
        }),
      ),
    ).rejects.toThrow("WORKSPACE_MISMATCH");

    expect(await new TaskStore().list()).toEqual([]);
    expect(await control.receiveInbound()).toBeNull();
  });
});
