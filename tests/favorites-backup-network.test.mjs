import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyBackupRequest } from '../e2e/helpers/backup-network.mjs';
const endpoint = 'https://cloudflareinsights.com/cdn-cgi/rum';
const canary = 'synthetic-private-backup-日本語';
const beacon = { eventType: 1, pageloadId: 'synthetic-page', location: 'https://jpop.today/favorites/', siteToken: 'synthetic-only' };
const classify = (method, url, body = '') => classifyBackupRequest({ method, url, body }, [canary]);

test('only exact recognized analytics POSTs are distinguished from unexpected writes', () => {
  assert.equal(classify('GET', 'https://jpop.today/catalog.json'), 'read');
  for (const eventType of [1, 3]) assert.equal(classify('POST', endpoint, JSON.stringify({ ...beacon, eventType })), 'analytics');
  for (const url of [endpoint + '?file=1', endpoint + '/extra', 'https://cloudflareinsights.com.evil.invalid/cdn-cgi/rum',
    'http://cloudflareinsights.com/cdn-cgi/rum', 'https://jpop.today/upload'])
    assert.equal(classify('POST', url, JSON.stringify(beacon)), 'unexpected-write');
  for (const body of ['', '{}', '[]', 'file bytes', JSON.stringify({ ...beacon, eventType: 999 })])
    assert.equal(classify('POST', endpoint, body), 'unexpected-write');
  assert.equal(classify('PUT', endpoint, JSON.stringify(beacon)), 'unexpected-write');
});

test('file canaries in any request query or body override the analytics exception without retaining private text', () => {
  for (const method of ['GET', 'POST']) {
    for (const query of [canary, encodeURIComponent(canary), encodeURIComponent(encodeURIComponent(canary))])
      assert.equal(classify(method, 'https://jpop.today/?data=' + query), 'favorite-data-in-request');
  }
  for (const url of [endpoint, 'https://jpop.today/upload']) {
    for (const body of [canary, JSON.stringify({ ...beacon, note: canary }), JSON.stringify({ ...beacon, note: canary }).replace('日本語', '\\u65e5\\u672c\\u8a9e')])
      assert.equal(classify('POST', url, body), 'favorite-data-in-request');
  }
});
