import { homedir } from "node:os";
import { describe, expect, it } from "vitest";

import { sanitizeOutput } from "../../src/execution/sanitizer.js";

describe("sanitizeOutput", () => {
  it("redacts common tokens and the user home path", () => {
    const input = `Bearer abcdefghijklmnop ghp_123456789012345678901234 sk-abcdefghijklmnopq ${homedir()}/project`;
    const result = sanitizeOutput(input);
    expect(result.status).toBe("readable");
    expect(result.body).toContain("<redacted:bearer-token>");
    expect(result.body).toContain("<redacted:github-token>");
    expect(result.body).toContain("<redacted:openai-key>");
    expect(result.body).toContain("<home>");
    expect(result.body).not.toContain("ghp_");
    expect(result.body).not.toContain("sk-");
  });

  it("withholds an entire private-key body", () => {
    const result = sanitizeOutput("-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----");
    expect(result).toEqual({ status: "restricted", redactions: ["private-key"], truncated: false });
  });

  it("caps readable output by line count", () => {
    const result = sanitizeOutput(Array.from({ length: 2001 }, (_, i) => `line-${i}`).join("\n"));
    expect(result.status).toBe("readable");
    expect(result.truncated).toBe(true);
    expect(result.body?.split("\n")).toHaveLength(2000);
  });
});
