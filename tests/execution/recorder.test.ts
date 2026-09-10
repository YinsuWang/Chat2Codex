import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { ExecutionRecorder } from "../../src/execution/recorder.js";

describe("ExecutionRecorder", () => {
  it("persists execution evidence across recorder instances", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "chat2codex-execution-"));
    const recorder = new ExecutionRecorder(stateDir);
    await recorder.startIteration({
      task_id: "task_001",
      iteration: 1,
      control_message: {
        kind: "PLAN",
        workspace_id: "ws_abc123",
        task_id: "task_001",
        iteration: 1,
        implementation_mode: "guided",
        goal: "test",
        instructions: [],
        constraints: [],
        acceptance_criteria: [],
      },
    });
    await recorder.appendCodexEvent("task_001", 1, { type: "command_execution", command: "test" });
    const readable = await recorder.recordCommandOutput(
      "task_001",
      1,
      "tests",
      "ok sk-abcdefghijklmnopq",
    );
    const restricted = await recorder.recordCommandOutput(
      "task_001",
      1,
      "key",
      "-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----",
    );
    await recorder.finishIteration("task_001", 1, {
      exit_code: 0,
      changed_files: ["src/a.ts"],
      tests_summary: "1 passed",
    });

    const reloaded = new ExecutionRecorder(stateDir);
    const summary = await reloaded.getSummary("task_001", 1);
    expect(summary.status).toBe("completed");
    expect(summary.exit_code).toBe(0);
    expect(summary.changed_files).toEqual(["src/a.ts"]);
    expect(summary.tests_summary).toBe("1 passed");

    const output = await reloaded.readOutput("task_001", 1, readable.id);
    expect(output.body).toContain("<redacted:openai-key>");
    expect(output.body).not.toContain("sk-");
    const withheld = await reloaded.readOutput("task_001", 1, restricted.id);
    expect(withheld.status).toBe("restricted");
    expect(withheld.body).toBeUndefined();
  });
});
