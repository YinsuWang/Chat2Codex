import { mkdir, open, readFile, realpath, rename } from "node:fs/promises";
import { dirname } from "node:path";

import {
  getWorkspaceIndexPath,
  getWorkspaceRecordPath,
  getWorkspacesDir,
} from "../config/paths.js";
import type {
  WorkspaceRecord,
  WorkspaceRegistryIndex,
} from "../config/types.js";
import { discoverWorkspace } from "./identity.js";

function canonicalKey(path: string): string {
  const normalized = path.replace(/[\\/]+$/, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function assertWorkspaceId(workspaceId: string): void {
  if (!/^ws_[a-f0-9]{16}$/.test(workspaceId)) {
    throw new Error(`Invalid workspace_id: ${workspaceId}`);
  }
}

async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  const handle = await open(tempPath, "w", 0o600);

  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }

  await rename(tempPath, path);
}

async function readIndex(): Promise<WorkspaceRegistryIndex> {
  try {
    const raw = await readFile(getWorkspaceIndexPath(), "utf8");
    const parsed = JSON.parse(raw) as WorkspaceRegistryIndex;
    if (!parsed || typeof parsed !== "object" || !parsed.roots || typeof parsed.roots !== "object") {
      throw new Error("Workspace registry index is invalid");
    }
    return parsed;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return { roots: {} };
    }
    throw error;
  }
}

function assertWorkspaceRecord(value: unknown): asserts value is WorkspaceRecord {
  if (!value || typeof value !== "object") {
    throw new Error("Workspace record is invalid");
  }

  const record = value as Partial<WorkspaceRecord>;
  if (
    typeof record.workspace_id !== "string" ||
    typeof record.workspace_name !== "string" ||
    typeof record.machine !== "string" ||
    typeof record.root !== "string" ||
    typeof record.git_root !== "string" ||
    !(typeof record.git_remote === "string" || record.git_remote === null) ||
    typeof record.created_at !== "string" ||
    !record.policy ||
    typeof record.policy.allow_current_working_tree !== "boolean"
  ) {
    throw new Error("Workspace record is invalid");
  }
  assertWorkspaceId(record.workspace_id);
}

async function validateStoredRoot(record: WorkspaceRecord): Promise<void> {
  const canonicalStoredRoot = await realpath(record.root);
  if (canonicalKey(canonicalStoredRoot) !== canonicalKey(record.root)) {
    throw new Error(`Workspace root no longer matches its canonical path: ${record.workspace_id}`);
  }

  const canonicalGitRoot = await realpath(record.git_root);
  if (canonicalKey(canonicalGitRoot) !== canonicalKey(record.root)) {
    throw new Error(`Workspace git root no longer matches registered root: ${record.workspace_id}`);
  }
}

export async function getWorkspace(workspaceId: string): Promise<WorkspaceRecord> {
  assertWorkspaceId(workspaceId);
  const raw = await readFile(getWorkspaceRecordPath(workspaceId), "utf8");
  const parsed: unknown = JSON.parse(raw);
  assertWorkspaceRecord(parsed);
  if (parsed.workspace_id !== workspaceId) {
    throw new Error(`Workspace record identity mismatch: ${workspaceId}`);
  }
  await validateStoredRoot(parsed);
  return parsed;
}

export async function findWorkspaceByRoot(root: string): Promise<WorkspaceRecord | null> {
  const discovered = await discoverWorkspace(root);
  const index = await readIndex();
  const workspaceId = index.roots[canonicalKey(discovered.root)];
  return workspaceId ? getWorkspace(workspaceId) : null;
}

export async function registerWorkspace(root: string): Promise<WorkspaceRecord> {
  await mkdir(getWorkspacesDir(), { recursive: true });

  const discovered = await discoverWorkspace(root);
  const index = await readIndex();
  const key = canonicalKey(discovered.root);
  const existingId = index.roots[key];
  if (existingId) {
    return getWorkspace(existingId);
  }

  await atomicWriteJson(getWorkspaceRecordPath(discovered.workspace_id), discovered);
  index.roots[key] = discovered.workspace_id;
  await atomicWriteJson(getWorkspaceIndexPath(), index);
  return discovered;
}
