/** Explicit legacy observation projection; never a verified catalog v1. */
export function buildPublicCatalog(staging) {
  if (staging?.stagingVersion !== 1 || staging.purpose !== 'legacy-catalog-staging' ||
      !Array.isArray(staging.songs) || !staging.songs.length || !Array.isArray(staging.unresolvedAliases))
    throw new Error('A nonempty legacy staging snapshot is required');
  const ids = new Set();
  const conflicts = new Set(staging.unresolvedAliases.flatMap(group => group.ids.map(id => `${group.provider}:${id}`)));
  const songs = staging.songs.map(song => {
    if (typeof song.id !== 'string' || !song.id || ids.has(song.id) || /[\u0000-\u001f/\\]/u.test(song.id)) throw new Error('Invalid or duplicate public ID');
    ids.add(song.id);
    for (const field of ['titleOriginal', 'titleKo', 'artistOriginal', 'artistKo'])
      if (typeof song[field] !== 'string') throw new Error(`Invalid ${field}`);
    if (!['current', 'archived'].includes(song.availability) || !Array.isArray(song.tags) || song.tags.some(tag => typeof tag !== 'string'))
      throw new Error('Invalid public song metadata');
    const karaoke = {};
    for (const provider of ['tj', 'ky']) {
      const value = song.karaoke?.[provider];
      if (!value || !['observed-unverified', 'unknown'].includes(value.status) || value.evidence !== null ||
          (value.status === 'unknown' ? value.observedNumber !== null : typeof value.observedNumber !== 'string' || !/^\d+$/.test(value.observedNumber)))
        throw new Error('Invalid legacy provider observation');
      karaoke[provider] = { status: value.status, observedNumber: value.observedNumber, conflict: conflicts.has(`${provider}:${song.id}`) };
    }
    return { id: song.id, titleOriginal: song.titleOriginal, titleKo: song.titleKo, artistOriginal: song.artistOriginal,
      artistKo: song.artistKo, tags: [...song.tags], availability: song.availability, origin: song.origin, karaoke };
  });
  if (staging.summary?.totalIds !== ids.size) throw new Error('Incomplete staging snapshot');
  return { version: 1, songs };
}

export const normalizeSearch = value => String(value).normalize('NFKC').toLocaleLowerCase('ja').replace(/\s+/g, ' ').trim();
export function songHref(id) { return '/songs/' + encodeURIComponent(id) + '/'; }
export function matchesSong(song, params) {
  const text = normalizeSearch([song.titleOriginal, song.titleKo, song.artistOriginal, song.artistKo,
    song.karaoke.tj.observedNumber, song.karaoke.ky.observedNumber, ...song.tags].join(' '));
  if (!normalizeSearch(params.get('q') ?? '').split(' ').filter(Boolean).every(term => text.includes(term))) return false;
  const tj = Boolean(song.karaoke.tj.observedNumber), ky = Boolean(song.karaoke.ky.observedNumber);
  if (!params.getAll('number').every(value => ({ 'has-tj': tj, 'has-ky': ky, 'only-tj': tj && !ky, 'only-ky': ky && !tj })[value] ?? true)) return false;
  const tags = [...song.tags, ...(song.artistKo ? ['가수:' + song.artistKo] : [])];
  if (!params.getAll('tag').every(tag => tags.includes(tag))) return false;
  if (params.get('anime') === 'all' && !tags.some(tag => tag.startsWith('애니메이션:') || ['애니메이션', '애니', 'anime'].includes(normalizeSearch(tag)))) return false;
  if (params.get('artist') === 'all' && !tags.some(tag => tag.startsWith('가수:') || tag.startsWith('아티스트:'))) return false;
  return true;
}
