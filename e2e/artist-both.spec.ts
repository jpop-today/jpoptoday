import { test, expect, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Song } from '../src/lib/catalog';

type Provider = 'tj' | 'ky';
type Evidence = NonNullable<Song['karaoke']['tj']['evidence']>;
type Entry = { songId: string; provider: Provider; action: string; number: string | null; evidence: Evidence };
const providers = ['tj', 'ky'] as const;
const staging = JSON.parse(readFileSync(new URL('../data/staging/legacy-catalog.json', import.meta.url), 'utf8')) as { songs: Song[] };
const ledger = JSON.parse(readFileSync(new URL('../data/reviewed/provider-corrections.json', import.meta.url), 'utf8')) as { entries: Entry[] };
const corrections = new Map(ledger.entries.map(entry => [JSON.stringify([entry.songId, entry.provider]), entry]));
const bothSearch = '/search/?number=confirmed-tj&number=confirmed-ky';
const anchorFor = (name: string) => 'artist-' + createHash('sha256').update(name, 'utf8').digest('hex').slice(0, 16);
const ready = (page: Page) => expect(page.locator('html')).toHaveAttribute('data-app-ready', 'true');
const confirmedButton = (page: Page, provider: Provider) => page.getByRole('button', {
  name: provider === 'tj' ? 'TJ 공식 확인' : '금영 공식 확인', exact: true,
});

// Independent provenance/number oracle: no application count, grouping, matching,
// projection or official-URL helper is imported into these tests.
function numericEvidence(provider: Provider, number: string | null, evidence: Evidence | null): boolean {
  if (typeof number !== 'string' || !/^[0-9]{1,10}$/.test(number) || /^0+$/.test(number) || !evidence
      || !['url', 'checkedAt', 'title', 'artist'].every(key => typeof evidence[key as keyof Evidence] === 'string'
        && evidence[key as keyof Evidence].trim()) || !Number.isFinite(Date.parse(evidence.checkedAt))) return false;
  let url: URL;
  try { url = new URL(evidence.url); } catch { return false; }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.port) return false;
  if (provider === 'tj') return ['www.tjmedia.com', 'tjmedia.com'].includes(url.hostname)
    && url.pathname === '/song/accompaniment_search' && url.searchParams.get('strType') === '16'
    && url.searchParams.get('searchTxt') === number && url.searchParams.get('strWord') === 'Y'
    && ['JPN', 'KOR'].includes(url.searchParams.get('nationType') ?? '');
  return url.hostname === 'kygabang.com' && url.pathname === '/chart/search_list.php'
    && url.searchParams.get('mode') === 'SongSearch' && url.searchParams.get('val') === number;
}

function publicProviderIds(songs: Song[], provider: Provider) {
  return new Set(songs.filter(song => song.origin === 'playlist' && song.availability === 'current'
    && song.karaoke[provider].status === 'provider-confirmed' && song.karaoke[provider].conflict === false
    && numericEvidence(provider, song.karaoke[provider].observedNumber, song.karaoke[provider].evidence)).map(song => song.id));
}

function reviewedProviderIds(provider: Provider) {
  const multiplicity = new Map<string, number>();
  for (const song of staging.songs) {
    const entry = corrections.get(JSON.stringify([song.id, provider]));
    const number = entry ? entry.number : song.karaoke[provider].observedNumber;
    if (number !== null) multiplicity.set(number, (multiplicity.get(number) ?? 0) + 1);
  }
  return new Set(staging.songs.filter(song => {
    const entry = corrections.get(JSON.stringify([song.id, provider]));
    return song.origin === 'playlist' && song.availability === 'current' && entry?.action === 'confirm'
      && numericEvidence(provider, entry.number, entry.evidence) && multiplicity.get(entry.number!) === 1;
  }).map(song => song.id));
}

function expectedIds(songs: Song[]) {
  expect(new Set(songs.map(song => song.id)).size).toBe(songs.length);
  expect(new Set(songs.map(song => song.id))).toEqual(new Set(staging.songs.map(song => song.id)));
  const tj = publicProviderIds(songs, 'tj'), ky = publicProviderIds(songs, 'ky');
  expect(tj, 'public TJ eligibility must match reviewed ledger and independently recomputed conflicts').toEqual(reviewedProviderIds('tj'));
  expect(ky, 'public KY eligibility must match reviewed ledger and independently recomputed conflicts').toEqual(reviewedProviderIds('ky'));
  const both = new Set([...tj].filter(id => ky.has(id))), union = new Set([...tj, ...ky]);
  expect(both.size, 'real overlap is required to distinguish intersection from an empty placeholder').toBeGreaterThan(0);
  expect(both.size, 'real one-provider songs must distinguish intersection from union').toBeLessThan(union.size);
  return { tj, ky, both, union };
}

async function verifyDirectory(page: Page, songs: Song[]) {
  const expected = expectedIds(songs), directory = songs.filter(song => expected.union.has(song.id));
  const artistNames = new Set(directory.map(song => song.artistOriginal));
  await expect(page.locator('[data-artist-group]')).toHaveCount(artistNames.size);
  await expect(page.locator('[data-directory="songs"]')).toHaveText(`${expected.union.size}개`);
  const allRows = await page.locator('.artist-song').evaluateAll(rows => rows.map(row => row.getAttribute('data-song-id')));
  expect(allRows).toHaveLength(expected.union.size);
  expect(new Set(allRows), 'no duplicate ID or alias-derived extra song').toEqual(expected.union);
  for (const scope of ['tj', 'ky', 'both'] as const) {
    const count = page.locator(`[data-provider-count="global"][data-provider="${scope}"]`);
    await expect(count).toHaveAttribute('data-count', String(expected[scope].size));
    await expect(count).toContainText(`${expected[scope].size}개 ID`);
  }
  let zeroBothGroups = 0;
  for (const name of artistNames) {
    const anchor = anchorFor(name), group = page.locator(`#${anchor}[data-artist-group]`);
    await expect(group).toHaveAttribute('data-artist-name', name);
    await expect(group.getByRole('heading', { name, exact: true, level: 2 })).toBeVisible();
    const index = page.locator(`.artist-index a[data-artist-index="${anchor}"]`);
    await expect(index).toHaveAttribute('href', `#${anchor}`);
    const groupIds = new Set(directory.filter(song => song.artistOriginal === name).map(song => song.id));
    const rows = await group.locator('.artist-song').evaluateAll(rows => rows.map(row => row.getAttribute('data-song-id')));
    expect(rows).toHaveLength(groupIds.size); expect(new Set(rows)).toEqual(groupIds);
    for (const provider of ['tj', 'ky', 'both'] as const) {
      const count = [...groupIds].filter(id => expected[provider].has(id)).length;
      for (const [scope, container] of [['index', index], ['group', group]] as const) {
        const value = container.locator(`[data-provider-count="${scope}"][data-provider="${provider}"]`);
        await expect(value).toHaveAttribute('data-count', String(count));
        const label = provider === 'both' ? 'TJ·금영 모두' : provider === 'tj' ? 'TJ' : '금영';
        await expect(value).toHaveText(`${label} ${count}${scope === 'index' ? '개 공식 확인곡 ID' : '개 ID'}`);
      }
      if (provider === 'both' && count === 0) zeroBothGroups++;
    }
  }
  expect(zeroBothGroups, 'real single-provider group retains a meaningful both=0 state').toBeGreaterThan(0);
  await expect(page.locator('#provider-count-note')).toContainText('공식 미수록을 뜻하지 않습니다');
  await expect(page.locator('[data-confirmed-both-search]')).toHaveAttribute('href', bothSearch);
  return expected;
}

async function visibleResultIds(page: Page) {
  const rows = page.locator('#song-list > [data-song-id]'), more = page.getByRole('button', { name: '더 보기', exact: true });
  for (let attempt = 0; await more.isVisible(); attempt++) {
    expect(attempt).toBeLessThan(staging.songs.length);
    const before = await rows.count(); await more.click();
    await expect.poll(() => rows.count()).toBeGreaterThan(before);
  }
  return rows.evaluateAll(rows => rows.map(row => row.getAttribute('data-song-id')!));
}

const observeProblems = (page: Page) => {
  const problems: string[] = [];
  page.on('pageerror', () => problems.push('pageerror'));
  page.on('console', message => { if (['warning', 'error'].includes(message.type())) problems.push(`console-${message.type()}`); });
  page.on('request', request => { if (/googlesyndication|doubleclick|googleadservices/.test(request.url())) problems.push('ad-request'); });
  return problems;
};

test('both-provider counts equal the independent real intersection in every static artist group and index', async ({ page, request }) => {
  const catalog = await (await request.get('/catalog.json')).json() as { songs: Song[] };
  const build = await (await request.get('/build-info.json')).json(), problems = observeProblems(page);
  await page.goto('/artists/');
  await expect(page).toHaveTitle('가수별 공식 확인곡 | jpop.today');
  await expect(page.locator('h1')).toHaveText('가수별 공식 확인곡');
  await expect(page.locator('main')).not.toBeEmpty();
  await expect(page.locator('astro-error-overlay, vite-error-overlay')).toHaveCount(0);
  await expect(page.locator('body')).not.toContainText('Internal Server Error');
  await verifyDirectory(page, catalog.songs);
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', 'https://jpop.today/artists/');
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', build.target === 'production' ? 'index, follow' : 'noindex, follow');
  expect(problems).toEqual([]);
});

test('360px keyboard directory entry restores exact AND results and preserves existing favorites bytes', async ({ page, request }) => {
  const catalog = await (await request.get('/catalog.json')).json() as { songs: Song[] };
  const ids = expectedIds(catalog.songs), bothId = [...ids.both][0], oneProviderId = [...ids.union].find(id => !ids.both.has(id))!;
  const saved = JSON.stringify([{ id: bothId, note: 'preserve-existing-note' }, oneProviderId, 'unresolved-legacy-id']);
  await page.addInitScript(value => {
    if (localStorage.getItem('jpop_today_favorites') === null) localStorage.setItem('jpop_today_favorites', value);
  }, saved);
  await page.setViewportSize({ width: 360, height: 800 });
  const problems = observeProblems(page);
  await page.goto('/artists/');
  const link = page.locator('[data-confirmed-both-search]');
  await link.focus(); await expect(link).toBeFocused();
  const focus = await link.evaluate(element => {
    const style = getComputedStyle(element), box = element.getBoundingClientRect();
    return { outline: style.outlineStyle, width: Number.parseFloat(style.outlineWidth), height: box.height, hitWidth: box.width };
  });
  expect(focus.height).toBeGreaterThanOrEqual(44); expect(focus.hitWidth).toBeGreaterThanOrEqual(44);
  expect(focus.outline).not.toBe('none'); expect(focus.width).toBeGreaterThan(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.keyboard.press('Enter'); await expect(page).toHaveURL(url => url.pathname + url.search === bothSearch); await ready(page);
  for (const provider of providers) await expect(confirmedButton(page, provider)).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#result-count')).toHaveText(`${ids.both.size}곡`);
  const actual = await visibleResultIds(page); expect(actual).toHaveLength(ids.both.size); expect(new Set(actual)).toEqual(ids.both);
  // Every row is a real two-provider safe ID: conflicts, unknown/suppressed values,
  // chart aliases and one-provider-only observations cannot leak into AND results.
  for (const id of actual) for (const provider of providers) {
    const value = catalog.songs.find(song => song.id === id)!.karaoke[provider];
    expect(value.status).toBe('provider-confirmed'); expect(value.conflict).toBe(false);
  }
  await page.reload(); await ready(page);
  expect(new URL(page.url()).searchParams.getAll('number')).toEqual(['confirmed-tj', 'confirmed-ky']);
  expect(new Set(await visibleResultIds(page))).toEqual(ids.both);
  expect(await page.evaluate(() => localStorage.getItem('jpop_today_favorites'))).toBe(saved);
  await page.getByRole('searchbox').fill('absent-both-directory-song-44'); await page.getByRole('searchbox').press('Enter');
  await expect(page.locator('#result-count')).toHaveText('0곡');
  await expect(page.locator('#empty-message')).toContainText('공식 미수록을 뜻하지 않습니다');
  await page.getByRole('button', { name: '조건 해제', exact: true }).click();
  expect(new URL(page.url()).search).toBe('');
  expect(await page.evaluate(() => localStorage.getItem('jpop_today_favorites'))).toBe(saved);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(problems).toEqual([]);
});

test('JavaScript-off mobile keeps both counts, exact artist anchors and the honest disabled-search fallback', async ({ browser, request }) => {
  const catalog = await (await request.get('/catalog.json')).json() as { songs: Song[] };
  const context = await browser.newContext({ baseURL: process.env.JPOP_TEST_BASE_URL ?? 'http://127.0.0.1:4321',
    javaScriptEnabled: false, viewport: { width: 360, height: 800 } });
  try {
    const page = await context.newPage(), problems = observeProblems(page);
    await page.goto('/artists/'); await verifyDirectory(page, catalog.songs);
    await expect(page.locator('#both-search-note')).toContainText('JavaScript');
    await expect(page.locator('#both-search-note')).toContainText('가수');
    const anchor = page.locator('.artist-index a[data-artist-index]').last(), fragment = await anchor.getAttribute('href');
    await anchor.focus(); await expect(anchor).toBeFocused(); await page.keyboard.press('Enter');
    await expect.poll(() => new URL(page.url()).hash).toBe(fragment);
    await expect(page.locator(fragment! + ' h2')).toBeInViewport();
    const row = page.locator(fragment!).locator('.artist-song').first(), id = await row.getAttribute('data-song-id');
    await expect(row.locator('h3 a')).toHaveAttribute('href', '/songs/' + encodeURIComponent(id!) + '/');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const link = page.locator('[data-confirmed-both-search]'); await link.focus(); await page.keyboard.press('Enter');
    await expect(page).toHaveURL(url => url.pathname + url.search === bothSearch);
    for (const provider of providers) await expect(confirmedButton(page, provider)).toBeDisabled();
    await expect(page.locator('.filter-fallback')).toContainText('현재 표시된 목록에는 위 조건이 적용되지 않았습니다');
    expect(problems).toEqual([]);
  } finally { await context.close(); }
});

test('first search guide explains two-provider AND, clearing conditions and the JavaScript-free artist alternative', async ({ browser, request }) => {
  const context = await browser.newContext({ baseURL: process.env.JPOP_TEST_BASE_URL ?? 'http://127.0.0.1:4321',
    javaScriptEnabled: false, viewport: { width: 360, height: 800 } });
  try {
    const page = await context.newPage(), problems = observeProblems(page);
    await page.goto('/guides/find-japanese-songs/');
    await expect(page).toHaveTitle('일본어 제목을 몰라도 노래를 찾는 순서 | jpop.today');
    const article = page.locator('article');
    await expect(article).toContainText('두 업체'); await expect(article).toContainText('모두');
    await expect(article).toContainText('전체는 번호 조건을 지우며');
    await expect(article).toContainText('입력한 검색어나 다른 조건은 유지');
    await expect(article).toContainText('JavaScript');
    await expect(article).toContainText('미수록');
    await expect(article.locator(`a[href="${bothSearch}"]`)).toHaveCount(1);
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', 'https://jpop.today/guides/find-japanese-songs/');
    const build = await (await request.get('/build-info.json')).json();
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', build.target === 'production' ? 'index, follow' : 'noindex, follow');
    const alternative = article.locator('a[href="/artists/"]'); await expect(alternative).toHaveCount(1);
    await alternative.focus(); await expect(alternative).toBeFocused(); await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/artists\/$/);
    await expect(page.locator('[data-provider-count="global"][data-provider="both"]')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(problems).toEqual([]);
  } finally { await context.close(); }
});
