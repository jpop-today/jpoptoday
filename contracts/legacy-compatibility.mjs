/**
 * Browser-safe compatibility contracts. This module never reads globals such
 * as window/localStorage and does not import Node modules. Inject storage.
 * Evidence references must name a reviewed correction record; `verified: true`
 * is a caller assertion, not proof that two songs are identical.
 */
export const FAVORITES_STORAGE_KEY = 'jpop_today_favorites';
export const RECENT_FILTERS_STORAGE_KEY = 'jpop_today_recent_filters';
export const MAX_RECENT_FILTERS = 5;

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function validId(value) {
  if (typeof value !== 'string' || !value.trim() || value === '.' || value === '..' || /[\u0000-\u001f\u007f]/u.test(value)) return false;
  try { encodeURIComponent(value); return true; } catch { return false; }
}

/** Preserve baseline IDs exactly; metadata and shared numbers never affect ID. */
export function createIdentityResolver(baseline, explicitAliases = []) {
  if (!record(baseline) || !Array.isArray(baseline.identities) || !baseline.identities.length)
    throw new Error('A nonempty identity baseline is required');
  const known = new Set();
  for (const identity of baseline.identities) {
    if (!record(identity) || !validId(identity.id)) throw new Error('Invalid baseline ID');
    if (known.has(identity.id)) throw new Error('Duplicate baseline ID');
    known.add(identity.id);
  }
  if (!Array.isArray(explicitAliases)) throw new Error('Aliases must be an array of reviewed records');
  const aliases = new Map();
  for (const item of explicitAliases) {
    if (!record(item) || !validId(item.alias) || !validId(item.canonicalId) || item.verified !== true ||
        typeof item.evidence !== 'string' || !item.evidence.trim()) throw new Error('A reviewed alias and evidence reference are required');
    if (!known.has(item.canonicalId)) throw new Error('Alias target must be a known baseline ID');
    if (aliases.has(item.alias)) throw new Error('Duplicate or conflicting alias');
    if (item.alias === item.canonicalId) throw new Error('Self alias is not permitted');
    aliases.set(item.alias, Object.freeze({ ...item }));
  }
  for (const alias of aliases.values()) {
    if (aliases.has(alias.canonicalId)) throw new Error('Alias chains and cycles are not permitted');
  }
  const resolve = id => {
    if (!validId(id)) return { status: 'invalid', id, canonicalId: null, aliased: false };
    const alias = aliases.get(id);
    if (alias) return { status: 'known', id, canonicalId: alias.canonicalId, aliased: true, evidence: alias.evidence };
    return known.has(id)
      ? { status: 'known', id, canonicalId: id, aliased: false }
      : { status: 'missing', id, canonicalId: null, aliased: false };
  };
  return Object.freeze({ resolve, size: known.size, aliasCount: aliases.size });
}

function strictUrlEncoding(url) {
  // URL/URLSearchParams replace broken UTF-8 rather than rejecting it. Validate
  // original escaped components before selecting any identity or redirect.
  decodeURIComponent(url.pathname);
  decodeURIComponent(url.hash.slice(1));
  for (const part of url.search.slice(1).split('&')) {
    const split = part.indexOf('=');
    decodeURIComponent((split < 0 ? part : part.slice(0, split)).replace(/\+/g, ' '));
    decodeURIComponent((split < 0 ? '' : part.slice(split + 1)).replace(/\+/g, ' '));
  }
}

/**
 * Return a same-origin relative href only for a resolved route. Unknown songs
 * are unresolved with their exact decoded legacyId and original URL retained.
 * Consumers should use history.replaceState for redirects and preserve browser
 * navigation; this pure adapter itself never changes history or location.
 */
export function resolveLegacyUrl(input, resolver, { origin = 'https://jpop.today' } = {}) {
  let url;
  let base;
  const original = input instanceof URL ? input.href : input;
  const reject = reason => ({ status: 'rejected', reason, original, href: null });
  try {
    base = new URL(origin);
    if (!['https:', 'http:'].includes(base.protocol) || base.username || base.password) return reject('invalid-origin');
    if (typeof original !== 'string' || /[\u0000-\u0020\u007f\\]/u.test(original)) return reject('invalid-url');
    url = new URL(original, base.origin + '/');
    if (url.origin !== base.origin || url.username || url.password) return reject('external-origin');
    strictUrlEncoding(url);
  } catch { return reject('invalid-url-encoding'); }
  const originalHref = url.pathname + url.search + url.hash;
  const path = url.pathname.replace(/\/$/, '') || '/';
  const result = (route, href, extra = {}) => ({
    status: href === originalHref ? 'unchanged' : 'redirect', route, href, original, originalHref, ...extra,
  });
  if ((path === '/' || path === '/index' || path === '/index.html') && url.hash === '#favorites-view')
    return result('favorites', '/favorites/' + url.search);
  if (path === '/song' || path === '/song.html') {
    const ids = url.searchParams.getAll('id');
    if (ids.length !== 1 || !validId(ids[0])) return reject(ids.length > 1 ? 'ambiguous-id' : 'invalid-id');
    const identity = resolver.resolve(ids[0]);
    if (identity.status !== 'known') return { status: 'unresolved', route: 'song', legacyId: ids[0], identity, original, originalHref, href: null };
    const remaining = url.search.slice(1).split('&').filter(part =>
      decodeURIComponent(part.split('=')[0].replace(/\+/g, ' ')) !== 'id').join('&');
    return result('song', '/songs/' + encodeURIComponent(identity.canonicalId) + '/' + (remaining ? '?' + remaining : '') + url.hash, { legacyId: ids[0], identity });
  }
  const songPath = /^\/songs\/([^/]+)$/.exec(path);
  if (songPath) {
    const id = decodeURIComponent(songPath[1]);
    const identity = resolver.resolve(id);
    if (identity.status !== 'known') return { status: 'unresolved', route: 'song', legacyId: id, identity, original, originalHref, href: null };
    return result('song', '/songs/' + encodeURIComponent(identity.canonicalId) + '/' + url.search + url.hash, { identity });
  }
  if (['/filter', '/filter.html', '/search', '/search.html'].includes(path))
    return result('search', '/search/' + url.search + url.hash);
  if (path === '/favorites' || path === '/favorites.html') return result('favorites', '/favorites/' + url.search + url.hash);
  // Other observed .html routes retain their query/hash. Restrict conversion to
  // known public page families rather than inventing arbitrary redirect targets.
  if (/^\/(?:chart|coverage|about|contact|privacy|faq|guides(?:\/[^/]+)?)\.html$/.test(path))
    return result('page', path.slice(0, -5) + '/' + url.search + url.hash);
  if (path === '/index.html') return result('home', '/' + url.search + url.hash);
  return { status: 'unmatched', original, originalHref, href: null };
}

const diagnostic = (code, error) => ({ code, ...(error ? { errorName: typeof error.name === 'string' ? error.name : 'Error' } : {}) });
function readStored(storage, key, parse) {
  let raw;
  try { raw = storage.getItem(key); }
  catch (error) { return { status: 'read-failed', mode: 'session', key, raw: null, readable: false, values: [], diagnostics: [diagnostic('storage-read-failed', error)] }; }
  if (raw === null) return { status: 'empty', mode: 'persistent', key, raw, readable: true, values: [], diagnostics: [] };
  if (typeof raw !== 'string') return { status: 'invalid-storage', mode: 'session', key, raw, readable: false, values: [], diagnostics: [diagnostic('invalid-storage-value')] };
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch { return { status: 'invalid-json', mode: 'session', key, raw, readable: true, values: [], diagnostics: [diagnostic('invalid-json')] }; }
  if (!Array.isArray(parsed)) return { status: 'invalid-shape', mode: 'session', key, raw, readable: true, values: [], diagnostics: [diagnostic('expected-array')] };
  const normalized = parse(parsed);
  return { key, raw, readable: true, ...normalized };
}

function parseFavorites(values, resolver) {
  const entries = values.map((value, index) => {
    const id = typeof value === 'string' ? value : record(value) ? value.id : undefined;
    const identity = resolver.resolve(id);
    return { ...identity, value, index };
  });
  const invalid = entries.some(entry => entry.status === 'invalid');
  return {
    status: invalid ? 'invalid-entry' : 'ready', mode: invalid ? 'session' : 'persistent', values, entries,
    diagnostics: invalid ? [diagnostic('invalid-favorite-entry')] : [],
  };
}

/** Reading is strictly read-only, including damaged JSON or missing IDs. */
export function readFavorites(storage, resolver) {
  const result = readStored(storage, FAVORITES_STORAGE_KEY, values => parseFavorites(values, resolver));
  return { entries: [], ...result };
}

let backupSequence = 0;
function restoreOriginal(storage, key, raw, candidate) {
  try {
    const current = storage.getItem(key);
    if (current === raw) return { restored: true, diagnostics: [] };
    // A concurrent writer's bytes are not ours to overwrite.
    if (current !== candidate) return { restored: false, diagnostics: [diagnostic('rollback-concurrent-change')] };
    if (raw === null) storage.removeItem(key); else storage.setItem(key, raw);
    if (storage.getItem(key) !== raw) throw new Error('Rollback verification failed');
    return { restored: true, diagnostics: [] };
  } catch (error) { return { restored: false, diagnostics: [diagnostic('rollback-failed', error)] }; }
}

function persistCandidate(storage, current, values, parse, { backup = false, backupKey } = {}) {
  const session = parse(values);
  const fallback = (status, diagnostics, extra = {}) => ({ ...current, ...session, status, mode: 'session', diagnostics: [...current.diagnostics, ...diagnostics], ...extra });
  // Do not replace corrupted or inaccessible bytes during a normal save.
  if (!current.readable || current.mode === 'session') return fallback('session-only', [diagnostic('original-preserved')]);
  const candidate = JSON.stringify(values);
  const verified = parse(JSON.parse(candidate));
  if (verified.mode !== 'persistent') return fallback('invalid-candidate', [diagnostic('invalid-candidate')]);
  if (candidate === current.raw) return { ...current, ...session, status: 'unchanged' };
  let actualBackupKey = null;
  try {
    if (storage.getItem(current.key) !== current.raw) return fallback('conflict', [diagnostic('concurrent-change')]);
    if (backup && current.raw !== null) {
      actualBackupKey = backupKey ?? current.key + '.backup.v1.' + Date.now().toString(36) + '-' + (++backupSequence).toString(36);
      if (typeof actualBackupKey !== 'string' || !actualBackupKey || actualBackupKey === current.key) return fallback('invalid-backup-key', [diagnostic('invalid-backup-key')]);
      const existing = storage.getItem(actualBackupKey);
      if (existing !== null && existing !== current.raw) return fallback('backup-conflict', [diagnostic('backup-conflict')], { backupKey: actualBackupKey });
      storage.setItem(actualBackupKey, current.raw);
      if (storage.getItem(actualBackupKey) !== current.raw) throw new Error('Backup verification failed');
      // Revalidate after the durable backup and before modifying the old key.
      if (parse(JSON.parse(candidate)).mode !== 'persistent') throw new Error('Candidate verification failed');
      if (storage.getItem(current.key) !== current.raw) return fallback('conflict', [diagnostic('concurrent-change')], { backupKey: actualBackupKey });
    }
  } catch (error) { return fallback('backup-failed', [diagnostic(backup ? 'backup-failed' : 'storage-check-failed', error)], { backupKey: actualBackupKey }); }
  try {
    storage.setItem(current.key, candidate);
    if (storage.getItem(current.key) !== candidate) throw new Error('Write verification failed');
    return { ...current, ...session, status: 'saved', raw: candidate, mode: 'persistent', diagnostics: [], backupKey: actualBackupKey };
  } catch (error) {
    const rollback = restoreOriginal(storage, current.key, current.raw, candidate);
    return fallback('write-failed', [diagnostic('storage-write-failed', error), ...rollback.diagnostics], { backupKey: actualBackupKey, restored: rollback.restored });
  }
}

/**
 * Explicit migration keeps an exact-byte backup, resolves reviewed aliases,
 * preserves unknown IDs/metadata, and returns failure/rollback diagnostics.
 */
export function migrateFavorites(storage, resolver, options = {}) {
  const current = readFavorites(storage, resolver);
  const values = current.entries.map(entry => entry.aliased
    ? typeof entry.value === 'string' ? entry.canonicalId : { ...entry.value, id: entry.canonicalId }
    : entry.value);
  return persistCandidate(storage, current, values, candidate => parseFavorites(candidate, resolver), { ...options, backup: true });
}

/**
 * Explicit save/remove. Pass the previous session result as options.state to
 * retain session-only changes after denied storage or damaged JSON. Removing a
 * missing ID is allowed only when that exact ID was explicitly selected.
 */
export function updateFavorites(storage, resolver, { action, id }, { state } = {}) {
  if (!['save', 'remove'].includes(action) || !validId(id)) throw new Error('An explicit save/remove action and valid ID are required');
  const current = state?.mode === 'session' && state.key === FAVORITES_STORAGE_KEY ? state : readFavorites(storage, resolver);
  const identity = resolver.resolve(id);
  let values = [...current.values];
  const matches = value => {
    const storedId = typeof value === 'string' ? value : record(value) ? value.id : undefined;
    if (storedId === id) return true;
    return identity.status === 'known' && resolver.resolve(storedId).canonicalId === identity.canonicalId;
  };
  if (action === 'remove') values = values.filter(value => !matches(value));
  else if (!values.some(matches)) values.push(identity.canonicalId ?? id);
  return persistCandidate(storage, current, values, candidate => parseFavorites(candidate, resolver));
}

function normalizeFilter(value, index, position = 0) {
  if (!record(value)) return null;
  const type = ({ animeAll: 'anime-all', artistAll: 'artist-all' })[value.type] ?? value.type;
  if (!['number', 'tag', 'anime-all', 'artist-all'].includes(type)) return null;
  if (['number', 'tag'].includes(type) && (typeof value.value !== 'string' || !value.value.trim())) return null;
  const savedAt = Number.isFinite(Number(value.savedAt)) && Number(value.savedAt) >= 0 ? Number(value.savedAt) : 0;
  return { id: typeof value.id === 'string' && value.id.trim() ? value.id : `legacy-filter-${index}-${position}`, type,
    value: ['number', 'tag'].includes(type) ? value.value.trim() : '', savedAt };
}

function decodeFilters(values) {
  const decoded = [];
  const unrecognized = [];
  values.forEach((value, index) => {
    if (record(value) && Object.hasOwn(value, 'type')) {
      const item = normalizeFilter(value, index);
      if (item) decoded.push(item); else unrecognized.push({ index, value });
      return;
    }
    if (!record(value) || !['numberFilters', 'tags', 'animeAll', 'artistAll'].some(key => Object.hasOwn(value, key)) ||
        (value.numberFilters !== undefined && !Array.isArray(value.numberFilters)) || (value.tags !== undefined && !Array.isArray(value.tags)) ||
        [...(value.numberFilters ?? []), ...(value.tags ?? [])].some(item => typeof item !== 'string' || !item.trim())) {
      unrecognized.push({ index, value }); return;
    }
    const items = [
      ...(value.numberFilters ?? []).map(filter => ({ type: 'number', value: filter })),
      ...(value.animeAll ? [{ type: 'anime-all' }] : []), ...(value.artistAll ? [{ type: 'artist-all' }] : []),
      ...(value.tags ?? []).map(tag => ({ type: 'tag', value: tag })),
    ];
    items.forEach((item, position) => decoded.push(normalizeFilter({ ...item, savedAt: value.savedAt }, index, position)));
  });
  const seen = new Set();
  const allEntries = decoded.sort((a, b) => b.savedAt - a.savedAt).filter(item => {
    const key = item.type + ':' + item.value;
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });
  return {
    status: unrecognized.length ? 'invalid-entry' : 'ready', mode: unrecognized.length ? 'session' : 'persistent', values,
    entries: allEntries.slice(0, MAX_RECENT_FILTERS), allEntries, unrecognized, overflowCount: Math.max(0, allEntries.length - MAX_RECENT_FILTERS),
    diagnostics: unrecognized.length ? [diagnostic('unrecognized-recent-filter')] : [],
  };
}

/** Supports original snapshots and newer button entries; reads never truncate storage. */
export function readRecentFilters(storage) {
  return { entries: [], allEntries: [], unrecognized: [], overflowCount: 0, ...readStored(storage, RECENT_FILTERS_STORAGE_KEY, decodeFilters) };
}

/** Normalize snapshots only when no unknown entry or overflow would be lost. */
export function migrateRecentFilters(storage, options = {}) {
  const current = readRecentFilters(storage);
  if (current.overflowCount) return { ...current, status: 'overflow-preserved', diagnostics: [...current.diagnostics, diagnostic('overflow-preserved')] };
  return persistCandidate(storage, current, current.allEntries, decodeFilters, { ...options, backup: true });
}
