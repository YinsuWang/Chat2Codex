export type ImplementationMode = "delegate" | "guided" | "patch";

export interface MessageIdentity {
  workspace_id: string;
  task_id: string;
  iteration: number;
}

export interface PlanMessage extends MessageIdentity {
  kind: "PLAN";
  implementation_mode: ImplementationMode;
  base_sha?: string;
  goal: string;
  instructions: string[];
  constraints: string[];
  acceptance_criteria: string[];
  patch?: string;
}

export interface ExecutedMessage extends MessageIdentity {
  kind: "EXECUTED";
  exit_code: number;
  changed_files: number;
  tests_summary: string;
}

export interface ReviewFinding {
  severity: "low" | "medium" | "high";
  file?: string;
  issue: string;
  required_change: string;
}

export interface ReviewMessage extends MessageIdentity {
  kind: "REVIEW";
  decision: "PASS" | "REVISE";
  findings: ReviewFinding[];
}

export interface DoneMessage extends MessageIdentity {
  kind: "DONE";
  summary: string;
}

export type ControlMessage =
  | PlanMessage
  | ExecutedMessage
  | ReviewMessage
  | DoneMessage;
