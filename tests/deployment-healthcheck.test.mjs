import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DeploymentVerificationError, validateDeploymentUrl, verifyDeployment, normalizeCFEmailHTML } from '../scripts/verify-deployment.mjs';
import { buildPublicCatalog } from '../contracts/public-catalog.mjs';
import { applyProviderCorrections } from '../contracts/provider-corrections.mjs';

const sha = 'a'.repeat(40);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const staticFiles = new Map([
  ['/', 'index.html'], ['/robots.txt', 'robots.txt'], ['/sitemap.xml', 'sitemap.xml'],
  ...['search', 'favorites', 'song', 'guides', 'guides/tj-ky-numbers', 'about', 'contact', 'privacy', 'faq', 'coverage', 'chart'].map(route => [`/${route}/`, `${route}/index.html`]),
  ['/songs/confirmed/', 'songs/confirmed/index.html'], ['/songs/suppressed/', 'songs/suppressed/index.html'],
  ['/_astro/brand.css', '_astro/brand.css'],
]);

async function fixture(t, target = 'production') {
  const root = await mkdtemp(path.join(tmpdir(), 'jpop-healthcheck-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dist = path.join(root, 'dist');
  await mkdir(dist);
  const resources = new Map();
  const songs = [
    { id: 'confirmed', availability: 'current', karaoke: { tj: { status: 'provider-confirmed', conflict: false } } },
    { id: 'suppressed', availability: 'current', karaoke: { tj: { status: 'unknown', correction: { previousNumber: '00123' } } } },
  ];
  const catalog = Buffer.from(JSON.stringify({ version: 2, songs }));
  const info = { schemaVersion: 2, target, sourceSha: sha, legacyRevision: 'b'.repeat(40), catalogSha256: hash(catalog), ledgerSha256: 'c'.repeat(64), chartSha256: 'd'.repeat(64), songCount: 2, currentSongCount: 2, dirty: false };
  resources.set('/build-info.json', Buffer.from(JSON.stringify(info)));
  resources.set('/catalog.json', catalog);
  await writeFile(path.join(dist, 'build-info.json'), resources.get('/build-info.json'));
  await writeFile(path.join(dist, 'catalog.json'), catalog);
  for (const [route, file] of staticFiles) {
    const bytes = Buffer.from(route === '/' ? '<html><link href="/_astro/brand.css"><body>today</body></html>' : `local:${target}:${route}`);
    resources.set(route, bytes);
    await mkdir(path.dirname(path.join(dist, file)), { recursive: true });
    await writeFile(path.join(dist, file), bytes);
  }
  const notFound = Buffer.from('<html><meta name="robots" content="noindex, follow">404</html>');
  await writeFile(path.join(dist, '404.html'), notFound);
  for (const route of ['/data/staging/legacy-catalog.json', '/scripts/manage-production.py', '/reports/daily/healthcheck.json', '/not-found-healthcheck']) resources.set(route, notFound);
  const calls = [];
  const fetchImpl = async (input, options) => {
    const url = new URL(input);
    calls.push({ url, options });
    const bytes = resources.get(url.pathname);
    assert.ok(bytes, `unexpected route ${url.pathname}`);
    return new Response(bytes, { status: url.pathname === '/not-found-healthcheck' || url.pathname.startsWith('/data/') || url.pathname.startsWith('/scripts/') || url.pathname.startsWith('/reports/') ? 404 : 200,
      headers: target === 'preview' ? { 'x-robots-tag': 'noindex, nofollow' } : {} });
  };
  const options = { url: target === 'production' ? 'https://jpop.today' : 'https://5011a963.jpoptoday-preview.pages.dev', distPath: dist, fetchImpl, maxAttempts: 1, retryDelayMs: 0, expectedSourceSha: sha, expectedTarget: target };
  return { root, dist, resources, info, calls, fetchImpl, options };
}

function code(code) { return error => error instanceof DeploymentVerificationError && error.code === code; }
function changedInfo(f, changes) { return new Response(JSON.stringify({ ...f.info, ...changes })); }

test('new artist directory is pinned while a previous artifact without it remains recoverable', async t => {
  const legacy = await fixture(t);
  const oldReceipt = await verifyDeployment(legacy.options);
  assert.equal(oldReceipt.passed, true);
  assert.equal(legacy.calls.some(call => call.url.pathname === '/artists/'), false);
  const current = await fixture(t);
  await mkdir(path.join(current.dist, 'artists'));
  const bytes = Buffer.from('<h1>Checked artist directory</h1>');
  await writeFile(path.join(current.dist, 'artists/index.html'), bytes);
  current.resources.set('/artists/', bytes);
  const result = await verifyDeployment(current.options);
  assert.equal(result.passed, true);
  assert.ok(result.attempts[0].checks.some(check => check.path === '/artists/' && check.passed));
  current.resources.set('/artists/', Buffer.from('<h1>Stale directory</h1>'));
  const stale = await verifyDeployment(current.options);
  assert.equal(stale.passed, false);
  assert.equal(stale.code, 'BODY_MISMATCH');
});

test('strict target-specific origin allowlist rejects credentials, normalization, paths, query and fragment', () => {
  assert.equal(validateDeploymentUrl('https://jpop.today/', 'production'), 'https://jpop.today');
  assert.equal(validateDeploymentUrl('https://2be02785.todayjpop.pages.dev', 'production'), 'https://2be02785.todayjpop.pages.dev');
  assert.equal(validateDeploymentUrl('https://jpoptoday-preview.pages.dev', 'preview'), 'https://jpoptoday-preview.pages.dev');
  for (const input of ['http://jpop.today', 'https://user:private@jpop.today', 'https://jpop.today:443', 'https://JPOP.TODAY', 'https://jpop.today/./', 'https://jpop.today//', 'https://jpop.today?', 'https://jpop.today#', 'https://jpop.today/?key=private', 'https://jpop.today/path', 'https://jpop.today.evil.test', 'https://arbitrary.todayjpop.pages.dev', 'https://todayjpop.pages.dev', 'https://2be02785.otherproject.pages.dev', 'https://jpoptoday-preview.pages.dev', 'https://jpop.today\\@evil.test']) {
    assert.throws(() => validateDeploymentUrl(input, 'production'), code('INVALID_URL'));
  }
  assert.throws(() => validateDeploymentUrl('https://jpop.today', 'preview'), code('INVALID_URL'));
  assert.throws(() => validateDeploymentUrl('https://jpop.today', 'unknown'), code('INVALID_OPTIONS'));
});

for (const target of ['production', 'preview']) {
  test(`${target}: exact frozen bytes, two fresh metadata probes, ordinary real routes and safe receipt`, async t => {
    const f = await fixture(t, target);
    const outputPath = path.join(f.root, 'receipt.json');
    const receipt = await verifyDeployment({ ...f.options, outputPath });
    assert.equal(receipt.passed, true);
    assert.equal(receipt.code, null);
    assert.equal(receipt.ledgerSha256, f.info.ledgerSha256);
    assert.equal(receipt.chartSha256, f.info.chartSha256);
    const metadata = f.calls.filter(call => call.url.pathname === '/build-info.json');
    assert.equal(metadata.length, 2);
    assert.notEqual(metadata[0].url.search, metadata[1].url.search);
    assert.deepEqual([...metadata[0].url.searchParams.keys()], ['healthcheck']);
    for (const call of f.calls) {
      assert.equal(call.options.redirect, 'error');
      assert.equal(call.options.credentials, 'omit');
      assert.equal(call.options.method, 'GET');
      assert.deepEqual(Object.keys(call.options.headers), ['Accept']);
      if (call.url.pathname !== '/build-info.json') assert.equal(call.url.search, '');
    }
    const saved = await readFile(outputPath, 'utf8');
    assert.deepEqual(JSON.parse(saved), receipt);
    assert.doesNotMatch(saved, /healthcheck=|<html>|noindex, nofollow|local:production|local:preview/);
    assert.equal(receipt.attempts[0].checks.filter(check => check.diagnosticNonce).length, 2);
  });
}

test('stale metadata fails first attempt, then complete matching attempt passes without hiding failure', async t => {
  const f = await fixture(t);
  let probes = 0;
  const receipt = await verifyDeployment({ ...f.options, maxAttempts: 2, fetchImpl: async (url, options) => {
    if (new URL(url).pathname === '/build-info.json' && probes++ === 0) return changedInfo(f, { sourceSha: 'f'.repeat(40) });
    return f.fetchImpl(url, options);
  } });
  assert.equal(receipt.passed, true);
  assert.equal(receipt.attempts.length, 2);
  assert.equal(receipt.attempts[0].code, 'METADATA_MISMATCH');
  assert.equal(receipt.attempts[0].passed, false);
  assert.equal(receipt.attempts[1].passed, true);
});

for (const [name, changes] of [
  ['wrong source SHA', { sourceSha: 'f'.repeat(40) }], ['wrong target', { target: 'preview' }],
  ['ledger digest', { ledgerSha256: 'e'.repeat(64) }], ['chart digest', { chartSha256: 'e'.repeat(64) }],
  ['legacy revision', { legacyRevision: 'f'.repeat(40) }], ['dirty artifact', { dirty: true }],
  ['unknown metadata key', { credential: 'do-not-log-private' }], ['old schema', { schemaVersion: 1 }],
]) {
  test(`${name}: rejected remote metadata and no body exposure`, async t => {
    const f = await fixture(t);
    const receipt = await verifyDeployment({ ...f.options, fetchImpl: async () => changedInfo(f, changes) });
    assert.equal(receipt.passed, false);
    assert.ok(['INVALID_METADATA', 'METADATA_MISMATCH'].includes(receipt.code));
    assert.equal(receipt.attempts[0].checks.at(-1).passed, false);
    assert.equal(receipt.attempts[0].checks.at(-1).code, receipt.code);
    assert.doesNotMatch(JSON.stringify(receipt), /do-not-log-private|credential/);
  });
}

test('metadata switches at end of an otherwise matching attempt: mixed deployment rejected', async t => {
  const f = await fixture(t);
  let probes = 0;
  const receipt = await verifyDeployment({ ...f.options, fetchImpl: async (url, options) => {
    if (new URL(url).pathname === '/build-info.json' && probes++ > 0) return changedInfo(f, { sourceSha: 'f'.repeat(40) });
    return f.fetchImpl(url, options);
  } });
  assert.equal(receipt.passed, false);
  assert.equal(receipt.code, 'METADATA_MISMATCH');
  assert.ok(receipt.attempts[0].checks.length > 20);
});

for (const route of ['/catalog.json', '/', '/robots.txt', '/sitemap.xml', '/songs/confirmed/', '/songs/suppressed/', '/_astro/brand.css', '/not-found-healthcheck']) {
  test(`mixed bytes at ${route}: matching metadata cannot mask old or wrong response`, async t => {
    const f = await fixture(t);
    const receipt = await verifyDeployment({ ...f.options, fetchImpl: async (url, options) => new URL(url).pathname === route
      ? new Response('untrusted-body-with-private-token', { status: route === '/not-found-healthcheck' ? 404 : 200 }) : f.fetchImpl(url, options) });
    assert.equal(receipt.passed, false);
    assert.equal(receipt.code, route === '/catalog.json' ? 'CATALOG_MISMATCH' : 'BODY_MISMATCH');
    assert.equal(receipt.attempts[0].checks.at(-1).passed, false);
    assert.equal(receipt.attempts[0].checks.at(-1).code, receipt.code);
    assert.doesNotMatch(JSON.stringify(receipt), /untrusted-body-with-private-token/);
  });
}

test('preview missing blanket noindex rejected despite matching artifact bytes', async t => {
  const f = await fixture(t, 'preview');
  const receipt = await verifyDeployment({ ...f.options, fetchImpl: async () => new Response(f.resources.get('/build-info.json')) });
  assert.equal(receipt.passed, false);
  assert.equal(receipt.code, 'CRAWLER_MISMATCH');
});

test('production home blanket noindex rejected despite exact frozen body', async t => {
  const f = await fixture(t);
  const receipt = await verifyDeployment({ ...f.options, fetchImpl: async (url, options) => new URL(url).pathname === '/'
    ? new Response(f.resources.get('/'), { headers: { 'x-robots-tag': 'noindex' } }) : f.fetchImpl(url, options) });
  assert.equal(receipt.code, 'CRAWLER_MISMATCH');
});

for (const status of [301, 302, 404, 500]) {
  test(`HTTP ${status} at metadata never counts as successful recovery`, async t => {
    const f = await fixture(t);
    const receipt = await verifyDeployment({ ...f.options, fetchImpl: async () => new Response('private-location-body', { status, headers: { Location: 'https://private:credential@evil.test/?secret=value' } }) });
    assert.equal(receipt.passed, false);
    assert.equal(receipt.code, status < 400 ? 'REDIRECT' : 'HTTP_STATUS');
    assert.doesNotMatch(JSON.stringify(receipt), /private-location-body|evil|credential|secret=value/);
  });
}

test('a client that reports following a redirect is rejected', async t => {
  const f = await fixture(t);
  const receipt = await verifyDeployment({ ...f.options, fetchImpl: async () => ({ status: 200, redirected: true }) });
  assert.equal(receipt.code, 'REDIRECT');
});

test('transport throws secrets: only whitelisted code goes to persisted receipt', async t => {
  const f = await fixture(t);
  const outputPath = path.join(f.root, 'failure.json');
  const receipt = await verifyDeployment({ ...f.options, outputPath, fetchImpl: async () => { throw new Error('https://token:credential@proxy.test/?secret=private Bearer do-not-log'); } });
  assert.equal(receipt.code, 'TRANSPORT_ERROR');
  assert.doesNotMatch(await readFile(outputPath, 'utf8'), /proxy.test|credential|private|Bearer|do-not-log/);
});

test('request timeout bounds a client that ignores its abort signal', async t => {
  const f = await fixture(t);
  let observedSignal;
  const began = Date.now();
  const receipt = await verifyDeployment({ ...f.options, requestTimeoutMs: 15, fetchImpl: async (_, options) => { observedSignal = options.signal; return new Promise(() => {}); } });
  assert.equal(receipt.passed, false);
  assert.equal(receipt.code, 'REQUEST_TIMEOUT');
  assert.equal(observedSignal.aborted, true);
  assert.ok(Date.now() - began < 1000);
});

test('body timeout bounds an endless server stream and cancels its reader', async t => {
  const f = await fixture(t);
  let canceled = false;
  const stream = new ReadableStream({ pull() { return new Promise(() => {}); }, cancel() { canceled = true; } });
  const receipt = await verifyDeployment({ ...f.options, requestTimeoutMs: 15, fetchImpl: async () => new Response(stream) });
  assert.equal(receipt.passed, false);
  assert.equal(receipt.code, 'REQUEST_TIMEOUT');
  assert.equal(canceled, true);
});

test('overall deadline ends before maximum retry count and preserves timed-out attempts', async t => {
  const f = await fixture(t);
  const receipt = await verifyDeployment({ ...f.options, maxAttempts: 30, totalTimeoutMs: 25, requestTimeoutMs: 10, fetchImpl: async () => new Promise(() => {}) });
  assert.equal(receipt.passed, false);
  assert.equal(receipt.code, 'DEADLINE_EXCEEDED');
  assert.ok(receipt.attempts.length < 30);
  assert.ok(receipt.durationMs < 1000);
});

for (const advertised of [true, false]) {
  test(`oversize ${advertised ? 'Content-Length' : 'stream'} rejected without leaking body`, async t => {
    const f = await fixture(t);
    const receipt = await verifyDeployment({ ...f.options, fetchImpl: async () => new Response('private'.repeat(3000), { headers: advertised ? { 'content-length': '21000' } : {} }) });
    assert.equal(receipt.code, 'RESPONSE_TOO_LARGE');
    assert.doesNotMatch(JSON.stringify(receipt), /private/);
  });
}

test('existing success receipt is unchanged and stops requests before network', async t => {
  const f = await fixture(t);
  const outputPath = path.join(f.root, 'success.json');
  const original = Buffer.from('previous-success-with-verbatim-bytes\n');
  await writeFile(outputPath, original);
  await assert.rejects(verifyDeployment({ ...f.options, outputPath }), code('OUTPUT_EXISTS'));
  assert.deepEqual(await readFile(outputPath), original);
  assert.equal(f.calls.length, 0);
});

test('competing writer cannot replace a receipt and owned temporary file is removed', async t => {
  const f = await fixture(t);
  const outputPath = path.join(f.root, 'race.json');
  let inserted = false;
  await assert.rejects(verifyDeployment({ ...f.options, outputPath, fetchImpl: async (url, options) => {
    if (!inserted) { inserted = true; await writeFile(outputPath, 'other-real-result\n'); }
    return f.fetchImpl(url, options);
  } }), code('OUTPUT_EXISTS'));
  assert.equal(await readFile(outputPath, 'utf8'), 'other-real-result\n');
  assert.ok(!(await readdir(f.root)).some(file => file.endsWith('.tmp')));
});

test('artifact SHA, target, dirty, catalog and symlink errors fail before any network', async t => {
  const f = await fixture(t);
  await assert.rejects(verifyDeployment({ ...f.options, expectedSourceSha: 'f'.repeat(40) }), code('INVALID_ARTIFACT'));
  await assert.rejects(verifyDeployment({ ...f.options, expectedTarget: 'preview' }), code('INVALID_ARTIFACT'));
  await writeFile(path.join(f.dist, 'catalog.json'), 'wrong');
  await assert.rejects(verifyDeployment(f.options), code('INVALID_ARTIFACT'));
  await writeFile(path.join(f.dist, 'catalog.json'), f.resources.get('/catalog.json'));
  await rm(path.join(f.dist, 'robots.txt'));
  await symlink(path.join(f.dist, 'index.html'), path.join(f.dist, 'robots.txt'));
  await assert.rejects(verifyDeployment(f.options), code('INVALID_ARTIFACT'));
  assert.equal(f.calls.length, 0);
});

test('user detail path cannot escape artifact or origin; option limits cannot disable bounds', async t => {
  const f = await fixture(t);
  for (const route of ['/songs/../private/', '/songs/%2e%2e/', '/songs/confirmed/?secret=private', 'https://evil.test', '/about/']) {
    await assert.rejects(verifyDeployment({ ...f.options, detailPaths: [route] }), code('INVALID_OPTIONS'));
  }
  for (const options of [{ maxAttempts: Infinity }, { maxAttempts: 0 }, { totalTimeoutMs: 300001 }, { requestTimeoutMs: 0 }, { retryDelayMs: -1 }, { maxResponseBytes: 0 }]) {
    await assert.rejects(verifyDeployment({ ...f.options, ...options }), code('INVALID_OPTIONS'));
  }
  assert.equal(f.calls.length, 0);
});

test('Unicode and literal percent stable IDs keep canonical encoded URLs and original local filenames', async t => {
  const f = await fixture(t);
  const catalog = JSON.parse(f.resources.get('/catalog.json'));
  catalog.songs[0].id = 'alia-かくれんほ';
  catalog.songs[1].id = '노래-100%';
  for (const song of catalog.songs) {
    const route = `/songs/${encodeURIComponent(song.id)}/`;
    const file = path.join(f.dist, 'songs', song.id, 'index.html');
    const bytes = Buffer.from(`real-id:${song.id}`);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, bytes);
    f.resources.set(route, bytes);
  }
  const bytes = Buffer.from(JSON.stringify(catalog));
  f.info.catalogSha256 = hash(bytes);
  f.resources.set('/catalog.json', bytes);
  f.resources.set('/build-info.json', Buffer.from(JSON.stringify(f.info)));
  await writeFile(path.join(f.dist, 'catalog.json'), bytes);
  await writeFile(path.join(f.dist, 'build-info.json'), f.resources.get('/build-info.json'));
  const receipt = await verifyDeployment(f.options);
  assert.equal(receipt.passed, true);
  assert.ok(f.calls.some(call => call.url.pathname === '/songs/alia-%E3%81%8B%E3%81%8F%E3%82%8C%E3%82%93%E3%81%BB/'));
  assert.ok(f.calls.some(call => call.url.pathname === '/songs/%EB%85%B8%EB%9E%98-100%25/'));
  for (const route of ['/songs/alia-かくれんほ/', '/songs/%61lia-%E3%81%8B%E3%81%8F%E3%82%8C%E3%82%93%E3%81%BB/', '/songs/unknown-id/', '/songs/%2F/', '/songs/%5C/', '/songs/%00/', '/songs/%2e%2e/', '/songs/%invalid/']) {
    await assert.rejects(verifyDeployment({ ...f.options, detailPaths: [route] }), code('INVALID_OPTIONS'));
  }
});

test('real 3317-ID staging and reviewed projection chooses existing canonical confirmed/suppressed details', async t => {
  const f = await fixture(t);
  const staging = JSON.parse(await readFile(new URL('../data/staging/legacy-catalog.json', import.meta.url), 'utf8'));
  const ledger = JSON.parse(await readFile(new URL('../data/reviewed/provider-corrections.json', import.meta.url), 'utf8'));
  const songs = applyProviderCorrections(buildPublicCatalog(staging).songs, staging, ledger);
  assert.equal(songs.length, 3317);
  const selected = [songs.find(song => song.availability === 'current' && Object.values(song.karaoke).some(provider => provider.status === 'provider-confirmed' && !provider.conflict)),
    songs.find(song => Object.values(song.karaoke).some(provider => provider.status === 'unknown' && provider.correction))];
  assert.ok(selected.every(Boolean));
  for (const song of selected) {
    const file = path.join(f.dist, 'songs', song.id, 'index.html');
    const bytes = Buffer.from(`real-catalog-selected:${song.id}`);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, bytes);
    f.resources.set(`/songs/${encodeURIComponent(song.id)}/`, bytes);
  }
  const bytes = Buffer.from(JSON.stringify({ version: 2, songs }));
  Object.assign(f.info, { catalogSha256: hash(bytes), songCount: songs.length, currentSongCount: songs.filter(song => song.availability === 'current').length });
  f.resources.set('/catalog.json', bytes);
  f.resources.set('/build-info.json', Buffer.from(JSON.stringify(f.info)));
  await writeFile(path.join(f.dist, 'catalog.json'), bytes);
  await writeFile(path.join(f.dist, 'build-info.json'), f.resources.get('/build-info.json'));
  const receipt = await verifyDeployment(f.options);
  assert.equal(receipt.passed, true);
  assert.equal(f.info.currentSongCount, 3313);
  assert.equal(receipt.attempts[0].checks.filter(check => check.path.startsWith('/songs/')).length, 2);
  assert.ok(receipt.attempts[0].checks.some(check => check.path === `/songs/${encodeURIComponent(selected[0].id)}/`));
});

const decoder = '<script data-cfasync="false" src="/cdn-cgi/scripts/5c5dd728/cloudflare-static/email-decode.min.js"></script>';
const plainEmail = '<a href="mailto:editor@example.test">editor@example.test</a>';
function encodeCFEmail(email, key) {
  return Buffer.from([key, ...Buffer.from(email, 'utf8')].map((byte, index) => index === 0 ? byte : byte ^ key)).toString('hex');
}
function protectedEmail(linkEmail = 'editor@example.test', spanEmail = linkEmail, firstKey = 22, secondKey = 157) {
  return `<a href="/cdn-cgi/l/email-protection#${encodeCFEmail(linkEmail, firstKey)}"><span class="__cf_email__" data-cfemail="${encodeCFEmail(spanEmail, secondKey)}">[email&#160;protected]</span></a>`;
}
const html = contents => Buffer.from(`<html><body>${contents}</body></html>`);

test('exact known CF email anchor/independent XOR keys and one decoder normalize to frozen artifact', () => {
  const expected = html(plainEmail);
  for (const [first, second] of [[22, 157], [51, 5], [0, 255]]) {
    const raw = html(protectedEmail('editor@example.test', 'editor@example.test', first, second) + decoder);
    const result = normalizeCFEmailHTML(raw, expected);
    assert.deepEqual(result.bytes, expected);
    assert.deepEqual(result.normalizations, [{ type: 'cloudflare-email-obfuscation', anchors: 1, decoderScripts: 1 }]);
    assert.notEqual(hash(raw), hash(result.bytes));
  }
});

test('CF email normalization retains raw and normalized hashes and accepted transform counts in receipt', async t => {
  const f = await fixture(t);
  const expected = html(plainEmail);
  const actual = html(protectedEmail() + decoder);
  f.resources.set('/contact/', expected);
  await writeFile(path.join(f.dist, 'contact/index.html'), expected);
  const receipt = await verifyDeployment({ ...f.options, fetchImpl: async (url, options) => new URL(url).pathname === '/contact/'
    ? new Response(actual) : f.fetchImpl(url, options) });
  assert.equal(receipt.passed, true);
  const check = receipt.attempts[0].checks.find(check => check.path === '/contact/');
  assert.equal(check.rawSha256, hash(actual));
  assert.equal(check.sha256, hash(actual));
  assert.equal(check.normalizedSha256, hash(expected));
  assert.equal(check.expectedSha256, hash(expected));
  assert.deepEqual(check.normalizations, [{ type: 'cloudflare-email-obfuscation', anchors: 1, decoderScripts: 1 }]);
});

for (const [name, transformed] of [
  ['different decoded href', protectedEmail('unknown@example.test', 'editor@example.test')],
  ['different decoded span', protectedEmail('editor@example.test', 'unknown@example.test')],
  ['two identical unapproved extra anchors', protectedEmail() + protectedEmail()],
  ['no expected plain anchor', protectedEmail('token-secret@example.test')],
  ['odd length encoded href', protectedEmail().replace(/email-protection#[a-f0-9]+/, 'email-protection#123')],
  ['UTF8 decode failure', protectedEmail().replace(/email-protection#[a-f0-9]+/, 'email-protection#00ff')],
]) {
  test(`CF email ${name} fails with safe code and no secret content`, () => {
    assert.throws(() => normalizeCFEmailHTML(html(transformed + decoder), html(plainEmail)), error => {
      assert.equal(error.code, 'CF_EMAIL_MISMATCH');
      assert.doesNotMatch(error.message, /unknown|token-secret|example.test|123/);
      return true;
    });
  });
}

for (const [name, actual] of [
  ['added anchor attribute', protectedEmail().replace('<a href=', '<a onclick="privateSecret()" href=') + decoder],
  ['added span attribute', protectedEmail().replace('<span class=', '<span title="private-secret" class=') + decoder],
  ['extra unrecognized script', protectedEmail() + decoder + '<script src="https://ads.example.test/private-secret.js"></script>'],
  ['changed body', protectedEmail() + decoder + '<p>private-secret</p>'],
  ['changed protected marker', protectedEmail().replace('[email&#160;protected]', '[email protected]') + decoder],
]) {
  test(`CF email ${name} cannot hide body mismatch behind approved transform`, async t => {
    const f = await fixture(t);
    const expected = html(plainEmail);
    f.resources.set('/contact/', expected);
    await writeFile(path.join(f.dist, 'contact/index.html'), expected);
    const receipt = await verifyDeployment({ ...f.options, fetchImpl: async (url, options) => new URL(url).pathname === '/contact/'
      ? new Response(html(actual)) : f.fetchImpl(url, options) });
    assert.equal(receipt.passed, false);
    assert.equal(receipt.code, 'BODY_MISMATCH');
    assert.doesNotMatch(JSON.stringify(receipt), /private-secret|privateSecret|ads.example.test/);
  });
}

for (const [name, script] of [['missing decoder', ''], ['duplicate decoder', decoder + decoder],
  ['changed decoder attrs', decoder.replace('data-cfasync="false"', 'data-cfasync="false" data-secret="private"')],
  ['unknown decoder source', decoder.replace('5c5dd728', '12345678')]]) {
  test(`CF email ${name} does not broaden approved script removal`, () => {
    assert.throws(() => normalizeCFEmailHTML(html(protectedEmail() + script), html(plainEmail)), code('CF_EMAIL_MISMATCH'));
  });
}

const queryPayload = 'editor@example.test?subject=jpop.today%20%EC%A0%9C%EB%B3%B4&amp;body=https%3A%2F%2Fjpop.today%2Fsongs%2Fstable-%E6%AD%8C%2F';
const queryLabel = '이 곡 정보 제보';
const plainQuery = `<a href="mailto:${queryPayload}">${queryLabel}</a>`;
const protectedQuery = (payload = queryPayload, label = queryLabel, key = 76) => `<a href="/cdn-cgi/l/email-protection#${encodeCFEmail(payload, key)}">${label}</a>`;

test('CF mailto query anchor preserves the entire HTML-encoded payload and its original label', () => {
  const expected = html(plainQuery);
  for (const key of [0, 33, 76, 255]) {
    const normalized = normalizeCFEmailHTML(html(protectedQuery(queryPayload, queryLabel, key) + decoder), expected);
    assert.deepEqual(normalized.bytes, expected);
    assert.deepEqual(normalized.normalizations, [{ type: 'cloudflare-email-obfuscation', anchors: 1, mailtoAnchors: 1, decoderScripts: 1 }]);
  }
});

test('span and query anchor forms share an exact expected occurrence budget and one decoder', () => {
  const expected = html(plainEmail + plainQuery);
  const normalized = normalizeCFEmailHTML(html(protectedEmail() + protectedQuery() + decoder), expected);
  assert.deepEqual(normalized.bytes, expected);
  assert.deepEqual(normalized.normalizations, [{ type: 'cloudflare-email-obfuscation', anchors: 2, mailtoAnchors: 1, decoderScripts: 1 }]);
  assert.throws(() => normalizeCFEmailHTML(html(protectedEmail() + protectedEmail() + protectedQuery() + decoder), expected), code('CF_EMAIL_MISMATCH'));
});

for (const [name, payload, label] of [
  ['different subject', queryPayload.replace('subject=jpop.today', 'subject=private-secret'), queryLabel],
  ['different body', queryPayload.replace('body=https', 'body=private-secret-https'), queryLabel],
  ['different stable ID', queryPayload.replace('stable-', 'other-'), queryLabel],
  ['entity-decoded query', queryPayload.replace('&amp;', '&'), queryLabel],
  ['reordered query', 'editor@example.test?body=test&amp;subject=test', queryLabel],
  ['missing query', 'editor@example.test', queryLabel],
  ['different label', queryPayload, 'private-secret'],
]) {
  test(`CF mailto ${name} is not equivalent to the frozen anchor`, () => {
    assert.throws(() => normalizeCFEmailHTML(html(protectedQuery(payload, label) + decoder), html(plainQuery)), error => {
      assert.equal(error.code, 'CF_EMAIL_MISMATCH');
      assert.doesNotMatch(error.message, /private-secret|subject|body=|example.test/);
      return true;
    });
  });
}

for (const [name, actual] of [
  ['extra query-anchor attribute', protectedQuery().replace('<a href=', '<a onclick="privateSecret()" href=') + decoder],
  ['HTML label injection', protectedQuery(queryPayload, '<script>privateSecret()</script>') + decoder],
  ['extra injected HTML', protectedQuery() + decoder + '<iframe src="https://private-secret.test"></iframe>'],
]) {
  test(`CF mailto ${name} remains a body mismatch and is never logged`, async t => {
    const f = await fixture(t);
    const expected = html(plainQuery);
    f.resources.set('/contact/', expected);
    await writeFile(path.join(f.dist, 'contact/index.html'), expected);
    const receipt = await verifyDeployment({ ...f.options, fetchImpl: async (url, options) => new URL(url).pathname === '/contact/'
      ? new Response(html(actual)) : f.fetchImpl(url, options) });
    assert.equal(receipt.passed, false);
    assert.equal(receipt.code, 'BODY_MISMATCH');
    assert.doesNotMatch(JSON.stringify(receipt), /private-secret|privateSecret/);
  });
}

test('CF mailto query gets raw/normalized digest and form count in the safe receipt', async t => {
  const f = await fixture(t);
  const expected = html(plainQuery);
  const actual = html(protectedQuery() + decoder);
  f.resources.set('/contact/', expected);
  await writeFile(path.join(f.dist, 'contact/index.html'), expected);
  const receipt = await verifyDeployment({ ...f.options, fetchImpl: async (url, options) => new URL(url).pathname === '/contact/'
    ? new Response(actual) : f.fetchImpl(url, options) });
  assert.equal(receipt.passed, true);
  const check = receipt.attempts[0].checks.find(check => check.path === '/contact/');
  assert.equal(check.rawSha256, hash(actual));
  assert.equal(check.normalizedSha256, hash(expected));
  assert.equal(check.normalizations[0].mailtoAnchors, 1);
  assert.doesNotMatch(JSON.stringify(receipt), /subject=|body=|editor@example.test/);
});
