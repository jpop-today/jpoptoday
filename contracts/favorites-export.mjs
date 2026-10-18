import { hasConfirmedNumber } from './public-catalog.mjs';

function formatProvider(song, provider, label) {
  const value = song.karaoke?.[provider];
  if (hasConfirmedNumber(song, provider)) return `${label} ${value.observedNumber} (공식 확인)`;
  if (value?.status === 'observed-unverified' && value.conflict === false &&
      typeof value.observedNumber === 'string' && /^\d+$/u.test(value.observedNumber))
    return `${label} ${value.observedNumber} (관측·미확인)`;
  return `${label} 확인 필요`;
}

/** Export every supplied song in order, preserving provider state and number strings. */
export function formatFavoritesExport(songs) {
  return songs.map(song => `${song.titleOriginal} · ${song.artistOriginal} | ${formatProvider(song, 'tj', 'TJ')} | ${formatProvider(song, 'ky', '금영')}`).join('\n');
}
