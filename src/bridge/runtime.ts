import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import type { McpToolDependencies } from "../mcp/tools.js";
import { createBridgeApp } from "./app.js";

export interface BridgeRuntime {
  host: "127.0.0.1";
  port: number;
  server: Server;
  close(): Promise<void>;
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

  return {
    host: "127.0.0.1",
    port,
    server,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
