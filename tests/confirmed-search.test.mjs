import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildPublicCatalog, matchesSong, songHref } from '../contracts/public-catalog.mjs';
import { applyProviderCorrections } from '../contracts/provider-corrections.mjs';
import { createIdentityResolver, readFavorites, resolveLegacyUrl } from '../contracts/legacy-compatibility.mjs';

const lookup = (provider, number) => provider === 'tj'
  ? `https://www.tjmedia.com/song/accompaniment_search?nationType=JPN&strType=16&searchTxt=${number}&strWord=Y`
  : `https://kygabang.com/chart/search_list.php?mode=SongSearch&val=${number}`;
const provider = (name, number) => ({ status: 'provider-confirmed', observedNumber: number, conflict: false,
  evidence: { url: lookup(name, number), checkedAt: '2026-10-14T10:00:00+09:00', title: '合成の曲', artist: '合成の歌手' }, correction: null });
const unknown = () => ({ status: 'unknown', observedNumber: null, conflict: false, evidence: null, correction: null });
const song = (id = 'synthetic-confirmed-search') => ({ id, titleOriginal: '合成の曲', titleKo: '합성 테스트',
  artistOriginal: '合成の歌手', artistKo: '합성 가수', tags: ['애니메이션:합성', '가수:합성 가수'],
  availability: 'current', origin: 'playlist', karaoke: { tj: provider('tj', '00123'), ky: unknown() } });
const params = (...numbers) => new URLSearchParams(numbers.map(number => ['number', number]));
const clone = value => structuredClone(value);
const freeze = value => {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
};

test('confirmed provider filters distinguish a single provider from their AND intersection', () => {
  const tj = song('tj-only'), ky = song('ky-only'), both = song('both');
  ky.karaoke = { tj: unknown(), ky: provider('ky', '00517') };
  both.karaoke.ky = provider('ky', '00517');
  for (const [value, expected] of [[tj, [true, false, false]], [ky, [false, true, false]], [both, [true, true, true]]]) {
    assert.deepEqual([matchesSong(value, params('confirmed-tj')), matchesSong(value, params('confirmed-ky')),
      matchesSong(value, params('confirmed-tj', 'confirmed-ky'))], expected, value.id);
  }
  assert.equal(matchesSong(both, params('confirmed-ky', 'confirmed-tj', 'confirmed-ky')), true);
  assert.equal(tj.karaoke.tj.observedNumber, '00123');
  assert.equal(ky.karaoke.ky.observedNumber, '00517');
});

test('a displayed observed number never satisfies official confirmation, including suppression and conflicts', () => {
  for (const name of ['tj', 'ky']) {
    const baseline = song(); baseline.karaoke[name] = provider(name, '00123');
    for (const status of ['unknown', 'observed-unverified', 'registered', 'unlisted']) {
      const value = clone(baseline); value.karaoke[name].status = status;
      assert.equal(matchesSong(value, params(`confirmed-${name}`)), false, `${name}/${status}`);
    }
    for (const conflict of [true, undefined, null, 'false', 0]) {
      const value = clone(baseline); value.karaoke[name].conflict = conflict;
      assert.equal(matchesSong(value, params(`confirmed-${name}`)), false, `${name}/conflict=${String(conflict)}`);
    }
    const suppressed = clone(baseline);
    suppressed.karaoke[name] = { ...unknown(), correction: { reason: '합성 버전 불일치', previousNumber: '00123' } };
    assert.equal(matchesSong(suppressed, params(`confirmed-${name}`)), false);
    for (const metadata of [{ availability: 'archived' }, { origin: 'chart-only' }]) {
      assert.equal(matchesSong({ ...baseline, ...metadata }, params(`confirmed-${name}`)), false, JSON.stringify(metadata));
    }
  }
});

test('missing evidence and malformed or mismatched numeric provenance fail closed for both providers', () => {
  for (const name of ['tj', 'ky']) {
    const baseline = song(); baseline.karaoke[name] = provider(name, '00123');
    const absent = clone(baseline); absent.karaoke[name].evidence = null;
    assert.equal(matchesSong(absent, params(`confirmed-${name}`)), false);
    for (const key of ['url', 'checkedAt', 'title', 'artist']) for (const replacement of [undefined, null, '', ' ', 1]) {
      const value = clone(baseline); value.karaoke[name].evidence[key] = replacement;
      assert.equal(matchesSong(value, params(`confirmed-${name}`)), false, `${name}/${key}/${String(replacement)}`);
    }
    for (const number of [null, 123, '0', '0000', '-123', '１２３', '123\n', '12345678901']) {
      const value = clone(baseline); value.karaoke[name].observedNumber = number;
      value.karaoke[name].evidence.url = lookup(name, String(number));
      assert.equal(matchesSong(value, params(`confirmed-${name}`)), false, `${name}/${String(number)}`);
    }
    const source = lookup(name, '00123');
    for (const url of [lookup(name, '00124'), lookup(name === 'tj' ? 'ky' : 'tj', '00123'),
      source.replace('https:', 'http:'), source.replace('.com/', '.com.evil.invalid/'),
      source.replace('https://', 'https://operator:synthetic@'), `${source}#fragment`, `${source}&token=synthetic`,
      source + (name === 'tj' ? '&searchTxt=00123' : '&val=00123')]) {
      const value = clone(baseline); value.karaoke[name].evidence.url = url;
      assert.equal(matchesSong(value, params(`confirmed-${name}`)), false, `${name}/${url}`);
    }
  }
});

test('new confirmations compose with existing q, observed has/only, tags and artist/anime semantics', () => {
  const value = song();
  assert.equal(matchesSong(value, new URLSearchParams('q=합성+00123&number=confirmed-tj&number=only-tj&tag=애니메이션:합성&anime=all&artist=all')), true);
  for (const query of ['q=다른곡&number=confirmed-tj', 'number=confirmed-tj&number=has-ky',
    'number=confirmed-tj&tag=없는태그', 'number=confirmed-tj&number=only-ky']) {
    assert.equal(matchesSong(value, new URLSearchParams(query)), false, query);
  }
  value.karaoke.ky = { ...provider('ky', '00517'), status: 'observed-unverified', evidence: null };
  assert.equal(matchesSong(value, params('confirmed-tj', 'has-ky')), true, 'has-ky still means a displayed observation');
  assert.equal(matchesSong(value, params('confirmed-tj', 'only-tj')), false);
  assert.equal(matchesSong(value, params('confirmed-tj', 'confirmed-ky')), false);
  assert.equal(matchesSong(value, params('legacy-unrecognized-number-filter')), true, 'existing unknown URL values retain their no-op behavior');
});

const staging = JSON.parse(readFileSync(new URL('../data/staging/legacy-catalog.json', import.meta.url), 'utf8'));
const ledger = JSON.parse(readFileSync(new URL('../data/reviewed/provider-corrections.json', import.meta.url), 'utf8'));
const publicSongs = applyProviderCorrections(buildPublicCatalog(staging).songs, staging, ledger);
const rawById = new Map(staging.songs.map(value => [value.id, value]));
const corrections = new Map(ledger.entries.map(entry => [JSON.stringify([entry.songId, entry.provider]), entry]));

// Independent real-data oracle: reviewed entries plus raw origin/availability and
// post-correction duplicate counts. Do not use the matcher or confirmedNumbers.
function expectedIds(name) {
  const counts = new Map();
  for (const raw of staging.songs) {
    const entry = corrections.get(JSON.stringify([raw.id, name]));
    const number = entry ? entry.number : raw.karaoke[name].observedNumber;
    if (number !== null) counts.set(number, (counts.get(number) ?? 0) + 1);
  }
  return new Set(ledger.entries.filter(entry => {
    const raw = rawById.get(entry.songId);
    return entry.provider === name && entry.action === 'confirm' && raw.availability === 'current'
      && raw.origin === 'playlist' && counts.get(entry.number) === 1;
  }).map(entry => entry.songId));
}

test('real frozen ledger independently determines each provider and the exact intersection without fixed future counts', () => {
  const expected = { tj: expectedIds('tj'), ky: expectedIds('ky') };
  assert.ok(expected.tj.size > 0 && expected.ky.size > 0);
  for (const name of ['tj', 'ky']) {
    const actual = publicSongs.filter(value => matchesSong(value, params(`confirmed-${name}`)));
    assert.deepEqual(new Set(actual.map(value => value.id)), expected[name]);
    for (const value of actual) {
      const entry = corrections.get(JSON.stringify([value.id, name]));
      assert.equal(value.karaoke[name].observedNumber, entry.number);
      assert.equal(typeof value.karaoke[name].observedNumber, 'string');
      assert.deepEqual(value.karaoke[name].evidence, { url: entry.evidence.url, checkedAt: entry.evidence.checkedAt,
        title: entry.evidence.title, artist: entry.evidence.artist });
    }
  }
  assert.deepEqual(new Set(publicSongs.filter(value => matchesSong(value, params('confirmed-tj', 'confirmed-ky'))).map(value => value.id)),
    new Set([...expected.tj].filter(id => expected.ky.has(id))));
});

test('actual SAM/Ado deferred KY cells and original-version suppression remain counterexamples, not unlisted songs', () => {
  for (const id of ['jpop-playlist-samfree-ルカルカ-ナイトフィ-ハ-f6722acd10', 'jpop-playlist-ado-逆光-c8c1ba8b20']) {
    const value = publicSongs.find(item => item.id === id);
    assert.ok(value);
    assert.equal(value.karaoke.tj.status, 'provider-confirmed');
    assert.equal(value.karaoke.ky.status, 'observed-unverified');
    assert.equal(matchesSong(value, params('confirmed-tj')), true);
    assert.equal(matchesSong(value, params('has-ky')), true);
    assert.equal(matchesSong(value, params('confirmed-ky')), false);
    assert.equal(matchesSong(value, params('confirmed-tj', 'confirmed-ky')), false);
  }
  const originalVersion = publicSongs.find(value => value.id === 'jpop-playlist-radwimps-前前前世-original-ver-1ff3eb38b9');
  assert.ok(originalVersion);
  for (const name of ['tj', 'ky']) {
    assert.equal(originalVersion.karaoke[name].status, 'unknown');
    assert.equal(originalVersion.karaoke[name].observedNumber, null);
    assert.ok(originalVersion.karaoke[name].correction);
    assert.equal(matchesSong(originalVersion, params(`confirmed-${name}`)), false);
  }
});

test('searching frozen public songs leaves all identities, number strings and legacy storage bytes unchanged', () => {
  const values = freeze(clone(publicSongs));
  const before = JSON.stringify(values);
  const resolver = createIdentityResolver({ identities: values.map(value => ({ id: value.id })) });
  const confirmedId = [...expectedIds('tj')][0];
  const raw = JSON.stringify([{ id: confirmedId, note: 'preserve metadata' }, 'legacy-unknown-id']);
  let writes = 0;
  const state = readFavorites({ getItem: () => raw, setItem: () => { writes++; } }, resolver);
  for (const value of values) matchesSong(value, params('confirmed-tj', 'confirmed-ky'));
  assert.equal(JSON.stringify(values), before);
  assert.equal(state.raw, raw); assert.equal(writes, 0);
  assert.equal(state.entries[1].status, 'missing');
  const query = '?q=%E5%90%88%E6%88%90&number=has-tj&number=confirmed-tj&number=confirmed-ky&tag=%E3%82%A2%E3%83%8B%E3%83%A1&page=2';
  assert.equal(resolveLegacyUrl('/filter.html' + query, resolver).href, '/search/' + query);
  assert.equal(resolveLegacyUrl('/song.html?id=' + encodeURIComponent(confirmedId), resolver).href, songHref(confirmedId));
});
