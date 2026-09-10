import { appendFile, mkdir, open, readFile, rename } from "node:fs/promises";
import { dirname, join } from "node:path";

import { getStateDir } from "../config/paths.js";
import type { ImplementationMode, PlanMessage, ReviewFinding } from "../protocol/types.js";
import { assertTransition, type TaskState } from "./state-machine.js";

export interface TaskHistoryEntry {
  at: string;
  from: TaskState;
  to: TaskState;
  iteration: number;
  reason: string;
}

interface TaskDescriptor {
  workspace_id: string;
  task_id: string;
  implementation_mode: ImplementationMode;
  base_sha?: string;
  goal: string;
  instructions: string[];
  constraints: string[];
  acceptance_criteria: string[];
  patch?: string;
  created_at: string;
}

interface TaskStateDocument {
  state: TaskState;
  iteration: number;
  review_approved: boolean;
  last_review_findings: ReviewFinding[];
  done_summary?: string;
  updated_at: string;
}

export interface TaskRecord extends TaskDescriptor, TaskStateDocument {
  history: TaskHistoryEntry[];
}

export interface TaskUpdate {
  state?: TaskState;
  iteration?: number;
  reason?: string;
  implementation_mode?: ImplementationMode;
  base_sha?: string | null;
  goal?: string;
  instructions?: string[];
  constraints?: string[];
  acceptance_criteria?: string[];
  patch?: string | null;
  review_approved?: boolean;
  last_review_findings?: ReviewFinding[];
  done_summary?: string;
}

function assertSafeTaskId(taskId: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(taskId)) {
    throw new Error(`INVALID_TASK_ID: ${taskId}`);
  }
}

function taskDir(taskId: string): string {
  assertSafeTaskId(taskId);
  return join(getStateDir(), "tasks", taskId);
}

function taskPath(taskId: string): string {
  return join(taskDir(taskId), "task.json");
}

function statePath(taskId: string): string {
  return join(taskDir(taskId), "state.json");
}

function historyPath(taskId: string): string {
  return join(taskDir(taskId), "history.jsonl");
}

async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  const handle = await open(temporary, "w", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, path);
}

async function readHistory(taskId: string): Promise<TaskHistoryEntry[]> {
  try {
    const raw = await readFile(historyPath(taskId), "utf8");
    return raw
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as TaskHistoryEntry);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

function descriptorFromPlan(plan: PlanMessage, createdAt: string): TaskDescriptor {
  const descriptor: TaskDescriptor = {
    workspace_id: plan.workspace_id,
    task_id: plan.task_id,
    implementation_mode: plan.implementation_mode,
    goal: plan.goal,
    instructions: [...plan.instructions],
    constraints: [...plan.constraints],
    acceptance_criteria: [...plan.acceptance_criteria],
    created_at: createdAt,
  };
  if (plan.base_sha !== undefined) descriptor.base_sha = plan.base_sha;
  if (plan.patch !== undefined) descriptor.patch = plan.patch;
  return descriptor;
}

export class TaskStore {
  async create(plan: PlanMessage): Promise<TaskRecord> {
    const existing = await this.getOrNull(plan.task_id);
    if (existing) {
      throw new Error(`TASK_ALREADY_EXISTS: ${plan.task_id}`);
    }

    const now = new Date().toISOString();
    const descriptor = descriptorFromPlan(plan, now);
    const state: TaskStateDocument = {
      state: "NEW",
      iteration: plan.iteration,
      review_approved: false,
      last_review_findings: [],
      updated_at: now,
    };

    await atomicWriteJson(taskPath(plan.task_id), descriptor);
    await atomicWriteJson(statePath(plan.task_id), state);
    return { ...descriptor, ...state, history: [] };
  }

  async get(taskId: string): Promise<TaskRecord> {
    const descriptor = JSON.parse(await readFile(taskPath(taskId), "utf8")) as TaskDescriptor;
    const state = JSON.parse(await readFile(statePath(taskId), "utf8")) as TaskStateDocument;
    if (descriptor.task_id !== taskId) {
      throw new Error(`TASK_ID_MISMATCH: expected ${taskId}, found ${descriptor.task_id}`);
    }
    return { ...descriptor, ...state, history: await readHistory(taskId) };
  }

  async getOrNull(taskId: string): Promise<TaskRecord | null> {
    try {
      return await this.get(taskId);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      throw error;
    }
  }

  async update(taskId: string, update: TaskUpdate): Promise<TaskRecord> {
    const current = await this.get(taskId);
    const nextIteration = update.iteration ?? current.iteration;
    if (nextIteration < current.iteration) {
      throw new Error(`ITERATION_REGRESSION: ${nextIteration} < ${current.iteration}`);
    }

    let historyEntry: TaskHistoryEntry | null = null;
    if (update.state !== undefined && update.state !== current.state) {
      assertTransition(current.state, update.state);
      historyEntry = {
        at: new Date().toISOString(),
        from: current.state,
        to: update.state,
        iteration: nextIteration,
        reason: update.reason ?? "UNSPECIFIED",
      };
    }

    const descriptor: TaskDescriptor = {
      workspace_id: current.workspace_id,
      task_id: current.task_id,
      implementation_mode: update.implementation_mode ?? current.implementation_mode,
      goal: update.goal ?? current.goal,
      instructions: update.instructions ? [...update.instructions] : current.instructions,
      constraints: update.constraints ? [...update.constraints] : current.constraints,
      acceptance_criteria: update.acceptance_criteria
        ? [...update.acceptance_criteria]
        : current.acceptance_criteria,
      created_at: current.created_at,
    };

    const baseSha = update.base_sha === null ? undefined : update.base_sha ?? current.base_sha;
    const patch = update.patch === null ? undefined : update.patch ?? current.patch;
    if (baseSha !== undefined) descriptor.base_sha = baseSha;
    if (patch !== undefined) descriptor.patch = patch;

    const state: TaskStateDocument = {
      state: update.state ?? current.state,
      iteration: nextIteration,
      review_approved: update.review_approved ?? current.review_approved,
      last_review_findings: update.last_review_findings
        ? [...update.last_review_findings]
        : current.last_review_findings,
      updated_at: new Date().toISOString(),
    };
    const doneSummary = update.done_summary ?? current.done_summary;
    if (doneSummary !== undefined) state.done_summary = doneSummary;

    await atomicWriteJson(taskPath(taskId), descriptor);
    await atomicWriteJson(statePath(taskId), state);
    if (historyEntry) {
      await appendFile(historyPath(taskId), `${JSON.stringify(historyEntry)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
    }
    return { ...descriptor, ...state, history: await readHistory(taskId) };
  }
}
