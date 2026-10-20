import { readFavorites } from './legacy-compatibility.mjs';

export const MAX_FAVORITES_BACKUP_BYTES = 256 * 1024;
const FORMAT = 'jpop.today/favorites';
const fail = code => { const error = new Error('Favorites backup: ' + code); error.code = code; throw error; };
const byteLength = text => new TextEncoder().encode(text).byteLength;

function inspectValues(values, resolver) {
  if (!Array.isArray(values)) fail('invalid-values');
  let raw;
  try { raw = JSON.stringify(values); } catch { fail('invalid-values'); }
  const state = readFavorites({ getItem: () => raw }, resolver);
  if (state.mode !== 'persistent') fail('invalid-values');
  return { values: state.values, total: state.entries.length,
    known: state.entries.filter(entry => entry.status === 'known').length,
    unresolved: state.entries.filter(entry => entry.status === 'missing').length };
}

/** Whole stored/valid-session list, independent of the current UI filter. */
export function formatFavoritesBackup(values, resolver) {
  const inspected = inspectValues(values, resolver);
  const text = JSON.stringify({ format: FORMAT, version: 1, values: inspected.values }, null, 2) + '\n';
  if (byteLength(text) > MAX_FAVORITES_BACKUP_BYTES) fail('too-large');
  return text;
}

/** Pure, read-only inspection. Content is never echoed in errors. */
export function parseFavoritesBackup(text, resolver) {
  if (typeof text !== 'string') fail('invalid-format');
  if (byteLength(text) > MAX_FAVORITES_BACKUP_BYTES) fail('too-large');
  let file;
  try { file = JSON.parse(text); } catch { fail('invalid-json'); }
  if (!file || typeof file !== 'object' || Array.isArray(file) || file.format !== FORMAT) fail('invalid-format');
  if (file.version !== 1) fail('unsupported-version');
  return inspectValues(file.values, resolver);
}
