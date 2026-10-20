/** Test-only: never retain payloads, tokens, complete URLs or file contents. */
export function classifyBackupRequest({ method, url, body = '' }, canaries) {
  const pending = [url, body], seen = new Set();
  if (url.includes('?')) {
    for (const part of url.slice(url.indexOf('?') + 1).split('#')[0].split('&')) {
      const separator = part.indexOf('=');
      pending.push(part, separator < 0 ? part : part.slice(0, separator), separator < 0 ? '' : part.slice(separator + 1));
    }
  }
  try {
    const address = new URL(url);
    for (const [key, value] of address.searchParams) pending.push(key, value);
    pending.push(address.hash.slice(1), ...address.pathname.split('/'));
  } catch {}
  for (let cursor = 0; cursor < pending.length; cursor++) {
    const text = pending[cursor];
    if (seen.has(text)) continue;
    seen.add(text);
    if (canaries.some(value => value && text.includes(value))) return 'favorite-data-in-request';
    // Decode each valid byte run independently. A separate literal '%' or bad
    // UTF-8 byte must not suppress inspection of the other query/JSON fields.
    const decoded = text.replace(/(?:%[0-9a-f]{2})+/gi, run =>
      new TextDecoder().decode(Uint8Array.from(run.match(/[0-9a-f]{2}/gi), pair => parseInt(pair, 16))));
    if (decoded !== text) pending.push(decoded);
    try {
      const parsed = JSON.parse(text);
      // Revisit JSON strings after each decode as well as the complete body,
      // including percent-encoded JSON that itself contains Unicode escapes.
      const values = [parsed];
      for (let i = 0; i < values.length; i++) {
        const value = values[i];
        if (typeof value === 'string') pending.push(value);
        else if (value && typeof value === 'object') {
          for (const [key, child] of Object.entries(value)) { pending.push(key); values.push(child); }
        }
      }
    } catch {}
  }
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
