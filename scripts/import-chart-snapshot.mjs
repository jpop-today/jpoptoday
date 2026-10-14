import * as filesystem from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const source = 'TJ Media TOP100 JPOP';
const sourceUrl = 'https://www.tjmedia.com/chart/top100';
const apiUrl = 'https://www.tjmedia.com/legacy/api/topAndHot100';
const fullSha = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string' && Boolean(value.trim()) && !/[\u0000-\u001f\u007f]/.test(value);

export class ChartSnapshotError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ChartSnapshotError';
    this.code = code;
  }
}
const fail = (code, message) => { throw new ChartSnapshotError(code, message); };

function date(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
      !Number.isFinite(Date.parse(value + 'T00:00:00Z')) ||
      new Date(value + 'T00:00:00Z').toISOString().slice(0, 10) !== value)
    fail('INVALID_METADATA', 'Chart dates must be real YYYY-MM-DD dates');
  return value;
}

function metadata(input, raw, now) {
  if (!object(input) || input.source !== source || input.sourceUrl !== sourceUrl)
    fail('INVALID_METADATA', 'A matching official TJ chart source is required');
  if (typeof input.fetchedAt !== 'string' || !Number.isFinite(Date.parse(input.fetchedAt)) ||
      new Date(input.fetchedAt).toISOString() !== input.fetchedAt)
    fail('INVALID_METADATA', 'The original fetchedAt must be a valid UTC ISO timestamp');
  const validationTime = new Date(now).getTime();
  if (!Number.isFinite(validationTime) || Date.parse(input.fetchedAt) > validationTime)
    fail('INVALID_METADATA', 'A future fetch or invalid validation time cannot establish a collected snapshot');
  date(input.startDate); date(input.endDate);
  const fetchedDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(input.fetchedAt));
  if (input.startDate > input.endDate || input.endDate > fetchedDate || typeof input.periodVerified !== 'boolean')
    fail('INVALID_METADATA', 'Chart period and fetchedAt are inconsistent');
  if (raw) {
    const payload = input.requestPayload;
    if (input.apiUrl !== apiUrl || !object(payload) || payload.chartType !== 'TOP' || payload.strType !== '3')
      fail('INVALID_METADATA', 'A matching TJ JPOP request is required');
    const pairs = [['startDate', 'endDate'], ['searchStartDate', 'searchEndDate'], ['startDt', 'endDt']];
    let dated = false;
    for (const [start, end] of pairs) {
      if (Object.hasOwn(payload, start) || Object.hasOwn(payload, end)) {
        if (payload[start] !== input.startDate || payload[end] !== input.endDate)
          fail('INVALID_METADATA', 'Requested dates disagree with chart metadata');
        dated = true;
      }
    }
    if (input.periodVerified !== dated)
      fail('INVALID_METADATA', 'periodVerified must reflect the recorded date request');
  } else if (!fullSha(input.legacyRevision)) {
    fail('INVALID_METADATA', 'Previous chart source revision must be a full SHA');
  }
  return { source, sourceUrl, fetchedAt: input.fetchedAt, startDate: input.startDate,
    endDate: input.endDate, periodVerified: input.periodVerified };
}

function rows(input) {
  if (!Array.isArray(input.songs) || input.songs.length !== 100)
    fail('INVALID_ROWS', 'A complete 100-song chart is required');
  const ids = new Set();
  return input.songs.map((row, index) => {
    if (!object(row) || !['id', 'title', 'artist'].every(key => text(row[key])) ||
        typeof row.tjNumber !== 'string' || !/^[0-9]{1,10}$/.test(row.tjNumber) || /^0+$/.test(row.tjNumber) ||
        !Number.isInteger(row.rank) || row.rank !== index + 1 || ids.has(row.id))
      fail('INVALID_ROWS', 'Chart IDs, identity fields, number strings or rank order are invalid');
    ids.add(row.id);
    return { id: row.id, title: row.title, artist: row.artist, tjNumber: row.tjNumber, rank: row.rank };
  });
}

function parseJson(bytes) {
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)); }
  catch { fail('INVALID_JSON', 'Chart inputs must be valid UTF-8 JSON'); }
}

const committedBaseline = parseJson(await filesystem.readFile(new URL('../data/legacy-identity-baseline.json', import.meta.url)));

function chartIdentities(staging, baseline) {
  if (!object(staging) || staging.stagingVersion !== 1 || staging.purpose !== 'legacy-catalog-staging' ||
      !fullSha(staging.revision) || !Array.isArray(staging.sources) || !staging.sources.every(object) || !Array.isArray(staging.songs) ||
      !object(baseline) || baseline.baselineVersion !== 1 || baseline.repository !== staging.repository ||
      !Array.isArray(baseline.sources) || !baseline.sources.every(object) || !Array.isArray(baseline.identities) ||
      !baseline.identities.every(row => object(row) && text(row.id) && Array.isArray(row.observations)))
    fail('INVALID_IDENTITY_BASELINE', 'A matching staging and identity baseline is required');
  const sourceIndexes = staging.sources.flatMap((item, index) =>
    item.path === 'js/chart.js' && item.revision === staging.revision ? [index] : []);
  const baselineIndexes = baseline.sources.flatMap((item, index) =>
    item.path === 'js/chart.js' && item.revision === staging.revision ? [index] : []);
  if (sourceIndexes.length !== 1 || baselineIndexes.length !== 1)
    fail('INVALID_IDENTITY_BASELINE', 'Exactly one original chart source is required');
  const chartSource = sourceIndexes[0], baselineSource = baselineIndexes[0];
  const sourceRecord = staging.sources[chartSource], baselineRecord = baseline.sources[baselineSource];
  if (sourceRecord.rows !== 100 || baselineRecord.rows !== 100 ||
      !/^[a-f0-9]{64}$/.test(sourceRecord.sha256 ?? '') || sourceRecord.sha256 !== baselineRecord.sha256)
    fail('INVALID_IDENTITY_BASELINE', 'Original chart source hashes and counts must agree');
  const originals = new Map(baseline.identities.map(row => [row.id, row]));
  if (originals.size !== baseline.identities.length)
    fail('INVALID_IDENTITY_BASELINE', 'Canonical baseline IDs must be unique');
  const byId = new Map(), byIndex = new Map(), stagingIds = new Set();
  for (const song of staging.songs) {
    if (!object(song) || !text(song.id) || stagingIds.has(song.id) || !Array.isArray(song.refs) || !song.refs.every(object))
      fail('INVALID_IDENTITY_BASELINE', 'Staging IDs and references are invalid');
    stagingIds.add(song.id);
    const refs = song.refs.filter(ref => ref.source === chartSource);
    if (!refs.length) continue;
    const index = refs[0].index;
    if (refs.length !== 1 || !Number.isInteger(index) || index < 0 || index >= 100 || byIndex.has(index) || song.availability !== 'current')
      fail('INVALID_IDENTITY_BASELINE', 'Original chart references must identify 100 current songs');
    const original = originals.get(song.id);
    const observations = original?.observations?.filter(observation =>
      object(observation) && Array.isArray(observation.refs) && observation.refs.every(object) &&
      observation.refs.some(ref => ref.source === baselineSource && ref.index === index));
    if (!observations?.length)
      fail('INVALID_IDENTITY_BASELINE', 'Canonical song lacks its original chart observation');
    const identity = { id: song.id, number: song.karaoke?.tj?.observedNumber, observations };
    byId.set(song.id, identity); byIndex.set(index, identity);
  }
  if (byId.size !== 100 || byIndex.size !== 100)
    fail('INVALID_IDENTITY_BASELINE', 'All 100 original chart identities are required');
  return { byId, byIndex };
}

function matches(row, identity) {
  return identity && identity.number === row.tjNumber && identity.observations.some(observation =>
    observation.title === row.title && observation.artist === row.artist && observation.tjNumber === row.tjNumber);
}

function mappedRows(snapshot, identities) {
  const projected = rows(snapshot), canonicalIds = new Set();
  return projected.map((row, index) => {
    const canonicalId = snapshot.songs[index].canonicalId;
    if (!text(canonicalId) || canonicalIds.has(canonicalId) || !matches(row, identities.byId.get(canonicalId)))
      fail('INVALID_CANONICAL_ID', 'Chart alias and original canonical identity must agree');
    canonicalIds.add(canonicalId);
    return { ...row, canonicalId };
  });
}

// Shared with artifact verification: canonical IDs are checked against the
// original chart observation, never inferred solely from a karaoke number.
export function validateChartSnapshot(snapshot, staging, baseline = committedBaseline, { now = new Date() } = {}) {
  metadata(snapshot, false, now);
  mappedRows(snapshot, chartIdentities(staging, baseline));
  return snapshot;
}

export function buildChartSnapshot({ raw, previous, staging, sourceSha, baseline = committedBaseline, now = new Date() }) {
  if (!fullSha(sourceSha)) fail('INVALID_SOURCE_SHA', 'A full lowercase source SHA is required');
  const candidateMetadata = metadata(raw, true, now), previousMetadata = metadata(previous, false, now);
  if (candidateMetadata.fetchedAt < previousMetadata.fetchedAt || candidateMetadata.startDate < previousMetadata.startDate ||
      candidateMetadata.endDate < previousMetadata.endDate)
    fail('STALE_SNAPSHOT', 'An older fetch or requested period cannot replace the current snapshot');
  const candidate = rows(raw), before = rows(previous), identities = chartIdentities(staging, baseline);
  const canonicalCount = previous.songs.filter(row => Object.hasOwn(row, 'canonicalId')).length;
  let trusted;
  if (canonicalCount === 100) trusted = mappedRows(previous, identities);
  else {
    if (canonicalCount !== 0 || previous.legacyRevision !== staging.revision)
      fail('INVALID_CANONICAL_ID', 'Unmapped snapshots can only migrate from the original staging revision');
    // This one-time migration ties the archived raw alias order to the exact
    // original chart reference and matching committed observation tuple.
    trusted = before.map((row, index) => {
      const identity = identities.byIndex.get(index);
      if (!matches(row, identity))
        fail('INVALID_CANONICAL_ID', 'The initial alias order does not match the original chart observation');
      return { ...row, canonicalId: identity.id };
    });
  }
  const byAlias = new Map(trusted.map(row => [row.id, row]));
  const songs = candidate.map(row => {
    const old = byAlias.get(row.id);
    if (!old || old.title !== row.title || old.artist !== row.artist || old.tjNumber !== row.tjNumber)
      fail('IDENTITY_CHANGED', 'New aliases or changed chart identity tuples require review');
    return { ...row, canonicalId: old.canonicalId };
  });
  const snapshot = { ...candidateMetadata, legacyRevision: sourceSha, songs };
  return validateChartSnapshot(snapshot, staging, baseline, { now });
}

// The filesystem injection is used only by tests. The CLI always uses Node's
// filesystem and never evaluates input JSON or source JavaScript.
export async function importChartSnapshot(inputPath, snapshotPath, stagingPath, sourceSha, options = {}) {
  const io = options.io ?? filesystem;
  if (![inputPath, snapshotPath, stagingPath].every(value => typeof value === 'string' && value))
    fail('INVALID_PATH', 'Input, snapshot and staging paths are required');
  if (!fullSha(sourceSha)) fail('INVALID_SOURCE_SHA', 'A full lowercase source SHA is required');
  const input = await io.realpath(inputPath);
  const stagingFile = await io.realpath(stagingPath);
  const directory = await io.realpath(dirname(resolve(snapshotPath)));
  const output = join(directory, basename(resolve(snapshotPath)));
  const outputStat = await io.lstat(output);
  if (!outputStat.isFile()) fail('INVALID_OUTPUT', 'The existing snapshot must be a regular file');
  for (const path of [input, stagingFile]) {
    const stat = await io.stat(path);
    if (!stat.isFile()) fail('INVALID_INPUT', 'Inputs must be regular files');
    if (path === output || (stat.dev === outputStat.dev && stat.ino === outputStat.ino))
      fail('SAME_FILE', 'The snapshot must not alias an input');
  }
  const raw = parseJson(await io.readFile(input));
  const previous = parseJson(await io.readFile(output));
  const staging = parseJson(await io.readFile(stagingFile));
  const snapshot = buildChartSnapshot({ raw, previous, staging, sourceSha, baseline: options.baseline, now: options.now });
  const bytes = Buffer.from(JSON.stringify(snapshot, null, 2) + '\n');
  const temporary = join(directory, '.' + basename(output) + '.' + randomUUID() + '.tmp');
  let handle, owned = false;
  try {
    handle = await io.open(temporary, 'wx', outputStat.mode & 0o777); owned = true;
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close(); handle = undefined;
    await io.rename(temporary, output); owned = false;
  } finally {
    if (handle) await handle.close().catch(() => {});
    if (owned) await io.unlink(temporary).catch(() => {});
  }
  return { songs: snapshot.songs.length, sourceSha, fetchedAt: snapshot.fetchedAt,
    startDate: snapshot.startDate, endDate: snapshot.endDate };
}

export async function main(args = process.argv.slice(2)) {
  if (args.length !== 4) fail('INVALID_ARGUMENTS', 'Usage: node scripts/import-chart-snapshot.mjs <raw.json> <snapshot.json> <staging.json> <sourceSHA>');
  const result = await importChartSnapshot(...args);
  console.log('Chart snapshot imported: ' + JSON.stringify(result));
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => {
    const code = error instanceof ChartSnapshotError ? error.code : 'IO_ERROR';
    console.error('Chart import failed: ' + code + '; previous snapshot preserved.');
    process.exitCode = 1;
  });
}
