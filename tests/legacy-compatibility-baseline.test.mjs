import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createIdentityResolver, resolveLegacyUrl, readFavorites, migrateFavorites } from '../contracts/legacy-compatibility.mjs';

const baseline = JSON.parse(await readFile(new URL('../data/legacy-identity-baseline.json', import.meta.url), 'utf8'));

test('all 3,317 real baseline IDs round-trip through old song URLs and new stable routes', () => {
  const resolver = createIdentityResolver(baseline);
  assert.equal(resolver.size, 3317);
  assert.equal(resolver.aliasCount, 0);
  for (const identity of baseline.identities) {
    assert.equal(resolver.resolve(identity.id).canonicalId, identity.id);
    for (const route of ['/song', '/song.html']) {
      const legacy = resolveLegacyUrl(route + '?id=' + encodeURIComponent(identity.id), resolver);
      assert.equal(legacy.status, 'redirect', identity.id);
      assert.equal(legacy.identity.canonicalId, identity.id);
      assert.equal(legacy.href, '/songs/' + encodeURIComponent(identity.id) + '/');
      const canonical = resolveLegacyUrl(legacy.href, resolver);
      assert.equal(canonical.status, 'unchanged', identity.id);
      assert.equal(canonical.identity.canonicalId, identity.id);
    }
  }
});

test('real baseline collision groups preserve distinct IDs without reviewed aliases', () => {
  const resolver = createIdentityResolver(baseline);
  assert.equal(baseline.unresolvedAliases.length, 11);
  for (const group of baseline.unresolvedAliases) {
    const targets = group.ids.map(id => resolver.resolve(id).canonicalId);
    assert.deepEqual(targets, group.ids);
    assert.equal(new Set(targets).size, group.ids.length);
  }
});

test('all real IDs survive string/object favorite reads and explicit migration with missing IDs', () => {
  const resolver = createIdentityResolver(baseline);
  const values = baseline.identities.map((row, index) => index % 2 ? { id: row.id } : row.id);
  values.push('synthetic-unresolved-retained');
  const raw = ' ' + JSON.stringify(values) + '\n';
  const bytes = new Map([['jpop_today_favorites', raw]]);
  let writes = 0;
  const storage = { getItem: key => bytes.get(key) ?? null, setItem: (key, value) => { writes++; bytes.set(key, value); } };
  const read = readFavorites(storage, resolver);
  assert.equal(writes, 0);
  assert.equal(read.entries.filter(row => row.status === 'known').length, 3317);
  assert.equal(read.entries.filter(row => row.status === 'missing').length, 1);
  const migrated = migrateFavorites(storage, resolver, { backupKey: 'synthetic-baseline-backup' });
  assert.equal(migrated.status, 'saved');
  assert.equal(bytes.get('synthetic-baseline-backup'), raw);
  assert.deepEqual(JSON.parse(bytes.get('jpop_today_favorites')), values);
});

test('correcting every baseline title and provider number cannot change any stable ID', () => {
  const corrected = structuredClone(baseline);
  for (const row of corrected.identities) row.observations = [{ title: 'Synthetic corrected title', artist: 'Synthetic artist', tjNumber: '00001', kyNumber: '00002' }];
  const resolver = createIdentityResolver(corrected);
  for (const identity of baseline.identities) assert.equal(resolver.resolve(identity.id).canonicalId, identity.id);
});
