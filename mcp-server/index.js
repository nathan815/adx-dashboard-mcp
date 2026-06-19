#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerReadTools } from "./tools/read.js";
import { registerWriteTools } from "./tools/write.js";
import { registerLifecycleTools } from "./tools/lifecycle.js";

const server = new McpServer({
  name: "adx-live-edit-mcp",
  version: "0.1.0",
});

// Tools touch the daemon lazily (first call triggers ensureDaemon), so
// registration here stays instant and tool-listing never pays the ~20s cold
// start.
registerReadTools(server);
registerWriteTools(server);
registerLifecycleTools(server);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  // Diagnostics go to stderr so they never corrupt the stdio JSON-RPC stream.
  console.error("adx-live-edit-mcp failed to start:", err);
  process.exit(1);
});
