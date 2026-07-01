# ADX Dashboard Live-Edit MCP Server - Design

## Why

Azure Data Explorer dashboards are normally authored by hand in the browser: clicking through
tile editors, parameter dialogs, and query panes. That is slow for bulk or repetitive changes
(renaming parameters across many tiles, adjusting a shared query, restructuring a page) and it
gives an AI agent no way to help, because there is no public write API for a dashboard and the
edits only exist in the browser's in-memory state until the user saves.

This project bridges that gap. A Chrome extension owns the live dashboard in the page, a local
daemon holds the working copy and brokers approval, and an MCP server gives an agent a typed,
validated way to read and change a dashboard that is open in front of the user. The agent can
make a change, the daemon validates it against the ADX schema, and the user approves before
anything is pushed back into the browser. The result is conversational dashboard editing on a
real, live dashboard without the agent ever touching the raw dashboard JSON or saving on the
user's behalf.

## Why an MCP server, not a skill

A prior version of this shipped as a skill: a `client.js` CLI plus a skill instruction document.
That approach fails structurally. A skill document can only ask the calling agent to remember a
rule, and the rule is dropped as soon as the relevant instructions fall out of context. The
clearest example is the `usedVariables` invariant. A query only binds the parameter variables
listed in its `usedVariables` array, so injecting a variable into the query text without adding
it to that array makes the tile fail at render time with
`Failed to resolve scalar expression named '...'`. A prose rule does not prevent this; a typed
tool that requires `usedVariables` as an explicit input does, because the rule becomes part of
the interface rather than a note the caller has to recall.

The normalized JSON is the second structural problem. Editing it by hand means walking
references (tile to query to data source) and patching a large document in place, which is error
prone and easy to get subtly wrong. A daemon-hosted working copy plus element-level typed tools
removes the raw JSON surgery entirely.

## Architecture

Keep the extension and daemon. Replace the CLI. Add caching plus a working copy in the backend
so the agent stops maintaining state.

```
many ephemeral stdio MCP servers (per agent session)   <- thin front end
                 |  HTTP 127.0.0.1:9876
        one persistent daemon (singleton)               <- owns state below
                |  WebSocket ws://127.0.0.1:9876/extension
        Chrome/Edge extension  ->  ADX dashboard page
```

Responsibilities:

- **stdio MCP server** (replaces `client.js`): thin. Maps MCP tool calls to daemon HTTP
  endpoints. Validates input shape. Implements the blocking `apply` (progress plus "Waiting
  for your approval..."). Auto-starts the daemon (`ensureDaemon`). Holds no durable state.
- **daemon** (singleton, stays): owns the browser/extension connection and the per-dashboard
  approval grant (page localStorage, 12h TTL). It also owns the caches and the working copy.
  These must be a shared singleton because they outlive any one session and are co-located
  with the single browser connection.
- **extension**: injects into the page, keeps a WebSocket open to the daemon, applies edits,
  and reports tile errors.

The working copy (edit buffer) lives in the daemon, not the stdio server. It survives
stdio-server restarts and compactions, is shared, and sits next to the browser connection that
is the real source of edited state.

## Windows constraint

The CLI-to-daemon HTTP path uses node `http`, not `fetch`. The undici implementation behind
`fetch` keeps pooled sockets alive, and calling `process.exit()` while a socket is open crashes
libuv on Windows. The MCP server's daemon client must keep using `node:http` for the same
reason. Schema fetching inside the validation layer can use `fetch` because that path does not
call `process.exit()`. Daemon cold start is about 20 seconds.

## Multi-tab handling

The real edit path is a WebSocket broker keyed by dashboard id. Each tab's content script
derives `dashboardId` from the URL, opens `ws://127.0.0.1:9876/extension`, and sends a
`register` message with `dashboardId`, `instanceId`, title, and agent version. The daemon only
sends a queued command to a socket whose dashboard id matches (or to any registered socket for
`*`), and the content script re-checks and rejects on `Dashboard ID mismatch`. Approval is
per-dashboardId in page localStorage, which is shared across same-origin tabs.

Implications:

- Different dashboards in different tabs (the common case): already correct. Commands for A only
  reach an A socket. No user involvement needed.
- Same dashboard in 2 or more tabs (the only real hazard): both tabs register with the same id,
  so a read is answered by whichever socket receives the command and an edit could target either
  tab's in-memory model. The final render/read and a save are nondeterministic between duplicate
  tabs, and two tabs saving can clobber each other.

v1 design: detect-and-refuse on duplicate same-dashboard tabs.

- The content script generates a stable per-tab `instanceId` (`crypto.randomUUID()` once per
  load) and includes it in the WebSocket `register` message.
- The daemon tracks `dashboardId -> [{instanceId, title, connectedAt}]` instead of collapsing by
  id.
- When the MCP server is about to `apply`/write and sees more than one live instance for that id,
  it returns a typed error the agent surfaces: "Dashboard X is open in N tabs, close the extras
  or tell me which to use." This makes the ambiguity structural and un-corruptable, the same
  spirit as the `usedVariables` fix.

Future (documented, not v1): per-tab routing. The same `instanceId` plumbing supports an
optional target `instanceId` on queued commands and `list_open_tabs` / `select_tab` tools. The
v1 work builds the `instanceId` foundation and defers routing.

## Caching

Daemon-backed, on disk, under a cache root
(`process.env.ADX_LIVE_EDIT_HOME` or `~/.adx-live-edit-mcp`):

- `schema/<schema_version>.json` - fetched once per schema version, reused across all sessions.
  Backs `get_schema` and every server-side validation.
- `dashboards/<id>/saved.json` - last fetched saved dashboard.
- `dashboards/<id>/working.json` - the edit buffer. On first access of a dashboard the daemon
  pulls the current saved JSON from the page into `saved.json` and copies it to `working.json`;
  the read tools trigger this pull automatically. `set_*` tools mutate `working.json`; `apply`
  pushes it to the browser.

This removes the repeated large `get` into caller context, the hand-maintained edit buffer, and
the ambiguity between saved JSON and the browser's in-memory edited state. There is one
authoritative working copy.

## Data model the tools hide (schema v76)

The dashboard JSON is normalized, and that normalization is the single biggest source of
error-prone manual editing. The typed tools exist to hide it.

- A tile does not contain its KQL. `tiles[]` entries carry `id, title, layout, pageId,
  visualType, visualOptions` and a `queryRef` (`{kind:"query", queryId}` or
  `{kind:"baseQuery", baseQueryId}`). The `queryRef` is required on every tile except
  `markdownCard` (text tiles have no query).
- The KQL lives in a separate top-level `queries[]` entry: `{id, text, usedVariables[],
  dataSource?}`. `usedVariables` is a required field on the query (may be `[]`) and is the array
  that caused the original failure.
- The cluster/database binding is normalized too: `query.dataSource` is `{kind:"inline",
  dataSourceId}` or `{kind:"parameter", parameterId}`, pointing into top-level `dataSources[]`.
- Query-backed parameters have their own `queryRef` into `queries[]`.

So "change this tile's query" is really: resolve `tile.queryRef.queryId`, then mutate the
matching `queries[]` entry's `text` and `usedVariables`. "Repoint a tile to another cluster" is:
resolve the query, then mutate `query.dataSource`. The agent should never walk these refs by
hand; the tools take a friendly `tileId` and do the ref resolution server-side.

Note: there is no tile-level variables field. The `tile.json` schema has a stale `errorMessage`
string that lists a `usedParamVariables` property as required, but the actual `required` array
and `properties` do not include it. `query.usedVariables` is the only variable array. Ignore
`usedParamVariables`.

Tile required fields: `id, title, layout (x>=0, y>=0, width>=2, height>=1), pageId, visualType,
visualOptions`. The `queryRef` is required when `visualType != "markdownCard"`. `visualType` and
`visualOptions` are open in the schema (the app enforces the visual enum and per-visual option
shape; JSON-schema does not), so the tools validate the tile envelope strictly but treat
`visualOptions` as a typed-passthrough object.

## Tool surface (schema-driven)

Every write mutates `working.json` and runs full schema validation before returning. A write
that would make the dashboard invalid is rejected and the working copy is left untouched.
Required inputs are shown without a `?`; optional inputs carry a trailing `?`.

The typed input shapes (visual types, parameter kinds, refresh intervals) use curated static
enums for schema v76 rather than shapes derived from a live schema fetch at startup. Deriving
them at tool-registration time would force the daemon's roughly 20 second cold start during
`tools/list` and break instant tool listing. The daemon still validates every write against the
cached schema with ajv, which is the real gate; the static enums only shape the inputs the
caller sees.

### Read (cheap, scoped)

| Tool | Returns |
| --- | --- |
| `list_dashboards()` | `[{id, title}]` for dashboards with a live connected tab. Listing dashboards without an open tab is a possible later addition. |
| `get_dashboard_summary(dashboardId)` | pages `[{id, name}]`, tiles `[{id, title, visualType, pageId, layout, queryId, hasQuery}]`, parameters `[{id, displayName, kind, variableName(s), selectionType}]`, `schema_version`. No KQL bodies or visualOptions. The map a caller reads instead of the full dashboard blob. |
| `get_dashboard_json(dashboardId)` | Escape hatch: the full normalized dashboard JSON from the daemon working copy. Use typed read tools first because this can be large. |
| `list_pages(dashboardId)` | `[{id, name}]`. |
| `list_tiles(dashboardId, pageId?)` | `[{id, title, visualType, pageId, layout, queryId, hasQuery}]`, optionally filtered to one page. |
| `get_tile(dashboardId, tileId)` | the full tile object plus its resolved query (`{text, usedVariables, dataSource}`) inlined. |
| `get_query(dashboardId, tileId)` | `{queryId, text, usedVariables, dataSource}`. |
| `get_parameters(dashboardId)` | full parameter list (kinds, variable names, defaults, data sources). |
| `get_schema(schemaVersion?, file?)` | cached schema. `file` selects one schema file (`tile.json`, `query.json`, `parameter.json`, ...); omit it for the whole `{filename: schema}` graph. `schemaVersion` defaults to 76. |
| `get_schema_for_dashboard(dashboardId, file?)` | cached schema at the version the dashboard actually uses. Resolves `schema_version` server-side so the caller never passes it, then returns `{dashboardId, schemaVersion, file, schema}`. The safe choice for a known dashboard. |

### Write (typed; resolve refs; mutate working copy; validate every call)

| Tool | Behavior |
| --- | --- |
| `set_query(dashboardId, tileId, text, usedVariables)` | Resolves the tile's `queryRef`, rewrites that query's `text` and `usedVariables` (see the usedVariables rule below). Returns `{queryId, usedVariables}` and any lint warnings. |
| `set_query_datasource(dashboardId, tileId, dataSourceId)` | Repoints the tile's query at a different entry in `dataSources[]`. Validates the id exists. |
| `set_tile(dashboardId, tileId, {title?, hideTitle?, description?, layout?, visualType?, visualOptions?, markdownText?})` | Patch semantics; the envelope is schema-validated. `markdownText` sets the body of a `markdownCard` tile. Changing `visualType` to/from `markdownCard` enforces the queryRef presence/absence rule and errors with guidance rather than silently corrupting. |
| `set_layout(dashboardId, tileId, {x?, y?, width?, height?})` | At least one of x/y/width/height required (patch). Validates bounds (`width>=2`, `height>=1`, `x,y>=0`). Split from `set_tile` because moving/resizing is the most common cosmetic edit. |
| `add_tile(dashboardId, {pageId, visualType, title, layout, query?, visualOptions?})` | Creates the tile and, for non-markdown visuals, the backing `queries[]` entry in one call (`query = {text, usedVariables, dataSourceId}`). Generates the uuids and queryRef wiring. `markdownCard` skips the query. Returns the new `tileId` (plus `queryId`). |
| `remove_tile(dashboardId, tileId)` | Removes the tile and garbage-collects its query if no other tile/parameter references it. |
| `set_parameter(dashboardId, parameterId, patch)` | Merges the patch and validates against `parameter.json`, which carries the per-kind required fields (`string|int|long|real|decimal|bool|datetime|duration|dataSource`; e.g. `duration` needs `beginVariableName`/`endVariableName`, query-backed `scalar`/`array` need `includeAllOption` plus a `dataSource`). Renaming a variable name flags every query whose `usedVariables` references the old name. A per-kind typed input shape is a candidate refinement. |
| `add_parameter` / `remove_parameter` | Same validation. `remove_parameter` warns if any query still lists its variable in `usedVariables`. |
| `rename_page(dashboardId, pageId, name)` | Renames the page. |
| `set_dashboard_json(dashboardId, dashboard)` | Escape hatch: replaces the full daemon working copy with normalized dashboard JSON after full schema validation. Prefer typed tools when they can express the change; use this for gaps like page add/remove until dedicated tools exist. |

### Lifecycle

| Tool | Behavior |
| --- | --- |
| `apply(dashboardId)` | Pushes `working.json` to the browser, blocks on approval while emitting progress ("Waiting for your approval on the ADX dashboard..."), then returns `{applied, tileErrors:[{tileId, message}]}`. Detect-and-refuse if the dashboard is open in more than one tab. |
| `get_errors(dashboardId)` | Current `tileErrors` from the live render. Used after `apply` to confirm a fix. |
| `discard(dashboardId)` | Drops `working.json`, reverts to `saved.json`. |
| `refresh(dashboardId)` | Re-runs the live dashboard's queries. |

### Deferred to phase 2 (documented, not v1)

| Tool | Purpose |
| --- | --- |
| `diff(dashboardId)` | A compact summary of working-vs-saved changes. |
| `list_open_tabs(dashboardId)` / `select_tab(instanceId)` | Per-tab routing on top of the v1 `instanceId` plumbing. |
| `add_page` / `remove_page` | Page creation/removal. |
| `move_tile_to_page` | Convenience wrapper over `set_tile(pageId)`. |

## usedVariables rule (explicit, not derived)

Variables are not required to start with `_`, so scanning the query text is unreliable (false
negatives on non-prefixed vars, false positives on columns and `let` bindings). So:

1. `set_query` requires an explicit `usedVariables: string[]`. The agent cannot skip a field the
   tool demands.
2. Validate: every entry must be a declared dashboard parameter variable name (including a
   duration parameter's `beginVariableName`/`endVariableName`). Reject unknown names with a clear
   message.
3. Lint (warning, non-fatal): for each declared parameter whose variable name appears as a
   whole-word token in `queryText` but is missing from `usedVariables`, return "possible missing
   usedVariable: X". Kept as a warning, not a hard block, because of column-name collisions.
4. The tool description states the injection rule inline: "The dashboard only injects the
   parameter variables listed in usedVariables. List every dashboard parameter referenced by
   queryText."

Four layers (required field, validation, lint, inline description) that a prose rule cannot
enforce, only request.
