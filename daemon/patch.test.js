import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Point the schema cache at the repo's committed .cache so validation runs offline and
// deterministically instead of depending on whatever is in the user's home directory.
const here = path.dirname(fileURLToPath(import.meta.url));
process.env.ADX_LIVE_EDIT_HOME = path.resolve(here, '..', '.cache');

const { validateDashboard } = await import('../shared/validate.js');
const patch = await import('./patch.js');

const FIXTURE_PATH = path.join(here, 'fixtures', 'dashboard.json');
const RAW = fs.readFileSync(FIXTURE_PATH, 'utf8');

// Ids baked into daemon/fixtures/dashboard.json.
const ID = {
  pageMain: '11111111-1111-4111-8111-111111111111',
  pageSecond: '22222222-2222-4222-8222-222222222222',
  dataSource: '33333333-3333-4333-8333-333333333333',
  queryChart: '44444444-4444-4444-8444-444444444444',
  queryShared: '55555555-5555-4555-8555-555555555555',
  tileChart: '66666666-6666-4666-8666-666666666666',
  tileMarkdown: '77777777-7777-4777-8777-777777777777',
  tileShared: '88888888-8888-4888-8888-888888888888',
  paramRegion: '99999999-9999-4999-8999-999999999999',
  paramDuration: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
};

function load() {
  return JSON.parse(RAW);
}

async function assertValid(dash) {
  const res = await validateDashboard(dash);
  assert.equal(res.valid, true, `expected valid dashboard, got errors: ${JSON.stringify(res.errors)}`);
}

function patchErrorCode(fn) {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof patch.PatchError, `expected PatchError, got ${e}`);
    return e.code;
  }
  throw new Error('expected the function to throw a PatchError');
}

// ---------------------------------------------------------------------------
// Fixture sanity
// ---------------------------------------------------------------------------

test('fixture validates green against the cached v76 schema', async () => {
  await assertValid(load());
});

// ---------------------------------------------------------------------------
// Read views
// ---------------------------------------------------------------------------

test('dashboardSummary reports pages, tiles, parameters without KQL', () => {
  const summary = patch.dashboardSummary(load());
  assert.equal(summary.schema_version, 76);
  assert.equal(summary.pages.length, 2);
  assert.equal(summary.tiles.length, 3);
  assert.equal(summary.parameters.length, 2);
  for (const t of summary.tiles) {
    assert.ok(!('text' in t), 'tile summary must not leak query text');
    assert.ok(!('markdownText' in t), 'tile summary must not leak markdownText');
  }
});

test('listTiles filters by page', () => {
  const dash = load();
  assert.equal(patch.listTiles(dash, ID.pageMain).length, 2);
  assert.equal(patch.listTiles(dash, ID.pageSecond).length, 1);
  assert.equal(patch.listTiles(dash).length, 3);
});

test('getTile inlines the resolved query for a data tile', () => {
  const { tile, query } = patch.getTile(load(), ID.tileChart);
  assert.equal(tile.id, ID.tileChart);
  assert.ok(query, 'data tile should resolve a query');
  assert.match(query.text, /StormEvents/);
  assert.deepEqual(query.usedVariables, ['region', '_startTime', '_endTime']);
  assert.deepEqual(query.dataSource, { kind: 'inline', dataSourceId: ID.dataSource });
});

test('getTile returns null query for a markdown tile', () => {
  const { query } = patch.getTile(load(), ID.tileMarkdown);
  assert.equal(query, null);
});

test('getQuery throws tile_has_no_query for a markdown tile', () => {
  assert.equal(patchErrorCode(() => patch.getQuery(load(), ID.tileMarkdown)), 'tile_has_no_query');
});

// ---------------------------------------------------------------------------
// setQuery + usedVariables enforcement
// ---------------------------------------------------------------------------

test('setQuery accepts declared variables and stays valid', async () => {
  const dash = load();
  const { result, warnings } = patch.setQuery(dash, {
    tileId: ID.tileChart,
    text: 'StormEvents | where State == region | take 5',
    usedVariables: ['region'],
  });
  assert.equal(result.queryId, ID.queryChart);
  assert.deepEqual(result.usedVariables, ['region']);
  assert.deepEqual(warnings, []);
  await assertValid(dash);
});

test('setQuery rejects an undeclared variable', () => {
  const code = patchErrorCode(() =>
    patch.setQuery(load(), {
      tileId: ID.tileChart,
      text: 'StormEvents | take 1',
      usedVariables: ['region', 'notAParam'],
    }),
  );
  assert.equal(code, 'unknown_variable');
});

test('setQuery warns when a declared var appears in text but is omitted', () => {
  const { warnings } = patch.setQuery(load(), {
    tileId: ID.tileChart,
    text: 'StormEvents | where State == region | take 5',
    usedVariables: [],
  });
  assert.ok(
    warnings.some((w) => w.includes('region')),
    `expected a region warning, got ${JSON.stringify(warnings)}`,
  );
});

test('setQuery rejects non-string text', () => {
  assert.equal(
    patchErrorCode(() => patch.setQuery(load(), { tileId: ID.tileChart, text: 42, usedVariables: [] })),
    'invalid_input',
  );
});

// ---------------------------------------------------------------------------
// setQueryDatasource
// ---------------------------------------------------------------------------

test('setQueryDatasource rejects an unknown dataSource id', () => {
  assert.equal(
    patchErrorCode(() => patch.setQueryDatasource(load(), { tileId: ID.tileChart, dataSourceId: 'nope' })),
    'datasource_not_found',
  );
});

test('setQueryDatasource sets an inline reference', () => {
  const dash = load();
  const { result } = patch.setQueryDatasource(dash, { tileId: ID.tileChart, dataSourceId: ID.dataSource });
  assert.deepEqual(result.dataSource, { kind: 'inline', dataSourceId: ID.dataSource });
});

// ---------------------------------------------------------------------------
// setTile
// ---------------------------------------------------------------------------

test('setTile updates title and stays valid', async () => {
  const dash = load();
  const { result } = patch.setTile(dash, { tileId: ID.tileChart, patch: { title: 'Renamed' } });
  assert.equal(result.tile.title, 'Renamed');
  await assertValid(dash);
});

test('setTile rejects markdownText on a non-markdown tile', () => {
  assert.equal(
    patchErrorCode(() => patch.setTile(load(), { tileId: ID.tileChart, patch: { markdownText: 'hi' } })),
    'not_markdown',
  );
});

test('setTile accepts markdownText on a markdown tile and stays valid', async () => {
  const dash = load();
  patch.setTile(dash, { tileId: ID.tileMarkdown, patch: { markdownText: '## Updated' } });
  const tile = dash.tiles.find((t) => t.id === ID.tileMarkdown);
  assert.equal(tile.markdownText, '## Updated');
  await assertValid(dash);
});

test('setTile refuses to turn a data tile into markdownCard', () => {
  assert.equal(
    patchErrorCode(() => patch.setTile(load(), { tileId: ID.tileChart, patch: { visualType: 'markdownCard' } })),
    'markdown_has_query',
  );
});

test('setTile rejects an out-of-bounds layout', () => {
  assert.equal(
    patchErrorCode(() => patch.setTile(load(), { tileId: ID.tileChart, patch: { layout: { width: 1 } } })),
    'invalid_layout',
  );
});

// ---------------------------------------------------------------------------
// setLayout
// ---------------------------------------------------------------------------

test('setLayout merges a partial update and stays valid', async () => {
  const dash = load();
  const { result } = patch.setLayout(dash, { tileId: ID.tileChart, layout: { x: 2, y: 3 } });
  assert.equal(result.layout.x, 2);
  assert.equal(result.layout.y, 3);
  assert.equal(result.layout.width, 6);
  await assertValid(dash);
});

test('setLayout requires at least one dimension', () => {
  assert.equal(
    patchErrorCode(() => patch.setLayout(load(), { tileId: ID.tileChart, layout: {} })),
    'invalid_input',
  );
});

// ---------------------------------------------------------------------------
// addTile
// ---------------------------------------------------------------------------

test('addTile creates a data tile with a backing query and stays valid', async () => {
  const dash = load();
  const { result } = patch.addTile(dash, {
    pageId: ID.pageMain,
    visualType: 'table',
    title: 'New table',
    layout: { x: 0, y: 12, width: 4, height: 3 },
    query: { text: 'StormEvents | take 1', usedVariables: ['region'], dataSourceId: ID.dataSource },
  });
  assert.ok(result.tileId);
  assert.ok(result.queryId);
  const tile = dash.tiles.find((t) => t.id === result.tileId);
  assert.deepEqual(tile.queryRef, { kind: 'query', queryId: result.queryId });
  await assertValid(dash);
});

test('addTile requires query.text for a data tile', () => {
  assert.equal(
    patchErrorCode(() =>
      patch.addTile(load(), {
        pageId: ID.pageMain,
        visualType: 'table',
        title: 'No query',
        layout: { x: 0, y: 12, width: 4, height: 3 },
      }),
    ),
    'invalid_input',
  );
});

test('addTile rejects an undeclared usedVariable', () => {
  assert.equal(
    patchErrorCode(() =>
      patch.addTile(load(), {
        pageId: ID.pageMain,
        visualType: 'table',
        title: 'Bad var',
        layout: { x: 0, y: 12, width: 4, height: 3 },
        query: { text: 'StormEvents | take 1', usedVariables: ['ghost'] },
      }),
    ),
    'unknown_variable',
  );
});

test('addTile creates a markdown tile with markdownText and no queryRef', async () => {
  const dash = load();
  const { result } = patch.addTile(dash, {
    pageId: ID.pageMain,
    visualType: 'markdownCard',
    title: 'Note',
    layout: { x: 0, y: 12, width: 4, height: 2 },
    markdownText: '## Hi',
  });
  assert.ok(result.tileId);
  assert.equal(result.queryId, undefined);
  const tile = dash.tiles.find((t) => t.id === result.tileId);
  assert.equal(tile.markdownText, '## Hi');
  assert.ok(!('queryRef' in tile), 'markdown tile must not have a queryRef');
  await assertValid(dash);
});

test('addTile rejects a query on a markdown tile', () => {
  assert.equal(
    patchErrorCode(() =>
      patch.addTile(load(), {
        pageId: ID.pageMain,
        visualType: 'markdownCard',
        title: 'Bad',
        layout: { x: 0, y: 12, width: 4, height: 2 },
        query: { text: 'x', usedVariables: [] },
      }),
    ),
    'markdown_has_query',
  );
});

test('addTile defaults markdownText to an empty string and stays valid', async () => {
  const dash = load();
  const { result } = patch.addTile(dash, {
    pageId: ID.pageMain,
    visualType: 'markdownCard',
    title: 'Empty note',
    layout: { x: 4, y: 12, width: 4, height: 2 },
  });
  const tile = dash.tiles.find((t) => t.id === result.tileId);
  assert.equal(tile.markdownText, '');
  await assertValid(dash);
});

// ---------------------------------------------------------------------------
// removeTile (GC vs keep)
// ---------------------------------------------------------------------------

test('removeTile garbage-collects a single-referenced query', async () => {
  const dash = load();
  const { result } = patch.removeTile(dash, { tileId: ID.tileChart });
  assert.equal(result.removed, true);
  assert.equal(result.removedQueryId, ID.queryChart);
  assert.ok(!dash.queries.some((q) => q.id === ID.queryChart), 'orphaned query should be removed');
  await assertValid(dash);
});

test('removeTile keeps a query that another tile still references', async () => {
  const dash = load();
  // Point the shared tile at the chart's query so two tiles reference it.
  dash.tiles.find((t) => t.id === ID.tileShared).queryRef = { kind: 'query', queryId: ID.queryChart };
  const { result } = patch.removeTile(dash, { tileId: ID.tileChart });
  assert.equal(result.removedQueryId, undefined);
  assert.ok(dash.queries.some((q) => q.id === ID.queryChart), 'shared query must survive');
});

test('removeTile on a markdown tile removes nothing extra', async () => {
  const dash = load();
  const { result } = patch.removeTile(dash, { tileId: ID.tileMarkdown });
  assert.equal(result.removed, true);
  assert.equal(result.removedQueryId, undefined);
  await assertValid(dash);
});

// ---------------------------------------------------------------------------
// Parameters
// ---------------------------------------------------------------------------

test('addParameter generates an id and stays valid', async () => {
  const dash = load();
  const { result } = patch.addParameter(dash, {
    parameter: {
      displayName: 'State',
      description: 'Another free text filter',
      kind: 'string',
      variableName: 'stateName',
      selectionType: 'freetext',
      defaultValue: { kind: 'value', value: 'OHIO' },
    },
  });
  assert.ok(result.parameterId);
  await assertValid(dash);
});

test('setParameter warns when a renamed variable is still used by a query', () => {
  const { warnings } = patch.setParameter(load(), {
    parameterId: ID.paramRegion,
    patch: { variableName: 'regionRenamed' },
  });
  assert.ok(
    warnings.some((w) => w.includes('region')),
    `expected a dangling-variable warning, got ${JSON.stringify(warnings)}`,
  );
});

test('removeParameter warns about queries still listing its variable', () => {
  const { warnings } = patch.removeParameter(load(), { parameterId: ID.paramRegion });
  assert.ok(warnings.length > 0, 'expected at least one warning for the removed variable');
});

// ---------------------------------------------------------------------------
// renamePage
// ---------------------------------------------------------------------------

test('renamePage updates the page name and stays valid', async () => {
  const dash = load();
  patch.renamePage(dash, { pageId: ID.pageMain, name: 'Home' });
  assert.equal(dash.pages.find((p) => p.id === ID.pageMain).name, 'Home');
  await assertValid(dash);
});

test('renamePage rejects an empty name', () => {
  assert.equal(
    patchErrorCode(() => patch.renamePage(load(), { pageId: ID.pageMain, name: '   ' })),
    'invalid_input',
  );
});
