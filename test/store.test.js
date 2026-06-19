import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Point the cache root at a throwaway temp dir before importing the store, so the
// saved/working files never touch the real cache and the suite stays offline.
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'adx-store-'));
process.env.ADX_LIVE_EDIT_HOME = tmpHome;

const store = await import('../daemon/store.js');

const DASH_ID = '12345678-1234-4123-8123-123456789abc';

function sampleDashboard() {
  return { schema_version: 76, title: 'Sample', pages: [{ id: 'p1', name: 'One' }] };
}

test.after(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

test('hasSaved/hasWorking are false before anything is written', () => {
  assert.equal(store.hasSaved('nope-' + DASH_ID), false);
  assert.equal(store.hasWorking('nope-' + DASH_ID), false);
});

test('setSavedAndWorking writes both copies identically', () => {
  const dash = sampleDashboard();
  store.setSavedAndWorking(DASH_ID, dash);

  assert.equal(store.hasSaved(DASH_ID), true);
  assert.equal(store.hasWorking(DASH_ID), true);
  assert.deepEqual(store.loadSaved(DASH_ID), dash);
  assert.deepEqual(store.loadWorking(DASH_ID), dash);
});

test('writeWorking mutates only the working copy', () => {
  store.setSavedAndWorking(DASH_ID, sampleDashboard());

  const edited = sampleDashboard();
  edited.title = 'Edited working title';
  store.writeWorking(DASH_ID, edited);

  assert.equal(store.loadWorking(DASH_ID).title, 'Edited working title');
  assert.equal(store.loadSaved(DASH_ID).title, 'Sample');
});

test('promoteWorkingToSaved copies working over saved', () => {
  store.setSavedAndWorking(DASH_ID, sampleDashboard());

  const edited = sampleDashboard();
  edited.title = 'Applied title';
  store.writeWorking(DASH_ID, edited);

  store.promoteWorkingToSaved(DASH_ID);
  assert.equal(store.loadSaved(DASH_ID).title, 'Applied title');
});

test('promoteWorkingToSaved throws when there is no working copy', () => {
  assert.throws(() => store.promoteWorkingToSaved('missing-' + DASH_ID), /no working copy/);
});

test('discard reverts working back to saved', () => {
  store.setSavedAndWorking(DASH_ID, sampleDashboard());

  const edited = sampleDashboard();
  edited.title = 'Throwaway edit';
  store.writeWorking(DASH_ID, edited);
  assert.equal(store.loadWorking(DASH_ID).title, 'Throwaway edit');

  store.discard(DASH_ID);
  assert.equal(store.loadWorking(DASH_ID).title, 'Sample');
});

test('discard throws when there is no saved copy', () => {
  assert.throws(() => store.discard('missing-' + DASH_ID), /no saved copy/);
});

test('writes for two dashboards land in separate directories', () => {
  const a = '11111111-aaaa-4aaa-8aaa-111111111111';
  const b = '22222222-bbbb-4bbb-8bbb-222222222222';
  const dashA = sampleDashboard();
  dashA.title = 'Dashboard A';
  const dashB = sampleDashboard();
  dashB.title = 'Dashboard B';

  store.setSavedAndWorking(a, dashA);
  store.setSavedAndWorking(b, dashB);

  assert.equal(store.loadSaved(a).title, 'Dashboard A');
  assert.equal(store.loadSaved(b).title, 'Dashboard B');
});

test('dirNameFor strips path separators so an id cannot escape the dashboards dir', () => {
  const dirty = store._internal.dirNameFor('../../etc/passwd');
  assert.ok(!dirty.includes('/'));
  assert.ok(!dirty.includes('\\'));
});

test('dirNameFor throws on an empty id', () => {
  assert.throws(() => store._internal.dirNameFor('   '), /required/);
});
