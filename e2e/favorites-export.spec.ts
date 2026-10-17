import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import type { Song } from '../src/lib/catalog';

const staging = JSON.parse(readFileSync(new URL('../data/staging/legacy-catalog.json', import.meta.url), 'utf8')) as { songs: Song[] };
type Entry = { songId: string; provider: 'tj' | 'ky'; action: 'confirm' | 'suppress'; number: string | null };
const ledger = JSON.parse(readFileSync(new URL('../data/reviewed/provider-corrections.json', import.meta.url), 'utf8')) as { entries: Entry[] };
const providers = ['tj', 'ky'] as const;
const rawById = new Map(staging.songs.map(song => [song.id, song]));
const entries = new Map(ledger.entries.map(entry => [JSON.stringify([entry.songId, entry.provider]), entry]));
const correctedNumber = (song: Song, provider: 'tj' | 'ky') => {
  const entry = entries.get(JSON.stringify([song.id, provider]));
  return entry ? entry.number : song.karaoke[provider].observedNumber;
};
const counts = Object.fromEntries(providers.map(provider => {
  const result = new Map<string, number>();
  for (const song of staging.songs) {
    const number = correctedNumber(song, provider);
    if (number !== null) result.set(number, (result.get(number) ?? 0) + 1);
  }
  return [provider, result];
})) as Record<'tj' | 'ky', Map<string, number>>;

// Expected text comes from frozen raw cells + reviewed actions + independent
// duplicate counts, never the formatter, confirmation predicate or search matcher.
function oracle(song: Song, provider: 'tj' | 'ky') {
  const entry = entries.get(JSON.stringify([song.id, provider]));
  const number = correctedNumber(song, provider);
  const conflict = number !== null && (counts[provider].get(number) ?? 0) > 1;
  const official = entry?.action === 'confirm' && song.availability === 'current' && song.origin === 'playlist' && !conflict;
  const observed = !entry && song.karaoke[provider].status === 'observed-unverified' && number !== null && !conflict;
  const label = provider === 'tj' ? 'TJ' : '금영';
  return { number, conflict, official, observed,
    status: entry ? entry.action === 'confirm' ? 'provider-confirmed' : 'unknown' : song.karaoke[provider].status,
    text: `${label} ${official ? `${number} (공식 확인)` : observed ? `${number} (관측·미확인)` : '확인 필요'}` };
}
const expectedLine = (song: Song) => `${song.titleOriginal} · ${song.artistOriginal} | ${oracle(song, 'tj').text} | ${oracle(song, 'ky').text}`;
const preferred = ['アイドル', 'Lemon', '夜に駆ける', '怪獣の花唄', 'Pretender']
  .map(title => staging.songs.find(song => song.titleOriginal === title && song.origin === 'playlist')!.id);
const priority = (id: string) => preferred.includes(id) ? preferred.indexOf(id) : 100;
const ordered = [...staging.songs].sort((a, b) => priority(a.id) - priority(b.id));
const orderedSelection = (ids: string[]) => ordered.filter(song => ids.includes(song.id));
const expectedExport = (songs: Song[]) => songs.map(expectedLine).join('\n');
const pretender = staging.songs.find(song => song.titleOriginal === 'Pretender' && song.origin === 'playlist')!;
const sam = rawById.get('jpop-playlist-samfree-ルカルカ-ナイトフィ-ハ-f6722acd10')!;
const ado = rawById.get('jpop-playlist-ado-逆光-c8c1ba8b20')!;
const original = rawById.get('jpop-playlist-radwimps-前前前世-original-ver-1ff3eb38b9')!;
const missingProvider = staging.songs.find(song => oracle(song, 'tj').official && oracle(song, 'ky').number === null)!;
const conflict = staging.songs.find(song => song.availability === 'current' && song.origin === 'playlist' && providers.some(provider => oracle(song, provider).conflict))!;
const observedOnly = staging.songs.find(song => song.availability === 'current' && song.origin === 'playlist'
  && providers.every(provider => oracle(song, provider).observed))!;
const mixed = orderedSelection([...new Set([pretender, sam, ado, original, missingProvider, conflict, observedOnly].map(song => song.id))]);
const unresolved = 'legacy-unknown-export-id';
const storageRaw = (songs: Song[]) => ` [ ${JSON.stringify({ id: songs.at(-1)!.id, note: '원문 보존', extra: { value: '00123' } })}, ${songs.slice(0, -1).map(song => JSON.stringify(song.id)).join(', ')}, ${JSON.stringify(unresolved)} ] `;
const ready = async (page: Page) => { await expect(page.locator('html')).toHaveAttribute('data-app-ready', 'true'); };
const copyButton = (page: Page) => page.getByRole('button', { name: '번호 목록 복사', exact: true });
type ClipboardState = { calls: string[]; value: string };

async function captureClipboard(page: Page, raw: string, denied = false) {
  await page.addInitScript(({ value, reject }) => {
    if (localStorage.getItem('jpop_today_favorites') === null) localStorage.setItem('jpop_today_favorites', value);
    const state: ClipboardState = { calls: [], value: '이전 클립보드 원문' };
    (window as unknown as { __exportClipboard: ClipboardState }).__exportClipboard = state;
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
      writeText: async (text: string) => {
        state.calls.push(text);
        if (reject) throw new DOMException('Denied', 'NotAllowedError');
        state.value = text;
      },
    } });
  }, { value: raw, reject: denied });
}
const clipboardState = (page: Page) => page.evaluate(() => (window as unknown as { __exportClipboard: ClipboardState }).__exportClipboard);
const assertRaw = async (page: Page, raw: string) => expect(await page.evaluate(() => localStorage.getItem('jpop_today_favorites'))).toBe(raw);

test('successful clipboard export preserves each real provider state and exact legacy storage bytes', async ({ page, request }) => {
  expect(mixed.length).toBeGreaterThanOrEqual(6);
  expect(oracle(sam, 'tj').official && oracle(sam, 'ky').observed).toBe(true);
  expect(oracle(ado, 'tj').official && oracle(ado, 'ky').observed).toBe(true);
  expect(providers.some(provider => oracle(conflict, provider).conflict)).toBe(true);
  expect(providers.every(provider => oracle(original, provider).number === null)).toBe(true);
  const raw = storageRaw(mixed), expected = expectedExport(mixed), errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await captureClipboard(page, raw);
  await page.goto('/favorites/'); await ready(page);
  await expect(page).toHaveTitle('내 즐겨찾기 | jpop.today');
  await expect(page.locator('h1')).toHaveText('내 즐겨찾기');
  await expect(page.locator('#song-list > .song-row')).toHaveCount(mixed.length);
  expect(await page.locator('#song-list > .song-row').evaluateAll(rows => rows.map(row => row.getAttribute('data-song-id')))).toEqual(mixed.map(song => song.id));
  await expect(page.locator('#unresolved-list')).toContainText(unresolved);
  // Also reject a stale/mismatched served catalog before asserting copied text.
  const payload = await (await request.get('/catalog.json')).json() as { songs: Song[] };
  for (const song of mixed) for (const provider of providers) {
    const actual = payload.songs.find(value => value.id === song.id)!.karaoke[provider], independent = oracle(song, provider);
    expect({ number: actual.observedNumber, status: actual.status, conflict: actual.conflict })
      .toEqual({ number: independent.number, status: independent.status, conflict: independent.conflict });
  }
  await copyButton(page).click();
  await expect.poll(async () => (await clipboardState(page)).calls).toEqual([expected]);
  expect((await clipboardState(page)).value).toBe(expected);
  await expect(page.locator('#status')).toHaveText('복사했습니다.');
  await expect(page.getByRole('dialog')).not.toBeVisible();
  expect(expected).not.toContain(unresolved); expect(expected).not.toMatch(/미수록|undefined|null/u);
  await assertRaw(page, raw); expect(errors).toEqual([]);
  if (process.env.JPOP_SCREENSHOT_DIR) await page.screenshot({ path: process.env.JPOP_SCREENSHOT_DIR + '/favorites-export-desktop.png', fullPage: false });
});

test('clipboard denial leaves a selected read-only manual copy fallback usable by keyboard at 360px', async ({ page }) => {
  const raw = storageRaw(mixed), expected = expectedExport(mixed);
  await page.setViewportSize({ width: 360, height: 800 });
  await captureClipboard(page, raw, true);
  await page.goto('/favorites/'); await ready(page);
  const copy = copyButton(page); await copy.focus(); await expect(copy).toBeFocused();
  const focus = await copy.evaluate(element => ({ outline: getComputedStyle(element).outlineStyle,
    width: Number.parseFloat(getComputedStyle(element).outlineWidth), box: element.getBoundingClientRect().toJSON() }));
  expect(focus.outline).not.toBe('none'); expect(focus.width).toBeGreaterThan(0);
  expect(focus.box.width).toBeGreaterThanOrEqual(44); expect(focus.box.height).toBeGreaterThanOrEqual(44);
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog'), text = page.getByRole('textbox', { name: '복사할 번호 목록', exact: true });
  await expect(dialog).toBeVisible(); await expect(text).toHaveValue(expected); await expect(text).toBeFocused();
  expect(await text.evaluate(element => { const input = element as HTMLTextAreaElement;
    return { readOnly: input.readOnly, selected: input.value.slice(input.selectionStart, input.selectionEnd) }; }))
    .toEqual({ readOnly: true, selected: expected });
  expect((await clipboardState(page)).value).toBe('이전 클립보드 원문');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const bounds = await dialog.boundingBox(); expect(bounds).not.toBeNull();
  expect(bounds!.x).toBeGreaterThanOrEqual(0); expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(360);
  if (process.env.JPOP_SCREENSHOT_DIR) await page.screenshot({ path: process.env.JPOP_SCREENSHOT_DIR + '/favorites-export-mobile-fallback.png', fullPage: false });
  await page.keyboard.press('Escape'); await expect(dialog).not.toBeVisible(); await expect(copy).toBeFocused();
  await page.keyboard.press('Space'); await expect(dialog).toBeVisible();
  await page.getByRole('button', { name: '닫기', exact: true }).focus(); await page.keyboard.press('Enter');
  await expect(dialog).not.toBeVisible(); await expect(copy).toBeFocused();
  expect((await clipboardState(page)).calls).toEqual([expected, expected]);
  await assertRaw(page, raw);
});

test('filtered export includes every matching saved song beyond 30 and page two, then respects both-provider AND', async ({ page }) => {
  const selected = ordered.filter(song => oracle(song, 'tj').official);
  const both = selected.filter(song => oracle(song, 'ky').official);
  expect(selected.length).toBeGreaterThan(30); expect(both.length).toBeGreaterThan(0); expect(both.length).toBeLessThan(selected.length);
  const raw = storageRaw([...selected, observedOnly, conflict, original]);
  await captureClipboard(page, raw);
  await page.goto('/favorites/?number=confirmed-tj&page=2'); await ready(page);
  await expect(page.locator('#result-count')).toHaveText(`${selected.length.toLocaleString('ko-KR')}곡`);
  const visible = selected.slice(30, 60);
  expect(visible.length).toBeGreaterThan(0);
  await expect(page.locator('#song-list > .song-row')).toHaveCount(visible.length);
  expect(await page.locator('#song-list > .song-row').evaluateAll(rows => rows.map(row => row.getAttribute('data-song-id')))).toEqual(visible.map(song => song.id));
  await copyButton(page).click();
  await expect.poll(async () => (await clipboardState(page)).value).toBe(expectedExport(selected));
  expect((await clipboardState(page)).value.split('\n')).toHaveLength(selected.length);
  await page.getByRole('button', { name: '금영 공식 확인', exact: true }).click();
  expect(new URL(page.url()).searchParams.get('page')).toBeNull();
  expect(new Set(new URL(page.url()).searchParams.getAll('number'))).toEqual(new Set(['confirmed-tj', 'confirmed-ky']));
  await expect(page.locator('#result-count')).toHaveText(`${both.length.toLocaleString('ko-KR')}곡`);
  await copyButton(page).click();
  await expect.poll(async () => (await clipboardState(page)).value).toBe(expectedExport(both));
  expect((await clipboardState(page)).calls).toEqual([expectedExport(selected), expectedExport(both)]);
  await assertRaw(page, raw);
});

test('search narrows the copied set and empty matching or unresolved-only lists never overwrite clipboard', async ({ page }) => {
  const raw = storageRaw(mixed);
  await captureClipboard(page, raw);
  await page.goto('/favorites/?q=Pretender&number=confirmed-tj'); await ready(page);
  await expect(page.locator('#song-list > .song-row')).toHaveCount(1);
  await copyButton(page).click();
  await expect.poll(async () => (await clipboardState(page)).value).toBe(expectedLine(pretender));
  await page.getByRole('searchbox').fill('no-such-favorite-export-38'); await page.getByRole('searchbox').press('Enter');
  await expect(page.locator('#result-count')).toHaveText('0곡');
  await expect(page.locator('#empty-message')).toContainText('공식 미수록을 뜻하지 않습니다');
  await copyButton(page).click(); await expect(page.locator('#status')).toHaveText('복사할 곡이 없습니다.');
  expect((await clipboardState(page)).calls).toEqual([expectedLine(pretender)]);
  expect((await clipboardState(page)).value).toBe(expectedLine(pretender));
  await expect(page.getByRole('dialog')).not.toBeVisible(); await assertRaw(page, raw);
  const unknownOnly = ` [ ${JSON.stringify({ id: unresolved, note: '그대로' })} ] `;
  await page.evaluate(value => localStorage.setItem('jpop_today_favorites', value), unknownOnly);
  await page.goto('/favorites/'); await ready(page);
  await expect(page.locator('#song-list > .song-row')).toHaveCount(0);
  await expect(page.locator('#unresolved-list')).toContainText(unresolved);
  await copyButton(page).click(); await expect(page.locator('#status')).toHaveText('복사할 곡이 없습니다.');
  expect((await clipboardState(page)).calls).toEqual([]);
  expect((await clipboardState(page)).value).toBe('이전 클립보드 원문');
  await assertRaw(page, unknownOnly);
});

test('export guidance is associated with the control, keeps the palette and explains JavaScript-off limits', async ({ page, browser, request }) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await captureClipboard(page, storageRaw(mixed));
  await page.goto('/favorites/'); await ready(page);
  await expect(copyButton(page)).toHaveAttribute('aria-describedby', 'favorites-export-scope favorites-export-status');
  await expect(page.locator('#favorites-export-scope')).toContainText('모두 복사');
  await expect(page.locator('#favorites-export-scope')).toContainText('더 보기로 펼치지 않은 곡도 포함');
  await expect(page.locator('#favorites-export-status')).toContainText('공식 확인, 관측·미확인, 확인 필요');
  await expect(page.locator('#favorites-export-status')).toContainText('미수록으로 해석하지 마세요');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const colors = await page.evaluate(() => ({ brand: getComputedStyle(document.querySelector('.site-header .brand span')!).backgroundImage,
    body: getComputedStyle(document.body).backgroundImage }));
  expect(colors.brand).toBe('linear-gradient(135deg, rgb(79, 124, 255), rgb(255, 122, 168))');
  for (const color of ['rgba(255, 122, 168, 0.18)', 'rgba(77, 199, 183, 0.16)', 'rgb(238, 245, 255)']) expect(colors.body).toContain(color);
  if (process.env.JPOP_SCREENSHOT_DIR) await page.screenshot({ path: process.env.JPOP_SCREENSHOT_DIR + '/favorites-export-mobile-guidance.png', fullPage: false });
  const context = await browser.newContext({ javaScriptEnabled: false, viewport: { width: 360, height: 800 } });
  try {
    const staticPage = await context.newPage();
    await staticPage.goto((process.env.JPOP_TEST_BASE_URL ?? 'http://127.0.0.1:4321') + '/favorites/');
    await expect(staticPage.locator('h1')).toHaveText('내 즐겨찾기');
    await expect(copyButton(staticPage)).toBeDisabled();
    // Playwright skips NOSCRIPT itself for text matching; assert its rendered
    // child in a real JavaScript-disabled context, including visibility.
    const noScriptNotice = staticPage.locator('[data-list-view="favorites"] > noscript > p');
    await expect(noScriptNotice).toHaveText('개인 저장 목록을 읽고 번호 목록을 복사하려면 JavaScript가 필요합니다.');
    await expect(noScriptNotice).toBeVisible();
    await expect(staticPage.locator('#favorites-export-status')).toContainText('관측·미확인');
    expect(await staticPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    if (process.env.JPOP_SCREENSHOT_DIR) await staticPage.screenshot({ path: process.env.JPOP_SCREENSHOT_DIR + '/favorites-export-js-off-mobile.png', fullPage: false });
  } finally { await context.close(); }
  const response = await request.get('/favorites/'), html = await response.text();
  expect(html).toContain('content="noindex, follow"');
  expect(html).not.toContain('googlesyndication'); expect(html).not.toContain('adsbygoogle');
});
