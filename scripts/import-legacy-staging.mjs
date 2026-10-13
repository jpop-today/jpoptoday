import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstat, open, readFile, realpath, rename, unlink } from 'node:fs/promises';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { buildLegacyStaging, legacyStagingPaths } from '../contracts/legacy-staging.mjs';

const args = process.argv.slice(2);
const [repositoryPath, revision, baselineFile, output, mode] = args;
if ((args.length !== 4 && args.length !== 5) || (mode && mode !== '--check')) {
  process.stderr.write('Usage: node scripts/import-legacy-staging.mjs <git-checkout> <full-source-sha> <baseline.json> <staging.json> [--check]\n');
  process.exitCode = 1;
} else {
  try {
    if (!/^[a-f0-9]{40}$/.test(revision)) throw new Error('A full lowercase source commit SHA is required');
    const checkout = await realpath(repositoryPath);
    const git = (...gitArgs) => {
      try {
        return execFileSync('git', ['-C', checkout, '--no-pager', ...gitArgs], {
          maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
          env: { ...process.env, GIT_NO_LAZY_FETCH: '1', GIT_TERMINAL_PROMPT: '0' },
        });
      } catch { throw new Error('Cannot read required local Git object or configuration: ' + gitArgs[0]); }
    };
    const sourceRoot = await realpath(git('rev-parse', '--show-toplevel').toString('utf8').trim());
    const origin = git('remote', 'get-url', 'origin').toString('utf8').trim();
    const baselinePath = await realpath(baselineFile);
    let baseline;
    try { baseline = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await readFile(baselinePath))); }
    catch { throw new Error('Baseline must be valid UTF-8 JSON'); }
    if (!Array.isArray(baseline?.sources) || !baseline.sources.length) throw new Error('A nonempty source baseline is required');
    const sources = new Map();
    for (const source of baseline.sources) {
      if (!/^[a-f0-9]{40}$/.test(source.revision || '') || ![legacyStagingPaths.playlist, legacyStagingPaths.chart].includes(source.path))
        throw new Error('Invalid baseline source reference');
      sources.set(source.revision + ':' + source.path, { revision: source.revision, path: source.path });
    }
    for (const path of Object.values(legacyStagingPaths)) sources.set(revision + ':' + path, { revision, path });
    for (const sha of new Set([...sources.values()].map(source => source.revision)))
      if (git('rev-parse', '--verify', sha + '^{commit}').toString('utf8').trim() !== sha) throw new Error('Source revision is not an available commit object');
    const inputs = [...sources.values()].map(source => ({ ...source, bytes: git('show', source.revision + ':' + source.path) }));
    const staging = buildLegacyStaging({ repository: origin, revision, baseline, inputs });
    const bytes = Buffer.from(JSON.stringify(staging, null, 2) + '\n');
    const resolvedOutput = resolve(output);
    const outputDirectory = await realpath(dirname(resolvedOutput));
    const outputPath = join(outputDirectory, basename(resolvedOutput));
    if (outputPath === sourceRoot || outputPath.startsWith(sourceRoot + sep)) throw new Error('Write staging outside the original checkout');
    if (outputPath === baselinePath) throw new Error('Staging output must differ from the baseline');
    let existing;
    try { existing = await lstat(outputPath); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (existing && !existing.isFile()) throw new Error('Staging output must be a regular file');
    if (existing && (await realpath(outputPath)) === baselinePath) throw new Error('Staging output must not alias the baseline');
    const baselineStat = await lstat(baselinePath);
    if (existing && existing.dev === baselineStat.dev && existing.ino === baselineStat.ino) throw new Error('Staging output must not alias the baseline');
    if (mode === '--check') {
      if (!bytes.equals(await readFile(outputPath))) throw new Error('Staging differs from the selected source and baseline');
    } else {
      const temporary = join(outputDirectory, '.' + basename(outputPath) + '.' + randomUUID() + '.tmp');
      let handle, owned = false;
      try {
        handle = await open(temporary, 'wx', 0o644); owned = true;
        await handle.writeFile(bytes); await handle.sync(); await handle.close(); handle = undefined;
        await rename(temporary, outputPath); owned = false;
      } finally {
        if (handle) await handle.close().catch(() => {});
        if (owned) await unlink(temporary).catch(() => {});
      }
    }
    process.stdout.write('Legacy staging ' + (mode === '--check' ? 'matches' : 'written') + ': ' + JSON.stringify(staging.summary) + '\n');
  } catch (error) {
    process.stderr.write('Cannot import legacy staging: ' + error.message + '\n');
    process.exitCode = 1;
  }
}
