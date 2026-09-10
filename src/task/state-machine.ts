export type TaskState =
  | "NEW"
  | "PLANNED"
  | "DISPATCHED"
  | "EXECUTING"
  | "EXECUTED"
  | "REVIEWING"
  | "DONE"
  | "FAILED"
  | "CANCELLED"
  | "BLOCKED";

const TRANSITIONS: Readonly<Record<TaskState, readonly TaskState[]>> = {
  NEW: ["PLANNED", "FAILED", "CANCELLED"],
  PLANNED: ["DISPATCHED", "FAILED", "CANCELLED", "BLOCKED"],
  DISPATCHED: ["EXECUTING", "FAILED", "CANCELLED", "BLOCKED"],
  EXECUTING: ["EXECUTED", "FAILED", "CANCELLED", "BLOCKED"],
  EXECUTED: ["REVIEWING", "FAILED", "CANCELLED", "BLOCKED"],
  REVIEWING: ["PLANNED", "DONE", "FAILED", "CANCELLED", "BLOCKED"],
  DONE: [],
  FAILED: [],
  CANCELLED: [],
  BLOCKED: ["PLANNED", "FAILED", "CANCELLED"],
};

export function assertTransition(from: TaskState, to: TaskState): void {
  if (!TRANSITIONS[from].includes(to)) {
    throw new Error(`ILLEGAL_TASK_TRANSITION: ${from} -> ${to}`);
  }
}

export function canTransition(from: TaskState, to: TaskState): boolean {
  return TRANSITIONS[from].includes(to);
}
