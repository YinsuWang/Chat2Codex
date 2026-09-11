import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { CodexAdapter, CodexRunInput } from "../codex/adapter.js";
import type { WorkspaceRecord } from "../config/types.js";
import { ControlService } from "../control/service.js";
import { ExecutionRecorder } from "../execution/recorder.js";
import type { PlanMessage } from "../protocol/types.js";
import { TaskService } from "../task/service.js";
import { TaskStore, type TaskRecord } from "../task/store.js";
import { WorktreeManager, type TaskWorktree } from "../workspace/worktree.js";

const execFileAsync = promisify(execFile);

export interface SupervisorDependencies {
  taskStore?: TaskStore;
  taskService?: TaskService;
  controlService?: ControlService;
  worktreeManager?: WorktreeManager;
  codexAdapter: CodexAdapter;
  recorder?: ExecutionRecorder;
}

function currentPlan(task: TaskRecord): PlanMessage {
  const plan: PlanMessage = {
    kind: "PLAN",
    workspace_id: task.workspace_id,
    task_id: task.task_id,
    iteration: task.iteration,
    implementation_mode: task.implementation_mode,
    goal: task.goal,
    instructions: [...task.instructions],
    constraints: [...task.constraints],
    acceptance_criteria: [...task.acceptance_criteria],
  };
  if (task.base_sha !== undefined) plan.base_sha = task.base_sha;
  if (task.patch !== undefined) plan.patch = task.patch;
  return plan;
}

async function changedFiles(worktreePath: string): Promise<string[]> {
  const common = {
    cwd: worktreePath,
    encoding: "buffer" as const,
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
  };
  const [tracked, untracked] = await Promise.all([
    execFileAsync("git", ["diff", "--name-only", "-z", "HEAD"], common),
    execFileAsync("git", ["ls-files", "--others", "--exclude-standard", "-z"], common),
  ]);
  const decode = (value: Buffer): string[] =>
    value.toString("utf8").split("\0").filter(Boolean);
  return [...new Set([...decode(tracked.stdout), ...decode(untracked.stdout)])].sort();
}

export class Supervisor {
  readonly taskStore: TaskStore;
  readonly taskService: TaskService;
  readonly controlService: ControlService;
  readonly worktreeManager: WorktreeManager;
  readonly recorder: ExecutionRecorder;
  private readonly codexAdapter: CodexAdapter;

  constructor(
    readonly workspace: WorkspaceRecord,
    dependencies: SupervisorDependencies,
  ) {
    this.taskStore = dependencies.taskStore ?? new TaskStore();
    this.taskService = dependencies.taskService ?? new TaskService(this.taskStore, workspace);
    this.controlService = dependencies.controlService ?? new ControlService(workspace.workspace_id);
    this.worktreeManager = dependencies.worktreeManager ?? new WorktreeManager();
    this.codexAdapter = dependencies.codexAdapter;
    this.recorder = dependencies.recorder ?? new ExecutionRecorder();
  }

  async tick(): Promise<void> {
    const inbound = await this.controlService.receiveInbound();
    if (inbound) await this.handleInbound(inbound.id, inbound.message);

    const planned = (await this.taskStore.list())
      .filter(
        (task) =>
          task.workspace_id === this.workspace.workspace_id && task.state === "PLANNED",
      )
      .sort((a, b) => a.created_at.localeCompare(b.created_at))[0];
    if (planned) await this.dispatchPlannedTask(planned.task_id);
  }

  async handleInbound(
    envelopeId: string,
    message: Parameters<TaskService["acceptControlMessage"]>[0],
  ): Promise<TaskRecord> {
    if (message.kind === "EXECUTED") {
      throw new Error("EXECUTED_IS_SUPERVISOR_OWNED");
    }
    const task = await this.taskService.acceptControlMessage(message);
    await this.controlService.acknowledgeInbound(envelopeId);
    return task;
  }

  async dispatchPlannedTask(taskId: string): Promise<void> {
    let task = await this.taskStore.get(taskId);
    if (task.workspace_id !== this.workspace.workspace_id) {
      throw new Error(
        `WORKSPACE_MISMATCH: ${task.workspace_id} != ${this.workspace.workspace_id}`,
      );
    }
    if (task.state !== "PLANNED") return;

    let worktree: TaskWorktree;
    try {
      await this.worktreeManager.validateBase(task, this.workspace);
      worktree = await this.worktreeManager.create(task, this.workspace);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.startsWith("STALE_BASE")) {
        await this.taskStore.update(task.task_id, {
          state: "BLOCKED",
          reason: "STALE_BASE",
        });
        return;
      }
      throw error;
    }

    task = await this.taskStore.update(task.task_id, {
      state: "DISPATCHED",
      reason: "WORKTREE_READY",
    });
    const plan = currentPlan(task);
    await this.recorder.startIteration({
      task_id: task.task_id,
      iteration: task.iteration,
      control_message: plan,
    });

    const input: CodexRunInput = {
      workspace_id: task.workspace_id,
      task_id: task.task_id,
      iteration: task.iteration,
      implementation_mode: task.implementation_mode,
      goal: task.goal,
      instructions: [...task.instructions],
      constraints: [...task.constraints],
      acceptance_criteria: [...task.acceptance_criteria],
      worktree_path: worktree.path,
      onEvent: async (event) =>
        this.recorder.appendCodexEvent(task.task_id, task.iteration, event),
    };
    if (task.base_sha !== undefined) input.base_sha = task.base_sha;
    if (task.patch !== undefined) input.patch = task.patch;

    let handle;
    try {
      handle = await this.codexAdapter.start(input);
    } catch (error) {
      await this.recorder.finishIteration(task.task_id, task.iteration, {
        exit_code: -1,
        changed_files: await changedFiles(worktree.path).catch(() => []),
        tests_summary: `Codex spawn failed: ${error instanceof Error ? error.message : String(error)}`,
      });
      await this.taskStore.update(task.task_id, {
        state: "FAILED",
        reason: "CODEX_SPAWN_FAILED",
      });
      return;
    }

    await this.taskStore.update(task.task_id, {
      state: "EXECUTING",
      reason: `CODEX_STARTED:${handle.execution_id}`,
    });
    const result = await handle.completion;
    if (result.stderr) {
      await this.recorder.recordCommandOutput(
        task.task_id,
        task.iteration,
        "codex-stderr",
        result.stderr,
      );
    }
    const files = await changedFiles(worktree.path);
    const testsSummary =
      result.exit_code === 0
        ? "Codex process exited successfully; inspect recorded outputs for test details."
        : `Codex process exited ${result.exit_code}.`;
    await this.recorder.finishIteration(task.task_id, task.iteration, {
      exit_code: result.exit_code,
      changed_files: files,
      tests_summary: testsSummary,
    });

    if (result.exit_code !== 0 || result.spawn_error) {
      await this.taskStore.update(task.task_id, {
        state: "FAILED",
        reason: `CODEX_EXIT_${result.exit_code}`,
      });
      await this.controlService.publishOutbound({
        kind: "EXECUTED",
        workspace_id: task.workspace_id,
        task_id: task.task_id,
        iteration: task.iteration,
        exit_code: result.exit_code,
        changed_files: files.length,
        tests_summary: testsSummary,
      });
      return;
    }

    await this.taskStore.update(task.task_id, {
      state: "EXECUTED",
      reason: "EXECUTION_RECORDED",
    });
    await this.controlService.publishOutbound({
      kind: "EXECUTED",
      workspace_id: task.workspace_id,
      task_id: task.task_id,
      iteration: task.iteration,
      exit_code: result.exit_code,
      changed_files: files.length,
      tests_summary: testsSummary,
    });
    await this.taskStore.update(task.task_id, {
      state: "REVIEWING",
      reason: "EXECUTED_PUBLISHED",
    });
  }

  async recoverInterruptedTasks(): Promise<TaskRecord[]> {
    const recovered: TaskRecord[] = [];
    for (const task of await this.taskStore.list()) {
      if (task.workspace_id !== this.workspace.workspace_id) continue;
      if (task.state === "EXECUTING" || task.state === "DISPATCHED") {
        recovered.push(
          await this.taskStore.update(task.task_id, {
            state: "BLOCKED",
            reason: "INTERRUPTED_EXECUTION",
          }),
        );
      } else if (task.state === "EXECUTED") {
        const summary = await this.recorder.getSummary(task.task_id, task.iteration);
        await this.controlService.publishOutbound({
          kind: "EXECUTED",
          workspace_id: task.workspace_id,
          task_id: task.task_id,
          iteration: task.iteration,
          exit_code: summary.exit_code ?? 0,
          changed_files: summary.changed_files.length,
          tests_summary: summary.tests_summary,
        });
        recovered.push(
          await this.taskStore.update(task.task_id, {
            state: "REVIEWING",
            reason: "EXECUTED_REPUBLISHED",
          }),
        );
      }
    }
    return recovered;
  }
}
