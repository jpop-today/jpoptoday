import { test, expect, type Page } from '@playwright/test';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { guardBackupNetwork } from './helpers/backup-network.mjs';

// Synthetic storage failures; these are neither real user records nor provider
// evidence. Expected arrays/bytes are independent of the backup implementation.
const key = 'jpop_today_favorites';
const staged = JSON.parse(readFileSync(new URL('../data/staging/legacy-catalog.json', import.meta.url), 'utf8')) as {
  songs: { id: string; titleOriginal: string; origin: string }[];
};
const knownA = staged.songs.find(song => song.titleOriginal === 'Pretender' && song.origin === 'playlist')!.id;
const knownB = staged.songs.find(song => song.titleOriginal === 'Lemon' && song.origin === 'playlist')!.id;
const originalValues = [{ id: knownA, note: 'synthetic-existing', legacy: { number: '00042', nested: [false, null] } },
  'recovery-original-unknown-日本語', knownA];
const incoming = [{ id: knownB, note: 'synthetic-import', legacy: { number: '00001' } }, 'recovery-import-unknown'];
const originalRaw = ' [ ' + originalValues.map(value => JSON.stringify(value)).join(', ') + ' ] ';
const externalRaw = ' [ { "id": ' + JSON.stringify(knownA) + ', "note": "synthetic-other-writer" }, "recovery-other-writer-unknown" ] ';
type Fault = 'rollback-set-denied' | 'concurrent-after-candidate' | 'rollback-remove-denied' | 'rollback-set-raced' | 'rollback-succeeds';
type RecoveryProbe = { read: () => string | null; calls: { op: string; value: string | null }[] };

async function seedFailure(page: Page, raw: string | null, fault: Fault, denySession = false) {
  await page.addInitScript(({ initial, mode, otherRaw, blockSession }) => {
    const get = Storage.prototype.getItem, set = Storage.prototype.setItem, remove = Storage.prototype.removeItem;
    if (initial === null) remove.call(localStorage, 'jpop_today_favorites');
    else set.call(localStorage, 'jpop_today_favorites', initial);
    const probe: RecoveryProbe = { read: () => get.call(localStorage, 'jpop_today_favorites'), calls: [] };
    (window as unknown as { __recoveryProbe: RecoveryProbe }).__recoveryProbe = probe;
    let favoriteWrites = 0;
    Storage.prototype.setItem = function (name, value) {
      if (blockSession && this === sessionStorage) throw new DOMException('Synthetic session refusal', 'QuotaExceededError');
      if (this !== localStorage || name !== 'jpop_today_favorites') { set.call(this, name, value); return; }
      probe.calls.push({ op: 'set', value }); favoriteWrites++;
      if (favoriteWrites === 1) {
        set.call(this, name, value);
        if (mode === 'concurrent-after-candidate') set.call(this, name, otherRaw);
        throw new DOMException('Synthetic post-write failure', 'QuotaExceededError');
      }
      if (mode === 'rollback-set-denied') throw new DOMException('Synthetic rollback refusal', 'QuotaExceededError');
      set.call(this, name, value);
      if (mode === 'rollback-set-raced') set.call(this, name, otherRaw);
    };
    Storage.prototype.removeItem = function (name) {
      if (this === localStorage && name === 'jpop_today_favorites') {
        probe.calls.push({ op: 'remove', value: null });
        if (mode === 'rollback-remove-denied') throw new DOMException('Synthetic rollback removal refusal', 'SecurityError');
      }
      remove.call(this, name);
    };
  }, { initial: raw, mode: fault, otherRaw: externalRaw, blockSession: denySession });
}

const actual = (page: Page) => page.evaluate(() => {
  const probe = (window as unknown as { __recoveryProbe: RecoveryProbe }).__recoveryProbe;
  return { raw: probe.read(), calls: probe.calls };
});

async function previewAndConfirm(page: Page) {
  await page.goto('/favorites/');
  await expect(page).toHaveTitle('내 즐겨찾기 | jpop.today');
  await expect(page.locator('h1')).toHaveText('내 즐겨찾기');
  await expect(page.locator('astro-error-overlay')).toHaveCount(0);
  await expect(page.locator('html')).toHaveAttribute('data-app-ready', 'true');
  await page.locator('#favorites-backup > summary').click();
  const before = await actual(page);
  await page.locator('#favorites-backup-file').setInputFiles({ name: 'synthetic-recovery.json', mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify({ format: 'jpop.today/favorites', version: 1, values: incoming })) });
  await expect(page.locator('#favorites-backup-preview')).toBeVisible();
  await expect(page.locator('#merge-favorites-backup')).toBeEnabled();
  expect(await actual(page)).toEqual(before);
  await page.locator('#merge-favorites-backup').click();
  await expect(page.locator('#merge-favorites-backup')).toBeDisabled();
}

async function downloadSession(page: Page, expectedValues: unknown[]) {
  const before = await actual(page);
  const downloading = page.waitForEvent('download');
  await page.locator('#download-favorites-backup').click();
  const download = await downloading;
  expect(download.suggestedFilename()).toBe('jpoptoday-favorites-v1.json');
  const path = await download.path(); expect(path).not.toBeNull();
  expect(JSON.parse(readFileSync(path!, 'utf8'))).toEqual({ format: 'jpop.today/favorites', version: 1, values: expectedValues });
  await expect(page.locator('#favorites-backup-status')).toContainText('임시 목록');
  await expect(page.locator('#favorites-backup-status')).toContainText('원본 데이터는 포함하지 않습니다');
  expect(await actual(page)).toEqual(before);
}

const cases: { name: string; fault: Fault; absent?: boolean; denySession?: boolean; expectedWrites: number; expectedRemoves: number }[] = [
  { name: 'failed rollback write', fault: 'rollback-set-denied', expectedWrites: 2, expectedRemoves: 0 },
  { name: 'writer replaces the candidate before rollback', fault: 'concurrent-after-candidate', expectedWrites: 1, expectedRemoves: 0 },
  { name: 'absent original key cannot be removed after a partial write', fault: 'rollback-remove-denied', absent: true, expectedWrites: 1, expectedRemoves: 1 },
  { name: 'writer replaces the original during rollback read-back', fault: 'rollback-set-raced', expectedWrites: 2, expectedRemoves: 0 },
  { name: 'failed rollback and blocked session persistence', fault: 'rollback-set-denied', denySession: true, expectedWrites: 2, expectedRemoves: 0 },
];

for (const scenario of cases) test(`recovery warning and file rescue: ${scenario.name}`, async ({ page }) => {
  const errors: string[] = [], uploads: string[] = [];
  page.on('pageerror', error => errors.push(error.name));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.type()); });
  await guardBackupNetwork(page, uploads, [knownA, knownB, 'recovery-original-unknown-', 'recovery-import-unknown', 'synthetic-existing', 'synthetic-import']);
  const starting = scenario.absent ? null : originalRaw;
  const expectedValues = [...(scenario.absent ? [] : originalValues), ...incoming];
  await seedFailure(page, starting, scenario.fault, scenario.denySession);
  await previewAndConfirm(page);
  const note = page.locator('#storage-note'), status = page.locator('#favorites-backup-status');
  await expect(note).toBeVisible();
  // Keeping original entries in the displayed/session list is distinct from
  // proving that the persistent original bytes were restored.
  await expect(page.locator('#unresolved-favorites > p')).toHaveText('현재 곡 자료에서 찾지 못한 항목입니다. 원래 항목을 아래 목록에 유지합니다.');
  await expect(page.locator('#unresolved-favorites > p')).not.toContainText('저장값을 보존했습니다');
  for (const message of [note, status]) {
    await expect(message).toContainText('원본 복구를 확인하지 못했습니다');
    await expect(message).toContainText('파일로 보관');
    await expect(message).not.toContainText('보존했습니다');
    await expect(message).not.toContainText('새 ID');
  }
  const after = await actual(page);
  const raced = ['concurrent-after-candidate', 'rollback-set-raced'].includes(scenario.fault);
  if (raced) expect(after.raw).toBe(externalRaw);
  else expect(JSON.parse(after.raw!)).toEqual(expectedValues);
  expect(after.calls.filter(call => call.op === 'set')).toHaveLength(scenario.expectedWrites);
  expect(after.calls.filter(call => call.op === 'remove')).toHaveLength(scenario.expectedRemoves);
  if (!scenario.absent) await expect(page.locator('#unresolved-list')).toContainText('recovery-original-unknown-日本語');
  await expect(page.locator('#unresolved-list')).toContainText('recovery-import-unknown');
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', 'noindex, follow');
  if (process.env.JPOP_RECOVERY_SCREENSHOT_DIR && scenario.fault === 'concurrent-after-candidate') {
    mkdirSync(process.env.JPOP_RECOVERY_SCREENSHOT_DIR, { recursive: true });
    await note.scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(process.env.JPOP_RECOVERY_SCREENSHOT_DIR, 'favorites-backup-concurrent-recovery-warning.png'), fullPage: false });
  }
  await downloadSession(page, expectedValues);
  expect(errors).toEqual([]); expect(uploads).toEqual([]);
});

test('successful rollback control retains the exact original bytes and makes a truthful session-only rescue file', async ({ page }) => {
  const errors: string[] = [], uploads: string[] = [];
  page.on('pageerror', error => errors.push(error.name));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.type()); });
  await guardBackupNetwork(page, uploads, [knownA, knownB, 'recovery-original-unknown-', 'recovery-import-unknown', 'synthetic-existing', 'synthetic-import']);
  await seedFailure(page, originalRaw, 'rollback-succeeds');
  await previewAndConfirm(page);
  await expect(page.locator('#storage-note')).toContainText('기존 저장값은 보존했습니다');
  await expect(page.locator('#favorites-backup-status')).toContainText('영구 저장하지 못해');
  await expect(page.locator('#favorites-backup-status')).toContainText('기존 저장값은 보존했습니다');
  await expect(page.locator('#storage-note')).not.toContainText('복구를 확인하지 못했습니다');
  await expect(page.locator('#unresolved-favorites > p')).toHaveText('현재 곡 자료에서 찾지 못한 항목입니다. 원래 항목을 아래 목록에 유지합니다.');
  expect((await actual(page)).raw).toBe(originalRaw);
  await downloadSession(page, [...originalValues, ...incoming]);
  expect((await actual(page)).raw).toBe(originalRaw);
  expect(errors).toEqual([]); expect(uploads).toEqual([]);
});
