import { describe, expect, it } from "vitest";

import { runDoctor } from "../src/cli/commands/doctor.js";

describe("doctor", () => {
  it("accepts the complete read-only MCP registry", async () => {
    const report = await runDoctor(process.cwd());
    const mcpTools = report.checks.find((check) => check.name === "mcp_tools");

    expect(mcpTools).toEqual({
      name: "mcp_tools",
      ok: true,
      detail: "Read-only MCP tool registry is valid",
    });
  });
});
