import type { ControlMessage } from "../protocol/types.js";

export interface ExecutionIterationStart {
  task_id: string;
  iteration: number;
  control_message: ControlMessage;
}

export interface ExecutionFinishInput {
  exit_code: number;
  changed_files: string[];
  tests_summary: string;
}

export interface ExecutionSummary {
  task_id: string;
  iteration: number;
  status: "running" | "completed";
  started_at: string;
  ended_at?: string;
  exit_code?: number;
  changed_files: string[];
  tests_summary: string;
}

export interface ExecutionOutputEntry {
  id: string;
  label: string;
  created_at: string;
  status: "readable" | "restricted";
  redactions: string[];
  truncated: boolean;
}
