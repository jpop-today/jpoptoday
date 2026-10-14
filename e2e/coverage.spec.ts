import { test, expect } from '@playwright/test';
import type { Song } from '../src/lib/catalog';

const pathFor = (id: string) => '/songs/' + encodeURIComponent(id) + '/';
const counts = {
  'provider-confirmed': { tj: '22', ky: '20' },
  'observed-unverified': { tj: '3,113', ky: '2,471' },
  unknown: { tj: '164', ky: '808' },
};

test('coverage distinguishes provider numbers, song IDs and unknown within the playlist denominator', async ({ page }) => {
  await page.goto('/coverage/');
  await expect(page).toHaveTitle('관리 목록의 번호 범위 | jpop.today');
  await expect(page.locator('h1')).toHaveText('관리 목록의 번호 범위');
  await expect(page.locator('#coverage-denominator')).toContainText('3,299개 곡 식별자');
  await expect(page.locator('#coverage-denominator')).toContainText('차트 전용 18개 항목은 이 분모와 집계에서 제외');
  for (const [status, providerCounts] of Object.entries(counts)) {
    const row = page.locator(`tr[data-status="${status}"]`);
    for (const [provider, count] of Object.entries(providerCounts)) {
      await expect(row.locator(`td[data-provider="${provider}"]`)).toHaveText(count);
    }
  }
  await expect(page.locator('[data-coverage="confirmed-numbers"]')).toHaveText('42건');
  await expect(page.locator('[data-coverage="confirmed-songs"]')).toHaveText('22개');
  await expect(page.locator('[data-coverage="listed-songs"]')).toHaveText('20개');
  await expect(page.locator('#coverage-count-note')).toContainText('4건은 같은 번호의 다른 항목과 충돌');
  await expect(page.locator('.coverage-note')).toContainText('확인 필요는 미수록이 아닙니다');
  await expect(page.locator('.coverage-note')).toContainText('보류한 13건도 ‘확인 필요’에 포함');
});

test('coverage exposes reviewed string numbers and their official identity, time and stable detail routes', async ({ page, request }) => {
  const catalog = await (await request.get('/catalog.json')).json() as { songs: Song[] };
  const playlist = catalog.songs.filter(song => song.origin === 'playlist');
  const reviewed = playlist.filter(song => song.availability === 'current' && ['tj', 'ky'].some(provider => {
    const value = song.karaoke[provider as 'tj' | 'ky'];
    return value.status === 'provider-confirmed' && value.evidence && !value.conflict;
  }));
  await page.goto('/coverage/');
  await expect(page.locator('.reviewed-song')).toHaveCount(20);
  await expect(page.locator('.reviewed-number strong')).toHaveCount(38);
  for (const song of reviewed) {
    const row = page.locator(`.reviewed-song[data-song-id="${song.id}"]`);
    await expect(row.locator('h3 .song-detail-link')).toHaveAttribute('href', pathFor(song.id));
    await expect(row.locator('.reviewed-artist')).toContainText(song.artistOriginal);
    for (const provider of ['tj', 'ky'] as const) {
      const value = song.karaoke[provider];
      const cell = row.locator(`.reviewed-provider[data-provider="${provider}"]`);
      if (value.status === 'provider-confirmed' && value.evidence && !value.conflict) {
        expect(typeof value.observedNumber).toBe('string');
        await expect(cell.locator('.reviewed-number strong')).toHaveText(value.observedNumber!);
        await expect(cell.locator('.evidence-identity')).toContainText(value.evidence.title);
        await expect(cell.locator('.evidence-identity')).toContainText(value.evidence.artist);
        await expect(cell.locator('time')).toHaveAttribute('datetime', value.evidence.checkedAt);
        await expect(cell.locator('.evidence-link')).toHaveAttribute('href', value.evidence.url);
      } else {
        await expect(cell.locator('.reviewed-number')).toHaveCount(0);
        await expect(cell.locator('.evidence-link')).toHaveCount(0);
      }
    }
  }
  const cover = page.locator('.reviewed-song[data-song-id="jpop-playlist-butter-fly-71e0adeb5b"]');
  await expect(cover.locator('[data-provider="ky"] .reviewed-number strong')).toHaveText('51714');
  await expect(cover.locator('[data-provider="ky"] .reviewed-number')).not.toContainText('40554');
  const turing = page.locator('.reviewed-song[data-song-id="jpop-playlist-ナナヲアカリ-チュ-リンク-ラフ-feat-sou-0adf58fbdd"]');
  await expect(turing.locator('[data-provider="ky"]')).toContainText('확인 필요');
  await expect(turing.locator('[data-provider="ky"]')).toContainText('미수록을 뜻하지 않습니다');
  for (const song of playlist.filter(song => !reviewed.some(reviewedSong => reviewedSong.id === song.id) && ['tj', 'ky'].some(provider => {
    const value = song.karaoke[provider as 'tj' | 'ky'];
    return value.status === 'provider-confirmed' && value.conflict;
  }))) {
    await expect(page.locator(`.reviewed-song[data-song-id="${song.id}"]`)).toHaveCount(0);
  }
  await cover.locator('.song-detail-link').click();
  await expect(page).toHaveURL(pathFor('jpop-playlist-butter-fly-71e0adeb5b'));
  await expect(page.locator('h1')).toHaveText('Butter-Fly');
  await expect(page.locator('.artist')).toContainText('전영호');
});

test('coverage works without JavaScript at 360px with keyboard links and the original palette', async ({ browser }) => {
  const baseURL = process.env.JPOP_TEST_BASE_URL ?? 'http://127.0.0.1:4321';
  const context = await browser.newContext({ baseURL, javaScriptEnabled: false, viewport: { width: 360, height: 800 } });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto('/coverage/');
  await expect(page.locator('main h1')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const colors = await page.evaluate(() => ({
    brand: getComputedStyle(document.querySelector('.site-header .brand span')!).backgroundImage,
    body: getComputedStyle(document.body).backgroundImage,
  }));
  expect(colors.brand).toBe('linear-gradient(135deg, rgb(79, 124, 255), rgb(255, 122, 168))');
  for (const color of ['rgba(255, 122, 168, 0.18)', 'rgba(77, 199, 183, 0.16)', 'rgb(238, 245, 255)']) expect(colors.body).toContain(color);
  if (process.env.JPOP_SCREENSHOT_DIR) await page.screenshot({ path: process.env.JPOP_SCREENSHOT_DIR + '/coverage-mobile.png', fullPage: false });
  const jump = page.getByRole('link', { name: '공식 확인곡 보기', exact: true });
  await jump.focus();
  await expect(jump).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/coverage\/#reviewed-songs$/);
  await expect(page.locator('#reviewed-heading')).toBeInViewport();
  const detail = page.locator('.reviewed-song[data-song-id="jpop-playlist-butter-fly-71e0adeb5b"] .song-detail-link');
  const href = await detail.getAttribute('href');
  await detail.focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(href!);
  await expect(page.locator('h1')).toHaveText('Butter-Fly');
  expect(errors).toEqual([]);
  await context.close();
});
