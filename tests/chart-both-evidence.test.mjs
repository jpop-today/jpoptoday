import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { buildPublicCatalog } from '../contracts/public-catalog.mjs';
import { applyProviderCorrections } from '../contracts/provider-corrections.mjs';
import { guides } from '../src/content/guides.ts';
import { numericEvidence, rawProviderIds, publicProviderIds } from '../e2e/helpers/chart-confirmed-oracle.ts';

// Immutable expectations were read from committed base 4d4c021e, before this
// cohort's append. No Git history, docs checkout, network, or app count helper
// is needed by CI. This test does not claim to repeat the official lookups.
const sha = value => createHash('sha256').update(value).digest('hex');
const read = path => readFileSync(new URL('../' + path, import.meta.url), 'utf8');
const staging = JSON.parse(read('data/staging/legacy-catalog.json'));
const ledger = JSON.parse(read('data/reviewed/provider-corrections.json'));
const chart = JSON.parse(read('data/chart-snapshot.json'));
const providers = ['tj', 'ky'];
const untouchedFiles = {
  'data/staging/legacy-catalog.json': 'a3d482ca2da082852883960d200841b4ad4ff26336eaf1174c55677881eecbf3',
  'data/chart-snapshot.json': '7ade29897828967b98b2bca64b285b9694356ad3d2b97498f06270217c91da97',
  'data/legacy-identity-baseline.json': '5d882010993879420ac30bfcbbb1fcc3fe7e87a5bd00a56e5c379f41000aaec8',
  'src/styles/global.css': '64cab788adde9940627b3bb61f50bf99b0191ed984c2114ee1b2bad0c115b889',
};
const untouchedGuides = {
  'find-japanese-songs': '4c626a0f7d5a20eba6a5883327eb5e472e1d45c053a3aa16e41b3164cef2ba03',
  'tj-ky-numbers': '04c5fffe6a6d4db4e2bbc911e33526ad5f92c44d0c14de16b9b56c3734d965c8',
  'build-your-setlist': '42df98f8716128ccf7adca026641962ced062d12a33dcb264c57b4f504c26319',
  'checking-song-numbers': 'd68bd8e60c1cf7cbdde292f18ee05df6627b0d8e14d9bed1cbf25d7160cc7c5f',
  'title-artist-variants': '3d15b8cd2bebafe13050644de7d7ff79207fdb39658c2edd05e77f8fcf65bbd5',
};
const cohort = [
  [32, 'jpop-playlist-yoasobi-夜に駆ける-677d131f3f', '68381', '44656'],
  [33, 'jpop-playlist-あいみょん-マリ-コ-ルト-ebdb512207', '28927', '44314'],
  [34, 'jpop-playlist-松田聖子-青い珊瑚礁-f8e4a0a705', '27121', '40403'],
  [35, 'jpop-playlist-なとり-フ-ロホ-ス-5b000e662c', '52402', null],
];

test('Issue47 keeps every raw/chart/identity/style byte and the full ordered original92 ledger prefix', () => {
  for (const [path, hash] of Object.entries(untouchedFiles)) assert.equal(sha(read(path)), hash, path);
  assert.ok(ledger.entries.length >= 99, 'The actual seven reviewed additions must be present; later appends remain possible');
  assert.equal(sha(JSON.stringify(ledger.entries.slice(0, 92))), '73f58019ff2ad06e8a5bcb5db8f5ee254a63da038cc9afe49ce43dec410cc5ad');
  assert.deepEqual(Object.fromEntries(Object.entries(ledger).filter(([key]) => key !== 'entries')), {
    ledgerVersion: 1, purpose: 'reviewed-provider-corrections', legacyRevision: '6dbe5a65d1bd729c09393f746f715f4363089a43',
  });
});

test('the seven appended evidence cells retain exact frozen IDs, string numbers and complete official identities', () => {
  const additions = ledger.entries.slice(92, 99), expected = new Map();
  for (const [rank, id, tj, ky] of cohort) {
    assert.equal(chart.songs[rank - 1].canonicalId, id);
    const song = staging.songs.find(song => song.id === id);
    assert.equal(song.origin, 'playlist'); assert.equal(song.availability, 'current');
    for (const [provider, number] of [['tj', tj], ['ky', ky]]) {
      assert.equal(song.karaoke[provider].observedNumber, number);
      if (number !== null) expected.set(JSON.stringify([id, provider]), { song, number });
    }
  }
  assert.equal(expected.size, 7); assert.equal(additions.length, 7);
  assert.deepEqual(new Set(additions.map(entry => JSON.stringify([entry.songId, entry.provider]))), new Set(expected.keys()));
  for (const entry of additions) {
    const { song, number } = expected.get(JSON.stringify([entry.songId, entry.provider]));
    assert.equal(entry.action, 'confirm'); assert.equal(entry.expectedObservedNumber, number); assert.equal(entry.number, number);
    assert.equal(entry.evidence.title, song.titleOriginal); assert.equal(entry.evidence.artist, song.artistOriginal);
    assert.match(entry.evidence.responseSha256, /^[a-f0-9]{64}$/);
    assert.ok(numericEvidence(entry.provider, entry.number, entry.evidence));
    assert.equal(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(entry.evidence.checkedAt)), '2026-10-20');
    assert.ok(entry.reason.trim());
  }
});

test('actual projection eligibility equals independent ledger/post-correction multiplicities, including real excluded cells', () => {
  const publicSongs = applyProviderCorrections(buildPublicCatalog(staging).songs, staging, ledger);
  const sets = {};
  for (const provider of providers) {
    const expected = rawProviderIds(staging.songs, ledger.entries, provider);
    const actual = publicProviderIds(publicSongs, provider);
    assert.deepEqual(actual, expected); sets[provider] = expected;
  }
  const chartIds = new Set(chart.songs.map(row => row.canonicalId));
  const both = [...sets.tj].filter(id => sets.ky.has(id) && chartIds.has(id));
  const union = [...new Set([...sets.tj, ...sets.ky])].filter(id => chartIds.has(id));
  assert.ok(both.length > 0 && both.length < union.length, 'Real one-provider chart rows distinguish intersection from union');
  for (const [, id] of cohort.slice(0, 3)) assert.ok(both.includes(id));
  const natori = publicSongs.find(song => song.id === cohort[3][1]);
  assert.ok(sets.tj.has(natori.id)); assert.ok(!sets.ky.has(natori.id)); assert.ok(!both.includes(natori.id));
  assert.equal(natori.karaoke.ky.status, 'unknown'); assert.equal(natori.karaoke.ky.observedNumber, null);
  assert.equal(natori.karaoke.ky.evidence, null); assert.equal(natori.karaoke.ky.correction, null);
  const ambiguous = ['jpop-playlist-samfree-ルカルカ-ナイトフィ-ハ-f6722acd10', 'jpop-playlist-ado-逆光-c8c1ba8b20'];
  for (const id of ambiguous) assert.ok(!sets.ky.has(id), 'A matching TJ result cannot resolve separate KY identity uncertainty');
});

test('the five other complete guide objects and all six public guide paths retain the base contract', () => {
  assert.deepEqual(guides.map(guide => guide.slug), ['find-japanese-songs', 'tj-ky-numbers', 'build-your-setlist', 'read-tj-chart', 'checking-song-numbers', 'title-artist-variants']);
  for (const [slug, hash] of Object.entries(untouchedGuides)) {
    const matches = guides.filter(guide => guide.slug === slug); assert.equal(matches.length, 1);
    assert.equal(sha(JSON.stringify(matches[0])), hash, slug);
  }
  assert.equal(guides.find(guide => guide.slug === 'read-tj-chart').reviewedAt, '2026-10-20');
});
