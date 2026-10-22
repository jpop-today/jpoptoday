/** Artist pages: exact artist labels, human-written intros, reviewed language classification. */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { confirmedNumbers } from './public-catalog.mjs';

export const ARTIST_INDEX_MIN_CONFIRMED = 3;
export const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const compare = (left, right) => left < right ? -1 : left > right ? 1 : 0;
// Resolved from the working directory: Astro bundles this module, so import.meta.url is not the source path.
export const projectRoot = pathToFileURL(process.cwd() + '/');

/** Frontmatter values are JSON-compatible YAML scalars/arrays so Astro and Node read the same data. */
export function parseFrontmatter(label, text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!match) throw new Error(`${label}: missing frontmatter`);
  const data = {};
  for (const line of match[1].split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const field = /^([A-Za-z]+):\s*(.*)$/.exec(line);
    if (!field) throw new Error(`${label}: unsupported frontmatter line`);
    try { data[field[1]] = JSON.parse(field[2]); } catch { data[field[1]] = field[2].trim(); }
  }
  return { data, body: match[2].trim() };
}

export function parseIntro(slug, text) {
  if (!SLUG.test(slug)) throw new Error(`Invalid artist slug: ${slug}`);
  const { data, body } = parseFrontmatter(slug, text);
  if (typeof data.name !== 'string' || !data.name.trim()) throw new Error(`${slug}: name required`);
  if (!Array.isArray(data.artists) || !data.artists.length || !data.artists.every(value => typeof value === 'string' && value.trim()))
    throw new Error(`${slug}: artists must list exact artist labels`);
  if (typeof data.draft !== 'boolean') throw new Error(`${slug}: draft must be true or false`);
  return { slug, name: data.name, artists: data.artists, draft: data.draft, body };
}

export function loadArtistIntros(directory = new URL('src/content/artists/', projectRoot)) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory).filter(name => name.endsWith('.md')).sort()
    .map(name => parseIntro(name.slice(0, -3), readFileSync(new URL(name, directory), 'utf8')));
}

/** Returns songId -> true|false. Songs without a reviewed basis are absent (null). */
export function loadSongClassification(file = new URL('data/reviewed/song-classification.json', projectRoot)) {
  const ledger = JSON.parse(readFileSync(file, 'utf8'));
  if (ledger.version !== 1 || ledger.purpose !== 'reviewed-song-classification' || !Array.isArray(ledger.entries))
    throw new Error('Invalid song classification ledger');
  const result = new Map();
  for (const entry of ledger.entries) {
    if (typeof entry.songId !== 'string' || typeof entry.isJpop !== 'boolean' || typeof entry.basis !== 'string' || !entry.basis.trim())
      throw new Error('Song classification entries need songId, boolean isJpop and basis');
    if (result.has(entry.songId)) throw new Error(`Duplicate classification: ${entry.songId}`);
    result.set(entry.songId, entry.isJpop);
  }
  return result;
}

export const isJpop = (classification, song) => classification.has(song.id) ? classification.get(song.id) : null;
const fallbackSlug = name => 'artist-' + createHash('sha256').update(name, 'utf8').digest('hex').slice(0, 16);

/**
 * Pages exist for every reviewed intro and every exact artist label with a confirmed song.
 * Only isJpop === false excludes a song; unknown (null) stays.
 */
export function buildArtistPages(songs, intros, classification) {
  const current = songs.filter(song => song.availability === 'current' && isJpop(classification, song) !== false);
  const byLabel = new Map();
  for (const song of current) {
    if (!byLabel.has(song.artistOriginal)) byLabel.set(song.artistOriginal, []);
    byLabel.get(song.artistOriginal).push(song);
  }
  const claimed = new Map(), pages = [];
  for (const intro of intros) {
    for (const label of intro.artists) {
      if (claimed.has(label)) throw new Error(`${label}: claimed by ${claimed.get(label)} and ${intro.slug}`);
      claimed.set(label, intro.slug);
    }
    pages.push({ slug: intro.slug, name: intro.name, labels: intro.artists, intro });
  }
  for (const [label, labelSongs] of byLabel) {
    if (claimed.has(label) || !labelSongs.some(song => confirmedNumbers(song).length)) continue;
    pages.push({ slug: fallbackSlug(label), name: label, labels: [label], intro: null });
  }
  const slugs = new Set();
  return pages.map(page => {
    if (slugs.has(page.slug)) throw new Error(`Duplicate artist slug: ${page.slug}`);
    slugs.add(page.slug);
    const pageSongs = page.labels.flatMap(label => byLabel.get(label) ?? []);
    const confirmed = pageSongs.filter(song => confirmedNumbers(song).length);
    // Confirmed songs first, then the rest by title; IDs break ties for stable output.
    const ordered = [...pageSongs].sort((a, b) =>
      (confirmedNumbers(b).length > 0) - (confirmedNumbers(a).length > 0) ||
      compare(a.titleOriginal, b.titleOriginal) || compare(a.id, b.id));
    const indexable = Boolean(page.intro && !page.intro.draft && page.intro.body) && confirmed.length >= ARTIST_INDEX_MIN_CONFIRMED;
    return { ...page, songs: ordered, confirmedCount: confirmed.length, indexable };
  }).sort((a, b) => compare(a.slug, b.slug));
}

/** Related artists share an anime tag (애니메이션:*) or the vocaloid tag; strongest overlap first. */
export function relatedArtists(page, pages, limit = 6) {
  const tagsOf = target => new Set(target.songs.flatMap(song => song.tags.filter(tag => tag.startsWith('애니메이션:') || tag === '보컬로이드')));
  const own = tagsOf(page);
  if (!own.size) return [];
  return pages.filter(other => other.slug !== page.slug)
    .map(other => ({ other, score: [...tagsOf(other)].filter(tag => own.has(tag)).length }))
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score || b.other.confirmedCount - a.other.confirmedCount || compare(a.other.slug, b.other.slug))
    .slice(0, limit).map(item => item.other);
}

export const artistHref = slug => `/artists/${slug}/`;
