import type { APIRequestContext } from '@playwright/test';

/** sitemap.xml is an index; route URLs live in its page and song children. */
export async function sitemapRoutes(request: APIRequestContext) {
  const parts = await Promise.all(['/sitemap-pages.xml', '/sitemap-songs.xml'].map(async path => (await request.get(path)).text()));
  return parts.join('');
}
