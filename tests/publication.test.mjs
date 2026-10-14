import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTarget, indexableSong, robotsFor } from '../contracts/publication.mjs';

const evidence = { url: 'https://kygabang.com/chart/search_list.php?mode=SongSearch&val=57803', checkedAt: '2026-10-14', title: 'フォニイ', artist: 'ツミキ' };
const provider = (status = 'unknown', conflict = false, proof = null) => ({ status, observedNumber: status === 'unknown' ? null : '57803', conflict, evidence: proof });
const song = (overrides = {}) => ({ id: 'reviewed-fixture', availability: 'current', karaoke: { tj: provider(), ky: provider('provider-confirmed', false, evidence) }, ...overrides });

test('preview always suppresses indexing, including useful routes and confirmed songs', () => {
  for (const pathname of ['/', '/guides/tj-ky-numbers/', '/chart/', '/privacy/', '/songs/reviewed-fixture/'])
    assert.equal(robotsFor('preview', pathname, song()), 'noindex, follow');
  for (const invalid of ['', 'live', null, 'Production']) assert.throws(() => buildTarget(invalid));
});

test('archived, unverified, unknown, conflicting and missing-evidence songs never enter production indexing', () => {
  const candidates = [song({ availability: 'archived' }),
    song({ karaoke: { tj: provider('observed-unverified'), ky: provider() } }),
    song({ karaoke: { tj: provider(), ky: provider() } }),
    song({ karaoke: { tj: provider(), ky: provider('provider-confirmed', true, evidence) } }),
    song({ karaoke: { tj: provider(), ky: provider('provider-confirmed', false, null) } })];
  for (const candidate of candidates) {
    assert.equal(Boolean(indexableSong(candidate)), false);
    assert.equal(robotsFor('production', '/songs/' + candidate.id + '/', candidate), 'noindex, follow');
  }
  assert.equal(robotsFor('production', '/songs/missing/'), 'noindex, follow');
});

test('production exposes reviewed song content while utility and compatibility routes remain noindex', () => {
  assert.equal(robotsFor('production', '/songs/reviewed-fixture/', song()), 'index, follow');
  for (const pathname of ['/search/', '/favorites/', '/song/', '/song.html', '/filter.html', '/404.html', '/missing/'])
    assert.equal(robotsFor('production', pathname, song()), 'noindex, follow');
  assert.equal(robotsFor('production', '/', song()), 'index, follow');
  assert.equal(robotsFor('production', '/guides/tj-ky-numbers/'), 'index, follow');
  assert.equal(robotsFor('production', '/artists/'), 'index, follow');
  assert.equal(robotsFor('preview', '/artists/'), 'noindex, follow');
  assert.equal(robotsFor('production', '/artists/unreviewed-biography/'), 'noindex, follow');
});
