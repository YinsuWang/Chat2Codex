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
      if (!request.method || !request.url) {
        response.statusCode = 400;
        response.end("Missing HTTP request metadata");
        return;
      }
      // The MCP node adapter accepts native IncomingMessage/ServerResponse objects at
      // runtime. Its structural request type marks method/url as required, while
      // Node's IncomingMessage types mark them optional, so narrow at this boundary.
      void nodeMcpHandler(
        request as unknown as Parameters<typeof nodeMcpHandler>[0],
        response as unknown as Parameters<typeof nodeMcpHandler>[1],
      );
      return;
    }
    response.statusCode = 404;
    response.setHeader("content-type", "application/json; charset=utf-8");
    response.end(JSON.stringify({ error: "NOT_FOUND" }));
  };
}
