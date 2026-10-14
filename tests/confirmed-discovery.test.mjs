import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildConfirmedArtistGroups, confirmedNumbers } from '../contracts/confirmed-discovery.mjs';
import { buildPublicCatalog, songHref } from '../contracts/public-catalog.mjs';
import { applyProviderCorrections } from '../contracts/provider-corrections.mjs';

const officialUrl = (provider, number) => provider === 'tj'
  ? `https://www.tjmedia.com/song/accompaniment_search?nationType=JPN&strType=16&searchTxt=${number}&strWord=Y`
  : `https://kygabang.com/chart/search_list.php?mode=SongSearch&val=${number}`;
const confirmed = (provider = 'tj', number = '00123') => ({
  status: 'provider-confirmed', observedNumber: number, conflict: false, correction: null,
  evidence: { url: officialUrl(provider, number), checkedAt: '2026-10-14T10:00:00+09:00',
    title: '合成テストの曲', artist: '合成テストの歌手' },
});
const unknown = () => ({ status: 'unknown', observedNumber: null, conflict: false, evidence: null, correction: null });
const song = (id = 'synthetic-song', overrides = {}) => ({
  id, titleOriginal: '合成テストの曲', titleKo: '합성 테스트 곡',
  artistOriginal: '合成テストの歌手', artistKo: '합성 테스트 가수', tags: [],
  availability: 'current', origin: 'playlist', karaoke: { tj: confirmed(), ky: unknown() }, ...overrides,
});
const freeze = value => {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
};

test('only explicitly confirmed conflict-free providers are discoverable; observations never become confirmations', () => {
  for (const status of ['unknown', 'observed-unverified', 'registered', 'unlisted']) {
    const value = song(); value.karaoke.tj.status = status;
    assert.deepEqual(confirmedNumbers(value), [], status);
    assert.deepEqual(buildConfirmedArtistGroups([value]), [], status);
  }
  const value = song(); value.karaoke.ky = confirmed('ky', '00517');
  value.karaoke.tj.conflict = true;
  assert.deepEqual(confirmedNumbers(value).map(item => [item.provider, item.number]), [['ky', '00517']]);
  value.karaoke.ky.conflict = true;
  assert.deepEqual(buildConfirmedArtistGroups([value]), []);
  for (const conflict of [undefined, null, 'false', 0]) {
    const ambiguous = song(); ambiguous.karaoke.tj.conflict = conflict;
    assert.deepEqual(confirmedNumbers(ambiguous), []);
  }
});

test('confirmed decimal strings preserve leading zeros and do not coerce invalid numbers', () => {
  const value = song(); value.karaoke.ky = confirmed('ky', '00517');
  assert.deepEqual(confirmedNumbers(value).map(item => [item.provider, item.number]), [['tj', '00123'], ['ky', '00517']]);
  for (const number of [null, 123, '', ' ', '0', '0000', '-123', '+123', '1e3', '12.3', '１２３', '123\n', '12345678901']) {
    const damaged = song(); damaged.karaoke.tj.observedNumber = number;
    damaged.karaoke.tj.evidence.url = officialUrl('tj', String(number));
    assert.deepEqual(confirmedNumbers(damaged), [], String(number));
  }
});

test('status alone cannot promote absent or incomplete public title/artist/date/source evidence', () => {
  const absent = song(); absent.karaoke.tj.evidence = null;
  assert.deepEqual(confirmedNumbers(absent), []);
  for (const key of ['url', 'checkedAt', 'title', 'artist']) {
    for (const value of [undefined, null, '', '   ']) {
      const damaged = song(); damaged.karaoke.tj.evidence[key] = value;
      assert.deepEqual(confirmedNumbers(damaged), [], `${key}: ${String(value)}`);
      assert.deepEqual(buildConfirmedArtistGroups([damaged]), []);
    }
  }
});

test('archived IDs and chart-only observations remain outside current playlist artist discovery', () => {
  const current = song('current');
  const archived = song('archived', { availability: 'archived' });
  const chartOnly = song('chart-only', { origin: 'chart-only' });
  assert.deepEqual(confirmedNumbers(archived), []);
  assert.deepEqual(confirmedNumbers(chartOnly), []);
  assert.deepEqual(buildConfirmedArtistGroups([archived, chartOnly, current]).flatMap(group => group.songs.map(item => item.id)), ['current']);
});

test('official numeric lookup must match provider and string number without ambiguous or credential-bearing URLs', () => {
  const value = song();
  const url = value.karaoke.tj.evidence.url;
  const disallowed = [url.replace('https:', 'http:'), url.replace('tjmedia.com', 'tjmedia.com.evil.invalid'),
    url.replace('www.tjmedia.com', 'operator:synthetic@www.tjmedia.com'), url.replace('tjmedia.com', 'tjmedia.com:443'),
    url + '#fragment', url + '&token=synthetic', url + '&searchTxt=00123',
    url.replace('searchTxt=00123', 'searchTxt=00124'), url.replace('strType=16', 'strType=1'),
    officialUrl('ky', '00123')];
  for (const source of disallowed) {
    const damaged = song(); damaged.karaoke.tj.evidence.url = source;
    assert.deepEqual(confirmedNumbers(damaged), [], source);
  }
  value.karaoke.tj.evidence.url = 'https://tjmedia.com/song/accompaniment_search?strWord=Y&searchTxt=00123&nationType=KOR&strType=16';
  assert.equal(confirmedNumbers(value)[0].number, '00123');
});

test('invalid or duplicate song IDs fail the grouping boundary even when a duplicate row is not eligible', () => {
  assert.throws(() => buildConfirmedArtistGroups(null));
  assert.throws(() => buildConfirmedArtistGroups([song(), song()]));
  assert.throws(() => buildConfirmedArtistGroups([song(), song('synthetic-song', { availability: 'archived' })]));
  for (const id of [undefined, null, '', '   ']) assert.throws(() => buildConfirmedArtistGroups([song('invalid', { id })]));
  const missingArtist = song(); missingArtist.artistOriginal = ' ';
  assert.throws(() => buildConfirmedArtistGroups([missingArtist]));
});

test('exact original artist labels keep aliases, joint credits and casing separate', () => {
  const names = ['YOASOBI', 'Yoasobi', 'ikura', 'YOASOBI & 合成ゲスト'];
  const songs = names.map((artistOriginal, index) => song(`identity-${index}`, { artistOriginal, artistKo: '같은 한국어 별칭' }));
  const groups = buildConfirmedArtistGroups(songs);
  assert.equal(groups.length, names.length);
  assert.deepEqual(new Set(groups.map(group => group.name)), new Set(names));
  assert.equal(new Set(groups.map(group => group.id)).size, names.length);
  for (const group of groups) assert.equal(group.songs.length, 1);
});

test('same exact artist collects songs once and retains distinct Korean display names without inventing identity', () => {
  const songs = [song('one', { artistKo: '표기 하나' }), song('two', { artistKo: '표기 하나' }),
    song('three', { artistKo: '표기 둘' }), song('four', { artistKo: '' })];
  const [group] = buildConfirmedArtistGroups(songs);
  assert.equal(group.name, songs[0].artistOriginal);
  assert.deepEqual(new Set(group.namesKo), new Set(['표기 하나', '표기 둘']));
  assert.equal(group.namesKo.length, 2);
  assert.deepEqual(new Set(group.songs.map(item => item.id)), new Set(songs.map(item => item.id)));
});

test('artist fragment IDs survive reordering and append operations without becoming song IDs', () => {
  const songs = [song('first', { artistOriginal: 'A / 合成' }), song('second', { artistOriginal: 'B % 合成' })];
  const original = new Map(buildConfirmedArtistGroups(songs).map(group => [group.name, group.id]));
  const changed = buildConfirmedArtistGroups([song('third', { artistOriginal: '別の歌手' }), songs[1],
    song('fourth', { artistOriginal: songs[0].artistOriginal }), songs[0]]);
  for (const [name, id] of original) {
    assert.match(id, /^artist-[a-f0-9]+$/u);
    assert.equal(changed.find(group => group.name === name).id, id);
    assert.ok(!songs.some(item => item.id === id));
  }
});

test('frozen input metadata, string ID, URL encoding and numbers survive discovery projection', () => {
  const songs = [song('jpop-日本語-%raw', { artistOriginal: '合成 <記号> & 歌手' })];
  const bytes = JSON.stringify(songs);
  freeze(songs);
  const groups = buildConfirmedArtistGroups(songs);
  assert.equal(JSON.stringify(songs), bytes);
  assert.equal(groups[0].songs[0].id, songs[0].id);
  assert.equal(songHref(groups[0].songs[0].id), '/songs/jpop-%E6%97%A5%E6%9C%AC%E8%AA%9E-%25raw/');
  assert.equal(confirmedNumbers(groups[0].songs[0])[0].number, '00123');
  assert.deepEqual(confirmedNumbers(groups[0].songs[0])[0].evidence, songs[0].karaoke.tj.evidence);
});

test('real frozen reviewed ledger determines discoverable IDs and provider provenance independently', () => {
  const staging = JSON.parse(readFileSync(new URL('../data/staging/legacy-catalog.json', import.meta.url), 'utf8'));
  const ledger = JSON.parse(readFileSync(new URL('../data/reviewed/provider-corrections.json', import.meta.url), 'utf8'));
  const songs = applyProviderCorrections(buildPublicCatalog(staging).songs, staging, ledger);
  const rawById = new Map(staging.songs.map(item => [item.id, item]));
  const correctionByPair = new Map(ledger.entries.map(entry => [JSON.stringify([entry.songId, entry.provider]), entry]));
  const duplicates = Object.fromEntries(['tj', 'ky'].map(provider => {
    const counts = new Map();
    for (const item of staging.songs) {
      const entry = correctionByPair.get(JSON.stringify([item.id, provider]));
      const number = entry ? entry.number : item.karaoke[provider].observedNumber;
      if (number !== null) counts.set(number, (counts.get(number) ?? 0) + 1);
    }
    return [provider, counts];
  }));
  const expected = ledger.entries.filter(entry => {
    const original = rawById.get(entry.songId);
    return entry.action === 'confirm' && original.origin === 'playlist' && original.availability === 'current'
      && duplicates[entry.provider].get(entry.number) === 1;
  });
  assert.ok(expected.length > 0, 'Actual reviewed ledger must supply evidence, never a synthetic publication');
  const groups = buildConfirmedArtistGroups(songs);
  const discovered = groups.flatMap(group => group.songs);
  assert.deepEqual(new Set(discovered.map(item => item.id)), new Set(expected.map(entry => entry.songId)));
  assert.equal(discovered.length, new Set(discovered.map(item => item.id)).size);
  assert.equal(new Set(groups.map(group => group.name)).size, groups.length);
  for (const group of groups) for (const item of group.songs) {
    assert.equal(item.artistOriginal, group.name);
    assert.equal(songHref(item.id), songHref(rawById.get(item.id).id));
    for (const result of confirmedNumbers(item)) {
      const entry = expected.find(value => value.songId === item.id && value.provider === result.provider);
      assert.ok(entry);
      assert.equal(result.number, entry.number);
      assert.deepEqual(result.evidence, { url: entry.evidence.url, checkedAt: entry.evidence.checkedAt,
        title: entry.evidence.title, artist: entry.evidence.artist });
    }
  }
  assert.equal(discovered.reduce((count, item) => count + confirmedNumbers(item).length, 0), expected.length);
});
