#!/usr/bin/env node

import { execFile } from "node:child_process";
import { access, readFile, stat } from "node:fs/promises";
import { get as httpGet } from "node:http";
import { createConnection } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const HEARTBEAT_MAX_AGE_MS = 90_000;
const CLOCK_SKEW_MS = 5_000;
const EXPECTED_READ_ONLY_TOOLS = [
  "workspace_info",
  "list_directory",
  "read_file",
  "search_workspace",
  "git_status",
  "git_diff",
  "task_get",
  "task_list",
  "task_history",
  "execution_summary",
  "execution_output",
  "test_status",
];

function usage() {
  return [
    "Usage: node scripts/acceptance-relay.mjs [options]",
    "",
    "Read-only local acceptance gate for the Browser Extension Relay.",
    "Run pnpm build before the full gate; --help does not require dist/.",
    "",
    "Options:",
    "  -w, --workspace <path>  Registered target workspace (default: current directory)",
    "      --json              Emit one machine-readable JSON result",
    "  -h, --help              Show this help",
    "",
  ].join("\n");
}

function parseArgs(argv) {
  const options = { workspace: process.cwd(), json: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "-h" || arg === "--help") options.help = true;
    else if (arg === "--json") options.json = true;
    else if (arg === "-w" || arg === "--workspace") {
      const value = argv[index + 1];
      if (!value || value.startsWith("-")) throw new Error("WORKSPACE_PATH_REQUIRED");
      options.workspace = value;
      index += 1;
    } else throw new Error("UNKNOWN_ARGUMENT: " + arg);
  }
  return options;
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error && typeof error === "object" && error.code === "EPERM";
  }
}

async function bridgeHealthy(port, workspaceId, pid) {
  return new Promise((done) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      done(value);
    };
    const request = httpGet(
      { host: "127.0.0.1", port, path: "/health", timeout: 1500 },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => { body += chunk; });
        response.on("end", () => {
          try {
            const value = JSON.parse(body);
            finish(
              response.statusCode === 200 &&
              value?.product === "Chat2Codex" &&
              value?.workspace_id === workspaceId &&
              value?.pid === pid
            );
          } catch {
            finish(false);
          }
        });
      }
    );
    request.on("timeout", () => request.destroy(new Error("BRIDGE_HEALTH_TIMEOUT")));
    request.on("error", () => finish(false));
  });
}

async function relayListening(port) {
  return new Promise((done) => {
    let settled = false;
    const socket = createConnection({ host: "127.0.0.1", port });
    const finish = (value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      done(value);
    };
    socket.setTimeout(1500, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

async function gitStatus(root) {
  const result = await execFileAsync("git", ["status", "--porcelain=v2", "--branch"], {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  });
  return result.stdout;
}

async function extensionArtifactCheck() {
  const required = [
    "manifest.json",
    "service-worker.js",
    "content-script.js",
    "popup.js",
    "popup.html",
  ];
  for (const name of required) {
    const path = join(ROOT, "dist-extension", name);
    await access(path);
    const metadata = await stat(path);
    if (!metadata.isFile() || metadata.size === 0) {
      throw new Error("EXTENSION_ARTIFACT_INVALID: " + name);
    }
  }

  const manifest = JSON.parse(
    await readFile(join(ROOT, "dist-extension", "manifest.json"), "utf8")
  );
  const permissions = Array.isArray(manifest.permissions) ? manifest.permissions : [];
  const hostPermissions = Array.isArray(manifest.host_permissions) ? manifest.host_permissions : [];
  const forbiddenPermissions = new Set([
    "cookies",
    "history",
    "downloads",
    "debugger",
    "clipboardRead",
    "clipboardWrite",
    "webRequest",
  ]);
  const allowedPermissions = new Set(["storage", "tabs"]);
  const allowedHosts = new Set(["https://chatgpt.com/*", "http://127.0.0.1/*"]);
  const contentMatches = Array.isArray(manifest.content_scripts)
    ? manifest.content_scripts.flatMap((entry) => Array.isArray(entry?.matches) ? entry.matches : [])
    : [];

  const ok =
    manifest.manifest_version === 3 &&
    Number.parseInt(String(manifest.minimum_chrome_version ?? ""), 10) >= 116 &&
    permissions.includes("storage") &&
    permissions.includes("tabs") &&
    permissions.every((permission) => allowedPermissions.has(permission)) &&
    permissions.every((permission) => !forbiddenPermissions.has(permission)) &&
    hostPermissions.length > 0 &&
    hostPermissions.every((host) => allowedHosts.has(host)) &&
    hostPermissions.includes("https://chatgpt.com/*") &&
    hostPermissions.includes("http://127.0.0.1/*") &&
    contentMatches.length === 1 &&
    contentMatches[0] === "https://chatgpt.com/*" &&
    manifest.background?.service_worker === "service-worker.js" &&
    manifest.action?.default_popup === "popup.html";

  if (!ok) throw new Error("EXTENSION_MANIFEST_INVARIANT_FAILED");
  return required.length + " built files; MV3 Chrome 116+ least-privilege manifest";
}

function heartbeatCheck(boundTabSeen, lastHeartbeatAt) {
  if (!boundTabSeen || typeof lastHeartbeatAt !== "string") {
    return { ok: false, detail: "No bound ChatGPT tab heartbeat has been observed" };
  }
  const timestamp = Date.parse(lastHeartbeatAt);
  if (!Number.isFinite(timestamp)) {
    return { ok: false, detail: "Bound-tab heartbeat timestamp is invalid" };
  }
  const age = Date.now() - timestamp;
  if (age < -CLOCK_SKEW_MS) {
    return { ok: false, detail: "Bound-tab heartbeat is unexpectedly in the future" };
  }
  if (age > HEARTBEAT_MAX_AGE_MS) {
    return {
      ok: false,
      detail: "Bound-tab heartbeat is stale (" + Math.round(age / 1000) + "s old; max 90s)",
    };
  }
  return {
    ok: true,
    detail: "Bound-tab heartbeat is fresh (" + Math.max(0, Math.round(age / 1000)) + "s old)",
  };
}

async function run(options) {
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok, detail });

  try {
    add("extension_artifact", true, await extensionArtifactCheck());
  } catch (error) {
    add(
      "extension_artifact",
      false,
      error instanceof Error ? error.message : "Extension artifact check failed"
    );
  }

  const modules = {
    registry: join(ROOT, "dist", "workspace", "registry.js"),
    status: join(ROOT, "dist", "cli", "commands", "status.js"),
    relay: join(ROOT, "dist", "cli", "commands", "relay.js"),
    mcp: join(ROOT, "dist", "mcp", "tools.js"),
  };

  let buildReady = true;
  try {
    for (const path of Object.values(modules)) await access(path);
  } catch {
    buildReady = false;
  }
  add(
    "node_build",
    buildReady,
    buildReady ? "Built Node runtime is present" : "Built Node runtime is missing; run pnpm build"
  );

  let workspace = null;
  let beforeStatus = null;

  if (buildReady) {
    try {
      const registry = await import(pathToFileURL(modules.registry).href);
      const statusModule = await import(pathToFileURL(modules.status).href);
      const relayModule = await import(pathToFileURL(modules.relay).href);
      const mcpModule = await import(pathToFileURL(modules.mcp).href);

      workspace = await registry.findWorkspaceByRoot(options.workspace);
      if (!workspace) throw new Error("WORKSPACE_NOT_REGISTERED");
      beforeStatus = await gitStatus(workspace.git_root);
      const status = await statusModule.getWorkspaceStatus(options.workspace);
      const relay = await relayModule.relayStatus(options.workspace);

      const identityOk =
        status.workspace_id === workspace.workspace_id &&
        relay.workspace_id === workspace.workspace_id;
      add(
        "workspace_identity",
        identityOk,
        identityOk
          ? "Registered workspace " + workspace.workspace_id + " matches status and relay state"
          : "Workspace identity does not match status/relay state"
      );

      const daemonOk = status.daemon_pid !== null && pidAlive(status.daemon_pid);
      add(
        "daemon",
        daemonOk,
        daemonOk ? "Supervisor daemon lock points to a live process" : "Supervisor daemon is not live"
      );

      const bridgeOk =
        status.bridge?.host === "127.0.0.1" &&
        pidAlive(status.bridge.pid) &&
        await bridgeHealthy(status.bridge.port, workspace.workspace_id, status.bridge.pid);
      add(
        "loopback_mcp_bridge",
        bridgeOk,
        bridgeOk
          ? "Read-only MCP bridge is healthy on loopback"
          : "Loopback MCP bridge is unavailable or unhealthy"
      );

      const relayServerOk =
        status.relay?.host === "127.0.0.1" &&
        pidAlive(status.relay.pid) &&
        await relayListening(status.relay.port);
      add(
        "relay_server",
        relayServerOk,
        relayServerOk
          ? "Browser relay is listening on 127.0.0.1"
          : "Browser relay is unavailable or not loopback"
      );

      add(
        "relay_paired",
        relay.paired === true,
        relay.paired
          ? "Browser extension authorization is paired"
          : "Browser extension is not paired"
      );

      const heartbeat = heartbeatCheck(relay.bound_tab_seen, relay.last_heartbeat_at);
      add("bound_tab_heartbeat", heartbeat.ok, heartbeat.detail);

      const toolNames = Array.from(mcpModule.READ_ONLY_TOOL_NAMES ?? []);
      const forbidden = /(?:^|_)(?:write|exec|shell|delete|commit|push|patch)(?:_|$)/i;
      const toolsOk =
        toolNames.length === EXPECTED_READ_ONLY_TOOLS.length &&
        toolNames.every((name, index) => name === EXPECTED_READ_ONLY_TOOLS[index]) &&
        toolNames.every((name) => typeof name === "string" && !forbidden.test(name));
      add(
        "mcp_read_only_tools",
        toolsOk,
        toolsOk
          ? "Read-only MCP registry is unchanged (" + EXPECTED_READ_ONLY_TOOLS.length + " tools)"
          : "Unexpected MCP tool registry or mutation-capable tool name"
      );
    } catch (error) {
      add(
        "workspace_identity",
        false,
        error instanceof Error ? error.message : "Local runtime inspection failed"
      );
    }
  } else {
    add("workspace_identity", false, "Cannot inspect workspace without built Node runtime");
  }

  if (workspace && beforeStatus !== null) {
    try {
      const afterStatus = await gitStatus(workspace.git_root);
      add(
        "primary_worktree_unchanged",
        afterStatus === beforeStatus,
        afterStatus === beforeStatus
          ? "Acceptance checks did not change primary working-tree status"
          : "Primary working-tree status changed while acceptance checks ran"
      );
    } catch (error) {
      add(
        "primary_worktree_unchanged",
        false,
        error instanceof Error ? error.message : "Unable to compare primary working-tree status"
      );
    }
  } else {
    add(
      "primary_worktree_unchanged",
      false,
      "Workspace was unavailable, so primary working-tree status could not be compared"
    );
  }

  const result = {
    product: "Chat2Codex",
    gate: "browser-relay-local",
    ok: checks.every((check) => check.ok),
    workspace_id: workspace?.workspace_id ?? null,
    heartbeat_max_age_ms: HEARTBEAT_MAX_AGE_MS,
    checks,
  };

  if (options.json) process.stdout.write(JSON.stringify(result) + "\n");
  else {
    for (const check of checks) {
      process.stdout.write(
        (check.ok ? "✓" : "✗") + " " + check.name + ": " + check.detail + "\n"
      );
    }
    process.stdout.write(
      "Browser relay local acceptance: " + (result.ok ? "PASS" : "FAIL") + "\n"
    );
  }

  if (!result.ok) process.exitCode = 1;
}

let options;
try {
  options = parseArgs(process.argv.slice(2));
} catch (error) {
  process.stderr.write(
    (error instanceof Error ? error.message : "INVALID_ARGUMENTS") + "\n\n" + usage()
  );
  process.exitCode = 2;
}

if (options?.help) process.stdout.write(usage());
else if (options) await run(options);
