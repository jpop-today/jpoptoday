import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildPublicCatalog, matchesSong, songHref } from '../contracts/public-catalog.mjs';
const staging = JSON.parse(readFileSync(new URL('../data/staging/legacy-catalog.json', import.meta.url)));
const catalog = buildPublicCatalog(staging);
test('public model preserves actual legacy identities and observations without provenance/lyrics', () => {
  assert.equal(catalog.songs.length, 3317); assert.equal(catalog.songs.filter(song => song.availability === 'current').length, 3313);
  for (const song of catalog.songs) { assert.deepEqual(Object.keys(song).sort(), ['id','titleOriginal','titleKo','artistOriginal','artistKo','tags','availability','origin','karaoke'].sort());
    for (const provider of ['tj','ky']) assert.equal(song.karaoke[provider].observedNumber, staging.songs.find(original => original.id === song.id).karaoke[provider].observedNumber);
    assert.equal(decodeURIComponent(songHref(song.id).slice(7,-1)),song.id);
  }
  assert.ok(catalog.songs.some(song => song.karaoke.ky.conflict));
});
test('legacy combined query and repeated provider/tag filters keep AND semantics', () => {
  const song = catalog.songs.find(song => song.titleOriginal === 'Pretender' && song.origin === 'playlist');
  assert.ok(matchesSong(song, new URLSearchParams('q=프리텐더')));
  assert.ok(matchesSong(song, new URLSearchParams('q=Official Pretender&number=has-tj&number=has-ky')));
  assert.ok(!matchesSong(song, new URLSearchParams('q=Pretender 없는검색어')));
  assert.ok(!matchesSong(song, new URLSearchParams('number=only-tj&number=has-ky')));
  assert.ok(!matchesSong(song, new URLSearchParams('tag=없는태그')));
});
test('empty, incomplete and false verified snapshots cannot become public observations', () => {
  assert.throws(() => buildPublicCatalog({ ...staging, songs: [] }));
  assert.throws(() => buildPublicCatalog({ ...staging, songs: staging.songs.slice(1) }));
  const damaged = structuredClone(staging); damaged.songs[0].karaoke.tj.status = 'registered';
  assert.throws(() => buildPublicCatalog(damaged));
});
