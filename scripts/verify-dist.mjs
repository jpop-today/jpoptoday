#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { lstat, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const origin = 'https://jpop.today';
const songFields = ['id', 'titleOriginal', 'titleKo', 'artistOriginal', 'artistKo', 'tags', 'availability', 'origin', 'karaoke'];
const numberFields = ['status', 'observedNumber', 'conflict'];
const metadataFields = ['schemaVersion', 'sourceSha', 'legacyRevision', 'catalogSha256', 'songCount', 'currentSongCount', 'dirty'];
const privateSegments = new Set(['.git', '.github', '.agents', '.codex', 'node_modules', 'data', 'raw', 'staging', 'contracts', 'scripts', 'tests', 'docs', 'src']);
const decodeUtf8 = bytes => new TextDecoder('utf-8', { fatal: true }).decode(bytes);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const fullSha = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const nonempty = value => typeof value === 'string' && value.trim().length > 0;

function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}

function exactFields(value, expected, context) {
  requireCondition(value && typeof value === 'object' && !Array.isArray(value), `${context}: expected an object`);
  requireCondition(isDeepStrictEqual(Object.keys(value).sort(), [...expected].sort()), `${context}: missing or unapproved public fields`);
}

async function readText(file, context) {
  try { return decodeUtf8(await readFile(file)); }
  catch (error) { throw new Error(`${context}: cannot read valid UTF-8 (${error.message})`); }
}

function parseJson(text, context) {
  try { return JSON.parse(text); }
  catch { throw new Error(`${context}: invalid JSON`); }
}

async function walk(directory, relative = '') {
  const info = await lstat(directory);
  requireCondition(!info.isSymbolicLink(), `${relative || 'dist'}: symbolic links are forbidden`);
  requireCondition(info.isDirectory(), `${relative || 'dist'}: expected a directory`);
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const child = relative ? `${relative}/${entry.name}` : entry.name;
    requireCondition(!privateSegments.has(entry.name.toLowerCase()) && !entry.name.startsWith('.'), `${child}: private or hidden path is forbidden`);
    const file = path.join(directory, entry.name);
    const stat = await lstat(file);
    requireCondition(!stat.isSymbolicLink(), `${child}: symbolic links are forbidden`);
    if (stat.isDirectory()) files.push(...await walk(file, child));
    else {
      requireCondition(stat.isFile(), `${child}: only regular files may be published`);
      const permitted = ['_headers', '_redirects', 'robots.txt', 'catalog.json', 'build-info.json'].includes(child)
        || child.endsWith('.html')
        || /^_astro\/[A-Za-z0-9_.-]+\.(?:css|js)$/.test(child);
      requireCondition(permitted, `${child}: unapproved artifact file type or location`);
      files.push(child);
    }
  }
  return files;
}

function publicProjection(staging) {
  requireCondition(staging?.stagingVersion === 1 && staging.purpose === 'legacy-catalog-staging', 'staging: unsupported input');
  requireCondition(Array.isArray(staging.songs) && staging.songs.length === 3317, 'staging: expected all 3,317 legacy IDs');
  const shared = { tj: new Map(), ky: new Map() };
  for (const song of staging.songs) {
    for (const provider of ['tj', 'ky']) {
      const number = song.karaoke?.[provider]?.observedNumber;
      if (!number) continue;
      if (!shared[provider].has(number)) shared[provider].set(number, new Set());
      shared[provider].get(number).add(song.id);
    }
  }
  return staging.songs.map(song => ({
    ...Object.fromEntries(songFields.filter(field => field !== 'karaoke').map(field => [field, song[field]])),
    karaoke: Object.fromEntries(['tj', 'ky'].map(provider => [provider, {
      status: song.karaoke[provider].status,
      observedNumber: song.karaoke[provider].observedNumber,
      conflict: (shared[provider].get(song.karaoke[provider].observedNumber)?.size ?? 0) > 1,
    }])),
  }));
}

function verifyCatalog(catalog, expected) {
  exactFields(catalog, ['version', 'songs'], 'catalog.json');
  requireCondition(catalog.version === 1 && Array.isArray(catalog.songs), 'catalog.json: unsupported public read model');
  const expectedById = new Map(expected.map(song => [song.id, song]));
  requireCondition(expectedById.size === expected.length, 'staging: duplicate legacy ID');
  requireCondition(catalog.songs.length === expected.length, 'catalog.json: legacy ID count changed');
  const seen = new Set();
  for (const song of catalog.songs) {
    exactFields(song, songFields, 'catalog song');
    requireCondition(nonempty(song.id) && !/[\\/\u0000-\u001f]/.test(song.id) && !['.', '..'].includes(song.id), 'catalog song: unsafe stable ID');
    requireCondition(!seen.has(song.id), `catalog.json: duplicate ID ${song.id}`);
    seen.add(song.id);
    for (const field of ['titleOriginal', 'artistOriginal']) requireCondition(nonempty(song[field]), `${song.id}: missing ${field}`);
    for (const field of ['titleKo', 'artistKo']) requireCondition(typeof song[field] === 'string', `${song.id}: invalid ${field}`);
    requireCondition(Array.isArray(song.tags) && song.tags.every(nonempty), `${song.id}: invalid tags`);
    requireCondition(['current', 'archived'].includes(song.availability), `${song.id}: invalid availability`);
    requireCondition(['playlist', 'chart-only'].includes(song.origin), `${song.id}: invalid origin`);
    exactFields(song.karaoke, ['tj', 'ky'], `${song.id}: karaoke`);
    for (const provider of ['tj', 'ky']) {
      const entry = song.karaoke[provider];
      exactFields(entry, numberFields, `${song.id}: ${provider}`);
      requireCondition(typeof entry.conflict === 'boolean', `${song.id}: ${provider} conflict must be boolean`);
      requireCondition(entry.status === 'observed-unverified' || entry.status === 'unknown', `${song.id}: ${provider} cannot claim verified status`);
      requireCondition(entry.status === 'unknown' ? entry.observedNumber === null && !entry.conflict : typeof entry.observedNumber === 'string' && /^[0-9]{1,10}$/.test(entry.observedNumber), `${song.id}: ${provider} invalid observed number`);
    }
    requireCondition(expectedById.has(song.id) && isDeepStrictEqual(song, expectedById.get(song.id)), `${song.id}: public fields differ from the staging projection`);
  }
  requireCondition(catalog.songs.filter(song => song.availability === 'current').length === 3313, 'catalog.json: expected 3,313 current IDs and four archived IDs');
}

function decodeEntities(value) {
  return value.replace(/&(#x[0-9a-f]+|#[0-9]+|amp|lt|gt|quot|apos|nbsp);/gi, (entity, name) => {
    if (name[0] === '#') {
      const codepoint = name[1].toLowerCase() === 'x' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return codepoint <= 0x10ffff ? String.fromCodePoint(codepoint) : entity;
    }
    return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }[name.toLowerCase()];
  });
}

function attributes(tag) {
  const result = {};
  for (const match of tag.matchAll(/([^\s=<>/]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)) {
    result[match[1].toLowerCase()] = decodeEntities(match[2] ?? match[3] ?? match[4]);
  }
  return result;
}

function normalized(value) { return value.replace(/\s+/g, ' ').trim(); }

function canonicalFor(file) {
  const route = file === 'index.html' ? '' : file.endsWith('/index.html') ? file.slice(0, -'index.html'.length) : file;
  return `${origin}/${route.split('/').map(encodeURIComponent).join('/')}`;
}

function verifyHtml(html, file, song, canonicals) {
  const canonicalsOnPage = [...html.matchAll(/<link\b[^>]*>/gi)].map(match => attributes(match[0])).filter(attr => attr.rel?.toLowerCase().split(/\s+/).includes('canonical'));
  requireCondition(canonicalsOnPage.length === 1 && canonicalsOnPage[0].href === canonicalFor(file), `${file}: canonical must match the encoded static route`);
  requireCondition(!canonicals.has(canonicalsOnPage[0].href), `${file}: duplicate canonical`);
  canonicals.add(canonicalsOnPage[0].href);
  const robots = [...html.matchAll(/<meta\b[^>]*>/gi)].map(match => attributes(match[0])).filter(attr => attr.name?.toLowerCase() === 'robots');
  requireCondition(robots.length === 1 && /(?:^|[,\s])noindex(?:$|[,\s])/i.test(robots[0].content ?? ''), `${file}: preview must have one robots noindex meta tag`);
  const title = normalized(decodeEntities(/<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? ''));
  requireCondition(title.length > 0, `${file}: missing document title`);
  requireCondition(!/<(?:img|image|picture)\b/i.test(html), `${file}: image elements are outside this preview's public boundary`);
  for (const match of html.matchAll(/<script\b[^>]*>/gi)) {
    const src = attributes(match[0]).src;
    if (src) requireCondition(/^\/_astro\/[A-Za-z0-9_.-]+\.js$/.test(src), `${file}: scripts must use local /_astro JavaScript assets`);
  }
  if (!song) return;
  const body = /<body\b[^>]*>([\s\S]*?)<\/body>/i.exec(html)?.[1];
  requireCondition(body !== undefined, `${file}: missing static body`);
  const text = normalized(decodeEntities(body.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '').replace(/<!--([\s\S]*?)-->/g, '').replace(/<[^>]*>/g, ' ')));
  for (const field of ['titleOriginal', 'artistOriginal']) requireCondition(text.includes(normalized(song[field])), `${file}: ${field} is absent from the static body`);
  requireCondition(title.includes(normalized(song.titleOriginal)), `${file}: title does not identify the song`);
  for (const provider of ['tj', 'ky']) {
    const number = song.karaoke[provider].observedNumber;
    if (number) requireCondition(text.includes(number), `${file}: ${provider} observed number is absent from the static body`);
  }
  if (['tj', 'ky'].some(provider => song.karaoke[provider].observedNumber)) requireCondition(text.includes('관측') && text.includes('확인'), `${file}: observed numbers need a visible verification notice`);
  if (song.availability === 'archived') requireCondition(text.includes('보관'), `${file}: archived status must be visible`);
}

function verifyHeaders(headers, robots) {
  const lines = headers.split(/\r?\n/);
  const rule = lines.findIndex(line => line.trim() === '/*');
  requireCondition(rule >= 0, '_headers: missing /* preview rule');
  const values = [];
  for (const line of lines.slice(rule + 1)) {
    if (line.trim() && !/^\s/.test(line) && !/^#/.test(line)) break;
    values.push(line);
  }
  requireCondition(values.some(line => /^\s+X-Robots-Tag\s*:\s*.*\bnoindex\b/i.test(line)), '_headers: /* must set X-Robots-Tag: noindex');
  const group = /(?:^|\n)\s*User-agent:\s*\*\s*(?:\r?\n)([\s\S]*?)(?=(?:^|\n)\s*User-agent:|$)/im.exec(robots)?.[1];
  requireCondition(group && /^\s*Disallow:\s*\/\s*$/im.test(group) && !/^\s*Allow:\s*\S/im.test(group), 'robots.txt: preview must disallow / for all crawlers');
}

function verifyPrivateBoundary(text, file) {
  requireCondition(!/(?:jpop-playlist\.raw|legacy-catalog\.json|legacy-identity-baseline)/i.test(text), `${file}: private staging or evidence payload is forbidden`);
  const fields = /(["'](?:stagingVersion|unresolvedAliases|evidence|refs)["']|\b(?:stagingVersion|unresolvedAliases|evidence|refs))\s*:/gi;
  for (const match of text.matchAll(fields)) {
    const field = match[1].replace(/["']/g, '');
    // The reviewed-alias resolver returns evidence from its argument. It is
    // executable compatibility code, not a serialized evidence record. Only
    // this unquoted same-property member access is permitted in JS assets;
    // quoted keys and literal/object/array values remain forbidden everywhere.
    const runtimeMember = file.endsWith('.js') && !/["']/.test(match[1])
      && ['evidence', 'refs'].includes(field)
      && new RegExp(`^\\s*[$A-Z_a-z][$\\w]*\\.${field}\\s*(?=[,}])`).test(text.slice(match.index + match[0].length));
    requireCondition(runtimeMember, `${file}: private staging or evidence payload is forbidden`);
  }
}

/** Validate a built preview; this function never writes or publishes files. */
export async function verifyDist({ distPath = path.join(projectRoot, 'dist'), stagingPath = path.join(projectRoot, 'data/staging/legacy-catalog.json'), expectedSourceSha = process.env.GITHUB_SHA } = {}) {
  const directory = path.resolve(distPath);
  const files = await walk(directory);
  const fileSet = new Set(files);
  for (const required of ['index.html', '404.html', 'catalog.json', 'build-info.json', '_headers', 'robots.txt']) requireCondition(fileSet.has(required), `dist: missing ${required}; run the complete build first`);
  const staging = parseJson(await readText(stagingPath, 'staging'), 'staging');
  const catalogText = await readText(path.join(directory, 'catalog.json'), 'catalog.json');
  const catalog = parseJson(catalogText, 'catalog.json');
  verifyCatalog(catalog, publicProjection(staging));
  const metadata = parseJson(await readText(path.join(directory, 'build-info.json'), 'build-info.json'), 'build-info.json');
  exactFields(metadata, metadataFields, 'build-info.json');
  requireCondition(metadata.schemaVersion === 1 && fullSha(metadata.sourceSha), 'build-info.json: sourceSha must be a full lowercase commit SHA');
  requireCondition(!expectedSourceSha || metadata.sourceSha === expectedSourceSha, 'build-info.json: sourceSha differs from the CI source SHA');
  requireCondition(metadata.legacyRevision === staging.revision && fullSha(metadata.legacyRevision), 'build-info.json: legacy revision differs from staging');
  requireCondition(metadata.catalogSha256 === digest(Buffer.from(catalogText)), 'build-info.json: catalog bytes do not match catalogSha256');
  requireCondition(metadata.songCount === catalog.songs.length && metadata.currentSongCount === 3313 && typeof metadata.dirty === 'boolean', 'build-info.json: invalid counts or dirty flag');
  if (expectedSourceSha) requireCondition(metadata.dirty === false, 'build-info.json: CI build must use a clean source tree');
  const songByFile = new Map(catalog.songs.map(song => [`songs/${song.id}/index.html`, song]));
  for (const file of songByFile.keys()) requireCondition(fileSet.has(file), `${file}: missing static legacy detail`);
  requireCondition(files.filter(file => file.startsWith('songs/')).length === songByFile.size, 'songs/: expected exactly one static detail file per legacy ID');
  const canonicals = new Set();
  let htmlCount = 0;
  for (const file of files) {
    const text = await readText(path.join(directory, file), file);
    requireCondition(!/(?:adsbygoogle|googlesyndication\.com|doubleclick\.net|googleadservices\.com)/i.test(text), `${file}: advertising code is forbidden in this preview`);
    verifyPrivateBoundary(text, file);
    requireCondition(!/(?:["'](?:lyrics|lyric|imageUrl|image_url|thumbnailUrl)["']|\b(?:lyrics|lyric|imageUrl|image_url|thumbnailUrl))\s*:/i.test(text) && !/url\(\s*["']?\s*(?:https?:)?\/\//i.test(text), `${file}: lyrics or external image payload is forbidden`);
    if (file.endsWith('.html')) {
      verifyHtml(text, file, songByFile.get(file), canonicals);
      htmlCount += 1;
    }
  }
  verifyHeaders(await readText(path.join(directory, '_headers'), '_headers'), await readText(path.join(directory, 'robots.txt'), 'robots.txt'));
  return { sourceSha: metadata.sourceSha, dirty: metadata.dirty, files: files.length, htmlPages: htmlCount, songs: catalog.songs.length, currentSongs: 3313, archivedSongs: 4 };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    requireCondition(process.argv.length <= 3, 'Usage: node scripts/verify-dist.mjs [dist-directory]');
    const result = await verifyDist({ distPath: process.argv[2] ? path.resolve(process.argv[2]) : undefined });
    console.log(`Verified preview artifact: ${result.songs} static songs (${result.currentSongs} current, ${result.archivedSongs} archived), ${result.htmlPages} noindex HTML pages, ${result.files} files; source ${result.sourceSha}${result.dirty ? ' (dirty local build)' : ''}`);
  } catch (error) {
    console.error(`Artifact verification failed: ${error.message}`);
    process.exitCode = 1;
  }
}
