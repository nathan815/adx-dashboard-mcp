// HTTP client + lifecycle manager for the localhost daemon.
//
// The MCP server is ephemeral (one per agent run); the daemon is a persistent
// singleton that owns the browser connection, the schema cache, and the
// saved/working store. This module is the only place the MCP process talks to
// it.
//
// We use node:http rather than global fetch on purpose. fetch (undici) keeps
// pooled sockets alive and a later process exit can crash libuv with an
// assertion on Windows. For a localhost-only client, http.request gives clean,
// prompt teardown.

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const DAEMON_PORT = parseInt(process.env.ADX_AGENT_PORT || '9876', 10);
const DAEMON_BASE = `http://127.0.0.1:${DAEMON_PORT}`;
const SERVER_PATH = path.join(__dirname, '..', 'daemon', 'agent-server.js');

// Keep the log next to the schema/store cache so it survives npx runs (cwd is
// unstable under npx, so writing a .cache/ there would scatter logs).
function cacheRoot() {
  return process.env.ADX_LIVE_EDIT_HOME || path.join(os.homedir(), '.adx-live-edit-mcp');
}

// A daemon failure that already carries a structured payload from the server.
// Tool handlers turn this into a clean MCP error instead of a stack trace.
export class DaemonError extends Error {
  constructor(message, { status, code, details, response } = {}) {
    super(message);
    this.name = 'DaemonError';
    this.status = status;
    this.code = code;
    this.details = details;
    this.response = response;
  }
}

// Low-level request. Resolves with { status, ok, body } and only rejects on a
// transport-level failure (connection refused, timeout). Non-2xx is returned,
// not thrown, so callers can inspect the daemon's structured error body.
export function request(method, pathAndQuery, body, timeoutMs = 130000) {
  return new Promise((resolve, reject) => {
    const u = new URL(DAEMON_BASE + pathAndQuery);
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        method,
        headers: payload ? { 'Content-Type': 'application/json' } : {},
      },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          let parsed = null;
          if (data) {
            try { parsed = JSON.parse(data); } catch { parsed = { raw: data }; }
          }
          resolve({
            status: res.statusCode,
            ok: res.statusCode >= 200 && res.statusCode < 300,
            body: parsed,
          });
        });
      }
    );
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`Daemon request timed out after ${timeoutMs}ms`));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// Call the daemon and return its body on success, or throw a DaemonError that
// preserves the server's code/details. The daemon reports some failures as a
// 200 with { error } or { success:false } (e.g. a page action that could not
// run), so those are treated as failures too.
export async function call(method, pathAndQuery, body, { timeoutMs, context } = {}) {
  let res;
  try {
    res = await request(method, pathAndQuery, body, timeoutMs);
  } catch (e) {
    throw new DaemonError(`${context || 'Daemon request'} failed: ${e.message}`, {
      code: 'daemon_unreachable',
    });
  }
  const payload = res.body;
  if (!res.ok) {
    const msg = (payload && (payload.error || payload.message)) || `HTTP ${res.status}`;
    throw new DaemonError(`${context || 'Request'} failed: ${msg}`, {
      status: res.status,
      code: payload && payload.code,
      details: payload && payload.details,
      response: payload,
    });
  }
  if (payload && payload.success === false) {
    throw new DaemonError(`${context || 'Request'} failed`, { status: res.status, response: payload });
  }
  if (payload && payload.error) {
    throw new DaemonError(`${context || 'Request'} failed: ${payload.error}`, {
      status: res.status,
      code: payload.code,
      response: payload,
    });
  }
  return payload;
}

// Short-timeout health probe. A down daemon rejects fast (ECONNREFUSED), so the
// common cold-start case resolves quickly.
export async function isDaemonUp() {
  try {
    const res = await request('GET', '/status', undefined, 1000);
    return res.ok && res.body && res.body.status === 'ok';
  } catch {
    return false;
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Start the daemon as a detached, unref'd singleton if it is not already up.
// The daemon binds the port, so a redundant spawn simply fails to bind and
// exits; we only spawn after a failed probe, then wait for it to report healthy.
export async function ensureDaemon() {
  if (await isDaemonUp()) return;

  if (!fs.existsSync(SERVER_PATH)) {
    throw new DaemonError(`Daemon not found at ${SERVER_PATH}`, { code: 'daemon_missing' });
  }

  const root = cacheRoot();
  fs.mkdirSync(root, { recursive: true });
  const logPath = path.join(root, 'daemon.log');
  const out = fs.openSync(logPath, 'a');

  const child = spawn(process.execPath, [SERVER_PATH, '--port', String(DAEMON_PORT)], {
    detached: true,
    stdio: ['ignore', out, out],
    windowsHide: true,
  });
  child.unref();

  // Cold start is slow on the first run (Windows process spawn + ajv lazy-load),
  // so allow a generous window. Still well under the request timeout, so it
  // never masks a real hang.
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    await sleep(150);
    if (await isDaemonUp()) return;
  }

  throw new DaemonError('Daemon did not become healthy after start', {
    code: 'daemon_unhealthy',
    details: { logPath },
  });
}

const enc = encodeURIComponent;

// Typed endpoint helpers. Each maps one daemon route; tool handlers call these
// so the route strings live in one place.
export const daemon = {
  status: () => call('GET', '/status', undefined, { timeoutMs: 2000, context: 'Status' }),
  listDashboards: () => call('GET', '/dashboards', undefined, { timeoutMs: 5000, context: 'List dashboards' }),
  getSchema: (file, version) => {
    const q = new URLSearchParams();
    if (file) q.set('file', file);
    if (version) q.set('version', String(version));
    const qs = q.toString();
    return call('GET', qs ? `/schema?${qs}` : '/schema', undefined, { context: 'Get schema' });
  },

  // Lifecycle.
  pull: (id) => call('POST', `/dashboards/${enc(id)}/pull`, {}, { context: 'Pull dashboard' }),
  // Apply blocks on the daemon's long-poll for user approval (EDIT_TIMEOUT_MS
  // is 120s server-side), so give the client a little headroom above that.
  // skipConfirmation auto-clicks ADX's per-apply "Continue" dialog so the edit
  // actually commits; the one-time "Allow Edits" consent is the human gate.
  apply: (id, { skipConfirmation = true } = {}) =>
    call('POST', `/dashboards/${enc(id)}/apply`, { skipConfirmation }, { timeoutMs: 150000, context: 'Apply' }),
  discard: (id) => call('POST', `/dashboards/${enc(id)}/discard`, {}, { context: 'Discard' }),
  refresh: (id) => call('POST', `/dashboards/${enc(id)}/refresh`, {}, { context: 'Refresh' }),
  getErrors: (id) => call('GET', `/dashboards/${enc(id)}/errors`, undefined, { context: 'Get errors' }),

  // Typed read views over the working copy.
  summary: (id) => call('GET', `/dashboards/${enc(id)}/summary`, undefined, { context: 'Get summary' }),
  listPages: (id) => call('GET', `/dashboards/${enc(id)}/page-list`, undefined, { context: 'List pages' }),
  getParameters: (id) => call('GET', `/dashboards/${enc(id)}/parameters`, undefined, { context: 'Get parameters' }),
  listTiles: (id, pageId) => {
    const q = pageId ? `?pageId=${enc(pageId)}` : '';
    return call('GET', `/dashboards/${enc(id)}/tiles${q}`, undefined, { context: 'List tiles' });
  },
  getTile: (id, tileId) => call('GET', `/dashboards/${enc(id)}/tiles/${enc(tileId)}`, undefined, { context: 'Get tile' }),
  getQuery: (id, tileId) => call('GET', `/dashboards/${enc(id)}/tiles/${enc(tileId)}/query`, undefined, { context: 'Get query' }),

  // Typed element writes against the working copy.
  patch: (id, route, body) => call('POST', `/dashboards/${enc(id)}/${route}`, body, { context: route }),
};
