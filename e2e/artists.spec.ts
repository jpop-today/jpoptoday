import { test, expect } from '@playwright/test';
import type { Song } from '../src/lib/catalog';
import { sitemapRoutes } from './helpers/sitemap';

const pathFor = (id: string) => '/songs/' + encodeURIComponent(id) + '/';
const providers = ['tj', 'ky'] as const;
const safe = (song: Song, provider: 'tj' | 'ky') => {
  const value = song.karaoke[provider];
  return value.status === 'provider-confirmed' && !value.conflict && typeof value.observedNumber === 'string'
    && /^[0-9]+$/.test(value.observedNumber) && !/^0+$/.test(value.observedNumber) && value.evidence
    && Object.values(value.evidence).every(field => typeof field === 'string' && field.trim().length > 0);
};
const currentReviewed = (songs: Song[]) => songs.filter(song => song.origin === 'playlist' && song.availability === 'current'
  && providers.some(provider => safe(song, provider)));

test('artist directory independently matches the served reviewed catalog, identity, numbers, evidence and crawler target', async ({ page, request }) => {
  // Checks every reviewed song against the served catalog; grows with the ledger.
  test.setTimeout(120_000);
  const catalog = await (await request.get('/catalog.json')).json() as { songs: Song[] };
  const reviewed = currentReviewed(catalog.songs);
  expect(reviewed.length).toBeGreaterThan(0);
  const ads: string[] = [];
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  page.on('request', request => { if (/googlesyndication|doubleclick|googleadservices/.test(request.url())) ads.push(request.url()); });
  await page.goto('/artists/');
  await expect(page).toHaveTitle('가수별 공식 확인곡 | jpop.today');
  await expect(page.locator('h1')).toHaveText('가수별 공식 확인곡');
  await expect(page.locator('astro-error-overlay')).toHaveCount(0);
  await expect(page.locator('main')).toContainText('미수록');
  await expect(page.locator('main')).toContainText('일부');
  await expect(page.locator('.artist-song')).toHaveCount(reviewed.length);
  await expect(page.locator('.artist-group')).toHaveCount(new Set(reviewed.map(song => song.artistOriginal)).size);
  expect(new Set(await page.locator('.artist-song').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-song-id')))))
    .toEqual(new Set(reviewed.map(song => song.id)));
  for (const song of reviewed) {
    const row = page.locator(`.artist-song[data-song-id="${song.id}"]`);
    await expect(row.locator('h3 a')).toHaveAttribute('href', pathFor(song.id));
    await expect(row.locator('h3')).toContainText(song.titleOriginal);
    const group = page.locator('.artist-group').filter({ has: row });
    await expect(group).toHaveAttribute('data-artist-name', song.artistOriginal);
    await expect(group.locator('h2')).toHaveText(song.artistOriginal);
    for (const provider of providers) {
      const number = row.locator(`.artist-number[data-provider="${provider}"]`);
      const value = song.karaoke[provider];
      if (safe(song, provider)) {
        await expect(number.locator('.artist-number-value')).toHaveText(value.observedNumber!);
        await expect(number).toContainText(value.evidence!.title);
        await expect(number).toContainText(value.evidence!.artist);
        await expect(number.locator('time')).toHaveAttribute('datetime', value.evidence!.checkedAt);
        await expect(number.locator('.artist-evidence')).toHaveAttribute('href', value.evidence!.url);
        await expect(number.locator('.artist-evidence')).toHaveAttribute('target', '_blank');
        await expect(number.locator('.artist-evidence')).toHaveAttribute('rel', /noopener/);
      } else {
        await expect(number.locator('.artist-number-value')).toHaveCount(0);
        await expect(number.locator('.artist-evidence')).toHaveCount(0);
      }
    }
  }
  const info = await (await request.get('/build-info.json')).json();
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', 'https://jpop.today/artists/');
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', info.target === 'production' ? 'index, follow' : 'noindex, follow');
  const sitemap = await sitemapRoutes(request);
  if (info.target === 'production') expect(sitemap).toContain('<loc>https://jpop.today/artists/</loc>');
  else expect(sitemap).not.toContain('<loc>');
  expect(ads).toEqual([]);
  expect(errors).toEqual([]);
  if (process.env.JPOP_SCREENSHOT_DIR) await page.screenshot({ path: process.env.JPOP_SCREENSHOT_DIR + '/artists-desktop.png', fullPage: false });
});

test('artist anchors and existing song details work without JavaScript at 360px using the keyboard', async ({ browser, request }) => {
  const baseURL = process.env.JPOP_TEST_BASE_URL ?? 'http://127.0.0.1:4321';
  const catalog = await (await request.get('/catalog.json')).json() as { songs: Song[] };
  const context = await browser.newContext({ baseURL, javaScriptEnabled: false, viewport: { width: 360, height: 800 } });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto('/artists/');
  await expect(page.locator('main h1')).toBeVisible();
  await expect(page.locator('body')).not.toContainText('Internal Server Error');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  if (process.env.JPOP_SCREENSHOT_DIR) await page.screenshot({ path: process.env.JPOP_SCREENSHOT_DIR + '/artists-mobile.png', fullPage: false });
  const anchor = page.getByRole('navigation', { name: '가수 바로가기' }).locator('a').first();
  const fragment = await anchor.getAttribute('href');
  expect(fragment).toMatch(/^#artist-[a-f0-9]+$/);
  await anchor.focus();
  await expect(anchor).toBeFocused();
  await page.keyboard.press('Enter');
  await expect.poll(() => new URL(page.url()).hash).toBe(fragment);
  const group = page.locator(fragment!);
  const row = group.locator('.artist-song').first();
  const id = await row.getAttribute('data-song-id');
  const song = catalog.songs.find(song => song.id === id)!;
  expect(song).toBeTruthy();
  const link = row.locator('h3 a');
  await link.focus();
  await expect(link).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(pathFor(song.id));
  await expect(page.locator('h1')).toHaveText(song.titleOriginal);
  await expect(page.locator('.artist')).toContainText(song.artistOriginal);
  const provider = providers.find(provider => safe(song, provider))!;
  await expect(page.locator(`a[href="${song.karaoke[provider].evidence!.url}"]`)).toHaveCount(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(errors).toEqual([]);
  await context.close();
});

test('artist discovery preserves existing object favorites, unresolved IDs and the legacy song URL when saving a new song', async ({ page, request }) => {
  const catalog = await (await request.get('/catalog.json')).json() as { songs: Song[] };
  const reviewed = currentReviewed(catalog.songs);
  expect(reviewed.length).toBeGreaterThan(1);
  const oldSong = reviewed[0], newSong = reviewed[1];
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  // Initialize once so subsequent page loads cannot hide a storage rewrite.
  await page.addInitScript(({ id }) => {
    if (localStorage.getItem('jpop_quality_artist_fixture') !== 'ready') {
      localStorage.setItem('jpop_today_favorites', JSON.stringify([{ id, note: 'preserve-existing-note' }, 'unresolved-legacy-id']));
      localStorage.setItem('jpop_quality_artist_fixture', 'ready');
    }
  }, { id: oldSong.id });
  await page.goto('/artists/');
  await page.locator(`.artist-song[data-song-id="${newSong.id}"] h3 a`).click();
  await expect(page).toHaveURL(pathFor(newSong.id));
  const save = page.locator('[data-save]');
  await expect(save).toBeEnabled();
  await save.click();
  await expect(save).toHaveAttribute('aria-pressed', 'true');
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('jpop_today_favorites')!)))
    .toEqual([{ id: oldSong.id, note: 'preserve-existing-note' }, 'unresolved-legacy-id', newSong.id]);
  await page.goto('/song.html?id=' + encodeURIComponent(newSong.id));
  await expect(page).toHaveURL(url => url.pathname === pathFor(newSong.id));
  await expect(page.locator('[data-save]')).toHaveAttribute('aria-pressed', 'true');
  await page.goto('/favorites/');
  await expect(page.locator('#song-list')).toContainText(oldSong.titleOriginal);
  await expect(page.locator('#song-list')).toContainText(newSong.titleOriginal);
  await expect(page.locator('#unresolved-list')).toContainText('unresolved-legacy-id');
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('jpop_today_favorites')!)))
    .toEqual([{ id: oldSong.id, note: 'preserve-existing-note' }, 'unresolved-legacy-id', newSong.id]);
  expect(errors).toEqual([]);
});
