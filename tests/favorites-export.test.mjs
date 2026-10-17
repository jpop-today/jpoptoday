import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { formatFavoritesExport } from '../contracts/favorites-export.mjs';
import { buildPublicCatalog } from '../contracts/public-catalog.mjs';
import { applyProviderCorrections } from '../contracts/provider-corrections.mjs';
import { createIdentityResolver, readFavorites } from '../contracts/legacy-compatibility.mjs';

const lookup = (provider, number) => provider === 'tj'
  ? `https://www.tjmedia.com/song/accompaniment_search?nationType=JPN&strType=16&searchTxt=${number}&strWord=Y`
  : `https://kygabang.com/chart/search_list.php?mode=SongSearch&val=${number}`;
const confirmed = (provider, number) => ({ status: 'provider-confirmed', observedNumber: number, conflict: false,
  evidence: { url: lookup(provider, number), checkedAt: '2026-10-14T10:00:00+09:00', title: '合成曲', artist: '合成歌手' }, correction: null });
const unknown = () => ({ status: 'unknown', observedNumber: null, conflict: false, evidence: null, correction: null });
const observed = number => ({ ...unknown(), status: 'observed-unverified', observedNumber: number });
const song = (id = 'synthetic-export') => ({ id, titleOriginal: '合成曲', titleKo: '합성곡', artistOriginal: '合成歌手', artistKo: '합성가수',
  availability: 'current', origin: 'playlist', tags: [], karaoke: { tj: confirmed('tj', '00123'), ky: observed('00517') } });
const freeze = value => {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
};
const cell = (provider, text) => (provider === 'tj' ? 'TJ ' : '금영 ') + text;
const exportedCell = (value, provider) => formatFavoritesExport([value]).split(' | ')[provider === 'tj' ? 1 : 2];

test('export keeps titles, artists, provider-specific status, order and leading-zero strings without mutation', () => {
  const first = song(), second = song('second');
  second.titleOriginal = '第二曲'; second.artistOriginal = '別の歌手';
  second.karaoke = { tj: unknown(), ky: confirmed('ky', '00042') };
  const input = freeze([second, first]), before = JSON.stringify(input);
  assert.equal(formatFavoritesExport(input), '第二曲 · 別の歌手 | TJ 확인 필요 | 금영 00042 (공식 확인)\n合成曲 · 合成歌手 | TJ 00123 (공식 확인) | 금영 00517 (관측·미확인)');
  assert.equal(JSON.stringify(input), before);
  assert.equal(formatFavoritesExport([]), '');
  assert.doesNotMatch(formatFavoritesExport(input), /미수록|unlisted|undefined|null/u);
});

test('observed exports preserve the existing numeric string contract and never claim official confirmation', () => {
  for (const provider of ['tj', 'ky']) {
    for (const number of ['00123', '0', '0000', '12345678901']) {
      const value = song(); value.karaoke[provider] = observed(number);
      assert.equal(exportedCell(value, provider), cell(provider, `${number} (관측·미확인)`));
    }
    for (const status of ['unknown', 'registered', 'unlisted', undefined]) {
      const value = song(); value.karaoke[provider] = { ...observed('00123'), status };
      assert.equal(exportedCell(value, provider), cell(provider, '확인 필요'), `${provider}/${String(status)}`);
    }
    for (const conflict of [true, undefined, null, 'false', 0]) {
      const value = song(); value.karaoke[provider] = { ...observed('00123'), conflict };
      assert.equal(exportedCell(value, provider), cell(provider, '확인 필요'), `${provider}/conflict=${String(conflict)}`);
    }
    for (const number of [null, undefined, 123, '', ' ', '-123', '１２３', '123\n', '12 3', '123a']) {
      const value = song(); value.karaoke[provider] = observed(number);
      assert.equal(exportedCell(value, provider), cell(provider, '확인 필요'), `${provider}/${String(number)}`);
    }
  }
});

test('suppression and conflicts withhold their old or ambiguous numbers, including misleading evidence', () => {
  for (const provider of ['tj', 'ky']) {
    const suppressed = song();
    suppressed.karaoke[provider] = { ...unknown(), correction: { reason: '합성 버전 불일치', previousNumber: '99998' } };
    assert.equal(exportedCell(suppressed, provider), cell(provider, '확인 필요'));
    assert.doesNotMatch(formatFavoritesExport([suppressed]), /99998|미수록/u);
    for (const status of ['provider-confirmed', 'observed-unverified', 'unknown']) {
      const value = song(); value.karaoke[provider] = { ...confirmed(provider, '99998'), status, conflict: true };
      assert.equal(exportedCell(value, provider), cell(provider, '확인 필요'), `${provider}/${status}`);
      assert.doesNotMatch(formatFavoritesExport([value]), /99998/u);
    }
  }
});

test('official labels require complete matching evidence and current playlist identity for each provider', () => {
  for (const provider of ['tj', 'ky']) {
    const baseline = song(); baseline.karaoke[provider] = confirmed(provider, '00123');
    assert.equal(exportedCell(baseline, provider), cell(provider, '00123 (공식 확인)'));
    const missing = structuredClone(baseline); missing.karaoke[provider].evidence = null;
    assert.equal(exportedCell(missing, provider), cell(provider, '확인 필요'));
    for (const key of ['url', 'checkedAt', 'title', 'artist']) for (const invalid of [undefined, null, '', ' ', 1]) {
      const value = structuredClone(baseline); value.karaoke[provider].evidence[key] = invalid;
      assert.equal(exportedCell(value, provider), cell(provider, '확인 필요'), `${provider}/${key}/${String(invalid)}`);
    }
    for (const conflict of [true, undefined, null, 'false', 0]) {
      const value = structuredClone(baseline); value.karaoke[provider].conflict = conflict;
      assert.equal(exportedCell(value, provider), cell(provider, '확인 필요'), `${provider}/conflict=${String(conflict)}`);
    }
    for (const metadata of [{ availability: 'archived' }, { origin: 'chart-only' }])
      assert.equal(exportedCell({ ...baseline, ...metadata }, provider), cell(provider, '확인 필요'), JSON.stringify(metadata));
    const original = lookup(provider, '00123');
    for (const url of [lookup(provider, '00124'), lookup(provider === 'tj' ? 'ky' : 'tj', '00123'), original.replace('https:', 'http:'),
      original.replace('.com/', '.com.evil.invalid/'), original.replace('https://', 'https://operator:synthetic@'),
      `${original}#fragment`, `${original}&token=synthetic`, `${original}${provider === 'tj' ? '&searchTxt=00123' : '&val=00123'}`]) {
      const value = structuredClone(baseline); value.karaoke[provider].evidence.url = url;
      assert.equal(exportedCell(value, provider), cell(provider, '확인 필요'), `${provider}/${url}`);
    }
    for (const number of [null, 123, '0', '0000', '-123', '１２３', '123\n', '12345678901']) {
      const value = structuredClone(baseline); value.karaoke[provider].observedNumber = number;
      value.karaoke[provider].evidence.url = lookup(provider, String(number));
      assert.equal(exportedCell(value, provider), cell(provider, '확인 필요'), `${provider}/${String(number)}`);
    }
  }
});

const staging = JSON.parse(readFileSync(new URL('../data/staging/legacy-catalog.json', import.meta.url), 'utf8'));
const ledger = JSON.parse(readFileSync(new URL('../data/reviewed/provider-corrections.json', import.meta.url), 'utf8'));
const publicSongs = applyProviderCorrections(buildPublicCatalog(staging).songs, staging, ledger);
const rawById = new Map(staging.songs.map(value => [value.id, value]));
const correctionByCell = new Map(ledger.entries.map(entry => [JSON.stringify([entry.songId, entry.provider]), entry]));
// Independent oracle uses raw cells, reviewed actions and post-correction number
// multiplicity. It never calls formatFavoritesExport or hasConfirmedNumber.
const correctedNumber = (raw, provider) => {
  const entry = correctionByCell.get(JSON.stringify([raw.id, provider]));
  return entry ? entry.number : raw.karaoke[provider].observedNumber;
};
const counts = Object.fromEntries(['tj', 'ky'].map(provider => {
  const result = new Map();
  for (const raw of staging.songs) {
    const number = correctedNumber(raw, provider);
    if (number !== null) result.set(number, (result.get(number) ?? 0) + 1);
  }
  return [provider, result];
}));
function expectedCell(raw, provider) {
  const entry = correctionByCell.get(JSON.stringify([raw.id, provider]));
  const number = correctedNumber(raw, provider);
  if (number === null || counts[provider].get(number) !== 1) return cell(provider, '확인 필요');
  if (entry) return cell(provider, entry.action === 'confirm' && raw.availability === 'current' && raw.origin === 'playlist'
    ? `${number} (공식 확인)` : '확인 필요');
  return cell(provider, raw.karaoke[provider].status === 'observed-unverified' ? `${number} (관측·미확인)` : '확인 필요');
}
const expectedLine = raw => `${raw.titleOriginal} · ${raw.artistOriginal} | ${expectedCell(raw, 'tj')} | ${expectedCell(raw, 'ky')}`;

test('all frozen public exports match an independent raw-plus-ledger oracle, including duplicate-number suppression', () => {
  const before = JSON.stringify(publicSongs);
  assert.equal(publicSongs.length, staging.songs.length);
  assert.ok(staging.songs.length > 3000);
  assert.ok(staging.songs.some(raw => ['tj', 'ky'].some(provider => {
    const number = correctedNumber(raw, provider);
    return number !== null && counts[provider].get(number) > 1;
  })), 'the real-data oracle must exercise conflicting observations');
  assert.equal(formatFavoritesExport(freeze(structuredClone(publicSongs))), staging.songs.map(expectedLine).join('\n'));
  assert.equal(JSON.stringify(publicSongs), before);
});

test('actual SAM/Ado deferred KY numbers stay observed and suppressed original-version numbers stay absent', () => {
  for (const id of ['jpop-playlist-samfree-ルカルカ-ナイトフィ-ハ-f6722acd10', 'jpop-playlist-ado-逆光-c8c1ba8b20']) {
    const raw = rawById.get(id), actual = publicSongs.find(value => value.id === id);
    assert.ok(raw && actual);
    assert.match(expectedCell(raw, 'tj'), /\(공식 확인\)$/u);
    assert.match(expectedCell(raw, 'ky'), /\(관측·미확인\)$/u);
    assert.equal(formatFavoritesExport([actual]), expectedLine(raw));
  }
  const id = 'jpop-playlist-radwimps-前前前世-original-ver-1ff3eb38b9';
  const raw = rawById.get(id), actual = publicSongs.find(value => value.id === id);
  assert.ok(raw && actual);
  for (const provider of ['tj', 'ky']) {
    assert.equal(correctionByCell.get(JSON.stringify([id, provider])).action, 'suppress');
    assert.equal(exportedCell(actual, provider), cell(provider, '확인 필요'));
  }
  assert.equal(formatFavoritesExport([actual]), `${raw.titleOriginal} · ${raw.artistOriginal} | TJ 확인 필요 | 금영 확인 필요`);
});

test('reading and exporting known favorites preserves unresolved IDs, metadata and exact storage bytes', () => {
  const resolver = createIdentityResolver({ identities: publicSongs.map(value => ({ id: value.id })) });
  const selected = publicSongs.find(value => value.titleOriginal === 'Pretender' && value.origin === 'playlist');
  assert.ok(selected);
  const raw = ` [ { "id" : ${JSON.stringify(selected.id)}, "note" : "원문 보존" }, "legacy-unknown-export-id" ] `;
  let writes = 0;
  const state = readFavorites({ getItem: () => raw, setItem: () => { writes++; } }, resolver);
  const original = JSON.stringify(state);
  const values = state.entries.filter(entry => entry.status === 'known').map(entry => publicSongs.find(value => value.id === entry.canonicalId));
  assert.equal(formatFavoritesExport(values), expectedLine(rawById.get(selected.id)));
  assert.equal(JSON.stringify(state), original);
  assert.equal(state.raw, raw); assert.equal(writes, 0);
  assert.equal(state.entries[1].status, 'missing');
  assert.equal(state.entries[1].value, 'legacy-unknown-export-id');
  assert.equal(state.values[0].note, '원문 보존');
});
