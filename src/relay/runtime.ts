import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { z } from "zod";

import { getStateDir } from "../config/paths.js";
import type { ControlService } from "../control/service.js";
import { createRelayServer } from "./server.js";
import type { RelayStatusStore } from "./status.js";
import type { RelayTokenStore } from "./token-store.js";

const WORKSPACE_ID_PATTERN = /^ws_[a-f0-9]{16}$/;
const DEFAULT_RELAY_PORT = 48766;

const RelayRuntimeStateSchema = z.strictObject({
  workspace_id: z.string().regex(WORKSPACE_ID_PATTERN),
  host: z.literal("127.0.0.1"),
  port: z.number().int().min(1).max(65535),
  pid: z.number().int().positive(),
  started_at: z.string().datetime(),
});

export type RelayRuntimeState = z.infer<typeof RelayRuntimeStateSchema>;

export interface RelayRuntime extends RelayRuntimeState {
  server: Server;
  close(): Promise<void>;
}

export interface StartRelayServerOptions {
  workspaceId: string;
  controlService: ControlService;
  tokenStore?: RelayTokenStore;
  statusStore?: RelayStatusStore;
  port?: number;
}

function assertWorkspaceId(workspaceId: string): void {
  if (!WORKSPACE_ID_PATTERN.test(workspaceId)) {
    throw new Error(`INVALID_WORKSPACE_ID: ${workspaceId}`);
  }
}

function runtimePath(workspaceId: string): string {
  assertWorkspaceId(workspaceId);
  return join(getStateDir(), "runtime", `${workspaceId}-relay.json`);
}

async function writeRuntime(state: RelayRuntimeState): Promise<void> {
  const validated = RelayRuntimeStateSchema.parse(state);
  const path = runtimePath(validated.workspace_id);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(temporary, `${JSON.stringify(validated)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temporary, path);
}

export async function getRelayRuntime(workspaceId: string): Promise<RelayRuntimeState | null> {
  const path = runtimePath(workspaceId);
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }

  try {
    const parsed = RelayRuntimeStateSchema.parse(JSON.parse(raw) as unknown);
    if (parsed.workspace_id !== workspaceId) throw new Error("WORKSPACE_MISMATCH");
    return parsed;
  } catch {
    throw new Error("INVALID_RELAY_RUNTIME");
  }
}

async function listen(server: Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException) => {
      server.removeListener("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.removeListener("error", onError);
      resolve((server.address() as AddressInfo).port);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, "127.0.0.1");
  });
}

export async function startRelayServer(options: StartRelayServerOptions): Promise<RelayRuntime> {
  assertWorkspaceId(options.workspaceId);
  const host = createRelayServer({
    workspaceId: options.workspaceId,
    controlService: options.controlService,
    ...(options.tokenStore ? { tokenStore: options.tokenStore } : {}),
    ...(options.statusStore ? { statusStore: options.statusStore } : {}),
  });
  const requestedPort = options.port ?? DEFAULT_RELAY_PORT;
  let port: number;
  try {
    port = await listen(host.server, requestedPort);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE" || requestedPort === 0) {
      await host.closeWebSockets().catch(() => undefined);
      throw error;
    }
    port = await listen(host.server, 0);
  }

  const state: RelayRuntimeState = {
    workspace_id: options.workspaceId,
    host: "127.0.0.1",
    port,
    pid: process.pid,
    started_at: new Date().toISOString(),
  };

  try {
    await writeRuntime(state);
  } catch (error) {
    await host.closeWebSockets().catch(() => undefined);
    await new Promise<void>((resolve) => host.server.close(() => resolve()));
    throw error;
  }

  return {
    ...state,
    server: host.server,
    close: async () => {
      await host.closeWebSockets();
      if (host.server.listening) {
        await new Promise<void>((resolve, reject) => {
          host.server.close((error) => (error ? reject(error) : resolve()));
        });
      }
      const saved = await getRelayRuntime(state.workspace_id).catch(() => null);
      if (saved?.pid === state.pid && saved.port === state.port) {
        await rm(runtimePath(state.workspace_id), { force: true });
      }
    },
  };
}

export { DEFAULT_RELAY_PORT };
