#!/usr/bin/env node
/**
 * Pick today's official-lookup targets (default 50 songs) for the human review queue.
 * Order: artists with 5+ current JPOP songs that still need confirmed songs to reach 3,
 * closest to 3 first, so "150 artists with 3+ confirmed songs" arrives as early as possible.
 * After every such artist has 3, remaining songs of the largest artists follow.
 *
 * Usage: node scripts/build-review-targets.mjs <output.json> [songLimit]
 */
import { readFileSync, readdirSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildPublicCatalog, confirmedNumbers } from '../contracts/public-catalog.mjs';
import { applyProviderCorrections } from '../contracts/provider-corrections.mjs';
import { isJpop, loadSongClassification, ARTIST_INDEX_MIN_CONFIRMED } from '../contracts/artists.mjs';

const MIN_ARTIST_SONGS = 5;
const QUEUE_DIR = join(process.cwd(), 'data', 'review-queue');
const readJson = file => JSON.parse(readFileSync(join(process.cwd(), file), 'utf8'));
const compare = (left, right) => left < right ? -1 : left > right ? 1 : 0;

export function selectTargets({ songs, ledger, classification, queued, limit }) {
  const inLedger = new Set(ledger.entries.map(entry => `${entry.songId}:${entry.provider}`));
  const lookups = song => ['tj', 'ky'].filter(provider => {
    const value = song.karaoke[provider];
    return value.observedNumber && !value.conflict && value.status === 'observed-unverified'
      && !inLedger.has(`${song.id}:${provider}`) && !queued.has(`${song.id}:${provider}`);
  });
  const byArtist = new Map();
  for (const song of songs) {
    // Artist pages count only playlist songs as confirmed (hasConfirmedNumber), so chart-only songs wait.
    if (song.availability !== 'current' || isJpop(classification, song) === false) continue;
    if (!byArtist.has(song.artistOriginal)) byArtist.set(song.artistOriginal, []);
    byArtist.get(song.artistOriginal).push(song);
  }
  const artists = [...byArtist].filter(([, list]) => list.length >= MIN_ARTIST_SONGS).map(([name, list]) => {
    const confirmed = list.filter(song => confirmedNumbers(song).length).length;
    // Songs with both numbers get two chances at a confirmation; then title order for stable output.
    const candidates = list.filter(song => song.origin === 'playlist' && !confirmedNumbers(song).length && lookups(song).length)
      .sort((a, b) => lookups(b).length - lookups(a).length || compare(a.titleOriginal, b.titleOriginal) || compare(a.id, b.id));
    return { name, total: list.length, need: Math.max(0, ARTIST_INDEX_MIN_CONFIRMED - confirmed), candidates };
  });
  const picked = [];
  const take = (artist, count) => {
    for (const song of artist.candidates.splice(0, Math.min(count, limit - picked.length))) picked.push(song);
  };
  // Pass 1: bring each 5+ artist to 3 confirmed songs, closest first.
  for (const artist of artists.filter(a => a.need > 0).sort((a, b) => a.need - b.need || b.total - a.total || compare(a.name, b.name))) {
    if (picked.length >= limit) break;
    if (artist.candidates.length) take(artist, artist.need);
  }
  // Pass 2: once every artist is covered, deepen the largest artists one song at a time.
  const byTotal = [...artists].sort((a, b) => b.total - a.total || compare(a.name, b.name));
  while (picked.length < limit && byTotal.some(a => a.candidates.length))
    for (const artist of byTotal) if (picked.length < limit && artist.candidates.length) take(artist, 1);
  return picked.flatMap(song => lookups(song).map(provider => ({
    songId: song.id, provider, number: song.karaoke[provider].observedNumber,
    title: song.titleOriginal, artist: song.artistOriginal,
  })));
}

function queuedKeys() {
  // Pending or rejected entries in earlier queues are not asked again.
  if (!existsSync(QUEUE_DIR)) return new Set();
  return new Set(readdirSync(QUEUE_DIR).filter(name => name.endsWith('.json')).flatMap(name =>
    JSON.parse(readFileSync(join(QUEUE_DIR, name), 'utf8')).entries?.map(entry => `${entry.songId}:${entry.provider}`) ?? []));
}

const [output, limitArg = '50'] = process.argv.slice(2);
if (!output || !/^[1-9][0-9]*$/.test(limitArg)) {
  console.error('Usage: node scripts/build-review-targets.mjs <output.json> [songLimit]');
  process.exit(1);
}
const staging = readJson('data/staging/legacy-catalog.json');
const ledger = readJson('data/reviewed/provider-corrections.json');
const songs = applyProviderCorrections(buildPublicCatalog(staging).songs, staging, ledger);
const targets = selectTargets({ songs, ledger, classification: loadSongClassification(), queued: queuedKeys(), limit: Number(limitArg) });
writeFileSync(output, JSON.stringify({ version: 1, createdAt: new Date().toISOString(), targets }, null, 2) + '\n', { flag: 'wx' });
console.log(`Review targets: ${new Set(targets.map(t => t.songId)).size} songs, ${targets.length} lookups -> ${output}`);
