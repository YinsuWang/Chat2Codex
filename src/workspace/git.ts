import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolveContainedPath } from "./containment.js";
const execFileAsync = promisify(execFile);
export type GitDiffMode = "unstaged" | "staged" | "head";
export interface GitDiffResult { content: string; offset: number; has_more: boolean; next_offset: number | null; }
async function git(root: string, args: string[]): Promise<string> { return (await execFileAsync("git", args, { cwd: root, encoding: "utf8", windowsHide: true, maxBuffer: 8 * 1024 * 1024 })).stdout; }
export async function getGitStatus(root: string): Promise<string> { const canonicalRoot = (await resolveContainedPath(root, ".")).absolutePath; return git(canonicalRoot, ["status", "--porcelain=v2", "--branch"]); }
function diffArgs(mode: GitDiffMode): string[] { const args = ["diff", "--no-ext-diff", "--no-color"]; if (mode === "staged") args.push("--cached"); else if (mode === "head") args.push("HEAD"); else if (mode !== "unstaged") throw new Error(`INVALID_DIFF_MODE: ${mode}`); return args; }
async function fullSafeDiff(root: string, mode: GitDiffMode): Promise<string> {
  const base = diffArgs(mode);
  const safeMain = await git(root, [...base, "--", ".", ":(exclude,glob)**/.env", ":(exclude,glob)**/.env.*", ":(exclude,glob)**/id_rsa", ":(exclude,glob)**/id_dsa", ":(exclude,glob)**/id_ecdsa", ":(exclude,glob)**/id_ed25519", ":(exclude,glob)**/*.pem", ":(exclude,glob)**/*.key", ":(exclude,glob)**/*.p12", ":(exclude,glob)**/*.pfx", ":(exclude,glob)**/.ssh/**", ":(exclude,glob)**/.aws/credentials", ":(exclude,glob)**/.config/gcloud/application_default_credentials.json"]);
  const allowedEnvExample = await git(root, [...base, "--", ":(glob)**/.env.example"]);
  return `${safeMain}${allowedEnvExample}`;
}
export async function getGitDiff(root: string, mode: GitDiffMode = "unstaged", requestedPath?: string, offset = 0, maxBytes = 64 * 1024): Promise<GitDiffResult> {
  if (!Number.isInteger(offset) || offset < 0) throw new Error("INVALID_DIFF_OFFSET");
  if (!Number.isInteger(maxBytes) || maxBytes < 1024 || maxBytes > 256 * 1024) throw new Error("INVALID_DIFF_MAX_BYTES");
  const canonicalRoot = (await resolveContainedPath(root, ".")).absolutePath;
  let raw: string;
  if (requestedPath !== undefined) { const resolved = await resolveContainedPath(canonicalRoot, requestedPath); raw = await git(canonicalRoot, [...diffArgs(mode), "--", resolved.relativePath]); }
  else raw = await fullSafeDiff(canonicalRoot, mode);
  const output = Buffer.from(raw, "utf8");
  const end = Math.min(output.length, offset + maxBytes);
  return { content: output.subarray(offset, end).toString("utf8"), offset, has_more: end < output.length, next_offset: end < output.length ? end : null };
}
