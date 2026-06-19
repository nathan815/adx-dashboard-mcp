// Lifecycle tools: push the working copy to the live page (with blocking
// approval), read render errors, discard edits, and refresh. None of these
// auto-pull; an implicit pull here would hide what the agent is acting on.

import { z } from 'zod';
import { daemon, DaemonError } from '../daemon-client.js';
import { handler, jsonResult, errorResult } from './common.js';

export function registerLifecycleTools(server) {
  server.registerTool(
    'apply',
    {
      title: 'Apply edits',
      description:
        'Push the dashboard\'s working copy to the open browser tab and block until you approve (or reject) it there. Refuses if the dashboard is open in more than one tab. Returns the apply result including any per-tile render errors.',
      inputSchema: { dashboardId: z.string() },
    },
    handler(async ({ dashboardId }, extra) => {
      // While the daemon long-polls for the user's approval, emit MCP progress
      // notifications so the client shows a live pending state instead of an
      // opaque hang. Only fire when the caller supplied a progress token.
      const token = extra && extra._meta && extra._meta.progressToken;
      const canNotify = token != null && typeof extra.sendNotification === 'function';

      const sendProgress = async (progress) => {
        if (!canNotify) return;
        try {
          await extra.sendNotification({
            method: 'notifications/progress',
            params: {
              progressToken: token,
              progress,
              message: 'Waiting for your approval on the ADX dashboard...',
            },
          });
        } catch {
          // A failed heartbeat must never break the apply.
        }
      };

      let timer = null;
      try {
        await sendProgress(0);
        if (canNotify) {
          let n = 0;
          timer = setInterval(() => {
            n += 1;
            void sendProgress(n);
          }, 3000);
        }

        const body = await daemon.apply(dashboardId);
        // A page-side apply failure comes back as HTTP 200 { ok:false, result },
        // which call() does not treat as an error, so check it here.
        if (body && body.ok === false) {
          return errorResult(
            new DaemonError('Apply did not complete on the page', {
              status: 200,
              code: 'apply_failed',
              response: body.result,
            })
          );
        }
        return jsonResult(body.result ?? body);
      } finally {
        if (timer) clearInterval(timer);
      }
    })
  );

  server.registerTool(
    'get_errors',
    {
      title: 'Get tile errors',
      description:
        'Read the live dashboard\'s current per-tile render errors. Use after apply to confirm a fix. Does not require a working copy.',
      inputSchema: { dashboardId: z.string() },
    },
    handler(async ({ dashboardId }) => {
      const body = await daemon.getErrors(dashboardId);
      return jsonResult(body);
    })
  );

  server.registerTool(
    'discard',
    {
      title: 'Discard edits',
      description:
        'Throw away the working copy and revert to the last saved state. Errors if nothing has been pulled yet.',
      inputSchema: { dashboardId: z.string() },
    },
    handler(async ({ dashboardId }) => {
      const body = await daemon.discard(dashboardId);
      return jsonResult(body.result);
    })
  );

  server.registerTool(
    'refresh',
    {
      title: 'Refresh dashboard',
      description: 'Re-run the live dashboard\'s queries in the open tab. Does not require a working copy.',
      inputSchema: { dashboardId: z.string() },
    },
    handler(async ({ dashboardId }) => {
      const body = await daemon.refresh(dashboardId);
      return jsonResult(body);
    })
  );
}
