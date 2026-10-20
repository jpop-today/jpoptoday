import { test, expect } from '@playwright/test';
import { createHash } from 'node:crypto';

const originalHash = '485311a4f1407193caa0a8a7314c316e2f37aaae73986b7c7f935033fb44db80';
const sellerPattern = /^google\.com,\s*pub-\d{16},\s*(?:DIRECT|RESELLER),\s*[a-f0-9]+\s*$/i;

// Keep the seller response in memory even when an assertion fails.
test.use({ trace: 'off' });

test('ads.txt preserves the original plain seller bytes only in production and stays absent from preview', async ({ request }) => {
  const metadata = await request.get('/build-info.json'); expect(metadata.status()).toBe(200);
  const info = await metadata.json(); expect(['production', 'preview'].includes(info.target)).toBe(true);
  const response = await request.get('/ads.txt', { maxRedirects: 0 });
  const bytes = await response.body(), text = bytes.toString('utf8');
  const sellerRows = text.split(/\r?\n/).filter(line => sellerPattern.test(line)).length;
  // Never pass the response body or publisher line into an assertion reporter.
  expect(/adsbygoogle|googlesyndication|doubleclick|googleadservices/i.test(text)).toBe(false);
  if (info.target === 'production') {
    expect(response.status()).toBe(200);
    expect(/^text\/plain(?:\s*;|$)/i.test(response.headers()['content-type'] ?? '')).toBe(true);
    expect(bytes.byteLength).toBe(59);
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(originalHash);
    expect(sellerRows).toBe(1);
    expect(/<(?:html|script|iframe)\b/i.test(text)).toBe(false);
  } else {
    expect(response.status()).toBe(404);
    expect(/noindex/i.test(response.headers()['x-robots-tag'] ?? '')).toBe(true);
    expect(sellerRows).toBe(0);
    expect(createHash('sha256').update(bytes).digest('hex') === originalHash).toBe(false);
  }
});
