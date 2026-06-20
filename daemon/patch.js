/*
 * Pure, element-level operations on a dashboard's working copy.
 *
 * Everything here mutates the dashboard object in place (or just reads it) and either
 * returns a typed result or throws a PatchError. Nothing here does disk or network IO and
 * nothing calls schema validation. The daemon is responsible for loading the working copy,
 * calling one of these, then running full schema validation before it writes the result
 * back. That split keeps this file trivially unit-testable against a fixture.
 *
 * The whole point of these functions is to hide the normalized JSON: a tile has no KQL, it
 * points at a queries[] entry via queryRef, and that query points at a dataSources[] entry.
 * Callers pass a friendly tileId and we walk the refs for them so the agent never has to.
 */

import crypto from 'node:crypto';

// Typed error so the daemon can map a friendly code to an HTTP status and message instead
// of leaking a generic 500. code is a short machine string; message is human-facing.
export class PatchError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'PatchError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

// ---------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------

function findTile(dash, tileId) {
  const tile = (dash.tiles || []).find((t) => t.id === tileId);
  if (!tile) throw new PatchError('tile_not_found', `No tile with id ${tileId}`);
  return tile;
}

function findPage(dash, pageId) {
  const page = (dash.pages || []).find((p) => p.id === pageId);
  if (!page) throw new PatchError('page_not_found', `No page with id ${pageId}`);
  return page;
}

function findParameter(dash, parameterId) {
  const param = (dash.parameters || []).find((p) => p.id === parameterId);
  if (!param) throw new PatchError('parameter_not_found', `No parameter with id ${parameterId}`);
  return param;
}

function findQueryById(dash, queryId) {
  return (dash.queries || []).find((q) => q.id === queryId);
}

// Every variable name a query is allowed to list in usedVariables. Duration parameters
// declare a begin/end pair instead of a single variableName, so union all three.
export function paramVariableNames(param) {
  const names = [];
  if (param.variableName) names.push(param.variableName);
  if (param.beginVariableName) names.push(param.beginVariableName);
  if (param.endVariableName) names.push(param.endVariableName);
  return names;
}

export function declaredVariableNames(dash) {
  const names = new Set();
  for (const param of dash.parameters || []) {
    for (const name of paramVariableNames(param)) names.add(name);
  }
  return names;
}

// Resolve a tile to its editable query. Returns { tile, query } where query is the
// queries[] entry. Throws with guidance for the cases the agent should not silently hit:
// markdown tiles (no query) and tiles backed by a shared base query (not editable in v1).
export function resolveTileQuery(dash, tileId) {
  const tile = findTile(dash, tileId);
  const ref = tile.queryRef;
  if (!ref) {
    throw new PatchError('tile_has_no_query', `Tile ${tileId} has no query (visualType ${tile.visualType}).`);
  }
  if (ref.kind === 'baseQuery') {
    throw new PatchError(
      'query_is_base',
      `Tile ${tileId} uses a shared base query; editing base queries is not supported in v1.`,
    );
  }
  const query = findQueryById(dash, ref.queryId);
  if (!query) {
    throw new PatchError('query_not_found', `Tile ${tileId} references missing query ${ref.queryId}.`);
  }
  return { tile, query };
}

// ---------------------------------------------------------------------------
// usedVariables: validate (hard) and lint (warn). Never derive from text.
// ---------------------------------------------------------------------------

function assertStringArray(value, field) {
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
    throw new PatchError('invalid_input', `${field} must be an array of strings`);
  }
}

// Reject any usedVariable that is not a declared parameter variable. This is the invariant
// that bit the session: the engine only injects variables the query lists AND that exist.
export function validateUsedVariables(dash, usedVariables) {
  assertStringArray(usedVariables, 'usedVariables');
  const declared = declaredVariableNames(dash);
  const unknown = usedVariables.filter((v) => !declared.has(v));
  if (unknown.length > 0) {
    throw new PatchError(
      'unknown_variable',
      `usedVariables contains names that are not declared dashboard parameters: ${unknown.join(', ')}. ` +
        `Declared variables: ${[...declared].join(', ') || '(none)'}.`,
      { unknown, declared: [...declared] },
    );
  }
}

function tokenRegexFor(name) {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Variable names can contain spaces/dots/dashes, so a plain \b will not do. Require the
  // name to not be flanked by another identifier char.
  return new RegExp(`(^|[^a-zA-Z0-9_])${esc}([^a-zA-Z0-9_]|$)`);
}

// Warn (do not block) when a declared variable looks used in the text but was left out of
// usedVariables. Warning-only because column names and let-bindings can collide with a
// parameter name and produce false positives.
export function lintUsedVariables(dash, text, usedVariables) {
  const warnings = [];
  const listed = new Set(usedVariables);
  const body = String(text || '');
  for (const param of dash.parameters || []) {
    for (const name of paramVariableNames(param)) {
      if (listed.has(name)) continue;
      if (tokenRegexFor(name).test(body)) {
        warnings.push(`possible missing usedVariable: ${name}`);
      }
    }
  }
  return warnings;
}

// ---------------------------------------------------------------------------
// Read views (pure; no KQL/visualOptions in summaries)
// ---------------------------------------------------------------------------

function tileQueryId(tile) {
  return tile.queryRef && tile.queryRef.kind === 'query' ? tile.queryRef.queryId : null;
}

function tileSummary(tile) {
  return {
    id: tile.id,
    title: tile.title,
    visualType: tile.visualType,
    pageId: tile.pageId,
    layout: tile.layout,
    queryId: tileQueryId(tile),
    hasQuery: Boolean(tile.queryRef),
  };
}

function parameterSummary(param) {
  return {
    id: param.id,
    displayName: param.displayName,
    kind: param.kind,
    variableNames: paramVariableNames(param),
    selectionType: param.selectionType,
  };
}

export function listPages(dash) {
  return (dash.pages || []).map((p) => ({ id: p.id, name: p.name }));
}

export function listTiles(dash, pageId) {
  let tiles = dash.tiles || [];
  if (pageId) tiles = tiles.filter((t) => t.pageId === pageId);
  return tiles.map(tileSummary);
}

export function getParameters(dash) {
  return (dash.parameters || []).map(parameterSummary);
}

export function dashboardSummary(dash) {
  return {
    schema_version: dash.schema_version,
    pages: listPages(dash),
    tiles: listTiles(dash),
    parameters: getParameters(dash),
  };
}

// Inline the resolved query so the agent gets tile + KQL in one read. Returns query: null
// for tiles that have none (markdown). Base-query-backed tiles report the ref but no text.
export function getTile(dash, tileId) {
  const tile = findTile(dash, tileId);
  let query = null;
  if (tile.queryRef && tile.queryRef.kind === 'query') {
    const q = findQueryById(dash, tile.queryRef.queryId);
    if (q) query = { queryId: q.id, text: q.text, usedVariables: q.usedVariables, dataSource: q.dataSource || null };
  } else if (tile.queryRef && tile.queryRef.kind === 'baseQuery') {
    query = { baseQueryId: tile.queryRef.baseQueryId, kind: 'baseQuery' };
  }
  return { tile, query };
}

export function getQuery(dash, tileId) {
  const { query } = resolveTileQuery(dash, tileId);
  return { queryId: query.id, text: query.text, usedVariables: query.usedVariables, dataSource: query.dataSource || null };
}

// ---------------------------------------------------------------------------
// Mutators (mutate dash in place; daemon validates the result afterward)
// ---------------------------------------------------------------------------

export function setQuery(dash, { tileId, text, usedVariables }) {
  if (typeof text !== 'string') throw new PatchError('invalid_input', 'text must be a string');
  validateUsedVariables(dash, usedVariables);
  const { query } = resolveTileQuery(dash, tileId);
  query.text = text;
  query.usedVariables = [...usedVariables];
  const warnings = lintUsedVariables(dash, text, usedVariables);
  return { result: { queryId: query.id, usedVariables: query.usedVariables }, warnings };
}

export function setQueryDatasource(dash, { tileId, dataSourceId }) {
  const { query } = resolveTileQuery(dash, tileId);
  const exists = (dash.dataSources || []).some((d) => d.id === dataSourceId);
  if (!exists) throw new PatchError('datasource_not_found', `No dataSource with id ${dataSourceId}`);
  query.dataSource = { kind: 'inline', dataSourceId };
  return { result: { queryId: query.id, dataSource: query.dataSource } };
}

const TILE_PATCH_FIELDS = ['title', 'hideTitle', 'description', 'layout', 'visualType', 'visualOptions', 'markdownText'];

export function setTile(dash, { tileId, patch }) {
  const tile = findTile(dash, tileId);
  if (!patch || typeof patch !== 'object') throw new PatchError('invalid_input', 'patch object is required');

  if (patch.layout !== undefined) validateLayout({ ...tile.layout, ...patch.layout });

  // markdownText is only a valid property on markdownCard tiles (schema unevaluatedProperties).
  // visualType cannot cross the markdown boundary via setTile (the query-presence guards below
  // block both directions), so checking the current visualType is sufficient.
  if (patch.markdownText !== undefined && tile.visualType !== 'markdownCard') {
    throw new PatchError(
      'not_markdown',
      `markdownText only applies to markdownCard tiles; tile ${tileId} is ${tile.visualType}.`,
    );
  }

  if (patch.visualType !== undefined && patch.visualType !== tile.visualType) {
    const toMarkdown = patch.visualType === 'markdownCard';
    if (toMarkdown && tile.queryRef) {
      throw new PatchError(
        'markdown_has_query',
        `Cannot change tile ${tileId} to markdownCard while it has a query. Use remove_tile + add_tile instead.`,
      );
    }
    if (!toMarkdown && !tile.queryRef) {
      throw new PatchError(
        'visual_needs_query',
        `Changing tile ${tileId} from markdownCard to ${patch.visualType} needs a backing query. Recreate it with add_tile.`,
      );
    }
  }

  for (const field of TILE_PATCH_FIELDS) {
    if (patch[field] === undefined) continue;
    if (field === 'layout') {
      tile.layout = { ...tile.layout, ...patch.layout };
    } else {
      tile[field] = patch[field];
    }
  }
  return { result: { tile: tileSummary(tile) } };
}

function validateLayout(layout) {
  const { x, y, width, height } = layout;
  if ([x, y, width, height].some((n) => typeof n !== 'number' || !Number.isFinite(n))) {
    throw new PatchError('invalid_layout', 'layout x, y, width, height must all be numbers');
  }
  if (x < 0 || y < 0) throw new PatchError('invalid_layout', 'layout x and y must be >= 0');
  if (width < 2) throw new PatchError('invalid_layout', 'layout width must be >= 2');
  if (height < 1) throw new PatchError('invalid_layout', 'layout height must be >= 1');
}

export function setLayout(dash, { tileId, layout }) {
  const tile = findTile(dash, tileId);
  if (!layout || typeof layout !== 'object') throw new PatchError('invalid_input', 'layout object is required');
  const allowed = ['x', 'y', 'width', 'height'];
  const provided = allowed.filter((k) => layout[k] !== undefined);
  if (provided.length === 0) {
    throw new PatchError('invalid_input', 'provide at least one of x, y, width, height');
  }
  const merged = { ...tile.layout };
  for (const k of provided) merged[k] = layout[k];
  validateLayout(merged);
  tile.layout = merged;
  return { result: { tileId, layout: tile.layout } };
}

export function addTile(dash, { pageId, visualType, title, layout, query, visualOptions, markdownText }) {
  findPage(dash, pageId);
  if (!visualType) throw new PatchError('invalid_input', 'visualType is required');
  if (typeof title !== 'string') throw new PatchError('invalid_input', 'title is required');
  validateLayout(layout || {});

  const isMarkdown = visualType === 'markdownCard';
  const tileId = crypto.randomUUID();
  const tile = {
    id: tileId,
    title,
    layout,
    pageId,
    visualType,
    visualOptions: visualOptions || {},
  };

  let queryId;
  let warnings = [];
  if (isMarkdown) {
    if (query) throw new PatchError('markdown_has_query', 'markdownCard tiles cannot have a query');
    // markdownText is a required property on markdownCard tiles. Empty string is schema-valid.
    tile.markdownText = typeof markdownText === 'string' ? markdownText : '';
  } else {
    if (!query || typeof query.text !== 'string') {
      throw new PatchError('invalid_input', `visualType ${visualType} requires query.text`);
    }
    validateUsedVariables(dash, query.usedVariables || []);
    queryId = crypto.randomUUID();
    const queryEntry = { id: queryId, text: query.text, usedVariables: [...(query.usedVariables || [])] };
    if (query.dataSourceId) queryEntry.dataSource = { kind: 'inline', dataSourceId: query.dataSourceId };
    (dash.queries = dash.queries || []).push(queryEntry);
    tile.queryRef = { kind: 'query', queryId };
    warnings = lintUsedVariables(dash, query.text, query.usedVariables || []);
  }

  (dash.tiles = dash.tiles || []).push(tile);
  return { result: { tileId, queryId }, warnings };
}

// True if anything other than the tile being removed still points at this query.
function queryStillReferenced(dash, queryId, excludeTileId) {
  const tileRef = (dash.tiles || []).some(
    (t) => t.id !== excludeTileId && t.queryRef && t.queryRef.kind === 'query' && t.queryRef.queryId === queryId,
  );
  if (tileRef) return true;
  return (dash.parameters || []).some(
    (p) => p.queryRef && p.queryRef.kind === 'query' && p.queryRef.queryId === queryId,
  );
}

export function removeTile(dash, { tileId }) {
  const tile = findTile(dash, tileId);
  const queryId = tile.queryRef && tile.queryRef.kind === 'query' ? tile.queryRef.queryId : null;
  dash.tiles = (dash.tiles || []).filter((t) => t.id !== tileId);

  let removedQueryId;
  if (queryId && !queryStillReferenced(dash, queryId, tileId)) {
    dash.queries = (dash.queries || []).filter((q) => q.id !== queryId);
    removedQueryId = queryId;
  }
  return { result: { removed: true, removedQueryId } };
}

export function renamePage(dash, { pageId, name }) {
  if (typeof name !== 'string' || name.trim() === '') {
    throw new PatchError('invalid_input', 'name is required');
  }
  const page = findPage(dash, pageId);
  page.name = name;
  return { result: { pageId, name } };
}

const PARAMETER_MUTABLE_FIELDS = [
  'displayName',
  'variableName',
  'beginVariableName',
  'endVariableName',
  'selectionType',
  'kind',
  'defaultValue',
  'includeAllOption',
  'dataSource',
  'queryRef',
  'values',
];

// Warn about queries that still list any of the given variable names. Used both when a
// parameter's variable is renamed and when a parameter is removed, so a dangling
// usedVariables reference never goes unnoticed.
function queriesUsingVariables(dash, names) {
  const set = new Set(names);
  const hits = [];
  for (const q of dash.queries || []) {
    const used = (q.usedVariables || []).filter((v) => set.has(v));
    if (used.length > 0) hits.push({ queryId: q.id, variables: used });
  }
  return hits;
}

export function setParameter(dash, { parameterId, patch }) {
  const param = findParameter(dash, parameterId);
  if (!patch || typeof patch !== 'object') throw new PatchError('invalid_input', 'patch object is required');

  const oldNames = paramVariableNames(param);
  for (const field of PARAMETER_MUTABLE_FIELDS) {
    if (patch[field] !== undefined) param[field] = patch[field];
  }
  const newNames = paramVariableNames(param);

  // If a variable name changed, queries still listing the old name will break at runtime.
  const removedNames = oldNames.filter((n) => !newNames.includes(n));
  const warnings = [];
  if (removedNames.length > 0) {
    for (const hit of queriesUsingVariables(dash, removedNames)) {
      warnings.push(`query ${hit.queryId} still lists renamed/removed variable(s): ${hit.variables.join(', ')}`);
    }
  }
  return { result: { parameter: parameterSummary(param) }, warnings };
}

export function addParameter(dash, { parameter }) {
  if (!parameter || typeof parameter !== 'object') throw new PatchError('invalid_input', 'parameter object is required');
  const param = { ...parameter };
  if (!param.id) param.id = crypto.randomUUID();
  if (findQueryById(dash, param.id)) {
    throw new PatchError('invalid_input', `id ${param.id} collides with an existing query id`);
  }
  if ((dash.parameters || []).some((p) => p.id === param.id)) {
    throw new PatchError('invalid_input', `parameter id ${param.id} already exists`);
  }
  (dash.parameters = dash.parameters || []).push(param);
  return { result: { parameterId: param.id } };
}

export function removeParameter(dash, { parameterId }) {
  const param = findParameter(dash, parameterId);
  const names = paramVariableNames(param);
  dash.parameters = (dash.parameters || []).filter((p) => p.id !== parameterId);

  const warnings = [];
  for (const hit of queriesUsingVariables(dash, names)) {
    warnings.push(`query ${hit.queryId} still lists variable(s) from the removed parameter: ${hit.variables.join(', ')}`);
  }
  return { result: { removed: true }, warnings };
}
