import type { RequestListener } from "node:http";
import { toNodeHandler } from "@modelcontextprotocol/node";

import type { McpToolDependencies } from "../mcp/tools.js";
import { createChat2CodexMcpHandler } from "../mcp/server.js";

export function createBridgeApp(dependencies: McpToolDependencies): RequestListener {
  const mcpHandler = createChat2CodexMcpHandler(dependencies);
  const nodeMcpHandler = toNodeHandler(mcpHandler);

  return (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/health" && request.method === "GET") {
      response.statusCode = 200;
      response.setHeader("content-type", "application/json; charset=utf-8");
      response.end(
        JSON.stringify({
          product: "Chat2Codex",
          version: "0.1.0",
          workspace_id: dependencies.workspace.workspace_id,
          pid: process.pid,
        }),
      );
      return;
    }
    if (url.pathname === "/mcp") {
      void nodeMcpHandler(request, response);
      return;
    }
    response.statusCode = 404;
    response.setHeader("content-type", "application/json; charset=utf-8");
    response.end(JSON.stringify({ error: "NOT_FOUND" }));
  };
}
