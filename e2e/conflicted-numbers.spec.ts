import { test, expect, type Locator, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Song } from '../src/lib/catalog';

type Provider = 'tj' | 'ky';
type Entry = { songId: string; provider: Provider; action: 'confirm' | 'suppress'; number: string | null;
  evidence: { url: string; checkedAt: string; title: string; artist: string }; reason: string };
const providers: Provider[] = ['tj', 'ky'];
const bytes = (path: string) => readFileSync(new URL('../' + path, import.meta.url));
const staging = JSON.parse(bytes('data/staging/legacy-catalog.json').toString()) as { songs: Song[] };
const ledger = JSON.parse(bytes('data/reviewed/provider-corrections.json').toString()) as { entries: Entry[] };
const chart = JSON.parse(bytes('data/chart-snapshot.json').toString()) as { songs: { canonicalId: string; rank: number }[] };
const edits = new Map(ledger.entries.map(entry => [JSON.stringify([entry.songId, entry.provider]), entry]));
const rawById = new Map(staging.songs.map(song => [song.id, song]));
const editFor = (song: Song, provider: Provider) => edits.get(JSON.stringify([song.id, provider]));
const numberFor = (song: Song, provider: Provider) => {
  const entry = editFor(song, provider);
  return entry ? entry.number : song.karaoke[provider].observedNumber;
};
const frequencies = Object.fromEntries(providers.map(provider => {
  const counts = new Map<string, number>();
  for (const song of staging.songs) {
    const number = numberFor(song, provider);
    if (number !== null) counts.set(number, (counts.get(number) ?? 0) + 1);
  }
  return [provider, counts];
})) as Record<Provider, Map<string, number>>;

// Independent frozen raw + explicit ledger actions + complete post-edit duplicate
// counts. Do not import the app's display/confirmation/export/projection helpers.
function oracle(song: Song, provider: Provider) {
  const entry = editFor(song, provider), number = numberFor(song, provider);
  const conflict = number !== null && frequencies[provider].get(number)! > 1;
  return { number, conflict, entry,
    official: entry?.action === 'confirm' && song.availability === 'current' && song.origin === 'playlist' && !conflict,
    status: entry ? entry.action === 'confirm' ? 'provider-confirmed' : 'unknown' : song.karaoke[provider].status };
}
const conflicts = staging.songs.filter(song => providers.some(provider => oracle(song, provider).conflict));
const preferred = ['アイドル', 'Lemon', '夜に駆ける', '怪獣の花唄', 'Pretender'];
const home = preferred.map(title => staging.songs.find(song => song.titleOriginal === title && song.origin === 'playlist')!);
const pretender = home.at(-1)!;
const observed = staging.songs.find(song => song.availability === 'current' && song.origin === 'playlist'
  && providers.every(provider => !editFor(song, provider) && numberFor(song, provider) !== null && !oracle(song, provider).conflict))!;
const mixed = rawById.get('jpop-playlist-samfree-ルカルカ-ナイトフィ-ハ-f6722acd10')!;
const suppressed = rawById.get('jpop-playlist-radwimps-前前前世-original-ver-1ff3eb38b9')!;
const unknown = staging.songs.find(song => song.availability === 'current' && song.origin === 'playlist'
  && providers.some(provider => numberFor(song, provider) === null && !editFor(song, provider)))!;
const contrasts = [...new Map([pretender, observed, mixed, suppressed, unknown].map(song => [song.id, song])).values()];
const selection = [...conflicts, ...contrasts];
const unresolved = 'legacy-unresolved-conflicted-number-41';
const rawStorage = ` [ ${JSON.stringify({ id: conflicts[0].id, note: '보존', nested: { number: '00041' } })}, ${selection.slice(1).map(song => JSON.stringify(song.id)).join(', ')}, ${JSON.stringify(unresolved)} ] `;
const pathFor = (id: string) => '/songs/' + encodeURIComponent(id) + '/';
const ready = async (page: Page) => expect(page.locator('html')).toHaveAttribute('data-app-ready', 'true');
const rowFor = (page: Page, song: Song) => page.locator(`.song-row[data-song-id="${song.id}"]`);
const overflow = async (page: Page) => expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

async function assertRow(row: Locator, song: Song) {
  await expect(row.locator('.song-name a')).toHaveAttribute('href', pathFor(song.id));
  const cells = row.locator('.number-cell'); await expect(cells).toHaveCount(2);
  for (const [index, provider] of providers.entries()) {
    const cell = cells.nth(index), expected = oracle(song, provider);
    if (expected.conflict) {
      await expect(cell).toContainText('번호 충돌'); await expect(cell).toContainText('재확인 필요');
      await expect(cell).not.toContainText(expected.number!);
      await expect(cell.locator('[data-copy], .number-button')).toHaveCount(0);
      await expect(cell.locator('.verification-badge')).toHaveCount(0);
      await expect(cell).not.toContainText('공식 확인');
    } else if (expected.number !== null) {
      await expect(cell.locator('[data-copy]')).toHaveCount(1);
      await expect(cell.locator('[data-copy]')).toHaveAttribute('data-copy', expected.number);
      await expect(cell.locator('.verification-badge')).toHaveCount(expected.official ? 1 : 0);
      await expect(cell.locator('[data-copy]')).toHaveAccessibleName(new RegExp(expected.official ? '공식 확인 번호' : '관측 번호'));
    } else {
      await expect(cell).toContainText('확인 필요');
      await expect(cell.locator('[data-copy], .verification-badge')).toHaveCount(0);
    }
  }
}

async function assertDetail(page: Page, song: Song) {
  await expect(page.locator('h1')).toHaveText(song.titleOriginal);
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', 'https://jpop.today' + pathFor(song.id));
  for (const [index, provider] of providers.entries()) {
    const section = page.locator('.detail-numbers > section').nth(index), expected = oracle(song, provider);
    const copy = section.getByRole('button', { name: `${provider} 번호 복사`, exact: true });
    if (expected.conflict) {
      await expect(section).toContainText('번호 충돌'); await expect(section).toContainText('재확인 필요');
      await expect(section).toContainText('미수록을 뜻하지 않습니다');
      await expect(section).not.toContainText(expected.number!);
      await expect(copy).toHaveCount(0); await expect(section.locator('[data-copy]')).toHaveCount(0);
      await expect(section).not.toContainText('공식 검색에서 확인');
    } else if (expected.number !== null) {
      await expect(copy).toHaveAttribute('data-copy', expected.number);
      await expect(section).toContainText(expected.official ? '공식 검색에서 확인' : '관측 번호');
      if (!expected.official) await expect(section).not.toContainText('공식 검색에서 확인');
    } else {
      await expect(copy).toHaveCount(0); await expect(section).toContainText('확인 필요');
      await expect(section).toContainText('미수록을 뜻하지 않습니다');
    }
    if (expected.entry) {
      await expect(section).toContainText(expected.entry.reason);
      await expect(section).toContainText(expected.entry.evidence.checkedAt);
      await expect(section.locator('a')).toHaveAttribute('href', expected.entry.evidence.url);
    }
  }
  await expect(page.getByRole('link', { name: '이 곡 정보 제보', exact: true })).toHaveAttribute('href', /^mailto:/);
}

async function captureClipboard(page: Page, denied = false) {
  await page.addInitScript(({ value, reject }) => {
    if (localStorage.getItem('jpop_today_favorites') === null) localStorage.setItem('jpop_today_favorites', value);
    (window as unknown as { __numberCalls: string[] }).__numberCalls = [];
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text: string) => {
      (window as unknown as { __numberCalls: string[] }).__numberCalls.push(text);
      if (reject) throw new DOMException('Denied', 'NotAllowedError');
    } } });
  }, { value: rawStorage, reject: denied });
}

test('frozen actual inputs and public catalog retain all conflict numbers, evidence and stable identities', async ({ request }) => {
  const expectedHashes: Record<string, string> = {
    'data/staging/legacy-catalog.json': 'a3d482ca2da082852883960d200841b4ad4ff26336eaf1174c55677881eecbf3',
    'data/chart-snapshot.json': '7ade29897828967b98b2bca64b285b9694356ad3d2b97498f06270217c91da97',
  };
  for (const [path, hash] of Object.entries(expectedHashes)) expect(createHash('sha256').update(bytes(path)).digest('hex'), path).toBe(hash);
  expect(staging.songs).toHaveLength(3317); expect(ledger.entries.length).toBeGreaterThanOrEqual(92);
  // Whole Issue44 ledger92 remains an immutable prefix, including top-level metadata.
  expect(createHash('sha256').update(JSON.stringify({ ...ledger, entries: ledger.entries.slice(0, 92) })).digest('hex')).toBe('2431130e4f4e3f5c1424322edd65502a9573f660a628922eac280186d3ee16cf');
  // Original Issue41 ledger84 is an immutable prefix; new reviews append only.
  expect(createHash('sha256').update(JSON.stringify({ ...ledger, entries: ledger.entries.slice(0, 84) })).digest('hex')).toBe('5275c44ef1cd30a57b0cf633be33be16d5be500ed8ee4446012cda54be939370');
  expect(conflicts).toHaveLength(4);
  expect(conflicts.flatMap(song => providers.filter(provider => oracle(song, provider).conflict))).toHaveLength(8);
  expect(chart.songs.filter(row => conflicts.some(song => song.id === row.canonicalId)).map(row => row.rank)).toEqual([28, 37]);
  expect(oracle(mixed, 'tj').official).toBe(true); expect(oracle(mixed, 'ky').status).toBe('observed-unverified');
  expect(providers.every(provider => editFor(suppressed, provider)?.action === 'suppress')).toBe(true);
  const publicData = await (await request.get('/catalog.json')).json() as { version: number; songs: Song[] };
  expect(publicData.version).toBe(2); expect(publicData.songs).toHaveLength(staging.songs.length);
  for (const [index, actual] of publicData.songs.entries()) {
    const raw = staging.songs[index];
    const identity = (song: Song) => ({ id: song.id, titleOriginal: song.titleOriginal, titleKo: song.titleKo,
      artistOriginal: song.artistOriginal, artistKo: song.artistKo, tags: song.tags, availability: song.availability, origin: song.origin });
    expect(identity(actual)).toEqual(identity(raw));
    for (const provider of providers) {
      const expected = oracle(raw, provider), entry = expected.entry;
      expect(actual.karaoke[provider], `${raw.id}/${provider}`).toEqual({ status: expected.status,
        observedNumber: expected.number, conflict: expected.conflict,
        evidence: entry ? { url: entry.evidence.url, checkedAt: entry.evidence.checkedAt, title: entry.evidence.title, artist: entry.evidence.artist } : null,
        correction: entry ? { reason: entry.reason, previousNumber: raw.karaoke[provider].observedNumber } : null });
    }
  }
});

test('JavaScript-off home, all static chart rows and all actual conflict details withhold unsafe controls', async ({ browser }) => {
  test.setTimeout(120000);
  const context = await browser.newContext({ javaScriptEnabled: false, viewport: { width: 360, height: 800 } });
  const page = await context.newPage(), base = process.env.JPOP_TEST_BASE_URL ?? 'http://127.0.0.1:4321';
  try {
    await page.goto(base + '/'); await expect(page.locator('#song-list .song-row')).toHaveCount(home.length);
    for (const song of home) await assertRow(rowFor(page, song), song);
    await overflow(page);
    await page.goto(base + '/chart/'); await expect(page.locator('.chart-entry')).toHaveCount(100);
    for (const entry of chart.songs) await assertRow(rowFor(page, rawById.get(entry.canonicalId)!), rawById.get(entry.canonicalId)!);
    for (const song of conflicts.filter(song => chart.songs.some(entry => entry.canonicalId === song.id))) {
      await expect(page.locator(`[data-chart-shortcut][data-song-id="${song.id}"]`)).toHaveCount(0);
    }
    await overflow(page);
    if (process.env.JPOP_SCREENSHOT_DIR) await page.screenshot({ path: process.env.JPOP_SCREENSHOT_DIR + '/conflicted-chart-js-off-mobile.png', fullPage: false });
    for (const song of conflicts) {
      await page.goto(base + pathFor(song.id)); await assertDetail(page, song); await overflow(page);
      await expect(page.locator('.detail-save')).toBeDisabled();
    }
    if (process.env.JPOP_SCREENSHOT_DIR) await page.screenshot({ path: process.env.JPOP_SCREENSHOT_DIR + '/conflicted-detail-js-off-mobile.png', fullPage: false });
  } finally { await context.close(); }
});

test('dynamic search and favorites suppress every real conflict while safe individual and bulk copies preserve storage', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await captureClipboard(page);
  for (const artist of [...new Set(conflicts.map(song => song.artistOriginal))]) {
    await page.goto('/search/?q=' + encodeURIComponent(artist)); await ready(page);
    for (const song of conflicts.filter(song => song.artistOriginal === artist)) await assertRow(rowFor(page, song), song);
  }
  await page.goto('/favorites/'); await ready(page);
  await expect(page.locator('#song-list .song-row')).toHaveCount(selection.length);
  await expect(page.locator('#unresolved-list')).toContainText(unresolved);
  for (const song of selection) await assertRow(rowFor(page, song), song);
  const safeCopy = rowFor(page, mixed).locator('.number-cell').first().locator('[data-copy]');
  await safeCopy.click();
  const calls = () => page.evaluate(() => (window as unknown as { __numberCalls: string[] }).__numberCalls);
  await expect.poll(calls).toEqual([oracle(mixed, 'tj').number]);
  await rowFor(page, mixed).locator('.number-cell').nth(1).locator('[data-copy]').click();
  await expect.poll(calls).toEqual(providers.map(provider => oracle(mixed, provider).number));
  await page.getByRole('button', { name: '번호 목록 복사', exact: true }).click();
  await expect.poll(async () => (await calls()).length).toBe(3);
  const exported = (await calls())[2].split('\n');
  for (const song of conflicts) expect(exported.find(line => line.startsWith(`${song.titleOriginal} · ${song.artistOriginal} |`)))
    .toBe(`${song.titleOriginal} · ${song.artistOriginal} | TJ 확인 필요 | 금영 확인 필요`);
  for (const number of new Set(conflicts.flatMap(song => providers.map(provider => oracle(song, provider).number!))))
    expect((await calls())[2]).not.toContain(number);
  expect(await page.evaluate(() => localStorage.getItem('jpop_today_favorites'))).toBe(rawStorage);
  expect(errors).toEqual([]);
});

test('nonconflict detail copy contrast, legacy conflict URL and mobile keyboard fallback keep existing behavior', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 800 }); await captureClipboard(page, true);
  for (const song of contrasts) { await page.goto(pathFor(song.id)); await ready(page); await assertDetail(page, song); await overflow(page); }
  await page.goto('/song.html?id=' + encodeURIComponent(conflicts[0].id));
  await expect(page).toHaveURL(pathFor(conflicts[0].id)); await assertDetail(page, conflicts[0]);
  await page.goto(pathFor(mixed.id)); await ready(page);
  const copy = page.getByRole('button', { name: 'tj 번호 복사', exact: true });
  await copy.focus(); await expect(copy).toBeFocused();
  const focus = await copy.evaluate(element => ({ outline: getComputedStyle(element).outlineStyle,
    width: Number.parseFloat(getComputedStyle(element).outlineWidth), box: element.getBoundingClientRect().toJSON() }));
  expect(focus.outline).not.toBe('none'); expect(focus.width).toBeGreaterThan(0);
  expect(focus.box.width).toBeGreaterThanOrEqual(44); expect(focus.box.height).toBeGreaterThanOrEqual(44);
  await page.keyboard.press('Enter'); await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.locator('#copy-text')).toHaveValue(oracle(mixed, 'tj').number!); await expect(page.locator('#copy-text')).toBeFocused();
  expect(await page.locator('#copy-text').evaluate(element => { const input = element as HTMLTextAreaElement;
    return { readOnly: input.readOnly, selected: input.value.slice(input.selectionStart, input.selectionEnd) }; }))
    .toEqual({ readOnly: true, selected: oracle(mixed, 'tj').number });
  await overflow(page);
  await page.keyboard.press('Escape'); await expect(page.getByRole('dialog')).not.toBeVisible(); await expect(copy).toBeFocused();
  await page.keyboard.press('Space'); await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('button', { name: '닫기', exact: true }).focus(); await page.keyboard.press('Enter'); await expect(copy).toBeFocused();
  expect(await page.evaluate(() => localStorage.getItem('jpop_today_favorites'))).toBe(rawStorage);
  const colors = await page.evaluate(() => ({ brand: getComputedStyle(document.querySelector('.site-header .brand span')!).backgroundImage,
    body: getComputedStyle(document.body).backgroundImage }));
  expect(colors.brand).toBe('linear-gradient(135deg, rgb(79, 124, 255), rgb(255, 122, 168))');
  for (const color of ['rgba(255, 122, 168, 0.18)', 'rgba(77, 199, 183, 0.16)', 'rgb(238, 245, 255)']) expect(colors.body).toContain(color);
});

test('conflict surfaces follow artifact crawler boundaries and make no advertising requests', async ({ page, request }) => {
  const adRequests: string[] = [];
  page.on('request', request => { const hostname = new URL(request.url()).hostname;
    if (/(?:^|\.)(?:googlesyndication\.com|doubleclick\.net|googleadservices\.com)$/u.test(hostname)) adRequests.push(hostname); });
  const info = await (await request.get('/build-info.json')).json();
  const sitemap = await (await request.get('/sitemap.xml')).text();
  for (const path of ['/', '/chart/', '/search/', '/favorites/', ...conflicts.map(song => pathFor(song.id))]) {
    const response = await request.get(path); expect(response.status()).toBe(200);
    const html = await response.text(); expect(html).not.toMatch(/googlesyndication|doubleclick|googleadservices/iu);
    const privateRoute = ['/search/', '/favorites/', ...conflicts.map(song => pathFor(song.id))].includes(path);
    if (info.target === 'preview' || privateRoute) {
      expect(html).toContain('content="noindex, follow"');
      expect(sitemap).not.toContain('<loc>https://jpop.today' + path + '</loc>');
    }
    if (info.target === 'preview') expect(response.headers()['x-robots-tag']).toContain('noindex');
    await page.goto(path);
  }
  if (info.target === 'preview') expect(await (await request.get('/robots.txt')).text()).toContain('Disallow: /');
  expect(adRequests).toEqual([]);
});
