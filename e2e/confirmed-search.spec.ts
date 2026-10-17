import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import type { Song } from '../src/lib/catalog';

type RawSong = Song;
type Entry = { songId: string; provider: 'tj' | 'ky'; action: string; number: string | null };
const staging = JSON.parse(readFileSync(new URL('../data/staging/legacy-catalog.json', import.meta.url), 'utf8')) as { songs: RawSong[] };
const ledger = JSON.parse(readFileSync(new URL('../data/reviewed/provider-corrections.json', import.meta.url), 'utf8')) as { entries: Entry[] };
const rawById = new Map(staging.songs.map(song => [song.id, song]));
const correctionByPair = new Map(ledger.entries.map(entry => [JSON.stringify([entry.songId, entry.provider]), entry]));

// Browser assertions use the reviewed ledger and independent duplicate counts,
// never the application matcher as both expected and actual result.
function reviewedIds(provider: 'tj' | 'ky') {
  const counts = new Map<string, number>();
  for (const song of staging.songs) {
    const entry = correctionByPair.get(JSON.stringify([song.id, provider]));
    const number = entry ? entry.number : song.karaoke[provider].observedNumber;
    if (number !== null) counts.set(number, (counts.get(number) ?? 0) + 1);
  }
  return new Set(ledger.entries.filter(entry => {
    const song = rawById.get(entry.songId)!;
    return entry.provider === provider && entry.action === 'confirm' && song.availability === 'current'
      && song.origin === 'playlist' && counts.get(entry.number!) === 1;
  }).map(entry => entry.songId));
}
const tjIds = reviewedIds('tj'), kyIds = reviewedIds('ky');
const bothIds = new Set([...tjIds].filter(id => kyIds.has(id)));
const samfreeId = 'jpop-playlist-samfree-ルカルカ-ナイトフィ-ハ-f6722acd10';
const adoId = 'jpop-playlist-ado-逆光-c8c1ba8b20';
const originalId = 'jpop-playlist-radwimps-前前前世-original-ver-1ff3eb38b9';
const pretender = staging.songs.find(song => song.titleOriginal === 'Pretender' && song.origin === 'playlist')!;
const pathFor = (id: string) => '/songs/' + encodeURIComponent(id) + '/';
const confirmedButton = (page: Page, provider: 'tj' | 'ky') => page.getByRole('button', { name: provider === 'tj' ? 'TJ 공식 확인' : '금영 공식 확인', exact: true });
const ready = (page: Page) => expect(page.locator('html')).toHaveAttribute('data-app-ready', 'true');
const numberFilters = (page: Page) => new URL(page.url()).searchParams.getAll('number');
async function allVisibleIds(page: Page) {
  const more = page.getByRole('button', { name: '더 보기', exact: true });
  const rows = page.locator('#song-list > [data-song-id]');
  for (let attempt = 0; await more.isVisible(); attempt++) {
    expect(attempt, 'Load-more actions must terminate within the frozen catalog size').toBeLessThan(staging.songs.length);
    const before = await rows.count();
    await more.click();
    await expect.poll(() => rows.count(), { message: 'Each load-more action must reveal additional song rows' }).toBeGreaterThan(before);
  }
  await expect(more).toBeHidden();
  return rows.evaluateAll(rows => rows.map(row => (row as HTMLElement).dataset.songId!));
}

test('official provider search matches the independent real ledger and uses AND for both selections', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto('/search/'); await ready(page);
  await expect(page).toHaveTitle(/jpop\.today/);
  await expect(page.locator('h1')).toHaveText('오늘 부를 JPOP를 찾아보세요.');
  await expect(page.locator('main')).not.toBeEmpty();
  await expect(page.locator('astro-dev-overlay, vite-error-overlay, nextjs-portal')).toHaveCount(0);
  await expect(page.getByRole('group', { name: '번호 조건' })).toHaveAttribute('aria-describedby', 'number-filter-note');
  await expect(page.locator('#number-filter-note')).toContainText('선택하지 않은 업체의 번호는 관측값일 수 있습니다');
  await confirmedButton(page, 'tj').click();
  await expect(confirmedButton(page, 'tj')).toHaveAttribute('aria-pressed', 'true');
  expect(numberFilters(page)).toEqual(['confirmed-tj']);
  await expect(page.locator('#result-count')).toHaveText(`${tjIds.size.toLocaleString('ko-KR')}곡`);
  expect(new Set(await allVisibleIds(page))).toEqual(tjIds);
  await confirmedButton(page, 'ky').click();
  expect(new Set(numberFilters(page))).toEqual(new Set(['confirmed-tj', 'confirmed-ky']));
  await expect(page.locator('#result-count')).toHaveText(`${bothIds.size.toLocaleString('ko-KR')}곡`);
  expect(new Set(await allVisibleIds(page))).toEqual(bothIds);
  await confirmedButton(page, 'tj').click();
  expect(numberFilters(page)).toEqual(['confirmed-ky']);
  await expect(page.locator('#result-count')).toHaveText(`${kyIds.size.toLocaleString('ko-KR')}곡`);
  expect(new Set(await allVisibleIds(page))).toEqual(kyIds);
  expect(errors).toEqual([]);
});

test('URL restore, page reset and browser history retain existing q, tag and observed number conditions', async ({ page }) => {
  const tag = pretender.tags.find(tag => tag.startsWith('가수:'))!;
  const initial = new URLSearchParams({ q: 'Pretender', tag, artist: 'all', page: '2' });
  initial.append('number', 'has-tj');
  await page.goto('/search/?' + initial); await ready(page);
  await expect(page.locator('#empty-message')).toContainText('이 페이지에 곡이 없습니다');
  await confirmedButton(page, 'tj').click();
  let url = new URL(page.url());
  expect(url.searchParams.get('page')).toBeNull();
  expect(url.searchParams.get('q')).toBe('Pretender');
  expect(url.searchParams.get('tag')).toBe(tag); expect(url.searchParams.get('artist')).toBe('all');
  expect(new Set(numberFilters(page))).toEqual(new Set(['has-tj', 'confirmed-tj']));
  await expect(page.locator(`[data-song-id="${pretender.id}"]`)).toBeVisible();
  await confirmedButton(page, 'ky').click();
  await page.reload(); await ready(page);
  await expect(confirmedButton(page, 'tj')).toHaveAttribute('aria-pressed', 'true');
  await expect(confirmedButton(page, 'ky')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('searchbox')).toHaveValue('Pretender');
  await expect(page.locator('#filter-summary')).toContainText('TJ 공식 확인');
  await expect(page.locator('#filter-summary')).toContainText('금영 공식 확인');
  await page.goBack();
  await expect(confirmedButton(page, 'ky')).toHaveAttribute('aria-pressed', 'false');
  await expect(confirmedButton(page, 'tj')).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: '전체', exact: true }).click();
  url = new URL(page.url()); expect(url.searchParams.getAll('number')).toEqual([]);
  expect(url.searchParams.get('q')).toBe('Pretender'); expect(url.searchParams.get('tag')).toBe(tag);
  expect(url.searchParams.get('artist')).toBe('all');
  await expect(page.locator('#song-list')).toContainText('Pretender');
  await page.getByRole('button', { name: '조건 해제', exact: true }).click();
  expect(new URL(page.url()).search).toBe('');
  await expect(page.getByRole('searchbox')).toHaveValue('');
  await expect(page.getByRole('button', { name: '전체', exact: true })).toHaveAttribute('aria-pressed', 'true');
});

test('real deferred KY observations and suppressed original version cannot appear as confirmed search matches', async ({ page }) => {
  for (const id of [samfreeId, adoId]) {
    const song = rawById.get(id)!;
    await page.goto('/search/?' + new URLSearchParams({ q: song.titleOriginal, number: 'confirmed-tj' }));
    await ready(page); const row = page.locator(`[data-song-id="${id}"]`);
    await expect(row).toBeVisible();
    await expect(row.locator('.number-cell').nth(0).locator('.verification-badge')).toHaveText('공식 확인');
    await expect(row.locator('.number-cell').nth(1).locator('.verification-badge')).toHaveCount(0);
    await expect(row.locator('.number-cell').nth(1).getByRole('button')).toHaveAttribute('aria-label', /관측 번호/);
    await confirmedButton(page, 'ky').click();
    await expect(page.locator(`[data-song-id="${id}"]`)).toHaveCount(0);
  }
  await page.goto('/search/?' + new URLSearchParams({ q: '前前前世', number: 'confirmed-tj' })); await ready(page);
  await expect(page.locator(`[data-song-id="${originalId}"]`)).toHaveCount(0);
  await page.goto(pathFor(originalId));
  await expect(page.locator('main')).toContainText('미수록을 뜻하지 않습니다');
  await expect(page.getByRole('button', { name: 'tj 번호 복사', exact: true })).toHaveCount(0);
});

test('confirmed search recovers from an empty result without turning an unknown result into unlisted', async ({ page }) => {
  await page.goto('/search/?q=no-such-confirmed-song-unique-35&number=confirmed-tj'); await ready(page);
  await expect(page.locator('#result-count')).toHaveText('0곡');
  await expect(page.locator('#empty-message')).toContainText('공식 미수록을 뜻하지 않습니다');
  await page.getByRole('searchbox').fill('Pretender');
  await page.getByRole('searchbox').press('Enter');
  await expect(page.locator('#song-list')).toContainText('Pretender');
  expect(numberFilters(page)).toEqual(['confirmed-tj']);
  await expect(page.locator('#empty-message')).toBeHidden();
});

test('legacy search and detail URLs retain stable IDs while favorites filters preserve original storage bytes', async ({ page }) => {
  const saved = JSON.stringify([{ id: pretender.id, note: 'preserve' }, samfreeId, 'legacy-unknown-id']);
  await page.addInitScript(value => {
    if (localStorage.getItem('jpop_today_favorites') === null) localStorage.setItem('jpop_today_favorites', value);
  }, saved);
  const query = new URLSearchParams({ q: 'Pretender', number: 'confirmed-tj' }); query.append('number', 'has-ky');
  await page.goto('/filter.html?' + query); await ready(page);
  expect(new URL(page.url()).pathname).toBe('/search/');
  expect(new Set(numberFilters(page))).toEqual(new Set(['confirmed-tj', 'has-ky']));
  await expect(page.locator(`[data-song-id="${pretender.id}"] .song-name a`)).toHaveAttribute('href', pathFor(pretender.id));
  await page.goto('/song.html?id=' + encodeURIComponent(pretender.id));
  await expect(page).toHaveURL(pathFor(pretender.id)); await ready(page);
  await page.goto('/favorites/?number=confirmed-ky'); await ready(page);
  await expect(page.locator(`[data-song-id="${pretender.id}"]`)).toBeVisible();
  await expect(page.locator(`[data-song-id="${samfreeId}"]`)).toHaveCount(0);
  await expect(page.locator('#unresolved-list')).toContainText('legacy-unknown-id');
  expect(await page.evaluate(() => localStorage.getItem('jpop_today_favorites'))).toBe(saved);
  await page.getByRole('button', { name: '전체', exact: true }).click();
  await expect(page.locator(`[data-song-id="${samfreeId}"]`)).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('jpop_today_favorites'))).toBe(saved);
  await page.getByRole('searchbox').fill('absent-favorite-35'); await page.getByRole('searchbox').press('Enter');
  await confirmedButton(page, 'tj').click();
  await expect(page.locator('#empty-message')).toContainText('공식 미수록을 뜻하지 않습니다');
  expect(await page.evaluate(() => localStorage.getItem('jpop_today_favorites'))).toBe(saved);
});

test('new filters remain disabled while catalog loads and offer an honest JavaScript-off fallback', async ({ page, browser }) => {
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/catalog.json', async route => { await held; await route.continue(); });
  try {
    await page.goto('/search/', { waitUntil: 'domcontentloaded' });
    await expect(confirmedButton(page, 'tj')).toBeDisabled(); await expect(confirmedButton(page, 'ky')).toBeDisabled();
  } finally { release(); }
  await ready(page); await expect(confirmedButton(page, 'tj')).toBeEnabled();
  const context = await browser.newContext({ javaScriptEnabled: false, viewport: { width: 360, height: 800 } });
  const staticPage = await context.newPage();
  await staticPage.goto((process.env.JPOP_TEST_BASE_URL ?? 'http://127.0.0.1:4321') + '/search/?number=confirmed-tj');
  await expect(staticPage.locator('h1')).toBeVisible();
  await expect(confirmedButton(staticPage, 'tj')).toBeDisabled();
  await expect(staticPage.locator('.filter-fallback')).toContainText('현재 표시된 목록에는 위 조건이 적용되지 않았습니다');
  await expect(staticPage.locator('.filter-fallback a[href="/coverage/"]')).toBeVisible();
  await expect(staticPage.locator('.filter-fallback a[href="/guides/tj-ky-numbers/"]')).toBeVisible();
  expect(await staticPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  if (process.env.JPOP_SCREENSHOT_DIR) await staticPage.screenshot({ path: process.env.JPOP_SCREENSHOT_DIR + '/confirmed-search-js-off-mobile.png', fullPage: false });
  await context.close();
});

test('keyboard and responsive confirmation controls keep original gradients, visible focus and 44px targets', async ({ page }) => {
  await page.goto('/search/'); await ready(page);
  const colors = await page.evaluate(() => ({ brand: getComputedStyle(document.querySelector('.site-header .brand span')!).backgroundImage,
    body: getComputedStyle(document.body).backgroundImage }));
  expect(colors.brand).toBe('linear-gradient(135deg, rgb(79, 124, 255), rgb(255, 122, 168))');
  for (const color of ['rgba(255, 122, 168, 0.18)', 'rgba(77, 199, 183, 0.16)', 'rgb(238, 245, 255)']) expect(colors.body).toContain(color);
  for (const viewport of [{ width: 1440, height: 1100 }, { width: 360, height: 800 }, { width: 800, height: 360 }]) {
    await page.setViewportSize(viewport);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    for (const provider of ['tj', 'ky'] as const) {
      const button = confirmedButton(page, provider); await button.focus(); await expect(button).toBeFocused();
      const focus = await button.evaluate(element => { const style = getComputedStyle(element); return { outline: style.outlineStyle,
        width: parseFloat(style.outlineWidth), box: element.getBoundingClientRect().toJSON() }; });
      expect(focus.outline).not.toBe('none'); expect(focus.width).toBeGreaterThan(0);
      expect(focus.box.height).toBeGreaterThanOrEqual(44); expect(focus.box.width).toBeGreaterThanOrEqual(44);
    }
  }
  await confirmedButton(page, 'tj').focus(); await page.keyboard.press('Enter');
  await expect(confirmedButton(page, 'tj')).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('Space'); await expect(confirmedButton(page, 'tj')).toHaveAttribute('aria-pressed', 'false');
  await page.setViewportSize({ width: 1440, height: 1100 }); await confirmedButton(page, 'tj').click();
  if (process.env.JPOP_SCREENSHOT_DIR) await page.screenshot({ path: process.env.JPOP_SCREENSHOT_DIR + '/confirmed-search-desktop.png', fullPage: false });
  await page.setViewportSize({ width: 360, height: 800 }); await confirmedButton(page, 'ky').click();
  await expect(page.locator('#result-count')).toHaveText(`${bothIds.size.toLocaleString('ko-KR')}곡`);
  if (process.env.JPOP_SCREENSHOT_DIR) await page.screenshot({ path: process.env.JPOP_SCREENSHOT_DIR + '/confirmed-search-mobile-both.png', fullPage: false });
});

test('mobile search and saved rows separate both providers and keep confirmation badges on one line', async ({ page, browser }) => {
  await page.setViewportSize({ width: 360, height: 800 });
  const savedIds = [pretender.id, samfreeId, adoId];
  await page.addInitScript(ids => localStorage.setItem('jpop_today_favorites', JSON.stringify(ids)), savedIds);
  async function checkRows(target: Page, route: string) {
    const failures = await target.locator('#song-list > .song-row').evaluateAll(rows => rows.flatMap(row => {
      const rowBounds = row.getBoundingClientRect();
      const elements = [...row.querySelectorAll('.number-cell > .mobile-label, .number-cell > .number-button, .number-cell > .unknown, .number-cell > .verification-badge')];
      const boxes = elements.map(element => ({ element, bounds: element.getBoundingClientRect() }));
      const problems: string[] = [];
      for (const { element, bounds } of boxes) {
        if (!bounds.width || !bounds.height) continue;
        if (bounds.left < rowBounds.left - 1 || bounds.right > rowBounds.right + 1) problems.push('provider-content-outside-row');
        if (element.classList.contains('verification-badge')) {
          const style = getComputedStyle(element);
          const lineHeight = Number.parseFloat(style.lineHeight) || Number.parseFloat(style.fontSize) * 1.7;
          if (bounds.height > lineHeight + 1) problems.push('confirmation-badge-wraps-vertically');
        }
        if (element.classList.contains('number-button') && (bounds.height < 44 || bounds.width < 44)) problems.push('number-copy-target-under-44px');
      }
      for (let left = 0; left < boxes.length; left++) for (let right = left + 1; right < boxes.length; right++) {
        const a = boxes[left].bounds, b = boxes[right].bounds;
        if (Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1
          && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1) problems.push('provider-label-number-badge-overlap');
      }
      return problems.map(problem => ({ id: row.getAttribute('data-song-id'), problem }));
    }));
    expect(failures, route).toEqual([]);
    expect(await target.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  for (const route of ['/?number=confirmed-tj', '/search/?number=confirmed-tj', '/favorites/?number=confirmed-tj']) {
    await page.goto(route); await ready(page);
    const expected = route.startsWith('/favorites/') ? new Set(savedIds.filter(id => tjIds.has(id))) : tjIds;
    const actual = await allVisibleIds(page);
    expect(actual.length, `${route}: geometry requires visible provider rows`).toBeGreaterThan(0);
    expect(actual, `${route}: exact row count before geometry`).toHaveLength(expected.size);
    expect(new Set(actual), `${route}: exact IDs before geometry`).toEqual(expected);
    await checkRows(page, route);
    if (route.startsWith('/search/') && process.env.JPOP_SCREENSHOT_DIR) {
      await page.locator('#song-list > .song-row').first().scrollIntoViewIfNeeded();
      await page.screenshot({ path: process.env.JPOP_SCREENSHOT_DIR + '/confirmed-search-mobile-provider-rows.png', fullPage: false });
    }
  }
  const context = await browser.newContext({ javaScriptEnabled: false, viewport: { width: 360, height: 800 } });
  try {
    const staticPage = await context.newPage();
    await staticPage.goto((process.env.JPOP_TEST_BASE_URL ?? 'http://127.0.0.1:4321') + '/search/?number=confirmed-tj');
    await expect(staticPage.locator('#song-list > .song-row')).toHaveCount(5);
    await checkRows(staticPage, 'JS-off unfiltered initial SSR rows');
  } finally { await context.close(); }
});
