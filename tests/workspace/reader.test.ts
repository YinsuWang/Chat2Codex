import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listDirectory, readTextFile } from "../../src/workspace/reader.js";
import { searchWorkspace } from "../../src/workspace/search.js";
let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "chat2codex-reader-")); await writeFile(join(root, "safe.txt"), "one\ntwo\nneedle three\nfour\n"); await writeFile(join(root, ".env"), "needle secret\n"); await writeFile(join(root, ".env.example"), "needle sample\n"); await writeFile(join(root, "ignored.txt"), "needle ignored\n"); await writeFile(join(root, ".chat2codexignore"), "ignored.txt\n"); await writeFile(join(root, "binary.bin"), Buffer.from([65, 0, 66])); });
afterEach(async () => rm(root, { recursive: true, force: true }));
describe("read-only workspace services", () => {
  it("returns numbered paginated lines", async () => { const result = await readTextFile(root, "safe.txt", 2, 2); expect(result.lines).toEqual([{ line: 2, text: "two" }]); expect(result.has_more).toBe(true); expect(result.next_start_line).toBe(3); });
  it("rejects binary files and ignore exclusions", async () => { await expect(readTextFile(root, "binary.bin")).rejects.toThrow(/BINARY/); await expect(readTextFile(root, "ignored.txt")).rejects.toThrow(/PATH_IGNORED/); });
  it("hides denied and ignored paths from listings", async () => { const paths = (await listDirectory(root)).map((entry) => entry.path); expect(paths).not.toContain(".env"); expect(paths).not.toContain("ignored.txt"); expect(paths).toContain(".env.example"); });
  it("searches source and .env.example without exposing secrets", async () => { const paths = (await searchWorkspace(root, "needle", 20)).map((m) => m.path); expect(paths).toContain("safe.txt"); expect(paths).toContain(".env.example"); expect(paths).not.toContain(".env"); expect(paths).not.toContain("ignored.txt"); });
  it("caps search limit at 200", async () => { await expect(searchWorkspace(root, "needle", 201)).rejects.toThrow(/INVALID_SEARCH_LIMIT/); });
});
