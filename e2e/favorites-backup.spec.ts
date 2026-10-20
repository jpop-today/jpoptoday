import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { guardBackupNetwork } from './helpers/backup-network.mjs';

const key = 'jpop_today_favorites';
const source = JSON.parse(readFileSync(new URL('../data/staging/legacy-catalog.json', import.meta.url), 'utf8')) as {
  songs: { id: string; titleOriginal: string; origin: string }[];
};
const idA = source.songs.find(song => song.titleOriginal === 'Pretender' && song.origin === 'playlist')!.id;
const idB = source.songs.find(song => song.titleOriginal === 'Lemon' && song.origin === 'playlist')!.id;
const absent = 'backup-unresolved-日本語-00042';
const encode = (values: unknown[]) => JSON.stringify({ format: 'jpop.today/favorites', version: 1, values });
const upload = (text: string | Buffer, name = 'synthetic-favorites.json') => ({ name, mimeType: 'application/json', buffer: Buffer.isBuffer(text) ? text : Buffer.from(text) });
type Probe = { writes: [string, string | null][]; read: () => string | null; denyRead: boolean; denyWrite: boolean };
const ready = async (page: Page) => expect(page.locator('html')).toHaveAttribute('data-app-ready', 'true');
const open = async (page: Page) => { await page.locator('#favorites-backup > summary').click(); await expect(page.locator('#favorites-backup')).toHaveAttribute('open', ''); };
const fileInput = (page: Page) => page.locator('#favorites-backup-file');
const apply = (page: Page) => page.locator('#merge-favorites-backup');
const notice = (page: Page) => page.locator('#favorites-backup-status');
const actualRaw = (page: Page) => page.evaluate(() => (window as unknown as { __backupProbe: Probe }).__backupProbe.read());
const writes = (page: Page) => page.evaluate(() => (window as unknown as { __backupProbe: Probe }).__backupProbe.writes);

async function seed(page: Page, raw: string | null, options: { denyRead?: boolean; denyWrite?: boolean } = {}) {
  await page.addInitScript(({ initial, readDenied, writeDenied }) => {
    const get = Storage.prototype.getItem, set = Storage.prototype.setItem, remove = Storage.prototype.removeItem;
    if (initial !== null && get.call(localStorage, 'jpop_today_favorites') === null) set.call(localStorage, 'jpop_today_favorites', initial);
    const probe: Probe = { writes: [], read: () => get.call(localStorage, 'jpop_today_favorites'), denyRead: readDenied, denyWrite: writeDenied };
    (window as unknown as { __backupProbe: Probe }).__backupProbe = probe;
    Storage.prototype.getItem = function (name) {
      if (this === localStorage && name === 'jpop_today_favorites' && probe.denyRead) throw new DOMException('Synthetic read denial', 'SecurityError');
      return get.call(this, name);
    };
    Storage.prototype.setItem = function (name, value) {
      if (this === localStorage && name === 'jpop_today_favorites') {
        probe.writes.push(['set', value]);
        if (probe.denyWrite) throw new DOMException('Synthetic write denial', 'QuotaExceededError');
      }
      set.call(this, name, value);
    };
    Storage.prototype.removeItem = function (name) {
      if (this === localStorage && name === 'jpop_today_favorites') probe.writes.push(['remove', null]);
      remove.call(this, name);
    };
  }, { initial: raw, readDenied: options.denyRead ?? false, writeDenied: options.denyWrite ?? false });
}

test('download includes every stored object and unresolved ID despite an empty active filter, and does not mutate storage or upload the file', async ({ page }) => {
  const values = [{ id: idA, note: '합성 보관 메모', extra: { number: '00042', data: [false, null] } }, absent, idB, idA];
  const raw = ' ' + JSON.stringify(values) + ' ', errors: string[] = [], uploads: string[] = [];
  page.on('pageerror', error => errors.push(error.name));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.type()); });
  await guardBackupNetwork(page, uploads, [idA, idB, absent, '합성 보관 메모']);
  await seed(page, raw); await page.goto('/favorites/?q=definitely-no-matching-favorites-backup'); await ready(page); await open(page);
  await expect(page).toHaveTitle('내 즐겨찾기 | jpop.today'); await expect(page.locator('h1')).toHaveText('내 즐겨찾기');
  await expect(page.locator('#song-list > .song-row')).toHaveCount(0);
  const downloading = page.waitForEvent('download'); await page.locator('#download-favorites-backup').click();
  const downloaded = await downloading;
  expect(downloaded.suggestedFilename()).toBe('jpoptoday-favorites-v1.json');
  const path = await downloaded.path(); expect(path).not.toBeNull();
  expect(JSON.parse(readFileSync(path!, 'utf8'))).toEqual({ format: 'jpop.today/favorites', version: 1, values });
  expect(await actualRaw(page)).toBe(raw); expect(await writes(page)).toEqual([]);
  expect(errors).toEqual([]); expect(uploads).toEqual([]);
  await expect(notice(page)).toContainText('다운로드 폴더');
});

test('a downloaded file is inspected without writes and explicit keyboard confirmation adds new IDs while preserving existing metadata and duplicates', async ({ page }) => {
  const originalValues = [{ id: idA, note: '기존 객체 그대로' }, absent, idA];
  const raw = ' ' + JSON.stringify(originalValues) + ' ';
  await seed(page, raw); await page.goto('/favorites/'); await ready(page); await open(page);
  const downloading = page.waitForEvent('download'); await page.locator('#download-favorites-backup').click();
  const path = await (await downloading).path();
  const downloaded = JSON.parse(readFileSync(path!, 'utf8'));
  downloaded.values.push({ id: idB, note: '첫 새 객체', extra: { number: '00123' } }, idB, 'backup-new-unknown');
  await fileInput(page).setInputFiles(upload(JSON.stringify(downloaded)));
  await expect(page.locator('#favorites-backup-preview')).toBeVisible(); await expect(apply(page)).toBeEnabled();
  await expect(page.locator('#favorites-backup-counts')).toContainText('파일 항목 6개');
  await expect(page.locator('#favorites-backup-counts')).toContainText('찾은 ID 4개');
  await expect(page.locator('#favorites-backup-counts')).toContainText('다시 확인할 ID 2개');
  await expect(notice(page)).toContainText('아직 저장 목록은 바꾸지 않았습니다');
  expect(await actualRaw(page)).toBe(raw); expect(await writes(page)).toEqual([]);
  await apply(page).focus(); await page.keyboard.press('Enter');
  await expect(notice(page)).toContainText('새 ID 2개');
  const expected = [...originalValues, { id: idB, note: '첫 새 객체', extra: { number: '00123' } }, 'backup-new-unknown'];
  expect(JSON.parse((await actualRaw(page))!)).toEqual(expected); expect((await writes(page)).length).toBe(1);
  await expect(page.locator('#unresolved-list')).toContainText(absent);
  await expect(page.locator('#unresolved-list')).toContainText('backup-new-unknown');
  await expect(apply(page)).toBeDisabled(); await expect(page.locator('#favorites-backup-preview')).toBeHidden();
});

test('cancel and invalid JSON, shape, version, ID, UTF-8 or oversized files do not write or leave an older valid import armed', async ({ page }) => {
  const raw = ` [ ${JSON.stringify(idA)}, ${JSON.stringify(absent)} ] `;
  await seed(page, raw); await page.goto('/favorites/'); await ready(page); await open(page);
  await fileInput(page).setInputFiles(upload(encode([idB]))); await expect(apply(page)).toBeEnabled();
  await page.locator('#cancel-favorites-backup').click(); await expect(apply(page)).toBeDisabled();
  await expect(notice(page)).toContainText('취소');
  const bad = [upload('{private-synthetic-json'), upload('[]'), upload(JSON.stringify({ format: 'jpop.today/favorites', version: 2, values: [idB] })),
    upload(encode([idB, null])), upload(encode([{ id: 42, note: 'synthetic-private-note' }])), upload(Buffer.from([0x7b, 0xff, 0x7d])),
    upload(' '.repeat(256 * 1024 + 1), 'oversized.json')];
  for (const file of bad) {
    await fileInput(page).setInputFiles(upload(encode([idB]))); await expect(apply(page)).toBeEnabled();
    await fileInput(page).setInputFiles(file); await expect(apply(page)).toBeDisabled();
    await expect(page.locator('#favorites-backup-preview')).toBeHidden();
    await expect(notice(page)).toContainText('저장 목록은 바꾸지 않았습니다');
    await expect(notice(page)).not.toContainText('synthetic-private');
    expect(await actualRaw(page)).toBe(raw); expect(await writes(page)).toEqual([]);
  }
});

test('another actual tab changing storage invalidates the pending confirmation and preserves the newer bytes', async ({ page, context }) => {
  const raw = JSON.stringify([idA, absent]); await seed(page, raw); await page.goto('/favorites/'); await ready(page); await open(page);
  await fileInput(page).setInputFiles(upload(encode([idB, 'pending-import']))); await expect(apply(page)).toBeEnabled();
  const other = await context.newPage(); await other.goto('/favorites/'); await ready(other);
  const newer = ` [ ${JSON.stringify(idA)}, "other-tab-new-value" ] `;
  await other.evaluate(({ storageKey, value }) => localStorage.setItem(storageKey, value), { storageKey: key, value: newer });
  await expect(apply(page)).toBeDisabled(); await expect(notice(page)).toContainText('다른 탭');
  expect(await actualRaw(page)).toBe(newer); expect(await writes(page)).toEqual([]);
  await expect(page.locator('#unresolved-list')).toContainText('other-tab-new-value'); await other.close();
});

test('same-tab save/remove invalidates confirmation rather than applying a previously inspected file', async ({ page }) => {
  const raw = JSON.stringify([idA, absent]); await seed(page, raw); await page.goto('/favorites/'); await ready(page); await open(page);
  await fileInput(page).setInputFiles(upload(encode([idB]))); await expect(apply(page)).toBeEnabled();
  await page.locator('#unresolved-list [data-remove]').click();
  await expect(apply(page)).toBeDisabled(); await expect(notice(page)).toContainText('저장 목록이 바뀌어');
  expect(JSON.parse((await actualRaw(page))!)).toEqual([idA]); expect((await writes(page)).length).toBe(1);
});

test('write denial keeps original bytes, clearly marks the temporary merge and permits a rescue download with all session IDs', async ({ page }) => {
  const values = [{ id: idA, note: 'keep original metadata' }, absent], raw = JSON.stringify(values);
  await seed(page, raw, { denyWrite: true }); await page.goto('/favorites/'); await ready(page); await open(page);
  await fileInput(page).setInputFiles(upload(encode([idB, 'temporary-unresolved']))); await expect(apply(page)).toBeEnabled(); await apply(page).click();
  await expect(notice(page)).toContainText('영구 저장하지 못해'); await expect(page.locator('#storage-note')).toBeVisible();
  expect(await actualRaw(page)).toBe(raw); expect((await writes(page)).length).toBe(1);
  await expect(page.locator('#unresolved-list')).toContainText('temporary-unresolved');
  const downloading = page.waitForEvent('download'); await page.locator('#download-favorites-backup').click();
  const path = await (await downloading).path();
  expect(JSON.parse(readFileSync(path!, 'utf8')).values).toEqual([...values, idB, 'temporary-unresolved']);
  expect(await actualRaw(page)).toBe(raw);
});

test('a permission lost after inspection does not lose previously readable favorites from the temporary merge', async ({ page }) => {
  const values = [{ id: idA, note: 'last readable state' }, absent], raw = JSON.stringify(values);
  await seed(page, raw); await page.goto('/favorites/'); await ready(page); await open(page);
  await fileInput(page).setInputFiles(upload(encode([idB]))); await expect(apply(page)).toBeEnabled();
  await page.evaluate(() => { (window as unknown as { __backupProbe: Probe }).__backupProbe.denyRead = true; });
  await apply(page).click(); await expect(notice(page)).toContainText('영구 저장하지 못해');
  expect(await actualRaw(page)).toBe(raw); expect(await writes(page)).toEqual([]);
  const downloading = page.waitForEvent('download'); await page.locator('#download-favorites-backup').click();
  const path = await (await downloading).path(); expect(JSON.parse(readFileSync(path!, 'utf8')).values).toEqual([...values, idB]);
});

for (const [name, raw, denyRead] of [
  ['malformed JSON', '{broken-favorite-json', false], ['wrong shape', '{"id":"wrong-root"}', false],
  ['invalid entry', '["valid-unknown",null]', false], ['inaccessible existing list', JSON.stringify([idA, absent]), true],
] as const) {
  test(`initial ${name} cannot silently download an apparently valid empty backup`, async ({ page }) => {
    await seed(page, raw, { denyRead }); await page.goto('/favorites/'); await ready(page); await open(page);
    let downloads = 0; const count = () => { downloads++; }; page.on('download', count);
    await page.locator('#download-favorites-backup').click(); await expect(notice(page)).toContainText(/보관하지 (?:못|않)/u);
    expect(downloads).toBe(0); expect(await actualRaw(page)).toBe(raw); expect(await writes(page)).toEqual([]); page.off('download', count);
  });
}

test('an explicit import into damaged storage remains temporary and its rescue file discloses that unreadable original data is absent', async ({ page }) => {
  const raw = '{broken-original-favorite-json', incoming = [idB, 'session-only-new-unknown'];
  await seed(page, raw); await page.goto('/favorites/'); await ready(page); await open(page);
  await fileInput(page).setInputFiles(upload(encode(incoming))); await expect(apply(page)).toBeEnabled(); await apply(page).click();
  await expect(notice(page)).toContainText('영구 저장하지 못해'); expect(await actualRaw(page)).toBe(raw); expect(await writes(page)).toEqual([]);
  const downloading = page.waitForEvent('download'); await page.locator('#download-favorites-backup').click();
  const path = await (await downloading).path(); expect(JSON.parse(readFileSync(path!, 'utf8')).values).toEqual(incoming);
  await expect(notice(page)).toContainText('원본 데이터는 포함하지 않습니다'); expect(await actualRaw(page)).toBe(raw);
});

test('sessionStorage clear events cannot discard a valid temporary favorites merge', async ({ page }) => {
  const raw = JSON.stringify([idA, absent]); await seed(page, raw, { denyWrite: true });
  await page.goto('/favorites/'); await ready(page); await open(page);
  await fileInput(page).setInputFiles(upload(encode([idB]))); await expect(apply(page)).toBeEnabled(); await apply(page).click();
  await expect(notice(page)).toContainText('영구 저장하지 못해');
  await page.evaluate(() => window.dispatchEvent(new StorageEvent('storage', { key: null, storageArea: sessionStorage })));
  const downloading = page.waitForEvent('download'); await page.locator('#download-favorites-backup').click();
  const path = await (await downloading).path(); expect(JSON.parse(readFileSync(path!, 'utf8')).values).toEqual([idA, absent, idB]);
  expect(await actualRaw(page)).toBe(raw); expect((await writes(page)).length).toBe(1);
});

test('slow file reads cannot replace a newer selection or revive a cancelled import', async ({ page }) => {
  const raw = JSON.stringify([idA]); await seed(page, raw);
  await page.addInitScript(() => {
    const original = File.prototype.arrayBuffer;
    (window as unknown as { __releaseSlowBackup?: () => void }).__releaseSlowBackup = undefined;
    File.prototype.arrayBuffer = function () {
      if (this.name !== 'slow.json') return original.call(this);
      return new Promise<ArrayBuffer>(resolve => { (window as unknown as { __releaseSlowBackup?: () => void }).__releaseSlowBackup = () => { void original.call(this).then(resolve); }; });
    };
  });
  await page.goto('/favorites/'); await ready(page); await open(page);
  await fileInput(page).setInputFiles(upload(encode([idB, 'slow-unknown']), 'slow.json'));
  await expect(notice(page)).toContainText('확인하고 있습니다');
  await fileInput(page).setInputFiles(upload(encode(['latest-unknown']))); await expect(apply(page)).toBeEnabled();
  await page.evaluate(() => (window as unknown as { __releaseSlowBackup?: () => void }).__releaseSlowBackup?.());
  await expect(page.locator('#favorites-backup-counts')).toContainText('파일 항목 1개');
  await apply(page).click(); expect(JSON.parse((await actualRaw(page))!)).toEqual([idA, 'latest-unknown']);
  await fileInput(page).setInputFiles(upload(encode([idB]), 'slow.json')); await expect(page.locator('#cancel-favorites-backup')).toBeEnabled();
  await page.locator('#cancel-favorites-backup').click();
  await page.evaluate(() => (window as unknown as { __releaseSlowBackup?: () => void }).__releaseSlowBackup?.());
  await expect(apply(page)).toBeDisabled(); await expect(page.locator('#favorites-backup-preview')).toBeHidden();
  expect(JSON.parse((await actualRaw(page))!)).toEqual([idA, 'latest-unknown']);
});

test('mobile keyboard controls remain usable, unknown input is inert text and preview keeps noindex/no ads', async ({ page, request }) => {
  const raw = JSON.stringify([idA]); await page.setViewportSize({ width: 360, height: 800 }); await seed(page, raw);
  await page.goto('/favorites/'); await ready(page);
  const summary = page.locator('#favorites-backup > summary'); await summary.focus(); await page.keyboard.press('Enter');
  await expect(page.locator('#favorites-backup')).toHaveAttribute('open', '');
  expect((await summary.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  expect((await page.locator('#download-favorites-backup').boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await expect(fileInput(page)).toHaveAccessibleName('보관 파일 선택 (JSON, 최대 256KiB)');
  const injected = '<img src=x onerror="window.__backupInjectionExecuted=true">';
  await fileInput(page).setInputFiles(upload(encode([injected]))); await expect(apply(page)).toBeEnabled(); await apply(page).click();
  await expect(page.locator('#unresolved-list')).toContainText(injected); expect(await page.locator('#unresolved-list img').count()).toBe(0);
  expect(await page.evaluate(() => (window as unknown as { __backupInjectionExecuted?: boolean }).__backupInjectionExecuted)).toBeUndefined();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const colors = await page.evaluate(() => ({ brand: getComputedStyle(document.querySelector('.site-header .brand span')!).backgroundImage, body: getComputedStyle(document.body).backgroundImage }));
  expect(colors.brand).toBe('linear-gradient(135deg, rgb(79, 124, 255), rgb(255, 122, 168))');
  for (const color of ['rgba(255, 122, 168, 0.18)', 'rgba(77, 199, 183, 0.16)', 'rgb(238, 245, 255)']) expect(colors.body).toContain(color);
  if (process.env.JPOP_SCREENSHOT_DIR) await page.screenshot({ path: process.env.JPOP_SCREENSHOT_DIR + '/favorites-backup-mobile-import.png', fullPage: false });
  const response = await request.get('/favorites/'), html = await response.text();
  expect(html).toContain('content="noindex, follow"'); expect(html).not.toMatch(/adsbygoogle|googlesyndication/);
});

test('JavaScript-off displays the real limits and disables all backup mutations', async ({ browser }) => {
  const context = await browser.newContext({ javaScriptEnabled: false, viewport: { width: 360, height: 800 } });
  try {
    const page = await context.newPage(); await page.goto((process.env.JPOP_TEST_BASE_URL ?? 'http://127.0.0.1:4321') + '/favorites/');
    await expect(page).toHaveTitle('내 즐겨찾기 | jpop.today'); await open(page);
    for (const selector of ['#download-favorites-backup', '#favorites-backup-file', '#merge-favorites-backup', '#cancel-favorites-backup']) await expect(page.locator(selector)).toBeDisabled();
    const note = page.locator('[data-list-view="favorites"] > noscript > p');
    await expect(note).toBeVisible(); await expect(note).toContainText('JavaScript가 필요합니다');
    await expect(note).toContainText('파일을 선택해도 자동으로 저장하지 않습니다');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    if (process.env.JPOP_SCREENSHOT_DIR) await page.screenshot({ path: process.env.JPOP_SCREENSHOT_DIR + '/favorites-backup-js-off-mobile.png', fullPage: false });
  } finally { await context.close(); }
});
