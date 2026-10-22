import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { buildPublicCatalog } from '../contracts/public-catalog.mjs';
import { applyProviderCorrections } from '../contracts/provider-corrections.mjs';
import { loadGuides } from '../contracts/guides.mjs';
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

test('the original six published guide paths keep their reviewed dates and Issue51 setlist facts after the markdown move', () => {
  // Guides moved from src/content/guides.ts to markdown in Phase 4; object hashes no longer apply.
  const guides = loadGuides().filter(guide => !guide.draft);
  const slugs = new Set(guides.map(guide => guide.slug));
  for (const slug of ['build-your-setlist', 'checking-song-numbers', 'find-japanese-songs', 'read-tj-chart', 'title-artist-variants', 'tj-ky-numbers'])
    assert.ok(slugs.has(slug), `${slug} stays published`);
  assert.equal(guides.find(guide => guide.slug === 'read-tj-chart').reviewedAt, '2026-10-20');
  // Issue51 intentionally extends this existing guide with a distinct ID backup.
  const setlist = guides.find(guide => guide.slug === 'build-your-setlist');
  assert.equal(setlist.reviewedAt, '2026-10-21');
  const setlistText = JSON.stringify(setlist);
  for (const fact of ['256KiB', 'JSON', '곡 식별자', '기존', '자동']) assert.ok(setlistText.includes(fact), fact);
});
