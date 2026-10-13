import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import type { Song } from '../src/lib/catalog';
const catalog = JSON.parse(readFileSync(new URL('../data/staging/legacy-catalog.json', import.meta.url), 'utf8')) as { songs: Song[] };
const pretender = catalog.songs.find(song => song.titleOriginal === 'Pretender' && song.origin === 'playlist')!;
const archived = catalog.songs.find(song => song.availability === 'archived')!;
const pathFor = (id: string) => '/songs/' + encodeURIComponent(id) + '/';

test('slow catalog keeps state controls disabled until handlers and storage are ready', async ({ page }) => {
  await page.route('**/catalog.json', async route => { await new Promise(resolve => setTimeout(resolve, 750)); await route.continue(); });
  await page.goto('/');
  const filter = page.getByRole('button', { name: 'TJ 번호 있음', exact: true });
  await expect(filter).toBeDisabled();
  await filter.click();
  await expect(filter).toHaveAttribute('aria-pressed', 'true');
  await expect(page).toHaveURL(/number=has-tj/);
});

test('search, provider filters, URL restore and back navigation', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto('/'); await expect(page.locator('#song-list .song-row')).toHaveCount(5);
  await expect(page.getByRole('button', { name: 'TJ 번호 있음', exact: true })).toBeEnabled();
  await page.getByRole('searchbox').fill('Official Pretender'); await page.getByRole('button', { name: '검색', exact: true }).click();
  await expect(page).toHaveURL(/q=Official\+Pretender/); await expect(page.locator('#song-list')).toContainText('Pretender');
  await page.getByRole('button', { name: 'TJ 번호 있음', exact: true }).click(); await expect(page).toHaveURL(/number=has-tj/);
  await page.reload(); await expect(page.getByRole('searchbox')).toHaveValue('Official Pretender');
  await expect(page.getByRole('button', { name: 'TJ 번호 있음', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: '조건 해제', exact: true }).click(); await expect(page).not.toHaveURL(/q=/);
  await page.goBack(); await expect(page.getByRole('searchbox')).toHaveValue('Official Pretender'); expect(errors).toEqual([]);
});
test('legacy query/detail and favorites hash routes connect to the preserved ID', async ({ page }) => {
  await page.goto('/song.html?id=' + encodeURIComponent(pretender.id)); await expect(page).toHaveURL(pathFor(pretender.id));
  await expect(page.locator('h1')).toHaveText('Pretender'); await page.goto('/#favorites-view'); await expect(page).toHaveURL('/favorites/');
  await page.goto('/filter.html?q=프리텐더&number=has-tj&number=has-ky'); await expect(page).toHaveURL(/search\//);
  await expect(page.locator('#song-list')).toContainText('Pretender');
});
test('existing string/object/missing favorites survive reads, saving and removal', async ({ page }) => {
  await page.addInitScript(({ id }) => { localStorage.setItem('jpop_today_favorites', JSON.stringify([{ id, note: 'preserve' }, 'legacy-unknown-id'])); }, { id: pretender.id });
  await page.goto('/favorites/'); await expect(page.locator('#song-list')).toContainText('Pretender'); await expect(page.locator('#unresolved-list')).toContainText('legacy-unknown-id');
  const before = await page.evaluate(() => localStorage.getItem('jpop_today_favorites')); expect(JSON.parse(before!)[0].note).toBe('preserve');
  await page.getByRole('button', { name: 'Pretender 저장 해제', exact: true }).click();
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('jpop_today_favorites')!))).toEqual(['legacy-unknown-id']);
});
test('corrupted storage remains intact while session favorites can be used', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('jpop_today_favorites', '{broken-json'));
  await page.goto('/'); await page.getByRole('button', { name: 'アイドル 저장', exact: true }).click();
  await expect(page.getByRole('button', { name: 'アイドル 저장 해제', exact: true })).toHaveAttribute('aria-pressed', 'true');
  expect(await page.evaluate(() => localStorage.getItem('jpop_today_favorites'))).toBe('{broken-json');
  await expect(page.locator('#status')).toContainText('이 탭에서만');
  await page.goto('/favorites/'); await expect(page.locator('#song-list')).toContainText('アイドル');
  expect(await page.evaluate(() => localStorage.getItem('jpop_today_favorites'))).toBe('{broken-json');
});
test('clipboard denial opens a usable fallback and unknown numbers have no copy control', async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: () => Promise.reject(new Error('Denied')) } }));
  await page.goto(pathFor(pretender.id)); await page.getByRole('button', { name: 'tj 번호 복사', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible(); await expect(page.locator('#copy-text')).toHaveValue(pretender.karaoke.tj.observedNumber!);
  await page.getByRole('button', { name: '닫기', exact: true }).click(); await expect(page.getByRole('dialog')).not.toBeVisible();
  const missing = catalog.songs.find(song => song.karaoke.ky.status === 'unknown')!;
  await page.goto(pathFor(missing.id)); await expect(page.getByRole('button', { name: 'ky 번호 복사', exact: true })).toHaveCount(0);
});
test('static detail and guide bodies work without JavaScript; archived ID still exists', async ({ browser }) => {
  const context = await browser.newContext({ javaScriptEnabled: false }); const page = await context.newPage();
  await page.goto((process.env.JPOP_TEST_BASE_URL ?? 'http://127.0.0.1:4321') + pathFor(pretender.id)); await expect(page.locator('h1')).toHaveText('Pretender'); await expect(page.locator('main')).toContainText(pretender.artistOriginal);
  await page.goto((process.env.JPOP_TEST_BASE_URL ?? 'http://127.0.0.1:4321') + pathFor(archived.id)); await expect(page.locator('main')).toContainText('보관');
  await page.goto((process.env.JPOP_TEST_BASE_URL ?? 'http://127.0.0.1:4321') + '/guides/build-your-setlist/'); await expect(page.locator('main')).toContainText('현재 브라우저에만 저장됩니다'); await context.close();
});
test('mobile keyboard search, overflow, current count and screenshots', async ({ page }) => {
  await page.goto('/'); await expect(page.locator('#result-count')).toHaveText('3,313곡');
  if (process.env.JPOP_SCREENSHOT_DIR) await page.screenshot({ path: process.env.JPOP_SCREENSHOT_DIR + '/desktop.png', fullPage: true });
  await page.setViewportSize({ width: 360, height: 800 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole('searchbox').fill('프리텐더'); await page.getByRole('searchbox').press('Enter'); await expect(page.locator('#song-list')).toContainText('Pretender');
  if (process.env.JPOP_SCREENSHOT_DIR) await page.screenshot({ path: process.env.JPOP_SCREENSHOT_DIR + '/mobile.png', fullPage: true });
});
test('public boundary and actual 404; preview excludes ads and robots allow', async ({ request }) => {
  for (const path of ['/data/jpop-playlist.raw.json','/data/staging/legacy-catalog.json','/scripts/inspect-cloudflare.py','/missing-route-never-published']) {
    const response = await request.get(path); expect(response.status(), path).toBe(404);
  }
  const root = await request.get('/'); expect(root.headers()['x-robots-tag']).toContain('noindex'); expect(await root.text()).not.toContain('googlesyndication');
  expect(await (await request.get('/robots.txt')).text()).toContain('Disallow: /');
});
