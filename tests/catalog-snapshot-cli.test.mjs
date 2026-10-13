import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../scripts/promote-catalog.mjs', import.meta.url));
const fixture = fileURLToPath(new URL('./fixtures/catalog.json', import.meta.url));
const fixtureBytes = await readFile(fixture);
const run = (...args) => spawnSync(process.execPath, [cli, ...args], { cwd: tmpdir(), encoding: 'utf8' });

test('snapshot CLI accepts explicit paths from another working directory', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'jpoptoday-snapshot-cli-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const snapshot = join(directory, 'snapshot.json');
  const result = run(fixture, snapshot);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Catalog snapshot promoted: 1 songs, 1 artists/);
  assert.deepEqual(await readFile(snapshot), fixtureBytes);
  assert.deepEqual(await readdir(directory), ['snapshot.json']);
});

test('snapshot CLI returns nonzero and preserves the existing snapshot on collection and validation failures', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'jpoptoday-snapshot-cli-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const candidate = join(directory, 'candidate.json');
  const snapshot = join(directory, 'snapshot.json');
  await writeFile(snapshot, fixtureBytes);
  assert.equal(run().status, 1);
  assert.equal(run(fixture).status, 1);
  assert.equal(run(fixture, snapshot, 'extra').status, 1);
  assert.equal(run(candidate, snapshot).status, 1);
  await writeFile(candidate, '{');
  assert.equal(run(candidate, snapshot).status, 1);
  await writeFile(candidate, JSON.stringify({ schemaVersion: 1, artists: [], songs: [] }));
  const result = run(candidate, snapshot);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Expected a nonempty song array/);
  assert.equal(run(snapshot, snapshot).status, 1);
  assert.deepEqual(await readFile(snapshot), fixtureBytes);
  assert.deepEqual((await readdir(directory)).sort(), ['candidate.json', 'snapshot.json']);
});
