import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { buildLegacyIdentityBaseline, canonicalRepository, parseLegacySongs } from '../contracts/legacy-identity.mjs';

const revisionA = 'a'.repeat(40);
const revisionB = 'b'.repeat(40);
const repository = 'https://github.com/example/legacy-fixture.git';
const song = (id, number = '00042') => ({ id, title: 'Fixture Title', artist: 'Fixture Artist', tjNumber: number, kyNumber: '' });
const source = (revision, path, rows) => ({
  revision,
  path,
  bytes: Buffer.from('/* synthetic fixture only */\nconst ' + (path === 'js/songs.js' ? 'songs' : 'tjJpopChart') + ' = ' + JSON.stringify(rows) + ';\n'),
});
const sources = () => [
  source(revisionA, 'js/songs.js', [song('playlist-fixture')]),
  source(revisionA, 'js/chart.js', [song('playlist-fixture'), song('chart-before', '00200')]),
  source(revisionB, 'js/songs.js', [song('playlist-fixture')]),
  source(revisionB, 'js/chart.js', [song('playlist-fixture'), song('chart-after', '00200')]),
];

test('parses only JSON arrays and preserves identity strings including leading zeros', () => {
  const row = song('fixture-exact');
  row.title = 'Text with ]; and /* no execution */';
  row.artist = ' 『原表記』 ';
  const bytes = source(revisionA, 'js/songs.js', [row]).bytes;
  assert.deepEqual(parseLegacySongs(bytes, 'songs'), [row]);
});

test('does not include lyrics, images, rank, supplied evidence, or extra fields in the baseline', () => {
  const input = sources();
  input[0] = source(revisionA, 'js/songs.js', [{ ...song('playlist-fixture'),
    lyricsText: 'DO NOT COPY THIS LYRIC', albumImage: 'https://example.com/private-image', rank: 99,
    sourceUrl: 'https://example.com/claim', checkedAt: '2026-10-13', extra: 'PRIVATE EXTRA',
  }]);
  const baseline = buildLegacyIdentityBaseline(repository, input);
  const serialized = JSON.stringify(baseline);
  for (const excluded of ['lyricsText', 'DO NOT COPY', 'albumImage', 'private-image', 'sourceUrl', 'checkedAt', 'PRIVATE EXTRA'])
    assert.ok(!serialized.includes(excluded), excluded);
  assert.equal(baseline.purpose, 'legacy-identity-audit');
  assert.equal(baseline.schemaVersion, undefined);
});

test('records exact file hashes and refs with a deterministic union across revisions', () => {
  const input = sources();
  const baseline = buildLegacyIdentityBaseline(repository, input);
  assert.deepEqual(baseline, buildLegacyIdentityBaseline(repository, [...input].reverse()));
  assert.equal(baseline.repository, 'https://github.com/example/legacy-fixture');
  assert.equal(baseline.mappingStrategy, 'preserve-each-legacy-id');
  assert.deepEqual(baseline.summary, { totalIds: 3, playlistIds: 1, chartOnlyIds: 2, unresolvedAliasGroups: 1 });
  assert.deepEqual(baseline.revisions.map(row => row.mergedIds), [2, 2]);
  for (const file of baseline.sources) {
    const original = input.find(row => row.revision === file.revision && row.path === file.path);
    assert.equal(file.sha256, createHash('sha256').update(original.bytes).digest('hex'));
  }
  const playlist = baseline.identities.find(row => row.id === 'playlist-fixture');
  assert.equal(playlist.observations.length, 1);
  assert.equal(playlist.observations[0].refs.length, 4);
  assert.equal(playlist.observations[0].tjNumber, '00042');
  for (const ref of playlist.observations[0].refs) {
    const file = baseline.sources[ref.source];
    const original = input.find(row => row.revision === file.revision && row.path === file.path);
    assert.equal(parseLegacySongs(original.bytes, file.path === 'js/songs.js' ? 'songs' : 'tjJpopChart')[ref.index].id, playlist.id);
  }
});

test('shared provider numbers remain unresolved candidates instead of automatic aliases', () => {
  const baseline = buildLegacyIdentityBaseline(repository, sources());
  assert.deepEqual(baseline.unresolvedAliases, [{ provider: 'tj', observedNumber: '00200', ids: ['chart-after', 'chart-before'], resolution: 'unresolved' }]);
  assert.ok(baseline.identities.some(row => row.id === 'chart-before'));
  assert.ok(baseline.identities.some(row => row.id === 'chart-after'));
});

test('provider collisions within one revision are retained for identity review', () => {
  const input = sources();
  input[0] = source(revisionA, 'js/songs.js', [song('playlist-fixture'), song('other-fixture')]);
  const baseline = buildLegacyIdentityBaseline(repository, input);
  assert.equal(baseline.summary.totalIds, 4);
  assert.ok(baseline.unresolvedAliases.some(row => row.ids.includes('playlist-fixture') && row.ids.includes('other-fixture')));
});

test('changed identity fields under the same ID are preserved as separate observations', () => {
  const input = sources();
  input[2] = source(revisionB, 'js/songs.js', [{ ...song('playlist-fixture'), artist: 'Changed Fixture Artist', kyNumber: '00088' }]);
  const baseline = buildLegacyIdentityBaseline(repository, input);
  const playlist = baseline.identities.find(row => row.id === 'playlist-fixture');
  assert.equal(playlist.observations.length, 2);
  assert.ok(playlist.observations.some(row => row.artist === 'Fixture Artist' && row.kyNumber === ''));
  assert.ok(playlist.observations.some(row => row.artist === 'Changed Fixture Artist' && row.kyNumber === '00088'));
});

test('duplicate IDs in one source file are rejected rather than overwritten', () => {
  const input = sources();
  input[0] = source(revisionA, 'js/songs.js', [song('duplicate'), { ...song('duplicate'), title: 'Different Title' }]);
  assert.throws(() => buildLegacyIdentityBaseline(repository, input), /Duplicate legacy ID/);
});

test('duplicate source files and missing revision pairs are rejected', () => {
  const input = sources();
  assert.throws(() => buildLegacyIdentityBaseline(repository, [...input, input[0]]), /Duplicate legacy source/);
  assert.throws(() => buildLegacyIdentityBaseline(repository, input.slice(0, 3)), /requires both/);
});

test('requires immutable full SHAs, known source paths, and exact bytes', () => {
  for (const patch of [{ revision: 'main' }, { revision: 'a'.repeat(7) }, { path: 'js/app.js' }, { bytes: 'const songs = [];' }]) {
    const input = sources();
    input[0] = { ...input[0], ...patch };
    assert.throws(() => buildLegacyIdentityBaseline(repository, input));
  }
});

test('malformed or executable JavaScript is rejected without evaluating input', () => {
  const marker = '__legacyIdentityMustNeverExecute';
  for (const text of [
    'const songs = [{ id: "fixture" }];',
    'const songs = [globalThis.' + marker + ' = true];',
    'const songs = []; globalThis.' + marker + ' = true;',
    'globalThis.' + marker + ' = true; const songs = [];',
    'const other = [];',
    'const songs = [',
  ]) assert.throws(() => parseLegacySongs(text, 'songs'));
  assert.equal(globalThis[marker], undefined);
});

test('rejects empty arrays, damaged UTF-8, invalid fields, and numeric provider numbers', () => {
  assert.throws(() => parseLegacySongs('const songs = [];', 'songs'), /nonempty/);
  assert.throws(() => parseLegacySongs(Buffer.from([0xff]), 'songs'), /UTF-8/);
  for (const row of [null, { ...song('fixture'), id: '' }, { ...song('fixture'), title: '' }, { ...song('fixture'), artist: null }, { ...song('fixture'), tjNumber: 42 }, { ...song('fixture'), kyNumber: 'not-a-number' }])
    assert.throws(() => parseLegacySongs(source(revisionA, 'js/songs.js', [row]).bytes, 'songs'));
});

test('canonicalizes credential-free origins and refuses to save remote credentials', () => {
  assert.equal(canonicalRepository('git@github.com:example/legacy-fixture.git'), 'https://github.com/example/legacy-fixture');
  assert.equal(canonicalRepository(repository), 'https://github.com/example/legacy-fixture');
  for (const origin of ['https://user:secret@github.com/example/fixture.git', 'https://github.com/example/fixture?token=secret', 'http://github.com/example/fixture', 'https://github.com/example/fixture/extra'])
    assert.throws(() => canonicalRepository(origin));
});
