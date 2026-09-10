import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { CodexCLIAdapter } from "../../src/codex/cli-adapter.js";

const fixture = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "fake-codex.mjs");

describe("CodexCLIAdapter", () => {
  it("executes without a shell in the task worktree and streams JSONL", async () => {
    const worktree = await mkdtemp(join(tmpdir(), "chat2codex-codex-"));
    const events: Array<Record<string, unknown>> = [];
    const adapter = new CodexCLIAdapter(process.execPath, [fixture]);
    const handle = await adapter.start({
      workspace_id: "ws_abc123",
      task_id: "task_001",
      iteration: 1,
      implementation_mode: "delegate",
      goal: "test",
      instructions: [],
      constraints: [],
      acceptance_criteria: [],
      worktree_path: worktree,
      onEvent: (event) => events.push(event),
    });
    const result = await handle.completion;
    expect(result.exit_code).toBe(0);
    expect(result.stderr).toContain("fake stderr");
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ type: "thread.started", cwd: worktree });
  });

  it("supports cancellation", async () => {
    const worktree = await mkdtemp(join(tmpdir(), "chat2codex-cancel-"));
    const previous = process.env.FAKE_CODEX_HANG;
    process.env.FAKE_CODEX_HANG = "1";
    try {
      const adapter = new CodexCLIAdapter(process.execPath, [fixture]);
      const handle = await adapter.start({
        workspace_id: "ws_abc123",
        task_id: "task_002",
        iteration: 1,
        implementation_mode: "delegate",
        goal: "test",
        instructions: [],
        constraints: [],
        acceptance_criteria: [],
        worktree_path: worktree,
      });
      await adapter.cancel(handle.execution_id);
      const result = await handle.completion;
      expect(result.exit_code !== 0 || result.signal !== null).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.FAKE_CODEX_HANG;
      else process.env.FAKE_CODEX_HANG = previous;
    }
  });
});
