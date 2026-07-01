// Read tools: cheap, scoped views over the dashboard's working copy so the
// agent never pulls the ~1MB normalized blob into context. Dashboard-scoped
// reads auto-pull on first access; list_dashboards and get_schema do not need a
// working copy.

import { z } from 'zod';
import { daemon } from '../daemon-client.js';
import { handler, withAutoPull, jsonResult } from './common.js';

export function registerReadTools(server) {
  server.registerTool(
    'list_dashboards',
    {
      title: 'List dashboards',
      description:
        'List the ADX dashboards the daemon currently knows about (open in a connected browser tab). Returns id, title, and how many tabs each is open in.',
      inputSchema: {},
    },
    handler(async () => {
      const body = await daemon.listDashboards();
      return jsonResult(body.dashboards);
    })
  );

  server.registerTool(
    'get_dashboard_summary',
    {
      title: 'Get dashboard summary',
      description:
        'The compact map of a dashboard: pages, tiles (id, title, visualType, pageId, layout, queryId, hasQuery), parameters, and schema_version. No KQL bodies, no visualOptions. Read this instead of the full dashboard JSON.',
      inputSchema: { dashboardId: z.string() },
    },
    handler(async ({ dashboardId }) => {
      const body = await withAutoPull(dashboardId, () => daemon.summary(dashboardId));
      return jsonResult(body.result);
    })
  );

  server.registerTool(
    'get_dashboard_json',
    {
      title: 'Get dashboard JSON',
      description:
        'Escape hatch: return the full normalized dashboard JSON from the daemon working copy. Use typed read tools first when possible because this can be large.',
      inputSchema: { dashboardId: z.string() },
    },
    handler(async ({ dashboardId }) => {
      const body = await withAutoPull(dashboardId, () => daemon.getDashboardJson(dashboardId));
      return jsonResult(body.result);
    })
  );

  server.registerTool(
    'list_pages',
    {
      title: 'List pages',
      description: 'List a dashboard\'s pages as [{id, name}], for resolving a page name to its id.',
      inputSchema: { dashboardId: z.string() },
    },
    handler(async ({ dashboardId }) => {
      const body = await withAutoPull(dashboardId, () => daemon.listPages(dashboardId));
      return jsonResult(body.result);
    })
  );

  server.registerTool(
    'list_tiles',
    {
      title: 'List tiles',
      description:
        'List a dashboard\'s tiles (id, title, visualType, pageId, layout, queryId, hasQuery), optionally filtered to one page. Use to find a tile id without reading full tile bodies.',
      inputSchema: { dashboardId: z.string(), pageId: z.string().optional() },
    },
    handler(async ({ dashboardId, pageId }) => {
      const body = await withAutoPull(dashboardId, () => daemon.listTiles(dashboardId, pageId));
      return jsonResult(body.result);
    })
  );

  server.registerTool(
    'get_tile',
    {
      title: 'Get tile',
      description:
        'Get one full tile plus its resolved query ({text, usedVariables, dataSource}) inlined, so you get the tile and its KQL in a single read.',
      inputSchema: { dashboardId: z.string(), tileId: z.string() },
    },
    handler(async ({ dashboardId, tileId }) => {
      const body = await withAutoPull(dashboardId, () => daemon.getTile(dashboardId, tileId));
      return jsonResult(body.result);
    })
  );

  server.registerTool(
    'get_query',
    {
      title: 'Get query',
      description:
        'Get just the query backing a tile: {queryId, text, usedVariables, dataSource}. usedVariables is the only variable-binding array the dashboard injects.',
      inputSchema: { dashboardId: z.string(), tileId: z.string() },
    },
    handler(async ({ dashboardId, tileId }) => {
      const body = await withAutoPull(dashboardId, () => daemon.getQuery(dashboardId, tileId));
      return jsonResult(body.result);
    })
  );

  server.registerTool(
    'get_parameters',
    {
      title: 'Get parameters',
      description:
        'Get the dashboard\'s full parameter list (kinds, variable names, selection types, defaults, data sources). These variable names are the legal values for a query\'s usedVariables.',
      inputSchema: { dashboardId: z.string() },
    },
    handler(async ({ dashboardId }) => {
      const body = await withAutoPull(dashboardId, () => daemon.getParameters(dashboardId));
      return jsonResult(body.result);
    })
  );

  server.registerTool(
    'get_schema',
    {
      title: 'Get schema',
      description:
        'Fetch the cached ADX dashboard schema. Pass file (e.g. "tile.json", "query.json", "parameter.json", "dashboard.json") to get just that file, or omit file to get the whole { filename: schema } graph. Defaults to schema version 76.',
      inputSchema: {
        file: z.string().optional().describe('Schema file name, e.g. "tile.json". Omit to get the whole graph.'),
        schemaVersion: z.number().int().optional().describe('Schema version. Defaults to 76.'),
      },
    },
    handler(async ({ file, schemaVersion }) => {
      const body = await daemon.getSchema(file, schemaVersion);
      return jsonResult(body);
    })
  );

  server.registerTool(
    'get_schema_for_dashboard',
    {
      title: 'Get schema for dashboard',
      description:
        'Fetch the cached ADX dashboard schema at the version a specific dashboard actually uses. Resolves the dashboard\'s schema_version for you, so you never have to guess or pass a version. Pass file (e.g. "tile.json", "query.json") to get just that file, or omit it to get the whole { filename: schema } graph. Returns { dashboardId, schemaVersion, file, schema }.',
      inputSchema: {
        dashboardId: z.string(),
        file: z.string().optional().describe('Schema file name, e.g. "tile.json". Omit to get the whole graph.'),
      },
    },
    handler(async ({ dashboardId, file }) => {
      const summary = await withAutoPull(dashboardId, () => daemon.summary(dashboardId));
      const schemaVersion = summary.result.schema_version;
      const schema = await daemon.getSchema(file, schemaVersion);
      return jsonResult({ dashboardId, schemaVersion, file: file ?? null, schema });
    })
  );
}
