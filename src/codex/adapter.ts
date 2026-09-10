import type { ImplementationMode } from "../protocol/types.js";

export interface CodexRunInput {
  workspace_id: string;
  task_id: string;
  iteration: number;
  implementation_mode: ImplementationMode;
  base_sha?: string;
  goal: string;
  instructions: string[];
  constraints: string[];
  acceptance_criteria: string[];
  patch?: string;
  worktree_path: string;
  onEvent?: (event: CodexEvent) => void | Promise<void>;
  onStderr?: (chunk: string) => void | Promise<void>;
}

export type CodexEvent = Record<string, unknown> | { type: "unknown"; raw: unknown };

export interface CodexRunResult {
  execution_id: string;
  pid: number | null;
  exit_code: number;
  signal: NodeJS.Signals | null;
  stderr: string;
  spawn_error?: string;
}

export interface CodexRunHandle {
  execution_id: string;
  pid: number | null;
  completion: Promise<CodexRunResult>;
}

export interface CodexAdapter {
  start(input: CodexRunInput): Promise<CodexRunHandle>;
  cancel(executionId: string): Promise<void>;
}
