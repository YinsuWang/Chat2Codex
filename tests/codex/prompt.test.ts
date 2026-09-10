import { describe, expect, it } from "vitest";

import { buildCodexPrompt, CODEX_EXECUTION_INVARIANT } from "../../src/codex/prompt.js";

const base = {
  workspace_id: "ws_abc123",
  task_id: "task_001",
  iteration: 1,
  goal: "Implement retry",
  instructions: ["Change retry policy"],
  constraints: ["Keep API compatible"],
  acceptance_criteria: ["Tests pass"],
  worktree_path: "/tmp/worktree",
} as const;

describe("buildCodexPrompt", () => {
  it("builds guided prompts with local adaptation authority", () => {
    const prompt = buildCodexPrompt({ ...base, implementation_mode: "guided" });
    expect(prompt).toContain(CODEX_EXECUTION_INVARIANT);
    expect(prompt).toContain("adapt it when the current local APIs");
    expect(prompt).toContain("ACCEPTANCE CRITERIA");
  });

  it("builds delegate prompts that ask Codex to inspect locally", () => {
    const prompt = buildCodexPrompt({ ...base, implementation_mode: "delegate" });
    expect(prompt).toContain("Inspect the local repository as needed");
  });

  it("includes the exact patch and base validation in patch mode", () => {
    const patch = "diff --git a/a.ts b/a.ts\n+const x = 1;";
    const prompt = buildCodexPrompt({ ...base, implementation_mode: "patch", base_sha: "abc123", patch });
    expect(prompt).toContain("based on abc123");
    expect(prompt).toContain(`PATCH\n${patch}`);
  });
});
