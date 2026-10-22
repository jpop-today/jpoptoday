import { test, expect } from '@playwright/test';
import { sitemapRoutes } from './helpers/sitemap';

const path = '/guides/title-artist-variants/';
const title = '제목·가수 표기가 다를 때 같은 곡인지 확인하는 법';
const officialSources = [
  ['https://www.tjmedia.com/song/accompaniment_search?nationType=JPN&strType=16&searchTxt=27527&strWord=Y', '2026-10-15T03:03:41.493546+09:00'],
  ['https://kygabang.com/chart/search_list.php?mode=SongSearch&val=43372', '2026-10-15T03:03:44.173265+09:00'],
  ['https://www.tjmedia.com/song/accompaniment_search?nationType=JPN&strType=16&searchTxt=52972&strWord=Y', '2026-10-15T03:03:47.678068+09:00'],
  ['https://kygabang.com/chart/search_list.php?mode=SongSearch&val=57784', '2026-10-15T03:03:50.023395+09:00'],
];

test('title and artist guide presents original comparison advice, exact historical sources and target-appropriate indexing', async ({ page, request }) => {
  const errors: string[] = [], ads: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  page.on('request', request => { if (/googlesyndication|doubleclick|googleadservices/.test(request.url())) ads.push(request.url()); });
  await page.goto(path);
  await expect(page).toHaveURL(path);
  await expect(page).toHaveTitle(title + ' | jpop.today');
  await expect(page.locator('h1')).toHaveText(title);
  await expect(page.locator('astro-error-overlay')).toHaveCount(0);
  await expect(page.locator('.verification-note time')).toHaveAttribute('datetime', '2026-10-16');
  await expect(page.locator('main')).toContainText('米津玄師，宇多田ヒカル');
  await expect(page.locator('main')).toContainText('米津玄師 & 宇多田ヒカル');
  await expect(page.locator('main')).toContainText('米津玄師、宇多田ヒカル');
  await expect(page.locator('main')).toContainText('Some Like it Hot');
  await expect(page.locator('main')).toContainText('Some Like It Hot!!');
  await expect(page.locator('main')).toContainText('현장 기기');
  await expect(page.locator('main')).toContainText('공식 미수록을 확인했다는 뜻이 아닙니다');
  await expect(page.locator('main')).toContainText('번호를 새로 조회한 시각이 아닙니다');
  const sources = page.locator('section[aria-labelledby="guide-sources"]');
  await expect(sources.locator('li')).toHaveCount(8);
  for (const [url, checkedAt] of officialSources) {
    const row = sources.locator('li').filter({ has: page.locator(`a[href="${url}"]`) });
    await expect(row.locator('a')).toHaveAttribute('target', '_blank');
    await expect(row.locator('a')).toHaveAttribute('rel', /noopener/);
    await expect(row.locator('time')).toHaveAttribute('datetime', checkedAt);
  }
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', 'https://jpop.today' + path);
  const info = await (await request.get('/build-info.json')).json();
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', info.target === 'production' ? 'index, follow' : 'noindex, follow');
  const sitemap = await sitemapRoutes(request);
  if (info.target === 'production') expect(sitemap).toContain('<loc>https://jpop.today' + path + '</loc>');
  else expect(sitemap).not.toContain('<loc>');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(errors).toEqual([]);
  expect(ads).toEqual([]);
  if (process.env.JPOP_SCREENSHOT_DIR) await page.screenshot({ path: process.env.JPOP_SCREENSHOT_DIR + '/title-artist-guide-desktop.png', fullPage: false });
});

test('guide index reaches the comparison guide without JavaScript at 360px and leaves older review dates unchanged', async ({ browser, request }) => {
  const baseURL = process.env.JPOP_TEST_BASE_URL ?? 'http://127.0.0.1:4321';
  const context = await browser.newContext({ baseURL, javaScriptEnabled: false, viewport: { width: 360, height: 800 } });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto('/guides/');
  await expect(page.locator('.guide-list > li').filter({ hasNotText: '(작성 중)' })).toHaveCount(6);
  const entry = page.getByRole('link', { name: title, exact: true });
  await entry.focus();
  await expect(entry).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(path);
  await expect(page.locator('h1')).toHaveText(title);
  await expect(page.locator('body')).not.toContainText('Internal Server Error');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  if (process.env.JPOP_SCREENSHOT_DIR) await page.screenshot({ path: process.env.JPOP_SCREENSHOT_DIR + '/title-artist-guide-mobile.png', fullPage: false });
  const contact = page.locator('article').getByRole('link', { name: '문의와 정정', exact: true });
  await contact.focus();
  await expect(contact).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL('/contact/');
  await expect(page.locator('h1')).toHaveText('문의와 정보 정정');
  // Issue51 edits the setlist guide; the other five guide dates remain unchanged.
  const firstGuide = await request.get('/guides/find-japanese-songs/');
  expect(firstGuide.status()).toBe(200);
  expect(await firstGuide.text()).toMatch(/datetime="2026-10-20"/);
  for (const slug of ['checking-song-numbers']) {
    const response = await request.get(`/guides/${slug}/`);
    expect(response.status()).toBe(200);
    expect(await response.text()).toMatch(/datetime="2026-10-14"/);
  }
  const chartGuide = await request.get('/guides/read-tj-chart/');
  expect(chartGuide.status()).toBe(200);
  const chartGuideHtml = await chartGuide.text();
  expect(chartGuideHtml).toMatch(/datetime="2026-10-20"/);
  expect(chartGuideHtml).toContain('두 업체');
  const providerGuide = await request.get('/guides/tj-ky-numbers/');
  expect(providerGuide.status()).toBe(200);
  const providerGuideHtml = await providerGuide.text();
  expect(providerGuideHtml).toMatch(/datetime="2026-10-19"/);
  expect(providerGuideHtml).toContain('번호 충돌 · 재확인 필요');
  const setlist = await request.get('/guides/build-your-setlist/');
  expect(setlist.status()).toBe(200);
  const setlistHtml = await setlist.text();
  expect(setlistHtml).toMatch(/datetime="2026-10-21"/);
  expect(setlistHtml).toContain('공식 확인, 관측·미확인, 확인 필요');
  expect(errors).toEqual([]);
  await context.close();
});
