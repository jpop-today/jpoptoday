/** Produce mode-specific crawler files from the already-built, reviewed catalog. */
import { readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { robotsFor } from '../contracts/publication.mjs';
import { buildArtistPages, loadArtistIntros, loadSongClassification } from '../contracts/artists.mjs';
const dist = new URL('../dist/', import.meta.url);
const info = JSON.parse(await readFile(new URL('build-info.json', dist), 'utf8'));
// The original seller declaration belongs only to the production origin.
if (info.target === 'preview') await rm(new URL('ads.txt', dist), { force: true });
const catalog = JSON.parse(await readFile(new URL('catalog.json', dist), 'utf8'));
const byId = new Map(catalog.songs.map(song => [song.id, song]));
const artistBySlug = new Map(buildArtistPages(catalog.songs, loadArtistIntros(), loadSongClassification()).map(page => [page.slug, page]));
const recordFor = route => (route.startsWith('/artists/') ? artistBySlug : byId).get(decodeURIComponent(route.split('/')[2] ?? ''));
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
await writeFile(new URL('sitemap.xml', dist), '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">' + indexed.map(route => `<url><loc>${escaped(urlFor(route))}</loc></url>`).join('') + '</urlset>\n');
const common = '/*\n  X-Content-Type-Options: nosniff\n  Referrer-Policy: strict-origin-when-cross-origin\n  Permissions-Policy: camera=(), microphone=(), geolocation=()\n';
await writeFile(new URL('_headers', dist), info.target === 'preview' ? common + '  X-Robots-Tag: noindex, nofollow\n' : common + '\n/catalog.json\n  X-Robots-Tag: noindex\n/build-info.json\n  X-Robots-Tag: noindex\n');
await writeFile(new URL('robots.txt', dist), info.target === 'preview' ? 'User-agent: *\nDisallow: /\n' : 'User-agent: *\nAllow: /\nSitemap: https://jpop.today/sitemap.xml\n');
console.log(`Crawler files: ${info.target}; ${indexed.length} reviewed sitemap routes`);
