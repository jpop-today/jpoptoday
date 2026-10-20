import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyChartBothDiscovery } from '../scripts/verify-dist.mjs';
import { numericEvidence, rawProviderIds, publicProviderIds } from '../e2e/helpers/chart-confirmed-oracle.ts';

// Synthetic acceptance examples only: no provider observations or live dates.
// Expected row membership is declared explicitly, never derived by an app helper.
const escape = value => String(value).replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const unknown = () => ({ status: 'unknown', observedNumber: null, conflict: false, evidence: null });
function confirmed(provider, number) {
  return { status: 'provider-confirmed', observedNumber: number, conflict: false, evidence: {
    url: provider === 'tj'
      ? `https://www.tjmedia.com/song/accompaniment_search?nationType=JPN&strType=16&searchTxt=${number}&strWord=Y`
      : `https://kygabang.com/chart/search_list.php?mode=SongSearch&val=${number}`,
    checkedAt: '2001-01-01', title: 'Synthetic title', artist: 'Synthetic artist',
  } };
}
function fixture() {
  const songs = Array.from({ length: 100 }, (_, index) => ({
    id: index === 0 ? '001' : index === 1 ? '1' : `fixture-${index + 1}`,
    titleOriginal: index === 0 ? '同じ & 別の歌' : `Synthetic title ${index + 1}`,
    artistOriginal: index === 0 ? '共演 A & B' : `Synthetic artist ${index + 1}`,
    origin: 'playlist', availability: 'current', karaoke: { tj: unknown(), ky: unknown() },
  }));
  songs[0].karaoke = { tj: confirmed('tj', '00123'), ky: confirmed('ky', '00987') };
  songs[1].karaoke = { tj: confirmed('tj', '123'), ky: confirmed('ky', '987') };
  songs[2].karaoke.tj = confirmed('tj', '111');
  songs[3].karaoke.ky = confirmed('ky', '222');
  for (let index = 4; index <= 8; index++) songs[index].karaoke = { tj: confirmed('tj', String(300 + index)), ky: confirmed('ky', String(600 + index)) };
  songs[4].availability = 'archived'; songs[5].origin = 'chart-only';
  songs[6].karaoke.tj.conflict = true;
  songs[7].karaoke.ky.status = 'observed-unverified';
  songs[8].karaoke.ky.evidence.url += '&val=608';
  return { songs, chart: { songs: songs.map((song, index) => ({ rank: index + 1, canonicalId: song.id })) } };
}
function shortcut(song, rank) {
  return `<a data-chart-shortcut="both" data-song-id="${escape(song.id)}" data-chart-rank="${rank}" href="#chart-${escape(song.id)}" aria-describedby="chart-both-note"><span class="shortcut-rank">${rank}<span>위</span></span><span class="shortcut-identity"><strong>${escape(song.titleOriginal)}</strong><span>${escape(song.artistOriginal)}</span><span class="shortcut-both-numbers">${['tj', 'ky'].map(provider => `<span data-chart-confirmed-number="${song.karaoke[provider].observedNumber}" data-provider="${provider}">${provider === 'tj' ? 'TJ' : '금영'} ${song.karaoke[provider].observedNumber} · 공식 확인</span>`).join('')}</span></span></a>`;
}
const count = number => `<dd data-chart-count="both" data-count="${number}">${number}<span>곡 / 100곡</span></dd>`;
const note = '<p id="chart-both-note">같은 곡의 두 업체 근거이며 원 TJ 순위입니다. 0은 공식 미수록이 아닙니다.</p>';
function panel(songs, indexes = [0, 1]) {
  return `<details data-chart-provider="both" data-chart-both-disclosure><summary id="chart-both-heading" aria-describedby="chart-both-note">TJ·금영 모두 확인된 곡 <span>${indexes.length}곡</span> 목록 열기·닫기</summary><nav aria-describedby="chart-both-note">${indexes.map(index => shortcut(songs[index], index + 1)).join('')}</nav></details>`;
}
function page(songs, indexes = [0, 1]) {
  return `<article>${count(indexes.length)}${note}${panel(songs, indexes)}<ol class="chart-list">${songs.map((song, index) => `<li class="chart-entry" id="chart-${escape(song.id)}" data-chart-rank="${index + 1}"><span class="chart-rank">${index + 1}</span></li>`).join('')}</ol></article>`;
}
const reject = (html, data = fixture()) => assert.throws(() => verifyChartBothDiscovery(html, data.songs, data.chart), /chart both:/);

test('synthetic frozen100 accepts exact mixed intersection, distinct string IDs and leading-zero numbers without mutation', () => {
  const data = fixture(), before = structuredClone(data);
  assert.deepEqual(verifyChartBothDiscovery(page(data.songs), data.songs, data.chart), { both: 2, chartRows: 100 });
  assert.deepEqual(data, before); assert.equal(data.songs[0].id, '001'); assert.equal(data.songs[1].id, '1');
  assert.equal(data.songs[0].karaoke.tj.observedNumber, '00123');
});

test('zero cohort and separate one-provider IDs never turn into a shared song', () => {
  const data = fixture();
  for (const song of data.songs) song.karaoke = { tj: unknown(), ky: unknown() };
  data.songs[0].karaoke.tj = confirmed('tj', '00123'); data.songs[1].karaoke.ky = confirmed('ky', '00987');
  assert.deepEqual(verifyChartBothDiscovery(page(data.songs, []), data.songs, data.chart), { both: 0, chartRows: 100 });
  reject(page(data.songs, [0]), data);
});

test('malformed frozen membership or duplicate catalog IDs must fail', async t => {
  for (const [name, change] of [
    ['missing chart row', d => d.chart.songs.pop()],
    ['duplicate canonical ID', d => { d.chart.songs[1].canonicalId = d.chart.songs[0].canonicalId; }],
    ['nonsequential rank', d => { d.chart.songs[1].rank = 1; }],
    ['missing catalog ID', d => d.songs.pop()],
    ['duplicate catalog ID', d => d.songs.push(structuredClone(d.songs[0]))],
  ]) await t.test(name, () => { const data = fixture(), html = page(data.songs); change(data); reject(html, data); });
});

test('current/playlist/full numeric evidence and nonconflict are all required', async t => {
  for (const index of [2, 3, 4, 5, 6, 7, 8]) await t.test(`ineligible frozen rank ${index + 1}`, () => {
    const data = fixture(); reject(page(data.songs, [0, 1, index]), data);
  });
});

test('counts and summary cannot be spoofed by correct metadata with wrong visible text', async t => {
  const data = fixture(), html = page(data.songs);
  for (const [name, changed] of [
    ['union instead of intersection', html.replace(count(2), count(4))],
    ['metadata-only right count', html.replace('>2<span>곡 / 100곡', '>4<span>곡 / 100곡')],
    ['wrong denominator', html.replace('곡 / 100곡', '곡 / 99곡')],
    ['missing count', html.replace(count(2), '')],
    ['duplicate count', html.replace(count(2), count(2).repeat(2))],
    ['summary numeric prefix', html.replace('<span>2곡</span>', '<span>12곡</span>')],
    ['summary extra number', html.replace('<span>2곡</span>', '<span>2곡 2</span>')],
    ['wrong summary label', html.replace('TJ·금영 모두 확인된 곡', 'TJ에서 확인된 곡')],
    ['summary not first child', html.replace('<summary ', '<p>not the native toggle</p><summary ')],
  ]) await t.test(name, () => reject(changed, data));
});

test('shortcuts preserve exact ID, rank, ordering, anchor, visible identity and both number strings', async t => {
  const data = fixture(), html = page(data.songs), first = shortcut(data.songs[0], 1), second = shortcut(data.songs[1], 2);
  for (const [name, changed] of [
    ['wrong ID', html.replace('data-song-id="001"', 'data-song-id="1"')],
    ['wrong rank attribute', html.replace('data-chart-rank="1"', 'data-chart-rank="2"')],
    ['wrong visible rank', html.replace('>1<span>위', '>2<span>위')],
    ['reverse order', html.replace(first + second, second + first)],
    ['wrong anchor', html.replace('href="#chart-001"', 'href="#chart-1"')],
    ['wrong full title', html.replace('<strong>同じ &amp; 別の歌</strong>', '<strong>別の歌</strong>')],
    ['wrong full artist', html.replace('<span>共演 A &amp; B</span>', '<span>共演 A</span>')],
    ['drop leading zero attribute', html.replace('data-chart-confirmed-number="00123"', 'data-chart-confirmed-number="123"')],
    ['drop leading zero visible', html.replace('>TJ 00123 ·', '>TJ 123 ·')],
    ['missing KY cell', html.replace('<span data-chart-confirmed-number="00987" data-provider="ky">금영 00987 · 공식 확인</span>', '')],
    ['wrong provider', html.replace('data-provider="ky"', 'data-provider="tj"')],
    ['duplicate shortcut', html.replace(first, first.repeat(2))],
    ['shortcut outside native panel', html.replace(first, '').replace('</details>', '</details>' + first)],
    ['wrong original row anchor', html.replace('id="chart-001"', 'id="chart-1"')],
    ['missing original row', html.replace(/<li class="chart-entry" id="chart-001"[\s\S]*?<\/li>/, '')],
  ]) await t.test(name, () => reject(changed, data));
});

test('hidden or inert proof cannot stand in for a usable count, disclosure, title or provider cell', async t => {
  const data = fixture(), html = page(data.songs);
  const wrap = (target, tag, attributes = '') => html.replace(target, `<${tag} ${attributes}>${target}</${tag}>`);
  for (const [name, changed] of [
    ['commented count', html.replace(count(2), `<!--${count(2)}-->`)],
    ['template count', wrap(count(2), 'template')],
    ['hidden disclosure', html.replace('<details ', '<details hidden ')],
    ['inert disclosure', html.replace('<details ', '<details inert ')],
    ['aria-hidden summary', html.replace('<summary ', '<summary aria-hidden="true" ')],
    ['display-none title', html.replace('<strong>', '<strong style="display:none">')],
    ['visibility-hidden provider', html.replace('data-provider="tj"', 'data-provider="tj" style="visibility:hidden"')],
    ['closed outer disclosure', html.replace(panel(data.songs), `<details><summary>unrelated toggle</summary>${panel(data.songs)}</details>`)],
  ]) await t.test(name, () => reject(changed, data));
});

test('native disclosure contract includes closed default, a single keyboard summary and visible scope note', async t => {
  const data = fixture(), html = page(data.songs);
  for (const [name, changed] of [
    ['open default expands the optional list', html.replace('<details ', '<details open ')],
    ['duplicate summary', html.replace('</summary>', '</summary><summary>second toggle</summary>')],
    ['summary removed from tab order', html.replace('<summary ', '<summary tabindex="-1" ')],
    ['missing visible scope note', html.replace(note, '')],
    ['summary scope link missing', html.replace('aria-describedby="chart-both-note"', '')],
  ]) await t.test(name, () => reject(changed, data));
});

test('test-only numeric evidence model preserves leading zeros and rejects ambiguous URLs and missing identity', async t => {
  const tj = confirmed('tj', '00123'), ky = confirmed('ky', '00987');
  assert.ok(numericEvidence('tj', '00123', tj.evidence)); assert.ok(numericEvidence('ky', '00987', ky.evidence));
  for (const [name, evidence] of [
    ['different number', { ...tj.evidence, url: tj.evidence.url.replace('00123', '123') }],
    ['duplicate query', { ...tj.evidence, url: tj.evidence.url + '&searchTxt=00123' }],
    ['extra key', { ...tj.evidence, url: tj.evidence.url + '&extra=1' }],
    ['fragment', { ...tj.evidence, url: tj.evidence.url + '#proof' }],
    ['wrong host', { ...tj.evidence, url: tj.evidence.url.replace('tjmedia.com', 'tjmedia.com.evil.invalid') }],
    ['userinfo', { ...tj.evidence, url: tj.evidence.url.replace('www.tjmedia.com', 'user@www.tjmedia.com') }],
    ['missing full title', { ...tj.evidence, title: '' }],
    ['missing full artist', { ...tj.evidence, artist: '' }],
    ['invalid date', { ...tj.evidence, checkedAt: 'not-a-date' }],
  ]) await t.test(name, () => assert.equal(numericEvidence('tj', '00123', evidence), false));
});

test('test-only raw oracle counts duplicates outside the playlist and applies suppression before counting', () => {
  const data = fixture(), only = structuredClone(data.songs.slice(0, 2));
  const entries = only.map(song => ({ songId: song.id, provider: 'tj', action: 'confirm', number: song.karaoke.tj.observedNumber, evidence: song.karaoke.tj.evidence }));
  assert.deepEqual([...rawProviderIds(only, entries, 'tj')], ['001', '1']);
  assert.deepEqual([...publicProviderIds(only, 'tj')], ['001', '1']);
  const duplicate = structuredClone(only[0]); duplicate.id = 'outside-playlist'; duplicate.origin = 'chart-only'; duplicate.availability = 'archived';
  only.push(duplicate); assert.deepEqual([...rawProviderIds(only, entries, 'tj')], ['1']);
  entries.push({ songId: duplicate.id, provider: 'tj', action: 'suppress', number: null, evidence: null });
  assert.deepEqual([...rawProviderIds(only, entries, 'tj')], ['001', '1']);
});
