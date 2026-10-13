import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { validateCatalog } from '../contracts/catalog.mjs';

const fixture = JSON.parse(await readFile(new URL('./fixtures/catalog.json', import.meta.url), 'utf8'));
const sample = () => structuredClone(fixture);
const rejects = (catalog, path) => assert.ok(validateCatalog(catalog).some(error => error.path === path));

test('accepts a consistent catalog and preserves leading zeros', () => {
  const catalog = sample();
  assert.deepEqual(validateCatalog(catalog), []);
  assert.equal(catalog.songs[0].karaoke.tj.number, '00042');
});
test('rejects empty catalogs', () => {
  const errors = validateCatalog({ schemaVersion: 1, artists: [], songs: [] });
  assert.equal(errors.length, 2);
});
test('handles malformed input without crashing', () => {
  for (const value of [null, [], 42, 'catalog', { songs: [null], artists: [false] }])
    assert.ok(validateCatalog(value).length > 0);
});
test('rejects duplicate song IDs', () => {
  const catalog = sample();
  catalog.songs.push(structuredClone(catalog.songs[0]));
  rejects(catalog, 'songs[1].id');
});
test('rejects duplicate artist IDs', () => {
  const catalog = sample();
  catalog.artists.push(structuredClone(catalog.artists[0]));
  rejects(catalog, 'artists[1].id');
});
test('rejects missing and unknown artist references', () => {
  const catalog = sample();
  catalog.songs[0].artistIds = ['missing'];
  rejects(catalog, 'songs[0].artistIds');
  catalog.songs[0].artistIds = [];
  rejects(catalog, 'songs[0].artistIds');
});
test('rejects numeric numbers and numbers in unknown records', () => {
  const catalog = sample();
  catalog.songs[0].karaoke.tj.number = 42;
  rejects(catalog, 'songs[0].karaoke.tj.number');
  catalog.songs[0].karaoke.ky.number = '42';
  rejects(catalog, 'songs[0].karaoke.ky.number');
});
test('requires evidence for confirmed absence', () => {
  const catalog = sample();
  catalog.songs[0].karaoke.ky = { status: 'unlisted', number: null };
  rejects(catalog, 'songs[0].karaoke.ky.sourceUrl');
  rejects(catalog, 'songs[0].karaoke.ky.checkedAt');
  catalog.songs[0].karaoke.ky.sourceUrl = 'https://example.com/test-only';
  catalog.songs[0].karaoke.ky.checkedAt = '2026-10-13';
  assert.deepEqual(validateCatalog(catalog), []);
});
test('rejects rollover dates and invalid source schemes', () => {
  const catalog = sample();
  catalog.songs[0].karaoke.tj.checkedAt = '2026-02-30';
  catalog.songs[0].karaoke.tj.sourceUrl = 'javascript:alert(1)';
  rejects(catalog, 'songs[0].karaoke.tj.checkedAt');
  rejects(catalog, 'songs[0].karaoke.tj.sourceUrl');
});
test('rejects credentials embedded in source URLs', () => {
  const catalog = sample();
  catalog.songs[0].karaoke.tj.sourceUrl = 'https://user:password@example.com/test-only';
  rejects(catalog, 'songs[0].karaoke.tj.sourceUrl');
});
test('requires review of provider number collisions', () => {
  const catalog = sample();
  const second = structuredClone(catalog.songs[0]);
  second.id = 'fixture-second';
  catalog.songs.push(second);
  rejects(catalog, 'songs[1].karaoke.tj.number');
});
test('rejects missing providers and unsupported schema versions', () => {
  const catalog = sample();
  delete catalog.songs[0].karaoke.ky;
  catalog.schemaVersion = 2;
  rejects(catalog, 'songs[0].karaoke.ky');
  rejects(catalog, 'schemaVersion');
});

test('rejects all-zero placeholder numbers', () => {
  const catalog = sample();
  catalog.songs[0].karaoke.tj.number = '00000';
  rejects(catalog, 'songs[0].karaoke.tj.number');
});
