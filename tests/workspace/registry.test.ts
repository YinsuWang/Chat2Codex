import { execFile } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { getWorkspaceRecordPath } from "../../src/config/paths.js";
import {
  findWorkspaceByRoot,
  getWorkspace,
  registerWorkspace,
} from "../../src/workspace/registry.js";

const execFileAsync = promisify(execFile);
let tempRoot: string;
let repo: string;

beforeEach(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), "chat2codex-workspace-"));
  repo = join(tempRoot, "repo");
  await execFileAsync("git", ["init", repo]);
  process.env.CHAT2CODEX_STATE_DIR = join(tempRoot, "state");
});

afterEach(async () => {
  delete process.env.CHAT2CODEX_STATE_DIR;
  await rm(tempRoot, { recursive: true, force: true });
});

describe("workspace registry", () => {
  it("returns the same immutable workspace id when registration is repeated", async () => {
    const first = await registerWorkspace(repo);
    const second = await registerWorkspace(repo);

    expect(first.workspace_id).toBe(second.workspace_id);
    expect(first.root).toBe(await realpath(repo));
    expect(first.git_root).toBe(first.root);
    expect(first.policy.allow_current_working_tree).toBe(false);
  });

  it("persists a workspace so a fresh lookup can reload it", async () => {
    const created = await registerWorkspace(repo);
    const loaded = await getWorkspace(created.workspace_id);

    expect(loaded).toEqual(created);
  });

  it("finds a registered workspace by its Git root", async () => {
    const created = await registerWorkspace(repo);
    const found = await findWorkspaceByRoot(repo);

    expect(found?.workspace_id).toBe(created.workspace_id);
  });

  it("rejects a stored record whose canonical root was tampered with", async () => {
    const created = await registerWorkspace(repo);
    const recordPath = getWorkspaceRecordPath(created.workspace_id);
    const stored = JSON.parse(await readFile(recordPath, "utf8")) as Record<string, unknown>;
    stored.root = tempRoot;
    await writeFile(recordPath, `${JSON.stringify(stored, null, 2)}\n`, "utf8");

    await expect(getWorkspace(created.workspace_id)).rejects.toThrow(/root/i);
  });
});
