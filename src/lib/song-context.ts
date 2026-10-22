import chart from '../../data/chart-snapshot.json';
import metadata from '../../data/reviewed/song-metadata.json';
import { songs, artistPages, type Song, type ArtistPage } from './catalog';
import { confirmedNumbers } from '../../contracts/public-catalog.mjs';

export type SongMetadata = { releaseYear?: number; album?: string; tieup?: string; source: string };
type MetadataEntry = SongMetadata & { songId: string };

// Only sourced values are shown; an entry without a source URL is a data error, not a blank.
const metadataById = new Map((metadata.entries as MetadataEntry[]).map(entry => {
  if (!/^https:\/\//.test(entry.source ?? '')) throw new Error(`song-metadata ${entry.songId}: source URL required`);
  return [entry.songId, entry];
}));
const pageByLabel = new Map(artistPages.flatMap(page => page.labels.map(label => [label, page] as const)));
const chartRank = new Map(chart.songs.map(row => [row.canonicalId, row.rank]));
const byId = new Map(songs.map(song => [song.id, song]));

export const artistPageFor = (song: Song): ArtistPage | undefined => pageByLabel.get(song.artistOriginal);
export const metadataFor = (song: Song): SongMetadata | undefined => metadataById.get(song.id);
export const isConfirmed = (song: Song) => confirmedNumbers(song).length > 0;

/** Same artist page, confirmed songs first (page order), excluding the song itself. */
export function sameArtistSongs(song: Song, limit = 5): Song[] {
  const page = artistPageFor(song);
  return page ? page.songs.filter(other => other.id !== song.id).slice(0, limit) : [];
}

/** Up to `limit` songs ranked closest to this one in the archived TJ chart. */
export function chartNeighbors(song: Song, limit = 5): { song: Song; rank: number }[] {
  const rank = chartRank.get(song.id);
  if (!rank) return [];
  return chart.songs.filter(row => row.canonicalId !== song.id)
    .sort((a, b) => Math.abs(a.rank - rank) - Math.abs(b.rank - rank) || a.rank - b.rank)
    .slice(0, limit).sort((a, b) => a.rank - b.rank)
    .map(row => ({ song: byId.get(row.canonicalId)!, rank: row.rank }));
}
export const chartRankFor = (song: Song) => chartRank.get(song.id);

/** First paragraph of a published intro (plain text), for quoting on song pages. */
export function introExcerpt(page: ArtistPage | undefined): string | null {
  if (!page?.intro || page.intro.draft || !page.intro.body) return null;
  const first = page.intro.body.split(/\n\s*\n/)[0].replace(/[*_`>#\[\]]/g, '').replace(/\(([^)]*)\)/g, '').trim();
  return first || null;
}

export function songJsonLd(song: Song, page: ArtistPage | undefined, meta: SongMetadata | undefined) {
  const origin = 'https://jpop.today';
  const url = `${origin}/songs/${encodeURIComponent(song.id)}/`;
  const artistUrl = page ? `${origin}/artists/${page.slug}/` : undefined;
  const recording: Record<string, unknown> = {
    '@context': 'https://schema.org', '@type': 'MusicRecording', name: song.titleOriginal, url,
    byArtist: { '@type': 'MusicGroup', name: page?.name ?? song.artistOriginal, ...(artistUrl ? { url: artistUrl } : {}) },
  };
  if (song.titleKo) recording.alternateName = song.titleKo;
  if (meta?.releaseYear) recording.datePublished = String(meta.releaseYear);
  if (meta?.album) recording.inAlbum = { '@type': 'MusicAlbum', name: meta.album };
  const crumbs = [{ name: 'jpop.today', item: `${origin}/` }, { name: '가수별 확인곡', item: `${origin}/artists/` },
    ...(page && artistUrl ? [{ name: page.name, item: artistUrl }] : []), { name: song.titleOriginal, item: url }];
  const breadcrumb = { '@context': 'https://schema.org', '@type': 'BreadcrumbList',
    itemListElement: crumbs.map((crumb, index) => ({ '@type': 'ListItem', position: index + 1, ...crumb })) };
  // Escape "<" so a title can never close the script element.
  return JSON.stringify([recording, breadcrumb]).replace(/</g, '\\u003c');
}
