import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildChartSnapshot, importChartSnapshot, validateChartSnapshot } from '../scripts/import-chart-snapshot.mjs';

// Entirely synthetic identity fixtures. Validation of the actual 100-song
// input is a separate importer execution recorded in docs/data/chart-snapshot.md.
const oldSha = 'a'.repeat(40), newSha = 'b'.repeat(40), chartHash = 'c'.repeat(64);
const clone = value => structuredClone(value);
function fixture() {
  const songs = Array.from({ length: 100 }, (_, index) => ({ id: 'alias-' + index,
    title: 'Synthetic title ' + index, artist: 'Synthetic artist ' + index,
    tjNumber: String(index + 1).padStart(5, '0'), rank: index + 1 }));
  const previous = { source: 'TJ Media TOP100 JPOP', sourceUrl: 'https://www.tjmedia.com/chart/top100',
    fetchedAt: '2026-10-12T10:00:00.000Z', startDate: '2026-09-28', endDate: '2026-10-12',
    periodVerified: true, legacyRevision: oldSha, songs };
  const raw = { ...clone(previous), fetchedAt: '2026-10-13T10:00:00.000Z', startDate: '2026-09-29', endDate: '2026-10-13',
    apiUrl: 'https://www.tjmedia.com/legacy/api/topAndHot100',
    requestPayload: { chartType: 'TOP', strType: '3', startDate: '2026-09-29', endDate: '2026-10-13' },
    unexpected: 'SYNTHETIC PRIVATE VALUE' };
  raw.songs[0] = { ...raw.songs[0], lyrics: 'SYNTHETIC PRIVATE LYRICS', albumImage: 'https://example.invalid/private-image', checkedAt: 'invented' };
  const repository = 'https://github.com/example/synthetic-chart';
  const chartSource = { path: 'js/chart.js', revision: oldSha, sha256: chartHash, rows: 100 };
  const staging = { stagingVersion: 1, purpose: 'legacy-catalog-staging', repository, revision: oldSha,
    sources: [{ path: 'data/raw.json', revision: oldSha }, { path: 'js/songs.js', revision: oldSha }, chartSource],
    songs: songs.map((row, index) => ({ id: 'canonical-' + index, availability: 'current',
      titleOriginal: row.title, artistOriginal: row.artist,
      karaoke: { tj: { observedNumber: row.tjNumber } }, refs: [{ source: 2, index }] })) };
  const baseline = { baselineVersion: 1, repository, sources: [clone(chartSource)],
    identities: songs.map((row, index) => ({ id: 'canonical-' + index, observations: [{
      title: row.title, artist: row.artist, tjNumber: row.tjNumber, refs: [{ source: 0, index }],
    }] })) };
  return { raw, previous, staging, baseline, sourceSha: newSha, now: new Date('2026-10-15T00:00:00Z') };
}
const build = input => buildChartSnapshot(input);
async function setup(t, edit = () => {}) {
  const directory = await fs.mkdtemp(join(tmpdir(), 'jpoptoday-chart-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const data = fixture(); edit(data);
  const input = join(directory, 'raw.json'), snapshot = join(directory, 'snapshot.json'), staging = join(directory, 'staging.json');
  await fs.writeFile(input, JSON.stringify(data.raw));
  await fs.writeFile(snapshot, JSON.stringify(data.previous, null, 4) + '\n');
  await fs.writeFile(staging, JSON.stringify(data.staging));
  const before = { input: await fs.readFile(input), snapshot: await fs.readFile(snapshot), staging: await fs.readFile(staging) };
  return { directory, data, input, snapshot, staging, before };
}
const promote = (context, io) => importChartSnapshot(context.input, context.snapshot, context.staging, newSha,
  { baseline: context.data.baseline, now: context.data.now, ...(io ? { io } : {}) });
async function assertPreserved(context) {
  for (const key of ['input', 'snapshot', 'staging']) assert.deepEqual(await fs.readFile(context[key]), context.before[key], key);
  assert.deepEqual((await fs.readdir(context.directory)).sort(), ['raw.json', 'snapshot.json', 'staging.json']);
}

test('one-time migration verifies the exact original observation and projects only public fields', () => {
  const data = fixture();
  // The chart observation can carry a title qualifier absent from a playlist
  // title; the actual chart observation, rather than a loose title, is decisive.
  data.staging.songs[0].titleOriginal = 'Synthetic playlist title';
  const result = build(data);
  assert.deepEqual(Object.keys(result), ['source', 'sourceUrl', 'fetchedAt', 'startDate', 'endDate', 'periodVerified', 'legacyRevision', 'songs']);
  assert.deepEqual(Object.keys(result.songs[0]), ['id', 'title', 'artist', 'tjNumber', 'rank', 'canonicalId']);
  assert.equal(result.songs[0].canonicalId, 'canonical-0');
  assert.equal(result.songs[0].tjNumber, '00001');
  assert.equal(result.fetchedAt, data.raw.fetchedAt);
  assert.equal(result.legacyRevision, newSha);
  for (const forbidden of ['PRIVATE', 'lyrics', 'albumImage', 'checkedAt', 'requestPayload', 'apiUrl'])
    assert.equal(JSON.stringify(result).includes(forbidden), false, forbidden);
  assert.equal(validateChartSnapshot(result, data.staging, data.baseline), result);
});

test('two successive rank changes join aliases and preserved canonical IDs without index dependence', () => {
  const data = fixture();
  data.raw.songs.reverse().forEach((row, index) => { row.rank = index + 1; });
  const first = build(data);
  assert.equal(first.songs[0].id, 'alias-99');
  assert.equal(first.songs[0].canonicalId, 'canonical-99');
  const next = clone(data.raw);
  next.fetchedAt = '2026-10-14T10:00:00.000Z';
  next.songs = [...next.songs.slice(20), ...next.songs.slice(0, 20)];
  next.songs.forEach((row, index) => { row.rank = index + 1; });
  data.staging.songs.reverse();
  const second = build({ ...data, previous: first, raw: next });
  for (const row of second.songs) assert.equal(row.canonicalId, row.id.replace('alias-', 'canonical-'));
});

test('a first migration refuses reordered aliases before canonical IDs were seeded', () => {
  const data = fixture();
  [data.previous.songs[0], data.previous.songs[1]] = [data.previous.songs[1], data.previous.songs[0]];
  data.previous.songs.forEach((row, index) => { row.rank = index + 1; });
  assert.throws(() => build(data), { code: 'INVALID_CANONICAL_ID' });
});

test('false periodVerified is preserved for a request with no date parameters', () => {
  const data = fixture(); data.raw.periodVerified = false;
  data.raw.requestPayload = { chartType: 'TOP', strType: '3' };
  assert.equal(build(data).periodVerified, false);
  for (const [start, end] of [['searchStartDate', 'searchEndDate'], ['startDt', 'endDt']]) {
    data.raw.periodVerified = true;
    data.raw.requestPayload = { chartType: 'TOP', strType: '3', [start]: data.raw.startDate, [end]: data.raw.endDate };
    assert.equal(build(data).periodVerified, true);
  }
});

test('fetch timestamps use an explicit validation clock and cannot establish future collection', () => {
  const data = fixture(), fetched = new Date(data.raw.fetchedAt);
  assert.equal(build({ ...data, now: fetched }).fetchedAt, data.raw.fetchedAt);
  assert.throws(() => build({ ...data, now: new Date(fetched.getTime() - 1) }), { code: 'INVALID_METADATA' });
  assert.throws(() => build({ ...data, now: new Date('invalid') }), { code: 'INVALID_METADATA' });
  const snapshot = build(data);
  assert.throws(() => validateChartSnapshot(snapshot, data.staging, data.baseline,
    { now: new Date(fetched.getTime() - 1) }), { code: 'INVALID_METADATA' });
});

for (const [label, edit] of [
  ['wrong source URL', d => { d.raw.sourceUrl += '?token=synthetic'; }],
  ['wrong source label', d => { d.raw.source = 'not TJ JPOP'; }],
  ['invalid fetchedAt', d => { d.raw.fetchedAt = '2026-02-30T10:00:00.000Z'; }],
  ['future fetchedAt', d => { d.raw.fetchedAt = '2026-10-16T10:00:00.000Z'; }],
  ['future previous snapshot', d => { d.previous.fetchedAt = '2026-10-16T10:00:00.000Z'; }],
  ['invalid period', d => { d.raw.startDate = '2026-02-30'; }],
  ['reversed period', d => { d.raw.startDate = '2026-10-14'; }],
  ['period after fetch', d => { d.raw.endDate = '2026-10-15'; }],
  ['payload date mismatch', d => { d.raw.requestPayload.endDate = '2026-10-12'; }],
  ['wrong genre request', d => { d.raw.requestPayload.strType = '1'; }],
  ['wrong API URL', d => { d.raw.apiUrl = 'https://example.invalid/chart'; }],
  ['unjustified verified period', d => { delete d.raw.requestPayload.startDate; delete d.raw.requestPayload.endDate; }],
  ['older fetched snapshot', d => { d.raw.fetchedAt = '2026-10-11T10:00:00.000Z'; d.raw.endDate = '2026-10-11'; d.raw.requestPayload.endDate = '2026-10-11'; }],
  ['partial collection', d => { d.raw.songs.pop(); }],
  ['duplicate alias ID', d => { d.raw.songs[1].id = d.raw.songs[0].id; }],
  ['new alias with the same number', d => { d.raw.songs[0].id = 'new-alias'; }],
  ['same alias and number but different title', d => { d.raw.songs[0].title = 'Another song'; }],
  ['same alias and number but different artist', d => { d.raw.songs[0].artist = 'Another artist'; }],
  ['changed number', d => { d.raw.songs[0].tjNumber = '99999'; }],
  ['numeric number', d => { d.raw.songs[0].tjNumber = 1; }],
  ['rank out of order', d => { d.raw.songs[0].rank = 2; }],
  ['fractional rank', d => { d.raw.songs[0].rank = 1.5; }],
  ['missing title', d => { d.raw.songs[0].title = ''; }],
  ['mixed mapping state', d => { d.previous.songs[0].canonicalId = 'canonical-0'; }],
  ['unmapped snapshot from a newer source', d => { d.previous.legacyRevision = newSha; }],
  ['baseline title mismatch', d => { d.baseline.identities[0].observations[0].title = 'Different baseline song'; }],
  ['staging number mismatch', d => { d.staging.songs[0].karaoke.tj.observedNumber = '99999'; }],
  ['missing original chart reference', d => { d.staging.songs[0].refs = []; }],
  ['source hash mismatch', d => { d.baseline.sources[0].sha256 = 'd'.repeat(64); }],
]) {
  test(label + ' preserves the last snapshot and both inputs', async t => {
    const context = await setup(t, edit);
    await assert.rejects(promote(context));
    await assertPreserved(context);
  });
}

test('artifact validator rejects a swapped or duplicated canonical ID instead of number-only matching', () => {
  const data = fixture(), snapshot = build(data);
  snapshot.songs[0].canonicalId = 'canonical-1';
  assert.throws(() => validateChartSnapshot(snapshot, data.staging, data.baseline), { code: 'INVALID_CANONICAL_ID' });
  snapshot.songs[0].canonicalId = 'missing-canonical';
  assert.throws(() => validateChartSnapshot(snapshot, data.staging, data.baseline), { code: 'INVALID_CANONICAL_ID' });
});

test('atomic import leaves raw and staging bytes unchanged and readers see the old snapshot until rename', async t => {
  const context = await setup(t);
  const io = { ...fs, rename: async (from, to) => {
    assert.deepEqual(await fs.readFile(to), context.before.snapshot);
    const prepared = JSON.parse(await fs.readFile(from));
    assert.equal(prepared.songs.length, 100);
    assert.equal(prepared.songs[99].canonicalId, 'canonical-99');
    return fs.rename(from, to);
  } };
  assert.equal((await promote(context, io)).songs, 100);
  assert.deepEqual(await fs.readFile(context.input), context.before.input);
  assert.deepEqual(await fs.readFile(context.staging), context.before.staging);
  const result = JSON.parse(await fs.readFile(context.snapshot));
  assert.equal(result.legacyRevision, newSha);
  assert.deepEqual((await fs.readdir(context.directory)).sort(), ['raw.json', 'snapshot.json', 'staging.json']);
});

for (const [label, bytes] of [['malformed JSON', Buffer.from('{')], ['non-JSON JavaScript', Buffer.from('globalThis.executed = true;')],
  ['invalid UTF-8', Buffer.from([0xff, 0xfe])]]) {
  test(label + ' is rejected without executing code or replacing the snapshot', async t => {
    const context = await setup(t);
    await fs.writeFile(context.input, bytes); context.before.input = bytes;
    await assert.rejects(promote(context), { code: 'INVALID_JSON' });
    await assertPreserved(context);
    assert.equal(globalThis.executed, undefined);
  });
}

test('invalid source SHA, same-file paths and hard-link aliases preserve all files', async t => {
  const context = await setup(t);
  await assert.rejects(importChartSnapshot(context.input, context.snapshot, context.staging, 'short'), { code: 'INVALID_SOURCE_SHA' });
  await assert.rejects(importChartSnapshot(context.snapshot, context.snapshot, context.staging, newSha), { code: 'SAME_FILE' });
  await fs.unlink(context.input); await fs.link(context.snapshot, context.input);
  context.before.input = context.before.snapshot;
  await assert.rejects(promote(context), { code: 'SAME_FILE' });
  await assertPreserved(context);
});

test('snapshot symlinks are refused and their existing target is preserved', async t => {
  const context = await setup(t);
  await fs.unlink(context.snapshot); await fs.symlink(context.input, context.snapshot);
  await assert.rejects(promote(context), { code: 'INVALID_OUTPUT' });
  assert.deepEqual(await fs.readFile(context.input), context.before.input);
  assert.ok((await fs.lstat(context.snapshot)).isSymbolicLink());
});

test('a real exclusive-open failure preserves the snapshot without temporary debris', async t => {
  const context = await setup(t);
  const io = { ...fs, open: () => fs.open(join(context.directory, 'missing-parent', 'temp.json'), 'wx') };
  await assert.rejects(promote(context, io), { code: 'ENOENT' });
  await assertPreserved(context);
});

test('a real partial write followed by failure is cleaned up and preserves the previous snapshot', async t => {
  const context = await setup(t);
  const io = { ...fs, open: async (...args) => {
    const handle = await fs.open(...args);
    return { writeFile: async bytes => {
      await handle.writeFile(bytes.subarray(0, 31));
      throw Object.assign(new Error('synthetic disk-full failure after real partial write'), { code: 'ENOSPC' });
    }, sync: () => handle.sync(), close: () => handle.close() };
  } };
  await assert.rejects(promote(context, io), { code: 'ENOSPC' });
  await assertPreserved(context);
});

test('a real rename into a nonempty directory fails and preserves the prior snapshot', async t => {
  const context = await setup(t), blocker = join(context.directory, 'blocker');
  await fs.mkdir(blocker); await fs.writeFile(join(blocker, 'keep.txt'), 'keep');
  const io = { ...fs, rename: from => fs.rename(from, blocker) };
  await assert.rejects(promote(context, io));
  assert.deepEqual(await fs.readFile(context.snapshot), context.before.snapshot);
  assert.equal(await fs.readFile(join(blocker, 'keep.txt'), 'utf8'), 'keep');
  assert.deepEqual((await fs.readdir(context.directory)).sort(), ['blocker', 'raw.json', 'snapshot.json', 'staging.json']);
});

test('the CLI accepts only four arguments and rejects damaged input with sanitized failure output', async t => {
  const context = await setup(t), cli = fileURLToPath(new URL('../scripts/import-chart-snapshot.mjs', import.meta.url));
  const run = args => spawnSync(process.execPath, [cli, ...args], { cwd: tmpdir(), encoding: 'utf8' });
  assert.equal(run([]).status, 1);
  assert.equal(run([context.input, context.snapshot, context.staging, newSha, 'extra']).status, 1);
  await fs.writeFile(context.input, '{ private-input-value');
  context.before.input = await fs.readFile(context.input);
  const result = run([context.input, context.snapshot, context.staging, newSha]);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /INVALID_JSON; previous snapshot preserved/);
  assert.doesNotMatch(result.stdout + result.stderr, /private-input-value|SYNTHETIC PRIVATE/);
  await assertPreserved(context);
});
