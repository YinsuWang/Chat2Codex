import type { CodexRunInput } from "./adapter.js";

const INVARIANT = `You are the local execution layer. ChatGPT owns the requested design and review.
You may inspect additional local files needed for correctness.
Only you may modify project files or run project commands.
Do not claim success without running the requested verification when it is available.`;

function bullets(values: string[]): string {
  return values.length === 0 ? "- (none)" : values.map((value) => `- ${value}`).join("\n");
}

export function buildCodexPrompt(input: CodexRunInput): string {
  const sections = [
    `TASK\nworkspace_id: ${input.workspace_id}\ntask_id: ${input.task_id}\niteration: ${input.iteration}`,
    `MODE\n${input.implementation_mode}`,
    `GOAL\n${input.goal}`,
    `INSTRUCTIONS\n${bullets(input.instructions)}`,
    `CONSTRAINTS\n${bullets(input.constraints)}`,
    `ACCEPTANCE CRITERIA\n${bullets(input.acceptance_criteria)}`,
  ];

  if (input.implementation_mode === "delegate") {
    sections.push("EXECUTION GUIDANCE\nInspect the local repository as needed and determine the concrete implementation that satisfies the requested design.");
  } else if (input.implementation_mode === "guided") {
    sections.push("EXECUTION GUIDANCE\nFollow ChatGPT's concrete implementation guidance closely, but adapt it when the current local APIs, types, or dependencies require a correctness-preserving integration change.");
  } else {
    if (!input.patch || input.patch.trim().length === 0) {
      throw new Error("PATCH_REQUIRED: patch mode requires patch content");
    }
    if (!input.base_sha) {
      throw new Error("BASE_SHA_REQUIRED: patch mode requires base_sha");
    }
    sections.push(`EXECUTION GUIDANCE\nValidate that the local task worktree is based on ${input.base_sha} before applying the patch. Apply the patch exactly where possible; if local integration requires adaptation, preserve the requested semantics and report the adaptation through normal execution evidence.`);
    sections.push(`PATCH\n${input.patch}`);
  }

  sections.push(INVARIANT);
  sections.push("RESULT DISCIPLINE\nDo not return file bodies for transport to ChatGPT. Make the changes locally and run the requested verification; ChatGPT will inspect the resulting diff and recorded evidence separately.");
  return sections.join("\n\n");
}

export { INVARIANT as CODEX_EXECUTION_INVARIANT };
