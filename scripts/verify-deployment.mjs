#!/usr/bin/env node
/** Bounded, read-only origin verification against a previously verified artifact. */
import { createHash, randomUUID } from 'node:crypto';
import { open, readFile, lstat, link, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';

const fields = ['schemaVersion', 'target', 'sourceSha', 'legacyRevision', 'catalogSha256', 'ledgerSha256', 'chartSha256', 'songCount', 'currentSongCount', 'dirty'];
const codes = new Set(['INVALID_URL', 'INVALID_OPTIONS', 'INVALID_ARTIFACT', 'INVALID_METADATA', 'METADATA_MISMATCH', 'CATALOG_MISMATCH', 'BODY_MISMATCH', 'CF_EMAIL_MISMATCH', 'CRAWLER_MISMATCH', 'HTTP_STATUS', 'REDIRECT', 'REQUEST_TIMEOUT', 'DEADLINE_EXCEEDED', 'RESPONSE_TOO_LARGE', 'TRANSPORT_ERROR', 'OUTPUT_EXISTS', 'OUTPUT_WRITE_FAILED', 'PROXY_CONFIGURATION_ERROR', 'PROXY_RUNTIME_UNSUPPORTED']);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const sha = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const fail = code => { throw new DeploymentVerificationError(code); };
const requireValue = (condition, code) => { if (!condition) fail(code); };
const safeCode = error => error instanceof DeploymentVerificationError ? error.code : 'TRANSPORT_ERROR';

/** Never retain untrusted error messages, response bodies, headers or URLs. */
export class DeploymentVerificationError extends Error {
  constructor(code) {
    const safe = codes.has(code) ? code : 'TRANSPORT_ERROR';
    super(`Deployment verification failed: ${safe}`);
    this.name = 'DeploymentVerificationError';
    this.code = safe;
  }
}

export function validateDeploymentUrl(value, target) {
  requireValue(typeof value === 'string' && value.length < 512 && !/[\s\\]/.test(value), 'INVALID_URL');
  let url;
  try { url = new URL(value); } catch { fail('INVALID_URL'); }
  // Check the raw form as well: URL normalization must not conceal a path,
  // empty query/fragment, default port, uppercase host, or credentials.
  const preview = /^(?:[a-z0-9]+\.)?jpoptoday-preview\.pages\.dev$/;
  const production = /^(?:jpop\.today|[a-f0-9]{8}\.todayjpop\.pages\.dev)$/;
  requireValue(['preview', 'production'].includes(target), 'INVALID_OPTIONS');
  requireValue((target === 'preview' ? preview : production).test(url.hostname)
    && value === `https://${url.hostname}${value.endsWith('/') ? '/' : ''}`
    && url.pathname === '/' && !url.port && !url.username && !url.password && !url.search && !url.hash, 'INVALID_URL');
  return url.origin;
}

function metadata(bytes, code = 'INVALID_METADATA') {
  let value;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { fail(code); }
  requireValue(value && !Array.isArray(value) && isDeepStrictEqual(Object.keys(value).sort(), [...fields].sort()), code);
  requireValue(value.schemaVersion === 2 && sha(value.sourceSha) && sha(value.legacyRevision)
    && ['preview', 'production'].includes(value.target) && value.dirty === false
    && ['catalogSha256', 'ledgerSha256', 'chartSha256'].every(field => hash(value[field]))
    && Number.isSafeInteger(value.songCount) && value.songCount > 0
    && Number.isSafeInteger(value.currentSongCount) && value.currentSongCount >= 0 && value.currentSongCount <= value.songCount, code);
  return value;
}

async function localBytes(root, relative, limit) {
  const file = path.join(root, relative);
  let stat;
  try {
    // Both the requested file and every parent must stay inside the artifact.
    let current = root;
    requireValue((await lstat(current)).isDirectory() && !(await lstat(current)).isSymbolicLink(), 'INVALID_ARTIFACT');
    for (const segment of relative.split('/')) {
      current = path.join(current, segment);
      stat = await lstat(current);
      requireValue(!stat.isSymbolicLink(), 'INVALID_ARTIFACT');
    }
    requireValue(stat.isFile() && stat.size <= limit, 'INVALID_ARTIFACT');
    const bytes = await readFile(file);
    requireValue(bytes.length <= limit, 'INVALID_ARTIFACT');
    return bytes;
  } catch { fail('INVALID_ARTIFACT'); }
}

function detailFile(route, knownIds) {
  requireValue(typeof route === 'string' && /^\/songs\/[^/]+\/$/.test(route), 'INVALID_OPTIONS');
  let id;
  try { id = decodeURIComponent(route.slice('/songs/'.length, -1)); } catch { fail('INVALID_OPTIONS'); }
  requireValue(id.length > 0 && !/[\\/\u0000-\u001f\u007f]/.test(id) && !['.', '..'].includes(id)
    && route === `/songs/${encodeURIComponent(id)}/` && knownIds.has(id), 'INVALID_OPTIONS');
  return `songs/${id}/index.html`;
}

function header(response, name) {
  // Only the crawler policy and size limit are read; never persist headers.
  return response.headers?.get?.(name) ?? null;
}

function decodeCFEmail(hex) {
  requireValue(/^(?:[A-Fa-f0-9]{2}){2,4096}$/.test(hex), 'CF_EMAIL_MISMATCH');
  const encoded = Buffer.from(hex, 'hex');
  const decoded = Buffer.from(encoded.subarray(1));
  for (let index = 0; index < decoded.length; index++) decoded[index] ^= encoded[0];
  try { return new TextDecoder('utf-8', { fatal: true }).decode(decoded); }
  catch { fail('CF_EMAIL_MISMATCH'); }
}

/**
 * One explicitly observed Cloudflare transform, anchored to plain emails in
 * the verified artifact. Nothing else is removed or made semantically equal.
 * Callers must still compare the complete normalized bytes with expected.
 */
export function normalizeCFEmailHTML(actualBytes, expectedBytes) {
  let actual, expected;
  try {
    actual = new TextDecoder('utf-8', { fatal: true }).decode(actualBytes);
    expected = new TextDecoder('utf-8', { fatal: true }).decode(expectedBytes);
  } catch { fail('BODY_MISMATCH'); }
  const allowed = new Map();
  const key = (payload, label) => payload + '\u0000' + label;
  for (const match of expected.matchAll(/<a href="mailto:([A-Za-z0-9.+_-]+@[A-Za-z0-9.-]+(?:\?[^"<>]*)?)">([^<]*)<\/a>/g)) {
    const entry = key(match[1], match[2]);
    allowed.set(entry, (allowed.get(entry) ?? 0) + 1);
  }
  function consume(payload, label) {
    const entry = key(payload, label);
    requireValue((allowed.get(entry) ?? 0) > 0, 'CF_EMAIL_MISMATCH');
    allowed.set(entry, allowed.get(entry) - 1);
    return `<a href="mailto:${payload}">${label}</a>`;
  }
  const transformed = /<a href="\/cdn-cgi\/l\/email-protection#([A-Fa-f0-9]+)"><span class="__cf_email__" data-cfemail="([A-Fa-f0-9]+)">\[email&#160;protected\]<\/span><\/a>/g;
  let anchors = 0;
  let normalized = actual.replace(transformed, (_, linkHex, spanHex) => {
    const linkEmail = decodeCFEmail(linkHex);
    const spanEmail = decodeCFEmail(spanHex);
    requireValue(linkEmail === spanEmail, 'CF_EMAIL_MISMATCH');
    anchors++;
    return consume(linkEmail, spanEmail);
  });
  const mailto = /<a href="\/cdn-cgi\/l\/email-protection#([A-Fa-f0-9]+)">([^<]*)<\/a>/g;
  let mailtoAnchors = 0;
  normalized = normalized.replace(mailto, (_, linkHex, label) => {
    // Treat the HTML-encoded payload as opaque: don't decode entities, parse
    // its query, drop a parameter, or replace only the email address.
    const payload = decodeCFEmail(linkHex);
    anchors++;
    mailtoAnchors++;
    return consume(payload, label);
  });
  if (anchors === 0) return { bytes: actualBytes, normalizations: [] };
  const decoder = '<script data-cfasync="false" src="/cdn-cgi/scripts/5c5dd728/cloudflare-static/email-decode.min.js"></script>';
  requireValue(normalized.split(decoder).length === 2 && !expected.includes(decoder), 'CF_EMAIL_MISMATCH');
  normalized = normalized.replace(decoder, '');
  return { bytes: Buffer.from(normalized), normalizations: [{ type: 'cloudflare-email-obfuscation', anchors,
    ...(mailtoAnchors ? { mailtoAnchors } : {}), decoderScripts: 1 }] };
}

/** Consume a streamed response with a byte ceiling, not an unbounded text(). */
async function responseBytes(response, limit, signal) {
  const declared = header(response, 'content-length');
  if (declared && /^\d+$/.test(declared) && Number(declared) > limit) fail('RESPONSE_TOO_LARGE');
  requireValue(response.body && typeof response.body.getReader === 'function', 'TRANSPORT_ERROR');
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  let rejectAbort;
  const aborted = new Promise((_, reject) => { rejectAbort = reject; });
  const onAbort = () => {
    void reader.cancel().catch(() => {});
    rejectAbort(new DeploymentVerificationError('REQUEST_TIMEOUT'));
  };
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    if (signal.aborted) onAbort();
    while (true) {
      const { done, value } = await Promise.race([reader.read(), aborted]);
      if (done) break;
      requireValue(value instanceof Uint8Array, 'TRANSPORT_ERROR');
      size += value.byteLength;
      requireValue(size <= limit, 'RESPONSE_TOO_LARGE');
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks, size);
  } catch (error) {
    // Cancellation is best effort and is deliberately not awaited: an
    // uncooperative server cannot extend the request deadline through cancel.
    void reader.cancel().catch(() => {});
    throw error;
  } finally { signal.removeEventListener('abort', onAbort); reader.releaseLock(); }
}

async function writeReceipt(outputPath, receipt) {
  const output = path.resolve(outputPath);
  const temporary = `${output}.healthcheck-${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(JSON.stringify(receipt, null, 2) + '\n');
    await handle.sync();
    await handle.close();
    handle = undefined;
    // An exclusive hard link publishes a complete receipt without replacing
    // an earlier success/failure, even when two writers race.
    await link(temporary, output);
  } catch (error) {
    fail(error?.code === 'EEXIST' ? 'OUTPUT_EXISTS' : 'OUTPUT_WRITE_FAILED');
  } finally {
    if (handle) await handle.close().catch(() => {});
    await unlink(temporary).catch(() => {});
  }
}

/**
 * Every attempt starts and ends with independent nonce metadata requests.
 * Ordinary application resources use their real, unqualified URLs.
 * The artifact must have passed verify-dist separately; this checks transport
 * identity and byte consistency, not Google's review or all CDN locations.
 */
export async function verifyDeployment({ url, distPath, outputPath, expectedSourceSha,
  expectedTarget, fetchImpl = globalThis.fetch, now = () => performance.timeOrigin + performance.now(), sleep = delay,
  maxAttempts = 6, totalTimeoutMs = 120_000, requestTimeoutMs = 10_000,
  retryDelayMs = 2_000, maxResponseBytes = 4 * 1024 * 1024, detailPaths } = {}) {
  requireValue(typeof distPath === 'string' && typeof fetchImpl === 'function' && typeof now === 'function' && typeof sleep === 'function'
    && (outputPath === undefined || typeof outputPath === 'string')
    && Number.isSafeInteger(maxAttempts) && maxAttempts >= 1 && maxAttempts <= 30
    && Number.isSafeInteger(totalTimeoutMs) && totalTimeoutMs >= 1 && totalTimeoutMs <= 300_000
    && Number.isSafeInteger(requestTimeoutMs) && requestTimeoutMs >= 1 && requestTimeoutMs <= 30_000
    && Number.isSafeInteger(retryDelayMs) && retryDelayMs >= 0 && retryDelayMs <= 10_000
    && Number.isSafeInteger(maxResponseBytes) && maxResponseBytes >= 1024 && maxResponseBytes <= 8 * 1024 * 1024,
  'INVALID_OPTIONS');
  if (outputPath !== undefined) {
    try { await lstat(outputPath); fail('OUTPUT_EXISTS'); }
    catch (error) { if (error.code !== 'ENOENT') fail(error.code === 'OUTPUT_EXISTS' ? 'OUTPUT_EXISTS' : 'OUTPUT_WRITE_FAILED'); }
  }
  const root = path.resolve(distPath);
  const info = metadata(await localBytes(root, 'build-info.json', 16_384), 'INVALID_ARTIFACT');
  if (expectedSourceSha !== undefined) requireValue(sha(expectedSourceSha) && info.sourceSha === expectedSourceSha, 'INVALID_ARTIFACT');
  if (expectedTarget !== undefined) requireValue(['preview', 'production'].includes(expectedTarget) && info.target === expectedTarget, 'INVALID_ARTIFACT');
  const origin = validateDeploymentUrl(url, info.target);
  const catalogBytes = await localBytes(root, 'catalog.json', maxResponseBytes);
  requireValue(digest(catalogBytes) === info.catalogSha256, 'INVALID_ARTIFACT');
  let catalog;
  try { catalog = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(catalogBytes)); } catch { fail('INVALID_ARTIFACT'); }
  requireValue(catalog.version === 2 && Array.isArray(catalog.songs) && catalog.songs.length === info.songCount
    && catalog.songs.filter(song => song.availability === 'current').length === info.currentSongCount, 'INVALID_ARTIFACT');
  if (detailPaths === undefined) {
    const confirmed = catalog.songs.find(song => song.availability === 'current' && Object.values(song.karaoke ?? {}).some(provider => provider.status === 'provider-confirmed' && !provider.conflict));
    const suppressed = catalog.songs.find(song => Object.values(song.karaoke ?? {}).some(provider => provider.status === 'unknown' && provider.correction));
    detailPaths = [...new Set([confirmed, suppressed].filter(Boolean).map(song => `/songs/${encodeURIComponent(song.id)}/`))];
  }
  requireValue(Array.isArray(detailPaths) && detailPaths.length <= 10, 'INVALID_OPTIONS');
  const staticRoutes = new Map([
    ['/', 'index.html'], ['/robots.txt', 'robots.txt'], ['/sitemap.xml', 'sitemap.xml'],
    ...['search', 'favorites', 'song', 'guides', 'guides/tj-ky-numbers', 'about', 'contact', 'privacy', 'faq', 'coverage', 'chart'].map(route => [`/${route}/`, `${route}/index.html`]),
    ...detailPaths.map(route => [route, detailFile(route, new Set(catalog.songs.map(song => song.id)))]),
  ]);
  // Previous frozen releases may predate reviewed routes; verify each route when its artifact contains it.
  for (const [route, file] of [['/artists/', 'artists/index.html'], ['/guides/title-artist-variants/', 'guides/title-artist-variants/index.html']]) {
    try {
      await lstat(path.join(root, file));
      staticRoutes.set(route, file);
    } catch (error) {
      if (error.code !== 'ENOENT') fail('INVALID_ARTIFACT');
    }
  }
  const resources = [];
  for (const [route, file] of staticRoutes) resources.push({ route, bytes: await localBytes(root, file, maxResponseBytes) });
  const home = resources[0].bytes.toString('utf8');
  const assets = [...new Set([...home.matchAll(/(?:href|src)="(\/_astro\/[A-Za-z0-9_.-]+\.(?:css|js))"/g)].map(match => match[1]))];
  requireValue(assets.length <= 20, 'INVALID_ARTIFACT');
  for (const route of assets) resources.push({ route, bytes: await localBytes(root, route.slice(1), maxResponseBytes) });
  const notFound = await localBytes(root, '404.html', maxResponseBytes);
  const started = now();
  const deadline = started + totalTimeoutMs;
  const receipt = { schemaVersion: 1, url: origin, sourceSha: info.sourceSha, target: info.target,
    catalogSha256: info.catalogSha256, ledgerSha256: info.ledgerSha256, chartSha256: info.chartSha256,
    startedAt: new Date(started).toISOString(), checkedAt: null, durationMs: 0,
    limits: { maxAttempts, totalTimeoutMs, requestTimeoutMs, retryDelayMs, maxResponseBytes },
    attempts: [], passed: false, code: null,
    scope: 'Observed HTTP origin and artifact byte consistency; separate CI/content/browser gates; no global CDN or AdSense approval claim' };

  async function get(route, checks, { metadataProbe = false, status = 200, limit = maxResponseBytes } = {}) {
    const remaining = deadline - now();
    requireValue(remaining > 0, 'DEADLINE_EXCEEDED');
    const timeout = Math.min(requestTimeoutMs, remaining);
    const controller = new AbortController();
    let timer;
    let response;
    const operation = (async () => {
      const destination = new URL(route, origin);
      if (metadataProbe) destination.searchParams.set('healthcheck', randomUUID());
      response = await fetchImpl(destination.href, { method: 'GET', redirect: 'error', credentials: 'omit', signal: controller.signal,
        headers: { Accept: route.endsWith('.json') ? 'application/json' : '*/*' } });
      requireValue(Number.isInteger(response?.status) && response.status >= 100 && response.status <= 599, 'TRANSPORT_ERROR');
      requireValue(!response.redirected && !(response.status >= 300 && response.status <= 399), 'REDIRECT');
      requireValue(response.status === status, 'HTTP_STATUS');
      const bytes = await responseBytes(response, limit, controller.signal);
      requireValue(!controller.signal.aborted, 'REQUEST_TIMEOUT');
      const crawler = header(response, 'x-robots-tag') ?? '';
      requireValue(info.target !== 'preview' || /(?:^|[,\s])noindex(?:$|[,\s])/i.test(crawler), 'CRAWLER_MISMATCH');
      requireValue(info.target !== 'production' || route !== '/' || !/\bnoindex\b/i.test(crawler), 'CRAWLER_MISMATCH');
      checks.push({ path: route, diagnosticNonce: metadataProbe, status: response.status, bytes: bytes.length, sha256: digest(bytes), passed: true });
      return bytes;
    })();
    const timed = new Promise((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new DeploymentVerificationError(timeout === remaining ? 'DEADLINE_EXCEEDED' : 'REQUEST_TIMEOUT')); }, timeout);
    });
    try { return await Promise.race([operation, timed]); }
    catch (error) {
      controller.abort();
      void response?.body?.cancel?.().catch(() => {});
      checks.push({ path: route, diagnosticNonce: metadataProbe, ...(Number.isInteger(response?.status) ? { status: response.status } : {}), passed: false, code: safeCode(error) });
      throw error;
    } finally { clearTimeout(timer); }
  }

  function matchBytes(actual, expected, checks, code) {
    const check = checks.at(-1);
    check.expectedSha256 = digest(expected);
    if (!actual.equals(expected) && code === 'BODY_MISMATCH'
      && /^(?:<!doctype html>\s*)?<html\b/i.test(expected.toString('utf8'))) {
      const normalized = normalizeCFEmailHTML(actual, expected);
      if (normalized.normalizations.length) {
        check.rawSha256 = check.sha256;
        check.normalizedSha256 = digest(normalized.bytes);
        check.normalizations = normalized.normalizations;
        actual = normalized.bytes;
      }
    }
    requireValue(actual.equals(expected), code);
  }

  for (let index = 1; index <= maxAttempts; index++) {
    const attempt = { number: index, startedAt: new Date(now()).toISOString(), checks: [], passed: false, code: null };
    receipt.attempts.push(attempt);
    try {
      const first = metadata(await get('/build-info.json', attempt.checks, { metadataProbe: true, limit: 16_384 }));
      requireValue(isDeepStrictEqual(first, info), 'METADATA_MISMATCH');
      const remoteCatalog = await get('/catalog.json', attempt.checks);
      matchBytes(remoteCatalog, catalogBytes, attempt.checks, 'CATALOG_MISMATCH');
      for (const resource of resources) {
        matchBytes(await get(resource.route, attempt.checks), resource.bytes, attempt.checks, 'BODY_MISMATCH');
      }
      for (const route of ['/data/staging/legacy-catalog.json', '/scripts/manage-production.py', '/reports/daily/healthcheck.json', '/not-found-healthcheck']) {
        matchBytes(await get(route, attempt.checks, { status: 404 }), notFound, attempt.checks, 'BODY_MISMATCH');
      }
      const final = metadata(await get('/build-info.json', attempt.checks, { metadataProbe: true, limit: 16_384 }));
      requireValue(isDeepStrictEqual(final, first) && isDeepStrictEqual(final, info), 'METADATA_MISMATCH');
      attempt.passed = true;
      receipt.passed = true;
      break;
    } catch (error) {
      attempt.code = safeCode(error);
      receipt.code = attempt.code;
      // A completed request is only a successful check after its metadata or
      // frozen bytes also match. Pin the semantic failure to that response.
      const last = attempt.checks.at(-1);
      if (last?.passed) { last.passed = false; last.code = attempt.code; }
    }
    const remaining = deadline - now();
    if (remaining <= 0) { receipt.code = 'DEADLINE_EXCEEDED'; break; }
    if (index < maxAttempts && retryDelayMs) {
      // A supplied sleep is test-only; production sleep is bounded by the
      // overall budget. Request/body timers enforce each real I/O deadline.
      await sleep(Math.min(retryDelayMs, remaining));
    }
  }
  if (receipt.passed) receipt.code = null;
  receipt.checkedAt = new Date(now()).toISOString();
  receipt.durationMs = Math.max(0, Math.round(now() - started));
  if (outputPath !== undefined) await writeReceipt(outputPath, receipt);
  return receipt;
}

async function cli() {
  requireValue(process.argv.length === 5, 'INVALID_OPTIONS');
  // Node 24 configures fetch's proxy from the existing environment. No
  // environment values are copied, printed, or added to application headers.
  const http = await import('node:http');
  requireValue(typeof http.setGlobalProxyFromEnv === 'function', 'PROXY_RUNTIME_UNSUPPORTED');
  let restore;
  try { restore = http.setGlobalProxyFromEnv(); } catch { fail('PROXY_CONFIGURATION_ERROR'); }
  try {
    const receipt = await verifyDeployment({ url: process.argv[2], distPath: process.argv[3], outputPath: process.argv[4],
      expectedSourceSha: process.env.EXPECTED_SOURCE_SHA ?? process.env.GITHUB_SHA,
      expectedTarget: process.env.EXPECTED_TARGET ?? process.env.JPOP_BUILD_TARGET });
    console.log(JSON.stringify({ sourceSha: receipt.sourceSha, target: receipt.target, attempts: receipt.attempts.length, passed: receipt.passed, code: receipt.code }));
    if (!receipt.passed) process.exitCode = 1;
  } finally { restore?.(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  cli().catch(error => { console.error(`Deployment verification failed: ${safeCode(error)}`); process.exitCode = 1; });
}
