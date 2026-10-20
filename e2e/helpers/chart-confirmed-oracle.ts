/** Test-only reference model. It imports no application or contract predicate.
 * Keep raw/ledger membership separate from the public projection under test.
 * Synthetic edge cases live in tests/chart-both-artifact.test.mjs.
 */
export type Provider = 'tj' | 'ky';
type Evidence = { url: string; checkedAt: string; title: string; artist: string };
type SongInput = {
  id: string; origin: string; availability: string;
  karaoke: Record<Provider, {
    observedNumber: string | null; status?: string; conflict?: boolean; evidence?: Evidence | null;
  }>;
};
type ReviewEntry = {
  songId: string; provider: Provider; action: string; number: string | null; evidence?: Evidence | null;
};

export function numericEvidence(provider: Provider, number: string | null, evidence?: Evidence | null) {
  if (typeof number !== 'string' || !/^[0-9]{1,10}$/.test(number) || /^0+$/.test(number)
      || !evidence || !['url', 'checkedAt', 'title', 'artist'].every(key => typeof evidence[key as keyof Evidence] === 'string' && evidence[key as keyof Evidence].trim())
      || !Number.isFinite(Date.parse(evidence.checkedAt)) || /[\s\\#]/.test(evidence.url)) return false;
  let url: URL;
  try { url = new URL(evidence.url); } catch { return false; }
  const prefix = provider === 'tj'
    ? /^https:\/\/(?:www\.)?tjmedia\.com\/song\/accompaniment_search\?/
    : /^https:\/\/(?:www\.)?kygabang\.com\/chart\/search_list\.php\?/;
  if (!prefix.test(evidence.url) || url.protocol !== 'https:' || url.username || url.password || url.port || url.hash) return false;
  const namespace = url.searchParams.get('nationType');
  const expected: Record<string, string | null> = provider === 'tj'
    ? { nationType: namespace, strType: '16', searchTxt: number, strWord: 'Y' }
    : { mode: 'SongSearch', val: number };
  const pairs = [...url.searchParams];
  return (provider !== 'tj' || ['JPN', 'KOR'].includes(namespace ?? ''))
    && pairs.length === Object.keys(expected).length && new Set(pairs.map(([key]) => key)).size === pairs.length
    && pairs.every(([key, value]) => Object.hasOwn(expected, key) && expected[key] === value);
}

export function rawProviderIds(songs: readonly SongInput[], entries: readonly ReviewEntry[], provider: Provider) {
  const corrections = new Map(entries.map(entry => [JSON.stringify([entry.songId, entry.provider]), entry]));
  const counts = new Map<string, number>();
  for (const song of songs) {
    const entry = corrections.get(JSON.stringify([song.id, provider]));
    const number = entry ? entry.number : song.karaoke[provider].observedNumber;
    if (number !== null) counts.set(number, (counts.get(number) ?? 0) + 1);
  }
  return new Set(songs.filter(song => {
    const entry = corrections.get(JSON.stringify([song.id, provider]));
    return song.origin === 'playlist' && song.availability === 'current' && entry?.action === 'confirm'
      && numericEvidence(provider, entry.number, entry.evidence) && counts.get(entry.number!) === 1;
  }).map(song => song.id));
}

export function publicProviderIds(songs: readonly SongInput[], provider: Provider) {
  return new Set(songs.filter(song => song.origin === 'playlist' && song.availability === 'current'
    && song.karaoke[provider].status === 'provider-confirmed' && song.karaoke[provider].conflict === false
    && numericEvidence(provider, song.karaoke[provider].observedNumber, song.karaoke[provider].evidence)).map(song => song.id));
}
