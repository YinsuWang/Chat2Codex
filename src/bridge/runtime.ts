import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { getStateDir } from "../config/paths.js";
import type { McpToolDependencies } from "../mcp/tools.js";
import { createBridgeApp } from "./app.js";

export interface BridgeRuntimeState {
  workspace_id: string;
  host: "127.0.0.1";
  port: number;
  pid: number;
  started_at: string;
}

export interface BridgeRuntime extends BridgeRuntimeState {
  server: Server;
  close(): Promise<void>;
}

function assertWorkspaceId(workspaceId: string): void {
  if (!/^ws_[a-f0-9]{16}$/.test(workspaceId)) {
    throw new Error(`INVALID_WORKSPACE_ID: ${workspaceId}`);
  }
}

function runtimePath(workspaceId: string): string {
  assertWorkspaceId(workspaceId);
  return join(getStateDir(), "runtime", `${workspaceId}-bridge.json`);
}

async function writeRuntime(state: BridgeRuntimeState): Promise<void> {
  const path = runtimePath(state.workspace_id);
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temporary, path);
}

export async function getBridgeRuntime(
  workspaceId: string,
): Promise<BridgeRuntimeState | null> {
  try {
    const value = JSON.parse(await readFile(runtimePath(workspaceId), "utf8")) as Partial<BridgeRuntimeState>;
    if (
      value.workspace_id !== workspaceId ||
      value.host !== "127.0.0.1" ||
      !Number.isInteger(value.port) ||
      (value.port ?? 0) < 1 ||
      (value.port ?? 0) > 65535 ||
      !Number.isInteger(value.pid) ||
      typeof value.started_at !== "string"
    ) {
      throw new Error("INVALID_BRIDGE_RUNTIME");
    }
    return value as BridgeRuntimeState;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
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

export async function startBridge(
  dependencies: McpToolDependencies,
  options: { port?: number } = {},
): Promise<BridgeRuntime> {
  const server = createServer(createBridgeApp(dependencies));
  const requestedPort = options.port ?? 48765;
  let port: number;
  try {
    port = await listen(server, requestedPort);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE" || requestedPort === 0) {
      throw error;
    }
    port = await listen(server, 0);
  }

  const state: BridgeRuntimeState = {
    workspace_id: dependencies.workspace.workspace_id,
    host: "127.0.0.1",
    port,
    pid: process.pid,
    started_at: new Date().toISOString(),
  };
  await writeRuntime(state);

  return {
    ...state,
    server,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      const saved = await getBridgeRuntime(state.workspace_id).catch(() => null);
      if (saved?.pid === state.pid && saved.port === state.port) {
        await rm(runtimePath(state.workspace_id), { force: true });
      }
    },
  };
}
