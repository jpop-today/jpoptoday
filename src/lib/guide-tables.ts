import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { songs, currentSongs, artistPages, type Song } from './catalog';
import { confirmedNumbers } from '../../contracts/public-catalog.mjs';
import type { GuideTable } from '../../contracts/guides.mjs';

export type GuideTableResult =
  | { kind: 'songs'; caption: string; songs: Song[]; empty: string }
  | { kind: 'coverage'; caption: string; rows: { label: string; tj: number; ky: number }[] };

const byId = new Map(songs.map(song => [song.id, song]));
const confirmedFirst = (list: Song[]) => [...list].sort((a, b) =>
  Number(confirmedNumbers(b).length > 0) - Number(confirmedNumbers(a).length > 0) || a.titleOriginal.localeCompare(b.titleOriginal, 'ja'));

type ChartRow = { title: string; artist: string; tjNumber: string; rank: number };
function chartHistory(): { date: string; songs: ChartRow[] }[] {
  const directory = new URL('data/chart-history/', `file://${process.cwd()}/`);
  if (!existsSync(directory)) return [];
  return readdirSync(directory).filter(name => /^\d{4}-\d{2}-\d{2}\.json$/.test(name)).sort()
    .map(name => ({ date: name.slice(0, 10), songs: JSON.parse(readFileSync(new URL(name, directory), 'utf8')).songs }));
}

/** Songs that entered the TJ chart during `month` (YYYY-MM), matched to catalog songs by exact title, artist and TJ number. */
function chartNewSongs(month: string): Song[] {
  const history = chartHistory();
  const before = new Set(history.filter(item => item.date < `${month}-01`).flatMap(item => item.songs.map(row => row.tjNumber)));
  const entered = history.filter(item => item.date.startsWith(month)).flatMap(item => item.songs).filter(row => !before.has(row.tjNumber));
  const matched = entered.map(row => currentSongs.find(song => song.karaoke.tj.observedNumber === row.tjNumber
    && song.titleOriginal === row.title && song.artistOriginal === row.artist)).filter(Boolean) as Song[];
  return [...new Map(matched.map(song => [song.id, song])).values()];
}

export function buildGuideTable(table: GuideTable): GuideTableResult {
  switch (table.type) {
    case 'artist': {
      const page = artistPages.find(item => item.slug === table.slug);
      if (!page) throw new Error(`Guide table: unknown artist ${table.slug}`);
      return { kind: 'songs', caption: `${page.name} 노래방 번호 (공식 확인 ${page.confirmedCount}곡 / 전체 ${page.songs.length}곡)`, songs: page.songs, empty: '' };
    }
    case 'tags': {
      const list = confirmedFirst(currentSongs.filter(song => table.tags.some(tag => song.tags.includes(tag))));
      return { kind: 'songs', caption: `관리 목록에서 고른 ${list.slice(0, table.limit ?? 30).length}곡 (공식 확인곡 먼저)`, songs: list.slice(0, table.limit ?? 30), empty: '조건에 맞는 곡이 아직 없습니다.' };
    }
    case 'songs': {
      const list = table.ids.map(id => byId.get(id));
      if (list.some(song => !song)) throw new Error('Guide table: unknown song ID');
      return { kind: 'songs', caption: '편집자가 고른 곡', songs: list as Song[], empty: '편집자가 곡을 고르는 중입니다.' };
    }
    case 'chart-new':
      return { kind: 'songs', caption: `${table.month} TJ JPOP 차트에 새로 오른 곡`, songs: chartNewSongs(table.month), empty: '이 달의 차트 수집 기록이 아직 없습니다.' };
    case 'coverage': {
      const count = (filter: (song: Song, provider: 'tj' | 'ky') => boolean) => ({
        tj: currentSongs.filter(song => filter(song, 'tj')).length, ky: currentSongs.filter(song => filter(song, 'ky')).length });
      return { kind: 'coverage', caption: '관리 목록 기준 업체별 번호 현황', rows: [
        { label: '번호가 있는 곡', ...count((song, p) => Boolean(song.karaoke[p].observedNumber)) },
        { label: '공식 검색으로 확인한 곡', ...count((song, p) => confirmedNumbers(song).some(n => n.provider === p)) },
        { label: '번호 확인 필요', ...count((song, p) => !song.karaoke[p].observedNumber) },
      ] };
    }
  }
}
