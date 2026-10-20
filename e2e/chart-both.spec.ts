import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import type { Song } from '../src/lib/catalog';
import { rawProviderIds, publicProviderIds } from './helpers/chart-confirmed-oracle';

type Provider = 'tj' | 'ky';
type Evidence = NonNullable<Song['karaoke']['tj']['evidence']>;
type Entry = { songId: string; provider: Provider; action: string; number: string | null; evidence: Evidence };
const raw = JSON.parse(readFileSync(new URL('../data/staging/legacy-catalog.json', import.meta.url), 'utf8')) as { songs: Song[] };
const ledger = JSON.parse(readFileSync(new URL('../data/reviewed/provider-corrections.json', import.meta.url), 'utf8')) as { entries: Entry[] };
const chart = JSON.parse(readFileSync(new URL('../data/chart-snapshot.json', import.meta.url), 'utf8')) as {
  startDate: string; endDate: string; fetchedAt: string; sourceUrl: string; songs: { rank: number; canonicalId: string }[];
};
const providers = ['tj', 'ky'] as const;
const songPath = (id: string) => '/songs/' + encodeURIComponent(id) + '/';
const natoriId = 'jpop-playlist-なとり-フ-ロホ-ス-5b000e662c';
const selector = '[data-chart-provider="both"][data-chart-both-disclosure]';

// Raw/ledger membership and the public response are modeled separately in a
// shared test-only oracle; no application lookup/count helper is imported.
function expectedRows(songs: Song[]) {
  expect(new Set(songs.map(song => song.id))).toEqual(new Set(raw.songs.map(song => song.id)));
  expect(new Set(songs.map(song => song.id)).size).toBe(songs.length);
  const ids = {} as Record<Provider, Set<string>>;
  for (const provider of providers) {
    ids[provider] = rawProviderIds(raw.songs, ledger.entries, provider);
    const projected = publicProviderIds(songs, provider);
    expect(projected, 'public projection must agree with independent corrected-number multiplicities').toEqual(ids[provider]);
  }
  const byId = new Map(songs.map(song => [song.id, song]));
  const rows = chart.songs.map(row => ({ rank: row.rank, song: byId.get(row.canonicalId)! }));
  expect(rows).toHaveLength(100); expect(new Set(rows.map(row => row.song.id)).size).toBe(100);
  expect(rows.map(row => row.rank)).toEqual(Array.from({ length: 100 }, (_, index) => index + 1));
  const both = rows.filter(row => ids.tj.has(row.song.id) && ids.ky.has(row.song.id));
  const union = rows.filter(row => ids.tj.has(row.song.id) || ids.ky.has(row.song.id));
  expect(both.length).toBeGreaterThan(0); expect(both.length).toBeLessThan(union.length);
  expect(ids.tj.has(natoriId)).toBe(true); expect(ids.ky.has(natoriId)).toBe(false);
  expect(both.some(row => row.song.id === natoriId)).toBe(false);
  return { rows, both, union, ids };
}

function observe(page: Page) {
  const problems: string[] = [];
  page.on('pageerror', () => problems.push('pageerror'));
  page.on('console', message => { if (['error', 'warning'].includes(message.type())) problems.push('console-' + message.type()); });
  page.on('request', request => { if (/googlesyndication|doubleclick|googleadservices/.test(request.url())) problems.push('ad-request'); });
  return problems;
}

async function checkStatic(page: Page, songs: Song[]) {
  const expected = expectedRows(songs);
  const count = page.locator('[data-chart-count="both"]');
  await expect(count).toHaveCount(1); await expect(count).toBeVisible();
  await expect(count).toHaveAttribute('data-count', String(expected.both.length));
  await expect.poll(() => count.innerText()).toMatch(new RegExp(`^\\s*${expected.both.length}\\s*곡\\s*/\\s*100\\s*곡\\s*$`));
  for (const provider of providers) {
    const rows = expected.rows.filter(row => expected.ids[provider].has(row.song.id));
    await expect(page.locator(`[data-chart-count="${provider}"]`)).toHaveAttribute('data-count', String(rows.length));
    const links = page.locator(`[data-chart-provider="${provider}"] a[data-chart-shortcut="${provider}"]`);
    expect(await links.evaluateAll(links => links.map(link => ({ id: link.getAttribute('data-song-id'), rank: link.getAttribute('data-chart-rank'), href: link.getAttribute('href') })))).toEqual(rows.map(row => ({ id: row.song.id, rank: String(row.rank), href: '#chart-' + row.song.id })));
  }
  await expect(page.locator('[data-chart-count="union"]')).toHaveAttribute('data-count', String(expected.union.length));
  expect(await page.locator('ol.chart-list > li.chart-entry').evaluateAll(rows => rows.map(row => ({
    rank: row.getAttribute('data-chart-rank'), visibleRank: row.querySelector('.chart-rank')?.textContent?.trim(), anchor: row.id,
    id: row.querySelector('.song-row')?.getAttribute('data-song-id'), href: row.querySelector('.song-name > a')?.getAttribute('href'),
  })))).toEqual(expected.rows.map(row => ({ rank: String(row.rank), visibleRank: String(row.rank), anchor: 'chart-' + row.song.id, id: row.song.id, href: songPath(row.song.id) })));
  const disclosure = page.locator(selector), summary = disclosure.locator('summary#chart-both-heading');
  await expect(disclosure).toHaveCount(1); await expect(summary).toBeVisible();
  await expect(summary).toHaveAccessibleName(new RegExp(`TJ·금영 모두 확인된 곡\\s*${expected.both.length}곡 목록 열기·닫기`));
  await expect(summary).toHaveAttribute('aria-describedby', /chart-both-note/);
  const note = page.locator('#chart-both-note'); await expect(note).toBeVisible();
  await expect(note).toContainText('같은 곡'); await expect(note).toContainText('미수록'); await expect(note).toContainText('TJ');
  for (const value of [chart.startDate, chart.endDate, chart.fetchedAt]) await expect(page.locator('main')).toContainText(value);
  await expect(page.locator('main')).toContainText('오늘의 최신 순위를 뜻하지 않습니다');
  await expect(page.locator('main')).toContainText('요청 기간이 응답에서 별도로 확인된 집계 기간을 뜻하지는 않습니다');
  await expect(page.locator(`a[href="${chart.sourceUrl}"]`)).toHaveCount(1);
  return { ...expected, disclosure, summary };
}

async function checkOpened(page: Page, songs: Song[]) {
  const expected = expectedRows(songs), links = page.locator(`${selector} a[data-chart-shortcut="both"]`);
  expect(await links.evaluateAll(links => links.map(link => ({ id: link.getAttribute('data-song-id'), rank: link.getAttribute('data-chart-rank'), href: link.getAttribute('href') })))).toEqual(expected.both.map(row => ({ id: row.song.id, rank: String(row.rank), href: '#chart-' + row.song.id })));
  for (const row of expected.both) {
    const link = page.locator(`${selector} a[data-song-id="${row.song.id}"]`);
    await expect(link).toBeVisible(); await expect(link).toContainText(row.song.titleOriginal); await expect(link).toContainText(row.song.artistOriginal);
    for (const provider of providers) {
      const number = row.song.karaoke[provider].observedNumber!;
      const cell = link.locator(`[data-provider="${provider}"][data-chart-confirmed-number]`);
      await expect(cell).toHaveCount(1); await expect(cell).toBeVisible();
      await expect(cell).toHaveAttribute('data-chart-confirmed-number', number);
      await expect(cell).toHaveText(new RegExp(`^${provider === 'tj' ? 'TJ' : '금영'}\\s+${number}\\s+·\\s+공식 확인$`));
    }
  }
  await expect(page.locator(`${selector} a[data-song-id="${natoriId}"]`)).toHaveCount(0);
  return expected;
}

test('chart both-provider discovery matches independent raw, ledger, public and frozen-rank oracles', async ({ page, request }) => {
  const catalogResponse = await request.get('/catalog.json'), bytes = await catalogResponse.text();
  expect(catalogResponse.status()).toBe(200); const catalog = JSON.parse(bytes) as { songs: Song[] };
  const build = await (await request.get('/build-info.json')).json();
  expect(build.catalogSha256).toBe(createHash('sha256').update(bytes).digest('hex'));
  expect(build.ledgerSha256).toBe(createHash('sha256').update(JSON.stringify(ledger)).digest('hex'));
  expect(build.chartSha256).toBe(createHash('sha256').update(JSON.stringify(chart)).digest('hex'));
  const problems = observe(page); await page.goto('/chart/');
  const expected = await checkStatic(page, catalog.songs);
  await expect(expected.disclosure).not.toHaveAttribute('open');
  await expect(expected.disclosure.locator('a[data-chart-shortcut="both"]').first()).toBeHidden();
  await expected.summary.click(); await expect(expected.disclosure).toHaveAttribute('open', '');
  await checkOpened(page, catalog.songs);
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', 'https://jpop.today/chart/');
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', build.target === 'production' ? 'index, follow' : 'noindex, follow');
  await expect(page.locator('ins.adsbygoogle, iframe[src*="doubleclick"], script[src*="googlesyndication"]')).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(problems).toEqual([]);
});

test('native both disclosure works at 360px without JavaScript and preserves exact rank/detail anchors', async ({ browser, request }) => {
  const catalog = await (await request.get('/catalog.json')).json() as { songs: Song[] };
  const context = await browser.newContext({ baseURL: process.env.JPOP_TEST_BASE_URL ?? 'http://127.0.0.1:4321', javaScriptEnabled: false, viewport: { width: 360, height: 800 } });
  try {
    const page = await context.newPage(), problems = observe(page); await page.goto('/chart/');
    const expected = await checkStatic(page, catalog.songs);
    await expect(expected.disclosure).not.toHaveAttribute('open');
    await expected.summary.focus(); await expect(expected.summary).toBeFocused();
    const focus = await expected.summary.evaluate(element => { const r = element.getBoundingClientRect(), s = getComputedStyle(element); return { width: r.width, height: r.height, outline: s.outlineStyle, outlineWidth: parseFloat(s.outlineWidth) }; });
    expect(focus.width).toBeGreaterThanOrEqual(44); expect(focus.height).toBeGreaterThanOrEqual(44);
    expect(focus.outline).not.toBe('none'); expect(focus.outlineWidth).toBeGreaterThan(0);
    await page.keyboard.press('Enter'); await expect(expected.disclosure).toHaveAttribute('open', '');
    await checkOpened(page, catalog.songs);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const row = expected.both.at(-1)!, link = expected.disclosure.locator(`a[data-song-id="${row.song.id}"]`);
    await link.focus(); await page.keyboard.press('Enter'); await expect.poll(() => decodeURIComponent(new URL(page.url()).hash)).toBe('#chart-' + row.song.id);
    const target = page.locator(`.chart-entry[id="chart-${row.song.id}"]`); await expect(target).toBeInViewport();
    const detail = target.locator('.song-name > a'); await expect(detail).toHaveAttribute('href', songPath(row.song.id));
    await detail.focus(); await page.keyboard.press('Enter'); await expect(page).toHaveURL(url => url.pathname === songPath(row.song.id));
    await expect(page.locator('main h1')).toHaveText(row.song.titleOriginal);
    expect(problems).toEqual([]);
  } finally { await context.close(); }
});

test('opening, navigating and reloading chart shortcuts do not rewrite the existing favorites bytes', async ({ page, request }) => {
  const catalog = await (await request.get('/catalog.json')).json() as { songs: Song[] }, expected = expectedRows(catalog.songs);
  const saved = JSON.stringify([{ id: expected.both[0].song.id, note: 'preserve existing note' }, natoriId, 'unresolved-legacy-quality-47', '000047']);
  await page.addInitScript(value => { if (localStorage.getItem('jpop_today_favorites') === null) localStorage.setItem('jpop_today_favorites', value); }, saved);
  const problems = observe(page); await page.setViewportSize({ width: 360, height: 800 }); await page.goto('/chart/');
  const checked = await checkStatic(page, catalog.songs); await checked.summary.focus(); await page.keyboard.press('Enter');
  await expect(checked.disclosure).toHaveAttribute('open', '');
  const row = expected.both[0], shortcut = checked.disclosure.locator(`a[data-song-id="${row.song.id}"]`);
  await shortcut.focus(); await page.keyboard.press('Enter');
  await expect.poll(() => decodeURIComponent(new URL(page.url()).hash)).toBe('#chart-' + row.song.id);
  expect(await page.evaluate(() => localStorage.getItem('jpop_today_favorites'))).toBe(saved);
  await page.reload(); await expect(page.locator(`.chart-entry[id="chart-${row.song.id}"]`)).toBeInViewport();
  expect(await page.evaluate(() => localStorage.getItem('jpop_today_favorites'))).toBe(saved);
  await page.goto('/guides/read-tj-chart/');
  expect(await page.evaluate(() => localStorage.getItem('jpop_today_favorites'))).toBe(saved);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(problems).toEqual([]);
});

test('reviewed chart guide links the native two-provider flow and keeps the snapshot/unknown boundaries without JavaScript', async ({ browser }) => {
  const context = await browser.newContext({ baseURL: process.env.JPOP_TEST_BASE_URL ?? 'http://127.0.0.1:4321', javaScriptEnabled: false, viewport: { width: 360, height: 800 } });
  try {
    const page = await context.newPage(), problems = observe(page); await page.goto('/guides/read-tj-chart/');
    const article = page.locator('article');
    await expect(article).toContainText('2026-10-20'); await expect(article).toContainText('TJ'); await expect(article).toContainText('금영');
    await expect(article).toContainText('미수록'); await expect(article).toContainText('JavaScript');
    await expect(article).toContainText('요청 기간'); await expect(article).toContainText('금영 인기순위');
    const link = article.locator('a[href="/chart/#chart-both-heading"]'); await expect(link).toHaveCount(1); await expect(link).toBeVisible();
    await link.focus(); await page.keyboard.press('Enter'); await expect(page).toHaveURL(url => url.pathname + url.hash === '/chart/#chart-both-heading');
    const summary = page.locator(selector + ' summary'); await expect(summary).toBeInViewport(); await summary.focus(); await page.keyboard.press('Enter');
    await expect(page.locator(selector)).toHaveAttribute('open', '');
    await expect(page.locator(selector + ' a[data-chart-shortcut="both"]').first()).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); expect(problems).toEqual([]);
  } finally { await context.close(); }
});
