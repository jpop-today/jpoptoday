import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyDetailNumbers } from '../scripts/verify-dist.mjs';

// Synthetic policy fixtures, not provider observations or generated app HTML.
// Expected permission is stated in each test; no app predicate/formatter is used.
const observed = number => ({ status: 'observed-unverified', observedNumber: number, conflict: false, evidence: null, correction: null });
const unknown = () => ({ status: 'unknown', observedNumber: null, conflict: false, evidence: null, correction: null });
const song = () => ({ id: 'synthetic-artifact-policy', availability: 'current', origin: 'playlist', karaoke: { tj: observed('00123'), ky: observed('00987') } });
const section = (heading, content) => `<section><h2>${heading}</h2>${content}</section>`;
const page = (tj, ky) => `<article><div class="detail-numbers">${section('TJ', tj)}${section('금영', ky)}</div></article>`;
const tjObserved = '<button type="button" class="number-button" data-copy="00123" aria-label="tj 번호 복사">00123</button><p>관측 번호 · 재확인 필요</p>';
const kyObserved = '<button type="button" class="number-button" data-copy="00987" aria-label="ky 번호 복사">00987</button><p>관측 번호 · 재확인 필요</p>';
const withholding = '<p class="unknown">번호 충돌 · 재확인 필요</p><p>다른 항목과의 번호 충돌이 해결될 때까지 번호 표시와 복사를 보류합니다. 미수록을 뜻하지 않습니다.</p>';
const unknownNotice = '<p class="unknown">확인 필요</p><p>확인된 번호가 없습니다. 미수록을 뜻하지 않습니다.</p>';
const tjHistory = '<p class="verification-note">합성 과거 사유: 원번호 00123은 보존하며 2개 항목의 동일성을 단정하지 않습니다.</p><p class="verification-note"><a href="https://www.tjmedia.com/song/accompaniment_search?nationType=JPN&amp;strType=16&amp;searchTxt=00123&amp;strWord=Y">공식 대조 결과</a><br>합성 조회일: 2001-01-01</p>';
const confirmedText = html => html.replace('관측 번호 · 재확인 필요', '공식 검색에서 확인');
const tjEvidence = { url: 'https://www.tjmedia.com/song/accompaniment_search?nationType=JPN&strType=16&searchTxt=00123&strWord=Y', checkedAt: '2001-01-01', title: 'Synthetic title', artist: 'Synthetic artist' };
const kyEvidence = { url: 'https://www.kygabang.com/chart/search_list.php?mode=SongSearch&val=00987', checkedAt: '2001-01-01', title: 'Synthetic title', artist: 'Synthetic artist' };

test('mixed TJ conflict and confirmed KY retain historical evidence and leading-zero strings without mutating data', () => {
  const fixture = song();
  fixture.karaoke.tj = { ...fixture.karaoke.tj, status: 'provider-confirmed', conflict: true, evidence: tjEvidence };
  fixture.karaoke.ky = { ...fixture.karaoke.ky, status: 'provider-confirmed', evidence: kyEvidence };
  const before = structuredClone(fixture);
  assert.doesNotThrow(() => verifyDetailNumbers(page(withholding + tjHistory, confirmedText(kyObserved)), fixture));
  assert.deepEqual(fixture, before);
});

test('reverse mixed state preserves observed TJ copy with leading zeros while withholding KY', () => {
  const fixture = song();
  fixture.karaoke.ky.conflict = true;
  assert.doesNotThrow(() => verifyDetailNumbers(page(tjObserved, withholding), fixture));
});

test('both conflicts may retain historic numbers and official-result source labels outside current presentation', () => {
  const fixture = song();
  fixture.karaoke.tj.conflict = true;
  fixture.karaoke.ky.conflict = true;
  assert.doesNotThrow(() => verifyDetailNumbers(page(withholding + tjHistory, withholding + '<p class="verification-note">합성 정정 사유: 과거 00987 / 공식 확인 이력 2001-01-01.</p>'), fixture));
});

test('unknown and suppressed values have no copy permission but retain history without being declared unlisted', () => {
  const fixture = song();
  fixture.karaoke.tj = unknown();
  fixture.karaoke.ky = { ...unknown(), correction: { reason: '합성 과거 번호 00987 억제' } };
  assert.doesNotThrow(() => verifyDetailNumbers(page(unknownNotice, unknownNotice + '<p class="verification-note">합성 과거 번호 00987 억제, 2001-01-01 검토.</p>'), fixture));
});

test('unknown explanation may contain a count or date without creating a standalone number display', () => {
  const fixture = song();
  fixture.karaoke.tj = unknown();
  assert.doesNotThrow(() => verifyDetailNumbers(page(unknownNotice + '<p>확인 방법은 2단계이며 합성 검토일은 2001-01-01입니다.</p>', kyObserved), fixture));
});

test('normal observed and strictly confirmed providers are accepted independently', () => {
  assert.doesNotThrow(() => verifyDetailNumbers(page(tjObserved, kyObserved), song()));
  const fixture = song();
  fixture.karaoke.tj = { ...fixture.karaoke.tj, status: 'provider-confirmed', evidence: tjEvidence };
  fixture.karaoke.ky = { ...fixture.karaoke.ky, status: 'provider-confirmed', evidence: kyEvidence };
  assert.doesNotThrow(() => verifyDetailNumbers(page(confirmedText(tjObserved), confirmedText(kyObserved)), fixture));
});

test('conflict mutations expose either the raw number, an action, or an unsupported current official claim', async t => {
  const fixture = song();
  fixture.karaoke.tj.conflict = true;
  const cases = [
    ['visible raw number', withholding + '<p>00123</p>'],
    ['numeric button', withholding + '<button>00123</button>'],
    ['button with no numeric text', withholding + '<button>복사</button>'],
    ['valued span action', withholding + '<span data-copy="00123">복사</span>'],
    ['boolean span action', withholding + '<span data-copy>복사</span>'],
    ['empty span action', withholding + '<span data-copy="">복사</span>'],
    ['official confirmation text', withholding + '<p>공식 검색에서 확인</p>'],
    ['official badge text', withholding + '<span>공식 확인</span>'],
    ['action after historic source', withholding + tjHistory + '<span data-copy="00123">복사</span>'],
    ['missing withholding explanation', '<p class="unknown">번호 충돌 · 재확인 필요</p>'],
  ];
  for (const [name, content] of cases) await t.test(name, () => {
    assert.throws(() => verifyDetailNumbers(page(content, kyObserved), fixture), /tj /);
  });
});

test('unknown mutations cannot add current number controls, official claims, or a bare numeric display', async t => {
  const fixture = song();
  fixture.karaoke.tj = unknown();
  const cases = [
    ['copy button', unknownNotice + '<button data-copy="00123">00123</button>'],
    ['boolean action', unknownNotice + '<span data-copy>복사</span>'],
    ['official claim', unknownNotice + '<p>공식 확인</p>'],
    ['bare numeric presentation', unknownNotice + '<p>00123</p>'],
    ['missing non-unlisted explanation', '<p>확인 필요</p>'],
  ];
  for (const [name, content] of cases) await t.test(name, () => {
    assert.throws(() => verifyDetailNumbers(page(content, kyObserved), fixture), /tj /);
  });
});

test('normal copy permission must keep its exact provider string and an actual number button', async t => {
  const cases = [
    ['lost leading zero in copy payload', tjObserved.replace('data-copy="00123"', 'data-copy="123"')],
    ['lost leading zero in visible text', tjObserved.replace('>00123</button>', '>123</button>')],
    ['missing visible number', tjObserved.replace('>00123</button>', '>복사</button>')],
    ['missing copy payload', tjObserved.replace(' data-copy="00123"', '')],
    ['non-button action', tjObserved.replace('<button ', '<span ').replace('</button>', '</span>')],
    ['two copy controls', tjObserved + '<button data-copy="00123">00123</button>'],
    ['unsupported official label', confirmedText(tjObserved)],
  ];
  for (const [name, content] of cases) await t.test(name, () => {
    assert.throws(() => verifyDetailNumbers(page(content, kyObserved), song()), /tj /);
  });
});

test('provider scope cannot be satisfied by the other provider or a third misplaced section', async t => {
  const cases = [
    ['swapped headings', `<div class="detail-numbers">${section('금영', tjObserved)}${section('TJ', kyObserved)}</div>`],
    ['duplicated TJ heading', page(tjObserved, kyObserved).replace('<h2>금영</h2>', '<h2>TJ</h2>')],
    ['swapped provider controls', page(kyObserved, tjObserved)],
    ['missing group', section('TJ', tjObserved) + section('금영', kyObserved)],
    ['extra provider section', page(tjObserved, kyObserved).replace('</div>', section('TJ', tjObserved) + '</div>')],
    ['missing normal value despite unrelated body text', page(tjObserved.replace('00123</button>', '복사</button>'), kyObserved) + '<p>00123</p>'],
  ];
  for (const [name, html] of cases) await t.test(name, () => assert.throws(() => verifyDetailNumbers(html, song())));
});

test('current official labels require this provider evidence and current playlist eligibility', async t => {
  const confirmed = song();
  confirmed.karaoke.tj = { ...confirmed.karaoke.tj, status: 'provider-confirmed', evidence: tjEvidence };
  const cases = [
    ['missing evidence', { karaoke: { ...confirmed.karaoke, tj: { ...confirmed.karaoke.tj, evidence: null } } }],
    ['different numeric URL', { karaoke: { ...confirmed.karaoke, tj: { ...confirmed.karaoke.tj, evidence: { ...tjEvidence, url: tjEvidence.url.replace('00123', '123') } } } }],
    ['wrong provider source', { karaoke: { ...confirmed.karaoke, tj: { ...confirmed.karaoke.tj, evidence: kyEvidence } } }],
    ['missing actual lookup field', { karaoke: { ...confirmed.karaoke, tj: { ...confirmed.karaoke.tj, evidence: { ...tjEvidence, checkedAt: '' } } } }],
    ['archived item', { availability: 'archived' }],
    ['chart-only item', { origin: 'chart-only' }],
  ];
  for (const [name, overrides] of cases) await t.test(name, () => {
    const fixture = { ...confirmed, ...overrides };
    assert.throws(() => verifyDetailNumbers(page(confirmedText(tjObserved), kyObserved), fixture), /tj /);
    assert.doesNotThrow(() => verifyDetailNumbers(page(tjObserved, kyObserved), fixture));
  });
});
