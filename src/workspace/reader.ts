import { createReadStream } from "node:fs";
import { open, readFile, readdir } from "node:fs/promises";
import { createInterface } from "node:readline";
import ignore, { type Ignore } from "ignore";
import { resolveContainedPath } from "./containment.js";

export const MAX_READ_BYTES = 256 * 1024;
export const MAX_BINARY_PROBE_BYTES = 8 * 1024;
export interface NumberedLine { line: number; text: string; }
export interface ReadTextResult { path: string; lines: NumberedLine[]; has_more: boolean; next_start_line: number | null; }
export interface DirectoryEntry { path: string; name: string; type: "file" | "directory" | "symlink" | "other"; }

async function loadIgnore(root: string): Promise<Ignore> {
  const matcher = ignore();
  try {
    const resolved = await resolveContainedPath(root, ".chat2codexignore");
    matcher.add(await readFile(resolved.absolutePath, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes("NO_EXISTING") && !message.includes("ENOENT")) throw error;
    }
  }
  return matcher;
}

function ignorePath(relativePath: string, directory: boolean): string {
  if (relativePath === ".") return "";
  const normalized = relativePath.replace(/\\/g, "/");
  return directory ? `${normalized.replace(/\/$/, "")}/` : normalized;
}

async function assertNotIgnored(root: string, relativePath: string, directory = false): Promise<void> {
  if (relativePath === "." || relativePath === ".chat2codexignore") return;
  const matcher = await loadIgnore(root);
  if (matcher.ignores(ignorePath(relativePath, directory))) throw new Error(`PATH_IGNORED: ${relativePath}`);
}

async function assertTextFile(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    const probe = Buffer.alloc(MAX_BINARY_PROBE_BYTES);
    const { bytesRead } = await handle.read(probe, 0, probe.length, 0);
    if (probe.subarray(0, bytesRead).includes(0)) throw new Error("BINARY_FILE_NOT_ALLOWED");
  } finally {
    await handle.close();
  }
}

export async function readTextFile(root: string, requested: string, startLine = 1, endLine = startLine + 399): Promise<ReadTextResult> {
  if (!Number.isInteger(startLine) || startLine < 1) throw new Error("INVALID_START_LINE");
  if (!Number.isInteger(endLine) || endLine < startLine) throw new Error("INVALID_END_LINE");
  const resolved = await resolveContainedPath(root, requested);
  await assertNotIgnored(root, resolved.relativePath);
  await assertTextFile(resolved.absolutePath);
  const stream = createReadStream(resolved.absolutePath, { encoding: "utf8" });
  const linesReader = createInterface({ input: stream, crlfDelay: Infinity });
  const lines: NumberedLine[] = [];
  let bytes = 0;
  let lineNumber = 0;
  let hasMore = false;
  let nextStartLine: number | null = null;
  try {
    for await (const text of linesReader) {
      lineNumber += 1;
      if (lineNumber < startLine) continue;
      if (lineNumber > endLine) { hasMore = true; nextStartLine = lineNumber; break; }
      const lineBytes = Buffer.byteLength(text, "utf8") + 1;
      if (lineBytes > MAX_READ_BYTES) throw new Error(`LINE_EXCEEDS_READ_CAP: line ${lineNumber}`);
      if (bytes + lineBytes > MAX_READ_BYTES) { hasMore = true; nextStartLine = lineNumber; break; }
      lines.push({ line: lineNumber, text });
      bytes += lineBytes;
    }
  } finally {
    linesReader.close();
    stream.destroy();
  }
  return { path: resolved.relativePath, lines, has_more: hasMore, next_start_line: hasMore ? nextStartLine : null };
}

export async function listDirectory(root: string, requested = "."): Promise<DirectoryEntry[]> {
  const resolved = await resolveContainedPath(root, requested);
  await assertNotIgnored(root, resolved.relativePath, true);
  const matcher = await loadIgnore(root);
  const entries = await readdir(resolved.absolutePath, { withFileTypes: true });
  const result: DirectoryEntry[] = [];
  for (const entry of entries) {
    const childRequest = resolved.relativePath === "." ? entry.name : `${resolved.relativePath}/${entry.name}`;
    let child;
    try { child = await resolveContainedPath(root, childRequest); }
    catch (error) {
      if (error instanceof Error && (error.message.startsWith("SENSITIVE_PATH_DENIED") || error.message === "SYMLINK_ESCAPE")) continue;
      throw error;
    }
    const directory = entry.isDirectory();
    if (matcher.ignores(ignorePath(child.relativePath, directory))) continue;
    result.push({ path: child.relativePath, name: entry.name, type: entry.isFile() ? "file" : directory ? "directory" : entry.isSymbolicLink() ? "symlink" : "other" });
  }
  return result.sort((a, b) => a.path.localeCompare(b.path));
}
