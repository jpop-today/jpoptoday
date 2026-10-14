/** Browse already-validated ADR-006 public songs without claiming artist identity aliases. */
import { createHash } from 'node:crypto';
import { officialLookupMatches } from './provider-corrections.mjs';

const nonempty = value => typeof value === 'string' && Boolean(value.trim());
const eligible = song => song?.availability === 'current' && song.origin === 'playlist';
const compare = (left, right) => left < right ? -1 : left > right ? 1 : 0;

/** Dates/identity are validated by the ledger before projection; this cannot verify a song. */
export function confirmedNumbers(song) {
  if (!eligible(song)) return [];
  return ['tj', 'ky'].flatMap(provider => {
    const value = song.karaoke?.[provider], evidence = value?.evidence;
    if (value?.status !== 'provider-confirmed' || value.conflict !== false ||
        !evidence || !['checkedAt', 'title', 'artist'].every(key => nonempty(evidence[key])) ||
        !officialLookupMatches(evidence.url, provider, value.observedNumber)) return [];
    return [{ provider, number: value.observedNumber, evidence: { ...evidence } }];
  });
}

export function buildConfirmedArtistGroups(songs) {
  if (!Array.isArray(songs)) throw new Error('Expected validated public songs');
  const seen = new Set(), groups = new Map();
  for (const song of songs) {
    if (!nonempty(song?.id) || seen.has(song.id)) throw new Error('Invalid or duplicate song ID');
    seen.add(song.id);
    if (!confirmedNumbers(song).length) continue;
    if (!nonempty(song.artistOriginal)) throw new Error('Confirmed song has no artist label');
    // Exact strings preserve different performer/feature/version labels. No inferred aliases.
    const name = song.artistOriginal;
    if (!groups.has(name)) groups.set(name, {
      id: 'artist-' + createHash('sha256').update(name, 'utf8').digest('hex').slice(0, 16),
      name, namesKo: [], songs: [],
    });
    const group = groups.get(name);
    if (nonempty(song.artistKo) && !group.namesKo.includes(song.artistKo)) group.namesKo.push(song.artistKo);
    group.songs.push(song);
  }
  return [...groups.values()].sort((a, b) => compare(a.name, b.name)).map(group => ({
    ...group, namesKo: group.namesKo.sort(compare),
    songs: group.songs.sort((a, b) => compare(a.id, b.id)),
  }));
}
