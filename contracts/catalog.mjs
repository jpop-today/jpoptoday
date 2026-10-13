// Framework-independent import contract. This validates shape and consistency;
// source authenticity and redistribution rights still require editorial review.
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonempty = value => typeof value === 'string' && value.trim().length > 0;
const stringList = value => Array.isArray(value) && value.every(nonempty);
const has = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(value + 'T00:00:00Z');
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function validSource(value) {
  if (!nonempty(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && Boolean(url.hostname) && !url.username && !url.password;
  } catch {
    return false;
  }
}

export function validateCatalog(catalog) {
  const errors = [];
  const fail = (path, message) => errors.push({ path, message });
  if (!record(catalog)) return [{ path: '$', message: 'Catalog must be an object' }];
  if (catalog.schemaVersion !== 1) fail('schemaVersion', 'Expected schema version 1');
  if (!Array.isArray(catalog.artists) || catalog.artists.length === 0)
    fail('artists', 'Expected a nonempty artist array');
  if (!Array.isArray(catalog.songs) || catalog.songs.length === 0)
    fail('songs', 'Expected a nonempty song array');

  const artistIds = new Set();
  for (const [index, artist] of (Array.isArray(catalog.artists) ? catalog.artists : []).entries()) {
    const path = 'artists[' + index + ']';
    if (!record(artist)) { fail(path, 'Artist must be an object'); continue; }
    if (!nonempty(artist.id)) fail(path + '.id', 'Expected a stable nonempty ID');
    else if (artistIds.has(artist.id)) fail(path + '.id', 'Duplicate artist ID');
    else artistIds.add(artist.id);
    for (const field of ['nameOriginal', 'nameKo'])
      if (!nonempty(artist[field])) fail(path + '.' + field, 'Expected a nonempty name');
    if (!stringList(artist.aliases)) fail(path + '.aliases', 'Expected a string array');
  }

  const songIds = new Set();
  const numbers = { tj: new Map(), ky: new Map() };
  for (const [index, song] of (Array.isArray(catalog.songs) ? catalog.songs : []).entries()) {
    const path = 'songs[' + index + ']';
    if (!record(song)) { fail(path, 'Song must be an object'); continue; }
    if (!nonempty(song.id)) fail(path + '.id', 'Expected a stable nonempty ID');
    else if (songIds.has(song.id)) fail(path + '.id', 'Duplicate song ID');
    else songIds.add(song.id);
    for (const field of ['titleOriginal', 'titleKo', 'version'])
      if (!nonempty(song[field])) fail(path + '.' + field, 'Expected nonempty text');
    if (!stringList(song.aliases)) fail(path + '.aliases', 'Expected a string array');
    if (!stringList(song.artistIds) || song.artistIds.length === 0) {
      fail(path + '.artistIds', 'Expected at least one artist ID');
    } else {
      if (new Set(song.artistIds).size !== song.artistIds.length)
        fail(path + '.artistIds', 'Duplicate artist reference');
      for (const id of song.artistIds)
        if (!artistIds.has(id)) fail(path + '.artistIds', 'Unknown artist ID: ' + id);
    }
    if (!record(song.karaoke)) { fail(path + '.karaoke', 'Expected provider records'); continue; }
    for (const provider of ['tj', 'ky']) {
      const item = song.karaoke[provider];
      const itemPath = path + '.karaoke.' + provider;
      if (!record(item)) { fail(itemPath, 'Expected a provider record'); continue; }
      if (!['registered', 'unknown', 'unlisted'].includes(item.status)) {
        fail(itemPath + '.status', 'Expected registered, unknown, or unlisted');
        continue;
      }
      if (item.status === 'registered') {
        if (typeof item.number !== 'string' || !/^[0-9]{1,10}$/.test(item.number)) {
          fail(itemPath + '.number', 'Expected a digit string of 1 to 10 characters');
        } else if (numbers[provider].has(item.number)) {
          fail(itemPath + '.number', 'Duplicate provider number; review identity/version mapping');
        } else {
          numbers[provider].set(item.number, song.id);
        }
      } else if (has(item, 'number') && item.number !== null) {
        fail(itemPath + '.number', 'Unknown or unlisted records must not contain a number');
      }
      if (item.status !== 'unknown') {
        if (!validSource(item.sourceUrl)) fail(itemPath + '.sourceUrl', 'Expected an HTTPS source without credentials');
        if (!validDate(item.checkedAt)) fail(itemPath + '.checkedAt', 'Expected a real YYYY-MM-DD date');
      } else {
        if (item.sourceUrl != null && !validSource(item.sourceUrl))
          fail(itemPath + '.sourceUrl', 'Invalid source URL');
        if (item.checkedAt != null && !validDate(item.checkedAt))
          fail(itemPath + '.checkedAt', 'Invalid checked date');
      }
    }
  }
  return errors;
}
