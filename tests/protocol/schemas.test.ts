import { describe, expect, it } from "vitest";

import { parseControlMessage } from "../../src/protocol/schemas.js";

describe("control protocol", () => {
  it("accepts a guided PLAN", () => {
    const result = parseControlMessage({
      kind: "PLAN",
      workspace_id: "ws_abc123",
      task_id: "task_001",
      iteration: 1,
      implementation_mode: "guided",
      goal: "Add retry handling",
      instructions: ["Update retry policy"],
      constraints: ["Keep API compatible"],
      acceptance_criteria: ["Tests pass"],
    });

    expect(result.kind).toBe("PLAN");
  });

  it("rejects a control message without workspace identity", () => {
    expect(() =>
      parseControlMessage({
        kind: "DONE",
        task_id: "task_001",
        iteration: 1,
        summary: "Accepted",
      }),
    ).toThrow();
  });

  it("requires patch content in patch mode", () => {
    expect(() =>
      parseControlMessage({
        kind: "PLAN",
        workspace_id: "ws_abc123",
        task_id: "task_001",
        iteration: 1,
        implementation_mode: "patch",
        goal: "Apply focused fix",
        instructions: [],
        constraints: [],
        acceptance_criteria: [],
      }),
    ).toThrow(/patch mode requires/i);
  });

  it("rejects patch content outside patch mode", () => {
    expect(() =>
      parseControlMessage({
        kind: "PLAN",
        workspace_id: "ws_abc123",
        task_id: "task_001",
        iteration: 1,
        implementation_mode: "guided",
        goal: "Apply focused fix",
        instructions: [],
        constraints: [],
        acceptance_criteria: [],
        patch: "diff --git a/a.ts b/a.ts",
      }),
    ).toThrow(/only allowed/i);
  });

  it("rejects negative iterations", () => {
    expect(() =>
      parseControlMessage({
        kind: "DONE",
        workspace_id: "ws_abc123",
        task_id: "task_001",
        iteration: -1,
        summary: "Accepted",
      }),
    ).toThrow();
  });
});
