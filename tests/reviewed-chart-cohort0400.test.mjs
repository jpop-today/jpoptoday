import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { buildPublicCatalog, songHref } from '../contracts/public-catalog.mjs';
import { applyProviderCorrections, validateProviderCorrections } from '../contracts/provider-corrections.mjs';

const load = path => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
const staging = load('../data/staging/legacy-catalog.json');
const chart = load('../data/chart-snapshot.json');
const ledger = load('../data/reviewed/provider-corrections.json');
const oldLedger = { ...ledger, entries: ledger.entries.slice(0, 71) };
const reviewedLedger = { ...ledger, entries: ledger.entries.slice(0, 77) };
const sha = value => createHash('sha256').update(value).digest('hex');
const officialUrl = (provider, number) => provider === 'tj'
  ? `https://www.tjmedia.com/song/accompaniment_search?nationType=JPN&strType=16&searchTxt=${number}&strWord=Y`
  : `https://kygabang.com/chart/search_list.php?mode=SongSearch&val=${number}`;

// Actual Issue27 metadata observations and separate editorial decisions, not a
// requirement that every successful HTTP request must become a confirmation.
// Preserve the full official title/feature/subtitle instead of replacing it with
// the shorter staging identity. The other two KY requests were explicitly deferred.
const reviewed = [
  ['jpop-playlist-samfree-ルカルカ-ナイトフィ-ハ-f6722acd10', 'tj', '27031', 'ルカルカ★ ナイトフィーバー', 'samfree(Feat.巡音ルカ)',
    '2026-10-15T19:06:49.340877Z', '024ead7135ab7abe272b98720e90b8e17e8d6779e662c85dc4c0536596043c20'],
  ['jpop-playlist-ado-逆光-c8c1ba8b20', 'tj', '68868', "逆光(映画 'ONE PIECE FILM RED' OST)", 'Ado',
    '2026-10-15T19:06:53.828995Z', '9c1759af47529a06fa63fc1d3512fbfdf9e840a728edbd16f9b9f9b3acf5572a'],
  ['jpop-playlist-米津玄師-kick-back-5f2ec0135c', 'tj', '68677', "KICK BACK( 'チェンソーマン' OP)", '米津玄師',
    '2026-10-15T19:06:57.259478Z', 'ab92bf8a7123f609799f8b67d5c522208b26d9451a40aef8ab7f251d91360ce9'],
  ['jpop-playlist-米津玄師-kick-back-5f2ec0135c', 'ky', '44855', 'KICK BACK ("チェンソーマン"OP)', '米津玄師',
    '2026-10-15T19:06:59.892091Z', 'b8f0d678f5c516ac62caeb9f61024861f8b1ddbb0175f5a6de2465b44e5b2219'],
  ['jpop-playlist-優里-レオ-4439d77563', 'tj', '52773', 'レオ', '優里',
    '2026-10-15T19:07:00.559714Z', '3b73929e8e281996d6cb66f4f53c1b0af91da4d6a734fc169831d9a840693362'],
  ['jpop-playlist-優里-レオ-4439d77563', 'ky', '57826', 'レオ', '優里',
    '2026-10-15T19:07:03.279190Z', '528f6bf0d28542ee0307797860655b4d45735021b0f8c37e8030ba7b9edf725a'],
];
const deferred = [
  ['jpop-playlist-samfree-ルカルカ-ナイトフィ-ハ-f6722acd10', 'ky', '43185'],
  ['jpop-playlist-ado-逆光-c8c1ba8b20', 'ky', '76509'],
];

test('Issue27 preserves the complete 71-entry ledger and frozen staging/chart identities', () => {
  assert.equal(sha(JSON.stringify(oldLedger.entries)), '35487404af46c08e2bf0471e0bf05fff088c0545b69639a57d9c928390797689');
  for (const [path, expected] of [
    ['../data/staging/legacy-catalog.json', 'a3d482ca2da082852883960d200841b4ad4ff26336eaf1174c55677881eecbf3'],
    ['../data/chart-snapshot.json', '7ade29897828967b98b2bca64b285b9694356ad3d2b97498f06270217c91da97'],
  ]) assert.equal(sha(readFileSync(new URL(path, import.meta.url))), expected, path);
  assert.equal(staging.songs.length, 3317);
  assert.equal(chart.songs.length, 100);
  assert.equal(new Set(chart.songs.map(row => row.canonicalId)).size, 100);
  assert.deepEqual(chart.songs.map(row => row.rank), Array.from({ length: 100 }, (_, index) => index + 1));
  assert.deepEqual(chart.songs.slice(14, 18).map(row => row.canonicalId), [...new Set(reviewed.map(([id]) => id))]);
});

test('the six reviewed entries retain exact official identity, string number and actual response evidence', () => {
  const expected = reviewed.map(([songId, provider, number, title, artist, checkedAt, responseSha256]) => ({
    songId, provider, action: 'confirm', expectedObservedNumber: number, number,
    evidence: { url: officialUrl(provider, number), checkedAt, title, artist, responseSha256 },
  }));
  // Later independently reviewed cohorts may append without weakening this one.
  const actual = reviewedLedger.entries.slice(71).map(({ reason, ...entry }) => {
    assert.equal(typeof reason, 'string');
    assert.ok(reason.trim().length > 0);
    return entry;
  });
  assert.deepEqual(actual, expected);
  assert.doesNotThrow(() => validateProviderCorrections(ledger, staging));
  for (const entry of actual) {
    const song = staging.songs.find(song => song.id === entry.songId);
    assert.ok(song);
    assert.equal(song.karaoke[entry.provider].observedNumber, entry.expectedObservedNumber);
    assert.equal(typeof entry.number, 'string');
  }
});

test('the reviewed projection preserves all IDs, routes, metadata and untouched provider records', () => {
  const input = buildPublicCatalog(staging).songs;
  const before = applyProviderCorrections(input, staging, oldLedger);
  const after = applyProviderCorrections(input, staging, reviewedLedger);
  const touched = new Set(reviewed.map(([id, provider]) => JSON.stringify([id, provider])));
  assert.deepEqual(after.map(song => song.id), before.map(song => song.id));
  assert.deepEqual(after.map(song => songHref(song.id)), before.map(song => songHref(song.id)));
  for (const [index, song] of after.entries()) {
    const previous = before[index];
    const { karaoke, ...identity } = song;
    const { karaoke: oldNumbers, ...oldIdentity } = previous;
    assert.deepEqual(identity, oldIdentity);
    for (const provider of ['tj', 'ky']) {
      if (!touched.has(JSON.stringify([song.id, provider]))) {
        assert.deepEqual(karaoke[provider], oldNumbers[provider]);
        continue;
      }
      assert.equal(oldNumbers[provider].status, 'observed-unverified');
      assert.equal(karaoke[provider].status, 'provider-confirmed');
      assert.equal(karaoke[provider].observedNumber, oldNumbers[provider].observedNumber);
      assert.equal(typeof karaoke[provider].observedNumber, 'string');
      assert.equal(karaoke[provider].conflict, false);
      const entry = reviewedLedger.entries.slice(71).find(entry => entry.songId === song.id && entry.provider === provider);
      const { responseSha256, ...publicEvidence } = entry.evidence;
      assert.deepEqual(karaoke[provider].evidence, publicEvidence);
    }
  }
  // Prior same-title/different-performer regression remains untouched by the
  // new Ado review. Evidence is attached by exact ID/provider, never by title.
  const sameTitle = after.filter(song => song.titleOriginal === 'ドライフラワー');
  assert.equal(sameTitle.length, 2);
  assert.equal(sameTitle.find(song => song.artistOriginal === '優里').karaoke.tj.status, 'provider-confirmed');
  const ado = sameTitle.find(song => song.artistOriginal === 'Ado');
  assert.equal(ado.karaoke.tj.status, 'observed-unverified');
  assert.equal(ado.karaoke.tj.evidence, null);
  assert.equal(ado.karaoke.ky.status, 'unknown');
  assert.equal(ado.karaoke.ky.observedNumber, null);
  assert.equal(JSON.stringify(after).includes('"unlisted"'), false);
});

test('unresolved feature credit and truncated KY title stay observed without invented evidence', () => {
  const after = applyProviderCorrections(buildPublicCatalog(staging).songs, staging, reviewedLedger);
  for (const [id, provider, number] of deferred) {
    assert.equal(reviewedLedger.entries.some(entry => entry.songId === id && entry.provider === provider), false);
    const value = after.find(song => song.id === id).karaoke[provider];
    assert.equal(value.status, 'observed-unverified');
    assert.equal(value.observedNumber, number);
    assert.equal(typeof value.observedNumber, 'string');
    assert.equal(value.evidence, null);
    assert.equal(value.correction, null);
  }
});
