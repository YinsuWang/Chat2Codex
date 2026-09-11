import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { getStateDir } from "../config/paths.js";
import type { WorkspaceRecord } from "../config/types.js";
import type { Supervisor } from "./supervisor.js";

interface DaemonLock {
  pid: number;
  started_at: string;
  workspace_id: string;
}

export interface StartDaemonOptions {
  pollMs?: number;
  signal?: AbortSignal;
  onAcquired?: () => Promise<void>;
}

function lockPath(workspaceId: string): string {
  return join(getStateDir(), "daemons", `${workspaceId}.lock`);
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function getDaemonLock(workspaceId: string): Promise<DaemonLock | null> {
  try {
    const lock = JSON.parse(await readFile(lockPath(workspaceId), "utf8")) as DaemonLock;
    if (
      !Number.isSafeInteger(lock.pid) ||
      typeof lock.started_at !== "string" ||
      lock.workspace_id !== workspaceId
    ) {
      return null;
    }
    return lock;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function acquireLock(workspace: WorkspaceRecord): Promise<DaemonLock> {
  const path = lockPath(workspace.workspace_id);
  await mkdir(dirname(path), { recursive: true });
  const existing = await getDaemonLock(workspace.workspace_id);
  if (existing && pidAlive(existing.pid)) {
    throw new Error(`DAEMON_ALREADY_RUNNING: ${existing.pid}`);
  }
  if (existing) await rm(path, { force: true });

  const lock: DaemonLock = {
    pid: process.pid,
    started_at: new Date().toISOString(),
    workspace_id: workspace.workspace_id,
  };
  await writeFile(path, `${JSON.stringify(lock)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  return lock;
}

export async function startDaemon(
  supervisor: Supervisor,
  options: StartDaemonOptions = {},
): Promise<void> {
  const pollMs = options.pollMs ?? 750;
  if (!Number.isInteger(pollMs) || pollMs < 100) {
    throw new Error("INVALID_POLL_INTERVAL");
  }

  await acquireLock(supervisor.workspace);
  const path = lockPath(supervisor.workspace.workspace_id);
  const controller = new AbortController();
  const stop = () => controller.abort();
  const externalAbort = () => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  options.signal?.addEventListener("abort", externalAbort, { once: true });

  try {
    await options.onAcquired?.();
    await supervisor.recoverInterruptedTasks();
    while (!controller.signal.aborted) {
      await supervisor.tick();
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, pollMs);
        controller.signal.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            resolve();
          },
          { once: true },
        );
      });
    }
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    options.signal?.removeEventListener("abort", externalAbort);
    await rm(path, { force: true });
  }
}
