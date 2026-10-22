/** Reviewed production routes; every preview remains noindex and ad-free. */
export function buildTarget(value = process.env.JPOP_BUILD_TARGET ?? 'preview') {
  if (!['preview', 'production'].includes(value)) throw new Error('Invalid JPOP_BUILD_TARGET');
  return value;
}
export function indexableSong(song) {
  return song?.availability === 'current' && ['tj', 'ky'].some(provider =>
    song.karaoke[provider].status === 'provider-confirmed' &&
    song.karaoke[provider].evidence && !song.karaoke[provider].conflict);
}
/** `record` is the song for /songs/{id}/ and the artist page (contracts/artists.mjs) for /artists/{slug}/. */
export function indexableRoute(pathname, record) {
  if (pathname.startsWith('/songs/')) return Boolean(indexableSong(record));
  if (/^\/artists\/[a-z0-9-]+\/$/.test(pathname)) return record?.indexable === true;
  return ['/', '/about/', '/contact/', '/privacy/', '/faq/', '/coverage/', '/chart/', '/guides/', '/artists/'].includes(pathname)
    || /^\/guides\/[a-z0-9-]+\/$/.test(pathname);
}
export function robotsFor(target, pathname, record) {
  return buildTarget(target) === 'production' && indexableRoute(pathname, record) ? 'index, follow' : 'noindex, follow';
}
