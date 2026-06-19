// Typed write tools. Each maps to one daemon STORE_WRITE_ROUTE and mutates the
// dashboard's working copy. The agent passes friendly flat fields (a tileId, a
// queryText, layout numbers); we assemble the nested body the daemon expects so
// the agent never builds normalized JSON by hand. The daemon validates every
// write against the schema and enforces the usedVariables invariant, so these
// tools stay thin: shape the input, call the route, surface result + warnings.

import { z } from 'zod';
import { daemon } from '../daemon-client.js';
import { handler, withAutoPull, jsonResult } from './common.js';
import { parameterKind, selectionType, visualType } from '../schema-shapes.js';

// Surface the daemon's typed result plus any non-fatal lint warnings (e.g. a
// declared parameter the query no longer references). Warnings never block.
function writeResult(body) {
  const out = body && body.result !== undefined ? { result: body.result } : { result: body };
  if (body && Array.isArray(body.warnings) && body.warnings.length) out.warnings = body.warnings;
  return jsonResult(out);
}

// Drop undefined keys so the daemon only sees fields the agent actually set.
function compact(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}

const layoutObject = (required) => {
  const num = (desc) => (required ? z.number().describe(desc) : z.number().describe(desc).optional());
  return z.object({
    x: num('Grid column (>= 0).'),
    y: num('Grid row (>= 0).'),
    width: num('Width in grid columns (>= 2).'),
    height: num('Height in grid rows (>= 1).'),
  });
};

export function registerWriteTools(server) {
  server.registerTool(
    'set_query',
    {
      title: 'Set query',
      description:
        'Replace the KQL text of the query backing a tile. usedVariables is REQUIRED and must list every dashboard parameter variable the query references: the dashboard only injects the parameter variables you list here, and listing one the dashboard does not declare is rejected. Do not guess from the text; read get_parameters and pass exactly the variables the query uses (they do not have to start with "_").',
      inputSchema: {
        dashboardId: z.string(),
        tileId: z.string(),
        queryText: z.string().describe('The full KQL query text.'),
        usedVariables: z
          .array(z.string())
          .describe('Dashboard parameter variable names this query references. The only variables the dashboard will inject.'),
      },
    },
    handler(async ({ dashboardId, tileId, queryText, usedVariables }) => {
      const body = await withAutoPull(dashboardId, () =>
        daemon.patch(dashboardId, 'set-query', { tileId, text: queryText, usedVariables })
      );
      return writeResult(body);
    })
  );

  server.registerTool(
    'set_query_datasource',
    {
      title: 'Set query datasource',
      description:
        "Point a tile's query at one of the dashboard's existing data sources by id. Use get_dashboard_summary / get_parameters to find valid dataSource ids.",
      inputSchema: {
        dashboardId: z.string(),
        tileId: z.string(),
        dataSourceId: z.string(),
      },
    },
    handler(async ({ dashboardId, tileId, dataSourceId }) => {
      const body = await withAutoPull(dashboardId, () =>
        daemon.patch(dashboardId, 'set-query-datasource', { tileId, dataSourceId })
      );
      return writeResult(body);
    })
  );

  server.registerTool(
    'set_tile',
    {
      title: 'Set tile',
      description:
        'Update presentation fields on a tile. Only the fields you pass change. markdownText only applies to markdownCard tiles; visualType cannot move a tile across the markdown/visual boundary. To change KQL use set_query; to change position use set_layout.',
      inputSchema: {
        dashboardId: z.string(),
        tileId: z.string(),
        title: z.string().optional(),
        hideTitle: z.boolean().optional(),
        description: z.string().optional(),
        layout: layoutObject(false).partial().optional().describe('Partial layout; only the fields you pass are merged.'),
        visualType: visualType().optional(),
        visualOptions: z.object({}).passthrough().optional().describe('Visual-specific options blob; passed through to the schema as-is.'),
        markdownText: z.string().optional().describe('Markdown body. markdownCard tiles only.'),
      },
    },
    handler(async ({ dashboardId, tileId, ...rest }) => {
      const patch = compact(rest);
      const body = await withAutoPull(dashboardId, () =>
        daemon.patch(dashboardId, 'set-tile', { tileId, patch })
      );
      return writeResult(body);
    })
  );

  server.registerTool(
    'set_layout',
    {
      title: 'Set layout',
      description:
        "Move or resize a tile on the grid. Pass at least one of x, y, width, height. Bounds: x >= 0, y >= 0, width >= 2, height >= 1.",
      inputSchema: {
        dashboardId: z.string(),
        tileId: z.string(),
        x: z.number().optional().describe('Grid column (>= 0).'),
        y: z.number().optional().describe('Grid row (>= 0).'),
        width: z.number().optional().describe('Width in grid columns (>= 2).'),
        height: z.number().optional().describe('Height in grid rows (>= 1).'),
      },
    },
    handler(async ({ dashboardId, tileId, x, y, width, height }) => {
      const layout = compact({ x, y, width, height });
      const body = await withAutoPull(dashboardId, () =>
        daemon.patch(dashboardId, 'set-layout', { tileId, layout })
      );
      return writeResult(body);
    })
  );

  server.registerTool(
    'add_tile',
    {
      title: 'Add tile',
      description:
        'Add a tile to a page. For a visual tile pass queryText (and its usedVariables); the same injection rule as set_query applies. For a text tile pass visualType "markdownCard" and markdownText, with no query. layout is required.',
      inputSchema: {
        dashboardId: z.string(),
        pageId: z.string(),
        visualType: visualType(),
        title: z.string(),
        layout: layoutObject(true).describe('Required grid placement: x, y, width (>= 2), height (>= 1).'),
        queryText: z.string().optional().describe('KQL for a visual tile. Omit for a markdownCard tile.'),
        usedVariables: z
          .array(z.string())
          .optional()
          .describe('Parameter variables the query references. Required when queryText is set if the query uses any parameters.'),
        dataSourceId: z.string().optional().describe('Existing dataSource id to bind the new query to.'),
        visualOptions: z.object({}).passthrough().optional(),
        markdownText: z.string().optional().describe('Body for a markdownCard tile.'),
      },
    },
    handler(async ({ dashboardId, pageId, visualType: vt, title, layout, queryText, usedVariables, dataSourceId, visualOptions, markdownText }) => {
      const body = compact({
        pageId,
        visualType: vt,
        title,
        layout,
        visualOptions,
        markdownText,
      });
      if (queryText !== undefined) {
        body.query = compact({ text: queryText, usedVariables, dataSourceId });
      }
      const result = await withAutoPull(dashboardId, () => daemon.patch(dashboardId, 'add-tile', body));
      return writeResult(result);
    })
  );

  server.registerTool(
    'remove_tile',
    {
      title: 'Remove tile',
      description:
        "Remove a tile. Its backing query is garbage-collected if no other tile or parameter still references it.",
      inputSchema: { dashboardId: z.string(), tileId: z.string() },
    },
    handler(async ({ dashboardId, tileId }) => {
      const body = await withAutoPull(dashboardId, () => daemon.patch(dashboardId, 'remove-tile', { tileId }));
      return writeResult(body);
    })
  );

  server.registerTool(
    'set_parameter',
    {
      title: 'Set parameter',
      description:
        'Update a dashboard parameter. Only the fields you pass change. Renaming a variable (variableName / beginVariableName / endVariableName) warns if a query still lists the old name in its usedVariables; fix those queries with set_query.',
      inputSchema: {
        dashboardId: z.string(),
        parameterId: z.string(),
        displayName: z.string().optional(),
        variableName: z.string().optional(),
        beginVariableName: z.string().optional().describe('Start variable for a duration/range parameter.'),
        endVariableName: z.string().optional().describe('End variable for a duration/range parameter.'),
        selectionType: selectionType().optional(),
        kind: parameterKind().optional(),
        defaultValue: z.any().optional().describe('Default value object; shape depends on kind/selectionType.'),
        includeAllOption: z.boolean().optional(),
        dataSource: z.any().optional().describe('Data source binding for a query-backed parameter.'),
        queryRef: z.any().optional(),
        values: z.any().optional().describe('Static value list for a manual parameter.'),
      },
    },
    handler(async ({ dashboardId, parameterId, ...rest }) => {
      const patch = compact(rest);
      const body = await withAutoPull(dashboardId, () =>
        daemon.patch(dashboardId, 'set-parameter', { parameterId, patch })
      );
      return writeResult(body);
    })
  );

  server.registerTool(
    'add_parameter',
    {
      title: 'Add parameter',
      description:
        'Add a dashboard parameter. Pass the parameter object (kind, displayName, variableName, selectionType, defaultValue, etc.); the id is generated. Read get_parameters first to match the shape of existing parameters.',
      inputSchema: {
        dashboardId: z.string(),
        parameter: z
          .object({
            displayName: z.string().optional(),
            variableName: z.string().optional(),
            beginVariableName: z.string().optional(),
            endVariableName: z.string().optional(),
            kind: parameterKind().optional(),
            selectionType: selectionType().optional(),
            defaultValue: z.any().optional(),
            includeAllOption: z.boolean().optional(),
            dataSource: z.any().optional(),
            queryRef: z.any().optional(),
            values: z.any().optional(),
          })
          .passthrough()
          .describe('The new parameter object. id is assigned by the daemon.'),
      },
    },
    handler(async ({ dashboardId, parameter }) => {
      const body = await withAutoPull(dashboardId, () => daemon.patch(dashboardId, 'add-parameter', { parameter }));
      return writeResult(body);
    })
  );

  server.registerTool(
    'remove_parameter',
    {
      title: 'Remove parameter',
      description:
        "Remove a dashboard parameter. Warns if any query still lists the parameter's variable in usedVariables; fix those queries with set_query.",
      inputSchema: { dashboardId: z.string(), parameterId: z.string() },
    },
    handler(async ({ dashboardId, parameterId }) => {
      const body = await withAutoPull(dashboardId, () =>
        daemon.patch(dashboardId, 'remove-parameter', { parameterId })
      );
      return writeResult(body);
    })
  );

  server.registerTool(
    'rename_page',
    {
      title: 'Rename page',
      description: 'Rename a dashboard page. name must be non-empty.',
      inputSchema: { dashboardId: z.string(), pageId: z.string(), name: z.string() },
    },
    handler(async ({ dashboardId, pageId, name }) => {
      const body = await withAutoPull(dashboardId, () => daemon.patch(dashboardId, 'rename-page', { pageId, name }));
      return writeResult(body);
    })
  );
}
