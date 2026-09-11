import type { WorkspaceRecord } from "../config/types.js";
import type { ControlMessage, PlanMessage, ReviewMessage } from "../protocol/types.js";
import { TaskStore, type TaskRecord } from "./store.js";
import { canTransition } from "./state-machine.js";

function reviewFindingsEqual(a: ReviewMessage["findings"], b: ReviewMessage["findings"]): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function reviewGuidance(message: ReviewMessage): string[] {
  return message.findings.map((finding) => {
    const where = finding.file ? ` in ${finding.file}` : "";
    return `[${finding.severity}]${where}: ${finding.issue} Required change: ${finding.required_change}`;
  });
}

export class TaskService {
  constructor(
    private readonly store: TaskStore,
    private readonly workspace: WorkspaceRecord,
  ) {}

  async acceptControlMessage(message: ControlMessage): Promise<TaskRecord> {
    this.assertWorkspace(message.workspace_id);
    switch (message.kind) {
      case "PLAN":
        return this.acceptPlan(message);
      case "REVIEW":
        return this.acceptReview(message);
      case "EXECUTED":
        return this.acceptExecuted(message);
      case "DONE":
        return this.acceptDone(message);
    }
  }

  private assertWorkspace(workspaceId: string): void {
    if (workspaceId !== this.workspace.workspace_id) {
      throw new Error(
        `WORKSPACE_MISMATCH: expected ${this.workspace.workspace_id}, received ${workspaceId}`,
      );
    }
  }

  private async requireTask(taskId: string): Promise<TaskRecord> {
    const task = await this.store.getOrNull(taskId);
    if (!task) throw new Error(`TASK_NOT_FOUND: ${taskId}`);
    if (task.task_id !== taskId) {
      throw new Error(`TASK_ID_MISMATCH: expected ${taskId}, found ${task.task_id}`);
    }
    if (task.workspace_id !== this.workspace.workspace_id) {
      throw new Error(
        `WORKSPACE_MISMATCH: task ${taskId} belongs to ${task.workspace_id}`,
      );
    }
    return task;
  }

  private assertIteration(task: TaskRecord, incoming: number): void {
    if (incoming < task.iteration) {
      throw new Error(`ITERATION_REGRESSION: ${incoming} < ${task.iteration}`);
    }
    if (incoming !== task.iteration) {
      throw new Error(`ITERATION_MISMATCH: expected ${task.iteration}, received ${incoming}`);
    }
  }

  private async acceptPlan(message: PlanMessage): Promise<TaskRecord> {
    const existing = await this.store.getOrNull(message.task_id);
    if (!existing) {
      const created = await this.store.create(message);
      return this.store.update(created.task_id, {
        state: "PLANNED",
        reason: "PLAN_ACCEPTED",
      });
    }

    if (existing.workspace_id !== message.workspace_id) {
      throw new Error(`WORKSPACE_MISMATCH: task ${message.task_id} belongs elsewhere`);
    }
    this.assertIteration(existing, message.iteration);
    if (existing.state !== "PLANNED" && !canTransition(existing.state, "PLANNED")) {
      throw new Error(`PLAN_NOT_ALLOWED_IN_STATE: ${existing.state}`);
    }

    return this.store.update(existing.task_id, {
      state: existing.state === "PLANNED" ? undefined : "PLANNED",
      implementation_mode: message.implementation_mode,
      base_sha: message.base_sha ?? null,
      goal: message.goal,
      instructions: message.instructions,
      constraints: message.constraints,
      acceptance_criteria: message.acceptance_criteria,
      patch: message.patch ?? null,
      review_approved: false,
      reason: "PLAN_UPDATED",
    });
  }

  private async acceptReview(message: ReviewMessage): Promise<TaskRecord> {
    const task = await this.requireTask(message.task_id);

    if (
      message.decision === "REVISE" &&
      task.state === "PLANNED" &&
      message.iteration + 1 === task.iteration &&
      reviewFindingsEqual(task.last_review_findings, message.findings)
    ) {
      return task;
    }
    if (
      message.decision === "PASS" &&
      task.state === "DONE" &&
      task.review_approved &&
      message.iteration === task.iteration &&
      reviewFindingsEqual(task.last_review_findings, message.findings)
    ) {
      return task;
    }

    this.assertIteration(task, message.iteration);
    if (task.state !== "REVIEWING") {
      throw new Error(`REVIEW_NOT_ALLOWED_IN_STATE: ${task.state}`);
    }

    if (message.decision === "REVISE") {
      const switchingFromPatch = task.implementation_mode === "patch";
      return this.store.update(task.task_id, {
        state: "PLANNED",
        iteration: task.iteration + 1,
        implementation_mode: switchingFromPatch ? "guided" : task.implementation_mode,
        patch: switchingFromPatch ? null : task.patch,
        instructions: [...task.instructions, ...reviewGuidance(message)],
        review_approved: false,
        last_review_findings: message.findings,
        reason: "REVIEW_REVISE",
      });
    }

    return this.store.update(task.task_id, {
      state: "DONE",
      review_approved: true,
      last_review_findings: message.findings,
      reason: "REVIEW_PASS",
    });
  }

  private async acceptExecuted(
    message: Extract<ControlMessage, { kind: "EXECUTED" }>,
  ): Promise<TaskRecord> {
    const task = await this.requireTask(message.task_id);
    this.assertIteration(task, message.iteration);
    if (task.state !== "EXECUTING") {
      throw new Error(`EXECUTED_NOT_ALLOWED_IN_STATE: ${task.state}`);
    }
    return this.store.update(task.task_id, {
      state: "EXECUTED",
      reason: `CODEX_EXIT_${message.exit_code}`,
    });
  }

  private async acceptDone(
    message: Extract<ControlMessage, { kind: "DONE" }>,
  ): Promise<TaskRecord> {
    const task = await this.requireTask(message.task_id);
    this.assertIteration(task, message.iteration);
    if (task.state !== "DONE" || !task.review_approved) {
      throw new Error("DONE_REQUIRES_REVIEW_APPROVAL");
    }
    return this.store.update(task.task_id, {
      done_summary: message.summary,
      reason: "DONE_ACKNOWLEDGED",
    });
  }
}
