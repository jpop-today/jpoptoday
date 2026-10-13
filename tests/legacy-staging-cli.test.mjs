import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { link, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildLegacyIdentityBaseline } from '../contracts/legacy-identity.mjs';

const cli = fileURLToPath(new URL('../scripts/import-legacy-staging.mjs', import.meta.url));
const run = (...args) => spawnSync(process.execPath, [cli, ...args], { cwd: tmpdir(), encoding: 'utf8' });
const header = 'title\ttitleKo\tartist\tartistKo\tTJ\tKY\ttags\n';
const song = (id, title, number) => ({ id, title, titleKo: '', artist: 'Artist', artistKo: '', tjNumber: number, kyNumber: '', tags: ['TJ'] });
const js = (row, variable) => 'const ' + variable + ' = ' + JSON.stringify([row]) + ';\n';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'jpoptoday-staging-cli-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const checkout = join(directory, 'original');
  await mkdir(join(checkout, 'data'), { recursive: true }); await mkdir(join(checkout, 'js'));
  const git = (...args) => execFileSync('git', ['-C', checkout, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-q'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.com');
  git('config', 'commit.gpgsign', 'false'); git('remote', 'add', 'origin', 'https://github.com/example/legacy.git');
  const playlist = song('unchanged-id', 'A song', '00123');
  await writeFile(join(checkout, 'js/songs.js'), js(playlist, 'songs'));
  await writeFile(join(checkout, 'js/chart.js'), js(song('old-chart-id', 'Old chart', '00456'), 'tjJpopChart'));
  await writeFile(join(checkout, 'data/jpop-playlist.raw.json'), JSON.stringify({ parsedRows: 1, uniqueSongs: 1, songs: [playlist] }));
  await writeFile(join(checkout, 'data/jpop-playlist-karaoke-tj-ky-merged.txt'), header + 'A song\t\tArtist\t\t00123\t\tTJ\n');
  git('add', '.'); git('-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'Initial fixture');
  const previous = git('rev-parse', 'HEAD');
  await writeFile(join(checkout, 'js/chart.js'), js(song('current-chart-id', 'Current chart', '00789'), 'tjJpopChart'));
  git('add', '.'); git('-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'Updated chart');
  const revision = git('rev-parse', 'HEAD');
  const inputs = [previous, revision].flatMap(sha => ['js/songs.js', 'js/chart.js'].map(path => ({
    revision: sha, path, bytes: Buffer.from(git('show', sha + ':' + path) + '\n'),
  })));
  const baseline = join(directory, 'baseline.json');
  await writeFile(baseline, JSON.stringify(buildLegacyIdentityBaseline('https://github.com/example/legacy', inputs)));
  const output = join(directory, 'staging.json');
  return { directory, checkout, revision, baseline, output, git };
}

test('staging CLI rejects missing arguments, mutable refs, unsupported options and missing Git sources', async t => {
  for (const args of [[], ['/missing', 'main', '/baseline.json', '/output.json'], ['/missing', 'a'.repeat(40), '/baseline.json', '/output.json', '--force']])
    assert.equal(run(...args).status, 1);
  const input = await fixture(t);
  await writeFile(input.output, 'last known staging');
  for (const checkout of [join(input.directory, 'missing'), input.directory]) {
    assert.equal(run(checkout, input.revision, input.baseline, input.output).status, 1);
    assert.equal(await readFile(input.output, 'utf8'), 'last known staging');
  }
  assert.equal(run(input.checkout, 'a'.repeat(40), input.baseline, input.output).status, 1);
  assert.equal(await readFile(input.output, 'utf8'), 'last known staging');
});

test('CLI imports exact Git bytes outside the checkout, preserves archives, and --check detects drift without rewriting', async t => {
  const input = await fixture(t);
  const result = run(input.checkout, input.revision, input.baseline, input.output);
  assert.equal(result.status, 0, result.stderr);
  const originalBytes = await readFile(input.output);
  const output = JSON.parse(originalBytes);
  assert.equal(output.summary.totalIds, 3);
  assert.equal(output.summary.archivedChartOnlyIds, 1);
  assert.equal(output.songs.find(row => row.id === 'unchanged-id').karaoke.tj.observedNumber, '00123');
  assert.equal(run(input.checkout, input.revision, input.baseline, input.output, '--check').status, 0);
  await writeFile(join(input.checkout, 'data/jpop-playlist.raw.json'), '{}');
  assert.equal(run(input.checkout, input.revision, input.baseline, input.output, '--check').status, 0, 'reads committed Git bytes, not a mutable working copy');
  await writeFile(input.output, 'drifted previous output');
  assert.equal(run(input.checkout, input.revision, input.baseline, input.output, '--check').status, 1);
  assert.equal(await readFile(input.output, 'utf8'), 'drifted previous output');
  assert.equal(run(input.checkout, input.revision, input.baseline, input.output).status, 0);
  assert.deepEqual(await readFile(input.output), originalBytes);
  assert.equal((await readdir(input.directory)).some(name => name.endsWith('.tmp')), false);
});

test('invalid UTF-8 and partial baseline leave a previous staging output byte-for-byte unchanged', async t => {
  const input = await fixture(t);
  const baseline = await readFile(input.baseline);
  await writeFile(input.output, 'previous verified staging');
  for (const invalid of [Buffer.from([0xc3, 0x28]), Buffer.from('{}'), Buffer.from('{"sources":[]}')]) {
    await writeFile(input.baseline, invalid);
    assert.equal(run(input.checkout, input.revision, input.baseline, input.output).status, 1);
    assert.equal(await readFile(input.output, 'utf8'), 'previous verified staging');
  }
  const partial = JSON.parse(baseline); partial.sources.pop();
  await writeFile(input.baseline, JSON.stringify(partial));
  assert.equal(run(input.checkout, input.revision, input.baseline, input.output).status, 1);
  assert.equal(await readFile(input.output, 'utf8'), 'previous verified staging');
  assert.equal((await readdir(input.directory)).some(name => name.endsWith('.tmp')), false);
});

test('CLI rejects writes into source checkout and baseline aliases, including symlinks and hardlinks', async t => {
  const input = await fixture(t);
  const baselineBytes = await readFile(input.baseline);
  const raw = join(input.checkout, 'data/jpop-playlist.raw.json');
  const rawBytes = await readFile(raw);
  assert.equal(run(input.checkout, input.revision, input.baseline, raw).status, 1);
  assert.deepEqual(await readFile(raw), rawBytes);
  assert.equal(run(input.checkout, input.revision, input.baseline, input.baseline).status, 1);
  const symbolic = join(input.directory, 'symlink.json'), hard = join(input.directory, 'hardlink.json');
  await symlink(input.baseline, symbolic); await link(input.baseline, hard);
  for (const output of [symbolic, hard]) assert.equal(run(input.checkout, input.revision, input.baseline, output).status, 1);
  assert.deepEqual(await readFile(input.baseline), baselineBytes);
  const linkedDirectory = join(input.directory, 'linked-original'); await symlink(input.checkout, linkedDirectory);
  assert.equal(run(input.checkout, input.revision, input.baseline, join(linkedDirectory, 'data/out.json')).status, 1);
});

test('a valid but partial collection at a new source commit cannot replace the complete baseline output', async t => {
  const input = await fixture(t);
  assert.equal(run(input.checkout, input.revision, input.baseline, input.output).status, 0);
  const previousBytes = await readFile(input.output);
  await writeFile(join(input.checkout, 'data/jpop-playlist-karaoke-tj-ky-merged.txt'), header);
  input.git('add', '.'); input.git('-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'Incomplete collection');
  const partialRevision = input.git('rev-parse', 'HEAD');
  const baseline = JSON.parse(await readFile(input.baseline));
  const revisions = [...baseline.revisions.map(row => row.revision), partialRevision];
  const inputs = revisions.flatMap(revision => ['js/songs.js', 'js/chart.js'].map(path => ({ revision, path, bytes: Buffer.from(input.git('show', revision + ':' + path) + '\n') })));
  await writeFile(input.baseline, JSON.stringify(buildLegacyIdentityBaseline('https://github.com/example/legacy', inputs)));
  assert.equal(run(input.checkout, partialRevision, input.baseline, input.output).status, 1);
  assert.deepEqual(await readFile(input.output), previousBytes);
});

test('non-file output is rejected while its contents and the staging directory remain intact', async t => {
  const input = await fixture(t);
  await mkdir(input.output);
  await writeFile(join(input.output, 'existing.txt'), 'preserve');
  assert.equal(run(input.checkout, input.revision, input.baseline, input.output).status, 1);
  assert.equal(await readFile(join(input.output, 'existing.txt'), 'utf8'), 'preserve');
  assert.equal((await readdir(input.directory)).some(name => name.endsWith('.tmp')), false);
});
