import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../scripts/validate-catalog.mjs', import.meta.url));
const run = (...args) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
test('CLI accepts valid input from a different working directory', () => {
  const path = fileURLToPath(new URL('./fixtures/catalog.json', import.meta.url));
  const result = spawnSync(process.execPath, [cli, path], { cwd: tmpdir(), encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Catalog valid: 1 songs, 1 artists/);
});
test('CLI returns nonzero for missing, malformed, and empty input', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'jpoptoday-contract-'));
  try {
    assert.equal(run().status, 1);
    assert.equal(run(join(directory, 'missing.json')).status, 1);
    const path = join(directory, 'input.json');
    await writeFile(path, '{');
    assert.equal(run(path).status, 1);
    await writeFile(path, JSON.stringify({ schemaVersion: 1, artists: [], songs: [] }));
    const result = run(path);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Expected a nonempty song array/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
