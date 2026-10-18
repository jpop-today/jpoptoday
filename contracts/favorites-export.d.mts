import type { Song } from '../src/lib/catalog';

/** Plain-text export of every matching saved song, preserving order and provider states. */
export function formatFavoritesExport(songs: readonly Song[]): string;
