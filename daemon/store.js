/*
 * Disk-backed store for the daemon's dashboard state.
 *
 * For each dashboard the daemon keeps two copies under the cache root:
 *   dashboards/<id>/saved.json    last copy pulled from (or applied to) the browser
 *   dashboards/<id>/working.json  the agent's in-progress edits
 *
 * Write tools mutate working.json. `apply` pushes working to the browser and then
 * promotes working into saved. `discard` reverts working back to saved. Keeping the two
 * separate is what lets the agent make a series of edits and still bail out cleanly.
 *
 * Schema files are served from the same cache that shared/validate.js fetches into, so
 * get_schema never needs its own network path.
 */

import fs from 'node:fs';
import path from 'node:path';
import { cacheRoot, getSchemaFileText, loadSchemaGraph } from '../shared/validate.js';

function dashboardsRoot() {
  return path.join(cacheRoot(), 'dashboards');
}

// Dashboard ids are GUIDs in practice, but sanitize anyway so a stray id can never
// escape the dashboards directory or collide with a path separator.
function dirNameFor(dashboardId) {
  const id = String(dashboardId || '').trim();
  if (!id) throw new Error('dashboardId is required');
  return id.replace(/[^a-zA-Z0-9._-]/g, '_');
}

function dashboardDir(dashboardId) {
  return path.join(dashboardsRoot(), dirNameFor(dashboardId));
}

function savedPath(dashboardId) {
  return path.join(dashboardDir(dashboardId), 'saved.json');
}

function workingPath(dashboardId) {
  return path.join(dashboardDir(dashboardId), 'working.json');
}

// Atomic write: stage to a temp file then rename over the target. On both Windows and
// POSIX rename is atomic, so a crash mid-write can never leave a half-written copy.
function writeJsonAtomic(filePath, obj) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, filePath);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

export function hasSaved(dashboardId) {
  return fs.existsSync(savedPath(dashboardId));
}

export function hasWorking(dashboardId) {
  return fs.existsSync(workingPath(dashboardId));
}

export function loadSaved(dashboardId) {
  return readJson(savedPath(dashboardId));
}

export function loadWorking(dashboardId) {
  return readJson(workingPath(dashboardId));
}

export function writeSaved(dashboardId, dashboard) {
  writeJsonAtomic(savedPath(dashboardId), dashboard);
}

export function writeWorking(dashboardId, dashboard) {
  writeJsonAtomic(workingPath(dashboardId), dashboard);
}

// Fresh pull from the browser: both copies start identical so the first edit has a clean
// baseline to diff against on discard.
export function setSavedAndWorking(dashboardId, dashboard) {
  writeSaved(dashboardId, dashboard);
  writeWorking(dashboardId, dashboard);
}

// apply succeeded: the browser now holds the working copy, so saved catches up to it.
export function promoteWorkingToSaved(dashboardId) {
  if (!hasWorking(dashboardId)) throw new Error('no working copy to promote');
  writeSaved(dashboardId, loadWorking(dashboardId));
}

// discard: throw away the agent's edits and restore the last saved baseline.
export function discard(dashboardId) {
  if (!hasSaved(dashboardId)) throw new Error('no saved copy to restore');
  writeWorking(dashboardId, loadSaved(dashboardId));
}

// Serve a single schema file for get_schema, fetching (and caching) it if needed.
export async function readSchemaFile(version, filename) {
  return getSchemaFileText(version, filename);
}

// Ensure the whole schema graph for a version is cached on disk. Lets the daemon warm
// the cache up front so later get_schema / validate calls are pure disk reads.
export async function ensureSchemaCached(version) {
  await loadSchemaGraph(version);
}

export const _internal = { dashboardDir, savedPath, workingPath, dirNameFor };
