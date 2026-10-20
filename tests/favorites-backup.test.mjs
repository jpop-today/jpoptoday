import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_FAVORITES_BACKUP_BYTES, formatFavoritesBackup, parseFavoritesBackup } from '../contracts/favorites-backup.mjs';
import { FAVORITES_STORAGE_KEY, createIdentityResolver, readFavorites, mergeFavorites } from '../contracts/legacy-compatibility.mjs';

// These are synthetic stable identities, deliberately unrelated to numbers or
// title normalization. The expected arrays below are written independently.
const resolver = createIdentityResolver({ identities: [{ id: 'stable-A' }, { id: 'stable-B' }, { id: '日本語/ID +%' }] }, [
  { alias: 'reviewed-old-A', canonicalId: 'stable-A', verified: true, evidence: 'synthetic-reviewed-alias' },
]);
const envelope = values => ({ format: 'jpop.today/favorites', version: 1, values });
const encoded = values => JSON.stringify(envelope(values));
const frozen = value => {
  if (value && typeof value === 'object') { for (const item of Object.values(value)) frozen(item); Object.freeze(value); }
  return value;
};
function memory(raw = null) {
  const bytes = new Map(raw === null ? [] : [[FAVORITES_STORAGE_KEY, raw]]);
  const mutations = [];
  return {
    bytes, mutations,
    getItem(key) { return bytes.get(key) ?? null; },
    setItem(key, value) { mutations.push(['set', key, value]); bytes.set(key, value); },
    removeItem(key) { mutations.push(['remove', key]); bytes.delete(key); },
  };
}
function codedRejection(action, hidden = '') {
  assert.throws(action, error => {
    assert.equal(typeof error.code, 'string');
    assert.match(error.code, /^[a-z][a-z0-9-]*$/i);
    if (hidden) assert.ok(!error.message.includes(hidden), 'fixed errors must not reveal an input ID or metadata');
    return true;
  });
}

test('file round trip preserves full values, order, duplicates, unresolved IDs and nested legacy metadata without mutating input', () => {
  const values = frozen(['reviewed-old-A', { id: 'stable-B', note: '보관용 합성 메모', legacy: { number: '00042', enabled: false, data: [null, 0, '001'] } },
    'missing-未解決', 'stable-B', '00042', '日本語/ID +%', ' stable-A ']);
  const before = JSON.stringify(values), text = formatFavoritesBackup(values, resolver), actual = JSON.parse(text);
  assert.deepEqual(actual, envelope(values));
  const parsed = parseFavoritesBackup(text, resolver);
  assert.deepEqual(parsed.values, values);
  assert.equal(parsed.total, 7); assert.equal(parsed.known, 4); assert.equal(parsed.unresolved, 3);
  assert.equal(JSON.stringify(values), before);
  assert.deepEqual(Object.keys(actual).sort(), ['format', 'values', 'version']);
});

test('empty backup is valid and never invents a song or provider confirmation', () => {
  const result = parseFavoritesBackup(formatFavoritesBackup([], resolver), resolver);
  assert.deepEqual(result, { values: [], total: 0, known: 0, unresolved: 0 });
});

test('JSON object metadata named __proto__ survives as data and does not change prototypes', () => {
  const text = '{"format":"jpop.today/favorites","version":1,"values":[{"id":"stable-A","__proto__":{"polluted":"synthetic"},"constructor":{"prototype":{"polluted":true}}}]}';
  const values = parseFavoritesBackup(text, resolver).values;
  assert.equal(Object.hasOwn(values[0], '__proto__'), true);
  assert.deepEqual(JSON.parse(formatFavoritesBackup(values, resolver)), JSON.parse(text));
  assert.equal({}.polluted, undefined);
});

test('the size cap counts UTF-8 bytes, accepts the exact boundary and rejects one byte over it', () => {
  assert.equal(MAX_FAVORITES_BACKUP_BYTES, 256 * 1024);
  const base = encoded([{ id: 'stable-A', note: '' }]);
  const room = MAX_FAVORITES_BACKUP_BYTES - Buffer.byteLength(base);
  const exact = encoded([{ id: 'stable-A', note: 'x'.repeat(room) }]);
  assert.equal(Buffer.byteLength(exact), MAX_FAVORITES_BACKUP_BYTES);
  assert.equal(parseFavoritesBackup(exact, resolver).total, 1);
  codedRejection(() => parseFavoritesBackup(exact + ' ', resolver));
  const unicode = encoded([{ id: 'stable-A', note: '한'.repeat(Math.floor(room / 3) + 1) }]);
  assert.ok(unicode.length < MAX_FAVORITES_BACKUP_BYTES);
  assert.ok(Buffer.byteLength(unicode) > MAX_FAVORITES_BACKUP_BYTES);
  codedRejection(() => parseFavoritesBackup(unicode, resolver));
  codedRejection(() => formatFavoritesBackup([{ id: 'stable-A', note: '한'.repeat(room) }], resolver));
});

test('malformed JSON, incompatible envelopes and invalid IDs are rejected before any storage write', async t => {
  const invalid = [
    ['broken JSON', '{synthetic-private-content'], ['array root', '[]'], ['null root', 'null'], ['number root', '42'],
    ['wrong format', JSON.stringify({ ...envelope([]), format: 'another-app' })],
    ['missing format', JSON.stringify({ version: 1, values: [] })], ['future version', JSON.stringify({ ...envelope([]), version: 2 })],
    ['string version', JSON.stringify({ ...envelope([]), version: '1' })], ['missing version', JSON.stringify({ format: 'jpop.today/favorites', values: [] })],
    ['missing values', JSON.stringify({ format: 'jpop.today/favorites', version: 1 })],
    ['values object', JSON.stringify({ ...envelope([]), values: { id: 'stable-A' } })],
    ...[null, 42, true, [], {}, { id: 42 }, { id: '' }, '', ' ', '.', '..', 'private\nID', 'private\u0000ID', 'private\u007fID', '\ud800']
      .map((value, index) => ['invalid entry ' + index, encoded(['stable-A', value])]),
  ];
  for (const [name, text] of invalid) await t.test(name, () => {
    const store = memory(' [ "stable-B" ] ');
    codedRejection(() => {
      const parsed = parseFavoritesBackup(text, resolver);
      mergeFavorites(store, resolver, parsed.values, { expectedRaw: store.getItem(FAVORITES_STORAGE_KEY) });
    }, 'private');
    assert.equal(store.getItem(FAVORITES_STORAGE_KEY), ' [ "stable-B" ] ');
    assert.deepEqual(store.mutations, []);
  });
});

test('export refuses invalid entries instead of silently dropping them or making an apparently recoverable backup', () => {
  for (const values of [['stable-A', null], [42], [{ id: '' }], ['bad\nID'], { id: 'stable-A' }])
    codedRejection(() => formatFavoritesBackup(values, resolver));
});

test('valid parsing and file formatting are pure and leave original spacing and storage bytes untouched', () => {
  const raw = ' [ { "id" : "stable-A", "note" : "원문" }, "missing-keep" ] ';
  const store = memory(raw), state = readFavorites(store, resolver);
  const parsed = parseFavoritesBackup(formatFavoritesBackup(state.values, resolver), resolver);
  assert.deepEqual(parsed.values, [{ id: 'stable-A', note: '원문' }, 'missing-keep']);
  assert.equal(state.raw, raw); assert.equal(store.getItem(FAVORITES_STORAGE_KEY), raw);
  assert.deepEqual(store.mutations, []);
});

test('one atomic merge keeps every existing object and duplicate, appends only new exact IDs and reviewed aliases do not create duplicates', () => {
  const original = [{ id: 'reviewed-old-A', note: 'existing metadata' }, 'missing-existing', 'stable-A', 'stable-A'];
  const raw = ' ' + JSON.stringify(original) + ' ', store = memory(raw);
  const incoming = frozen([{ id: 'stable-A', note: 'must not replace metadata' }, { id: 'stable-B', note: 'first imported', nested: { value: '00042' } },
    { id: 'stable-B', note: 'ignored duplicate' }, 'missing-existing', 'missing-new', { id: 'missing-new', note: 'ignored duplicate' }, '00042', ' stable-A ']);
  const before = JSON.stringify(incoming);
  const result = mergeFavorites(store, resolver, incoming, { expectedRaw: raw });
  const expected = [...original, { id: 'stable-B', note: 'first imported', nested: { value: '00042' } }, 'missing-new', '00042', ' stable-A '];
  assert.equal(result.status, 'saved'); assert.equal(result.mode, 'persistent'); assert.equal(result.addedCount, 4);
  assert.deepEqual(JSON.parse(store.getItem(FAVORITES_STORAGE_KEY)), expected);
  assert.deepEqual(result.values, expected); assert.equal(JSON.stringify(incoming), before);
  assert.equal(store.mutations.filter(call => call[0] === 'set' && call[1] === FAVORITES_STORAGE_KEY).length, 1);
});

test('all-duplicate and empty imports do not rewrite original bytes or normalize their whitespace', () => {
  for (const values of [[], ['stable-A', 'reviewed-old-A', 'missing-existing']]) {
    const raw = ' [ "stable-A", "missing-existing" ] ', store = memory(raw);
    const result = mergeFavorites(store, resolver, values, { expectedRaw: raw });
    assert.equal(result.status, 'unchanged'); assert.equal(result.addedCount, 0);
    assert.equal(store.getItem(FAVORITES_STORAGE_KEY), raw); assert.deepEqual(store.mutations, []);
  }
});

test('new aliases deduplicate only with reviewed evidence while the first imported representation and metadata are preserved', () => {
  const store = memory();
  const result = mergeFavorites(store, resolver, [{ id: 'reviewed-old-A', note: 'first wins' }, 'stable-A', 'not-reviewed-old-A'], { expectedRaw: null });
  assert.equal(result.addedCount, 2);
  assert.deepEqual(JSON.parse(store.getItem(FAVORITES_STORAGE_KEY)), [{ id: 'reviewed-old-A', note: 'first wins' }, 'not-reviewed-old-A']);
});

test('direct merge also refuses an invalid candidate before changing a valid original', () => {
  const raw = '["stable-A"]', store = memory(raw);
  assert.throws(() => mergeFavorites(store, resolver, ['stable-B', null], { expectedRaw: raw }));
  assert.equal(store.getItem(FAVORITES_STORAGE_KEY), raw); assert.deepEqual(store.mutations, []);
});

test('a different tab changing bytes after confirmation cancels the import without rewriting that tab or appending to stale state', () => {
  const raw = ' [ "stable-A" ] ', store = memory(raw), state = readFavorites(store, resolver);
  const newer = ' [ "stable-B", { "id": "missing-other-tab", "note": "other writer" } ] ';
  store.bytes.set(FAVORITES_STORAGE_KEY, newer);
  const result = mergeFavorites(store, resolver, ['missing-import'], { state, expectedRaw: raw });
  assert.equal(result.status, 'conflict'); assert.equal(result.addedCount, 0);
  assert.equal(store.getItem(FAVORITES_STORAGE_KEY), newer); assert.deepEqual(store.mutations, []);
});

test('a writer racing the pre-write check cannot be overwritten by the candidate or a rollback', () => {
  const raw = '["stable-A"]', newer = '["stable-B","other-writer"]', store = memory(raw);
  let reads = 0;
  const realGet = store.getItem.bind(store);
  store.getItem = key => { if (key === FAVORITES_STORAGE_KEY && ++reads === 2) store.bytes.set(key, newer); return realGet(key); };
  const result = mergeFavorites(store, resolver, ['missing-import'], { expectedRaw: raw });
  assert.equal(result.status, 'conflict'); assert.equal(store.getItem(FAVORITES_STORAGE_KEY), newer);
  assert.deepEqual(store.mutations, []);
});

test('corrupted source bytes are never repaired by import and incoming valid values are session-only', () => {
  for (const raw of ['{broken', '{"id":"stable-A"}', '["stable-A",null,"missing-existing"]']) {
    const store = memory(raw), current = readFavorites(store, resolver);
    const result = mergeFavorites(store, resolver, ['stable-B', 'missing-import'], { state: current, expectedRaw: raw });
    assert.equal(result.mode, 'session');
    assert.equal(store.getItem(FAVORITES_STORAGE_KEY), raw); assert.deepEqual(store.mutations, []);
    assert.ok(result.values.includes('stable-B')); assert.ok(result.values.includes('missing-import'));
    if (raw.includes('missing-existing')) assert.ok(result.values.includes('missing-existing'));
  }
});

test('blocked reads create a truthful session result without attempted writes or deletion', () => {
  const store = memory('["stable-A"]');
  store.getItem = () => { throw new DOMException('synthetic denial', 'SecurityError'); };
  const result = mergeFavorites(store, resolver, ['stable-B', 'missing-import'], { expectedRaw: null });
  assert.equal(result.mode, 'session'); assert.equal(result.status, 'session-only');
  assert.deepEqual(result.values, ['stable-B', 'missing-import']); assert.deepEqual(store.mutations, []);
  assert.equal(store.bytes.get(FAVORITES_STORAGE_KEY), '["stable-A"]');
});

test('a read permission lost after confirmation retains the previously readable list in the temporary merge', () => {
  const raw = ' [ { "id": "stable-A", "note": "known before denial" }, "missing-existing" ] ', store = memory(raw);
  const state = readFavorites(store, resolver);
  store.getItem = () => { throw new DOMException('synthetic changed read permission', 'SecurityError'); };
  const result = mergeFavorites(store, resolver, ['stable-B', 'missing-import'], { state, expectedRaw: raw });
  assert.equal(result.mode, 'session');
  assert.deepEqual(result.values, [{ id: 'stable-A', note: 'known before denial' }, 'missing-existing', 'stable-B', 'missing-import']);
  assert.equal(store.bytes.get(FAVORITES_STORAGE_KEY), raw); assert.deepEqual(store.mutations, []);
});

test('denied writes retain last normal bytes and allow a subsequent session merge without partial persistent imports', () => {
  const raw = ' [ { "id": "stable-A", "note": "keep" }, "missing-existing" ] ', store = memory(raw);
  store.setItem = (key, value) => { store.mutations.push(['set', key, value]); throw new DOMException('synthetic quota', 'QuotaExceededError'); };
  const first = mergeFavorites(store, resolver, ['stable-B', 'missing-import'], { expectedRaw: raw });
  assert.equal(first.status, 'write-failed'); assert.equal(first.mode, 'session');
  assert.equal(store.getItem(FAVORITES_STORAGE_KEY), raw);
  assert.equal(store.mutations.length, 1);
  const second = mergeFavorites(store, resolver, ['missing-second'], { state: first, expectedRaw: raw });
  assert.equal(second.mode, 'session'); assert.equal(store.getItem(FAVORITES_STORAGE_KEY), raw);
  assert.deepEqual(second.values, [{ id: 'stable-A', note: 'keep' }, 'missing-existing', 'stable-B', 'missing-import', 'missing-second']);
  assert.equal(store.mutations.length, 1, 'a session merge must not retry persistence implicitly');
});

test('write-then-throw is rolled back to exact original bytes, including the originally absent key', () => {
  for (const raw of [null, ' [ "stable-A" ] ']) {
    const store = memory(raw), originalSet = store.setItem.bind(store);
    let first = true;
    store.setItem = (key, value) => { originalSet(key, value); if (first) { first = false; throw new DOMException('synthetic write failure', 'QuotaExceededError'); } };
    const result = mergeFavorites(store, resolver, ['stable-B', 'missing-import'], { expectedRaw: raw });
    assert.equal(result.status, 'write-failed'); assert.equal(result.mode, 'session'); assert.equal(result.restored, true);
    assert.equal(store.getItem(FAVORITES_STORAGE_KEY), raw);
  }
});

test('failed read-back verification restores only our own candidate and never a later concurrent writer', () => {
  const raw = ' [ "stable-A" ] ', store = memory(raw), originalSet = store.setItem.bind(store), realGet = store.getItem.bind(store);
  let failVerification = false;
  store.setItem = (key, value) => { originalSet(key, value); if (key === FAVORITES_STORAGE_KEY && value !== raw) failVerification = true; };
  store.getItem = key => { if (key === FAVORITES_STORAGE_KEY && failVerification) { failVerification = false; return '["synthetic-transient-read"]'; } return realGet(key); };
  const result = mergeFavorites(store, resolver, ['stable-B'], { expectedRaw: raw });
  assert.equal(result.status, 'write-failed'); assert.equal(result.restored, true);
  assert.equal(store.getItem(FAVORITES_STORAGE_KEY), raw);

  const concurrent = memory(raw), originalConcurrentSet = concurrent.setItem.bind(concurrent);
  const newer = '["stable-A","other-writer"]';
  concurrent.setItem = (key, value) => { originalConcurrentSet(key, value); concurrent.bytes.set(key, newer); throw new Error('synthetic concurrent writer after candidate'); };
  const collision = mergeFavorites(concurrent, resolver, ['stable-B'], { expectedRaw: raw });
  assert.equal(collision.status, 'write-failed'); assert.equal(collision.restored, false);
  assert.equal(concurrent.getItem(FAVORITES_STORAGE_KEY), newer);
  assert.equal(concurrent.mutations.length, 1, 'rollback must not overwrite a third-party value');
});
