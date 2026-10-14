/** Build a factual Discord report. This does not run agents or publish releases. */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function koreanDate(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}
export function previousDate(date) {
  validateDate(date);
  return new Date(Date.parse(`${date}T00:00:00Z`) - 86400000).toISOString().slice(0, 10);
}
export function validateDate(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date ?? '') || !Number.isFinite(Date.parse(`${date}T00:00:00Z`)) || new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date) throw new Error('Invalid report date');
  return date;
}
function list(values, fallback) {
  return Array.isArray(values) && values.length ? values.map(value => typeof value === 'string' ? value : value.after ?? value.name).filter(Boolean).join('\n') : fallback;
}
export function morningReport({ date, previous = null }) {
  validateDate(date);
  const yesterday = previousDate(date);
  if (previous) validateCompleteReport(previous, yesterday);
  return {
    schemaVersion: 1, date, timezone: 'Asia/Seoul', phase: 'plan',
    title: `${date} 오전 09시 · jpop.today`,
    summary: '저장된 실행 기록을 기준으로 어제 결과와 오늘 계획을 전합니다. 개발 관리자의 실행 결과는 완료 보고로 별도 기록합니다.',
    fields: [
      { name: `어제 · ${yesterday}`, value: previous ? list(previous.completed, '저장된 완료 항목 없음') : '전날 완료 보고 없음. 확인되지 않은 작업을 완료로 집계하지 않았습니다.' },
      { name: '오늘 계획', value: list(previous?.nextPlan, '공식 TJ·금영 번호 충돌 정정 근거 검토\n원본 그라데이션·검색/저장 호환성 유지\n검증 가능한 변경과 AdSense 운영 전환 게이트 진행\n세 신규 에이전트 배정·실행은 Codex 관리자 예약에서 수행') },
      { name: '승인 상태', value: previous?.adsense?.state === 'approved' ? '이전 보고에 기록된 approved 상태. 실제 Google 통지 근거는 해당 보고 참조.' : 'Google 실제 심사 승인 미확인. 준비·제출·승인을 구분합니다.' },
    ],
    url: 'https://github.com/jpop-today/docs/blob/main/operations/daily-development.md',
  };
}
export function eventReport(eventName, event) {
  if (eventName === 'workflow_run') {
    const run = event.workflow_run;
    if (!run || !/^[a-f0-9]{40}$/.test(run.head_sha ?? '')) throw new Error('Invalid workflow identity');
    return { title: `CI/CD · ${run.name}`, summary: `실행 결과: ${run.conclusion ?? 'unknown'}`, fields: [
      { name: '브랜치', value: String(run.head_branch ?? 'unknown') },
      { name: '소스 SHA', value: run.head_sha },
      { name: '배포 구분', value: 'CI 통과는 운영 배포·AdSense 승인을 뜻하지 않습니다. 실제 배포는 릴리스 기록을 확인하세요.' },
    ], url: run.html_url };
  }
  if (eventName === 'release') {
    if (!event.release?.tag_name) throw new Error('Missing release');
    return { title: `릴리스 · ${event.release.tag_name}`, summary: event.release.name ?? event.release.tag_name,
      fields: [{ name: '변경 기록', value: '검증 결과와 미리보기·운영 범위는 릴리스 노트에서 확인하세요.' }], url: event.release.html_url };
  }
  throw new Error('Unsupported report event');
}
export function validateCompleteReport(report, expectedDate) {
  validateDate(expectedDate);
  if (report.schemaVersion !== 1 || report.date !== expectedDate || report.timezone !== 'Asia/Seoul' || report.phase !== 'complete') throw new Error('Invalid completed report identity');
  const text = value => typeof value === 'string' && Boolean(value.trim());
  if (!text(report.title) || !text(report.summary) || !Array.isArray(report.fields) || report.fields.length > 25 || !report.fields.every(field => field && text(field.name) && text(field.value) && (field.inline === undefined || typeof field.inline === 'boolean')) || !Array.isArray(report.completed) || !report.completed.every(text) || !Array.isArray(report.nextPlan) || !report.nextPlan.every(text)) throw new Error('Invalid completed report content');
  return report;
}
export function evaluateTeam(workers, reviews) {
  if (!Array.isArray(workers) || workers.length !== 3 || new Set(workers).size !== 3 || !workers.every(w => typeof w === 'string' && w)) throw new Error('Exactly three unique workers required');
  if (!Array.isArray(reviews) || reviews.length !== 6) throw new Error('Two peer reviews per worker required');
  const keys = ['correctness', 'evidence', 'value', 'maintainability'];
  const pairs = new Set();
  const totals = Object.fromEntries(workers.map(w => [w, 0]));
  for (const review of reviews) {
    if (!workers.includes(review.reviewer) || !workers.includes(review.candidate) || review.reviewer === review.candidate) throw new Error('Invalid peer identity');
    const pair = `${review.reviewer}\u0000${review.candidate}`;
    if (pairs.has(pair)) throw new Error('Duplicate peer review');
    pairs.add(pair);
    if (typeof review.reason !== 'string' || !review.reason.trim() || !Array.isArray(review.evidence) || !review.evidence.length || !review.evidence.every(v => typeof v === 'string' && v.trim())) throw new Error('Review reason and evidence required');
    for (const key of keys) {
      const score = review.scores?.[key];
      if (!Number.isInteger(score) || score < 0 || score > 5) throw new Error('Scores must be integers from zero to five');
      totals[review.candidate] += score;
    }
  }
  const minimum = Math.min(...Object.values(totals));
  return { totals, lowest: workers.filter(w => totals[w] === minimum), maximum: 40 };
}
async function optionalJson(path) {
  try {
    const value = JSON.parse(await readFile(path, 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid stored report object');
    return value;
  }
  catch (error) { if (error.code === 'ENOENT') return null; throw new Error('Stored report unreadable'); }
}
export async function main(args = process.argv.slice(2), env = process.env) {
  const [mode, output] = args;
  if (!output) throw new Error('Usage: build-report.mjs morning|event|completed|message <output.json>');
  const date = validateDate(env.REPORT_DATE || koreanDate());
  let report;
  if (mode === 'morning') report = morningReport({ date, previous: await optionalJson(resolve('reports/daily', `${previousDate(date)}.json`)) });
  else if (mode === 'completed') {
    const saved = await optionalJson(resolve('reports/daily', `${date}.json`));
    if (!saved) throw new Error('Completed report missing; nothing sent');
    report = validateCompleteReport(saved, date);
  } else if (mode === 'event') report = eventReport(env.GITHUB_EVENT_NAME, JSON.parse(await readFile(env.GITHUB_EVENT_PATH, 'utf8')));
  else if (mode === 'message') {
    if (!env.MESSAGE_TEXT?.trim()) throw new Error('Manager message empty');
    report = { title: env.MESSAGE_TITLE || 'jpop.today 관리자 보고', summary: env.MESSAGE_TEXT, fields: [], url: 'https://github.com/jpop-today/jpoptoday/issues/9' };
  } else throw new Error('Unknown report mode');
  await mkdir(dirname(resolve(output)), { recursive: true });
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  console.log(`Report prepared: ${mode} (${date}); delivery not yet confirmed.`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => { console.error('Report preparation failed; no message sent. Check mode, date and stored report.'); process.exitCode = 1; });
}
