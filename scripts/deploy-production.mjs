/** Deploy reviewed organization artifacts to the existing origin, preserving storage. */
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { verifyDist } from './verify-dist.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const sha = git(['rev-parse', 'HEAD']);
if (git(['status', '--porcelain'])) throw new Error('Production requires a clean committed source tree');
const artifact = await verifyDist({ expectedSourceSha: sha, expectedTarget: 'production' });
const state = JSON.parse(execFileSync('python3', ['scripts/manage-production.py', 'inspect'], { cwd: root, encoding: 'utf8' }));
if (state.source.production_branch !== 'dev' || state.source.production_deployments_enabled !== false || state.source.preview_deployment_setting !== 'none')
  throw new Error('Pause legacy automatic production/preview builds before organization deployment');
const scrub = value => [process.env.CLOUDFLARE_API_TOKEN, process.env.CLOUDFLARE_ACCOUNT_ID].filter(Boolean).reduce((out, secret) => out.split(secret).join('[redacted]'), value);
const cli = fileURLToPath(new URL('../node_modules/wrangler/bin/wrangler.js', import.meta.url));
const result = spawnSync(process.execPath, [cli, 'pages', 'deploy', 'dist', '--project-name', 'todayjpop',
  '--branch', 'dev', '--commit-hash', sha, '--commit-dirty', 'false'], {
  cwd: root, encoding: 'utf8', env: { ...process.env, WRANGLER_SEND_METRICS: 'false', XDG_CONFIG_HOME: '/tmp/jpop-wrangler-config' },
});
process.stdout.write(scrub(result.stdout ?? '')); process.stderr.write(scrub(result.stderr ?? ''));
if (result.error || result.status !== 0) process.exitCode = result.status ?? 1;
else console.log(`Production todayjpop/jpop.today; verified organization source ${artifact.sourceSha}`);
