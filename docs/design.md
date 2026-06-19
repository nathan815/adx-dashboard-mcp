# ADX Dashboard Live-Edit MCP Server - Design

This is the canonical design reference for `adx-live-edit-mcp`. It is adapted from the
signed-off design plan and describes the architecture, the data model the tools hide, the
full v1 tool surface, and the `usedVariables` invariant.

## Goal

Replace the `adx-dashboard-live-edit` skill (a `client.js` CLI plus SKILL.md instructions)
with a stdio MCP server that exposes typed, schema-driven tools. Move the invariants the
agent kept missing (e.g. `usedVariables`) and the bookkeeping the agent did ad-hoc (edit
buffer, schema files, downloaded dashboards) out of the agent's head and into server code.

## Why

The skill-based approach failed structurally. A SKILL.md can only ask the agent to remember a
rule, and under compaction it forgets. The clearest example is the `usedVariables` failure: an
agent injected `_startTime`/`_endTime` into several query texts, the tiles errored with
`Failed to resolve scalar expression named '_startTime'`, and it burned roughly 16 tool calls
and 4 wrong hypotheses before discovering that a query only binds the variables listed in its
`usedVariables` array. A typed tool makes that rule part of the interface instead of a note in
a doc. The same session also did about 24 inline `node -e` JSON-surgery calls maintaining an
`edit.json` by hand, which the daemon-hosted working copy eliminates.

## Architecture

Keep the extension and daemon. Replace the CLI. Add caching plus a working copy in the backend
so the agent stops maintaining state.

```
many ephemeral stdio MCP servers (per agent session)   <- thin front end
                 |  HTTP 127.0.0.1:9876
        one persistent daemon (singleton)               <- owns state below
                 |
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
- **extension** (unchanged): injects into the page, applies edits, reports tile errors.

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

The real edit path is a poll-based broker keyed by dashboard id. Each tab's content script
derives `dashboardId` from the URL, POSTs `/connect`, then long-polls `GET /poll?dashboardId=<id>`.
The daemon only hands a queued command to a poll whose id matches (or `*`), and the content
script re-checks and rejects on `Dashboard ID mismatch`. Approval is per-dashboardId in page
localStorage, which is shared across same-origin tabs.

Implications:

- Different dashboards in different tabs (the common case): already correct. Commands for A only
  reach the A poller. No user involvement needed.
- Same dashboard in 2 or more tabs (the only real hazard): both tabs poll with the same id, so a
  read is answered by whichever polls first and an edit applies in both tabs' in-memory models.
  The final render/read and a save are nondeterministic between duplicate tabs, and two tabs
  saving can clobber each other.

v1 design: detect-and-refuse on duplicate same-dashboard tabs.

- The content script generates a stable per-tab `instanceId` (`crypto.randomUUID()` once per
  load) and includes it in `/connect` and `/poll`.
- The daemon tracks `dashboardId -> [{instanceId, title, connectedAt}]` instead of collapsing by
  id.
- When the MCP server is about to `apply`/write and sees more than one live instance for that id,
  it returns a typed error the agent surfaces: "Dashboard X is open in N tabs, close the extras
  or tell me which to use." This makes the ambiguity structural and un-corruptable, the same
  spirit as the `usedVariables` fix.

Future (documented, not v1): per-tab routing. The same `instanceId` plumbing supports
`/poll?...&instanceId=I`, an optional target `instanceId` on queued commands, and
`list_open_tabs` / `select_tab` tools. The v1 work builds the `instanceId` foundation and defers
routing.

## Caching

Daemon-backed, on disk, under a cache root
(`process.env.ADX_LIVE_EDIT_HOME` or `~/.adx-live-edit-mcp`):

- `schema/<schema_version>.json` - fetched once per schema version, reused across all sessions.
  Backs `get_schema` and every server-side validation.
- `dashboards/<id>/saved.json` - last fetched saved dashboard.
- `dashboards/<id>/working.json` - the edit buffer. `set_*` tools mutate this; `apply` pushes it
  to the browser.

This eliminates the repeated 1MB `get` into agent context, the hand-maintained `edit.json`, and
the get-vs-errors confusion (one authoritative working copy instead of "saved JSON" versus
"browser in-memory edited state").

## Data model the tools hide (schema v76)

The dashboard JSON is normalized, and that normalization is the single biggest source of the
agent's ad-hoc surgery. The typed tools exist to hide it.

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

Notation: **req** = required input, opt = optional. Every write mutates `working.json` and runs
full schema validation before returning. A write that would make the dashboard invalid is
rejected and the working copy is left untouched.

### Read (cheap, scoped)

- `list_dashboards()` -> `[{id, title}]`. Backed by the management API plus cache.
- `get_dashboard_summary(dashboardId)` -> pages `[{id, name}]`, tiles `[{id, title, visualType,
  pageId, layout, queryId, hasQuery}]`, parameters `[{id, displayName, kind, variableName(s),
  selectionType}]`, `schema_version`. No KQL bodies, no visualOptions. This is the map the agent
  reads instead of the 1MB blob.
- `list_pages(dashboardId)` -> `[{id, name}]`.
- `list_tiles(dashboardId, pageId?)` -> `[{id, title, visualType, pageId, layout, queryId,
  hasQuery}]`, optionally filtered to one page.
- `get_tile(dashboardId, tileId)` -> the one full tile object plus its resolved query
  (`{text, usedVariables, dataSource}`) inlined.
- `get_query(dashboardId, tileId)` -> just `{queryId, text, usedVariables, dataSource}`.
- `get_parameters(dashboardId)` -> full parameter list (kinds, variable names, defaults, data
  sources).
- `get_schema(schemaVersion?, file?)` -> cached schema. `file` selects one of the schema files
  (`tile`, `query`, `parameter`, ...) so the agent can pull just `tile.json`. Defaults to the
  dashboard's `schema_version`.

### Write (typed; resolve refs; mutate working copy; validate every call)

- `set_query(dashboardId, tileId, text, usedVariables)` - **req** all four. Resolves the tile's
  `queryRef`, rewrites that query's `text` and `usedVariables`. See the usedVariables rule below.
  Returns the updated `{queryId, usedVariables}` and any lint warnings.
- `set_query_datasource(dashboardId, tileId, dataSourceId)` - **req**. Repoints the tile's query
  at a different entry in `dataSources[]`. Validates the id exists.
- `set_tile(dashboardId, tileId, {title?, hideTitle?, description?, layout?, visualType?,
  visualOptions?})` - tileId **req**, every field opt (patch semantics). The envelope is
  schema-validated. If `visualType` changes to/from `markdownCard`, the tool enforces the
  queryRef presence/absence rule and errors with guidance rather than silently corrupting.
- `set_layout(dashboardId, tileId, {x, y, width, height})` - **req** tileId plus at least one of
  x/y/width/height (patch). Split out from `set_tile` because moving/resizing is the most common
  cosmetic edit. Validates bounds (`width>=2`, `height>=1`, `x,y>=0`).
- `add_tile(dashboardId, {pageId, visualType, title, layout, query?, visualOptions?})` - creates
  the tile and, for non-markdown visuals, the backing `queries[]` entry in one call
  (`query` = `{text, usedVariables, dataSourceId}`). Generates the uuids and the `queryRef`
  wiring. `markdownCard` skips the query. Returns the new `tileId` (plus `queryId`).
- `remove_tile(dashboardId, tileId)` - removes the tile and garbage-collects its query if no
  other tile/parameter references it.
- `set_parameter(dashboardId, parameterId, {...})` - typed per `kind`
  (`string|int|long|real|decimal|bool|datetime|duration|dataSource`). The tool knows each kind's
  required fields from `parameter.json` (e.g. `duration` needs `beginVariableName` /
  `endVariableName` plus a `dynamic|fixed` default; query-backed `scalar`/`array` need
  `includeAllOption` plus a `dataSource`). Renaming a parameter's variable name flags every query
  whose `usedVariables` references the old name.
- `add_parameter` / `remove_parameter` - same kind-aware shaping. `remove_parameter` warns if any
  query still lists its variable in `usedVariables`.
- `rename_page(dashboardId, pageId, name)` - **req**.

### Lifecycle

- `apply(dashboardId)` - push `working.json` to the browser, block on approval while emitting
  progress ("Waiting for your approval on the ADX dashboard..."), then return `{applied,
  tileErrors:[{tileId, message}]}`. Detect-and-refuse if the dashboard is open in more than one
  tab.
- `get_errors(dashboardId)` -> current `tileErrors` from the live render. Used after `apply` to
  confirm a fix.
- `discard(dashboardId)` - drop `working.json`, revert to `saved.json`.
- `refresh(dashboardId)` - re-run the live dashboard's queries.

### Deferred to phase 2 (documented, not v1)

- `diff(dashboardId)` -> a compact summary of working-vs-saved changes.
- `list_open_tabs(dashboardId)` / `select_tab(instanceId)` - per-tab routing on top of the v1
  `instanceId` plumbing.
- `add_page` / `remove_page` - page creation/removal.
- `move_tile_to_page` - convenience wrapper over `set_tile(pageId)`.

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

Four layers (required field, validation, lint, inline description) that a SKILL.md cannot
enforce, only request.

## What stays vs changes

Stays: the extension, the daemon singleton plus browser/approval ownership, the ADX-schema
validation logic, the per-dashboard approval model (12h TTL).

Changes: `client.js` becomes a thin stdio MCP server. The daemon gains a schema cache, the
dashboard saved/working store, element-level patch endpoints backing the typed tools, and the
long-poll approval for a blocking `apply`. Authoring stays a separate offline skill and shares
the `validate` logic.

## Distribution

Its own repo. MCP servers ship and version differently from skills (npm plus `npx`, an `mcp`
config block, extension releases). Registration is one stdio config block:
`command: npx, args: ["-y", "adx-live-edit-mcp"]`.

## Phases

1. Daemon backend: cache dir, schema cache, saved/working store, element-level patch endpoints
   mutating `working.json`, `apply` that pushes `working.json`, long-poll approval.
2. stdio MCP server scaffold (`@modelcontextprotocol/sdk`), tool-to-endpoint mapping, input
   validation, blocking `apply` with progress notifications.
3. Typed tools with schema-derived input shapes; `usedVariables` enforcement in `set_query`.
4. Shared validation logic; repo plus distribution wiring.
5. Retire/slim the old SKILL.md to a pointer; keep the authoring skill.
