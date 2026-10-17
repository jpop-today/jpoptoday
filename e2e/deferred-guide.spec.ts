import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test, expect, type Locator, type Page } from '@playwright/test';
import type { Song } from '../src/lib/catalog';
import { officialLookupMatches } from '../contracts/provider-corrections.mjs';

const guidePath = '/guides/title-artist-variants/';
const guideTitle = '제목·가수 표기가 다를 때 같은 곡인지 확인하는 법';
const ledger = JSON.parse(readFileSync(new URL('../data/reviewed/provider-corrections.json', import.meta.url), 'utf8'));

// Independently transcribed metadata and decisions from the actual Issue27
// requests in docs/data/provider-review-requests-20261016-0400.json. Do not import
// guide content or a UI projection: successful KY lookups were still deferred.
const cases = [
  {
    key: 'samfree', id: 'jpop-playlist-samfree-ルカルカ-ナイトフィ-ハ-f6722acd10',
    title: 'ルカルカ★ナイトフィーバー', artist: 'samfree',
    tj: { number: '27031', title: 'ルカルカ★ ナイトフィーバー', artist: 'samfree(Feat.巡音ルカ)',
      url: 'https://www.tjmedia.com/song/accompaniment_search?nationType=JPN&strType=16&searchTxt=27031&strWord=Y',
      checkedAt: '2026-10-15T19:06:49.340877Z' },
    ky: { number: '43185', title: 'ルカルカ★ナイトフィーバー', artist: 'SAM feat.巡音ルカ',
      url: 'https://kygabang.com/chart/search_list.php?mode=SongSearch&val=43185',
      checkedAt: '2026-10-15T19:06:53.142654Z' },
  },
  {
    key: 'ado', id: 'jpop-playlist-ado-逆光-c8c1ba8b20', title: '逆光', artist: 'Ado',
    tj: { number: '68868', title: "逆光(映画 'ONE PIECE FILM RED' OST)", artist: 'Ado',
      url: 'https://www.tjmedia.com/song/accompaniment_search?nationType=JPN&strType=16&searchTxt=68868&strWord=Y',
      checkedAt: '2026-10-15T19:06:53.828995Z' },
    ky: { number: '76509', title: '逆光(ウタ from ONE PIECE FILM RED)..', artist: 'Ado',
      url: 'https://kygabang.com/chart/search_list.php?mode=SongSearch&val=76509',
      checkedAt: '2026-10-15T19:06:56.561637Z' },
  },
];
type GuideCase = typeof cases[number];
const pathFor = (id: string) => '/songs/' + encodeURIComponent(id) + '/';
const caseSection = (page: Page, item: GuideCase) => page.locator(`section[data-guide-case="${item.id}"]`);

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

async function checkPage(page: Page) {
  await expect(page.locator('main h1')).toBeVisible();
  await expect(page.locator('astro-error-overlay')).toHaveCount(0);
  await expect(page.locator('body')).not.toContainText('Internal Server Error');
  await expect(page.locator('ins.adsbygoogle, iframe[src*="doubleclick"], script[src*="googlesyndication"]')).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
}

async function tabTo(page: Page, link: Locator) {
  for (let step = 0; step < 60; step++) {
    if (await link.evaluate(element => element === document.activeElement)) return;
    await page.keyboard.press('Tab');
  }
  await expect(link).toBeFocused();
}

async function checkCase(page: Page, item: GuideCase) {
  const section = caseSection(page, item);
  const link = section.locator('.guide-section-links a');
  await expect(section).toHaveCount(1);
  for (const provider of ['tj', 'ky'] as const) {
    const expected = item[provider];
    await expect(section).toContainText(expected.number);
    await expect(section).toContainText(expected.title);
    await expect(section).toContainText(expected.artist);
    // Share only the canonical URL-security contract, including www KY and
    // exact port/query rules, rather than inventing a second URL oracle.
    expect(officialLookupMatches(expected.url, provider, expected.number)).toBe(true);
    const source = page.locator('section[aria-labelledby="guide-sources"] li')
      .filter({ has: page.locator(`a[href="${expected.url}"]`) });
    await expect(source).toHaveCount(1);
    await expect(source.locator('time')).toHaveAttribute('datetime', expected.checkedAt);
    await expect(source.locator('a')).toHaveAttribute('target', '_blank');
    await expect(source.locator('a')).toHaveAttribute('rel', /noopener/);
  }
  await expect(link).toHaveCount(1);
  await expect(link).toHaveAttribute('href', pathFor(item.id));
  await expect(link).toContainText(item.title);
  await expect(link).toContainText(item.artist);
  await expect(link).toContainText('곡 상세');
  await link.scrollIntoViewIfNeeded();
  const bounds = await link.boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.height).toBeGreaterThanOrEqual(44);
  expect(bounds!.width).toBeGreaterThanOrEqual(44);
  return link;
}

function checkCatalog(songs: Song[]) {
  expect(songs).toHaveLength(3317);
  expect(new Set(songs.map(song => song.id)).size).toBe(3317);
  // Issue35 appends independently reviewed confirmations. Preserve the complete
  // original Issue30 ledger prefix (base2964f7e), rather than freezing its length
  // and preventing unrelated reviewed additions. The full current ledger hash
  // is still compared with build-info below; contract validation checks appends.
  expect(ledger.entries.length).toBeGreaterThanOrEqual(77);
  expect(createHash('sha256').update(JSON.stringify(ledger.entries.slice(0, 77))).digest('hex'))
    .toBe('c2396a2aa93c550e40dd8881527db06305fd01926f9498b54196a2db803e83cb');
  for (const item of cases) {
    const matches = songs.filter(song => song.id === item.id);
    expect(matches).toHaveLength(1);
    const song = matches[0];
    expect({ title: song.titleOriginal, artist: song.artistOriginal, origin: song.origin, availability: song.availability })
      .toEqual({ title: item.title, artist: item.artist, origin: 'playlist', availability: 'current' });
    const { number, ...evidence } = item.tj;
    expect(song.karaoke.tj).toMatchObject({ status: 'provider-confirmed', observedNumber: number, conflict: false, evidence });
    const entry = ledger.entries.filter((entry: { songId: string; provider: string }) => entry.songId === item.id && entry.provider === 'tj');
    expect(entry).toHaveLength(1);
    expect(entry[0]).toMatchObject({ action: 'confirm', expectedObservedNumber: number, number, evidence });
    expect(ledger.entries.filter((entry: { songId: string; provider: string }) => entry.songId === item.id && entry.provider === 'ky')).toEqual([]);
    expect(song.karaoke.ky).toMatchObject({ status: 'observed-unverified', observedNumber: item.ky.number, evidence: null, correction: null });
    for (const provider of ['tj', 'ky'] as const) expect(typeof song.karaoke[provider].observedNumber).toBe('string');
  }
}

test('deferred guide SSR links and historical sources match independent catalog and ledger evidence', async ({ page, request }) => {
  const catalogResponse = await request.get('/catalog.json');
  expect(catalogResponse.status()).toBe(200);
  const catalog = await catalogResponse.json() as { songs: Song[] };
  checkCatalog(catalog.songs);
  const info = await (await request.get('/build-info.json')).json();
  expect(info.ledgerSha256).toBe(createHash('sha256').update(JSON.stringify(ledger)).digest('hex'));
  const problems = observePage(page);
  const response = await page.goto(guidePath);
  expect(response?.status()).toBe(200);
  await expect(page).toHaveTitle(guideTitle + ' | jpop.today');
  await expect(page.locator('h1')).toHaveText(guideTitle);
  const ssr = await response!.text();
  for (const item of cases) {
    expect(ssr).toContain(`href="${pathFor(item.id)}"`);
    await checkCase(page, item);
  }
  // The common guidance must still distinguish deferral from an official
  // absence; exact editorial paragraphs are deliberately not snapshotted.
  await expect(page.locator('main')).toContainText('공식 미수록');
  await checkPage(page);
  expect(problems).toEqual([]);
  if (process.env.JPOP_SCREENSHOT_DIR) {
    await caseSection(page, cases[0]).scrollIntoViewIfNeeded();
    await page.screenshot({ path: process.env.JPOP_SCREENSHOT_DIR + '/guide-deferred-desktop.png', fullPage: false });
  }
});

for (const item of cases) test(`${item.key} guide to exact detail, evidence and report works by keyboard with JS off at 360px`, async ({ browser, request }) => {
  const catalog = await (await request.get('/catalog.json')).json() as { songs: Song[] };
  checkCatalog(catalog.songs);
  const context = await browser.newContext({ baseURL: process.env.JPOP_TEST_BASE_URL ?? 'http://127.0.0.1:4321',
    javaScriptEnabled: false, viewport: { width: 360, height: 800 } });
  const page = await context.newPage();
  const problems = observePage(page);
  try {
    await page.goto('/guides/');
    await expect(page.locator('.guide-list > li')).toHaveCount(6);
    const entry = page.getByRole('link', { name: guideTitle, exact: true });
    await tabTo(page, entry);
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(guidePath);
    await expect(page.locator('h1')).toHaveText(guideTitle);
    const detail = await checkCase(page, item);
    await checkPage(page);
    const colors = await page.evaluate(() => ({
      brand: getComputedStyle(document.querySelector('.site-header .brand span')!).backgroundImage,
      body: getComputedStyle(document.body).backgroundImage,
    }));
    expect(colors.brand).toBe('linear-gradient(135deg, rgb(79, 124, 255), rgb(255, 122, 168))');
    for (const color of ['rgba(255, 122, 168, 0.18)', 'rgba(77, 199, 183, 0.16)', 'rgb(238, 245, 255)']) expect(colors.body).toContain(color);
    await tabTo(page, detail);
    if (process.env.JPOP_SCREENSHOT_DIR) await page.screenshot({ path: process.env.JPOP_SCREENSHOT_DIR + `/guide-deferred-${item.key}-mobile.png`, fullPage: false });
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(url => url.pathname === pathFor(item.id));
    await expect(page.locator('h1')).toHaveText(item.title);
    await expect(page.locator('.song-detail > .artist')).toContainText(item.artist);
    const tj = page.locator('.detail-numbers > section').filter({ has: page.getByRole('heading', { name: 'TJ', exact: true }) });
    const ky = page.locator('.detail-numbers > section').filter({ has: page.getByRole('heading', { name: '금영', exact: true }) });
    await expect(tj.locator('[data-copy]')).toHaveAttribute('data-copy', item.tj.number);
    await expect(tj).toContainText('공식 검색에서 확인');
    await expect(tj).toContainText(item.tj.title);
    await expect(tj).toContainText(item.tj.artist);
    await expect(tj).toContainText(item.tj.checkedAt);
    const official = tj.getByRole('link', { name: '공식 대조 결과', exact: true });
    await expect(official).toHaveAttribute('href', item.tj.url);
    await expect(official).toHaveAttribute('target', '_blank');
    await expect(official).toHaveAttribute('rel', /noopener/);
    await expect(ky.locator('[data-copy]')).toHaveAttribute('data-copy', item.ky.number);
    await expect(ky).toContainText('관측 번호 · 재확인 필요');
    await expect(ky).not.toContainText('공식 검색에서 확인');
    await expect(ky.locator('a')).toHaveCount(0);
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', 'https://jpop.today' + pathFor(item.id));
    await checkPage(page);
    if (process.env.JPOP_SCREENSHOT_DIR) await page.screenshot({ path: process.env.JPOP_SCREENSHOT_DIR + `/guide-deferred-${item.key}-detail-mobile.png`, fullPage: false });
    await tabTo(page, official);
    const report = page.getByRole('link', { name: '이 곡 정보 제보', exact: true });
    await tabTo(page, report);
    // No-JavaScript users must receive the usable mailto itself. Cloudflare's
    // /cdn-cgi/l/email-protection fallback needs its decoder and is not usable
    // here; do not decode it in this test or supply a URL base to hide that.
    await expect(report).toHaveAttribute('href', /^mailto:/);
    const mail = new URL((await report.getAttribute('href'))!);
    expect(mail.protocol).toBe('mailto:');
    expect(mail.searchParams.get('subject')).toContain(item.title);
    expect(mail.searchParams.get('body')).toContain(`${item.title} / ${item.artist}`);
    expect(mail.searchParams.get('body')).toContain('https://jpop.today' + pathFor(item.id));
    await page.goBack();
    await expect(page).toHaveURL(guidePath);
    const contact = page.locator('article').getByRole('link', { name: '문의와 정정', exact: true });
    await tabTo(page, contact);
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL('/contact/');
    await expect(page.locator('h1')).toHaveText('문의와 정보 정정');
    const email = page.locator('article a[href^="mailto:"]');
    await expect(email).toHaveCount(1);
    await expect(email).toHaveAttribute('href', 'mailto:' + mail.pathname);
    await tabTo(page, email);
    await checkPage(page);
    await page.goto('/privacy/');
    const privacyEmail = page.locator('article a[href^="mailto:"]');
    await expect(privacyEmail).toHaveCount(1);
    await expect(privacyEmail).toHaveAttribute('href', 'mailto:' + mail.pathname);
    await tabTo(page, privacyEmail);
    await checkPage(page);
    await page.goBack();
    await expect(page).toHaveURL('/contact/');
    await page.goBack();
    await expect(page).toHaveURL(guidePath);
    const back = page.locator('article > a.back-link');
    await tabTo(page, back);
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL('/guides/');
    await checkPage(page);
    expect(problems).toEqual([]);
  } finally {
    await context.close();
  }
});
