# adx-dashboard-mcp

A stdio MCP server + Chrome extension for live-editing Azure Data Explorer (ADX) dashboards that are open in a
browser tab. It exposes typed, schema-driven tools so an agent can read and edit dashboard
tiles, queries, and parameters while avoiding editing the normalized dashboard JSON manually.

See [docs/design.md](docs/design.md) for the full architecture and tool surface.

## Components

- **chrome-extension/** - loads into Chrome/Edge, injects into ADX dashboard pages, applies
  edits, and reports tile errors.
- **daemon** (`daemon/agent-server.js`) - a single persistent process on `127.0.0.1:9876`
  that owns the WebSocket browser connection, the per-dashboard approval grant, the schema
  cache, and the saved/working copy of each dashboard.
- **MCP server** (`mcp-server/index.js`) - the thin stdio front end. One per agent session. Maps
  typed tool calls to daemon HTTP endpoints and auto-starts the daemon when needed.

## Setup

### 1. Load the Chrome extension

1. Open `chrome://extensions`.
2. Enable Developer mode.
3. Click "Load unpacked" and select the `chrome-extension/` folder in this repo.
4. Open an ADX dashboard (`https://dataexplorer.azure.com/...`) in a tab.

### 2. Register the MCP server

Add this stdio server to your MCP client config:

```json
{
  "mcpServers": {
    "adx-dashboard": {
      "command": "npx",
      "args": ["-y", "adx-dashboard-mcp"]
    }
  }
}
```

The daemon is started automatically by the MCP server on first use.

## Development

```bash
npm install
npm start          # run the MCP server over stdio
npm run daemon     # run the daemon directly (normally auto-started)
npm test           # run the unit tests
```
