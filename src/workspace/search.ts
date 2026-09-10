import { execFile } from "node:child_process";
import { access, readFile, readdir } from "node:fs/promises";
import { promisify } from "node:util";
import ignore, { type Ignore } from "ignore";
import { isHardDeniedRelativePath, resolveContainedPath } from "./containment.js";

const execFileAsync = promisify(execFile);
const MAX_SEARCH_RESULTS = 200;
const MAX_SEARCH_FILE_BYTES = 2 * 1024 * 1024;
export interface SearchMatch { path: string; line: number; text: string; }

async function loadIgnore(root: string): Promise<Ignore> {
  const matcher = ignore();
  try { const f = await resolveContainedPath(root, ".chat2codexignore"); matcher.add(await readFile(f.absolutePath, "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") { const m = error instanceof Error ? error.message : String(error); if (!m.includes("NO_EXISTING") && !m.includes("ENOENT")) throw error; } }
  return matcher;
}

function assertLimit(limit: number): void {
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_SEARCH_RESULTS) throw new Error(`INVALID_SEARCH_LIMIT: expected 1..${MAX_SEARCH_RESULTS}`);
}
async function rgAvailable(root: string): Promise<boolean> { try { await execFileAsync("rg", ["--version"], { cwd: root, windowsHide: true }); return true; } catch { return false; } }
async function parseRgOutput(stdout: string, root: string, limit: number): Promise<SearchMatch[]> {
  const matches: SearchMatch[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (!line || matches.length >= limit) continue;
    const match = /^(.+?):(\d+):(.*)$/.exec(line);
    if (!match) continue;
    const [, path, lineNumber, text] = match;
    if (!path || !lineNumber) continue;
    try { const resolved = await resolveContainedPath(root, path); matches.push({ path: resolved.relativePath, line: Number(lineNumber), text: text ?? "" }); } catch { /* denied */ }
  }
  return matches;
}
async function runRg(root: string, args: string[]): Promise<string> {
  try { return (await execFileAsync("rg", args, { cwd: root, encoding: "utf8", windowsHide: true, maxBuffer: 4 * 1024 * 1024 })).stdout; }
  catch (error) { if ((error as { code?: number | string }).code === 1) return ""; throw error; }
}
async function searchWithRg(root: string, query: string, limit: number): Promise<SearchMatch[]> {
  const commonArgs = ["--line-number", "--no-heading", "--color", "never", "--hidden", "--fixed-strings", "--max-filesize", String(MAX_SEARCH_FILE_BYTES)];
  const ignoreArgs: string[] = [];
  try { await access(`${root}/.chat2codexignore`); ignoreArgs.push("--ignore-file", ".chat2codexignore"); } catch { /* optional */ }
  const mainArgs = [...commonArgs, ...ignoreArgs, "--glob", "!.git/**", "--glob", "!**/.env", "--glob", "!**/.env.*", "--glob", "!**/id_rsa", "--glob", "!**/id_dsa", "--glob", "!**/id_ecdsa", "--glob", "!**/id_ed25519", "--glob", "!**/*.pem", "--glob", "!**/*.key", "--glob", "!**/*.p12", "--glob", "!**/*.pfx", "--glob", "!**/.ssh/**", "--glob", "!**/.aws/credentials", "--glob", "!**/.config/gcloud/application_default_credentials.json", query, "."];
  const exampleArgs = [...commonArgs, ...ignoreArgs, "--glob", "**/.env.example", query, "."];
  const [mainOutput, exampleOutput] = await Promise.all([runRg(root, mainArgs), runRg(root, exampleArgs)]);
  const matcher = await loadIgnore(root);
  const parsed = await parseRgOutput(`${mainOutput}${exampleOutput}`, root, limit * 3);
  const unique = new Map<string, SearchMatch>();
  for (const match of parsed) {
    if (isHardDeniedRelativePath(match.path) || matcher.ignores(match.path)) continue;
    unique.set(`${match.path}:${match.line}:${match.text}`, match);
    if (unique.size >= limit) break;
  }
  return [...unique.values()];
}
async function searchFallback(root: string, query: string, limit: number): Promise<SearchMatch[]> {
  const matcher = await loadIgnore(root);
  const results: SearchMatch[] = [];
  async function walk(relativeDir: string): Promise<void> {
    if (results.length >= limit) return;
    const dir = await resolveContainedPath(root, relativeDir || ".");
    for (const entry of await readdir(dir.absolutePath, { withFileTypes: true })) {
      if (results.length >= limit) return;
      const rel = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
      if (rel === ".git" || rel.startsWith(".git/") || isHardDeniedRelativePath(rel) || matcher.ignores(entry.isDirectory() ? `${rel}/` : rel)) continue;
      let resolved; try { resolved = await resolveContainedPath(root, rel); } catch { continue; }
      if (entry.isDirectory()) { await walk(rel); continue; }
      if (!entry.isFile()) continue;
      let buffer: Buffer; try { buffer = await readFile(resolved.absolutePath); } catch { continue; }
      if (buffer.length > MAX_SEARCH_FILE_BYTES || buffer.subarray(0, 8192).includes(0)) continue;
      const lines = buffer.toString("utf8").split(/\r?\n/);
      for (let i = 0; i < lines.length && results.length < limit; i += 1) { const text = lines[i] ?? ""; if (text.includes(query)) results.push({ path: resolved.relativePath, line: i + 1, text }); }
    }
  }
  await walk("");
  return results;
}
export async function searchWorkspace(root: string, query: string, limit = 50): Promise<SearchMatch[]> {
  if (!query) throw new Error("SEARCH_QUERY_REQUIRED");
  assertLimit(limit);
  const canonicalRoot = (await resolveContainedPath(root, ".")).absolutePath;
  return (await rgAvailable(canonicalRoot)) ? searchWithRg(canonicalRoot, query, limit) : searchFallback(canonicalRoot, query, limit);
}
