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
/** `record` is the song for /songs/{id}/, the artist page for /artists/{slug}/ and the guide for /guides/{slug}/. */
export function indexableRoute(pathname, record) {
  if (pathname.startsWith('/songs/')) return Boolean(indexableSong(record));
  if (/^\/(?:artists|guides)\/[a-z0-9-]+\/$/.test(pathname)) return record?.indexable === true;
  return ['/', '/about/', '/contact/', '/privacy/', '/faq/', '/coverage/', '/chart/', '/guides/', '/artists/'].includes(pathname);
}
export function robotsFor(target, pathname, record) {
  return buildTarget(target) === 'production' && indexableRoute(pathname, record) ? 'index, follow' : 'noindex, follow';
}

/**
 * Search Console / Naver ownership tokens come from the environment and appear only in production.
 * A malformed token fails the build instead of shipping a broken meta tag.
 */
export function siteVerification(target, env = process.env) {
  if (target !== 'production') return [];
  const tags = [['google-site-verification', env.GOOGLE_SITE_VERIFICATION], ['naver-site-verification', env.NAVER_SITE_VERIFICATION]];
  return tags.filter(([, value]) => value).map(([name, value]) => {
    if (!/^[A-Za-z0-9_-]{8,128}$/.test(value)) throw new Error(`${name}: invalid verification token`);
    return { name, content: value };
  });
}
