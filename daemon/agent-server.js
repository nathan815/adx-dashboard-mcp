#!/usr/bin/env node
/**
 * ADX Dashboard Agent Server (Node.js)
 *
 * A simple HTTP/WebSocket server that bridges between AI agents and the Chrome extension.
 * The HTTP API is for MCP clients; the WebSocket bridge is for the browser extension.
 * The validator (ajv) is loaded lazily so read-only commands work even before
 * `npm install`.
 *
 * Usage:
 *     node agent-server.js [--port 9876]
 *
 * API:
 *     POST /edit      - Submit dashboard edit (blocks until complete)
 *     GET  /dashboard - Get current dashboard JSON (blocks until received)
 *     WS   /extension - Extension command bridge
 *     GET  /status    - Health check
 */

import http from 'node:http';
import { WebSocketServer } from 'ws';
import * as store from './store.js';
import * as patch from './patch.js';
import { DEFAULT_SCHEMA_VERSION } from '../shared/validate.js';
import { createRouter } from './router.js';
import { EXTENSION_ORIGIN, EXTENSION_WS_PATH, ExtensionBroker } from './extension-broker.js';

const PORT = parseInt(process.argv.find((_, i, a) => a[i-1] === '--port') || '9876');
const EDIT_TIMEOUT_MS = 120000;
const GET_TIMEOUT_MS = 10000;
const ACTION_TIMEOUT_MS = 10000;
const VERIFY_APPLY_TIMEOUT_MS = 20000;
const VERIFY_APPLY_INTERVAL_MS = 750;

// Only the ADX dashboard page legitimately calls the daemon from a browser, and
// that is the single origin the extension content script runs on. The MCP client
// uses node:http, sends no Origin, and ignores CORS, so locking this down keeps
// any other web page from reaching the daemon without affecting the MCP path.
const ALLOWED_ORIGIN = 'https://dataexplorer.azure.com';

// Loaded lazily so read-only commands keep working even when deps are missing.
// Only the edit path needs the validator. ESM dynamic import is async, so the
// edit handler awaits this.
let _validateDashboard = null;
let _validatorLoadError = null;
async function getValidator() {
  if (!_validateDashboard && !_validatorLoadError) {
    try {
      const mod = await import('../shared/validate.js');
      _validateDashboard = mod.validateDashboard;
    } catch (e) {
      _validatorLoadError = e;
    }
  }
  return { fn: _validateDashboard, err: _validatorLoadError };
}

function log(msg) {
  const time = new Date().toLocaleTimeString('en-US', { hour12: false });
  console.log(`[${time}] ${msg}`);
}

const broker = new ExtensionBroker({ log });

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sendJson(res, data, status = 200) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': ALLOWED_ORIGIN
  });
  res.end(JSON.stringify(data));
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (e) {
        reject(new Error('Invalid JSON'));
      }
    });
  });
}

// --- Stateful backend helpers ----------------------------------------------------

// Run the schema validator and return a problem ({status, body}) when the dashboard is
// invalid or the validator could not run, or null when it passes. Shared by /edit,
// store patches, and apply so they all gate on the same authoritative check.
async function validateOrProblem(dashboard) {
  const { fn, err } = await getValidator();
  if (err) {
    return { status: 500, body: {
      error: 'Validation could not run on the server',
      detail: err.message,
      hint: 'Run `npm install` so the validator (ajv) is available.'
    } };
  }
  let validation;
  try {
    validation = await fn(dashboard);
  } catch (e) {
    return { status: 500, body: {
      error: 'Validation could not run on the server',
      detail: e.message,
      hint: 'Check network access to the ADX schema host or a populated schema cache dir.'
    } };
  }
  if (!validation.valid) {
    return { status: 400, body: {
      error: 'Dashboard failed schema validation',
      code: 'validation_failed',
      validationErrors: validation.errors
    } };
  }
  return null;
}

// Queue an edit for the page and block until the extension reports a result (or we time
// out). Extracted from handleEdit so apply reuses the exact same approval/WebSocket flow.
async function queueEditAndWait(dashboardId, dashboard, opts = {}) {
  const payload = {
    dashboard,
    description: opts.description || 'Agent edit',
    skipConfirmation: opts.skipConfirmation || false,
    filename: opts.filename || 'agent-edit.json',
    expiresAt: Date.now() + EDIT_TIMEOUT_MS,
  };
  const { commandId, result } = await broker.queueCommand(dashboardId, 'edit', payload, EDIT_TIMEOUT_MS);
  log(`Edit queued: ${commandId} for dashboard ${dashboardId}`);
  return { editId: commandId, result };
}

// Ask the page for its current dashboard JSON and block until it answers (or times out).
// Returns the page result ({ dashboard, title, meta, selectedPageId }) or { timeout: true }.
async function requestDashboardFromPage(dashboardId) {
  const { commandId, result } = await broker.queueCommand(dashboardId || '*', 'getDashboard', {}, GET_TIMEOUT_MS);
  log(`Get queued: ${commandId} for dashboard ${dashboardId || '*'}`);
  return result;
}

async function requestActionFromPage(dashboardId, type, params = {}) {
  const { result } = await broker.queueCommand(dashboardId || '*', 'action', { type, params }, ACTION_TIMEOUT_MS);
  return result;
}

// Deterministic JSON with object keys sorted, so two structurally-equal
// dashboards stringify identically regardless of key insertion order.
function stableStringify(value) {
  if (Array.isArray(value)) {
    return '[' + value.map(stableStringify).join(',') + ']';
  }
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(value[k])).join(',') + '}';
  }
  return JSON.stringify(value);
}

// The page content script's "did the apply dialog close" heuristic can return a
// false negative even when the edit actually committed. When that happens we ask
// the page for its current JSON and compare it to the working copy we pushed.
// Because every apply carries a unique change, the live state can only match the
// working copy if the edit truly landed, so this can overturn a false negative
// but never invent a false success. Returns true when verified applied.
async function verifyAppliedAgainstPage(dashboardId, workingDash, timeoutMs = VERIFY_APPLY_TIMEOUT_MS) {
  const expected = stableStringify(workingDash);
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const page = await requestDashboardFromPage(dashboardId);
    if (page && !page.timeout && !page.error && page.dashboard && stableStringify(page.dashboard) === expected) {
      return true;
    }
    if (Date.now() < deadline) {
      await sleep(VERIFY_APPLY_INTERVAL_MS);
    }
  }
  return false;
}

// Route handlers
async function handleStatus(req, res) {
  sendJson(res, {
    status: 'ok',
    version: '2.0.0',
    pendingCommands: broker.pendingCount(),
    connectedDashboards: broker.listDashboards().length
  });
}

async function handleEdit(req, res, dashboardIdFromPath) {
  let data;
  try {
    data = await parseBody(req);
  } catch (e) {
    return sendJson(res, { error: 'Invalid JSON' }, 400);
  }

  if (!data.dashboard) {
    return sendJson(res, { error: 'Missing dashboard field' }, 400);
  }

  // Validate before queuing so a bad edit can never reach the browser, even when
  // the caller skipped the MCP layer and hit this endpoint directly.
  const problem = await validateOrProblem(data.dashboard);
  if (problem) return sendJson(res, problem.body, problem.status);

  const dashboardId = dashboardIdFromPath || data.dashboardId || '*';
  const { editId, result } = await queueEditAndWait(dashboardId, data.dashboard, {
    description: data.description || 'Agent edit',
    skipConfirmation: data.skipConfirmation || false,
    filename: data.filename || 'agent-edit.json'
  });

  if (result.timeout) {
    log(`Edit timeout: ${editId}`);
    return sendJson(res, {
      error: 'Timeout waiting for extension to apply edit',
      hint: 'Make sure the ADX dashboard is open and the extension is installed'
    }, 504);
  }

  log(`Edit completed: ${editId}`);
  sendJson(res, result);
}

async function handleDashboardGet(req, res, dashboardIdFromPath) {
  const dashboardId = dashboardIdFromPath || '*';
  const result = await requestDashboardFromPage(dashboardId);

  if (result.timeout) {
    return sendJson(res, {
      error: 'Timeout waiting for dashboard data',
      hint: 'Make sure the ADX dashboard is open'
    }, 504);
  }

  sendJson(res, result);
}

async function handleDashboards(req, res) {
  sendJson(res, { dashboards: broker.listDashboards() });
}

async function handlePages(req, res, dashboardIdFromPath) {
  const dashboardId = dashboardIdFromPath || '*';
  const result = await requestActionFromPage(dashboardId, 'getPages');

  if (result.timeout) {
    return sendJson(res, { error: 'Timeout waiting for pages' }, 504);
  }

  sendJson(res, result);
}

async function handleRefresh(req, res, dashboardIdFromPath) {
  const dashboardId = dashboardIdFromPath || '*';
  const result = await requestActionFromPage(dashboardId, 'refresh');

  if (result.timeout) {
    return sendJson(res, { error: 'Timeout waiting for refresh' }, 504);
  }

  console.log(`[refresh] Dashboard ${dashboardId} refreshed`);
  sendJson(res, result);
}

async function handleErrors(req, res, dashboardIdFromPath) {
  const dashboardId = dashboardIdFromPath || '*';
  const result = await requestActionFromPage(dashboardId, 'getErrors');

  if (result.timeout) {
    return sendJson(res, { error: 'Timeout waiting for errors' }, 504);
  }

  const errorCount = result.errors?.length || 0;
  console.log(`[getErrors] Dashboard ${dashboardId}: ${errorCount} tile error(s)`);
  sendJson(res, result);
}

async function handleSelectPage(req, res, dashboardIdFromPath) {
  let data;
  try {
    data = await parseBody(req);
  } catch (e) {
    return sendJson(res, { error: 'Invalid JSON' }, 400);
  }

  const { pageId, pageName } = data;
  const dashboardId = dashboardIdFromPath || data.dashboardId || '*';
  const pageIdOrName = pageId || pageName;

  if (!pageIdOrName) {
    return sendJson(res, { error: 'Missing pageId or pageName' }, 400);
  }

  log(`Select page: ${pageIdOrName} on dashboard ${dashboardId}`);
  const result = await requestActionFromPage(dashboardId, 'selectPage', { pageIdOrName });

  if (result.timeout) {
    return sendJson(res, { error: 'Timeout waiting for page selection' }, 504);
  }

  sendJson(res, result);
}

// --- Stateful backend route handlers ---------------------------------------------

// Run a pure read view over the working copy. readFn receives the dashboard and returns
// a friendly typed result; it must never expose the raw normalized JSON.
async function handleStoreRead(req, res, dashboardId, readFn) {
  if (!store.hasWorking(dashboardId)) {
    return sendJson(res, {
      error: 'No working copy for this dashboard',
      code: 'no_working_copy',
      hint: 'Call pull first to load the dashboard from the open tab.'
    }, 409);
  }
  let dash;
  try {
    dash = store.loadWorking(dashboardId);
  } catch (e) {
    return sendJson(res, { error: e.message, code: 'store_read_failed' }, 500);
  }
  try {
    const result = readFn(dash);
    sendJson(res, { ok: true, result });
  } catch (e) {
    if (e instanceof patch.PatchError) {
      return sendJson(res, { error: e.message, code: e.code, details: e.details }, 400);
    }
    sendJson(res, { error: e.message, code: 'internal_error' }, 500);
  }
}

// Apply one element-level mutator to the working copy: load, mutate in place, validate,
// then persist. The agent never sees or sends the normalized JSON; it sends typed fields.
async function handleStorePatch(req, res, dashboardId, patchFn) {
  if (!store.hasWorking(dashboardId)) {
    return sendJson(res, {
      error: 'No working copy for this dashboard',
      code: 'no_working_copy',
      hint: 'Call pull first to load the dashboard from the open tab.'
    }, 409);
  }
  let body;
  try {
    body = await parseBody(req);
  } catch (e) {
    return sendJson(res, { error: 'Invalid JSON', code: 'invalid_input' }, 400);
  }
  let dash;
  try {
    dash = store.loadWorking(dashboardId);
  } catch (e) {
    return sendJson(res, { error: e.message, code: 'store_read_failed' }, 500);
  }

  let outcome;
  try {
    outcome = patchFn(dash, body);
  } catch (e) {
    if (e instanceof patch.PatchError) {
      return sendJson(res, { error: e.message, code: e.code, details: e.details }, 400);
    }
    return sendJson(res, { error: e.message, code: 'internal_error' }, 500);
  }

  const problem = await validateOrProblem(dash);
  if (problem) return sendJson(res, problem.body, problem.status);

  try {
    store.writeWorking(dashboardId, dash);
  } catch (e) {
    return sendJson(res, { error: e.message, code: 'store_write_failed' }, 500);
  }

  sendJson(res, { ok: true, result: outcome.result, warnings: outcome.warnings || [] });
}

async function handleSetDashboard(req, res, dashboardId) {
  if (!store.hasWorking(dashboardId)) {
    return sendJson(res, {
      error: 'No working copy for this dashboard',
      code: 'no_working_copy',
      hint: 'Call pull first to load the dashboard from the open tab.'
    }, 409);
  }

  let body;
  try {
    body = await parseBody(req);
  } catch (e) {
    return sendJson(res, { error: 'Invalid JSON', code: 'invalid_input' }, 400);
  }

  const dashboard = body.dashboard;
  if (!dashboard || typeof dashboard !== 'object' || Array.isArray(dashboard)) {
    return sendJson(res, {
      error: 'Missing dashboard object',
      code: 'invalid_input'
    }, 400);
  }

  const problem = await validateOrProblem(dashboard);
  if (problem) return sendJson(res, problem.body, problem.status);

  try {
    store.writeWorking(dashboardId, dashboard);
  } catch (e) {
    return sendJson(res, { error: e.message, code: 'store_write_failed' }, 500);
  }

  sendJson(res, { ok: true, result: patch.dashboardSummary(dashboard) });
}

// Pull the live dashboard JSON from the open tab and seed both the saved and working
// copies from it. This is the entry point before any read/edit can happen.
async function handlePull(req, res, dashboardId) {
  const result = await requestDashboardFromPage(dashboardId);
  if (result.timeout) {
    return sendJson(res, {
      error: 'Timeout waiting for dashboard data',
      code: 'page_timeout',
      hint: 'Make sure the ADX dashboard tab is open.'
    }, 504);
  }
  if (result.error) {
    return sendJson(res, { error: result.error, code: 'page_error' }, 502);
  }
  if (!result.dashboard) {
    return sendJson(res, {
      error: 'Page returned no dashboard JSON',
      code: 'page_no_dashboard'
    }, 502);
  }

  try {
    store.setSavedAndWorking(dashboardId, result.dashboard);
  } catch (e) {
    return sendJson(res, { error: e.message, code: 'store_write_failed' }, 500);
  }
  sendJson(res, { ok: true, result: patch.dashboardSummary(result.dashboard) });
}

// Push the working copy to the page through the approval/WebSocket flow, then promote
// working -> saved on success. Refuses when more than one tab targets the dashboard.
async function handleApply(req, res, dashboardId) {
  if (!store.hasWorking(dashboardId)) {
    return sendJson(res, {
      error: 'No working copy to apply',
      code: 'no_working_copy',
      hint: 'Call pull first to load the dashboard from the open tab.'
    }, 409);
  }

  let body = {};
  try {
    body = await parseBody(req);
  } catch (e) {
    // apply takes no required body; ignore parse errors and use defaults.
  }

  const instances = broker.instancesFor(dashboardId);
  if (instances.length > 1) {
    return sendJson(res, {
      error: 'More than one tab is open for this dashboard; refusing to apply',
      code: 'multiple_instances',
      instances: instances.map(i => ({ instanceId: i.instanceId, title: i.title }))
    }, 409);
  }

  let dash;
  try {
    dash = store.loadWorking(dashboardId);
  } catch (e) {
    return sendJson(res, { error: e.message, code: 'store_read_failed' }, 500);
  }

  const problem = await validateOrProblem(dash);
  if (problem) return sendJson(res, problem.body, problem.status);

  const { result } = await queueEditAndWait(dashboardId, dash, {
    description: body.description || 'Agent edit',
    skipConfirmation: body.skipConfirmation || false,
    filename: body.filename || 'agent-edit.json'
  });

  if (result.timeout) {
    const verified = await verifyAppliedAgainstPage(dashboardId, dash);
    if (verified) {
      log(`Apply timed out but live state matches working copy; treating as applied (dashboard ${dashboardId})`);
      try {
        store.promoteWorkingToSaved(dashboardId);
      } catch (e) {
        return sendJson(res, { error: e.message, code: 'store_write_failed' }, 500);
      }
      return sendJson(res, {
        ok: true,
        result: {
          success: true,
          verified: true,
          note: 'The apply command timed out before the page reported back, but the live dashboard matches the working copy, so the change committed.'
        }
      });
    }
    return sendJson(res, {
      error: 'Timeout waiting for the extension to apply the edit',
      code: 'page_timeout',
      hint: 'Make sure the ADX dashboard tab is open and approve the edit.'
    }, 504);
  }
  if (result.success === false) {
    // The page reported failure, but its dialog-close detection is known to
    // false-negative. Verify against live state before trusting that.
    const verified = await verifyAppliedAgainstPage(dashboardId, dash);
    if (verified) {
      log(`Apply reported failure but live state matches working copy; treating as applied (dashboard ${dashboardId})`);
      try {
        store.promoteWorkingToSaved(dashboardId);
      } catch (e) {
        return sendJson(res, { error: e.message, code: 'store_write_failed' }, 500);
      }
      return sendJson(res, {
        ok: true,
        result: {
          success: true,
          verified: true,
          note: 'Page reported a dialog-close failure, but the live dashboard matches the applied edit, so the change committed.'
        }
      });
    }
    return sendJson(res, { ok: false, result }, 200);
  }

  try {
    store.promoteWorkingToSaved(dashboardId);
  } catch (e) {
    return sendJson(res, { error: e.message, code: 'store_write_failed' }, 500);
  }
  sendJson(res, { ok: true, result });
}

// Throw away working edits and restore working <- saved.
async function handleDiscard(req, res, dashboardId) {
  try {
    store.discard(dashboardId);
  } catch (e) {
    return sendJson(res, {
      error: e.message,
      code: 'no_saved_copy',
      hint: 'Nothing has been pulled for this dashboard yet.'
    }, 409);
  }
  sendJson(res, { ok: true, result: patch.dashboardSummary(store.loadWorking(dashboardId)) });
}

// Serve schema from the daemon-owned cache. With ?file=tile.json returns that one
// file's raw text; with no file, returns the whole { filename: schema } graph.
async function handleSchema(req, res) {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const file = url.searchParams.get('file');
  const version = url.searchParams.get('version') || String(DEFAULT_SCHEMA_VERSION);
  try {
    if (!file) {
      const graph = await store.readSchemaGraph(version);
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': ALLOWED_ORIGIN
      });
      return res.end(JSON.stringify(graph));
    }
    const text = await store.readSchemaFile(version, file);
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': ALLOWED_ORIGIN
    });
    res.end(text);
  } catch (e) {
    sendJson(res, { error: e.message, code: 'schema_read_failed' }, 502);
  }
}

function handleCors(req, res) {
  res.writeHead(204, {
    'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  });
  res.end();
}

const router = createRouter();

// Top-level endpoints.
router.get('/status', handleStatus);
router.get('/dashboards', handleDashboards);
router.get('/schema', handleSchema);

// Live page operations: proxied to the open dashboard tab via the extension bridge.
router.get('/dashboards/:id', (req, res, { params }) => handleDashboardGet(req, res, params.id));
router.get('/dashboards/:id/pages', (req, res, { params }) => handlePages(req, res, params.id));
router.post('/dashboards/:id/selectPage', (req, res, { params }) => handleSelectPage(req, res, params.id));
router.post('/dashboards/:id/edit', (req, res, { params }) => handleEdit(req, res, params.id));
router.post('/dashboards/:id/refresh', (req, res, { params }) => handleRefresh(req, res, params.id));
router.get('/dashboards/:id/errors', (req, res, { params }) => handleErrors(req, res, params.id));

// Lifecycle: move the working copy between the page, saved, and discarded.
router.post('/dashboards/:id/pull', (req, res, { params }) => handlePull(req, res, params.id));
router.post('/dashboards/:id/apply', (req, res, { params }) => handleApply(req, res, params.id));
router.post('/dashboards/:id/discard', (req, res, { params }) => handleDiscard(req, res, params.id));
router.post('/dashboards/:id/set-dashboard', (req, res, { params }) => handleSetDashboard(req, res, params.id));

// Typed read views over the working copy (never the raw normalized JSON).
router.get('/dashboards/:id/summary', (req, res, { params }) => handleStoreRead(req, res, params.id, (d) => patch.dashboardSummary(d)));
router.get('/dashboards/:id/dashboard-json', (req, res, { params }) => handleStoreRead(req, res, params.id, (d) => d));
router.get('/dashboards/:id/page-list', (req, res, { params }) => handleStoreRead(req, res, params.id, (d) => patch.listPages(d)));
router.get('/dashboards/:id/parameters', (req, res, { params }) => handleStoreRead(req, res, params.id, (d) => patch.getParameters(d)));
router.get('/dashboards/:id/tiles', (req, res, { params, url }) => handleStoreRead(req, res, params.id, (d) => patch.listTiles(d, url.searchParams.get('pageId'))));
router.get('/dashboards/:id/tiles/:tileId', (req, res, { params }) => handleStoreRead(req, res, params.id, (d) => patch.getTile(d, params.tileId)));
router.get('/dashboards/:id/tiles/:tileId/query', (req, res, { params }) => handleStoreRead(req, res, params.id, (d) => patch.getQuery(d, params.tileId)));

// Typed element writes against the working copy, one route per mutator.
const DASHBOARD_STORE_ROUTES = {
  'set-query': (dash, body) => patch.setQuery(dash, body),
  'set-query-datasource': (dash, body) => patch.setQueryDatasource(dash, body),
  'set-tile': (dash, body) => patch.setTile(dash, body),
  'set-layout': (dash, body) => patch.setLayout(dash, body),
  'add-tile': (dash, body) => patch.addTile(dash, body),
  'remove-tile': (dash, body) => patch.removeTile(dash, body),
  'set-parameter': (dash, body) => patch.setParameter(dash, body),
  'add-parameter': (dash, body) => patch.addParameter(dash, body),
  'remove-parameter': (dash, body) => patch.removeParameter(dash, body),
  'rename-page': (dash, body) => patch.renamePage(dash, body)
};
for (const [sub, fn] of Object.entries(DASHBOARD_STORE_ROUTES)) {
  router.post(`/dashboards/:id/${sub}`, (req, res, { params }) => handleStorePatch(req, res, params.id, fn));
}

// Main server
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  // CORS preflight
  if (req.method === 'OPTIONS') {
    return handleCors(req, res);
  }

  const match = router.match(req.method, url.pathname);
  if (!match) {
    return sendJson(res, { error: 'Not found' }, 404);
  }

  try {
    await match.handler(req, res, { params: match.params, url });
  } catch (e) {
    console.error('Error handling request:', e);
    sendJson(res, { error: 'Internal server error' }, 500);
  }
});

const wss = new WebSocketServer({ noServer: true });
wss.on('connection', (ws) => {
  broker.addSocket(ws);
});

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (url.pathname !== EXTENSION_WS_PATH) {
    socket.destroy();
    return;
  }

  if (req.headers.origin !== EXTENSION_ORIGIN) {
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req);
  });
});

broker.startHeartbeat();

server.listen(PORT, '127.0.0.1', () => {
  console.log(`
╔═══════════════════════════════════════════════════════════════════╗
║         ADX Dashboard Agent Server v2.2.0 (Node.js)               ║
╠═══════════════════════════════════════════════════════════════════╣
║  Listening on: http://localhost:${PORT.toString().padEnd(30)}║
║                                                                   ║
║  Dashboard API:                                                   ║
║    GET  /dashboards              - List connected dashboards      ║
║    GET  /dashboards/:id          - Get dashboard JSON             ║
║    GET  /dashboards/:id/pages    - List pages/tabs               ║
║    POST /dashboards/:id/selectPage - Navigate to page             ║
║    POST /dashboards/:id/edit     - Submit edit                    ║
║    POST /dashboards/:id/refresh  - Refresh dashboard              ║
║    GET  /dashboards/:id/errors   - Get tile errors                ║
║                                                                   ║
║  Extension:                                                       ║
║    WS   /extension               - Command bridge                 ║
║    GET  /status                  - Health check                   ║
╚═══════════════════════════════════════════════════════════════════╝
`);
});
