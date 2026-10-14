import type { Song, Provider } from '../src/lib/catalog';
export type ConfirmedNumber = {
  provider: 'tj' | 'ky'; number: string; evidence: NonNullable<Provider['evidence']>;
};
export type ConfirmedArtistGroup = { id: string; name: string; namesKo: string[]; songs: Song[] };
export function confirmedNumbers(song: Song): ConfirmedNumber[];
export function buildConfirmedArtistGroups(songs: Song[]): ConfirmedArtistGroup[];
