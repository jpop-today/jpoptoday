import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { verifyAdsTxt } from '../scripts/verify-dist.mjs';

// Immutable public original, not a generated publisher identity or approval.
// Assertions expose only booleans, lengths and hashes, never the seller value.
const expectedHash = '485311a4f1407193caa0a8a7314c316e2f37aaae73986b7c7f935033fb44db80';
const original = readFileSync(new URL('../public/ads.txt', import.meta.url));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const sellerRows = bytes => bytes.toString('utf8').split(/\r?\n/).filter(line => /^google\.com,\s*pub-\d{16},\s*(?:DIRECT|RESELLER),\s*[a-f0-9]+\s*$/i.test(line)).length;
const input = (target, bytes, expectedBytes = original) => ({ target, bytes, expectedBytes });
function rejects(value) {
  let rejected = false;
  try { verifyAdsTxt(value); } catch { rejected = true; }
  assert.equal(rejected, true, 'The ads.txt gate must reject this invalid artifact without printing its bytes');
}

test('restored public seller bytes match the immutable original without implying account ownership', () => {
  assert.equal(original.byteLength, 59); assert.equal(hash(original), expectedHash);
  assert.equal(sellerRows(original), 1);
  assert.equal(/<(?:html|script|iframe)\b|adsbygoogle|googlesyndication|doubleclick/i.test(original.toString('utf8')), false);
});

test('production accepts exact original bytes and does not mutate either buffer', () => {
  const bytes = Buffer.from(original), expectedBytes = Buffer.from(original);
  assert.doesNotThrow(() => verifyAdsTxt(input('production', bytes, expectedBytes)));
  assert.equal(hash(bytes), expectedHash); assert.equal(hash(expectedBytes), expectedHash);
});

test('production rejects missing, truncated, changed or extended original bytes', async t => {
  const changed = Buffer.from(original); changed[0] ^= 1;
  for (const [name, bytes] of [
    ['missing', undefined], ['null', null], ['empty file', Buffer.alloc(0)],
    ['truncated', original.subarray(0, original.length - 1)], ['one changed byte', changed],
    ['extra whitespace', Buffer.concat([original, Buffer.from(' ')])],
    ['extra newline', Buffer.concat([original, Buffer.from('\n')])],
    ['duplicate seller row', Buffer.concat([original, Buffer.from('\n'), original])],
    ['HTML instead of plain row', Buffer.concat([Buffer.from('<html><body>'), original, Buffer.from('</body></html>')])],
  ]) await t.test(name, () => rejects(input('production', bytes)));
});

test('expected reference must itself be present and plain Google seller data', async t => {
  for (const [name, expectedBytes] of [
    ['missing reference', undefined], ['null reference', null], ['empty reference', Buffer.alloc(0)],
    ['non-seller reference', Buffer.from('not a seller row')],
    ['HTML reference', Buffer.concat([Buffer.from('<script>'), original, Buffer.from('</script>')])],
  ]) await t.test(name, () => rejects({ target: 'production', bytes: expectedBytes, expectedBytes }));
});

test('preview accepts absence only and rejects even an empty or otherwise correct seller file', async t => {
  assert.doesNotThrow(() => verifyAdsTxt(input('preview', undefined)));
  for (const [name, bytes] of [['null is not file absence', null], ['empty file', Buffer.alloc(0)], ['original seller file', original], ['HTML file', Buffer.from('<html></html>')]]) {
    await t.test(name, () => rejects(input('preview', bytes)));
  }
});
