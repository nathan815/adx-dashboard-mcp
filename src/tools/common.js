// Shared helpers for the MCP tool handlers: daemon readiness, first-access
// auto-pull, and the MCP content/error envelopes.

import { ensureDaemon, daemon, DaemonError } from '../daemon-client.js';

// ensureDaemon is idempotent but does real work (probe, maybe spawn + 20s
// poll). We memoize the in-flight promise so the first few tool calls share one
// cold start instead of racing several spawns. On failure we clear it so a
// later call can retry rather than caching a dead daemon forever.
let readyPromise = null;
export function ensureReady() {
  if (!readyPromise) {
    readyPromise = ensureDaemon().catch((e) => {
      readyPromise = null;
      throw e;
    });
  }
  return readyPromise;
}

// The design exposes no explicit `pull` tool: "on first access, the daemon
// pulls." The committed daemon does not auto-pull and returns 409
// no_working_copy instead, so the MCP layer does it: run the read, and if the
// daemon says there is no working copy, pull once and retry. Reads only; never
// auto-pull for apply/discard, where an implicit pull would hide intent.
export async function withAutoPull(dashboardId, fn) {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof DaemonError && e.code === 'no_working_copy') {
      await daemon.pull(dashboardId);
      return await fn();
    }
    throw e;
  }
}

export function jsonResult(obj) {
  return { content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }] };
}

export function errorResult(e) {
  if (e instanceof DaemonError) {
    const payload = { error: e.message, code: e.code, status: e.status };
    if (e.details !== undefined) payload.details = e.details;
    // Surface the structured fields an agent may need to act on (e.g. the open
    // tabs behind a multi-tab refusal, or the daemon's recovery hint).
    if (e.response && typeof e.response === 'object') {
      for (const k of ['instances', 'hint', 'warnings']) {
        if (e.response[k] !== undefined) payload[k] = e.response[k];
      }
    }
    return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }], isError: true };
  }
  return {
    content: [{ type: 'text', text: JSON.stringify({ error: e?.message || String(e) }, null, 2) }],
    isError: true,
  };
}

// Wrap a tool body so every handler ensures the daemon is up first and turns
// thrown errors into a clean MCP error envelope. Diagnostics go to stderr only;
// stdout is the MCP transport.
export function handler(fn) {
  return async (args, extra) => {
    try {
      await ensureReady();
      return await fn(args, extra);
    } catch (e) {
      console.error('[adx-live-edit-mcp] tool error:', e?.stack || e?.message || e);
      return errorResult(e);
    }
  };
}
