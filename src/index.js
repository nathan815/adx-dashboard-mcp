#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const server = new McpServer({
  name: "adx-live-edit-mcp",
  version: "0.1.0",
});

// Phase 0 scaffold tool. Real read/write/lifecycle tools land in later phases.
server.registerTool(
  "ping",
  {
    title: "Ping",
    description: "Health check for the adx-live-edit MCP server scaffold.",
    inputSchema: {},
  },
  async () => ({
    content: [{ type: "text", text: "adx-live-edit-mcp scaffold is alive" }],
  })
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  // Diagnostics go to stderr so they never corrupt the stdio JSON-RPC stream.
  console.error("adx-live-edit-mcp failed to start:", err);
  process.exit(1);
});
