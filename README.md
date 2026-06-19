# adx-live-edit-mcp

A stdio MCP server for live-editing Azure Data Explorer (ADX) dashboards that are open in a
browser tab. It exposes typed, schema-driven tools so an agent can read and edit dashboard
tiles, queries, and parameters without ever touching the normalized dashboard JSON by hand.

It replaces the old `adx-dashboard-live-edit` skill (a `client.js` CLI plus SKILL.md rules)
with server-enforced invariants. The most important one: a query only binds the parameter
variables listed in its `usedVariables` array, so `set_query` requires that array explicitly
and validates it.

See [docs/design.md](docs/design.md) for the full architecture and tool surface.

## Components

- **chrome-extension/** - loads into Chrome/Edge, injects into ADX dashboard pages, applies
  edits, and reports tile errors.
- **daemon** (`daemon/agent-server.js`) - a single persistent process on `127.0.0.1:9876`
  that owns the browser connection, the per-dashboard approval grant, the schema cache, and
  the saved/working copy of each dashboard.
- **MCP server** (`src/index.js`) - the thin stdio front end. One per agent session. Maps
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
    "adx-live-edit": {
      "command": "npx",
      "args": ["-y", "adx-live-edit-mcp"]
    }
  }
}
```

The daemon is started automatically by the MCP server on first use. Cold start takes about
20 seconds.

## Development

```bash
npm install
npm start          # run the MCP server over stdio
npm run daemon     # run the daemon directly (normally auto-started)
npm test           # run the unit tests
```

## Status

Early development. The tool surface is being built out in phases per
[docs/design.md](docs/design.md).
