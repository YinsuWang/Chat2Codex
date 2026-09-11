import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { READ_ONLY_TOOL_NAMES } from "../../src/mcp/tools.js";
import { createChat2CodexMcpServer } from "../../src/mcp/server.js";
import { registerWorkspace } from "../../src/workspace/registry.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

describe("read-only MCP tools", () => {
  it("registers only the approved data-plane tool names", () => {
    expect(READ_ONLY_TOOL_NAMES).toEqual([
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
    ]);
    for (const name of READ_ONLY_TOOL_NAMES) {
      expect([
        "write_file",
        "exec_command",
        "shell",
        "delete_file",
        "git_commit",
        "git_push",
        "apply_patch",
      ]).not.toContain(name);
    }
  });

  it("constructs a server for a registered workspace", async () => {
    const state = await mkdtemp(join(tmpdir(), "c2c-state-"));
    process.env.CHAT2CODEX_STATE_DIR = state;
    const repo = await mkdtemp(join(tmpdir(), "c2c-repo-"));
    git(repo, "init");
    git(repo, "config", "user.email", "test@example.com");
    git(repo, "config", "user.name", "Test");
    await writeFile(join(repo, "README.md"), "hello\n");
    git(repo, "add", ".");
    git(repo, "commit", "-m", "base");
    const workspace = await registerWorkspace(repo);
    expect(createChat2CodexMcpServer({ workspace })).toBeDefined();
  });
});
