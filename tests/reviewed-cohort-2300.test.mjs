import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { buildPublicCatalog, songHref } from '../contracts/public-catalog.mjs';
import { applyProviderCorrections, validateProviderCorrections } from '../contracts/provider-corrections.mjs';

const load = path => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
const staging = load('../data/staging/legacy-catalog.json');
const ledger = load('../data/reviewed/provider-corrections.json');
const oldLedger = { ...ledger, entries: ledger.entries.slice(0, 63) };
const sha = value => createHash('sha256').update(value).digest('hex');
// Actual metadata-only observations and editorial decisions from Issue24, 2026-10-15.
// These are a frozen reviewed cohort, not an expectation that every future request succeeds.
const cohort = [
  ['jpop-playlist-novelbright-walking-with-you-6d7d7f64d1', 'Walking with you', 'Novelbright', [
    ['tj', '68419', '2026-10-15T14:03:23.439453Z', '4b6cd434251f7488a9886e72d94052ec066b20b88b84859a3bcd311df1414746'],
    ['ky', '44686', '2026-10-15T14:03:27.519224Z', 'b2ca7709794e0e3c34be6f4a4e7143fd973920aa13d829bd792f3dc60c17d5f8'],
  ]],
  ['jpop-playlist-優里-ト-ライフラワ-1125dddd02', 'ドライフラワー', '優里', [
    ['tj', '68333', '2026-10-15T14:03:28.525583Z', '4a12616965b426eb669af86fef538491768ae061780d6fcc867a726649cbdc10'],
    ['ky', '44652', '2026-10-15T14:03:31.661086Z', '0c65cb223d178a9e580f2a9a83f29d462588f22132e04f8606ee946226b97736'],
  ]],
  ['jpop-playlist-back-number-水平線-187ab55662', '水平線', 'back number', [
    ['tj', '68446', '2026-10-15T14:03:32.326257Z', '3bd510368d5ddb8bca9f6dac149977ba87a518ce5af047fdf02d35721f60a404'],
    ['ky', '44701', '2026-10-15T14:03:35.981521Z', '7e51835302e3dad5315006e940b38833f479bf4fca321c59a162041a0e47ea6d'],
  ]],
  ['jpop-playlist-vaundy-踊り子-fe694e97f6', '踊り子', 'Vaundy', [
    ['tj', '68807', '2026-10-15T14:03:36.625532Z', '5534f29b576c5e4178cfe0e783ffc21ff6c54adef85fdcb754ec63fe2341ee6c'],
    ['ky', '76508', '2026-10-15T14:03:39.142231Z', '92d855f18468d8cb77b562eaeba36c9ad5ee9972acc461136f6a1d7fa58f515d'],
  ]],
];
const officialUrl = (provider, number) => provider === 'tj'
  ? `https://www.tjmedia.com/song/accompaniment_search?nationType=JPN&strType=16&searchTxt=${number}&strWord=Y`
  : `https://kygabang.com/chart/search_list.php?mode=SongSearch&val=${number}`;

test('Issue24 appends to the complete frozen 63-entry ledger without changing raw or chart inputs', () => {
  assert.equal(sha(JSON.stringify(oldLedger.entries)), '83698b0b9d3406e768fac9fe5dfa2b3caa804477e8c06acd494d77cef32802aa');
  for (const [path, expected] of [
    ['../data/staging/legacy-catalog.json', 'a3d482ca2da082852883960d200841b4ad4ff26336eaf1174c55677881eecbf3'],
    ['../data/chart-snapshot.json', '7ade29897828967b98b2bca64b285b9694356ad3d2b97498f06270217c91da97'],
  ]) assert.equal(sha(readFileSync(new URL(path, import.meta.url))), expected, path);
  assert.equal(staging.songs.length, 3317);
});

test('the eight actual reviewed provider observations stay attached to their exact song, identity and response evidence', () => {
  const expected = cohort.flatMap(([songId, title, artist, values]) => values.map(([provider, number, checkedAt, responseSha256]) => ({
    songId, provider, action: 'confirm', expectedObservedNumber: number, number,
    evidence: { url: officialUrl(provider, number), checkedAt, title, artist, responseSha256 },
  })));
  // Permit later reviewed cohorts while preserving this cohort's whole evidence records.
  const actual = ledger.entries.slice(63, 71).map(({ reason, ...entry }) => {
    assert.equal(typeof reason, 'string');
    assert.ok(reason.trim().length > 0);
    return entry;
  });
  assert.deepEqual(actual, expected);
  assert.doesNotThrow(() => validateProviderCorrections(ledger, staging));
  for (const [songId, title, artist] of cohort) {
    const song = staging.songs.find(song => song.id === songId);
    assert.ok(song);
    assert.equal(song.titleOriginal, title);
    assert.equal(song.artistOriginal, artist);
  }
});

test('reviewed projection preserves every ID, URL and untouched provider, including the other performer with the same title', () => {
  const input = buildPublicCatalog(staging).songs;
  const before = applyProviderCorrections(input, staging, oldLedger);
  // Isolate this reviewed cohort so a later append cannot weaken the regression.
  const after = applyProviderCorrections(input, staging, { ...ledger, entries: ledger.entries.slice(0, 71) });
  const touched = new Set(cohort.map(([id]) => id));
  assert.deepEqual(after.map(song => song.id), before.map(song => song.id));
  for (const [index, song] of after.entries()) {
    const previous = before[index];
    assert.equal(songHref(song.id), songHref(previous.id));
    if (!touched.has(song.id)) {
      assert.deepEqual(song, previous);
      continue;
    }
    const { karaoke, ...identity } = song;
    const { karaoke: oldNumbers, ...oldIdentity } = previous;
    assert.deepEqual(identity, oldIdentity);
    for (const provider of ['tj', 'ky']) {
      assert.equal(oldNumbers[provider].status, 'observed-unverified');
      assert.equal(karaoke[provider].status, 'provider-confirmed');
      assert.equal(karaoke[provider].observedNumber, oldNumbers[provider].observedNumber);
      assert.equal(typeof karaoke[provider].observedNumber, 'string');
      assert.equal(karaoke[provider].conflict, false);
      const entry = ledger.entries.slice(63, 71).find(entry => entry.songId === song.id && entry.provider === provider);
      const { responseSha256, ...publicEvidence } = entry.evidence;
      assert.deepEqual(karaoke[provider].evidence, publicEvidence);
    }
  }
  const otherPerformer = after.find(song => song.id === 'jpop-playlist-ado-ト-ライフラワ-683c11a736');
  assert.equal(otherPerformer.titleOriginal, 'ドライフラワー');
  assert.equal(otherPerformer.karaoke.tj.status, 'observed-unverified');
  assert.equal(otherPerformer.karaoke.tj.evidence, null);
  assert.equal(otherPerformer.karaoke.ky.status, 'unknown');
  assert.equal(otherPerformer.karaoke.ky.observedNumber, null);
  assert.equal(JSON.stringify(after).includes('"unlisted"'), false);
});
