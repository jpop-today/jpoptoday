/** ADR-006: consume explicit reviewed corrections; never infer identity from a number. */
import { buildPublicCatalog } from './public-catalog.mjs';
import { officialLookup } from './provider-lookup.mjs';
export { officialLookupMatches } from './provider-lookup.mjs';

const providers = ['tj', 'ky'];
const songKeys = ['id', 'titleOriginal', 'titleKo', 'artistOriginal', 'artistKo', 'tags', 'availability', 'origin', 'karaoke'];
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value));
const text = value => typeof value === 'string' && Boolean(value.trim()) && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value);
const number = value => typeof value === 'string' && /^[0-9]{1,10}$/u.test(value) && !/^0+$/u.test(value);
const fail = message => { throw new Error(message); };

function exactKeys(value, keys, message) {
  if (!plain(value) || Reflect.ownKeys(value).length !== keys.length ||
      !keys.every(key => Object.hasOwn(value, key))) fail(message);
}

const denseArray = value => Array.isArray(value) && Reflect.ownKeys(value).length === value.length + 1 &&
  Array.from({ length: value.length }, (_, index) => Object.hasOwn(value, index)).every(Boolean);

function stagingCatalog(staging) {
  if (!/^[a-f0-9]{40}$/u.test(staging?.revision ?? '')) fail('Invalid legacy revision');
  return buildPublicCatalog(staging);
}

function calendarDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function checkedAt(value, now) {
  if (typeof value !== 'string') fail('Invalid evidence date');
  const current = new Date(now);
  if (!Number.isFinite(current.getTime())) fail('Invalid validation time');
  if (calendarDate(value)) {
    const koreanToday = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(current);
    if (value > koreanToday) fail('Future evidence date');
    return;
  }
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|([+-])(\d{2}):(\d{2}))$/u.exec(value);
  if (!match || !calendarDate(match[1]) || Number(match[2]) > 23 || Number(match[3]) > 59 ||
      Number(match[4]) > 59 || (match[7] && (Number(match[8]) > 14 || Number(match[9]) > 59 ||
        (Number(match[8]) === 14 && Number(match[9]) !== 0)))) fail('Invalid evidence timestamp');
  const instant = Date.parse(value);
  const submillisecond = Number((match[5] ?? '').padEnd(9, '0').slice(3));
  if (!Number.isFinite(instant) || instant > current.getTime() ||
      (instant === current.getTime() && submillisecond > 0)) fail('Future or invalid evidence timestamp');
}

/** Shape/provenance validation cannot replace human title/artist/version review. */
export function validateProviderCorrections(ledger, staging, { now = new Date() } = {}) {
  exactKeys(ledger, ['ledgerVersion', 'purpose', 'legacyRevision', 'entries'], 'Invalid correction ledger fields');
  const original = stagingCatalog(staging);
  if (ledger.ledgerVersion !== 1 || ledger.purpose !== 'reviewed-provider-corrections' ||
      ledger.legacyRevision !== staging.revision || !denseArray(ledger.entries)) fail('Invalid correction ledger identity');
  const songs = new Map(original.songs.map(song => [song.id, song]));
  const seen = new Set();
  return ledger.entries.map(entry => {
    exactKeys(entry, ['songId', 'provider', 'action', 'expectedObservedNumber', 'number', 'evidence', 'reason'], 'Invalid correction entry fields');
    const song = songs.get(entry.songId);
    if (!song || !providers.includes(entry.provider) || !['confirm', 'suppress'].includes(entry.action))
      fail('Invalid correction identity or action');
    const key = JSON.stringify([entry.songId, entry.provider]);
    if (seen.has(key)) fail('Duplicate song/provider correction');
    seen.add(key);
    if (entry.expectedObservedNumber !== null && !number(entry.expectedObservedNumber)) fail('Invalid expected observed number');
    if (song.karaoke[entry.provider].observedNumber !== entry.expectedObservedNumber) fail('Observed number mismatch');
    if (entry.action === 'confirm' ? !number(entry.number) : entry.number !== null || entry.expectedObservedNumber === null)
      fail('Invalid correction number');
    if (!text(entry.reason)) fail('Correction reason required');
    exactKeys(entry.evidence, ['url', 'checkedAt', 'title', 'artist', 'responseSha256'], 'Invalid correction evidence fields');
    if (!text(entry.evidence.title) || !text(entry.evidence.artist) ||
        typeof entry.evidence.responseSha256 !== 'string' || !/^[a-f0-9]{64}$/iu.test(entry.evidence.responseSha256))
      fail('Incomplete correction evidence');
    checkedAt(entry.evidence.checkedAt, now);
    officialLookup(entry.evidence.url, entry.provider, entry.action === 'confirm' ? entry.number : entry.expectedObservedNumber);
    return { ...entry, evidence: { ...entry.evidence } };
  });
}

/** Applies once to the original public v1 songs; returns only public allowlisted fields. */
export function applyProviderCorrections(publicSongs, staging, ledger, options = {}) {
  const entries = validateProviderCorrections(ledger, staging, options);
  const original = stagingCatalog(staging);
  if (!Array.isArray(publicSongs) || publicSongs.length !== original.songs.length) fail('Incomplete public song input');
  const baseline = new Map(original.songs.map(song => [song.id, song]));
  const seen = new Set();
  const corrections = new Map(entries.map(entry => [JSON.stringify([entry.songId, entry.provider]), entry]));
  const result = publicSongs.map(song => {
    exactKeys(song, songKeys, 'Invalid public song fields');
    const source = baseline.get(song.id);
    if (!source || seen.has(song.id)) fail('Invalid or duplicate public song identity');
    seen.add(song.id);
    for (const key of songKeys.filter(key => !['tags', 'karaoke'].includes(key)))
      if (song[key] !== source[key]) fail('Public song metadata mismatch');
    if (!Array.isArray(song.tags) || song.tags.length !== source.tags.length ||
        !song.tags.every((tag, index) => tag === source.tags[index])) fail('Public song tags mismatch');
    exactKeys(song.karaoke, providers, 'Invalid public provider fields');
    const karaoke = {};
    for (const provider of providers) {
      exactKeys(song.karaoke[provider], ['status', 'observedNumber', 'conflict'], 'Invalid public provider observation fields');
      const input = song.karaoke[provider];
      const raw = source.karaoke[provider];
      if (input.status !== raw.status || input.observedNumber !== raw.observedNumber || typeof input.conflict !== 'boolean')
        fail('Public observation mismatch');
      const entry = corrections.get(JSON.stringify([song.id, provider]));
      karaoke[provider] = {
        status: entry ? entry.action === 'confirm' ? 'provider-confirmed' : 'unknown' : raw.status,
        observedNumber: entry ? entry.number : raw.observedNumber,
        conflict: false,
        evidence: entry ? { url: entry.evidence.url, checkedAt: entry.evidence.checkedAt,
          title: entry.evidence.title, artist: entry.evidence.artist } : null,
        correction: entry ? { reason: entry.reason, previousNumber: raw.observedNumber } : null,
      };
    }
    return { id: song.id, titleOriginal: song.titleOriginal, titleKo: song.titleKo,
      artistOriginal: song.artistOriginal, artistKo: song.artistKo, tags: [...song.tags],
      availability: song.availability, origin: song.origin, karaoke };
  });
  for (const provider of providers) {
    const counts = new Map();
    for (const song of result) {
      const value = song.karaoke[provider].observedNumber;
      if (value !== null) counts.set(value, (counts.get(value) ?? 0) + 1);
    }
    for (const song of result) {
      const value = song.karaoke[provider];
      value.conflict = value.observedNumber !== null && counts.get(value.observedNumber) > 1;
    }
  }
  return result;
}
