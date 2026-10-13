import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstat, open, readFile, realpath, rename, unlink } from 'node:fs/promises';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { buildLegacyIdentityBaseline } from '../contracts/legacy-identity.mjs';

const args = process.argv.slice(2);
const [repositoryPath, revisionA, revisionB, output, mode] = args;
if ((args.length !== 4 && args.length !== 5) || (mode && mode !== '--check')) {
  process.stderr.write('Usage: node scripts/audit-legacy-source.mjs <git-checkout> <full-sha-a> <full-sha-b> <baseline.json> [--check]\n');
  process.exitCode = 1;
} else {
  try {
    if (![revisionA, revisionB].every(value => /^[a-f0-9]{40}$/.test(value)) || revisionA === revisionB)
      throw new Error('Provide two different full lowercase commit SHAs');
    const checkout = await realpath(repositoryPath);
    const git = (...gitArgs) => {
      try {
        return execFileSync('git', ['-C', checkout, '--no-pager', ...gitArgs], {
          maxBuffer: 32 * 1024 * 1024,
          env: { ...process.env, GIT_NO_LAZY_FETCH: '1', GIT_TERMINAL_PROMPT: '0' },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch { throw new Error('Cannot read required local Git object or configuration: ' + gitArgs[0]); }
    };
    const sourceRoot = await realpath(git('rev-parse', '--show-toplevel').toString('utf8').trim());
    const origin = git('remote', 'get-url', 'origin').toString('utf8').trim();
    const inputs = [];
    for (const revision of [revisionA, revisionB]) {
      if (git('rev-parse', '--verify', revision + '^{commit}').toString('utf8').trim() !== revision)
        throw new Error('Revision must identify an available commit object');
      for (const path of ['js/songs.js', 'js/chart.js'])
        inputs.push({ revision, path, bytes: git('show', revision + ':' + path) });
    }
    const baseline = buildLegacyIdentityBaseline(origin, inputs);
    const bytes = Buffer.from(JSON.stringify(baseline, null, 2) + '\n');
    const resolvedOutput = resolve(output);
    const outputDirectory = await realpath(dirname(resolvedOutput));
    const outputPath = join(outputDirectory, basename(resolvedOutput));
    if (outputPath === sourceRoot || outputPath.startsWith(sourceRoot + sep))
      throw new Error('Write the baseline outside the original checkout');
    let existing;
    try { existing = await lstat(outputPath); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (existing && !existing.isFile()) throw new Error('Baseline output must be a regular file');
    if (mode === '--check') {
      if (!bytes.equals(await readFile(outputPath))) throw new Error('Baseline differs from the selected source commits');
    } else {
      const stagingPath = join(outputDirectory, '.' + basename(outputPath) + '.' + randomUUID() + '.tmp');
      let handle;
      let owned = false;
      try {
        handle = await open(stagingPath, 'wx', 0o644);
        owned = true;
        await handle.writeFile(bytes);
        await handle.sync();
        await handle.close();
        handle = undefined;
        await rename(stagingPath, outputPath);
        owned = false;
      } finally {
        if (handle) await handle.close().catch(() => {});
        if (owned) await unlink(stagingPath).catch(() => {});
      }
    }
    process.stdout.write('Legacy identity baseline ' + (mode === '--check' ? 'matches' : 'written') + ': ' + baseline.summary.totalIds + ' IDs, ' + baseline.summary.playlistIds + ' playlist IDs, ' + baseline.summary.chartOnlyIds + ' chart-only IDs; unresolved aliases: ' + baseline.summary.unresolvedAliasGroups + '\n');
  } catch (error) {
    process.stderr.write('Cannot audit legacy source: ' + error.message + '\n');
    process.exitCode = 1;
  }
}
