#!/usr/bin/env node
/**
 * Move human-approved review-queue entries into data/reviewed/provider-corrections.json.
 * An entry is promoted when approve === true, or when --approve-exact is given and the
 * entry is an exact match the reviewer did not reject (approve !== false).
 * The whole ledger is validated before it is written; on any error nothing changes.
 *
 * Usage: node scripts/promote-reviewed.mjs <queue.json> [--approve-exact]
 */
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { validateProviderCorrections } from '../contracts/provider-corrections.mjs';

const args = process.argv.slice(2);
const approveExact = args.includes('--approve-exact');
const queuePath = args.find(arg => !arg.startsWith('--'));
if (!queuePath || args.length > 2 || (args.length === 2 && !approveExact)) {
  console.error('Usage: node scripts/promote-reviewed.mjs <queue.json> [--approve-exact]');
  process.exit(1);
}
const ledgerPath = join(process.cwd(), 'data/reviewed/provider-corrections.json');
const queue = JSON.parse(readFileSync(queuePath, 'utf8'));
const ledger = JSON.parse(readFileSync(ledgerPath, 'utf8'));
const staging = JSON.parse(readFileSync(join(process.cwd(), 'data/staging/legacy-catalog.json'), 'utf8'));
if (queue.purpose !== 'provider-review-queue' || !Array.isArray(queue.entries)) throw new Error('Not a provider review queue');

const existing = new Set(ledger.entries.map(entry => `${entry.songId}:${entry.provider}`));
const approved = queue.entries.filter(entry => !entry.error && !existing.has(`${entry.songId}:${entry.provider}`) &&
  (entry.approve === true || (approveExact && entry.match === 'exact' && entry.approve !== false)));
const missingReason = approved.filter(entry => typeof entry.reason !== 'string' || !entry.reason.trim());
if (missingReason.length) {
  console.error(`Approved entries need a reason: ${missingReason.map(entry => `${entry.songId}:${entry.provider}`).join(', ')}`);
  process.exit(1);
}
const additions = approved.map(entry => ({
  songId: entry.songId, provider: entry.provider, action: entry.action,
  expectedObservedNumber: entry.number,
  number: entry.action === 'confirm' ? entry.number : null,
  evidence: { ...entry.evidence },
  reason: entry.reason.trim(),
}));
const next = { ...ledger, entries: [...ledger.entries, ...additions] };
validateProviderCorrections(next, staging);
// Write beside the ledger and rename so a crash never leaves a half-written ledger.
const temporary = ledgerPath + '.tmp';
writeFileSync(temporary, JSON.stringify(next, null, 2) + '\n', { flag: 'wx' });
renameSync(temporary, ledgerPath);
const confirms = additions.filter(entry => entry.action === 'confirm').length;
console.log(`Promoted ${additions.length} entries (${confirms} confirm, ${additions.length - confirms} suppress). Ledger: ${next.entries.length}`);
