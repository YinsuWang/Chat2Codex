import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { createStartCommand } from "../../src/cli/commands/start.js";
import { registerWorkspace } from "../../src/workspace/registry.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

describe("start lock ordering", () => {
  it("does not replace an existing bridge runtime when the daemon lock is already held", async () => {
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

    await mkdir(join(state, "daemons"), { recursive: true });
    await mkdir(join(state, "runtime"), { recursive: true });
    await writeFile(
      join(state, "daemons", `${workspace.workspace_id}.lock`),
      `${JSON.stringify({
        pid: process.pid,
        started_at: "2026-09-11T00:00:00.000Z",
        workspace_id: workspace.workspace_id,
      })}\n`,
    );

    const runtimePath = join(state, "runtime", `${workspace.workspace_id}-bridge.json`);
    const originalRuntime = {
      workspace_id: workspace.workspace_id,
      host: "127.0.0.1",
      port: 43123,
      pid: 777777,
      started_at: "2026-09-11T00:00:00.000Z",
    } as const;
    await writeFile(runtimePath, `${JSON.stringify(originalRuntime)}\n`);

    await expect(
      createStartCommand().parseAsync(["--workspace", repo], { from: "user" }),
    ).rejects.toThrow(/DAEMON_ALREADY_RUNNING/);

    expect(JSON.parse(await readFile(runtimePath, "utf8"))).toEqual(originalRuntime);
  });
});
