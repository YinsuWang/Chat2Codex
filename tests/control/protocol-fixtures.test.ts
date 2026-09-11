import { describe, expect, it } from "vitest";

import { formatControlText, parseControlText } from "../../src/protocol/text-format.js";
import type { ControlMessage } from "../../src/protocol/types.js";

const fixtures: ControlMessage[] = [
  {
    kind: "PLAN",
    workspace_id: "ws_a83f21",
    task_id: "task_001",
    iteration: 1,
    implementation_mode: "guided",
    base_sha: "abc123",
    goal: "Add retry handling",
    instructions: ["Update retry policy"],
    constraints: ["Preserve the public API"],
    acceptance_criteria: ["Tests pass"],
  },
  {
    kind: "EXECUTED",
    workspace_id: "ws_a83f21",
    task_id: "task_001",
    iteration: 1,
    exit_code: 0,
    changed_files: 2,
    tests_summary: "42 passed",
  },
  {
    kind: "REVIEW",
    workspace_id: "ws_a83f21",
    task_id: "task_001",
    iteration: 1,
    decision: "REVISE",
    findings: [
      {
        severity: "high",
        file: "src/retry.ts",
        issue: "Cancellation is ignored",
        required_change: "Propagate AbortSignal",
      },
    ],
  },
  {
    kind: "REVIEW",
    workspace_id: "ws_a83f21",
    task_id: "task_001",
    iteration: 2,
    decision: "PASS",
    findings: [],
  },
];

describe("control protocol fixtures", () => {
  for (const fixture of fixtures) {
    it(`round-trips ${fixture.kind}${fixture.kind === "REVIEW" ? `/${fixture.decision}` : ""}`, () => {
      const formatted = formatControlText(fixture);
      expect(formatted.startsWith("[CHAT2CODEX]\n")).toBe(true);
      expect(parseControlText(formatted)).toEqual(fixture);
      expect(parseControlText(formatControlText(parseControlText(formatted)))).toEqual(fixture);
    });
  }
});
