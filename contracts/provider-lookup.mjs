/** Browser-safe exact numeric provider URL rules shared by reviewed projections. */
const providers = ['tj', 'ky'];
const number = value => typeof value === 'string' && /^[0-9]{1,10}$/u.test(value) && !/^0+$/u.test(value);
const fail = message => { throw new Error(message); };

export function officialLookup(value, provider, lookupNumber) {
  if (typeof value !== 'string' || /[\s\\#]/u.test(value)) fail('Invalid official lookup URL');
  let url;
  try { url = new URL(value); } catch { fail('Invalid official lookup URL'); }
  const prefix = provider === 'tj'
    ? /^https:\/\/(?:www\.)?tjmedia\.com\/song\/accompaniment_search\?/u
    : /^https:\/\/(?:www\.)?kygabang\.com\/chart\/search_list\.php\?/u;
  if (!prefix.test(value) || url.protocol !== 'https:' || url.username || url.password || url.port || url.hash)
    fail('Invalid official lookup URL');
  const namespace = url.searchParams.get('nationType');
  if (provider === 'tj' && !['JPN', 'KOR'].includes(namespace)) fail('Invalid official lookup namespace');
  const expected = provider === 'tj'
    ? { nationType: namespace, strType: '16', searchTxt: lookupNumber, strWord: 'Y' }
    : { mode: 'SongSearch', val: lookupNumber };
  const query = [...url.searchParams];
  if (query.length !== Object.keys(expected).length || new Set(query.map(([key]) => key)).size !== query.length ||
      !query.every(([key, value]) => Object.hasOwn(expected, key) && expected[key] === value))
    fail('Invalid official numeric lookup query');
}

/** Reuse the ledger's exact numeric URL rules when displaying confirmed evidence. */
export function officialLookupMatches(value, provider, lookupNumber) {
  if (!providers.includes(provider) || !number(lookupNumber)) return false;
  try { officialLookup(value, provider, lookupNumber); return true; }
  catch { return false; }
}

