import { test, expect } from '@playwright/test';

test('number-checking guide renders correction cases and dated official sources without JavaScript', async ({ browser, request }) => {
  const baseURL = process.env.JPOP_TEST_BASE_URL ?? 'http://127.0.0.1:4321';
  const context = await browser.newContext({ baseURL, javaScriptEnabled: false, viewport: { width: 360, height: 800 } });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto('/guides/');
  await page.locator('a[href="/guides/checking-song-numbers/"]').click();
  await expect(page.locator('main h1')).toBeVisible();
  await expect(page.locator('article')).toContainText('전영호의 한국어판은 금영 51714');
  await expect(page.locator('article')).toContainText('和田光司의 곡은 금영 40554');
  await expect(page.locator('article')).toContainText('금영 대체 번호는 이 확인 기록에서 확보하지 못했습니다');
  await expect(page.locator('article')).toContainText('페이지를 연 시각이 번호를 새로 조회한 시각은 아닙니다');
  const sources = page.locator('section[aria-labelledby="guide-sources"]');
  await expect(sources.locator('a')).toHaveCount(4);
  await expect(sources.locator('a[href*="val=51714"]')).toHaveAttribute('target', '_blank');
  for (const checkedAt of await sources.locator('time').evaluateAll(nodes => nodes.map(node => node.getAttribute('datetime')))) {
    expect(new Date(checkedAt!).toISOString()).toMatch(/^2026-10-14T05:1[78]:/);
  }
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', 'https://jpop.today/guides/checking-song-numbers/');
  const metadata = await (await request.get('/build-info.json')).json();
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', metadata.target === 'production' ? 'index, follow' : 'noindex, follow');
  const sitemap = await (await request.get('/sitemap.xml')).text();
  if (metadata.target === 'production') expect(sitemap).toContain('<loc>https://jpop.today/guides/checking-song-numbers/</loc>');
  else expect(sitemap).not.toContain('<loc>');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const contact = page.locator('a[href="/contact/"]').first();
  await contact.focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/contact\/$/);
  await expect(page.locator('main h1')).toBeVisible();
  expect(errors).toEqual([]);
  await context.close();
});

test('home provides a direct entry to reviewed numbers while all six guides remain available', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('link', { name: '공식 확인 번호', exact: true }).click();
  await expect(page).toHaveURL(/\/coverage\/$/);
  await expect(page.locator('#reviewed-heading')).toBeVisible();
  await page.goto('/guides/');
  await expect(page.locator('.guide-list > li')).toHaveCount(6);
  for (const slug of ['find-japanese-songs', 'tj-ky-numbers', 'build-your-setlist', 'read-tj-chart', 'checking-song-numbers']) {
    await expect(page.locator(`.guide-list a[href="/guides/${slug}/"]`)).toBeVisible();
  }
});
