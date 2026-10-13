import { validateCatalog } from './catalog.mjs';

// Whole-catalog collection may add or correct records, but a missing record or
// lost confirmed provider state is a failed collection, not a deletion request.
export function validateCatalogChange(previous, candidate) {
  const errors = [
    ...validateCatalog(previous).map(error => ({ path: 'previous.' + error.path, message: error.message })),
    ...validateCatalog(candidate).map(error => ({ path: 'candidate.' + error.path, message: error.message })),
  ];
  if (errors.length) return errors;
  const nextSongs = new Map(candidate.songs.map(song => [song.id, song]));
  for (const song of previous.songs) {
    const next = nextSongs.get(song.id);
    if (!next) {
      errors.push({ path: 'songs.' + song.id, message: 'Existing song ID is missing from the whole-catalog candidate' });
      continue;
    }
    for (const provider of ['tj', 'ky']) {
      if (song.karaoke[provider].status !== 'unknown' && next.karaoke[provider].status === 'unknown')
        errors.push({ path: 'songs.' + song.id + '.karaoke.' + provider, message: 'Confirmed provider state cannot become unknown during collection' });
    }
  }
  return errors;
}
