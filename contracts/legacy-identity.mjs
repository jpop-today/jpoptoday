import { createHash } from 'node:crypto';

const files = { 'js/songs.js': 'songs', 'js/chart.js': 'tjJpopChart' };
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const fullSha = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const nonempty = value => typeof value === 'string' && value.trim().length > 0;

export function canonicalRepository(origin) {
  if (typeof origin !== 'string') throw new Error('Repository origin is required');
  const ssh = /^git@github\.com:([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/.exec(origin);
  if (ssh) return 'https://github.com/' + ssh[1] + '/' + ssh[2];
  let url;
  try { url = new URL(origin); } catch { throw new Error('Repository origin must be a GitHub HTTPS URL or SSH remote'); }
  if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.username || url.password || url.search || url.hash || url.port)
    throw new Error('Repository origin must be a credential-free GitHub HTTPS URL or SSH remote');
  const path = /^\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(url.pathname);
  if (!path) throw new Error('Repository origin must identify an owner and repository');
  return 'https://github.com/' + path[1] + '/' + path[2];
}

export function parseLegacySongs(source, variable) {
  if (!Object.values(files).includes(variable)) throw new Error('Unsupported legacy data variable');
  let text;
  try {
    text = typeof source === 'string' ? source : new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(source);
  } catch { throw new Error('Legacy source must be valid UTF-8'); }
  // Only an optional generated block comment and one const JSON array are
  // accepted. No source text is evaluated or executed.
  const pattern = new RegExp('^\\s*(?:/\\*[\\s\\S]*?\\*/\\s*)*const\\s+' + variable + '\\s*=\\s*(\\[[\\s\\S]*\\])\\s*;\\s*$');
  const literal = pattern.exec(text)?.[1];
  if (!literal) throw new Error('Expected only const ' + variable + ' = JSON array;');
  let rows;
  try { rows = JSON.parse(literal); } catch { throw new Error('Legacy array must contain JSON data, not JavaScript expressions'); }
  if (!Array.isArray(rows) || rows.length === 0) throw new Error('Legacy source must contain a nonempty array');
  const ids = new Set();
  return rows.map((row, index) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error('Invalid legacy row at index ' + index);
    for (const field of ['id', 'title', 'artist'])
      if (!nonempty(row[field])) throw new Error('Missing legacy ' + field + ' at index ' + index);
    if (ids.has(row.id)) throw new Error('Duplicate legacy ID at index ' + index);
    ids.add(row.id);
    for (const field of ['tjNumber', 'kyNumber'])
      if (typeof row[field] !== 'string' || (row[field] !== '' && !/^[0-9]{1,10}$/.test(row[field])))
        throw new Error('Legacy ' + field + ' must be an unchanged digit string or empty string at index ' + index);
    // Keep the original identity fields. Do not copy lyrics, images, editorial
    // content, ranking, provider evidence, or any unexpected input properties.
    return { id: row.id, title: row.title, artist: row.artist, tjNumber: row.tjNumber, kyNumber: row.kyNumber };
  });
}

export function buildLegacyIdentityBaseline(repository, inputs) {
  const repo = canonicalRepository(repository);
  if (!Array.isArray(inputs) || inputs.length === 0) throw new Error('Legacy sources are required');
  const sortedInputs = [...inputs].sort((a, b) => compare(a.revision + ':' + a.path, b.revision + ':' + b.path));
  const sourceKeys = new Set();
  const sources = [];
  const identities = new Map();
  const revisionIds = new Map();

  for (const input of sortedInputs) {
    if (!fullSha(input.revision)) throw new Error('A full lowercase commit SHA is required');
    if (!Object.hasOwn(files, input.path)) throw new Error('Unsupported legacy source path');
    const sourceKey = input.revision + ':' + input.path;
    if (sourceKeys.has(sourceKey)) throw new Error('Duplicate legacy source revision and path');
    sourceKeys.add(sourceKey);
    if (!Buffer.isBuffer(input.bytes)) throw new Error('Exact legacy source bytes are required');
    const rows = parseLegacySongs(input.bytes, files[input.path]);
    const sourceIndex = sources.length;
    sources.push({ revision: input.revision, path: input.path, sha256: createHash('sha256').update(input.bytes).digest('hex'), rows: rows.length });
    if (!revisionIds.has(input.revision)) revisionIds.set(input.revision, { playlist: new Set(), chart: new Set(), paths: new Set() });
    const revision = revisionIds.get(input.revision);
    revision.paths.add(input.path);
    const group = input.path === 'js/songs.js' ? 'playlist' : 'chart';

    for (const [rowIndex, { id, ...fields }] of rows.entries()) {
      revision[group].add(id);
      if (!identities.has(id)) identities.set(id, new Map());
      const observations = identities.get(id);
      const key = JSON.stringify(fields);
      if (!observations.has(key)) observations.set(key, { ...fields, refs: [] });
      observations.get(key).refs.push({ source: sourceIndex, index: rowIndex });
    }
  }

  const revisions = [...revisionIds].map(([revision, ids]) => {
    if (ids.paths.size !== 2) throw new Error('Every revision requires both js/songs.js and js/chart.js');
    return { revision, playlistIds: ids.playlist.size, chartIds: ids.chart.size, mergedIds: new Set([...ids.playlist, ...ids.chart]).size };
  });
  const playlistIds = new Set([...revisionIds.values()].flatMap(ids => [...ids.playlist]));
  const records = [...identities].sort(([a], [b]) => compare(a, b)).map(([id, observations]) => ({
    id,
    observations: [...observations].sort(([a], [b]) => compare(a, b)).map(([, observation]) => observation),
  }));
  const numberIds = { tj: new Map(), ky: new Map() };
  for (const record of records) {
    for (const observation of record.observations) {
      for (const provider of ['tj', 'ky']) {
        const number = observation[provider + 'Number'];
        if (!number) continue;
        if (!numberIds[provider].has(number)) numberIds[provider].set(number, new Set());
        numberIds[provider].get(number).add(record.id);
      }
    }
  }
  const unresolvedAliases = ['tj', 'ky'].flatMap(provider => [...numberIds[provider]]
    .filter(([, ids]) => ids.size > 1)
    .sort(([a], [b]) => compare(a, b))
    .map(([number, ids]) => ({ provider, observedNumber: number, ids: [...ids].sort(), resolution: 'unresolved' })));

  return {
    baselineVersion: 1,
    purpose: 'legacy-identity-audit',
    repository: repo,
    mappingStrategy: 'preserve-each-legacy-id',
    sources,
    revisions,
    summary: { totalIds: records.length, playlistIds: playlistIds.size, chartOnlyIds: records.filter(row => !playlistIds.has(row.id)).length, unresolvedAliasGroups: unresolvedAliases.length },
    identities: records,
    unresolvedAliases,
  };
}
