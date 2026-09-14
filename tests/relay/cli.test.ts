import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createRelayCommand,
  pairRelay,
  relayStatus,
  unpairRelay,
} from "../../src/cli/commands/relay.js";
import { RelayTokenStore } from "../../src/relay/token-store.js";
import { registerWorkspace } from "../../src/workspace/registry.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

let stateDir: string;
let repo: string;
let workspaceId: string;

beforeEach(async () => {
  stateDir = await mkdtemp(join(tmpdir(), "c2c-relay-cli-state-"));
  process.env.CHAT2CODEX_STATE_DIR = stateDir;
  repo = await mkdtemp(join(tmpdir(), "c2c-relay-cli-repo-"));
  git(repo, "init");
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "user.name", "Test");
  await writeFile(join(repo, "x.txt"), "x\n");
  git(repo, "add", ".");
  git(repo, "commit", "-m", "base");
  workspaceId = (await registerWorkspace(repo)).workspace_id;
});

afterEach(async () => {
  delete process.env.CHAT2CODEX_STATE_DIR;
  await Promise.all([
    rm(stateDir, { recursive: true, force: true }),
    rm(repo, { recursive: true, force: true }),
  ]);
});

describe("relay CLI", () => {
  it("registers pair, status, and unpair subcommands", () => {
    const command = createRelayCommand();
    expect(command.name()).toBe("relay");
    expect(command.commands.map((child) => child.name()).sort()).toEqual([
      "pair",
      "status",
      "unpair",
    ]);
  });

  it("creates a short pairing code without exposing a long-lived token", async () => {
    const result = await pairRelay(repo);

    expect(result).toMatchObject({
      workspace_id: workspaceId,
      attempts_remaining: 5,
    });
    expect(result.pairing_code).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$/);
    expect(Date.parse(result.expires_at)).toBeGreaterThan(Date.now());
    expect(JSON.stringify(result)).not.toContain("token");
  });

  it("reports authorization/runtime/tab state and revokes authorization", async () => {
    await new RelayTokenStore().issue(workspaceId, "ext-test");

    expect(await relayStatus(repo)).toMatchObject({
      workspace_id: workspaceId,
      paired: true,
      relay_running: false,
      bound_tab_seen: false,
      last_heartbeat_at: null,
    });

    expect(await unpairRelay(repo)).toEqual({
      workspace_id: workspaceId,
      paired: false,
    });
    expect((await relayStatus(repo)).paired).toBe(false);
  });
});
