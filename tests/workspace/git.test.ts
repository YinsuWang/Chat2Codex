import { execFile } from "node:child_process";
import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getGitDiff, getGitStatus } from "../../src/workspace/git.js";
const execFileAsync = promisify(execFile); let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "chat2codex-git-")); await execFileAsync("git", ["init"], { cwd: root }); await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: root }); await execFileAsync("git", ["config", "user.name", "Test"], { cwd: root }); await writeFile(join(root, "safe.txt"), "base\n"); await writeFile(join(root, ".env"), "secret\n"); await writeFile(join(root, ".env.example"), "sample\n"); await execFileAsync("git", ["add", "."], { cwd: root }); await execFileAsync("git", ["commit", "-m", "base"], { cwd: root }); });
afterEach(async () => rm(root, { recursive: true, force: true }));
describe("git read wrappers", () => {
  it("uses porcelain v2 status", async () => { await appendFile(join(root, "safe.txt"), "changed\n"); expect(await getGitStatus(root)).toContain("# branch"); });
  it("omits sensitive diffs but includes .env.example", async () => { await appendFile(join(root, "safe.txt"), "safe-change\n"); await appendFile(join(root, ".env"), "secret-change\n"); await appendFile(join(root, ".env.example"), "sample-change\n"); const result = await getGitDiff(root, "unstaged"); expect(result.content).toContain("safe-change"); expect(result.content).toContain("sample-change"); expect(result.content).not.toContain("secret-change"); });
  it("rejects a sensitive requested path", async () => { await expect(getGitDiff(root, "unstaged", ".env")).rejects.toThrow(/SENSITIVE/); });
});
