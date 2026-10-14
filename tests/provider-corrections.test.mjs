import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPublicCatalog, matchesSong, songHref } from '../contracts/public-catalog.mjs';
import { validateProviderCorrections, applyProviderCorrections } from '../contracts/provider-corrections.mjs';

const now = new Date('2026-10-14T01:00:00Z');
const revision = 'a'.repeat(40);
const observed = value => ({ status: value === null ? 'unknown' : 'observed-unverified', observedNumber: value, evidence: null });
const fixture = () => ({ stagingVersion: 1, purpose: 'legacy-catalog-staging', revision,
  summary: { totalIds: 3 }, unresolvedAliases: [{ provider: 'ky', ids: ['phony', 'turing'] }],
  songs: [['phony', 'フォニイ', 'ツミキ', '00123', '57803'], ['turing', 'チューリングラブ', 'ナナヲアカリ', '52536', '57803'],
    ['movie', '前前前世(movie ver.)', 'RADWIMPS', '27944', null]].map(([id, title, artist, tj, ky]) => ({
      id, titleOriginal: title, titleKo: '', artistOriginal: artist, artistKo: '', tags: ['JPOP'],
      origin: 'playlist', availability: 'current', karaoke: { tj: observed(tj), ky: observed(ky) }, refs: [{ internal: true }],
    })) });
const url = (provider, value) => provider === 'tj'
  ? `https://www.tjmedia.com/song/accompaniment_search?nationType=JPN&strType=16&searchTxt=${value}&strWord=Y`
  : `https://kygabang.com/chart/search_list.php?mode=SongSearch&val=${value}`;
const entry = (songId = 'phony', provider = 'ky', action = 'confirm', expected = '57803', value = '57803') => ({
  songId, provider, action, expectedObservedNumber: expected, number: value,
  evidence: { url: url(provider, action === 'confirm' ? value : expected), checkedAt: '2026-10-14',
    title: '合成公式タイトル', artist: '合成公式アーティスト', responseSha256: 'b'.repeat(64) },
  reason: 'Synthetic explicit human-reviewed title/artist/version decision',
});
const ledger = entries => ({ ledgerVersion: 1, purpose: 'reviewed-provider-corrections', legacyRevision: revision, entries });
const freeze = value => {
  if (value && typeof value === 'object') { Object.freeze(value); Object.values(value).forEach(freeze); }
  return value;
};

test('reviewed suppression/addition preserves raw bytes, stable IDs, metadata and input immutability', () => {
  const staging = fixture(), songs = buildPublicCatalog(staging).songs;
  const corrections = ledger([entry(), entry('turing', 'ky', 'suppress', '57803', null), entry('movie', 'ky', 'confirm', null, '44067')]);
  const before = JSON.stringify({ staging, songs, corrections });
  freeze(staging); freeze(songs); freeze(corrections);
  const result = applyProviderCorrections(songs, staging, corrections, { now });
  assert.equal(JSON.stringify({ staging, songs, corrections }), before);
  assert.notEqual(result, songs);
  assert.deepEqual(result.map(song => song.id), songs.map(song => song.id));
  for (const [index, song] of result.entries()) {
    const { karaoke, ...metadata } = song;
    const { karaoke: previous, ...original } = songs[index];
    assert.deepEqual(metadata, original);
    assert.notEqual(song.tags, songs[index].tags);
    assert.equal(songHref(song.id), songHref(songs[index].id));
  }
  assert.equal(result[0].karaoke.ky.status, 'provider-confirmed');
  assert.equal(result[0].karaoke.ky.conflict, false);
  assert.deepEqual(result[1].karaoke.ky, { status: 'unknown', observedNumber: null, conflict: false,
    evidence: { url: url('ky', '57803'), checkedAt: '2026-10-14', title: '合成公式タイトル', artist: '合成公式アーティスト' },
    correction: { reason: corrections.entries[1].reason, previousNumber: '57803' } });
  assert.equal(result[2].karaoke.ky.observedNumber, '44067');
  assert.equal(result[2].karaoke.ky.correction.previousNumber, null);
  assert.equal(staging.songs[1].karaoke.ky.observedNumber, '57803');
  assert.equal(matchesSong(result[1], new URLSearchParams('number=has-ky')), false);
  assert.equal(matchesSong(result[1], new URLSearchParams('q=57803')), false);
  assert.equal(matchesSong(result[2], new URLSearchParams('q=44067&number=has-ky')), true);
  const publicBytes = JSON.stringify(result);
  assert.equal(publicBytes.includes('responseSha256'), false);
  assert.equal(publicBytes.includes('refs'), false);
  assert.equal(publicBytes.includes('unlisted'), false);
});

test('only explicit entries confirm providers; effective numbers recompute all remaining conflicts', () => {
  const staging = fixture(), songs = buildPublicCatalog(staging).songs;
  const untouched = applyProviderCorrections(songs, staging, ledger([]), { now });
  assert.equal(untouched[0].karaoke.ky.status, 'observed-unverified');
  assert.equal(untouched[0].karaoke.ky.evidence, null);
  assert.equal(untouched[0].karaoke.ky.correction, null);
  assert.equal(untouched[0].karaoke.ky.conflict, true);
  const result = applyProviderCorrections(songs, staging, ledger([
    entry(), entry('turing', 'tj', 'confirm', '52536', '00123'),
  ]), { now });
  assert.equal(result[1].karaoke.ky.status, 'observed-unverified');
  assert.equal(result[0].karaoke.ky.conflict, true);
  assert.equal(result[1].karaoke.ky.conflict, true);
  assert.equal(result[0].karaoke.tj.observedNumber, '00123');
  assert.equal(result[1].karaoke.tj.observedNumber, '00123');
  assert.equal(result[0].karaoke.tj.conflict, true);
  assert.equal(result[1].karaoke.tj.conflict, true);
  assert.equal(result.length, 3);
  // A matching number is insufficient: title/artist evidence is mandatory,
  // and the human-reviewed ledger may retain different version spellings.
  const missingIdentity = entry(); missingIdentity.evidence.artist = '';
  assert.throws(() => validateProviderCorrections(ledger([missingIdentity]), staging, { now }));
});

test('every public provider has only allowed evidence/correction fields and validated entries are detached', () => {
  const staging = fixture(), corrections = ledger([entry('phony', 'tj', 'confirm', '00123', '00123')]);
  const validated = validateProviderCorrections(corrections, staging, { now });
  validated[0].evidence.title = 'changed after validation';
  assert.equal(corrections.entries[0].evidence.title, '合成公式タイトル');
  const result = applyProviderCorrections(buildPublicCatalog(staging).songs, staging, corrections, { now });
  for (const song of result) for (const provider of ['tj', 'ky']) {
    assert.deepEqual(Object.keys(song.karaoke[provider]).sort(), ['status', 'observedNumber', 'conflict', 'evidence', 'correction'].sort());
    if (song.karaoke[provider].evidence)
      assert.deepEqual(Object.keys(song.karaoke[provider].evidence).sort(), ['url', 'checkedAt', 'title', 'artist'].sort());
  }
  assert.equal(result[0].karaoke.tj.observedNumber, '00123');
  result[0].karaoke.tj.evidence.title = 'public edit';
  assert.equal(corrections.entries[0].evidence.title, '合成公式タイトル');
});

test('wrong revision, unknown/duplicate IDs, expected mismatches and invalid numbers fail closed', () => {
  const mutations = [
    l => { l.legacyRevision = 'c'.repeat(40); }, l => { l.ledgerVersion = 2; },
    l => { l.purpose = 'unreviewed'; }, l => { l.entries[0].songId = 'missing'; },
    l => { l.entries.push(structuredClone(l.entries[0])); }, l => { l.entries[0].provider = 'other'; },
    l => { l.entries[0].action = 'unlisted'; }, l => { l.entries[0].expectedObservedNumber = '57804'; },
    l => { l.entries[0].expectedObservedNumber = 57803; }, l => { l.entries[0].number = 57803; },
    l => { l.entries[0].number = '00'; }, l => { l.entries[0].number = '-123'; },
    l => { l.entries[0].number = '12345678901'; }, l => { l.entries[0].number = '１２３'; },
    l => { l.entries[0].reason = ' '; }, l => { l.entries[0].action = 'suppress'; },
  ];
  for (const mutate of mutations) {
    const value = ledger([entry()]); mutate(value);
    assert.throws(() => validateProviderCorrections(value, fixture(), { now }));
  }
  assert.throws(() => validateProviderCorrections(ledger([entry('movie', 'ky', 'suppress', null, null)]), fixture(), { now }));
});

test('extra/private fields and missing evidence cannot enter the reviewed/public model', () => {
  const mutations = [
    l => { l.privateToken = 'synthetic'; }, l => { l.entries[0].lyrics = 'synthetic private field'; },
    l => { l.entries[0].evidence.responseBody = 'synthetic body'; }, l => { delete l.entries[0].reason; },
    l => { l.entries[0].evidence = null; }, l => { l.entries[0].evidence.title = ' '; },
    l => { l.entries[0].evidence.artist = null; }, l => { l.entries[0].evidence.responseSha256 = 'b'.repeat(63); },
    l => { l.entries[0].evidence.responseSha256 = 'g'.repeat(64); },
    l => { l.entries = Array(1); }, l => { l.entries.privateToken = 'synthetic'; },
    l => { l.entries[0][Symbol('private')] = 'synthetic'; },
  ];
  for (const mutate of mutations) {
    const value = ledger([entry()]); mutate(value);
    assert.throws(() => validateProviderCorrections(value, fixture(), { now }));
  }
  const staging = fixture(), songs = buildPublicCatalog(staging).songs;
  songs[0].lyrics = 'private';
  assert.throws(() => applyProviderCorrections(songs, staging, ledger([]), { now }));
  delete songs[0].lyrics; songs[0].karaoke.ky.responseSha256 = 'b'.repeat(64);
  assert.throws(() => applyProviderCorrections(songs, staging, ledger([]), { now }));
});

test('real date/ISO timestamps are accepted, while rollovers, missing zones and future evidence fail', () => {
  const valid = ['2024-02-29', '2026-10-14', '2026-10-14T01:00:00Z', '2026-10-14T10:00:00+09:00',
    '2026-10-14T00:59:59.999Z', '2026-10-14T09:04:35.202434+09:00', '2026-10-14T00:59:59.999999999Z'];
  const invalid = ['2026-02-29', '2026-02-30', '2026-13-01', '2026-10-15',
    '2026-10-14T01:00:00.001Z', '2026-10-14T01:00:00.000000001Z', '2026-02-30T00:00:00Z', '2026-10-14T24:00:00Z',
    '2026-10-14T00:60:00Z', '2026-10-14T00:00:60Z', '2026-10-14T00:00:00',
    '2026-10-14T00:00:00+15:00', '2026-10-14T00:00:00+14:01', 'tomorrow', 20261014];
  for (const checkedAt of valid) {
    const value = entry(); value.evidence.checkedAt = checkedAt;
    assert.equal(validateProviderCorrections(ledger([value]), fixture(), { now }).length, 1);
  }
  for (const checkedAt of invalid) {
    const value = entry(); value.evidence.checkedAt = checkedAt;
    assert.throws(() => validateProviderCorrections(ledger([value]), fixture(), { now }));
  }
  const value = entry(); value.evidence.checkedAt = '2026-10-14';
  assert.equal(validateProviderCorrections(ledger([value]), fixture(), { now: new Date('2026-10-13T15:00:00Z') }).length, 1);
});

test('only exact official numeric lookups without credentials, token queries or ambiguous params are accepted', () => {
  const safe = entry();
  const invalid = [safe.evidence.url.replace('https:', 'http:'), safe.evidence.url.replace('kygabang.com', 'kygabang.com.evil.invalid'),
    safe.evidence.url.replace('kygabang.com', 'operator:password@kygabang.com'), safe.evidence.url.replace('kygabang.com', 'kygabang.com:443'),
    `${safe.evidence.url}&token=synthetic`, `${safe.evidence.url}&%74oken=synthetic`, `${safe.evidence.url}&val=57803`,
    `${safe.evidence.url}#fragment`, `${safe.evidence.url}#`, safe.evidence.url.replace('57803', '57804'),
    safe.evidence.url.replace('/chart/search_list.php', '/shop/'), url('tj', '57803')];
  for (const source of invalid) {
    const value = entry(); value.evidence.url = source;
    assert.throws(() => validateProviderCorrections(ledger([value]), fixture(), { now }));
  }
  const valid = entry('phony', 'tj', 'confirm', '00123', '00123');
  valid.evidence.url = 'https://tjmedia.com/song/accompaniment_search?strWord=Y&searchTxt=00123&strType=16&nationType=JPN';
  assert.equal(validateProviderCorrections(ledger([valid]), fixture(), { now }).length, 1);
  valid.evidence.url = valid.evidence.url.replace('nationType=JPN', 'nationType=KOR');
  assert.equal(validateProviderCorrections(ledger([valid]), fixture(), { now }).length, 1);
  const invalidNamespace = structuredClone(valid);
  invalidNamespace.evidence.url = invalidNamespace.evidence.url.replace('nationType=KOR', 'nationType=unverified');
  assert.throws(() => validateProviderCorrections(ledger([invalidNamespace]), fixture(), { now }));
  valid.evidence.url = valid.evidence.url.replace('strType=16', 'strType=1');
  assert.throws(() => validateProviderCorrections(ledger([valid]), fixture(), { now }));
});

test('partial, duplicate, changed-metadata and stale public observations are rejected without mutation', () => {
  const staging = fixture(), songs = buildPublicCatalog(staging).songs;
  for (const damage of [value => value.pop(), value => { value[1] = structuredClone(value[0]); },
    value => { value[0].titleOriginal = 'changed identity'; }, value => { value[0].tags.push('invented'); },
    value => { value[0].karaoke.ky.observedNumber = 'different'; }]) {
    const damaged = structuredClone(songs); damage(damaged);
    const before = JSON.stringify(damaged);
    assert.throws(() => applyProviderCorrections(damaged, staging, ledger([]), { now }));
    assert.equal(JSON.stringify(damaged), before);
  }
  assert.equal(buildPublicCatalog(staging).version, 1);
});
