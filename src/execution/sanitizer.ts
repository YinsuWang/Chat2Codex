import { homedir } from "node:os";

export interface SanitizedOutput {
  status: "readable" | "restricted";
  body?: string;
  redactions: string[];
  truncated: boolean;
}

const MAX_LINES = 2_000;
const MAX_BYTES = 256 * 1024;

const PRIVATE_KEY_RE = /-----BEGIN(?: [A-Z0-9]+)? PRIVATE KEY-----[\s\S]*?-----END(?: [A-Z0-9]+)? PRIVATE KEY-----/i;
const SECRET_PATTERNS: Array<[string, RegExp]> = [
  ["openai-key", /\bsk-[A-Za-z0-9_-]{16,}\b/g],
  ["github-token", /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g],
  ["bearer-token", /\bBearer\s+[A-Za-z0-9._~+\/-]{12,}={0,2}\b/gi],
];

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function truncateUtf8(input: string): { body: string; truncated: boolean } {
  let lines = input.split(/\r?\n/);
  let truncated = false;
  if (lines.length > MAX_LINES) {
    lines = lines.slice(0, MAX_LINES);
    truncated = true;
  }
  let body = lines.join("\n");
  const encoded = Buffer.from(body, "utf8");
  if (encoded.byteLength > MAX_BYTES) {
    body = encoded.subarray(0, MAX_BYTES).toString("utf8").replace(/\uFFFD$/, "");
    truncated = true;
  }
  return { body, truncated };
}

export function sanitizeOutput(input: string): SanitizedOutput {
  if (PRIVATE_KEY_RE.test(input)) {
    return { status: "restricted", redactions: ["private-key"], truncated: false };
  }

  const redactions = new Set<string>();
  let body = input;
  for (const [type, pattern] of SECRET_PATTERNS) {
    body = body.replace(pattern, () => {
      redactions.add(type);
      return `<redacted:${type}>`;
    });
  }

  const home = homedir();
  if (home) {
    const variants = new Set([home, home.replace(/\\/g, "/"), home.replace(/\//g, "\\")]);
    for (const variant of variants) {
      if (!variant) continue;
      const re = new RegExp(escapeRegExp(variant), process.platform === "win32" ? "gi" : "g");
      if (re.test(body)) {
        redactions.add("home-path");
        body = body.replace(re, "<home>");
      }
    }
  }

  const limited = truncateUtf8(body);
  return {
    status: "readable",
    body: limited.body,
    redactions: [...redactions].sort(),
    truncated: limited.truncated,
  };
}
