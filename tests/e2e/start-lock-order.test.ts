import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { createStartCommand } from "../../src/cli/commands/start.js";
import { registerWorkspace } from "../../src/workspace/registry.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

describe("start lock ordering", () => {
  it("does not replace existing bridge or relay runtime when the daemon lock is already held", async () => {
    const state = await mkdtemp(join(tmpdir(), "c2c-state-"));
    process.env.CHAT2CODEX_STATE_DIR = state;
    const repo = await mkdtemp(join(tmpdir(), "c2c-repo-"));

    try {
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

      const bridgeRuntimePath = join(
        state,
        "runtime",
        `${workspace.workspace_id}-bridge.json`,
      );
      const relayRuntimePath = join(
        state,
        "runtime",
        `${workspace.workspace_id}-relay.json`,
      );
      const originalBridgeRuntime = {
        workspace_id: workspace.workspace_id,
        host: "127.0.0.1",
        port: 43123,
        pid: 777777,
        started_at: "2026-09-11T00:00:00.000Z",
      } as const;
      const originalRelayRuntime = {
        workspace_id: workspace.workspace_id,
        host: "127.0.0.1",
        port: 43124,
        pid: 777778,
        started_at: "2026-09-11T00:00:00.000Z",
      } as const;
      await writeFile(bridgeRuntimePath, `${JSON.stringify(originalBridgeRuntime)}\n`);
      await writeFile(relayRuntimePath, `${JSON.stringify(originalRelayRuntime)}\n`);

      await expect(
        createStartCommand().parseAsync(["--workspace", repo], { from: "user" }),
      ).rejects.toThrow(/DAEMON_ALREADY_RUNNING/);

      expect(JSON.parse(await readFile(bridgeRuntimePath, "utf8"))).toEqual(
        originalBridgeRuntime,
      );
      expect(JSON.parse(await readFile(relayRuntimePath, "utf8"))).toEqual(
        originalRelayRuntime,
      );
    } finally {
      delete process.env.CHAT2CODEX_STATE_DIR;
      await Promise.all([
        rm(state, { recursive: true, force: true }),
        rm(repo, { recursive: true, force: true }),
      ]);
    }
  });
});
