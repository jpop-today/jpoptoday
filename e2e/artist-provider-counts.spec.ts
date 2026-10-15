import { test, expect, type Page } from '@playwright/test';
import type { Song } from '../src/lib/catalog';

const providers = ['tj', 'ky'] as const;
type Provider = typeof providers[number];
type Counts = { ids: Set<string>; tj: Set<string>; ky: Set<string> };
const emptyCounts = (): Counts => ({ ids: new Set(), tj: new Set(), ky: new Set() });
const pathFor = (id: string) => '/songs/' + encodeURIComponent(id) + '/';

// Recompute from the served public data; do not import the directory implementation.
function providerHasOfficialEvidence(song: Song, provider: Provider): boolean {
  const value = song.karaoke[provider], evidence = value.evidence;
  if (value.status !== 'provider-confirmed' || value.conflict !== false || !evidence
      || typeof value.observedNumber !== 'string' || !/^[0-9]{1,10}$/.test(value.observedNumber)
      || /^0+$/.test(value.observedNumber)
      || !Object.values(evidence).every(field => typeof field === 'string' && field.trim())) return false;
  const url = new URL(evidence.url);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) return false;
  if (provider === 'tj') return ['www.tjmedia.com', 'tjmedia.com'].includes(url.hostname)
    && url.pathname === '/song/accompaniment_search' && url.searchParams.get('strType') === '16'
    && url.searchParams.get('searchTxt') === value.observedNumber && url.searchParams.get('strWord') === 'Y'
    && ['JPN', 'KOR'].includes(url.searchParams.get('nationType') ?? '');
  return url.hostname === 'kygabang.com' && url.pathname === '/chart/search_list.php'
    && url.searchParams.get('mode') === 'SongSearch' && url.searchParams.get('val') === value.observedNumber;
}

function independentCounts(songs: Song[]) {
  const all = emptyCounts(), artists = new Map<string, Counts>();
  for (const song of songs) {
    if (song.origin !== 'playlist' || song.availability !== 'current') continue;
    for (const provider of providers) {
      if (!providerHasOfficialEvidence(song, provider)) continue;
      if (!artists.has(song.artistOriginal)) artists.set(song.artistOriginal, emptyCounts());
      const artist = artists.get(song.artistOriginal)!;
      artist.ids.add(song.id); artist[provider].add(song.id);
      all.ids.add(song.id); all[provider].add(song.id);
    }
  }
  return { all, artists };
}

async function verifyCounts(page: Page, songs: Song[]) {
  const { all, artists } = independentCounts(songs);
  expect(all.ids.size).toBeGreaterThan(0);
  // Real overlap makes treating TJ+KY as the unique song count an observable error.
  expect(all.tj.size + all.ky.size).toBeGreaterThan(all.ids.size);
  await expect(page.locator('[data-directory="songs"]')).toHaveText(`${all.ids.size}개`);
  for (const provider of providers) {
    const count = page.locator(`[data-provider-count="global"][data-provider="${provider}"]`);
    await expect(count).toHaveAttribute('data-count', String(all[provider].size));
    await expect(count).toHaveText(`${all[provider].size}개 ID`);
  }
  await expect(page.locator('#provider-count-note')).toContainText('공식 미수록을 뜻하지 않습니다');
  await expect(page.locator('.provider-summary')).toHaveAttribute('aria-describedby', 'provider-count-note');
  await expect(page.locator('[data-artist-group]')).toHaveCount(artists.size);
  let zeroCount = 0;
  for (const [name, expected] of artists) {
    const group = page.locator('[data-artist-group]').filter({ has: page.getByRole('heading', { name, exact: true, level: 2 }) });
    await expect(group).toHaveAttribute('data-artist-name', name);
    const id = await group.getAttribute('id');
    const anchor = page.locator(`.artist-index a[data-artist-index="${id}"]`);
    await expect(anchor).toHaveAttribute('href', `#${id}`);
    await expect(anchor).toHaveAttribute('aria-describedby', 'provider-count-note');
    await expect(group.locator('.group-provider-counts')).toHaveAttribute('role', 'group');
    await expect(group.locator('.group-provider-counts')).toHaveAttribute('aria-describedby', 'provider-count-note');
    const rowIds = new Set(await group.locator('.artist-song').evaluateAll(rows => rows.map(row => row.getAttribute('data-song-id'))));
    expect(rowIds).toEqual(expected.ids);
    for (const provider of providers) {
      for (const [scope, container] of [['index', anchor], ['group', group]] as const) {
        const count = container.locator(`[data-provider-count="${scope}"][data-provider="${provider}"]`);
        await expect(count).toHaveAttribute('data-count', String(expected[provider].size));
        const label = provider === 'tj' ? 'TJ' : '금영';
        await expect(count).toHaveText(`${label} ${expected[provider].size}${scope === 'index' ? '개 공식 확인곡 ID' : '개 ID'}`);
      }
      const renderedIds = new Set(await group.locator(`.artist-song:has([data-confirmed-number][data-provider="${provider}"])`)
        .evaluateAll(rows => rows.map(row => row.getAttribute('data-song-id'))));
      expect(renderedIds).toEqual(expected[provider]);
      if (expected[provider].size === 0) zeroCount++;
    }
  }
  expect(zeroCount).toBeGreaterThan(0);
  await expect(page.locator('.artist-song[data-song-id="jpop-playlist-ado-ト-ライフラワ-683c11a736"]')).toHaveCount(0);
  await expect(page.locator('main')).toContainText('공식 미수록을 뜻하지 않습니다');
}

test('provider counts independently match distinct reviewed song IDs globally and for every artist index and group', async ({ page, request }) => {
  const catalog = await (await request.get('/catalog.json')).json() as { songs: Song[] };
  const info = await (await request.get('/build-info.json')).json();
  const problems: string[] = [];
  page.on('pageerror', () => problems.push('pageerror'));
  page.on('console', message => { if (['error', 'warning'].includes(message.type())) problems.push(`console-${message.type()}`); });
  page.on('request', request => { if (/googlesyndication|doubleclick|googleadservices/.test(request.url())) problems.push('ad-request'); });
  await page.goto('/artists/');
  await expect(page).toHaveTitle('가수별 공식 확인곡 | jpop.today');
  await expect(page.locator('h1')).toHaveText('가수별 공식 확인곡');
  await expect(page.locator('astro-error-overlay')).toHaveCount(0);
  await expect(page.locator('body')).not.toContainText('Internal Server Error');
  await verifyCounts(page, catalog.songs);
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', 'https://jpop.today/artists/');
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', info.target === 'production' ? 'index, follow' : 'noindex, follow');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(problems).toEqual([]);
  if (process.env.JPOP_SCREENSHOT_DIR) await page.screenshot({ path: process.env.JPOP_SCREENSHOT_DIR + '/artists-provider-counts-desktop.png', fullPage: false });
});

test('provider counts and zero-count meaning remain available at 360px without JavaScript and keyboard links keep the existing song URL', async ({ browser, request }) => {
  const catalog = await (await request.get('/catalog.json')).json() as { songs: Song[] };
  const context = await browser.newContext({ baseURL: process.env.JPOP_TEST_BASE_URL ?? 'http://127.0.0.1:4321',
    javaScriptEnabled: false, viewport: { width: 360, height: 800 } });
  const page = await context.newPage();
  const problems: string[] = [];
  page.on('pageerror', () => problems.push('pageerror'));
  page.on('console', message => { if (['error', 'warning'].includes(message.type())) problems.push(`console-${message.type()}`); });
  page.on('request', request => { if (/googlesyndication|doubleclick|googleadservices/.test(request.url())) problems.push('ad-request'); });
  await page.goto('/artists/');
  await expect(page.locator('main h1')).toBeVisible();
  await verifyCounts(page, catalog.songs);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  if (process.env.JPOP_SCREENSHOT_DIR) await page.screenshot({ path: process.env.JPOP_SCREENSHOT_DIR + '/artists-provider-counts-mobile.png', fullPage: false });
  const anchor = page.locator('.artist-index a[data-artist-index]').first();
  const fragment = await anchor.getAttribute('href');
  expect(fragment).toMatch(/^#artist-[a-f0-9]{16}$/);
  await anchor.focus();
  await expect(anchor).toBeFocused();
  await page.keyboard.press('Enter');
  await expect.poll(() => new URL(page.url()).hash).toBe(fragment);
  const row = page.locator(fragment!).locator('.artist-song').first();
  const id = await row.getAttribute('data-song-id');
  const song = catalog.songs.find(song => song.id === id)!;
  const link = row.locator('h3 a');
  await expect(link).toHaveAttribute('href', pathFor(song.id));
  await link.focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(url => url.pathname === pathFor(song.id));
  await expect(page.locator('h1')).toHaveText(song.titleOriginal);
  const provider = providers.find(provider => providerHasOfficialEvidence(song, provider))!;
  await expect(page.locator(`a[href="${song.karaoke[provider].evidence!.url}"]`)).toHaveCount(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(problems).toEqual([]);
  await context.close();
});
