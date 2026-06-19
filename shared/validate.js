#!/usr/bin/env node

/*
 * Validate an ADX dashboard JSON object against the official ADX dashboard schema.
 *
 * Migrated from the adx-dashboard-authoring skill (scripts/validate.js) and converted
 * from CommonJS to ESM. Validation behavior is intentionally identical to the original.
 * The one change from the migration baseline is the cache location: the schema graph now
 * lands under a stable home directory (cacheRoot) instead of the repo root, so it survives
 * across npx runs where the cwd is a throwaway temp dir.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// ajv and ajv-formats are CommonJS. Node's interop exposes the class/function as the
// default export, but guard for the {default} shape so this keeps working if the
// package's module shape changes.
import _Ajv2020 from 'ajv/dist/2020.js';
import _addFormats from 'ajv-formats';

const Ajv2020 = _Ajv2020.default ?? _Ajv2020;
const addFormats = _addFormats.default ?? _addFormats;

// Dashboards that omit schema_version are assumed to target the current ADX schema.
const DEFAULT_SCHEMA_VERSION = 76;
const SCHEMA_HOST = 'https://dataexplorer.azure.com';

// The cache lives under a stable home dir so it survives across npx runs, where the
// cwd is a throwaway temp dir. ADX_LIVE_EDIT_HOME lets tests and CI redirect it.
function cacheRoot() {
  return process.env.ADX_LIVE_EDIT_HOME || path.join(os.homedir(), '.adx-live-edit-mcp');
}

function cacheDirFor(version) {
  return path.join(cacheRoot(), 'schema', String(version));
}

function resolveSchemaVersion(dashboard) {
  const raw = dashboard && dashboard.schema_version;
  if (raw === undefined || raw === null) return DEFAULT_SCHEMA_VERSION;
  const n = parseInt(String(raw), 10);
  return Number.isNaN(n) ? DEFAULT_SCHEMA_VERSION : n;
}

// Fetch one schema file, using the on-disk cache when present. Returns raw text so
// callers can both parse it and scan it for cross-file $refs.
async function getSchemaFileText(version, filename) {
  const dir = cacheDirFor(version);
  const cachePath = path.join(dir, filename);
  if (fs.existsSync(cachePath)) {
    return fs.readFileSync(cachePath, 'utf8');
  }
  const url = `${SCHEMA_HOST}/static/d/schema/${version}/${filename}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to fetch schema ${filename} (HTTP ${res.status})`);
  }
  const text = await res.text();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(cachePath, text);
  return text;
}

function findFileRefs(schemaText, selfName) {
  // Cross-file refs look like "tile.json#/properties/tile". Capture the file part.
  const re = /"\$ref"\s*:\s*"([^"#]+\.json)/g;
  const found = new Set();
  let m;
  while ((m = re.exec(schemaText)) !== null) {
    if (m[1] !== selfName) found.add(m[1]);
  }
  return [...found];
}

// Crawl the schema graph starting at dashboard.json, following every cross-file $ref.
// The Python original hardcoded a ref list and missed dataSource.json/embeddedApp.json,
// so we discover refs dynamically instead.
async function loadSchemaGraph(version) {
  const schemas = new Map(); // filename -> parsed schema object
  const queue = ['dashboard.json'];
  while (queue.length > 0) {
    const filename = queue.shift();
    if (schemas.has(filename)) continue;
    const text = await getSchemaFileText(version, filename);
    schemas.set(filename, JSON.parse(text));
    for (const ref of findFileRefs(text, filename)) {
      if (!schemas.has(ref)) queue.push(ref);
    }
  }
  return schemas;
}

async function validateDashboard(dashboard) {
  const version = resolveSchemaVersion(dashboard);
  const schemas = await loadSchemaGraph(version);

  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  // errorMessage is a cosmetic keyword baked into the ADX schema, not the ajv-errors
  // plugin. Register it as a no-op so ajv does not treat it as data.
  ajv.addKeyword('errorMessage');

  let mainId = `/static/d/schema/${version}/dashboard.json`;
  for (const schema of schemas.values()) {
    ajv.addSchema(schema);
  }
  const dashboardSchema = schemas.get('dashboard.json');
  if (dashboardSchema && dashboardSchema.$id) mainId = dashboardSchema.$id;

  const validate = ajv.getSchema(mainId);
  if (!validate) {
    throw new Error(`Could not resolve compiled schema for ${mainId}`);
  }

  // Strip top-level metadata keys (e.g. _metadata, _etag) that we attach but the
  // schema does not define. Matches the Python validator behavior.
  const cleaned = {};
  for (const key of Object.keys(dashboard)) {
    if (!key.startsWith('_')) cleaned[key] = dashboard[key];
  }

  const ok = validate(cleaned);
  if (ok) return { valid: true };

  const errors = (validate.errors || []).map((e) => ({
    path: e.instancePath || '/',
    message: e.message + (e.params && e.params.additionalProperty
      ? ` (${e.params.additionalProperty})`
      : ''),
  }));
  return { valid: false, errors };
}

async function main() {
  const file = process.argv[2];
  if (!file) {
    process.stderr.write('Usage: validate.js <dashboard.json>\n');
    process.exit(2);
  }
  if (!fs.existsSync(file)) {
    process.stderr.write(JSON.stringify({ error: `File not found: ${file}` }) + '\n');
    process.exit(2);
  }

  let dashboard;
  try {
    dashboard = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    process.stderr.write(JSON.stringify({ error: `Invalid JSON: ${e.message}` }) + '\n');
    process.exit(2);
  }

  try {
    const result = await validateDashboard(dashboard);
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    process.exit(result.valid ? 0 : 1);
  } catch (e) {
    process.stderr.write(JSON.stringify({ error: e.message }) + '\n');
    process.exit(2);
  }
}

export {
  validateDashboard,
  resolveSchemaVersion,
  loadSchemaGraph,
  getSchemaFileText,
  cacheDirFor,
  cacheRoot,
  DEFAULT_SCHEMA_VERSION,
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
