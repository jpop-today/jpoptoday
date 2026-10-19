import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { verifyBothProviderDiscovery } from '../scripts/verify-dist.mjs';

// Synthetic policy examples, never provider observations. Expected membership and
// counts below are stated explicitly; no app predicate/group/count helper is used.
const escape = text => String(text).replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const anchor = name => 'artist-' + createHash('sha256').update(name, 'utf8').digest('hex').slice(0, 16);
const unknown = () => ({ status: 'unknown', observedNumber: null, conflict: false, evidence: null, correction: null });
function confirmed(provider, number) {
  return {
    status: 'provider-confirmed', observedNumber: number, conflict: false, correction: null,
    evidence: {
      url: provider === 'tj'
        ? `https://www.tjmedia.com/song/accompaniment_search?nationType=JPN&strType=16&searchTxt=${number}&strWord=Y`
        : `https://www.kygabang.com/chart/search_list.php?mode=SongSearch&val=${number}`,
      checkedAt: '2001-01-01', title: 'Synthetic title', artist: 'Synthetic artist',
    },
  };
}
function song(id, artistOriginal, tj, ky, overrides = {}) {
  return { id, artistOriginal, availability: 'current', origin: 'playlist', karaoke: { tj, ky }, ...overrides };
}
function fixture() {
  const conflict = confirmed('tj', '777'); conflict.conflict = true;
  const observed = { ...confirmed('tj', '888'), status: 'observed-unverified' };
  const wrongUrl = confirmed('tj', '00123'); wrongUrl.evidence.url = wrongUrl.evidence.url.replace('00123', '123');
  return [
    song('001', '共演 A & B', confirmed('tj', '00123'), confirmed('ky', '00987')),
    song('1', '共演 A & B', confirmed('tj', '123'), confirmed('ky', '987')),
    song('different-label', '共演 A&B', confirmed('tj', '456'), confirmed('ky', '654')),
    song('tj-only', 'TJ solo', confirmed('tj', '111'), unknown()),
    song('ky-only', 'KY solo', unknown(), confirmed('ky', '222')),
    song('conflict', 'Conflict pending', conflict, confirmed('ky', '333')),
    song('unreviewed', 'Observed pending', observed, confirmed('ky', '444')),
    song('url-mismatch', 'URL pending', wrongUrl, confirmed('ky', '555')),
    song('archived', 'Excluded archived', confirmed('tj', '666'), confirmed('ky', '666'), { availability: 'archived' }),
    song('chart-only', 'Excluded chart', confirmed('tj', '7777'), confirmed('ky', '7777'), { origin: 'chart-only' }),
    song('unknown', 'Excluded unknown', unknown(), unknown()),
    song('both-unreviewed', 'Excluded unreviewed', { ...observed }, { ...observed }),
  ];
}
const expectedGroups = [
  ['共演 A & B', 2], ['共演 A&B', 1], ['TJ solo', 0], ['KY solo', 0],
  ['Conflict pending', 0], ['Observed pending', 0], ['URL pending', 0],
];
const count = (scope, number, tag = 'span') => `<${tag} data-provider-count="${scope}" data-provider="both" data-count="${number}">TJ·금영 모두 <strong>${number}</strong>개 ID</${tag}>`;
const searchLink = '<a href="/search/?number=confirmed-tj&amp;number=confirmed-ky" data-confirmed-both-search>TJ·금영 모두 확인된 곡 검색</a>';
function page(groups = expectedGroups, total = 3, link = searchLink) {
  return `<article>${count('global', total, 'dd')}${link}<nav>${groups.map(([name, number]) => `<a href="#${anchor(name)}" data-artist-index="${anchor(name)}"><span>${escape(name)}</span>${count('index', number)}</a>`).join('')}</nav><div>${groups.map(([name, number]) => `<section id="${anchor(name)}" data-artist-group data-artist-name="${escape(name)}"><header><h2>${escape(name)}</h2>${count('group', number)}</header><ul></ul></section>`).join('')}</div></article>`;
}
const reject = (html, songs = fixture()) => assert.throws(() => verifyBothProviderDiscovery(html, songs), /artists:/);

test('explicit mixed fixture counts three strict shared IDs and preserves zero groups, exact labels, leading zeros and data', () => {
  const songs = fixture(), before = structuredClone(songs);
  assert.deepEqual(verifyBothProviderDiscovery(page(), songs), { both: 3, artists: 7 });
  assert.deepEqual(songs, before);
  assert.equal(songs[0].id, '001'); assert.equal(songs[1].id, '1');
  assert.equal(songs[0].karaoke.tj.observedNumber, '00123');
});

test('all ineligible data has a real zero total and no artificial artist group', () => {
  assert.deepEqual(verifyBothProviderDiscovery(page([], 0), fixture().slice(8)), { both: 0, artists: 0 });
  assert.deepEqual(verifyBothProviderDiscovery(page([], 0), []), { both: 0, artists: 0 });
});

test('two separate single-provider songs stay zero instead of becoming one both-provider song', () => {
  const songs = [song('one', 'Same name', confirmed('tj', '123'), unknown()), song('two', 'Same name', unknown(), confirmed('ky', '456'))];
  assert.deepEqual(verifyBothProviderDiscovery(page([['Same name', 0]], 0), songs), { both: 0, artists: 1 });
  reject(page([['Same name', 1]], 1), songs);
});

test('query order, encoded ampersands and group order do not change the intersection', () => {
  const reordered = searchLink.replace('number=confirmed-tj&amp;number=confirmed-ky', 'number=confirmed-ky&amp;number=confirmed-tj');
  assert.deepEqual(verifyBothProviderDiscovery(page([...expectedGroups].reverse(), 3, reordered), fixture()), { both: 3, artists: 7 });
});

test('input duplication must fail instead of inflating or silently deduplicating stable IDs', () => {
  const songs = fixture(); songs.push(structuredClone(songs[0]));
  reject(page(), songs);
});

test('intersection counts cannot be replaced by union, sum, metadata-only or duplicate visible numbers', async t => {
  const cases = [
    ['global union', page().replace(count('global', 3, 'dd'), count('global', 8, 'dd'))],
    ['global provider sum', page().replace(count('global', 3, 'dd'), count('global', 11, 'dd'))],
    ['index union', page().replace(count('index', 0), count('index', 1))],
    ['group union', page().replace(count('group', 0), count('group', 1))],
    ['right metadata wrong visible', page().replace('<strong>3</strong>', '<strong>8</strong>')],
    ['right visible wrong metadata', page().replace('data-count="3"', 'data-count="8"')],
    ['two visible global numbers', page().replace('<strong>3</strong>', '<strong>3</strong> 3')],
    ['missing global count', page().replace(count('global', 3, 'dd'), '')],
    ['duplicate global count', page().replace(count('global', 3, 'dd'), count('global', 3, 'dd').repeat(2))],
    ['duplicate index count', page().replace(count('index', 2), count('index', 2).repeat(2))],
    ['duplicate group count', page().replace(count('group', 2), count('group', 2).repeat(2))],
    ['extra misplaced count', page() + count('global', 3)],
  ];
  for (const [name, html] of cases) await t.test(name, () => reject(html));
});

test('artist groups and usable anchors must preserve each exact original name', async t => {
  const id = anchor('共演 A & B'), changed = anchor('Other artist');
  const indexStart = `<a href="#${id}" data-artist-index="${id}">`;
  const groupStart = `<section id="${id}" data-artist-group data-artist-name="共演 A &amp; B">`;
  const cases = [
    ['missing index', page().replace(new RegExp(`<a href="#${id}"[\\s\\S]*?<\\/a>`), '')],
    ['missing group', page().replace(new RegExp(`<section id="${id}"[\\s\\S]*?<\\/section>`), '')],
    ['broken index anchor', page().replace(indexStart, indexStart.replace(`href="#${id}"`, 'href="#absent"'))],
    ['outside index route', page().replace(indexStart, indexStart.replace(`href="#${id}"`, `href="/search/#${id}"`))],
    ['unknown artist hash', page().replaceAll(id, changed)],
    ['duplicate group identities', page().replaceAll(anchor('共演 A&B'), id)],
    ['wrong displayed index name', page().replace('<span>共演 A &amp; B</span>', '<span>別の歌手</span>')],
    ['wrong displayed group name', page().replace('<h2>共演 A &amp; B</h2>', '<h2>別の歌手</h2>')],
    ['wrong group name attribute', page().replace(groupStart, groupStart.replace('共演 A &amp; B', '別の歌手'))],
  ];
  for (const [name, html] of cases) await t.test(name, () => reject(html));
});

test('the both search control is exactly one real AND search anchor', async t => {
  const href = '/search/?number=confirmed-tj&amp;number=confirmed-ky';
  const cases = [
    ['missing control', ''],
    ['empty control label', searchLink.replace('TJ·금영 모두 확인된 곡 검색', '')],
    ['non-anchor imitation', searchLink.replace('<a ', '<span ').replace('</a>', '</span>')],
    ['duplicate controls', searchLink.repeat(2)],
    ['missing href', searchLink.replace(` href="${href}"`, '')],
    ['broken route', searchLink.replace('/search/?', '/missing/?')],
    ['single provider only', searchLink.replace('&amp;number=confirmed-ky', '')],
    ['duplicate same provider', searchLink.replace('confirmed-ky', 'confirmed-tj')],
    ['third provider value', searchLink.replace('confirmed-ky', 'confirmed-ky&amp;number=has-tj')],
    ['external search origin', searchLink.replace('/search/?', 'https://example.com/search/?')],
    ['hash-only context', searchLink.replace('confirmed-ky"', 'confirmed-ky#absent"')],
    ['unexpected search condition', searchLink.replace('confirmed-ky"', 'confirmed-ky&amp;q=unrelated"')],
  ];
  for (const [name, link] of cases) await t.test(name, () => reject(page(expectedGroups, 3, link)));
});

test('required visible counts and search action cannot be hidden from users', async t => {
  const cases = [
    ['hidden global count', page().replace('<dd data-provider-count=', '<dd hidden data-provider-count=')],
    ['hidden index count', page().replace('<span data-provider-count="index"', '<span hidden data-provider-count="index"')],
    ['hidden group count', page().replace('<span data-provider-count="group"', '<span hidden data-provider-count="group"')],
    ['hidden search control', page(expectedGroups, 3, searchLink.replace('<a ', '<a hidden '))],
    ['hidden search label', page(expectedGroups, 3, searchLink.replace('TJ·금영 모두 확인된 곡 검색', '<span hidden>TJ·금영 모두 확인된 곡 검색</span>'))],
  ];
  for (const [name, html] of cases) await t.test(name, () => reject(html));
});
