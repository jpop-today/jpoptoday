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
test('successful reads with denied local writes still restore session favorites on navigation', async ({ page }) => {
  await page.addInitScript(({ id }) => {
    localStorage.setItem('jpop_today_favorites', JSON.stringify([{ id, note: 'preserve' }]));
    const write = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key: string, value: string) {
      if (this === localStorage && key === 'jpop_today_favorites') throw new DOMException('Full', 'QuotaExceededError');
      return write.call(this, key, value);
    };
  }, { id: pretender.id });
  await page.goto('/'); await page.getByRole('button', { name: 'アイドル 저장', exact: true }).click();
  await expect(page.locator('#status')).toContainText('이 탭에서만');
  await page.goto('/favorites/'); await expect(page.locator('#song-list')).toContainText('アイドル'); await expect(page.locator('#song-list')).toContainText('Pretender');
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('jpop_today_favorites')!))).toEqual([{ id: pretender.id, note: 'preserve' }]);
  await expect(page.locator('#storage-note')).toBeVisible();
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
test('public boundary and actual 404; crawler behavior follows the artifact target without ads', async ({ request }) => {
  for (const path of ['/data/jpop-playlist.raw.json','/data/staging/legacy-catalog.json','/data/reviewed/provider-corrections.json','/scripts/inspect-cloudflare.py','/AGENTS.md','/reports/daily/2026-10-14.json','/releases/v0.2.1.json','/missing-route-never-published']) {
    const response = await request.get(path); expect(response.status(), path).toBe(404);
  }
  const root = await request.get('/'); const info = await (await request.get('/build-info.json')).json();
  const html = await root.text(); expect(html).not.toContain('googlesyndication');
  if (info.target === 'preview') { expect(root.headers()['x-robots-tag']).toContain('noindex'); expect(html).toContain('content="noindex, follow"'); expect(await (await request.get('/robots.txt')).text()).toContain('Disallow: /'); }
  else { expect(root.headers()['x-robots-tag'] ?? '').not.toContain('noindex'); expect(html).toContain('content="index, follow"'); expect(await (await request.get('/robots.txt')).text()).toContain('Sitemap: https://jpop.today/sitemap.xml'); }
  expect(await (await request.get('/favorites/')).text()).toContain('content="noindex, follow"');
});

test('reviewed corrections remove wrong-number copy controls and show the official evidence', async ({ page, request }) => {
  const ledger = JSON.parse(readFileSync(new URL('../data/reviewed/provider-corrections.json', import.meta.url), 'utf8'));
  const publicData = await (await request.get('/catalog.json')).json();
  const suppressed = ledger.entries.find((entry: { action: string }) => entry.action === 'suppress');
  // A historical official lookup can still have an unresolved duplicate-number
  // conflict. This positive control must be current, playlist-origin and non-conflicting.
  const confirmed = ledger.entries.find((entry: { action: string; songId: string; provider: 'tj' | 'ky' }) => entry.action === 'confirm'
    && publicData.songs.some((song: Song) => song.id === entry.songId && song.availability === 'current'
      && song.origin === 'playlist' && song.karaoke[entry.provider].conflict === false));
  expect(suppressed).toBeTruthy(); expect(confirmed).toBeTruthy();
  await page.goto(pathFor(suppressed.songId));
  await expect(page.getByRole('button', { name: `${suppressed.provider} 번호 복사`, exact: true })).toHaveCount(0);
  await expect(page.locator('main')).toContainText(suppressed.reason);
  await expect(page.locator('main')).toContainText('미수록을 뜻하지 않습니다');
  if (process.env.JPOP_SCREENSHOT_DIR) await page.screenshot({ path: process.env.JPOP_SCREENSHOT_DIR + '/suppressed-detail.png', fullPage: true });
  await page.goto(pathFor(confirmed.songId));
  await expect(page.getByRole('button', { name: `${confirmed.provider} 번호 복사`, exact: true })).toHaveAttribute('data-copy', confirmed.number);
  await expect(page.locator('main')).toContainText(confirmed.evidence.title);
  await expect(page.locator(`a[href="${confirmed.evidence.url}"]`)).toHaveCount(1);
  if (process.env.JPOP_SCREENSHOT_DIR) await page.screenshot({ path: process.env.JPOP_SCREENSHOT_DIR + '/reviewed-detail.png', fullPage: true });
  expect(publicData.version).toBe(2); expect(JSON.stringify(publicData)).not.toContain('responseSha256');
  const suppressedSong = publicData.songs.find((song: Song) => song.id === suppressed.songId);
  await page.goto('/search/?q=' + encodeURIComponent(suppressedSong.titleOriginal) + '&number=has-' + suppressed.provider);
  await expect(page.locator('html')).toHaveAttribute('data-app-ready', 'true');
  await expect(page.locator(`[data-song-id="${suppressed.songId}"]`)).toHaveCount(0);
  await page.evaluate(id => localStorage.setItem('jpop_today_favorites', JSON.stringify([id])), suppressed.songId);
  await page.addInitScript(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: () => Promise.reject(new Error('Denied')) } }));
  await page.goto('/favorites/');
  await expect(page.locator(`[data-song-id="${suppressed.songId}"]`)).toBeVisible();
  await expect(page.locator(`[data-song-id="${suppressed.songId}"] [data-copy="${suppressed.expectedObservedNumber}"]`)).toHaveCount(0);
  await page.getByRole('button', { name: '번호 목록 복사', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.locator('#copy-text')).toHaveValue(`${suppressedSong.titleOriginal} · ${suppressedSong.artistOriginal} | TJ 확인 필요 | 금영 확인 필요`);
});

test('chart ranks link to stable identities after snapshot rank changes', async ({ page }) => {
  const chart = JSON.parse(readFileSync(new URL('../data/chart-snapshot.json', import.meta.url), 'utf8'));
  await page.goto('/chart/'); await expect(page.locator('.chart-entry')).toHaveCount(100);
  for (const rank of [1, 20, 50, 100]) {
    const row = page.locator('.chart-entry').nth(rank - 1);
    await expect(row.locator('.chart-rank')).toHaveText(String(rank));
    await expect(row.locator('.song-name a')).toHaveAttribute('href', pathFor(chart.songs[rank - 1].canonicalId));
  }
  await expect(page.locator('main')).toContainText(chart.endDate);
});

test('original blue-pink branding and pink-mint-blue background remain visible without mobile overflow', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto('/');
  await expect(page).toHaveTitle(/jpop\.today/);
  await expect(page.locator('h1')).toBeVisible();
  await expect(page.getByRole('searchbox')).toBeEnabled();
  const colors = await page.evaluate(() => ({
    brand: getComputedStyle(document.querySelector('.site-header .brand span')!).backgroundImage,
    body: getComputedStyle(document.body).backgroundImage,
  }));
  expect(colors.brand).toBe('linear-gradient(135deg, rgb(79, 124, 255), rgb(255, 122, 168))');
  for (const color of ['rgba(255, 122, 168, 0.18)', 'rgba(77, 199, 183, 0.16)', 'rgb(238, 245, 255)']) expect(colors.body).toContain(color);
  await page.setViewportSize({ width: 360, height: 800 });
  await page.goto('/chart/');
  await expect(page.locator('.chart-entry')).toHaveCount(100);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  if (process.env.JPOP_SCREENSHOT_DIR) await page.screenshot({ path: process.env.JPOP_SCREENSHOT_DIR + '/chart-mobile.png', fullPage: false });
  expect(errors).toEqual([]);
});

test('actual sitemap and route metadata enforce preview and reviewed-production boundaries', async ({ request }) => {
  const info = await (await request.get('/build-info.json')).json();
  const publicData = await (await request.get('/catalog.json')).json();
  const reviewed = publicData.songs.find((song: Song) => song.availability === 'current' && ['tj', 'ky'].some(provider => {
    const value = song.karaoke[provider as 'tj' | 'ky'];
    return value.status === 'provider-confirmed' && value.evidence && !value.conflict;
  }));
  const unreviewed = publicData.songs.find((song: Song) => song.availability === 'current' && ['tj', 'ky'].every(provider => song.karaoke[provider as 'tj' | 'ky'].status !== 'provider-confirmed'));
  expect(reviewed).toBeTruthy(); expect(unreviewed).toBeTruthy();
  const sitemapResponse = await request.get('/sitemap.xml'); expect(sitemapResponse.ok()).toBe(true);
  const sitemap = await sitemapResponse.text();
  for (const route of ['/search/', '/favorites/', '/song/', pathFor(unreviewed.id), pathFor(archived.id)]) {
    const response = await request.get(route);
    expect(await response.text(), route).toContain('content="noindex, follow"');
    expect(sitemap, route).not.toContain('https://jpop.today' + route);
  }
  const reviewedHtml = await (await request.get(pathFor(reviewed.id))).text();
  if (info.target === 'preview') {
    expect(reviewedHtml).toContain('content="noindex, follow"');
    expect(sitemap).not.toContain('<loc>');
  } else {
    expect(info.target).toBe('production');
    expect(reviewedHtml).toContain('content="index, follow"');
    expect(sitemap).toContain('<loc>https://jpop.today' + pathFor(reviewed.id) + '</loc>');
    expect(sitemap).toContain('<loc>https://jpop.today/</loc>');
  }
});
