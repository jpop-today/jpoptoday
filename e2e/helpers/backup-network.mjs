/** Test-only: never retain payloads, tokens, complete URLs or file contents. */
export function classifyBackupRequest({ method, url, body = '' }, canaries) {
  let inspected = url + '\n' + body;
  try { inspected += '\n' + JSON.stringify(JSON.parse(body)); } catch {}
  let decoded = inspected;
  for (let i = 0; i < 2; i++) {
    try { decoded = decodeURIComponent(decoded); inspected += '\n' + decoded; } catch { break; }
  }
  if (canaries.some(value => value && inspected.includes(value))) return 'favorite-data-in-request';
  if (['GET', 'HEAD'].includes(method)) return 'read';
  // This exact endpoint was read in the actual public Cloudflare beacon code.
  // A familiar hostname, query, alternate path or non-JSON body is insufficient.
  if (method === 'POST' && url === 'https://cloudflareinsights.com/cdn-cgi/rum') {
    try {
      const value = JSON.parse(body);
      if (value && !Array.isArray(value) && typeof value.pageloadId === 'string' &&
          typeof value.location === 'string' && typeof value.siteToken === 'string' &&
          [1, 3].includes(value.eventType)) return 'analytics';
    } catch {}
  }
  return 'unexpected-write';
}

export async function guardBackupNetwork(page, violations, canaries) {
  page.on('request', request => {
    const kind = classifyBackupRequest({ method: request.method(), url: request.url(), body: request.postData() ?? '' }, canaries);
    if (!['read', 'analytics'].includes(kind)) violations.push(kind);
  });
  // Inspect attempted analytics requests above but avoid publishing QA visits.
  await page.route('https://cloudflareinsights.com/cdn-cgi/rum', route => route.fulfill({ status: 204 }));
}
