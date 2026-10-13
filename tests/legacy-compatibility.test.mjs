import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FAVORITES_STORAGE_KEY as FAVORITES, RECENT_FILTERS_STORAGE_KEY as RECENT,
  createIdentityResolver, resolveLegacyUrl, readFavorites, updateFavorites, migrateFavorites,
  readRecentFilters, migrateRecentFilters,
} from '../contracts/legacy-compatibility.mjs';

const baseline = () => ({ identities: [
  { id: 'stable-a', observations: [{ title: 'Synthetic A', tjNumber: '00042' }] },
  { id: 'stable-b', observations: [{ title: 'Synthetic B', tjNumber: '00042' }] },
  { id: '日本語/ID +%', observations: [] },
] });
const alias = (alias = 'old-a', canonicalId = 'stable-a') => ({ alias, canonicalId, verified: true, evidence: 'synthetic-reviewed-correction-1' });
const resolver = createIdentityResolver(baseline(), [alias()]);

function storage(initial = {}, hook = () => {}) {
  const bytes = new Map(Object.entries(initial));
  const calls = [];
  const api = {
    calls, bytes,
    getItem(key) { calls.push(['get', key]); hook('get', key, undefined, bytes); return bytes.get(key) ?? null; },
    setItem(key, value) { calls.push(['set', key, value]); hook('set', key, value, bytes); bytes.set(key, value); },
    removeItem(key) { calls.push(['remove', key]); hook('remove', key, undefined, bytes); bytes.delete(key); },
  };
  return api;
}
const mutationCalls = mock => mock.calls.filter(([operation]) => operation !== 'get');
const quota = () => Object.assign(new Error('synthetic quota error'), { name: 'QuotaExceededError' });

test('baseline IDs remain independent of title/number corrections and collisions', () => {
  const original = baseline();
  const before = createIdentityResolver(original);
  original.identities[0].observations[0] = { title: 'Corrected synthetic title', tjNumber: '99999' };
  const after = createIdentityResolver(original);
  for (const id of ['stable-a', 'stable-b']) assert.equal(before.resolve(id).canonicalId, after.resolve(id).canonicalId);
  assert.equal(after.resolve('stable-b').canonicalId, 'stable-b');
  assert.equal(after.size, 3);
});

test('only explicit reviewed aliases resolve and unknown IDs remain exact', () => {
  assert.deepEqual(resolver.resolve('old-a'), { status: 'known', id: 'old-a', canonicalId: 'stable-a', aliased: true, evidence: 'synthetic-reviewed-correction-1' });
  assert.deepEqual(resolver.resolve('unknown日本語'), { status: 'missing', id: 'unknown日本語', canonicalId: null, aliased: false });
  assert.equal(createIdentityResolver(baseline()).resolve('old-a').status, 'missing');
});

test('rejects malformed baseline IDs and duplicate baseline identities', () => {
  for (const id of ['', null, 42, '.', '..', 'bad\nID', '\ud800'])
    assert.throws(() => createIdentityResolver({ identities: [{ id }] }));
  for (const input of [{}, { identities: [] }, { identities: [{ id: 'a' }, { id: 'a' }] }])
    assert.throws(() => createIdentityResolver(input));
});

test('rejects aliases without evidence, unknown targets, duplicates, chains, and cycles', () => {
  const invalid = [
    [{ ...alias(), verified: false }], [{ ...alias(), evidence: '' }], [alias('old-a', 'missing')],
    [alias(), alias()], [alias(), alias('old-a', 'stable-b')], [alias('stable-a', 'stable-a')],
    [alias('old-a', 'stable-a'), alias('stable-a', 'stable-b')],
    [alias('stable-a', 'stable-b'), alias('stable-b', 'stable-a')],
  ];
  for (const aliases of invalid) assert.throws(() => createIdentityResolver(baseline(), aliases));
});

test('legacy song addresses and reviewed aliases select the same stable encoded route', () => {
  for (const path of ['/song', '/song/', '/song.html', '/song.html/']) {
    const result = resolveLegacyUrl(path + '?id=old-a&q=%ED%95%9C%EA%B8%80%20%EC%9D%BC%EB%B3%B8&extra=x+y#detail', resolver);
    assert.equal(result.status, 'redirect');
    assert.equal(result.identity.canonicalId, 'stable-a');
    assert.equal(result.href, '/songs/stable-a/?q=%ED%95%9C%EA%B8%80%20%EC%9D%BC%EB%B3%B8&extra=x+y#detail');
  }
  const id = '日本語/ID +%';
  const result = resolveLegacyUrl('/song?id=' + encodeURIComponent(id), resolver);
  assert.equal(result.href, '/songs/' + encodeURIComponent(id) + '/');
  assert.equal(resolveLegacyUrl(result.href, resolver).status, 'unchanged');
});

test('query ID names are decoded once and duplicate IDs are always rejected', () => {
  assert.equal(resolveLegacyUrl('/song?%69d=stable-a', resolver).href, '/songs/stable-a/');
  for (const suffix of ['id=stable-a&id=stable-b', 'id=stable-a&%69d=stable-a', 'id=', '', 'id=%2E%2E'])
    assert.equal(resolveLegacyUrl('/song?' + suffix, resolver).status, 'rejected');
  const encodedTwice = resolveLegacyUrl('/song?id=old%252Da', resolver);
  assert.equal(encodedTwice.status, 'unresolved');
  assert.equal(encodedTwice.legacyId, 'old%2Da');
});

test('unknown IDs remain unresolved and never redirect to a guessed song', () => {
  const original = '/song.html?id=unresolved%2BID&keep=%EC%95%84';
  const result = resolveLegacyUrl(original, resolver);
  assert.equal(result.status, 'unresolved');
  assert.equal(result.legacyId, 'unresolved+ID');
  assert.equal(result.original, original);
  assert.equal(result.href, null);
  assert.equal(resolveLegacyUrl('/songs/unresolved%2BID/', resolver).status, 'unresolved');
});

test('filter redirects preserve Korean/Japanese, repeated filters, pagination and extra query bytes', () => {
  const query = '?q=%EC%95%84%EC%9D%B4%E3%82%A2&number=has-tj&number=has-ky&tag=A&tag=B&anime=all&artist=all&page=2&extra=keep+me';
  for (const path of ['/filter', '/filter.html', '/search.html']) {
    const result = resolveLegacyUrl(path + query + '#results', resolver);
    assert.equal(result.href, '/search/' + query + '#results');
    assert.deepEqual(new URL('https://jpop.today' + result.href).searchParams.getAll('tag'), ['A', 'B']);
  }
});

test('old favorites fragments and known .html pages retain queries and hashes', () => {
  assert.equal(resolveLegacyUrl('/?q=keep#favorites-view', resolver).href, '/favorites/?q=keep');
  assert.equal(resolveLegacyUrl('/index.html?x=1#favorites-view', resolver).href, '/favorites/?x=1');
  assert.equal(resolveLegacyUrl('/favorites.html?x=1#list', resolver).href, '/favorites/?x=1#list');
  assert.equal(resolveLegacyUrl('/guides/synthetic.html?x=1#chapter', resolver).href, '/guides/synthetic/?x=1#chapter');
  assert.equal(resolveLegacyUrl('/unknown.html', resolver).status, 'unmatched');
});

test('rejects foreign origins, credentials, unsupported protocols, broken escaping and control characters', () => {
  for (const input of [
    'https://evil.example/song?id=stable-a', '//evil.example/song?id=stable-a',
    'https://jpop.today.evil.example/song?id=stable-a', 'https://user:password@jpop.today/song?id=stable-a',
    'http://jpop.today/song?id=stable-a', 'javascript:alert(1)', '\\evil.example/song?id=stable-a',
    '/song?id=%', '/song?id=%GG', '/song?id=%C0%AF', '/song?id=%ED%A0%80', '/%FF?id=stable-a',
    '/filter?q=%E3%81', '/song?id=stable-a#%ZZ', '/song?id=stable-a\n',
  ]) assert.equal(resolveLegacyUrl(input, resolver).status, 'rejected', input);
  assert.equal(resolveLegacyUrl('https://preview.example/song?id=stable-a', resolver, { origin: 'https://preview.example' }).href, '/songs/stable-a/');
});

test('favorites reads string/object arrays, reviewed aliases and missing entries without a single write', () => {
  const raw = ' [ "old-a", {"id":"stable-b","note":"keep"}, "missing-日本語", "stable-a" ] ';
  const mock = storage({ [FAVORITES]: raw });
  const result = readFavorites(mock, resolver);
  assert.equal(result.mode, 'persistent');
  assert.deepEqual(result.entries.map(item => item.status), ['known', 'known', 'missing', 'known']);
  assert.equal(result.entries[0].canonicalId, 'stable-a');
  assert.equal(result.entries[2].id, 'missing-日本語');
  assert.equal(result.raw, raw);
  assert.deepEqual(mutationCalls(mock), []);
});

test('damaged JSON/shape/entries remain byte-for-byte unchanged and usable entries remain visible', () => {
  for (const raw of ['{broken', '{"id":"stable-a"}', '["stable-a",null,{"unknown":true},"missing"]', '']) {
    const mock = storage({ [FAVORITES]: raw });
    const result = readFavorites(mock, resolver);
    assert.equal(result.mode, 'session');
    assert.equal(result.raw, raw);
    assert.equal(mock.bytes.get(FAVORITES), raw);
    assert.deepEqual(mutationCalls(mock), []);
  }
  const partial = readFavorites(storage({ [FAVORITES]: '["stable-a",null,"missing"]' }), resolver);
  assert.deepEqual(partial.entries.map(entry => entry.status), ['known', 'invalid', 'missing']);
});

test('security/read failures do not attempt to repair or delete storage', () => {
  const mock = storage({ [FAVORITES]: '["old-a"]' }, operation => {
    if (operation === 'get') throw Object.assign(new Error('denied'), { name: 'SecurityError' });
  });
  const result = readFavorites(mock, resolver);
  assert.equal(result.status, 'read-failed');
  assert.equal(result.mode, 'session');
  assert.equal(result.diagnostics[0].errorName, 'SecurityError');
  assert.deepEqual(mutationCalls(mock), []);
  assert.equal(readFavorites(undefined, resolver).status, 'read-failed');
});

test('explicit alias migration backs up original bytes before writing and preserves unresolved IDs and metadata', () => {
  const raw = ' ["old-a", {"id":"old-a","note":"keep"}, "missing-日本語", "stable-b"] ';
  const mock = storage({ [FAVORITES]: raw });
  const result = migrateFavorites(mock, resolver, { backupKey: 'synthetic-backup' });
  assert.equal(result.status, 'saved');
  assert.equal(mock.bytes.get('synthetic-backup'), raw);
  assert.deepEqual(JSON.parse(mock.bytes.get(FAVORITES)), ['stable-a', { id: 'stable-a', note: 'keep' }, 'missing-日本語', 'stable-b']);
  const writes = mutationCalls(mock);
  assert.equal(writes[0][1], 'synthetic-backup');
  assert.equal(writes[1][1], FAVORITES);
  assert.equal(result.entries[2].status, 'missing');
});

test('automatic backup keys preserve each distinct original instead of overwriting previous backups', () => {
  const mock = storage({ [FAVORITES]: ' ["old-a"] ' });
  const first = migrateFavorites(mock, resolver);
  mock.bytes.set(FAVORITES, ' ["old-a","missing"] ');
  const second = migrateFavorites(mock, resolver);
  assert.equal(first.status, 'saved');
  assert.equal(second.status, 'saved');
  assert.notEqual(first.backupKey, second.backupKey);
  assert.equal(mock.bytes.get(first.backupKey), ' ["old-a"] ');
  assert.equal(mock.bytes.get(second.backupKey), ' ["old-a","missing"] ');
});

test('migration of already canonical serialized data performs no writes', () => {
  const mock = storage({ [FAVORITES]: '["stable-a","missing"]' });
  assert.equal(migrateFavorites(mock, resolver).status, 'unchanged');
  assert.deepEqual(mutationCalls(mock), []);
});

test('backup quota failure and existing backup conflict leave original favorites untouched', () => {
  const raw = '["old-a","missing"]';
  const mock = storage({ [FAVORITES]: raw }, (operation, key) => { if (operation === 'set' && key === 'backup') throw quota(); });
  const result = migrateFavorites(mock, resolver, { backupKey: 'backup' });
  assert.equal(result.status, 'backup-failed');
  assert.equal(result.mode, 'session');
  assert.equal(mock.bytes.get(FAVORITES), raw);
  assert.ok(!mutationCalls(mock).some(call => call[1] === FAVORITES));
  const conflict = storage({ [FAVORITES]: raw, backup: 'older bytes' });
  assert.equal(migrateFavorites(conflict, resolver, { backupKey: 'backup' }).status, 'backup-conflict');
  assert.equal(conflict.bytes.get('backup'), 'older bytes');
  assert.equal(conflict.bytes.get(FAVORITES), raw);
  assert.equal(migrateFavorites(conflict, resolver, { backupKey: FAVORITES }).status, 'invalid-backup-key');
});

test('failed target writes retain original bytes plus backup and allow a session result', () => {
  const raw = '["old-a","missing"]';
  const mock = storage({ [FAVORITES]: raw }, (operation, key) => { if (operation === 'set' && key === FAVORITES) throw quota(); });
  const result = migrateFavorites(mock, resolver, { backupKey: 'backup' });
  assert.equal(result.status, 'write-failed');
  assert.equal(result.restored, true);
  assert.equal(mock.bytes.get(FAVORITES), raw);
  assert.equal(mock.bytes.get('backup'), raw);
  assert.equal(result.entries[0].canonicalId, 'stable-a');
});

test('a storage implementation that writes then throws is rolled back to original bytes', () => {
  const raw = ' ["old-a","missing"] ';
  let failed = false;
  const mock = storage({ [FAVORITES]: raw }, (operation, key, value, bytes) => {
    if (operation === 'set' && key === FAVORITES && !failed) { failed = true; bytes.set(key, value); throw quota(); }
  });
  const result = migrateFavorites(mock, resolver, { backupKey: 'backup' });
  assert.equal(result.status, 'write-failed');
  assert.equal(result.restored, true);
  assert.equal(mock.bytes.get(FAVORITES), raw);
  assert.equal(mock.bytes.get('backup'), raw);
});

test('failed rollback is reported honestly and the durable original backup remains available', () => {
  const raw = '["old-a","missing"]';
  const mock = storage({ [FAVORITES]: raw }, (operation, key, value, bytes) => {
    if (operation === 'set' && key === FAVORITES) { bytes.set(key, value === raw ? '["damaged"]' : value); throw quota(); }
  });
  const result = migrateFavorites(mock, resolver, { backupKey: 'backup' });
  assert.equal(result.status, 'write-failed');
  assert.equal(result.restored, false);
  assert.ok(result.diagnostics.some(item => item.code === 'rollback-failed'));
  assert.equal(mock.bytes.get('backup'), raw);
});

test('a concurrent edit before the target write aborts migration and retains the old backup', () => {
  const raw = '["old-a"]';
  const concurrent = '["stable-b","missing"]';
  const mock = storage({ [FAVORITES]: raw }, (operation, key, value, bytes) => {
    if (operation === 'set' && key === 'backup') bytes.set(FAVORITES, concurrent);
  });
  const result = migrateFavorites(mock, resolver, { backupKey: 'backup' });
  assert.equal(result.status, 'conflict');
  assert.equal(mock.bytes.get(FAVORITES), concurrent);
  assert.equal(mock.bytes.get('backup'), raw);
});

test('a concurrent edit after a write is not overwritten by rollback', () => {
  const raw = '["old-a"]';
  const concurrent = '["stable-b","missing"]';
  let targetWritten = false;
  const mock = storage({ [FAVORITES]: raw }, (operation, key, value, bytes) => {
    if (operation === 'set' && key === FAVORITES) targetWritten = true;
    if (operation === 'get' && key === FAVORITES && targetWritten) bytes.set(FAVORITES, concurrent);
  });
  const result = migrateFavorites(mock, resolver, { backupKey: 'backup' });
  assert.equal(result.status, 'write-failed');
  assert.equal(result.restored, false);
  assert.ok(result.diagnostics.some(item => item.code === 'rollback-concurrent-change'));
  assert.equal(mock.bytes.get(FAVORITES), concurrent);
  assert.equal(mock.bytes.get('backup'), raw);
});

test('invalid JSON or invalid entries never migrate over the existing key', () => {
  for (const raw of ['{broken', '["old-a",null,"missing"]']) {
    const mock = storage({ [FAVORITES]: raw });
    assert.equal(migrateFavorites(mock, resolver).status, 'session-only');
    assert.equal(mock.bytes.get(FAVORITES), raw);
    assert.deepEqual(mutationCalls(mock), []);
  }
});

test('save/remove retains missing IDs and original object fields, with explicit missing-ID removal only', () => {
  const raw = '["old-a",{"id":"missing","note":"keep"}]';
  const mock = storage({ [FAVORITES]: raw });
  assert.equal(updateFavorites(mock, resolver, { action: 'save', id: 'stable-a' }).status, 'unchanged');
  updateFavorites(mock, resolver, { action: 'save', id: 'stable-b' });
  assert.deepEqual(JSON.parse(mock.bytes.get(FAVORITES)), ['old-a', { id: 'missing', note: 'keep' }, 'stable-b']);
  updateFavorites(mock, resolver, { action: 'remove', id: 'stable-a' });
  assert.deepEqual(JSON.parse(mock.bytes.get(FAVORITES)), [{ id: 'missing', note: 'keep' }, 'stable-b']);
  updateFavorites(mock, resolver, { action: 'remove', id: 'missing' });
  assert.deepEqual(JSON.parse(mock.bytes.get(FAVORITES)), ['stable-b']);
});

test('search-facing save and remove remain usable in a session after broken JSON', () => {
  const raw = '{original-broken-json';
  const mock = storage({ [FAVORITES]: raw });
  const saved = updateFavorites(mock, resolver, { action: 'save', id: 'stable-a' });
  assert.equal(saved.status, 'session-only');
  assert.deepEqual(saved.entries.map(entry => entry.id), ['stable-a']);
  const next = updateFavorites(mock, resolver, { action: 'save', id: 'stable-b' }, { state: saved });
  assert.deepEqual(next.entries.map(entry => entry.id), ['stable-a', 'stable-b']);
  const removed = updateFavorites(mock, resolver, { action: 'remove', id: 'stable-a' }, { state: next });
  assert.deepEqual(removed.entries.map(entry => entry.id), ['stable-b']);
  assert.equal(mock.bytes.get(FAVORITES), raw);
  assert.deepEqual(mutationCalls(mock), []);
});

test('quota failures leave previous persisted favorites and retain subsequent session changes', () => {
  const raw = '["missing"]';
  const mock = storage({ [FAVORITES]: raw }, (operation, key) => { if (operation === 'set' && key === FAVORITES) throw quota(); });
  const result = updateFavorites(mock, resolver, { action: 'save', id: 'stable-a' });
  assert.equal(result.status, 'write-failed');
  const next = updateFavorites(mock, resolver, { action: 'save', id: 'stable-b' }, { state: result });
  assert.deepEqual(next.entries.map(entry => entry.id), ['missing', 'stable-a', 'stable-b']);
  assert.equal(mock.bytes.get(FAVORITES), raw);
});

test('denied reads support session saving while untouched persisted bytes remain unavailable', () => {
  const raw = '["missing"]';
  const mock = storage({ [FAVORITES]: raw }, operation => { if (operation === 'get') throw new Error('read denied'); });
  const saved = updateFavorites(mock, resolver, { action: 'save', id: 'stable-a' });
  assert.equal(saved.mode, 'session');
  assert.deepEqual(saved.entries.map(entry => entry.id), ['stable-a']);
  assert.equal(mock.bytes.get(FAVORITES), raw);
  assert.deepEqual(mutationCalls(mock), []);
});

test('empty storage is initialized on explicit save and malformed actions are rejected', () => {
  const mock = storage();
  assert.equal(readFavorites(mock, resolver).status, 'empty');
  assert.equal(updateFavorites(mock, resolver, { action: 'save', id: 'stable-a' }).status, 'saved');
  assert.equal(mock.bytes.get(FAVORITES), '["stable-a"]');
  for (const action of [{ action: 'clear', id: 'stable-a' }, { action: 'save', id: null }])
    assert.throws(() => updateFavorites(mock, resolver, action));
});

test('recent filter snapshots expand without invented timestamps or read-side writes', () => {
  const raw = ' [{"numberFilters":["has-tj","has-ky"],"tags":["애니메이션:합성"],"animeAll":true,"artistAll":true,"savedAt":123}] ';
  const mock = storage({ [RECENT]: raw });
  const result = readRecentFilters(mock);
  assert.equal(result.entries.length, 5);
  assert.deepEqual(result.entries.map(entry => entry.type), ['number', 'number', 'anime-all', 'artist-all', 'tag']);
  assert.ok(result.entries.every(entry => entry.savedAt === 123));
  assert.equal(mock.bytes.get(RECENT), raw);
  assert.deepEqual(mutationCalls(mock), []);
  const missingDate = readRecentFilters(storage({ [RECENT]: '[{"type":"tag","value":"synthetic"}]' }));
  assert.equal(missingDate.entries[0].savedAt, 0);
});

test('recent filter aliases, deduplication, sort, and five-entry view preserve original bytes', () => {
  const values = [
    { id: 'old-special', type: 'animeAll', savedAt: 2 }, { id: 'new-special', type: 'anime-all', savedAt: 3 },
    ...Array.from({ length: 6 }, (_, index) => ({ id: 'tag-' + index, type: 'tag', value: 'synthetic-' + index, savedAt: index })),
  ];
  const raw = JSON.stringify(values);
  const mock = storage({ [RECENT]: raw });
  const result = readRecentFilters(mock);
  assert.equal(result.entries.length, 5);
  assert.equal(result.allEntries.length, 7);
  assert.equal(result.overflowCount, 2);
  assert.equal(result.allEntries.find(entry => entry.type === 'anime-all').id, 'new-special');
  assert.equal(migrateRecentFilters(mock).status, 'overflow-preserved');
  assert.equal(mock.bytes.get(RECENT), raw);
  assert.deepEqual(mutationCalls(mock), []);
});

test('recent filter migration keeps durable original snapshot and normalizes known entries only', () => {
  const raw = '[{"numberFilters":["has-tj"],"animeAll":true,"savedAt":42}]';
  const mock = storage({ [RECENT]: raw });
  const result = migrateRecentFilters(mock, { backupKey: 'recent-backup' });
  assert.equal(result.status, 'saved');
  assert.equal(mock.bytes.get('recent-backup'), raw);
  assert.deepEqual(JSON.parse(mock.bytes.get(RECENT)).map(item => item.type), ['number', 'anime-all']);
});

test('unknown recent formats and damaged storage stay intact while readable filters remain available', () => {
  for (const raw of ['{broken', '[null]', '[{"type":"future","value":"keep"}]', '[{"tags":"bad"}]']) {
    const mock = storage({ [RECENT]: raw });
    assert.equal(readRecentFilters(mock).mode, 'session');
    assert.equal(migrateRecentFilters(mock).status, 'session-only');
    assert.equal(mock.bytes.get(RECENT), raw);
    assert.deepEqual(mutationCalls(mock), []);
  }
  const partial = readRecentFilters(storage({ [RECENT]: '[{"type":"tag","value":"known"},{"type":"future"}]' }));
  assert.equal(partial.entries[0].value, 'known');
  assert.equal(partial.unrecognized.length, 1);
});

test('recent filters use the same checked backup and rollback guarantees as favorites', () => {
  const raw = '[{"tags":["synthetic"],"savedAt":42}]';
  const mock = storage({ [RECENT]: raw }, (operation, key) => { if (operation === 'set' && key === RECENT) throw quota(); });
  const result = migrateRecentFilters(mock, { backupKey: 'backup' });
  assert.equal(result.status, 'write-failed');
  assert.equal(result.restored, true);
  assert.equal(mock.bytes.get(RECENT), raw);
  assert.equal(mock.bytes.get('backup'), raw);
});
