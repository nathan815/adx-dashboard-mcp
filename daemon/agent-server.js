#!/usr/bin/env node
/**
 * ADX Dashboard Agent Server (Node.js)
 *
 * A simple HTTP server that bridges between AI agents and the Chrome extension.
 * Uses long polling for instant response without WebSocket dependencies.
 * The only third-party dependency is the validator (ajv), and it is loaded
 * lazily so read-only commands work even before `npm install`.
 *
 * Migrated from the adx-dashboard-live-edit skill (chrome-extension/agent-server.js)
 * and converted from CommonJS to ESM. Behavior is unchanged in this baseline; the
 * stateful backend (disk store, element patches) is layered on in later phases.
 *
 * Usage:
 *     node agent-server.js [--port 9876]
 *
 * API:
 *     POST /edit      - Submit dashboard edit (blocks until complete)
 *     GET  /dashboard - Get current dashboard JSON (blocks until received)
 *     GET  /poll      - Extension long-polls for commands
 *     POST /result    - Extension reports results
 *     GET  /status    - Health check
 */

import http from 'node:http';
import { randomUUID } from 'node:crypto';

const PORT = parseInt(process.argv.find((_, i, a) => a[i-1] === '--port') || '9876');
const EDIT_TIMEOUT_MS = 120000;
const GET_TIMEOUT_MS = 10000;
const ACTION_TIMEOUT_MS = 10000;
const POLL_TIMEOUT_MS = 30000;

// Server-side validation is the authoritative gate: even if an agent bypasses
// client.js and POSTs raw JSON, a malformed dashboard never reaches the browser.
// ADX_SKIP_VALIDATION=1 is a deliberate escape hatch for the rare case where
// ADX's own published schema is wrong; it disables this gate.
const SKIP_VALIDATION = process.env.ADX_SKIP_VALIDATION === '1';

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

// In-memory stores
const pendingEdits = new Map();
const pendingGets = new Map();
const pendingActions = new Map();  // Generic actions (getPages, selectPage, etc.)
const waitingPollers = [];  // Extension's long-poll requests
const connectedDashboards = new Map();  // id -> {id, title, connectedAt}

function log(msg) {
  const time = new Date().toLocaleTimeString('en-US', { hour12: false });
  console.log(`[${time}] ${msg}`);
}

// Wake up any waiting pollers when a new command arrives
function notifyPollers() {
  while (waitingPollers.length > 0) {
    const { res, dashboardId, timeout } = waitingPollers.shift();
    clearTimeout(timeout);
    handlePollResponse(res, dashboardId);
  }
}

function handlePollResponse(res, dashboardId) {
  // Check for pending get requests first
  for (const [id, get] of pendingGets) {
    if (!get.result && (get.dashboardId === '*' || get.dashboardId === dashboardId)) {
      sendJson(res, { pendingGet: { id, dashboardId: get.dashboardId } });
      return;
    }
  }

  // Check for pending actions (getPages, selectPage, etc.)
  for (const [id, action] of pendingActions) {
    if (!action.result && (action.dashboardId === '*' || action.dashboardId === dashboardId)) {
      sendJson(res, {
        pendingAction: {
          id,
          dashboardId: action.dashboardId,
          type: action.type,
          params: action.params
        }
      });
      return;
    }
  }

  // Check for pending edits
  for (const [id, edit] of pendingEdits) {
    if (!edit.result && (edit.dashboardId === '*' || edit.dashboardId === dashboardId)) {
      sendJson(res, {
        pendingEdit: {
          id,
          dashboardId: edit.dashboardId,
          dashboard: edit.dashboard,
          description: edit.description,
          skipConfirmation: edit.skipConfirmation,
          filename: edit.filename,
          expiresAt: edit.expiresAt
        }
      });
      return;
    }
  }

  sendJson(res, { pendingEdit: null, pendingGet: null, pendingAction: null });
}

function sendJson(res, data, status = 200) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*'
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

// Route handlers
async function handleStatus(req, res) {
  sendJson(res, {
    status: 'ok',
    version: '2.0.0',
    pendingEdits: pendingEdits.size,
    pendingGets: pendingGets.size
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
  // the caller skipped client.js and hit this endpoint directly.
  if (!SKIP_VALIDATION) {
    const { fn, err } = await getValidator();
    if (err) {
      return sendJson(res, {
        error: 'Validation could not run on the server',
        detail: err.message,
        hint: 'Run `npm install` in the adx-dashboard-live-edit skill so the validator (ajv) is available, or set ADX_SKIP_VALIDATION=1 to bypass.'
      }, 500);
    }
    let validation;
    try {
      validation = await fn(data.dashboard);
    } catch (e) {
      return sendJson(res, {
        error: 'Validation could not run on the server',
        detail: e.message,
        hint: 'Check network access to the ADX schema host or a populated .cache/schema dir.'
      }, 500);
    }
    if (!validation.valid) {
      return sendJson(res, {
        error: 'Dashboard failed schema validation; edit not applied',
        validationErrors: validation.errors,
        hint: 'Fix the JSON in the authoring skill and re-validate before applying.'
      }, 400);
    }
  }

  const editId = randomUUID();
  const dashboardId = dashboardIdFromPath || data.dashboardId || '*';

  const edit = {
    id: editId,
    dashboardId,
    dashboard: data.dashboard,
    description: data.description || 'Agent edit',
    skipConfirmation: data.skipConfirmation || false,
    filename: data.filename || 'agent-edit.json',
    createdAt: Date.now(),
    expiresAt: Date.now() + EDIT_TIMEOUT_MS,
    result: null,
    resolve: null
  };

  // Create promise that will be resolved when result arrives
  const resultPromise = new Promise((resolve) => {
    edit.resolve = resolve;
  });

  pendingEdits.set(editId, edit);
  log(`Edit queued: ${editId} for dashboard ${dashboardId}`);

  // Wake up any waiting pollers
  notifyPollers();

  // Wait for result with timeout
  const timeoutPromise = new Promise((resolve) =>
    setTimeout(() => resolve({ timeout: true }), EDIT_TIMEOUT_MS)
  );

  const result = await Promise.race([resultPromise, timeoutPromise]);
  pendingEdits.delete(editId);

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

  const getId = randomUUID();
  const get = {
    id: getId,
    dashboardId,
    createdAt: Date.now(),
    result: null,
    resolve: null
  };

  const resultPromise = new Promise((resolve) => {
    get.resolve = resolve;
  });

  pendingGets.set(getId, get);
  log(`Get queued: ${getId} for dashboard ${dashboardId}`);

  // Wake up any waiting pollers
  notifyPollers();

  const timeoutPromise = new Promise((resolve) =>
    setTimeout(() => resolve({ timeout: true }), GET_TIMEOUT_MS)
  );

  const result = await Promise.race([resultPromise, timeoutPromise]);
  pendingGets.delete(getId);

  if (result.timeout) {
    log(`Get timeout: ${getId}`);
    return sendJson(res, {
      error: 'Timeout waiting for dashboard data',
      hint: 'Make sure the ADX dashboard is open'
    }, 504);
  }

  log(`Get completed: ${getId}`);
  sendJson(res, result);
}

async function handlePoll(req, res) {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const dashboardId = url.searchParams.get('dashboardId');

  if (!dashboardId) {
    return sendJson(res, { error: 'Missing dashboardId' }, 400);
  }

  // Check if there's already a pending command
  for (const [id, get] of pendingGets) {
    if (!get.result && (get.dashboardId === '*' || get.dashboardId === dashboardId)) {
      return sendJson(res, { pendingGet: { id, dashboardId: get.dashboardId } });
    }
  }

  for (const [id, edit] of pendingEdits) {
    if (!edit.result && (edit.dashboardId === '*' || edit.dashboardId === dashboardId)) {
      return sendJson(res, {
        pendingEdit: {
          id,
          dashboardId: edit.dashboardId,
          dashboard: edit.dashboard,
          description: edit.description,
          skipConfirmation: edit.skipConfirmation,
          filename: edit.filename,
          expiresAt: edit.expiresAt
        }
      });
    }
  }

  for (const [id, action] of pendingActions) {
    if (!action.result && (action.dashboardId === '*' || action.dashboardId === dashboardId)) {
      return sendJson(res, {
        pendingAction: {
          id,
          dashboardId: action.dashboardId,
          type: action.type,
          params: action.params
        }
      });
    }
  }

  // No pending commands - hold the connection (long poll)
  const timeout = setTimeout(() => {
    // Remove from waiting list
    const idx = waitingPollers.findIndex(p => p.res === res);
    if (idx >= 0) waitingPollers.splice(idx, 1);
    sendJson(res, { pendingEdit: null, pendingGet: null, pendingAction: null });
  }, POLL_TIMEOUT_MS);

  waitingPollers.push({ res, dashboardId, timeout });
}

async function handleResult(req, res) {
  let data;
  try {
    data = await parseBody(req);
  } catch (e) {
    return sendJson(res, { error: 'Invalid JSON' }, 400);
  }

  const { editId, getId, result } = data;

  if (!result) {
    return sendJson(res, { error: 'Missing result' }, 400);
  }

  if (editId && pendingEdits.has(editId)) {
    const edit = pendingEdits.get(editId);
    edit.result = result;
    edit.resolve(result);
    return sendJson(res, { ok: true });
  }

  if (getId && pendingGets.has(getId)) {
    const get = pendingGets.get(getId);
    get.result = result;
    get.resolve(result);
    return sendJson(res, { ok: true });
  }

  // Handle action results (getPages, selectPage, etc.)
  const { actionId } = data;
  if (actionId && pendingActions.has(actionId)) {
    const action = pendingActions.get(actionId);
    action.result = result;
    action.resolve(result);
    return sendJson(res, { ok: true });
  }

  sendJson(res, { error: 'Request not found' }, 404);
}

async function handleConnect(req, res) {
  let data;
  try {
    data = await parseBody(req);
  } catch (e) {
    return sendJson(res, { error: 'Invalid JSON' }, 400);
  }

  const { dashboardId, title } = data;
  if (!dashboardId) {
    return sendJson(res, { error: 'Missing dashboardId' }, 400);
  }

  const isNew = !connectedDashboards.has(dashboardId);
  connectedDashboards.set(dashboardId, {
    id: dashboardId,
    title: title || 'Untitled',
    connectedAt: Date.now()
  });

  if (isNew) {
    log(`Extension connected: ${dashboardId} "${title || 'Untitled'}"`);
  }

  sendJson(res, { ok: true });
}

async function handleDisconnect(req, res) {
  let data;
  try {
    data = await parseBody(req);
  } catch (e) {
    return sendJson(res, { error: 'Invalid JSON' }, 400);
  }

  const { dashboardId } = data;
  if (dashboardId && connectedDashboards.has(dashboardId)) {
    const info = connectedDashboards.get(dashboardId);
    connectedDashboards.delete(dashboardId);
    log(`Extension disconnected: ${dashboardId} "${info.title}"`);
  }

  sendJson(res, { ok: true });
}

async function handleDashboards(req, res) {
  const dashboards = Array.from(connectedDashboards.values());
  sendJson(res, { dashboards });
}

async function handlePages(req, res, dashboardIdFromPath) {
  const dashboardId = dashboardIdFromPath || '*';

  const actionId = randomUUID();
  const action = {
    id: actionId,
    dashboardId,
    type: 'getPages',
    params: {},
    createdAt: Date.now(),
    result: null,
    resolve: null
  };

  const resultPromise = new Promise((resolve) => {
    action.resolve = resolve;
  });

  pendingActions.set(actionId, action);
  notifyPollers();

  const timeoutPromise = new Promise((resolve) =>
    setTimeout(() => resolve({ timeout: true }), ACTION_TIMEOUT_MS)
  );

  const result = await Promise.race([resultPromise, timeoutPromise]);
  pendingActions.delete(actionId);

  if (result.timeout) {
    return sendJson(res, { error: 'Timeout waiting for pages' }, 504);
  }

  sendJson(res, result);
}

async function handleRefresh(req, res, dashboardIdFromPath) {
  const dashboardId = dashboardIdFromPath || '*';

  const actionId = randomUUID();
  const action = {
    id: actionId,
    dashboardId,
    type: 'refresh',
    params: {},
    createdAt: Date.now(),
    result: null,
    resolve: null
  };

  const resultPromise = new Promise((resolve) => {
    action.resolve = resolve;
  });

  pendingActions.set(actionId, action);
  notifyPollers();

  const timeoutPromise = new Promise((resolve) =>
    setTimeout(() => resolve({ timeout: true }), ACTION_TIMEOUT_MS)
  );

  const result = await Promise.race([resultPromise, timeoutPromise]);
  pendingActions.delete(actionId);

  if (result.timeout) {
    return sendJson(res, { error: 'Timeout waiting for refresh' }, 504);
  }

  console.log(`[refresh] Dashboard ${dashboardId} refreshed`);
  sendJson(res, result);
}

async function handleErrors(req, res, dashboardIdFromPath) {
  const dashboardId = dashboardIdFromPath || '*';

  const actionId = randomUUID();
  const action = {
    id: actionId,
    dashboardId,
    type: 'getErrors',
    params: {},
    createdAt: Date.now(),
    result: null,
    resolve: null
  };

  const resultPromise = new Promise((resolve) => {
    action.resolve = resolve;
  });

  pendingActions.set(actionId, action);
  notifyPollers();

  const timeoutPromise = new Promise((resolve) =>
    setTimeout(() => resolve({ timeout: true }), ACTION_TIMEOUT_MS)
  );

  const result = await Promise.race([resultPromise, timeoutPromise]);
  pendingActions.delete(actionId);

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

  const actionId = randomUUID();
  const action = {
    id: actionId,
    dashboardId,
    type: 'selectPage',
    params: { pageIdOrName },
    createdAt: Date.now(),
    result: null,
    resolve: null
  };

  const resultPromise = new Promise((resolve) => {
    action.resolve = resolve;
  });

  pendingActions.set(actionId, action);
  log(`Select page: ${pageIdOrName} on dashboard ${dashboardId}`);
  notifyPollers();

  const timeoutPromise = new Promise((resolve) =>
    setTimeout(() => resolve({ timeout: true }), ACTION_TIMEOUT_MS)
  );

  const result = await Promise.race([resultPromise, timeoutPromise]);
  pendingActions.delete(actionId);

  if (result.timeout) {
    return sendJson(res, { error: 'Timeout waiting for page selection' }, 504);
  }

  sendJson(res, result);
}

function handleCors(req, res) {
  res.writeHead(204, {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  });
  res.end();
}

// Main server
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname;

  // CORS preflight
  if (req.method === 'OPTIONS') {
    return handleCors(req, res);
  }

  // Parse RESTful dashboard routes: /dashboards/:id/...
  const dashboardMatch = path.match(/^\/dashboards\/([^/]+)(\/(.+))?$/);

  try {
    if (path === '/status' && req.method === 'GET') {
      await handleStatus(req, res);
    } else if (path === '/dashboards' && req.method === 'GET') {
      await handleDashboards(req, res);
    } else if (dashboardMatch) {
      const dashboardId = dashboardMatch[1];
      const subPath = dashboardMatch[3] || '';

      if (!subPath && req.method === 'GET') {
        // GET /dashboards/:id - get dashboard JSON
        await handleDashboardGet(req, res, dashboardId);
      } else if (subPath === 'pages' && req.method === 'GET') {
        // GET /dashboards/:id/pages
        await handlePages(req, res, dashboardId);
      } else if (subPath === 'selectPage' && req.method === 'POST') {
        // POST /dashboards/:id/selectPage
        await handleSelectPage(req, res, dashboardId);
      } else if (subPath === 'edit' && req.method === 'POST') {
        // POST /dashboards/:id/edit
        await handleEdit(req, res, dashboardId);
      } else if (subPath === 'refresh' && req.method === 'POST') {
        // POST /dashboards/:id/refresh
        await handleRefresh(req, res, dashboardId);
      } else if (subPath === 'errors' && req.method === 'GET') {
        // GET /dashboards/:id/errors
        await handleErrors(req, res, dashboardId);
      } else {
        sendJson(res, { error: 'Not found' }, 404);
      }
    } else if (path === '/connect' && req.method === 'POST') {
      await handleConnect(req, res);
    } else if (path === '/disconnect' && req.method === 'POST') {
      await handleDisconnect(req, res);
    } else if (path === '/poll' && req.method === 'GET') {
      await handlePoll(req, res);
    } else if (path === '/result' && req.method === 'POST') {
      await handleResult(req, res);
    } else {
      sendJson(res, { error: 'Not found' }, 404);
    }
  } catch (e) {
    console.error('Error handling request:', e);
    sendJson(res, { error: 'Internal server error' }, 500);
  }
});

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
║    GET  /poll                    - Long-poll for commands         ║
║    POST /result                  - Report result                  ║
║    GET  /status                  - Health check                   ║
╚═══════════════════════════════════════════════════════════════════╝
`);
});
