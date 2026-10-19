#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { lstat, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { buildPublicCatalog, hasConfirmedNumber } from '../contracts/public-catalog.mjs';
import { applyProviderCorrections } from '../contracts/provider-corrections.mjs';
import { buildTarget, robotsFor } from '../contracts/publication.mjs';
import { validateChartSnapshot } from './import-chart-snapshot.mjs';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const origin = 'https://jpop.today';
const songFields = ['id', 'titleOriginal', 'titleKo', 'artistOriginal', 'artistKo', 'tags', 'availability', 'origin', 'karaoke'];
const numberFields = ['status', 'observedNumber', 'conflict', 'evidence', 'correction'];
const metadataFields = ['schemaVersion', 'sourceSha', 'legacyRevision', 'catalogSha256', 'target', 'ledgerSha256', 'chartSha256', 'songCount', 'currentSongCount', 'dirty'];
const privateSegments = new Set(['.git', '.github', '.agents', '.codex', 'node_modules', 'data', 'raw', 'staging', 'contracts', 'scripts', 'tests', 'docs', 'src', 'reports', 'releases']);
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
      const permitted = ['_headers', '_redirects', 'robots.txt', 'catalog.json', 'build-info.json', 'sitemap.xml'].includes(child)
        || child.endsWith('.html')
        || /^_astro\/[A-Za-z0-9_.-]+\.(?:css|js)$/.test(child);
      requireCondition(permitted, `${child}: unapproved artifact file type or location`);
      files.push(child);
    }
  }
  return files;
}

function verifyCatalog(catalog, expected) {
  exactFields(catalog, ['version', 'songs'], 'catalog.json');
  requireCondition(catalog.version === 2 && Array.isArray(catalog.songs), 'catalog.json: unsupported public read model');
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
      requireCondition(['observed-unverified', 'provider-confirmed', 'unknown'].includes(entry.status), `${song.id}: ${provider} cannot claim verified status`);
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

function visibleText(html) {
  return normalized(decodeEntities(html.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '').replace(/<!--[\s\S]*?-->/g, '').replace(/<[^>]*>/g, ' ')));
}

/** Validate the rendered intersection, including visible counts and the usable AND link. */
export function verifyBothProviderDiscovery(html, songs) {
  // Static visibility only; computed CSS and keyboard behavior remain browser gates.
  const stack = [], voidTags = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
  html = html.replace(/<!--[\s\S]*?-->|<\/?[a-zA-Z][^>]*>|[^<]+|</g, token => {
    if (token.startsWith('<!--')) return '';
    const closing = /^<\/([\w:-]+)/.exec(token);
    if (closing) {
      const index = stack.findLastIndex(frame => frame.tag === closing[1].toLowerCase());
      const hidden = index >= 0 ? stack[index].hidden : stack.at(-1)?.hidden;
      if (index >= 0) stack.splice(index);
      return hidden ? '' : token;
    }
    const opening = /^<([\w:-]+)\b([\s\S]*?)>$/.exec(token);
    if (!opening) return stack.at(-1)?.hidden ? '' : token;
    const tag = opening[1].toLowerCase(), raw = opening[2], attrs = attributes(raw);
    const booleanAttrs = raw.replace(/"[^"]*"|'[^']*'/g, '');
    const hidden = Boolean(stack.at(-1)?.hidden || ['script', 'style', 'template'].includes(tag)
      || /(?:^|\s)(?:hidden|inert)(?:\s|=|\/|$)/i.test(booleanAttrs) || attrs['aria-hidden']?.toLowerCase() === 'true'
      || /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*(?:hidden|collapse)|content-visibility\s*:\s*hidden)\s*(?:!important)?\s*(?:;|$)/i.test(attrs.style ?? ''));
    if (!voidTags.has(tag) && !/\/\s*$/.test(raw)) stack.push({ tag, hidden });
    return hidden ? '' : token;
  });
  const groups = new Map(), seen = new Set();
  let total = 0;
  for (const song of songs) {
    requireCondition(!seen.has(song.id), 'artists: duplicate input ID');
    seen.add(song.id);
    const tj = hasConfirmedNumber(song, 'tj'), ky = hasConfirmedNumber(song, 'ky');
    if (!tj && !ky) continue;
    const id = 'artist-' + createHash('sha256').update(song.artistOriginal, 'utf8').digest('hex').slice(0, 16);
    if (!groups.has(id)) groups.set(id, { name: song.artistOriginal, both: 0 });
    if (tj && ky) { groups.get(id).both += 1; total += 1; }
  }
  const markers = body => [...body.matchAll(/<(dd|span)\b(?=[^>]*\bdata-provider-count=)([^>]*)>([\s\S]*?)<\/\1>/gi)]
    .map(match => ({ attrs: attributes(match[2]), text: visibleText(match[3]) }))
    .filter(marker => marker.attrs['data-provider'] === 'both');
  const check = (body, scope, expected) => {
    const values = markers(body).filter(marker => marker.attrs['data-provider-count'] === scope);
    requireCondition(values.length === 1, `artists: missing or duplicate ${scope} both count`);
    const value = values[0], digits = value.text.match(/[0-9][0-9,]*/g) ?? [];
    requireCondition(value.attrs['data-count'] === String(expected) && digits.length === 1
      && digits[0].replaceAll(',', '') === String(expected), `artists: ${scope} both count differs from strict ID intersection`);
  };
  check(html, 'global', total);
  const indexes = [...html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)]
    .map(match => ({ attrs: attributes(match[1]), body: match[2] }))
    .filter(item => item.attrs['data-artist-index'] !== undefined);
  const sections = [...html.matchAll(/<section\b([^>]*)>\s*<header\b[^>]*>([\s\S]*?)<\/header>/gi)]
    .map(match => ({ attrs: attributes(match[1]), body: match[2] }))
    .filter(item => item.attrs.id?.startsWith('artist-'));
  for (const [items, scope, key] of [[indexes, 'index', 'data-artist-index'], [sections, 'group', 'id']]) {
    requireCondition(items.length === groups.size && new Set(items.map(item => item.attrs[key])).size === groups.size,
      `artists: ${scope} groups differ from exact artist labels`);
    for (const item of items) {
      requireCondition(groups.has(item.attrs[key]), `artists: unexpected ${scope} artist`);
      const expected = groups.get(item.attrs[key]);
      if (scope === 'index') {
        requireCondition(item.attrs.href === '#' + item.attrs[key], 'artists: changed artist anchor');
        const name = /<span\b[^>]*>([^<]*)<\/span>/i.exec(item.body)?.[1];
        requireCondition(name !== undefined && visibleText(name) === normalized(expected.name), 'artists: changed visible index name');
      } else {
        const headings = [...item.body.matchAll(/<h2\b[^>]*>([\s\S]*?)<\/h2>/gi)];
        requireCondition(item.attrs['data-artist-name'] === expected.name && headings.length === 1
          && visibleText(headings[0][1]) === normalized(expected.name), 'artists: changed exact group name');
      }
      check(item.body, scope, expected.both);
    }
  }
  requireCondition(markers(html).length === 1 + groups.size * 2, 'artists: extra both counts');
  const links = [...html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)]
    .filter(match => /\bdata-confirmed-both-search(?:\s|=|$)/.test(match[1]));
  requireCondition(links.length === 1 && visibleText(links[0][2]), 'artists: missing or duplicate usable both search link');
  const link = new URL(attributes(links[0][1]).href, origin);
  requireCondition(link.origin === origin && link.pathname === '/search/' && !link.hash
    && [...link.searchParams.keys()].every(key => key === 'number')
    && isDeepStrictEqual(link.searchParams.getAll('number').sort(), ['confirmed-ky', 'confirmed-tj']), 'artists: both search link must require both providers');
  return { both: total, artists: groups.size };
}

/** Check the displayed number controls per provider, separately from historical evidence. */
export function verifyDetailNumbers(html, song, file = 'detail') {
  const group = /<div\b[^>]*class=["']detail-numbers["'][^>]*>([\s\S]*?)<\/div>/i.exec(html)?.[1];
  requireCondition(group !== undefined, `${file}: missing provider number sections`);
  const sections = [...group.matchAll(/<section\b[^>]*>([\s\S]*?)<\/section>/gi)].map(match => match[1]);
  requireCondition(sections.length === 2, `${file}: expected exactly two provider number sections`);
  for (const [index, provider] of ['tj', 'ky'].entries()) {
    const section = sections[index];
    const heading = visibleText(/<h2\b[^>]*>([\s\S]*?)<\/h2>/i.exec(section)?.[1] ?? '');
    requireCondition(heading === (provider === 'tj' ? 'TJ' : '금영'), `${file}: ${provider} section heading differs`);
    // Reviewed correction reasons and source links may retain the old number.
    // They cannot establish a current display/copy permission.
    const presentation = section.split(/<p\b[^>]*class=["']verification-note["']/i)[0];
    const text = visibleText(presentation);
    const copyTags = [...section.matchAll(/<[^>]+>/g)].map(match => ({ tag: match[0], attr: attributes(match[0]) }))
      .filter(({ tag }) => /\sdata-copy(?=\s|=|\/?>)/i.test(tag));
    const entry = song.karaoke[provider];
    if (entry.conflict) {
      requireCondition(text.includes('번호 충돌 · 재확인 필요') && text.includes('번호 표시와 복사를 보류') && text.includes('미수록을 뜻하지 않습니다'), `${file}: ${provider} conflict withholding notice is absent`);
      requireCondition(!/<button\b/i.test(section) && copyTags.length === 0 && !/공식 (?:검색에서 확인|확인)/.test(text), `${file}: ${provider} conflict exposes a copy control or official claim`);
      requireCondition(!entry.observedNumber || !text.includes(entry.observedNumber), `${file}: ${provider} conflict exposes its number`);
    } else if (entry.observedNumber) {
      const buttons = [...presentation.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/gi)];
      requireCondition(copyTags.length === 1 && /^<button\b/i.test(copyTags[0].tag) && copyTags[0].attr.type === 'button'
        && copyTags[0].attr['data-copy'] === entry.observedNumber && buttons.length === 1 && visibleText(buttons[0][2]) === entry.observedNumber,
      `${file}: ${provider} observed number or copy control differs`);
      requireCondition(text.includes(hasConfirmedNumber(song, provider) ? '공식 검색에서 확인' : '관측 번호 · 재확인 필요'), `${file}: ${provider} verification label differs`);
      requireCondition(hasConfirmedNumber(song, provider) || !/공식 (?:검색에서 확인|확인)/.test(text), `${file}: ${provider} unconfirmed official claim`);
    } else {
      const numericDisplay = [...presentation.matchAll(/<(p|span|strong|output|div)\b[^>]*>([\s\S]*?)<\/\1>/gi)]
        .some(match => /^[0-9]{1,10}$/.test(visibleText(match[2])));
      requireCondition(copyTags.length === 0 && !/<button\b/i.test(section) && !numericDisplay && !/공식 (?:검색에서 확인|확인)/.test(text) && text.includes('미수록을 뜻하지 않습니다'), `${file}: ${provider} unknown number boundary differs`);
    }
  }
}

function verifyHtml(html, file, song, canonicals, target) {
  const canonicalsOnPage = [...html.matchAll(/<link\b[^>]*>/gi)].map(match => attributes(match[0])).filter(attr => attr.rel?.toLowerCase().split(/\s+/).includes('canonical'));
  requireCondition(canonicalsOnPage.length === 1 && canonicalsOnPage[0].href === canonicalFor(file), `${file}: canonical must match the encoded static route`);
  requireCondition(!canonicals.has(canonicalsOnPage[0].href), `${file}: duplicate canonical`);
  canonicals.add(canonicalsOnPage[0].href);
  const robots = [...html.matchAll(/<meta\b[^>]*>/gi)].map(match => attributes(match[0])).filter(attr => attr.name?.toLowerCase() === 'robots');
  const route = file === 'index.html' ? '/' : file.endsWith('/index.html') ? '/' + file.slice(0, -'index.html'.length) : '/' + file;
  requireCondition(robots.length === 1 && robots[0].content === robotsFor(target, route, song), `${file}: robots meta differs from publication policy`);
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
  const text = visibleText(body);
  for (const field of ['titleOriginal', 'artistOriginal']) requireCondition(text.includes(normalized(song[field])), `${file}: ${field} is absent from the static body`);
  requireCondition(title.includes(normalized(song.titleOriginal)), `${file}: title does not identify the song`);
  verifyDetailNumbers(body, song, file);
  if (['tj', 'ky'].some(provider => song.karaoke[provider].observedNumber)) requireCondition(text.includes('관측') && text.includes('확인'), `${file}: observed numbers need a visible verification notice`);
  if (song.availability === 'archived') requireCondition(text.includes('보관'), `${file}: archived status must be visible`);
}

function verifyHeaders(headers, robots, target) {
  const lines = headers.split(/\r?\n/);
  const rule = lines.findIndex(line => line.trim() === '/*');
  requireCondition(rule >= 0, '_headers: missing /* preview rule');
  const values = [];
  for (const line of lines.slice(rule + 1)) {
    if (line.trim() && !/^\s/.test(line) && !/^#/.test(line)) break;
    values.push(line);
  }
  const blocked = values.some(line => /^\s+X-Robots-Tag\s*:\s*.*\bnoindex\b/i.test(line));
  requireCondition(blocked === (target === 'preview'), '_headers: incorrect blanket crawler boundary');
  const group = /(?:^|\n)\s*User-agent:\s*\*\s*(?:\r?\n)([\s\S]*?)(?=(?:^|\n)\s*User-agent:|$)/im.exec(robots)?.[1];
  requireCondition(group && (target === 'preview' ? /^\s*Disallow:\s*\/\s*$/im.test(group) && !/^\s*Allow:\s*\S/im.test(group) : /^\s*Allow:\s*\/\s*$/im.test(group) && !/^\s*Disallow:\s*\/\s*$/im.test(group) && robots.includes('Sitemap: https://jpop.today/sitemap.xml')), 'robots.txt: incorrect target policy');
}

function verifyPrivateBoundary(text, file) {
  requireCondition(!/(?:jpop-playlist\.raw|legacy-catalog\.json|legacy-identity-baseline)/i.test(text), `${file}: private staging or unreviewed evidence payload is forbidden`);
  requireCondition(!/responseSha256\s*["']?\s*:/i.test(text), `${file}: internal response hash is forbidden`);
  const fields = /(["'](?:stagingVersion|unresolvedAliases|evidence|refs)["']|\b(?:stagingVersion|unresolvedAliases|evidence|refs))\s*:/gi;
  for (const match of text.matchAll(fields)) {
    const field = match[1].replace(/["']/g, '');
    if (file === 'catalog.json' && field === 'evidence') continue; // exact reviewed projection was validated above
    // The reviewed-alias resolver returns evidence from its argument. It is
    // executable compatibility code, not a serialized evidence record. Only
    // this unquoted same-property member access is permitted in JS assets;
    // quoted keys and literal/object/array values remain forbidden everywhere.
    const runtimeMember = file.endsWith('.js') && !/["']/.test(match[1])
      && ['evidence', 'refs'].includes(field)
      && new RegExp(`^\\s*[$A-Z_a-z][$\\w]*\\.${field}\\s*(?=[,}])`).test(text.slice(match.index + match[0].length));
    requireCondition(runtimeMember, `${file}: private staging or unreviewed evidence payload is forbidden`);
  }
}

/** Validate a built preview; this function never writes or publishes files. */
export async function verifyDist({ distPath = path.join(projectRoot, 'dist'), stagingPath = path.join(projectRoot, 'data/staging/legacy-catalog.json'), expectedSourceSha = process.env.EXPECTED_SOURCE_SHA ?? process.env.GITHUB_SHA, expectedTarget = process.env.JPOP_BUILD_TARGET } = {}) {
  const directory = path.resolve(distPath);
  const files = await walk(directory);
  const fileSet = new Set(files);
  for (const required of ['index.html', '404.html', 'catalog.json', 'build-info.json', '_headers', 'robots.txt', 'artists/index.html', 'guides/title-artist-variants/index.html']) requireCondition(fileSet.has(required), `dist: missing ${required}; run the complete build first`);
  const staging = parseJson(await readText(stagingPath, 'staging'), 'staging');
  const catalogText = await readText(path.join(directory, 'catalog.json'), 'catalog.json');
  const catalog = parseJson(catalogText, 'catalog.json');
  const ledger = parseJson(await readText(path.join(projectRoot, 'data/reviewed/provider-corrections.json'), 'ledger'), 'ledger');
  const chart = parseJson(await readText(path.join(projectRoot, 'data/chart-snapshot.json'), 'chart'), 'chart');
  validateChartSnapshot(chart, staging);
  verifyCatalog(catalog, applyProviderCorrections(buildPublicCatalog(staging).songs, staging, ledger));
  const metadata = parseJson(await readText(path.join(directory, 'build-info.json'), 'build-info.json'), 'build-info.json');
  exactFields(metadata, metadataFields, 'build-info.json');
  requireCondition(metadata.schemaVersion === 2 && fullSha(metadata.sourceSha), 'build-info.json: sourceSha must be a full lowercase commit SHA');
  buildTarget(metadata.target);
  requireCondition(!expectedTarget || metadata.target === expectedTarget, 'build-info.json: target differs from required deployment target');
  requireCondition(metadata.ledgerSha256 === digest(JSON.stringify(ledger)) && metadata.chartSha256 === digest(JSON.stringify(chart)), 'build-info.json: pinned ledger/chart differs from build input');
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
      verifyHtml(text, file, songByFile.get(file), canonicals, metadata.target);
      if (file === 'artists/index.html') verifyBothProviderDiscovery(text, catalog.songs);
      htmlCount += 1;
    }
  }
  verifyHeaders(await readText(path.join(directory, '_headers'), '_headers'), await readText(path.join(directory, 'robots.txt'), 'robots.txt'), metadata.target);
  const sitemap = await readText(path.join(directory, 'sitemap.xml'), 'sitemap.xml');
  const expectedUrls = files.filter(file => file.endsWith('.html')).filter(file => {
    const route = file === 'index.html' ? '/' : file.endsWith('/index.html') ? '/' + file.slice(0, -'index.html'.length) : '/' + file;
    return robotsFor(metadata.target, route, songByFile.get(file)) === 'index, follow';
  }).map(canonicalFor).sort();
  const sitemapUrls = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map(match => decodeEntities(match[1])).sort();
  requireCondition(isDeepStrictEqual(sitemapUrls, expectedUrls), 'sitemap.xml: differs from reviewed indexable routes');
  return { sourceSha: metadata.sourceSha, target: metadata.target, indexedPages: expectedUrls.length, dirty: metadata.dirty, files: files.length, htmlPages: htmlCount, songs: catalog.songs.length, currentSongs: 3313, archivedSongs: 4 };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    requireCondition(process.argv.length <= 3, 'Usage: node scripts/verify-dist.mjs [dist-directory]');
    const result = await verifyDist({ distPath: process.argv[2] ? path.resolve(process.argv[2]) : undefined });
    console.log(`Verified ${result.target} artifact: ${result.songs} static songs (${result.currentSongs} current, ${result.archivedSongs} archived), ${result.htmlPages} HTML pages (${result.indexedPages} indexable), ${result.files} files; source ${result.sourceSha}${result.dirty ? ' (dirty local build)' : ''}`);
  } catch (error) {
    console.error(`Artifact verification failed: ${error.message}`);
    process.exitCode = 1;
  }
}
