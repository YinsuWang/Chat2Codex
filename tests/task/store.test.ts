import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { WorkspaceRecord } from "../../src/config/types.js";
import type { PlanMessage } from "../../src/protocol/types.js";
import { TaskService } from "../../src/task/service.js";
import { TaskStore } from "../../src/task/store.js";

let stateDir: string;

const workspace: WorkspaceRecord = {
  workspace_id: "ws_0123456789abcdef",
  workspace_name: "demo",
  machine: "test-machine",
  root: "/tmp/demo",
  git_root: "/tmp/demo",
  git_remote: null,
  created_at: "2026-09-10T00:00:00.000Z",
  policy: { allow_current_working_tree: false },
};

function plan(iteration = 1): PlanMessage {
  return {
    kind: "PLAN",
    workspace_id: workspace.workspace_id,
    task_id: "task_001",
    iteration,
    implementation_mode: "guided",
    base_sha: "abc123",
    goal: "Add retry handling",
    instructions: ["Update retry policy"],
    constraints: ["Keep API compatible"],
    acceptance_criteria: ["Tests pass"],
  };
}

beforeEach(async () => {
  stateDir = await mkdtemp(join(tmpdir(), "chat2codex-task-"));
  process.env.CHAT2CODEX_STATE_DIR = stateDir;
});

afterEach(async () => {
  delete process.env.CHAT2CODEX_STATE_DIR;
  await rm(stateDir, { recursive: true, force: true });
});

describe("TaskStore", () => {
  it("persists state, iteration, mode, base SHA, and history across instances", async () => {
    const firstStore = new TaskStore();
    await firstStore.create(plan());
    await firstStore.update("task_001", {
      state: "PLANNED",
      reason: "PLAN_ACCEPTED",
    });

    const reloaded = await new TaskStore().get("task_001");

    expect(reloaded.state).toBe("PLANNED");
    expect(reloaded.iteration).toBe(1);
    expect(reloaded.implementation_mode).toBe("guided");
    expect(reloaded.base_sha).toBe("abc123");
    expect(reloaded.history).toHaveLength(1);
    expect(reloaded.history[0]).toMatchObject({
      from: "NEW",
      to: "PLANNED",
      iteration: 1,
      reason: "PLAN_ACCEPTED",
    });
  });
});

describe("TaskService", () => {
  it("creates a PLAN as PLANNED", async () => {
    const service = new TaskService(new TaskStore(), workspace);

    const created = await service.acceptControlMessage(plan());

    expect(created.state).toBe("PLANNED");
    expect(created.iteration).toBe(1);
  });

  it("turns REVIEW/REVISE into the next PLANNED iteration", async () => {
    const store = new TaskStore();
    const service = new TaskService(store, workspace);
    await service.acceptControlMessage(plan());
    await store.update("task_001", { state: "DISPATCHED", reason: "TEST" });
    await store.update("task_001", { state: "EXECUTING", reason: "TEST" });
    await store.update("task_001", { state: "EXECUTED", reason: "TEST" });
    await store.update("task_001", { state: "REVIEWING", reason: "TEST" });

    const revised = await service.acceptControlMessage({
      kind: "REVIEW",
      workspace_id: workspace.workspace_id,
      task_id: "task_001",
      iteration: 1,
      decision: "REVISE",
      findings: [
        {
          severity: "high",
          issue: "Retry state is lost",
          required_change: "Persist retry state",
        },
      ],
    });

    expect(revised.state).toBe("PLANNED");
    expect(revised.iteration).toBe(2);
    expect(revised.review_approved).toBe(false);
  });

  it("turns REVIEW/PASS into review-approved DONE and then accepts DONE", async () => {
    const store = new TaskStore();
    const service = new TaskService(store, workspace);
    await service.acceptControlMessage(plan());
    await store.update("task_001", { state: "DISPATCHED", reason: "TEST" });
    await store.update("task_001", { state: "EXECUTING", reason: "TEST" });
    await store.update("task_001", { state: "EXECUTED", reason: "TEST" });
    await store.update("task_001", { state: "REVIEWING", reason: "TEST" });

    const passed = await service.acceptControlMessage({
      kind: "REVIEW",
      workspace_id: workspace.workspace_id,
      task_id: "task_001",
      iteration: 1,
      decision: "PASS",
      findings: [],
    });
    expect(passed.state).toBe("DONE");
    expect(passed.review_approved).toBe(true);

    const done = await service.acceptControlMessage({
      kind: "DONE",
      workspace_id: workspace.workspace_id,
      task_id: "task_001",
      iteration: 1,
      summary: "Accepted",
    });
    expect(done.done_summary).toBe("Accepted");
  });

  it("rejects workspace mismatch before creating a task", async () => {
    const store = new TaskStore();
    const service = new TaskService(store, workspace);

    await expect(
      service.acceptControlMessage({ ...plan(), workspace_id: "ws_fedcba9876543210" }),
    ).rejects.toThrow(/WORKSPACE_MISMATCH/);
    expect(await store.getOrNull("task_001")).toBeNull();
  });

  it("rejects iteration regression without mutating the task", async () => {
    const store = new TaskStore();
    const service = new TaskService(store, workspace);
    await service.acceptControlMessage(plan(2));

    await expect(service.acceptControlMessage(plan(1))).rejects.toThrow(
      /ITERATION_REGRESSION/,
    );
    expect((await store.get("task_001")).iteration).toBe(2);
  });

  it("allows a new PLAN to recover a BLOCKED task", async () => {
    const store = new TaskStore();
    const service = new TaskService(store, workspace);
    await service.acceptControlMessage(plan());
    await store.update("task_001", { state: "BLOCKED", reason: "INTERRUPTED_EXECUTION" });

    const recovered = await service.acceptControlMessage(plan());

    expect(recovered.state).toBe("PLANNED");
    expect(recovered.history.at(-1)).toMatchObject({
      from: "BLOCKED",
      to: "PLANNED",
    });
  });

  it("rejects unsafe task ids before writing task files", async () => {
    const store = new TaskStore();

    await expect(
      store.create({ ...plan(), task_id: "../escape" }),
    ).rejects.toThrow(/INVALID_TASK_ID/);
  });

  it("rejects DONE before review approval", async () => {
    const store = new TaskStore();
    const service = new TaskService(store, workspace);
    await service.acceptControlMessage(plan());

    await expect(
      service.acceptControlMessage({
        kind: "DONE",
        workspace_id: workspace.workspace_id,
        task_id: "task_001",
        iteration: 1,
        summary: "Too early",
      }),
    ).rejects.toThrow(/DONE_REQUIRES_REVIEW_APPROVAL/);
  });
});
