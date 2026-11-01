import test from 'node:test';
import assert from 'node:assert/strict';
import { buildArtistPages, introLength, ARTIST_INDEX_MIN_INTRO_CHARS } from '../contracts/artists.mjs';

const evidence = { url: 'https://www.tjmedia.com/song/accompaniment_search?nationType=JPN&strType=16&searchTxt=52756&strWord=Y', checkedAt: '2026-10-22', title: 'T', artist: 'A' };
const confirmed = { status: 'provider-confirmed', observedNumber: '52756', conflict: false, evidence };
const none = { status: 'unknown', observedNumber: null, conflict: false, evidence: null };
const songs = [1, 2, 3].map(n => ({ id: `s${n}`, titleOriginal: `T${n}`, artistOriginal: 'A', availability: 'current', origin: 'playlist', karaoke: { tj: confirmed, ky: none } }));
const intro = body => ({ slug: 'a', name: 'A', artists: ['A'], draft: false, body });

test('a short blurb over the number list stays noindex; a full written intro indexes', () => {
  const short = '가'.repeat(ARTIST_INDEX_MIN_INTRO_CHARS - 1);
  const full = '## 소개\n\n' + '가 '.repeat(ARTIST_INDEX_MIN_INTRO_CHARS);
  assert.equal(introLength('## 제목\n\n**굵게** [링크](x)'), 7);
  assert.equal(buildArtistPages(songs, [intro(short)], new Map())[0].indexable, false);
  assert.equal(buildArtistPages(songs, [intro(full)], new Map())[0].indexable, true);
  assert.equal(buildArtistPages(songs.slice(0, 2), [intro(full)], new Map())[0].indexable, false);
});
