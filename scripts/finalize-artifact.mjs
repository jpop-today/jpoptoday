/** Produce mode-specific crawler files from the already-built, reviewed catalog. */
import { readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { robotsFor } from '../contracts/publication.mjs';
import { buildArtistPages, loadArtistIntros, loadSongClassification } from '../contracts/artists.mjs';
import { loadGuides } from '../contracts/guides.mjs';
const dist = new URL('../dist/', import.meta.url);
const info = JSON.parse(await readFile(new URL('build-info.json', dist), 'utf8'));
// The original seller declaration belongs only to the production origin.
if (info.target === 'preview') await rm(new URL('ads.txt', dist), { force: true });
const catalog = JSON.parse(await readFile(new URL('catalog.json', dist), 'utf8'));
const byId = new Map(catalog.songs.map(song => [song.id, song]));
const artistBySlug = new Map(buildArtistPages(catalog.songs, loadArtistIntros(), loadSongClassification()).map(page => [page.slug, page]));
const guideBySlug = new Map(loadGuides().map(guide => [guide.slug, guide]));
const recordFor = route => (route.startsWith('/artists/') ? artistBySlug : route.startsWith('/guides/') ? guideBySlug : byId).get(decodeURIComponent(route.split('/')[2] ?? ''));
const routes = ['/'];
async function walk(directory, prefix = '') {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) await walk(new URL(`${entry.name}/`, directory), `${prefix}${entry.name}/`);
    else if (entry.name === 'index.html' && prefix) routes.push(`/${prefix}`);
  }
}
await walk(dist);
const indexed = routes.filter(route => robotsFor(info.target, route, recordFor(route)) === 'index, follow');
const escaped = value => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const urlFor = route => 'https://jpop.today' + route.split('/').map(encodeURIComponent).join('/');
const urlset = list => '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">' + list.map(route => `<url><loc>${escaped(urlFor(route))}</loc></url>`).join('') + '</urlset>\n';
// sitemap.xml is an index so song pages and editorial pages can be watched separately in Search Console.
const sitemaps = { 'sitemap-pages.xml': indexed.filter(route => !route.startsWith('/songs/')), 'sitemap-songs.xml': indexed.filter(route => route.startsWith('/songs/')) };
for (const [name, list] of Object.entries(sitemaps)) await writeFile(new URL(name, dist), urlset(list));
await writeFile(new URL('sitemap.xml', dist), '<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">' + Object.keys(sitemaps).map(name => `<sitemap><loc>https://jpop.today/${name}</loc></sitemap>`).join('') + '</sitemapindex>\n');
// The guide feed lists only guides this target indexes, newest review first.
const feedGuides = [...guideBySlug.values()].filter(guide => indexed.includes(`/guides/${guide.slug}/`))
  .sort((a, b) => (b.reviewedAt ?? '').localeCompare(a.reviewedAt ?? '') || a.slug.localeCompare(b.slug));
const feedItem = guide => `<item><title>${escaped(guide.title)}</title><link>${urlFor(`/guides/${guide.slug}/`)}</link><guid>${urlFor(`/guides/${guide.slug}/`)}</guid><description>${escaped(guide.description)}</description>${guide.reviewedAt ? `<pubDate>${new Date(`${guide.reviewedAt}T00:00:00+09:00`).toUTCString()}</pubDate>` : ''}</item>`;
await writeFile(new URL('guides/rss.xml', dist), '<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0"><channel><title>jpop.today 가이드</title><link>https://jpop.today/guides/</link><description>J-POP 노래방 번호 확인과 선곡 가이드</description><language>ko</language>' + feedGuides.map(feedItem).join('') + '</channel></rss>\n');
const common = '/*\n  X-Content-Type-Options: nosniff\n  Referrer-Policy: strict-origin-when-cross-origin\n  Permissions-Policy: camera=(), microphone=(), geolocation=()\n';
await writeFile(new URL('_headers', dist), info.target === 'preview' ? common + '  X-Robots-Tag: noindex, nofollow\n' : common + '\n/catalog.json\n  X-Robots-Tag: noindex\n/build-info.json\n  X-Robots-Tag: noindex\n');
await writeFile(new URL('robots.txt', dist), info.target === 'preview' ? 'User-agent: *\nDisallow: /\n' : 'User-agent: *\nAllow: /\nSitemap: https://jpop.today/sitemap.xml\n');
console.log(`Crawler files: ${info.target}; ${indexed.length} reviewed sitemap routes`);
