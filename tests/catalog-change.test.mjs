import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateCatalogChange } from '../contracts/catalog-change.mjs';
import { promoteCatalog } from '../contracts/catalog-snapshot.mjs';

const fixture = JSON.parse(await readFile(new URL('./fixtures/catalog.json', import.meta.url)));
const sample = () => structuredClone(fixture);
function withSecondSong() {
  const catalog = sample();
  const second = structuredClone(catalog.songs[0]);
  second.id = 'fixture-second-song';
  second.karaoke.tj.number = '00043';
  catalog.songs.push(second);
  return catalog;
}

test('nonempty partial collection is rejected even when its v1 structure is valid', () => {
  const errors = validateCatalogChange(withSecondSong(), sample());
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /Existing song ID/);
});

test('title and number corrections preserve the stable ID and can be promoted', () => {
  const candidate = sample();
  candidate.songs[0].titleOriginal = 'Corrected synthetic title';
  candidate.songs[0].karaoke.tj.number = '00044';
  assert.deepEqual(validateCatalogChange(sample(), candidate), []);
});

test('complete updates can add records without deleting old records', () => {
  assert.deepEqual(validateCatalogChange(sample(), withSecondSong()), []);
});

test('collection failure cannot turn a confirmed number into unknown', () => {
  const candidate = sample();
  candidate.songs[0].karaoke.tj = { status: 'unknown', number: null };
  assert.ok(validateCatalogChange(sample(), candidate).some(error => /Confirmed provider/.test(error.message)));
});

test('collection failure cannot erase confirmed absence either', () => {
  const previous = sample();
  previous.songs[0].karaoke.ky = { status: 'unlisted', sourceUrl: 'https://example.com/synthetic-proof', checkedAt: '2026-10-13' };
  assert.ok(validateCatalogChange(previous, sample()).some(error => error.path.endsWith('.karaoke.ky')));
});

test('invalid previous or candidate catalogs cannot pass the change gate', () => {
  for (const [previous, candidate] of [[null, sample()], [sample(), { schemaVersion: 1, artists: [], songs: [] }]])
    assert.ok(validateCatalogChange(previous, candidate).length);
});

test('partial candidate leaves the previous snapshot bytes and directory unchanged', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'jpoptoday-change-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const input = join(directory, 'candidate.json');
  const output = join(directory, 'snapshot.json');
  const previous = Buffer.from(JSON.stringify(withSecondSong(), null, 2));
  await writeFile(input, JSON.stringify(sample()));
  await writeFile(output, previous);
  await assert.rejects(promoteCatalog(input, output), { code: 'INVALID_CATALOG_CHANGE' });
  assert.deepEqual(await readFile(output), previous);
  assert.deepEqual((await readdir(directory)).sort(), ['candidate.json', 'snapshot.json']);
});

test('damaged existing snapshot is retained until explicit recovery', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'jpoptoday-change-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const input = join(directory, 'candidate.json');
  const output = join(directory, 'snapshot.json');
  await writeFile(input, JSON.stringify(sample()));
  await writeFile(output, 'original damaged snapshot');
  await assert.rejects(promoteCatalog(input, output), { code: 'INVALID_EXISTING_SNAPSHOT' });
  assert.equal(await readFile(output, 'utf8'), 'original damaged snapshot');
});
