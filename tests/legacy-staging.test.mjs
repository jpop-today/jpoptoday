import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { buildLegacyIdentityBaseline } from '../contracts/legacy-identity.mjs';
import { buildLegacyStaging, legacyStagingPaths as paths, parseLegacyTsv } from '../contracts/legacy-staging.mjs';

const repository = 'https://github.com/example/legacy';
const revision = 'a'.repeat(40), previous = 'b'.repeat(40);
const header = 'title\ttitleKo\tartist\tartistKo\tTJ\tKY\ttags\tsource_title\tsource_url\tlyricsText';
const song = (id, title, tjNumber, kyNumber = '') => ({
  id, title, titleKo: '', artist: 'Artist', artistKo: '', tjNumber, kyNumber, tags: ['TJ'],
  lyrics: ['FORBIDDEN BODY'], lyricsText: 'lyrics/file.txt', albumImage: 'https://example.com/image.jpg',
  sourceTitle: 'FORBIDDEN SOURCE', sourceUrl: 'https://example.com/source', advertising: 'FORBIDDEN ADS',
});
const bytes = value => Buffer.from(value);
const js = (rows, variable) => bytes('/* generated */\nconst ' + variable + ' = ' + JSON.stringify(rows) + ';\n');

function fixture() {
  const playlist = [song('stable-a', 'Normal song', '000123'), song('stable-b', '"Song ""quoted"""', '', '00456')];
  const currentChart = [playlist[0], song('chart-current', 'Current chart', '00789')];
  const oldChart = [playlist[0], song('chart-archived', 'Old chart', '00999')];
  const inputs = [
    { revision, path: paths.playlist, bytes: js(playlist, 'songs') },
    { revision, path: paths.chart, bytes: js(currentChart, 'tjJpopChart') },
    { revision: previous, path: paths.playlist, bytes: js(playlist, 'songs') },
    { revision: previous, path: paths.chart, bytes: js(oldChart, 'tjJpopChart') },
  ];
  const baseline = buildLegacyIdentityBaseline(repository, inputs);
  inputs.push({ revision, path: paths.raw, bytes: bytes(JSON.stringify({ parsedRows: playlist.length, uniqueSongs: playlist.length, songs: playlist })) });
  inputs.push({ revision, path: paths.tsv, bytes: bytes(header + '\nNormal song\t\tArtist\t\t000123\t\tTJ\tFORBIDDEN SOURCE\thttps://example.com/source\tFORBIDDEN BODY\n"Song ""quoted"""\t\tArtist\t\t\t00456\tTJ\t\t\tlyrics/file.txt\n') });
  return { repository, revision, baseline, inputs };
}
const imported = () => buildLegacyStaging(fixture());
const replace = (input, path, value) => { input.inputs.find(source => source.revision === revision && source.path === path).bytes = bytes(value); return input; };

test('staging keeps immutable IDs, leading zero numbers, and archived-only identities without treating observations as evidence', () => {
  const output = imported();
  assert.deepEqual(output.summary, { totalIds: 4, playlistIds: 2, currentChartOnlyIds: 1, archivedChartOnlyIds: 1, titleCorrections: 1, unresolvedAliasGroups: 0 });
  assert.deepEqual(output.songs.map(row => row.id), ['chart-archived', 'chart-current', 'stable-a', 'stable-b']);
  const a = output.songs.find(row => row.id === 'stable-a');
  assert.deepEqual(a.karaoke.tj, { status: 'observed-unverified', observedNumber: '000123', evidence: null });
  assert.deepEqual(a.karaoke.ky, { status: 'unknown', observedNumber: null, evidence: null });
  assert.equal(output.songs[0].availability, 'archived');
  assert.equal(output.songs[1].availability, 'current');
  assert.equal(output.songs[1].origin, 'chart-only');
});

test('csv quoting is decoded for display and the original malformed title remains tied to the same stable ID', () => {
  const row = imported().songs.find(row => row.id === 'stable-b');
  assert.equal(row.titleOriginal, 'Song "quoted"');
  assert.equal(row.legacy.title, '"Song ""quoted"""');
  assert.deepEqual(row.titleCorrection, { kind: 'tsv-quoting', original: '"Song ""quoted"""', corrected: 'Song "quoted"' });
  assert.equal(row.id, 'stable-b');
  assert.equal(row.karaoke.ky.observedNumber, '00456');
});

test('whitelist excludes lyrics, lyrics references, images, advertising, source URLs and invented verification dates', () => {
  const output = imported();
  const serialized = JSON.stringify(output);
  for (const forbidden of ['lyrics', 'FORBIDDEN', 'albumImage', 'advertising', 'sourceTitle', 'sourceUrl', 'checkedAt'])
    assert.equal(serialized.includes(forbidden), false, forbidden);
  assert.deepEqual(Object.keys(output.songs.find(row => row.id === 'stable-a')), ['id', 'availability', 'origin', 'titleOriginal', 'titleKo', 'artistOriginal', 'artistKo', 'tags', 'legacy', 'karaoke', 'refs']);
});

test('exact source hashes, revision/path and both indexed and physical TSV row references are reproducible', () => {
  const input = fixture();
  const one = buildLegacyStaging(input);
  const two = buildLegacyStaging({ ...input, inputs: [...input.inputs].reverse() });
  assert.deepEqual(one, two);
  for (const source of one.sources) {
    assert.match(source.revision, /^[a-f0-9]{40}$/);
    assert.match(source.sha256, /^[a-f0-9]{64}$/);
    assert.ok(source.rows > 0);
  }
  const record = one.songs.find(row => row.id === 'stable-b');
  const tsvRef = record.refs.find(ref => one.sources[ref.source].path === paths.tsv);
  assert.deepEqual(tsvRef, { source: one.sources.findIndex(source => source.path === paths.tsv), index: 1, line: 3, endLine: 3 });
});

test('TSV parser handles BOM, CRLF, quoted tabs, quoted newlines, doubled quotes and trailing empty fields', () => {
  const input = '\uFEFFtitle\ttitleKo\tartist\tartistKo\tTJ\tKY\ttags\n"A\tB\r\nC ""D"""\t\tArtist\t\t00123\t\t\n';
  const result = parseLegacyTsv(bytes(input));
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].cells[0], 'A\tB\nC "D"');
  assert.equal(result.rows[0].rawCells[0], '"A\tB\r\nC ""D"""');
  assert.equal(result.rows[0].cells.at(-1), '');
  assert.deepEqual([result.rows[0].line, result.rows[0].endLine], [2, 3]);
});

test('TSV parser allows literal quotes in unquoted cells and accepts a final row without newline', () => {
  const result = parseLegacyTsv('title\ttitleKo\tartist\tartistKo\tTJ\tKY\ttags\nA "quoted" title\t\tArtist\t\t1\t\t');
  assert.equal(result.rows[0].cells[0], 'A "quoted" title');
});

test('malformed, empty and incomplete TSV input cannot be silently accepted', () => {
  for (const input of ['', '\n\n', header + '\n', header + '\n"unterminated', header + '\n"closed"oops\t\tA\t\t1\t\t\t\t\t', header + '\nA\tB', header.replace('titleKo', 'title') + '\nA\t\tArtist\t\t1\t\t\t\t\t'])
    assert.throws(() => parseLegacyTsv(input));
  assert.throws(() => parseLegacyTsv(Buffer.from([0xc3, 0x28])), /UTF-8/);
});

test('full coverage rejects missing raw rows even if the partial raw counts are internally consistent', () => {
  const input = fixture();
  const raw = JSON.parse(input.inputs.find(source => source.path === paths.raw).bytes);
  raw.songs.pop(); raw.parsedRows = 1; raw.uniqueSongs = 1;
  assert.throws(() => buildLegacyStaging(replace(input, paths.raw, JSON.stringify(raw))), /exactly cover/);
});

test('full coverage rejects missing TSV rows and does not match a different title by provider number alone', () => {
  const input = fixture();
  const source = input.inputs.find(source => source.path === paths.tsv).bytes.toString();
  assert.throws(() => buildLegacyStaging(replace(fixture(), paths.tsv, source.split('\n').slice(0, 2).join('\n'))), /cover every/);
  assert.throws(() => buildLegacyStaging(replace(fixture(), paths.tsv, source.replace('Normal song', 'Different song'))), /exact TSV identity/);
  assert.throws(() => buildLegacyStaging(replace(fixture(), paths.tsv, source.replace('Normal song\t\tArtist', 'Normal song\t\tOther Artist'))), /exact TSV identity/);
});

test('duplicate TSV identity and ambiguous raw identity tuples fail rather than deduplicating or merging', () => {
  const input = fixture();
  const tsv = input.inputs.find(source => source.path === paths.tsv).bytes.toString().split('\n');
  tsv[2] = tsv[1];
  assert.throws(() => buildLegacyStaging(replace(input, paths.tsv, tsv.join('\n'))), /Duplicate TSV/);
  const ambiguous = fixture();
  const playlist = [song('id-one', 'Same title', '00123'), song('id-two', 'Same title', '00123')];
  for (const source of ambiguous.inputs) {
    if (source.path === paths.playlist) source.bytes = js(playlist, 'songs');
    if (source.path === paths.raw) source.bytes = bytes(JSON.stringify({ parsedRows: 2, uniqueSongs: 2, songs: playlist }));
  }
  ambiguous.baseline = buildLegacyIdentityBaseline(repository, ambiguous.inputs.filter(source => [paths.playlist, paths.chart].includes(source.path)));
  assert.throws(() => buildLegacyStaging(ambiguous), /Ambiguous raw/);
});

test('baseline and source tampering, invalid number types, and metadata mismatch cannot pass staging', () => {
  const tampered = fixture(); tampered.baseline.summary.totalIds += 1;
  assert.throws(() => buildLegacyStaging(tampered), /Baseline does not match/);
  const changed = fixture(); changed.inputs.find(source => source.path === paths.chart).bytes = js([song('another-id', 'Other', '88')], 'tjJpopChart');
  assert.throws(() => buildLegacyStaging(changed), /Baseline does not match/);
  for (const number of [123, null, '000', '1x']) {
    const input = fixture(); const raw = JSON.parse(input.inputs.find(source => source.path === paths.raw).bytes);
    raw.songs[0].tjNumber = number;
    assert.throws(() => buildLegacyStaging(replace(input, paths.raw, JSON.stringify(raw))), /observed number/);
  }
  const input = fixture(); const raw = JSON.parse(input.inputs.find(source => source.path === paths.raw).bytes);
  raw.songs[0].titleKo = 'Changed translation';
  assert.throws(() => buildLegacyStaging(replace(input, paths.raw, JSON.stringify(raw))), /exactly cover/);
});

test('missing sources, mutable revisions and executable JS input are rejected without source execution', () => {
  const input = fixture(); input.inputs.pop();
  assert.throws(() => buildLegacyStaging(input), /Missing source/);
  assert.throws(() => buildLegacyStaging({ ...fixture(), revision: 'main' }), /full lowercase/);
  const executable = fixture(); executable.inputs.find(source => source.path === paths.playlist).bytes = bytes('const songs = [{id:process.exit(0)}];');
  assert.throws(() => buildLegacyStaging(executable), /JSON data/);
});

test('checked-in actual staging covers all 3317 audited IDs and records the three quoting corrections and four archives', async () => {
  const staging = JSON.parse(await readFile(new URL('../data/staging/legacy-catalog.json', import.meta.url)));
  const baseline = JSON.parse(await readFile(new URL('../data/legacy-identity-baseline.json', import.meta.url)));
  assert.deepEqual(staging.songs.map(song => song.id), baseline.identities.map(song => song.id));
  assert.deepEqual(staging.summary, { totalIds: 3317, playlistIds: 3299, currentChartOnlyIds: 14, archivedChartOnlyIds: 4, titleCorrections: 3, unresolvedAliasGroups: 11 });
  assert.equal(staging.revision, '6dbe5a65d1bd729c09393f746f715f4363089a43');
  const corrected = staging.songs.filter(song => song.titleCorrection);
  assert.deepEqual(corrected.map(song => song.titleOriginal).sort(), ['Don\'t say "lazy"', 'Running In The "90\'s"', 'under "Mebius"']);
  for (const row of staging.songs) {
    for (const provider of ['tj', 'ky']) {
      assert.equal(row.karaoke[provider].evidence, null);
      if (row.karaoke[provider].status === 'observed-unverified') assert.match(row.karaoke[provider].observedNumber, /^[0-9]{1,10}$/);
    }
  }
  assert.equal(staging.songs.filter(row => row.availability === 'archived').length, 4);
});
