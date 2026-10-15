import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test, expect, type Page } from '@playwright/test';
import type { Song } from '../src/lib/catalog';
import { officialLookupMatches } from '../contracts/provider-corrections.mjs';

type FrozenChart = { startDate: string; endDate: string; fetchedAt: string; sourceUrl: string;
  songs: { rank: number; canonicalId: string }[] };
const chart = JSON.parse(readFileSync(new URL('../data/chart-snapshot.json', import.meta.url), 'utf8')) as FrozenChart;
const providers = ['tj', 'ky'] as const;
type Provider = typeof providers[number];
const pathFor = (id: string) => '/songs/' + encodeURIComponent(id) + '/';
const rowFor = (page: Page, id: string) => page.locator(`.chart-entry[id="chart-${id}"]`);

// The URL contract is shared with ledger validation (including www KY and exact
// port/query rules). Counts/order/eligibility are independently derived here;
// neither confirmedNumbers nor the page's navigation/count implementation is imported.
function hasSafeEvidence(song: Song, provider: Provider) {
  const value = song.karaoke[provider], evidence = value.evidence;
  return song.origin === 'playlist' && song.availability === 'current'
    && value.status === 'provider-confirmed' && value.conflict === false && evidence !== null
    && ['checkedAt', 'title', 'artist'].every(key => {
      const text = evidence[key as keyof typeof evidence];
      return typeof text === 'string' && text.trim().length > 0;
    }) && officialLookupMatches(evidence.url, provider, value.observedNumber);
}

function expectedChart(songs: Song[]) {
  const catalog = new Map(songs.map(song => [song.id, song]));
  const rows = chart.songs.map(row => {
    const song = catalog.get(row.canonicalId);
    expect(song, `Frozen rank ${row.rank} must retain its exact catalog ID`).toBeTruthy();
    return { rank: row.rank, song: song! };
  });
  const lists = {
    tj: rows.filter(({ song }) => hasSafeEvidence(song, 'tj')),
    ky: rows.filter(({ song }) => hasSafeEvidence(song, 'ky')),
  };
  const ids = new Set(providers.flatMap(provider => lists[provider].map(({ song }) => song.id)));
  return { rows, lists, ids };
}

function observePage(page: Page) {
  const problems: string[] = [];
  page.on('pageerror', () => problems.push('pageerror'));
  page.on('console', message => {
    if (['error', 'warning'].includes(message.type())) problems.push(`console-${message.type()}`);
  });
  page.on('request', request => {
    if (/googlesyndication|doubleclick|googleadservices/.test(request.url())) problems.push('ad-request');
  });
  return problems;
}

async function checkChart(page: Page, songs: Song[]) {
  const expected = expectedChart(songs);
  expect(expected.rows).toHaveLength(100);
  expect(new Set(expected.rows.map(({ song }) => song.id)).size).toBe(100);
  const actual = await page.locator('ol.chart-list > li.chart-entry').evaluateAll(rows => rows.map(row => ({
    rank: row.getAttribute('data-chart-rank'),
    textRank: row.querySelector('.chart-rank')?.textContent?.trim(),
    anchor: row.id,
    id: row.querySelector('.song-row')?.getAttribute('data-song-id'),
    href: row.querySelector('.song-name > a')?.getAttribute('href'),
  })));
  expect(actual).toEqual(expected.rows.map(({ rank, song }) => ({
    rank: String(rank), textRank: String(rank), anchor: `chart-${song.id}`, id: song.id, href: pathFor(song.id),
  })));
  await expect(page.locator('[data-chart-denominator]')).toHaveAttribute('data-chart-denominator', '100');
  await expect(page.locator('[data-chart-denominator]')).toContainText('100');
  await expect(page.locator('[data-chart-count="union"]')).toHaveAttribute('data-count', String(expected.ids.size));
  await expect(page.locator('[data-chart-count="union"]')).toContainText(String(expected.ids.size));
  expect(expected.lists.tj.length + expected.lists.ky.length).toBeGreaterThan(expected.ids.size);
  await expect(page.locator('#chart-confirmed-scope')).toContainText('공식 미수록');
  await expect(page.locator('#chart-confirmed-scope')).toContainText('0');
  await expect(page.locator('#chart-confirmed-scope')).toContainText('중복');
  await expect(page.locator('.chart-confirmed-summary')).toHaveAttribute('aria-describedby', 'chart-confirmed-scope');
  await expect(page.locator('.chart-provider-navigation')).toHaveAttribute('aria-describedby', 'chart-confirmed-scope');

  for (const provider of providers) {
    const rows = expected.lists[provider];
    await expect(page.locator(`[data-chart-count="${provider}"]`)).toHaveAttribute('data-count', String(rows.length));
    await expect(page.locator(`[data-chart-count="${provider}"]`)).toContainText(String(rows.length));
    const nav = page.locator(`[data-chart-provider="${provider}"]`);
    const shortcuts = nav.locator(`a[data-chart-shortcut="${provider}"]`);
    expect(await shortcuts.evaluateAll(links => links.map(link => ({
      id: link.getAttribute('data-song-id'), rank: link.getAttribute('data-chart-rank'), href: link.getAttribute('href'),
    })))).toEqual(rows.map(({ rank, song }) => ({ id: song.id, rank: String(rank), href: `#chart-${song.id}` })));
    for (const { song } of rows) {
      const shortcut = nav.locator(`a[data-song-id="${song.id}"]`);
      await expect(shortcut).toHaveAttribute('aria-describedby', 'chart-confirmed-scope');
      await expect(shortcut).toContainText(song.titleOriginal);
      await expect(shortcut).toContainText(song.karaoke[provider].observedNumber!);
    }
  }
  // Metadata uncertainty in this cohort must not become a KY shortcut through a
  // matching TJ result, a shared feature name, or a truncated official title.
  for (const id of ['jpop-playlist-samfree-ルカルカ-ナイトフィ-ハ-f6722acd10', 'jpop-playlist-ado-逆光-c8c1ba8b20']) {
    const song = songs.find(song => song.id === id)!;
    // A future independently reviewed correction may legitimately add it.
    if (!hasSafeEvidence(song, 'ky')) await expect(page.locator(`[data-chart-provider="ky"] a[data-song-id="${id}"]`)).toHaveCount(0);
  }
  await expect(page.locator('main')).toContainText(chart.startDate);
  await expect(page.locator('main')).toContainText(chart.endDate);
  await expect(page.locator('main')).toContainText(chart.fetchedAt);
  await expect(page.locator('main')).toContainText('오늘의 최신 순위를 뜻하지 않습니다');
  await expect(page.locator('main')).toContainText('요청 기간이 응답에서 별도로 확인된 집계 기간을 뜻하지는 않습니다');
  await expect(page.locator(`a[href="${chart.sourceUrl}"]`)).toHaveCount(1);
  return expected;
}

test('chart SSR counts and provider shortcuts independently match frozen ranks and safe distinct IDs', async ({ page, request }) => {
  const catalog = await (await request.get('/catalog.json')).json() as { songs: Song[] };
  const info = await (await request.get('/build-info.json')).json();
  expect(info.chartSha256).toBe(createHash('sha256').update(JSON.stringify(chart)).digest('hex'));
  const problems = observePage(page);
  await page.goto('/chart/');
  await expect(page).toHaveTitle('TJ JPOP 차트 기록 | jpop.today');
  await expect(page.locator('main h1')).toHaveText('TJ JPOP 차트 기록');
  await expect(page.locator('astro-error-overlay')).toHaveCount(0);
  await expect(page.locator('body')).not.toContainText('Internal Server Error');
  await checkChart(page, catalog.songs);
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', 'https://jpop.today/chart/');
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', info.target === 'production' ? 'index, follow' : 'noindex, follow');
  await expect(page.locator('ins.adsbygoogle, iframe[src*="doubleclick"], script[src*="googlesyndication"]')).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(problems).toEqual([]);
  if (process.env.JPOP_SCREENSHOT_DIR) await page.screenshot({ path: process.env.JPOP_SCREENSHOT_DIR + '/chart-confirmed-desktop.png', fullPage: false });
});

test('chart provider navigation remains reachable at 360px with JS off and keyboard links keep the exact detail URL', async ({ browser, request }) => {
  const catalog = await (await request.get('/catalog.json')).json() as { songs: Song[] };
  const context = await browser.newContext({ baseURL: process.env.JPOP_TEST_BASE_URL ?? 'http://127.0.0.1:4321',
    javaScriptEnabled: false, viewport: { width: 360, height: 800 } });
  const page = await context.newPage();
  const problems = observePage(page);
  await page.goto('/chart/');
  await expect(page.locator('main h1')).toBeVisible();
  const expected = await checkChart(page, catalog.songs);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  // A page can fit the viewport while its provider labels and confirmation
  // badges overlap inside the original chart row. Check actual occupied boxes
  // across both providers, including reviewed rows far below the first screen.
  const crampedNumbers = await page.locator('.chart-entry .song-row').evaluateAll(rows => rows.flatMap(row => {
    const rowBounds = row.getBoundingClientRect();
    const elements = [...row.querySelectorAll('.number-cell > .mobile-label, .number-cell > .number-button, .number-cell > .unknown, .number-cell > .verification-badge')];
    const boxes = elements.map(element => ({ element, bounds: element.getBoundingClientRect() }));
    const failures: string[] = [];
    for (const { element, bounds } of boxes) {
      if (bounds.width === 0 || bounds.height === 0) continue;
      if (bounds.left < rowBounds.left - 1 || bounds.right > rowBounds.right + 1) failures.push('provider-content-outside-row');
      if (element.classList.contains('verification-badge')) {
        const style = getComputedStyle(element);
        const lineHeight = Number.parseFloat(style.lineHeight) || Number.parseFloat(style.fontSize) * 1.7;
        if (bounds.height > lineHeight + 1) failures.push('confirmation-badge-wraps-vertically');
      }
    }
    for (let left = 0; left < boxes.length; left++) for (let right = left + 1; right < boxes.length; right++) {
      const a = boxes[left].bounds, b = boxes[right].bounds;
      if (Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1
          && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1) failures.push('provider-label-number-badge-overlap');
    }
    return failures.map(problem => ({ id: row.getAttribute('data-song-id'), problem }));
  }));
  expect(crampedNumbers).toEqual([]);
  const colors = await page.evaluate(() => ({
    brand: getComputedStyle(document.querySelector('.site-header .brand span')!).backgroundImage,
    body: getComputedStyle(document.body).backgroundImage,
  }));
  expect(colors.brand).toBe('linear-gradient(135deg, rgb(79, 124, 255), rgb(255, 122, 168))');
  for (const color of ['rgba(255, 122, 168, 0.18)', 'rgba(77, 199, 183, 0.16)', 'rgb(238, 245, 255)']) expect(colors.body).toContain(color);
  if (process.env.JPOP_SCREENSHOT_DIR) await page.screenshot({ path: process.env.JPOP_SCREENSHOT_DIR + '/chart-confirmed-mobile.png', fullPage: false });

  for (const [provider, target] of [
    ['tj', expected.lists.tj.at(-1)!], ['ky', expected.lists.ky[0]],
  ] as const) {
    const shortcut = page.locator(`[data-chart-provider="${provider}"] a[data-song-id="${target.song.id}"]`);
    await shortcut.focus();
    await expect(shortcut).toBeFocused();
    await page.keyboard.press('Enter');
    // URL.hash serializes non-ASCII IDs. Decode to compare the stable ID itself.
    await expect.poll(() => decodeURIComponent(new URL(page.url()).hash)).toBe(`#chart-${target.song.id}`);
    const row = rowFor(page, target.song.id);
    await expect(row).toHaveAttribute('tabindex', '-1');
    await expect(row).toBeInViewport();
    const link = row.locator('.song-name > a');
    await expect(link).toHaveAttribute('href', pathFor(target.song.id));
    // The visible center of the target title must belong to the title link,
    // not a sticky navigation panel or an overlay covering the chart row.
    expect(await link.evaluate(link => {
      const bounds = link.getBoundingClientRect();
      const x = Math.max(0, Math.min(innerWidth - 1, bounds.x + bounds.width / 2));
      const y = Math.max(0, Math.min(innerHeight - 1, bounds.y + bounds.height / 2));
      const top = document.elementFromPoint(x, y);
      return bounds.bottom > 0 && bounds.top < innerHeight && Boolean(top && (top === link || link.contains(top)));
    })).toBe(true);
  }

  const selected = expected.lists.ky[0].song;
  const detail = rowFor(page, selected.id).locator('.song-name > a');
  await detail.focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(url => url.pathname === pathFor(selected.id));
  await expect(page.locator('h1')).toHaveText(selected.titleOriginal);
  await expect(page.locator(`a[href="${selected.karaoke.ky.evidence!.url}"]`)).toHaveCount(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(problems).toEqual([]);
  await context.close();
});
