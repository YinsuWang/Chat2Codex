import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { describe, expect, it } from "vitest";

import { startBridge } from "../../src/bridge/runtime.js";
import { registerWorkspace } from "../../src/workspace/registry.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function textOf(result: { content?: Array<{ type: string; text?: string }> }): string {
  return result.content?.find((block) => block.type === "text")?.text ?? "";
}

describe("MCP bridge", () => {
  it("serves workspace_info and denies sensitive file reads", async () => {
    const state = await mkdtemp(join(tmpdir(), "c2c-state-"));
    process.env.CHAT2CODEX_STATE_DIR = state;
    const repo = await mkdtemp(join(tmpdir(), "c2c-repo-"));
    git(repo, "init");
    git(repo, "config", "user.email", "test@example.com");
    git(repo, "config", "user.name", "Test");
    await writeFile(join(repo, "README.md"), "hello\n");
    await writeFile(join(repo, ".env"), "SECRET=never\n");
    git(repo, "add", "README.md");
    git(repo, "commit", "-m", "base");
    const workspace = await registerWorkspace(repo);
    const runtime = await startBridge({ workspace }, { port: 0 });

    const client = new Client(
      { name: "chat2codex-test", version: "1.0.0" },
      { versionNegotiation: { mode: "auto" } },
    );
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${runtime.port}/mcp`),
    );
    try {
      await client.connect(transport);
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toContain("workspace_info");
      const info = await client.callTool({ name: "workspace_info", arguments: {} });
      expect(textOf(info as never)).toContain(workspace.workspace_id);
      const denied = await client.callTool({
        name: "read_file",
        arguments: { path: ".env" },
      });
      expect(denied.isError).toBe(true);
      expect(textOf(denied as never)).not.toContain("never");
    } finally {
      await client.close();
      await runtime.close();
    }
  });
});
