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
export function indexableRoute(pathname, song) {
  if (pathname.startsWith('/songs/')) return Boolean(indexableSong(song));
  return ['/', '/about/', '/contact/', '/privacy/', '/faq/', '/coverage/', '/chart/', '/guides/'].includes(pathname)
    || /^\/guides\/[a-z0-9-]+\/$/.test(pathname);
}
export function robotsFor(target, pathname, song) {
  return buildTarget(target) === 'production' && indexableRoute(pathname, song) ? 'index, follow' : 'noindex, follow';
}
