/** Deploy only the dedicated noindex preview project, with a clean pinned artifact. */
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { verifyDist } from './verify-dist.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
const project = 'jpoptoday-preview';
const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const sha = git(['rev-parse', 'HEAD']);
if (git(['status', '--porcelain'])) throw new Error('Commit all source changes before preview deployment');
const artifact = await verifyDist({ expectedSourceSha: sha });
const scrub = value => [process.env.CLOUDFLARE_API_TOKEN, process.env.CLOUDFLARE_ACCOUNT_ID].filter(Boolean).reduce((out, secret) => out.split(secret).join('[redacted]'), value);
const cli = fileURLToPath(new URL('../node_modules/wrangler/bin/wrangler.js', import.meta.url));
const result = spawnSync(process.execPath, [cli, 'pages', 'deploy', 'dist', '--project-name', project,
  '--branch', 'main', '--commit-hash', sha, '--commit-dirty', 'false'], {
  cwd: root, encoding: 'utf8', env: { ...process.env, WRANGLER_SEND_METRICS: 'false', XDG_CONFIG_HOME: '/tmp/jpop-wrangler-config' },
});
process.stdout.write(scrub(result.stdout ?? ''));
process.stderr.write(scrub(result.stderr ?? ''));
if (result.error || result.status !== 0) process.exitCode = result.status ?? 1;
else console.log(`Preview project ${project}; verified source ${artifact.sourceSha}; no custom production domain changed.`);
