import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { buildLegacyIdentityBaseline, canonicalRepository, parseLegacySongs } from './legacy-identity.mjs';

export const legacyStagingPaths = Object.freeze({
  raw: 'data/jpop-playlist.raw.json',
  tsv: 'data/jpop-playlist-karaoke-tj-ky-merged.txt',
  playlist: 'js/songs.js',
  chart: 'js/chart.js',
});
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const cleanText = value => value.replace(/\s+/g, ' ').trim();
const cleanNumber = value => ['-', '""'].includes(cleanText(value)) ? '' : cleanText(value);
const keyFor = row => JSON.stringify([row.title, row.artist, row.tjNumber, row.kyNumber]);
const fields = ['id', 'title', 'titleKo', 'artist', 'artistKo', 'tjNumber', 'kyNumber', 'tags'];
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

function decode(source) {
  if (typeof source === 'string') return source;
  try { return new TextDecoder('utf-8', { fatal: true }).decode(source); }
  catch { throw new Error('Legacy input must be valid UTF-8'); }
}

// TSV produced by csv.writer: quotes at the start of a field delimit quoted
// text; embedded quotes in unquoted fields (for example filenames) are literal.
// Keep encoded cells solely for an exact match to the old split-based output.
export function parseLegacyTsv(source) {
  const text = decode(source).replace(/^\uFEFF/, '');
  if (!text.trim()) throw new Error('TSV input must be nonempty');
  const records = [];
  let cells = [], rawCells = [], value = '', raw = '', state = 'start';
  let line = 1, startLine = 1, touched = false;
  const cell = () => { cells.push(value); rawCells.push(raw); value = ''; raw = ''; state = 'start'; };
  const record = () => {
    cell();
    if (touched || cells.length > 1 || cells[0] !== '') records.push({ cells, rawCells, line: startLine, endLine: line });
    cells = []; rawCells = []; touched = false;
  };
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    const newline = c === '\n' || c === '\r';
    const crlf = c === '\r' && text[i + 1] === '\n';
    if (state === 'quoted') {
      raw += c;
      if (c === '"') {
        if (text[i + 1] === '"') { value += '"'; raw += '"'; i += 1; }
        else state = 'closed';
      } else if (newline) {
        if (crlf) { raw += '\n'; i += 1; }
        value += '\n'; line += 1;
      } else value += c;
      continue;
    }
    if (c === '\t') { touched = true; cell(); continue; }
    if (newline) {
      record();
      if (crlf) i += 1;
      line += 1; startLine = line;
      continue;
    }
    if (state === 'closed') throw new Error('Unexpected text after a quoted TSV cell at line ' + line);
    touched = true; raw += c;
    if (state === 'start' && c === '"') state = 'quoted';
    else { state = 'unquoted'; value += c; }
  }
  if (state === 'quoted') throw new Error('Unterminated quoted TSV cell at line ' + startLine);
  if (touched || cells.length || value || raw) record();
  if (records.length < 2) throw new Error('TSV requires a header and nonempty rows');
  const header = records.shift().cells;
  if (new Set(header).size !== header.length) throw new Error('Duplicate TSV column');
  for (const field of ['title', 'titleKo', 'artist', 'artistKo', 'TJ', 'KY', 'tags'])
    if (!header.includes(field)) throw new Error('Missing TSV column: ' + field);
  for (const record of records)
    if (record.cells.length !== header.length) throw new Error('TSV column count mismatch at line ' + record.line);
  return { header, rows: records };
}

function projectRow(row, context) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error('Invalid row: ' + context);
  for (const field of ['id', 'title', 'artist'])
    if (typeof row[field] !== 'string' || !row[field].trim()) throw new Error('Missing ' + field + ': ' + context);
  for (const field of ['titleKo', 'artistKo'])
    if (typeof row[field] !== 'string') throw new Error('Invalid ' + field + ': ' + context);
  for (const field of ['tjNumber', 'kyNumber'])
    if (typeof row[field] !== 'string' || (row[field] !== '' && (!/^[0-9]{1,10}$/.test(row[field]) || /^0+$/.test(row[field]))))
      throw new Error('Invalid observed number: ' + context);
  if (!Array.isArray(row.tags) || row.tags.some(tag => typeof tag !== 'string' || !tag.trim())) throw new Error('Invalid tags: ' + context);
  return Object.fromEntries(fields.map(field => [field, row[field]]));
}

function parseJsRows(bytes, variable) {
  // First enforce the established JSON-only grammar. Never evaluate source JS.
  parseLegacySongs(bytes, variable);
  const literal = new RegExp('const\\s+' + variable + '\\s*=\\s*(\\[[\\s\\S]*\\])\\s*;\\s*$').exec(decode(bytes))?.[1];
  return JSON.parse(literal).map((row, index) => projectRow(row, variable + ':' + index));
}

function requireUnique(rows, context) {
  const ids = new Set();
  for (const row of rows) {
    if (ids.has(row.id)) throw new Error('Duplicate ID: ' + context);
    ids.add(row.id);
  }
}

export function buildLegacyStaging({ repository, revision, baseline, inputs }) {
  const repo = canonicalRepository(repository);
  if (!/^[a-f0-9]{40}$/.test(revision || '')) throw new Error('A full lowercase source commit SHA is required');
  if (!baseline || baseline.baselineVersion !== 1 || baseline.repository !== repo || !Array.isArray(baseline.sources) || !baseline.sources.length)
    throw new Error('A matching legacy identity baseline is required');
  if (!Array.isArray(inputs) || !inputs.length) throw new Error('Exact source inputs are required');
  const inputMap = new Map();
  for (const input of inputs) {
    if (!/^[a-f0-9]{40}$/.test(input.revision || '') || !Object.values(legacyStagingPaths).includes(input.path) || !Buffer.isBuffer(input.bytes))
      throw new Error('Invalid staging source input');
    const key = input.revision + ':' + input.path;
    if (inputMap.has(key)) throw new Error('Duplicate staging source');
    inputMap.set(key, input);
  }
  const get = (sha, path) => {
    const input = inputMap.get(sha + ':' + path);
    if (!input) throw new Error('Missing source: ' + path);
    return input;
  };
  const baselineInputs = baseline.sources.map(source => get(source.revision, source.path));
  const reconstructed = buildLegacyIdentityBaseline(repo, baselineInputs);
  if (!isDeepStrictEqual(reconstructed, baseline)) throw new Error('Baseline does not match the exact source objects');
  if (!baseline.revisions.some(item => item.revision === revision)) throw new Error('Selected source revision must be covered by the baseline');
  const expectedKeys = new Set([...baselineInputs.map(input => input.revision + ':' + input.path),
    revision + ':' + legacyStagingPaths.raw, revision + ':' + legacyStagingPaths.tsv]);
  for (const key of expectedKeys) if (!inputMap.has(key)) throw new Error('Missing source: ' + key.split(':').slice(1).join(':'));
  if (inputMap.size !== expectedKeys.size || [...inputMap.keys()].some(key => !expectedKeys.has(key))) throw new Error('Unexpected staging source');

  const rawInput = get(revision, legacyStagingPaths.raw);
  let raw;
  try { raw = JSON.parse(decode(rawInput.bytes)); } catch { throw new Error('Raw catalog must be valid UTF-8 JSON'); }
  if (!raw || !Array.isArray(raw.songs) || !raw.songs.length || raw.parsedRows !== raw.songs.length || raw.uniqueSongs !== raw.songs.length)
    throw new Error('Raw catalog is empty, partial, or has inconsistent row counts');
  const rawRows = raw.songs.map((row, index) => projectRow(row, 'raw:' + index));
  requireUnique(rawRows, 'raw catalog');
  const jsRows = new Map();
  for (const input of baselineInputs)
    jsRows.set(input.revision + ':' + input.path, parseJsRows(input.bytes, input.path === legacyStagingPaths.playlist ? 'songs' : 'tjJpopChart'));
  const playlistRows = jsRows.get(revision + ':' + legacyStagingPaths.playlist);
  const chartRows = jsRows.get(revision + ':' + legacyStagingPaths.chart);
  if (!isDeepStrictEqual(rawRows, playlistRows)) throw new Error('Raw catalog must exactly cover the generated playlist and its metadata');

  const tsvInput = get(revision, legacyStagingPaths.tsv);
  const tsv = parseLegacyTsv(tsvInput.bytes);
  if (tsv.rows.length !== rawRows.length) throw new Error('TSV must cover every raw playlist row exactly once');
  const rawByTuple = new Map();
  for (const [index, row] of rawRows.entries()) {
    const key = keyFor(row);
    if (rawByTuple.has(key)) throw new Error('Ambiguous raw identity tuple');
    rawByTuple.set(key, { row, index });
  }
  const mappings = new Map();
  for (const [index, record] of tsv.rows.entries()) {
    const column = (name, encoded = false) => (encoded ? record.rawCells : record.cells)[tsv.header.indexOf(name)];
    const candidates = [false, true].map(encoded => rawByTuple.get(keyFor({
      title: cleanText(column('title', encoded)), artist: cleanText(column('artist', encoded)) || '아티스트 미등록',
      tjNumber: cleanNumber(column('TJ', encoded)), kyNumber: cleanNumber(column('KY', encoded)),
    }))).filter(Boolean);
    const ids = new Set(candidates.map(candidate => candidate.row.id));
    if (ids.size !== 1) throw new Error('Missing or ambiguous exact TSV identity at line ' + record.line);
    const match = candidates[0];
    if (mappings.has(match.row.id)) throw new Error('Duplicate TSV mapping at line ' + record.line);
    for (const name of ['titleKo', 'artistKo'])
      if (match.row[name] !== cleanText(column(name)) && match.row[name] !== cleanText(column(name, true)))
        throw new Error('TSV translation mismatch at line ' + record.line);
    const title = cleanText(column('title'));
    if (!title || cleanText(column('artist')) !== match.row.artist) throw new Error('Unsupported TSV identity correction at line ' + record.line);
    mappings.set(match.row.id, { index, record, title });
  }
  if (mappings.size !== rawRows.length) throw new Error('Incomplete TSV mapping');

  const sources = [...inputMap.values()].sort((a, b) => compare(a.revision + ':' + a.path, b.revision + ':' + b.path)).map(input => ({
    revision: input.revision, path: input.path, sha256: sha256(input.bytes),
    rows: input.path === legacyStagingPaths.raw ? rawRows.length : input.path === legacyStagingPaths.tsv ? tsv.rows.length : jsRows.get(input.revision + ':' + input.path).length,
  }));
  const sourceIndex = (sha, path) => sources.findIndex(source => source.revision === sha && source.path === path);
  const playlistById = new Map(rawRows.map((row, index) => [row.id, { row, index }]));
  const chartById = new Map(chartRows.map((row, index) => [row.id, { row, index }]));
  const observed = number => ({ status: number ? 'observed-unverified' : 'unknown', observedNumber: number || null, evidence: null });
  let titleCorrections = 0;
  const songs = baseline.identities.map(identity => {
    const playlist = playlistById.get(identity.id);
    const current = playlist || chartById.get(identity.id);
    let row = current?.row;
    if (!row) {
      if (identity.observations.length !== 1) throw new Error('Ambiguous archived legacy identity: ' + identity.id);
      const ref = identity.observations[0].refs[0];
      const source = baseline.sources[ref.source];
      row = jsRows.get(source.revision + ':' + source.path)[ref.index];
    }
    const refs = identity.observations.flatMap(observation => observation.refs.map(ref => ({
      source: sourceIndex(baseline.sources[ref.source].revision, baseline.sources[ref.source].path), index: ref.index,
    })));
    let titleOriginal = row.title, titleCorrection;
    if (playlist) {
      const mapping = mappings.get(row.id);
      refs.push({ source: sourceIndex(revision, legacyStagingPaths.raw), index: playlist.index });
      refs.push({ source: sourceIndex(revision, legacyStagingPaths.tsv), index: mapping.index, line: mapping.record.line, endLine: mapping.record.endLine });
      titleOriginal = mapping.title;
      if (titleOriginal !== row.title) {
        titleCorrections += 1;
        titleCorrection = { kind: 'tsv-quoting', original: row.title, corrected: titleOriginal };
      }
    }
    return {
      id: identity.id, availability: current ? 'current' : 'archived', origin: playlist ? 'playlist' : 'chart-only',
      titleOriginal, titleKo: row.titleKo, artistOriginal: row.artist, artistKo: row.artistKo, tags: row.tags,
      legacy: { title: row.title, artist: row.artist },
      karaoke: { tj: observed(row.tjNumber), ky: observed(row.kyNumber) }, refs,
      ...(titleCorrection ? { titleCorrection } : {}),
    };
  });
  if (songs.length !== baseline.summary.totalIds || new Set(songs.map(song => song.id)).size !== baseline.summary.totalIds)
    throw new Error('Staging must preserve every baseline ID exactly once');
  return {
    stagingVersion: 1, purpose: 'legacy-catalog-staging', repository: repo, revision,
    mappingStrategy: 'preserve-each-legacy-id', sources,
    summary: {
      totalIds: songs.length, playlistIds: rawRows.length,
      currentChartOnlyIds: songs.filter(song => song.origin === 'chart-only' && song.availability === 'current').length,
      archivedChartOnlyIds: songs.filter(song => song.availability === 'archived').length,
      titleCorrections, unresolvedAliasGroups: baseline.unresolvedAliases.length,
    },
    songs,
    unresolvedAliases: baseline.unresolvedAliases,
  };
}
