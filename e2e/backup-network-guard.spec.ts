import { test, expect } from '@playwright/test';
import { guardBackupNetwork } from './helpers/backup-network.mjs';

test('the browser preserves an empty query delimiter and the guard intercepts it before the offline fallback', async ({ page }) => {
  const origin = 'https://jpop.today', endpoint = origin + '/cdn-cgi/rum';
  const fallback: string[] = [], requests: string[] = [], violations: string[] = [];
  // Every unmatched request is fulfilled locally. No fixture request can reach
  // the public origin, even if the guard fails to match its real browser URL.
  await page.route('**/*', route => {
    fallback.push(route.request().method());
    return route.fulfill({ status: route.request().method() === 'GET' ? 200 : 418,
      contentType: 'text/html', body: '<title>Synthetic network guard fixture</title>' });
  });
  page.on('request', request => { if (request.method() === 'POST') requests.push(request.url()); });
  await guardBackupNetwork(page, violations, ['synthetic-private-network-guard']);
  await page.goto(origin + '/__synthetic_network_guard_fixture');
  const statuses = await page.evaluate(async ({ endpoint }) => {
    const body = { eventType: 1, pageloadId: 'synthetic', location: 'https://jpop.today/favorites/', siteToken: 'synthetic-only' };
    const send = async (url: string, note?: string) => (await fetch(url, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...body, ...(note ? { note } : {}) }) })).status;
    return [await send(endpoint), await send(endpoint + '?'), await send(endpoint + '?file='),
      await send(endpoint + '?', 'synthetic-private-network-guard')];
  }, { endpoint });
  expect(statuses).toEqual([204, 204, 418, 204]);
  expect(requests).toEqual([endpoint, endpoint + '?', endpoint + '?file=', endpoint + '?']);
  expect(fallback).toEqual(['GET', 'POST']);
  expect(violations).toEqual(['unexpected-write', 'favorite-data-in-request']);
});
