import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const main = 'c57a7ae1be0c6cff06c847bb7dbc5c572e631edd';
const dev = '6dbe5a65d1bd729c09393f746f715f4363089a43';
// Independently calculated with git show <full-sha>:<path> | sha256sum.
// This test checks saved metadata and reference integrity, not the unavailable
// original file bodies, provider evidence, rights, or current source truth.
const pinnedSources = new Map([
  [main + ':js/songs.js', { rows: 3299, sha256: '9a024c4259f74001215a36c61e0b1cf37199a6fcb57d9b0cfd596c2c842fd9c9' }],
  [main + ':js/chart.js', { rows: 100, sha256: '4724b9fb6d1526e633577410c84f92a774d9adb1a9a63cafe6b7b0cb56bff12f' }],
  [dev + ':js/songs.js', { rows: 3299, sha256: '9a024c4259f74001215a36c61e0b1cf37199a6fcb57d9b0cfd596c2c842fd9c9' }],
  [dev + ':js/chart.js', { rows: 100, sha256: '5722774c7047f6314d2726389692f09578111f4752296001881c4d1a2eeab50e' }],
]);

test('committed real baseline preserves pinned metadata, every source row, unique IDs, and unresolved groups', async () => {
  const baseline = JSON.parse(await readFile(new URL('../data/legacy-identity-baseline.json', import.meta.url), 'utf8'));
  assert.equal(baseline.baselineVersion, 1);
  assert.equal(baseline.purpose, 'legacy-identity-audit');
  assert.equal(baseline.repository, 'https://github.com/kim75503/todayjpop');
  assert.equal(baseline.mappingStrategy, 'preserve-each-legacy-id');
  assert.equal(baseline.sources.length, 4);
  const sourceKeys = new Set();
  for (const source of baseline.sources) {
    const key = source.revision + ':' + source.path;
    assert.ok(!sourceKeys.has(key), 'Duplicate saved source ' + key);
    sourceKeys.add(key);
    assert.ok(pinnedSources.has(key), 'Unexpected saved source ' + key);
    assert.deepEqual({ rows: source.rows, sha256: source.sha256 }, pinnedSources.get(key));
  }
  assert.equal(sourceKeys.size, pinnedSources.size);

  const ids = new Set();
  const playlistIds = new Set();
  const revisionIds = new Map([[main, new Set()], [dev, new Set()]]);
  const sourceRows = baseline.sources.map(() => new Set());
  for (const identity of baseline.identities) {
    assert.equal(typeof identity.id, 'string');
    assert.ok(identity.id.length > 0 && !ids.has(identity.id), 'Missing or duplicate ID');
    ids.add(identity.id);
    assert.ok(identity.observations.length > 0);
    for (const observation of identity.observations) {
      assert.deepEqual(Object.keys(observation).sort(), ['title', 'artist', 'tjNumber', 'kyNumber', 'refs'].sort());
      assert.equal(typeof observation.tjNumber, 'string');
      assert.equal(typeof observation.kyNumber, 'string');
      assert.ok(observation.refs.length > 0);
      for (const ref of observation.refs) {
        assert.ok(Number.isInteger(ref.source) && ref.source >= 0 && ref.source < baseline.sources.length);
        const source = baseline.sources[ref.source];
        assert.ok(Number.isInteger(ref.index) && ref.index >= 0 && ref.index < source.rows);
        assert.ok(!sourceRows[ref.source].has(ref.index), 'A source row maps to multiple observations');
        sourceRows[ref.source].add(ref.index);
        if (source.path === 'js/songs.js') playlistIds.add(identity.id);
        revisionIds.get(source.revision).add(identity.id);
      }
    }
  }
  for (const [source, indices] of sourceRows.entries())
    assert.equal(indices.size, baseline.sources[source].rows, 'Missing source row references');
  assert.equal(ids.size, 3317);
  assert.equal(playlistIds.size, 3299);
  assert.equal([...ids].filter(id => !playlistIds.has(id)).length, 18);
  assert.deepEqual(baseline.summary, { totalIds: 3317, playlistIds: 3299, chartOnlyIds: 18, unresolvedAliasGroups: 11 });
  assert.equal(baseline.revisions.length, 2);
  assert.deepEqual(baseline.revisions.map(row => row.revision).sort(), [main, dev].sort());
  for (const revision of baseline.revisions) {
    assert.equal(revision.playlistIds, 3299);
    assert.equal(revision.chartIds, 100);
    assert.equal(revision.mergedIds, 3313);
    assert.equal(revisionIds.get(revision.revision).size, 3313);
  }

  assert.equal(baseline.unresolvedAliases.length, 11);
  const expectedGroups = ['tj:25837', 'tj:27944', 'tj:52756', 'tj:68961', 'ky:40554', 'ky:41637', 'ky:43011', 'ky:43060', 'ky:44671', 'ky:57803', 'ky:80603'];
  assert.deepEqual(baseline.unresolvedAliases.map(row => row.provider + ':' + row.observedNumber).sort(), expectedGroups.sort());
  for (const group of baseline.unresolvedAliases) {
    assert.equal(group.resolution, 'unresolved');
    assert.equal(group.ids.length, group.provider === 'ky' && group.observedNumber === '43060' ? 3 : 2);
    assert.equal(new Set(group.ids).size, group.ids.length);
    for (const id of group.ids) {
      assert.ok(ids.has(id), 'Alias candidate points to a missing identity');
      const identity = baseline.identities.find(row => row.id === id);
      assert.ok(identity.observations.some(row => row[group.provider + 'Number'] === group.observedNumber));
    }
  }
});
