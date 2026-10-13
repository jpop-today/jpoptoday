import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../scripts/audit-legacy-source.mjs', import.meta.url));
const run = (...args) => spawnSync(process.execPath, [cli, ...args], { cwd: tmpdir(), encoding: 'utf8' });
const revisionA = 'a'.repeat(40);
const revisionB = 'b'.repeat(40);

test('legacy CLI rejects missing arguments, mutable refs, duplicate SHAs, and unknown options', () => {
  for (const args of [[], ['/missing', 'main', revisionB, '/output.json'], ['/missing', revisionA, revisionA, '/output.json'], ['/missing', revisionA, revisionB, '/output.json', '--force']]) {
    const result = run(...args);
    assert.equal(result.status, 1);
    assert.ok(result.stderr.length > 0);
  }
});

test('legacy CLI preserves an existing baseline when source checkout is missing or unusable', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'jpoptoday-legacy-cli-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const output = join(directory, 'baseline.json');
  await writeFile(output, 'previous baseline');
  for (const checkout of [join(directory, 'missing'), directory]) {
    assert.equal(run(checkout, revisionA, revisionB, output).status, 1);
    assert.equal(await readFile(output, 'utf8'), 'previous baseline');
    assert.deepEqual(await readdir(directory), ['baseline.json']);
  }
});
