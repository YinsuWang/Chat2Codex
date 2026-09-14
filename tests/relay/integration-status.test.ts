import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runDoctor } from "../../src/cli/commands/doctor.js";
import { getWorkspaceStatus } from "../../src/cli/commands/status.js";
import { RelayStatusStore } from "../../src/relay/status.js";
import { RelayTokenStore } from "../../src/relay/token-store.js";
import { registerWorkspace } from "../../src/workspace/registry.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

let stateDir: string;
let repo: string;

beforeEach(async () => {
  stateDir = await mkdtemp(join(tmpdir(), "c2c-relay-integration-state-"));
  process.env.CHAT2CODEX_STATE_DIR = stateDir;
  repo = await mkdtemp(join(tmpdir(), "c2c-relay-integration-repo-"));
  git(repo, "init");
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "user.name", "Test");
  await writeFile(join(repo, "x.txt"), "x\n");
  git(repo, "add", ".");
  git(repo, "commit", "-m", "base");
});

afterEach(async () => {
  delete process.env.CHAT2CODEX_STATE_DIR;
  await Promise.all([
    rm(stateDir, { recursive: true, force: true }),
    rm(repo, { recursive: true, force: true }),
  ]);
});

describe("relay integration status", () => {
  it("exposes paired/tab/runtime state through status and doctor", async () => {
    const workspace = await registerWorkspace(repo);
    await new RelayTokenStore().issue(workspace.workspace_id, "ext-test");
    const relayStatus = new RelayStatusStore();
    await relayStatus.markAuthenticated(workspace.workspace_id, "ext-test");
    await relayStatus.recordTabHeartbeat(workspace.workspace_id, "ext-test", null);

    await mkdir(join(stateDir, "runtime"), { recursive: true });
    await writeFile(
      join(stateDir, "runtime", `${workspace.workspace_id}-relay.json`),
      `${JSON.stringify({
        workspace_id: workspace.workspace_id,
        host: "127.0.0.1",
        port: 48766,
        pid: process.pid,
        started_at: new Date().toISOString(),
      })}\n`,
    );

    const status = await getWorkspaceStatus(repo);
    expect(status.relay).toMatchObject({
      host: "127.0.0.1",
      port: 48766,
      pid: process.pid,
      paired: true,
      bound_tab_seen: true,
    });
    expect(status.relay?.last_heartbeat_at).toEqual(expect.any(String));

    const doctor = await runDoctor(repo);
    expect(doctor.checks.find((check) => check.name === "relay_server")?.ok).toBe(true);
    expect(doctor.checks.find((check) => check.name === "relay_pairing")?.ok).toBe(true);
    expect(doctor.checks.find((check) => check.name === "relay_tab")?.ok).toBe(true);
  });
});
