import { execFile } from "node:child_process";
import { access, mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { get as httpGet } from "node:http";
import { Command } from "commander";

import { getBridgeRuntime } from "../../bridge/runtime.js";
import { getStateDir } from "../../config/paths.js";
import { READ_ONLY_TOOL_NAMES } from "../../mcp/tools.js";
import { getDaemonLock } from "../../supervisor/daemon.js";
import { findWorkspaceByRoot } from "../../workspace/registry.js";

const execFileAsync = promisify(execFile);

export interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
}

async function commandAvailable(command: string, args: string[]): Promise<boolean> {
  try {
    await execFileAsync(command, args, { windowsHide: true, timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function bridgeHealthy(port: number, workspaceId: string): Promise<boolean> {
  return new Promise((resolve) => {
    const request = httpGet(
      { host: "127.0.0.1", port, path: "/health", timeout: 1500 },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          body += chunk;
        });
        response.on("end", () => {
          try {
            const parsed = JSON.parse(body) as { workspace_id?: string; product?: string };
            resolve(
              response.statusCode === 200 &&
                parsed.product === "Chat2Codex" &&
                parsed.workspace_id === workspaceId,
            );
          } catch {
            resolve(false);
          }
        });
      },
    );
    request.on("timeout", () => {
      request.destroy();
      resolve(false);
    });
    request.on("error", () => resolve(false));
  });
}

async function skillInstalled(): Promise<boolean> {
  const candidates = [
    join(homedir(), ".codex", "skills", "chat2codex-relay", "SKILL.md"),
    join(homedir(), ".agents", "skills", "chat2codex-relay", "SKILL.md"),
  ];
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return true;
    } catch {
      // try next supported location
    }
  }
  return false;
}

export async function runDoctor(workspacePath: string): Promise<{ ok: boolean; checks: DoctorCheck[] }> {
  const checks: DoctorCheck[] = [];
  const major = Number(process.versions.node.split(".")[0]);
  checks.push({
    name: "node",
    ok: Number.isFinite(major) && major >= 20,
    detail: `Node ${process.versions.node}`,
  });

  const gitOk = await commandAvailable("git", ["--version"]);
  checks.push({ name: "git", ok: gitOk, detail: gitOk ? "Git available" : "Git not found" });

  const codexBin = process.env.CHAT2CODEX_CODEX_BIN ?? "codex";
  const codexOk = await commandAvailable(codexBin, ["--version"]);
  checks.push({
    name: "codex",
    ok: codexOk,
    detail: codexOk ? "Codex executable available" : "Codex executable not found",
  });

  let stateOk = false;
  try {
    const stateDir = getStateDir();
    await mkdir(stateDir, { recursive: true });
    const probe = join(stateDir, `.doctor-${process.pid}-${Date.now()}`);
    await writeFile(probe, "ok", { encoding: "utf8", mode: 0o600 });
    await rm(probe, { force: true });
    stateOk = true;
  } catch {
    stateOk = false;
  }
  checks.push({
    name: "state_dir",
    ok: stateOk,
    detail: stateOk ? "State directory writable" : "State directory is not writable",
  });

  let workspace = null;
  try {
    workspace = await findWorkspaceByRoot(workspacePath);
  } catch {
    workspace = null;
  }
  checks.push({
    name: "workspace",
    ok: workspace !== null,
    detail: workspace ? `Registered as ${workspace.workspace_id}` : "Workspace is not registered",
  });

  let gitRepoOk = false;
  if (workspace) {
    try {
      const result = await execFileAsync("git", ["rev-parse", "--is-inside-work-tree"], {
        cwd: workspace.git_root,
        encoding: "utf8",
        windowsHide: true,
      });
      gitRepoOk = result.stdout.trim() === "true";
    } catch {
      gitRepoOk = false;
    }
  }
  checks.push({
    name: "git_repository",
    ok: gitRepoOk,
    detail: gitRepoOk ? "Registered workspace is a Git work tree" : "Git work tree check failed",
  });

  let bridgeOk = false;
  if (workspace) {
    const runtime = await getBridgeRuntime(workspace.workspace_id).catch(() => null);
    if (runtime) bridgeOk = await bridgeHealthy(runtime.port, workspace.workspace_id);
  }
  checks.push({
    name: "bridge",
    ok: bridgeOk,
    detail: bridgeOk ? "Loopback MCP bridge is healthy" : "Loopback MCP bridge is not running or unhealthy",
  });

  const forbidden = /(?:^|_)(?:write|exec|shell|delete|commit|push|patch)(?:_|$)/i;
  const toolsOk = READ_ONLY_TOOL_NAMES.length === 12 && READ_ONLY_TOOL_NAMES.every((name) => !forbidden.test(name));
  checks.push({
    name: "mcp_tools",
    ok: toolsOk,
    detail: toolsOk ? "Read-only MCP tool registry is valid" : "Unexpected MCP tool registry",
  });

  let daemonOk = true;
  let daemonDetail = "Daemon is not running";
  if (workspace) {
    const lock = await getDaemonLock(workspace.workspace_id).catch(() => null);
    if (lock) {
      daemonOk = pidAlive(lock.pid);
      daemonDetail = daemonOk ? "Daemon lock points to a live process" : "Daemon lock is stale";
    }
  }
  checks.push({ name: "daemon_lock", ok: daemonOk, detail: daemonDetail });

  const relayInstalled = await skillInstalled();
  checks.push({
    name: "desktop_relay_skill",
    ok: relayInstalled,
    detail: relayInstalled ? "Desktop relay Skill installed" : "Desktop relay Skill not installed",
  });

  return { ok: checks.every((check) => check.ok), checks };
}

export function createDoctorCommand(): Command {
  return new Command("doctor")
    .description("Check Chat2Codex prerequisites and runtime health")
    .option("-w, --workspace <path>", "workspace path", process.cwd())
    .option("--json", "emit JSON")
    .action(async (options: { workspace: string; json?: boolean }) => {
      const report = await runDoctor(options.workspace);
      if (options.json) {
        process.stdout.write(`${JSON.stringify(report)}\n`);
      } else {
        for (const check of report.checks) {
          process.stdout.write(`${check.ok ? "✓" : "✗"} ${check.name}: ${check.detail}\n`);
        }
      }
      if (!report.ok) process.exitCode = 1;
    });
}
