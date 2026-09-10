import { describe, expect, it } from "vitest";

import { assertTransition } from "../../src/task/state-machine.js";

describe("task state machine", () => {
  it("allows the normal lifecycle transitions", () => {
    expect(() => assertTransition("NEW", "PLANNED")).not.toThrow();
    expect(() => assertTransition("PLANNED", "DISPATCHED")).not.toThrow();
    expect(() => assertTransition("DISPATCHED", "EXECUTING")).not.toThrow();
    expect(() => assertTransition("EXECUTING", "EXECUTED")).not.toThrow();
    expect(() => assertTransition("EXECUTED", "REVIEWING")).not.toThrow();
    expect(() => assertTransition("REVIEWING", "PLANNED")).not.toThrow();
    expect(() => assertTransition("REVIEWING", "DONE")).not.toThrow();
  });

  it("rejects skipping directly from NEW to DONE", () => {
    expect(() => assertTransition("NEW", "DONE")).toThrow(/ILLEGAL_TASK_TRANSITION/);
  });

  it("keeps DONE, FAILED, and CANCELLED terminal", () => {
    expect(() => assertTransition("DONE", "PLANNED")).toThrow();
    expect(() => assertTransition("FAILED", "PLANNED")).toThrow();
    expect(() => assertTransition("CANCELLED", "PLANNED")).toThrow();
  });

  it("allows a blocked task to be replanned", () => {
    expect(() => assertTransition("BLOCKED", "PLANNED")).not.toThrow();
  });
});
