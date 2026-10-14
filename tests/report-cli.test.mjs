import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, access, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const cli = fileURLToPath(new URL('../scripts/build-report.mjs', import.meta.url));
test('오전 CLI가 손상된 전일 완료 기록을 거부하며 기존 파일을 보존한다', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'jpop-report-regression-'));
  try {
    await mkdir(join(cwd, 'reports/daily'), { recursive: true });
    const file = join(cwd, 'reports/daily/2026-10-13.json');
    const invalid = JSON.stringify({ date: '2026-10-13', phase: 'complete', timezone: 'UTC', schemaVersion: 99, completed: ['unvalidated synthetic result'], nextPlan: ['synthetic plan'] });
    const output = join(cwd, 'morning.json');
    for (const bytes of [invalid, 'null', '[]']) {
      await writeFile(file, bytes);
      const result = spawnSync(process.execPath, [cli, 'morning', output], { cwd, encoding: 'utf8', env: { ...process.env, REPORT_DATE: '2026-10-14' } });
      assert.equal(result.status, 1, result.stderr);
      assert.doesNotMatch(result.stdout + result.stderr, /unvalidated synthetic result/);
      await assert.rejects(access(output));
      assert.equal(await readFile(file, 'utf8'), bytes);
    }
  } finally { await rm(cwd, { recursive: true, force: true }); }
});
