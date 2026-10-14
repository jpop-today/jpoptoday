import staging from '../../data/staging/legacy-catalog.json';
import { buildPublicCatalog, songHref } from '../../contracts/public-catalog.mjs';
import ledger from '../../data/reviewed/provider-corrections.json';
import chart from '../../data/chart-snapshot.json';
import { applyProviderCorrections } from '../../contracts/provider-corrections.mjs';
import { buildTarget } from '../../contracts/publication.mjs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

export type Provider = { status: string; observedNumber: string | null; conflict: boolean;
  evidence: null | { url: string; checkedAt: string; title: string; artist: string };
  correction: null | { reason: string; previousNumber: string | null } };
export type Song = { id: string; titleOriginal: string; titleKo: string; artistOriginal: string; artistKo: string;
  tags: string[]; availability: string; origin: string; karaoke: { tj: Provider; ky: Provider } };
export const publicCatalog = { version: 2, songs: applyProviderCorrections(buildPublicCatalog(staging).songs, staging, ledger) } as { version: number; songs: Song[] };
export const target = buildTarget();
export const songs = publicCatalog.songs;
export const currentSongs = songs.filter(song => song.availability === 'current');
const preferred = ['アイドル', 'Lemon', '夜に駆ける', '怪獣の花唄', 'Pretender'];
export const initialSongs = preferred.map(title => currentSongs.find(song => song.titleOriginal === title && song.origin === 'playlist')).filter(Boolean) as Song[];
if (initialSongs.length !== 5) throw new Error('Representative songs missing');
export const publicCatalogBytes = JSON.stringify(publicCatalog);
export const buildInfo = {
  schemaVersion: 2,
  target,
  sourceSha: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  legacyRevision: staging.revision,
  catalogSha256: createHash('sha256').update(publicCatalogBytes).digest('hex'),
  ledgerSha256: createHash('sha256').update(JSON.stringify(ledger)).digest('hex'),
  chartSha256: createHash('sha256').update(JSON.stringify(chart)).digest('hex'),
  songCount: songs.length,
  currentSongCount: currentSongs.length,
  dirty: Boolean(execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { encoding: 'utf8' }).trim()),
};
export { songHref };
