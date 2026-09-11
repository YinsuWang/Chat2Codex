import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

import type { WorkspaceRecord } from "../config/types.js";
import { ExecutionRecorder } from "../execution/recorder.js";
import type { ExecutionSummary } from "../execution/types.js";
import { TaskStore, type TaskRecord } from "../task/store.js";
import { getGitDiff, getGitStatus } from "../workspace/git.js";
import { listDirectory, readTextFile } from "../workspace/reader.js";
import { searchWorkspace } from "../workspace/search.js";

export interface McpToolDependencies {
  workspace: WorkspaceRecord;
  taskStore?: TaskStore;
  recorder?: ExecutionRecorder;
}

export const READ_ONLY_TOOL_NAMES = [
  "workspace_info",
  "list_directory",
  "read_file",
  "search_workspace",
  "git_status",
  "git_diff",
  "task_get",
  "task_list",
  "task_history",
  "execution_summary",
  "execution_output",
  "test_status",
] as const;

const safeId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
const relativePath = z.string().min(1).max(4096);

function jsonResult(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }] };
}

function publicTask(task: TaskRecord) {
  return {
    task_id: task.task_id,
    workspace_id: task.workspace_id,
    state: task.state,
    iteration: task.iteration,
    implementation_mode: task.implementation_mode,
    base_sha: task.base_sha ?? null,
    goal: task.goal,
    instructions: task.instructions,
    constraints: task.constraints,
    acceptance_criteria: task.acceptance_criteria,
    created_at: task.created_at,
    updated_at: task.updated_at,
    review_approved: task.review_approved,
    last_review_findings: task.last_review_findings,
  };
}

async function latestSummary(
  recorder: ExecutionRecorder,
  task: TaskRecord,
  requestedIteration?: number,
): Promise<ExecutionSummary> {
  if (requestedIteration !== undefined) {
    return recorder.getSummary(task.task_id, requestedIteration);
  }
  for (let iteration = task.iteration; iteration >= 0; iteration -= 1) {
    try {
      return await recorder.getSummary(task.task_id, iteration);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  throw new Error(`EXECUTION_NOT_FOUND: ${task.task_id}`);
}

export function registerReadOnlyTools(
  server: McpServer,
  dependencies: McpToolDependencies,
): void {
  const taskStore = dependencies.taskStore ?? new TaskStore();
  const recorder = dependencies.recorder ?? new ExecutionRecorder();
  const root = dependencies.workspace.git_root;

  server.registerTool(
    "workspace_info",
    {
      description: "Return the identity of the bound Chat2Codex workspace. Read-only.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async () =>
      jsonResult({
        workspace_id: dependencies.workspace.workspace_id,
        workspace_name: dependencies.workspace.workspace_name,
        machine: dependencies.workspace.machine,
        git_remote: dependencies.workspace.git_remote,
      }),
  );

  server.registerTool(
    "list_directory",
    {
      description: "List a directory inside the bound workspace. Sensitive paths are omitted.",
      inputSchema: z.object({
        path: relativePath.default("."),
        limit: z.number().int().min(1).max(500).default(200),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ path, limit }) => jsonResult((await listDirectory(root, path)).slice(0, limit)),
  );

  server.registerTool(
    "read_file",
    {
      description: "Read a bounded line range from a text file inside the workspace.",
      inputSchema: z
        .object({
          path: relativePath,
          start_line: z.number().int().min(1).max(10_000_000).default(1),
          end_line: z.number().int().min(1).max(10_000_000).optional(),
        })
        .superRefine((value, context) => {
          const end = value.end_line ?? value.start_line + 399;
          if (end < value.start_line || end - value.start_line > 399) {
            context.addIssue({
              code: "custom",
              path: ["end_line"],
              message: "line range must contain at most 400 lines",
            });
          }
        }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ path, start_line, end_line }) =>
      jsonResult(await readTextFile(root, path, start_line, end_line ?? start_line + 399)),
  );

  server.registerTool(
    "search_workspace",
    {
      description: "Search literal text in the workspace without exposing sensitive files.",
      inputSchema: z.object({
        query: z.string().min(1).max(1000),
        limit: z.number().int().min(1).max(200).default(50),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ query, limit }) => jsonResult(await searchWorkspace(root, query, limit)),
  );

  server.registerTool(
    "git_status",
    {
      description: "Return Git porcelain-v2 status for the bound workspace.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async () => jsonResult({ status: await getGitStatus(root) }),
  );

  server.registerTool(
    "git_diff",
    {
      description: "Return a bounded safe Git diff from the workspace.",
      inputSchema: z.object({
        mode: z.enum(["unstaged", "staged", "head"]).default("unstaged"),
        path: relativePath.optional(),
        offset: z.number().int().min(0).default(0),
        max_bytes: z.number().int().min(1024).max(256 * 1024).default(64 * 1024),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ mode, path, offset, max_bytes }) =>
      jsonResult(await getGitDiff(root, mode, path, offset, max_bytes)),
  );

  server.registerTool(
    "task_get",
    {
      description: "Return persisted task state and planning metadata.",
      inputSchema: z.object({ task_id: safeId }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ task_id }) => jsonResult(publicTask(await taskStore.get(task_id))),
  );

  server.registerTool(
    "task_list",
    {
      description: "List persisted tasks belonging to this workspace.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async () =>
      jsonResult(
        (await taskStore.list())
          .filter((task) => task.workspace_id === dependencies.workspace.workspace_id)
          .map(publicTask),
      ),
  );

  server.registerTool(
    "task_history",
    {
      description: "Return task state transitions only.",
      inputSchema: z.object({ task_id: safeId }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ task_id }) => jsonResult((await taskStore.get(task_id)).history),
  );

  server.registerTool(
    "execution_summary",
    {
      description: "Return a persisted execution summary. This does not run any command.",
      inputSchema: z.object({
        task_id: safeId,
        iteration: z.number().int().min(0).optional(),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ task_id, iteration }) => {
      const task = await taskStore.get(task_id);
      return jsonResult(await latestSummary(recorder, task, iteration));
    },
  );

  server.registerTool(
    "execution_output",
    {
      description:
        "List or read sanitized execution output. Restricted output bodies are never returned.",
      inputSchema: z.object({
        task_id: safeId,
        iteration: z.number().int().min(0),
        output_id: safeId.optional(),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ task_id, iteration, output_id }) => {
      if (!output_id) return jsonResult(await recorder.listOutputs(task_id, iteration));
      return jsonResult(await recorder.readOutput(task_id, iteration, output_id));
    },
  );

  server.registerTool(
    "test_status",
    {
      description: "Project the latest persisted test/execution status. It never starts tests.",
      inputSchema: z.object({ task_id: safeId }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ task_id }) => {
      const task = await taskStore.get(task_id);
      const summary = await latestSummary(recorder, task);
      return jsonResult({
        task_id,
        iteration: summary.iteration,
        status: summary.status,
        exit_code: summary.exit_code ?? null,
        tests_summary: summary.tests_summary,
        changed_files: summary.changed_files.length,
      });
    },
  );
}
