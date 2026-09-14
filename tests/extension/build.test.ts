import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(import.meta.dirname, "../..");
const BUILD_SCRIPT = resolve(ROOT, "scripts/build-extension.mjs");
const OUT_DIR = resolve(ROOT, "dist-extension");
const EXPECTED_FILES = [
  "content-script.js",
  "manifest.json",
  "popup.html",
  "popup.js",
  "service-worker.js",
];

function buildExtension(): void {
  execFileSync(process.execPath, [BUILD_SCRIPT], {
    cwd: ROOT,
    env: process.env,
    stdio: "pipe",
  });
}

async function snapshot(): Promise<Record<string, string>> {
  const names = (await readdir(OUT_DIR)).sort();
  const result: Record<string, string> = {};
  for (const name of names) {
    const content = await readFile(resolve(OUT_DIR, name));
    result[name] = createHash("sha256").update(content).digest("hex");
  }
  return result;
}

describe("extension build", () => {
  it("produces the complete unpacked extension artifact without Node builtins", async () => {
    buildExtension();
    expect((await readdir(OUT_DIR)).sort()).toEqual(EXPECTED_FILES);

    for (const name of ["content-script.js", "popup.js", "service-worker.js"]) {
      const text = await readFile(resolve(OUT_DIR, name), "utf8");
      expect(text).not.toContain("node:");
      expect(text).not.toMatch(/require\(["'](?:fs|path|crypto|http|https|child_process)["']\)/);
    }
  });

  it("is deterministic across consecutive clean builds", async () => {
    buildExtension();
    const first = await snapshot();
    buildExtension();
    const second = await snapshot();
    expect(second).toEqual(first);
  });
});
