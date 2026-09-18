import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

describe("relay acceptance script", () => {
  it("prints help without requiring a built runtime", async () => {
    const script = join(process.cwd(), "scripts", "acceptance-relay.mjs");
    const { stdout } = await execFileAsync(process.execPath, [script, "--help"], {
      cwd: process.cwd(),
      encoding: "utf8",
      windowsHide: true,
    });

    expect(stdout).toContain("Usage: node scripts/acceptance-relay.mjs");
    expect(stdout).toContain("--workspace <path>");
    expect(stdout).toContain("--json");
  });
});
