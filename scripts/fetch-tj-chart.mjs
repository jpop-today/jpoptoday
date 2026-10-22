#!/usr/bin/env node
/**
 * Collect one TJ JPOP TOP100 snapshot into data/chart-history/YYYY-MM-DD.json.
 * Ported from kim75503/todayjpop scripts/fetch-tj-chart.js without lyrics, images or catalog merging.
 * Any failure writes nothing, so previously collected snapshots stay as they are.
 */
import { mkdir, open } from 'node:fs/promises';
import { join } from 'node:path';

const TJ_TOP100_URL = 'https://www.tjmedia.com/legacy/api/topAndHot100';
const TJ_SITE_URL = 'https://www.tjmedia.com/chart/top100';
const HISTORY_DIR = join(process.cwd(), 'data', 'chart-history');

const seoulDate = (date = new Date()) => new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(date);
const daysBefore = (days, date = new Date()) => seoulDate(new Date(date.getTime() - days * 86400000));

function field(row, keys) {
  for (const key of keys) {
    if (row[key] !== undefined && row[key] !== null && String(row[key]).trim() !== '') return row[key];
  }
  return '';
}

// Same alias shape as the original repository so chart rows stay comparable with data/chart-snapshot.json.
function slugify(value) {
  return String(value || '').normalize('NFKD').toLowerCase().replace(/&/g, ' and ')
    .replace(/[^a-z0-9가-힣ぁ-んァ-ン一-龯]+/g, '-').replace(/^-+|-+$/g, '').replace(/-{2,}/g, '-');
}

function findRows(payload) {
  if (Array.isArray(payload)) return payload;
  const candidates = [payload?.data, payload?.result, payload?.list, payload?.rows, payload?.data?.list,
    payload?.result?.list, payload?.resultData, payload?.resultData?.list, payload?.resultData?.items];
  return candidates.find(Array.isArray) ?? [];
}

function normalizeRow(row, index) {
  const title = String(field(row, ['title', 'indexTitle', 'songName', 'song_name', 'SONG_NAME', 'SONG_TITLE', 'musicTitle', 'MUSIC_TITLE'])).trim();
  const artist = String(field(row, ['artist', 'indexSong', 'singerName', 'singer_name', 'SINGER_NAME', 'ARTIST', 'SINGER'])).trim();
  const tjNumber = String(field(row, ['tjNumber', 'songNo', 'songNumber', 'pro', 'pro1', 'proNo', 'proNum', 'PRO', 'PRO_NO',
    'PRO_NUM', 'SONG_NO', 'SONG_NUMBER', 'SONG_NUM', 'MUSIC_CODE'])).replace(/\D/g, '');
  const rank = Number(field(row, ['rank', 'rnum', 'RANK', 'RNUM', 'ranking'])) || index + 1;
  return { id: slugify(`${artist}-${title}`) || `rank-${rank}`, title, artist, tjNumber, rank };
}

async function requestChart(payload) {
  const response = await fetch(TJ_TOP100_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'x-requested-with': 'XMLHttpRequest',
      referer: TJ_SITE_URL,
      'user-agent': 'Mozilla/5.0 jpop.today chart collector',
    },
    body: new URLSearchParams(payload),
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`TJ API returned ${response.status}`);
  return response.json();
}

async function main() {
  const now = new Date();
  const startDate = process.env.TJ_START_DATE || daysBefore(14, now);
  const endDate = process.env.TJ_END_DATE || seoulDate(now);
  // TJ has renamed date parameters before; try the known shapes in order, undated last.
  const payloads = [
    { chartType: 'TOP', strType: '3', startDate, endDate },
    { chartType: 'TOP', strType: '3', searchStartDate: startDate, searchEndDate: endDate },
    { chartType: 'TOP', strType: '3', startDt: startDate, endDt: endDate },
    { chartType: 'TOP', strType: '3' },
  ];
  let rows = [], usedPayload = null, lastError = null;
  for (const payload of payloads) {
    try {
      rows = findRows(await requestChart(payload));
      usedPayload = payload;
      if (rows.length) break;
    } catch (error) { lastError = error; }
  }
  if (!rows.length) throw new Error(`TJ JPOP chart rows were not found.${lastError ? ` Last error: ${lastError.message}` : ''}`);

  const songs = rows.slice(0, 100).map(normalizeRow).sort((a, b) => a.rank - b.rank);
  if (songs.length < 90 || songs.some(song => !song.title || !song.artist || !/^\d+$/.test(song.tjNumber))
      || new Set(songs.map(song => song.tjNumber)).size !== songs.length)
    throw new Error('TJ chart validation failed; nothing was written.');

  const snapshot = {
    source: 'TJ Media TOP100 JPOP', sourceUrl: TJ_SITE_URL, apiUrl: TJ_TOP100_URL,
    fetchedAt: now.toISOString(), startDate, endDate,
    periodVerified: Boolean(usedPayload.startDate || usedPayload.searchStartDate || usedPayload.startDt),
    requestPayload: usedPayload, songs,
  };
  await mkdir(HISTORY_DIR, { recursive: true });
  const file = join(HISTORY_DIR, `${seoulDate(now)}.json`);
  // 'wx' refuses to replace a snapshot already collected for the same day.
  const handle = await open(file, 'wx');
  try { await handle.writeFile(JSON.stringify(snapshot, null, 2) + '\n'); } finally { await handle.close(); }
  console.log(`Collected ${songs.length} TJ JPOP chart songs into ${file}`);
}

main().catch(error => {
  console.error(`Chart collection failed: ${error.message}`);
  process.exitCode = 1;
});
