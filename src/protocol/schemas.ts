import { z } from "zod";

import type { ControlMessage } from "./types.js";

const nonEmptyString = z.string().trim().min(1);
const identityShape = {
  workspace_id: nonEmptyString,
  task_id: nonEmptyString,
  iteration: z.number().int().min(0),
} as const;

const planSchema = z
  .object({
    ...identityShape,
    kind: z.literal("PLAN"),
    implementation_mode: z.enum(["delegate", "guided", "patch"]),
    base_sha: nonEmptyString.optional(),
    goal: nonEmptyString,
    instructions: z.array(nonEmptyString),
    constraints: z.array(nonEmptyString),
    acceptance_criteria: z.array(nonEmptyString),
    patch: nonEmptyString.optional(),
  })
  .strict();

const executedSchema = z
  .object({
    ...identityShape,
    kind: z.literal("EXECUTED"),
    exit_code: z.number().int(),
    changed_files: z.number().int().min(0),
    tests_summary: z.string(),
  })
  .strict();

const reviewFindingSchema = z
  .object({
    severity: z.enum(["low", "medium", "high"]),
    file: nonEmptyString.optional(),
    issue: nonEmptyString,
    required_change: nonEmptyString,
  })
  .strict();

const reviewSchema = z
  .object({
    ...identityShape,
    kind: z.literal("REVIEW"),
    decision: z.enum(["PASS", "REVISE"]),
    findings: z.array(reviewFindingSchema),
  })
  .strict();

const doneSchema = z
  .object({
    ...identityShape,
    kind: z.literal("DONE"),
    summary: z.string(),
  })
  .strict();

export const controlMessageSchema = z
  .discriminatedUnion("kind", [
    planSchema,
    executedSchema,
    reviewSchema,
    doneSchema,
  ])
  .superRefine((message, context) => {
    if (message.kind !== "PLAN") {
      return;
    }

    if (message.implementation_mode === "patch" && message.patch === undefined) {
      context.addIssue({
        code: "custom",
        path: ["patch"],
        message: "patch mode requires a non-empty patch",
      });
    }

    if (message.implementation_mode !== "patch" && message.patch !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["patch"],
        message: "patch is only allowed when implementation_mode is patch",
      });
    }
  });

export function parseControlMessage(input: unknown): ControlMessage {
  return controlMessageSchema.parse(input) as ControlMessage;
}
