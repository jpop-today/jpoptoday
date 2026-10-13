import test from 'node:test';
import assert from 'node:assert/strict';
import { koreanDate, previousDate, validateDate, morningReport, eventReport, validateCompleteReport, evaluateTeam } from '../scripts/build-report.mjs';
test('09시 보고는 KST 날짜와 전날의 완료 기록만 사용한다', () => {
  assert.equal(koreanDate(new Date('2026-10-13T15:01:00Z')), '2026-10-14');
  assert.equal(previousDate('2026-01-01'), '2025-12-31');
  assert.throws(() => validateDate('2026-02-30'));
  const report = morningReport({ date: '2026-10-14', previous: { date: '2026-10-13', phase: 'complete', completed: ['실제 변경'], nextPlan: ['번호 대조'] } });
  assert.equal(report.fields[0].value, '실제 변경');
  assert.equal(report.fields[1].value, '번호 대조');
  assert.throws(() => morningReport({ date: '2026-10-14', previous: { date: '2026-10-12', phase: 'complete' } }));
  assert.match(morningReport({ date: '2026-10-14' }).fields[0].value, /보고 없음/);
});
test('완료 보고 없는 날짜와 잘못된 CI 식별자를 승인하지 않는다', () => {
  assert.throws(() => validateCompleteReport({ phase: 'plan' }, '2026-10-13'));
  assert.throws(() => eventReport('workflow_run', { workflow_run: { head_sha: 'short' } }));
  const report = eventReport('workflow_run', { workflow_run: { name: 'app', conclusion: 'failure', head_sha: 'a'.repeat(40), html_url: 'https://github.com/jpop-today/jpoptoday/actions/runs/1' } });
  assert.match(report.summary, /failure/);
});
const workers = ['one', 'two', 'three'];
const reviews = workers.flatMap(reviewer => workers.filter(candidate => candidate !== reviewer).map(candidate => ({ reviewer, candidate, scores: { correctness: 5, evidence: 4, value: candidate === 'two' ? 3 : 4, maintainability: 5 }, reason: '읽은 파일과 검증 결과에 근거', evidence: ['artifact:1'] })));
test('두 동료의 실제 리뷰로 최저 결과를 계산하고 자기/중복/근거 없는 투표를 거부한다', () => {
  assert.deepEqual(evaluateTeam(workers, reviews).lowest, ['two']);
  assert.equal(evaluateTeam(workers, reviews).totals.two, 34);
  assert.throws(() => evaluateTeam(workers, reviews.slice(1)));
  assert.throws(() => evaluateTeam(workers, [...reviews.slice(0, 5), reviews[0]]));
  assert.throws(() => evaluateTeam(workers, reviews.map((r, i) => i ? r : { ...r, candidate: r.reviewer })));
  assert.throws(() => evaluateTeam(workers, reviews.map((r, i) => i ? r : { ...r, evidence: [] })));
  assert.throws(() => evaluateTeam(workers, reviews.map((r, i) => i ? r : { ...r, scores: { ...r.scores, value: 6 } })));
});
