import { createIdentityResolver, readFavorites, updateFavorites, readRecentFilters, resolveLegacyUrl } from '../../contracts/legacy-compatibility.mjs';
import { matchesSong, songHref } from '../../contracts/public-catalog.mjs';
import type { Song } from '../lib/catalog';

const byId = (id: string) => document.getElementById(id);
const status = byId('status');
let statusTimer: ReturnType<typeof setTimeout>;
function announce(message: string) {
  if (!status) return;
  status.textContent = message; status.hidden = false;
  clearTimeout(statusTimer); statusTimer = setTimeout(() => { status.hidden = true; }, 5000);
}
const storage = { getItem: (key: string) => window.localStorage.getItem(key),
  setItem: (key: string, value: string) => window.localStorage.setItem(key, value), removeItem: (key: string) => window.localStorage.removeItem(key) };
const dialog = byId('copy-dialog') as HTMLDialogElement;
const copyText = byId('copy-text') as HTMLTextAreaElement;
async function copy(value: string) {
  try { await navigator.clipboard.writeText(value); announce('복사했습니다.'); }
  catch { copyText.value = value; dialog.showModal(); copyText.focus(); copyText.select(); }
}
byId('close-copy')?.addEventListener('click', () => dialog.close());
document.addEventListener('click', event => {
  const target = (event.target as Element).closest<HTMLButtonElement>('[data-copy]');
  if (target?.dataset.copy) void copy(target.dataset.copy);
});
if (location.hash === '#favorites-view' && ['/', '/index.html', '/index'].includes(location.pathname))
  location.replace('/favorites/' + location.search);

const view = document.querySelector<HTMLElement>('[data-list-view]');
const legacyRoute = ['/song', '/song/', '/song.html', '/filter', '/filter.html', '/search.html', '/favorites.html'].includes(location.pathname);
if (view || legacyRoute || document.querySelector('[data-save]')) void initialize();

async function initialize() {
  let songs: Song[];
  try {
    const response = await fetch('/catalog.json');
    if (!response.ok) throw new Error('Catalog unavailable');
    const payload = await response.json();
    if (payload.version !== 1 || !Array.isArray(payload.songs) || !payload.songs.length) throw new Error('Invalid catalog');
    songs = payload.songs;
  } catch {
    announce('목록을 불러오지 못했습니다. 새로고침하거나 표시된 곡 상세를 이용해 주세요.');
    const legacy = byId('legacy-status'); if (legacy) legacy.textContent = '곡 목록을 불러오지 못했습니다. 주소를 보존하고 다시 시도해 주세요.';
    return;
  }
  const resolver = createIdentityResolver({ identities: songs.map(song => ({ id: song.id })) });
  const resolved = resolveLegacyUrl(location.href, resolver, { origin: location.origin });
  if (resolved.status === 'redirect' && legacyRoute && resolved.href) { location.replace(resolved.href); return; }
  if (legacyRoute && ['unresolved', 'rejected'].includes(resolved.status)) {
    const legacy = byId('legacy-status'); if (legacy) legacy.textContent = '이 주소의 곡을 현재 목록에서 찾지 못했습니다. 다른 곡으로 연결하지 않았습니다.';
  }
  let favorites = readFavorites(storage, resolver);
  const sessionKey = 'jpop_today_favorites.session.v1';
  let sessionAvailable = true;
  try {
    const cached = sessionStorage.getItem(sessionKey);
    if (cached !== null) {
      const snapshot = JSON.parse(cached);
      // A successful read does not imply that the previous write succeeded.
      // Restore failed-write session state only against the same original bytes;
      // never override another tab's newer persistent snapshot with stale cache.
      const values = snapshot?.version === 1 && snapshot.originalRaw === favorites.raw && Array.isArray(snapshot.values)
        ? snapshot.values : favorites.mode === 'session' && Array.isArray(snapshot) ? snapshot : null;
      if (values) {
        const restored = readFavorites({ getItem: () => JSON.stringify(values) }, resolver);
        favorites = { ...favorites, mode: 'session', status: 'session-only', values: restored.values, entries: restored.entries };
      }
    }
  } catch { sessionAvailable = false; }
  function preserveSession() {
    try {
      if (favorites.mode === 'session') sessionStorage.setItem(sessionKey, JSON.stringify({ version: 1, originalRaw: favorites.raw, values: favorites.values }));
      else sessionStorage.removeItem(sessionKey);
    } catch { sessionAvailable = false; }
  }
  const savedIds = () => new Set(favorites.entries.filter((entry: { status: string }) => entry.status === 'known').map((entry: { canonicalId: string }) => entry.canonicalId));
  function syncSaveButtons() {
    const ids = savedIds();
    document.querySelectorAll<HTMLButtonElement>('[data-save]').forEach(button => {
      button.disabled = false;
      const selected = ids.has(button.dataset.save);
      button.setAttribute('aria-pressed', String(selected));
      const song = songs.find(song => song.id === button.dataset.save);
      button.setAttribute('aria-label', `${song?.titleOriginal ?? '곡'} ${selected ? '저장 해제' : '저장'}`);
      if (button.classList.contains('detail-save')) button.lastChild!.textContent = selected ? ' 즐겨찾기 해제' : ' 즐겨찾기 저장';
    });
    const note = byId('storage-note');
    if (note) { note.hidden = favorites.mode !== 'session'; note.textContent = sessionAvailable ? '브라우저에 영구 저장할 수 없어 이 탭에서만 유지합니다. 기존 저장값은 보존했습니다. 번호 목록을 복사해 두세요.' : '브라우저에 저장할 수 없어 현재 화면에서만 유지합니다. 이동하기 전에 번호 목록을 복사해 두세요. 기존 저장값은 보존했습니다.'; }
  }
  document.addEventListener('click', event => {
    const button = (event.target as Element).closest<HTMLButtonElement>('[data-save]');
    const remove = (event.target as Element).closest<HTMLButtonElement>('[data-remove]');
    const id = button?.dataset.save ?? remove?.dataset.remove;
    if (!id) return;
    const action = remove || savedIds().has(id) ? 'remove' : 'save';
    favorites = updateFavorites(storage, resolver, { action, id }, { state: favorites });
    preserveSession();
    syncSaveButtons(); if (view) render();
    announce(favorites.mode === 'session' ? sessionAvailable ? '이 탭에서만 저장했습니다. 번호 목록을 복사해 두세요.' : '현재 화면에서만 저장했습니다. 이동 전에 번호 목록을 복사해 두세요.' : action === 'save' ? '즐겨찾기에 저장했습니다.' : '즐겨찾기에서 해제했습니다.');
  });
  syncSaveButtons();
  if (!view) { document.documentElement.dataset.appReady = 'true'; return; }

  const form = byId('search-form') as HTMLFormElement;
  const query = byId('query') as HTMLInputElement;
  const list = byId('song-list')!;
  let shown = 5;
  let filtered: Song[] = [];
  const preferredTitles = ['アイドル', 'Lemon', '夜に駆ける', '怪獣の花唄', 'Pretender'];
  const preferred = preferredTitles.map(title => songs.find(song => song.titleOriginal === title && song.origin === 'playlist')?.id);
  const ordered = [...songs].sort((a, b) => {
    const ai = preferred.indexOf(a.id), bi = preferred.indexOf(b.id);
    return (ai < 0 ? 100 : ai) - (bi < 0 ? 100 : bi);
  });
  function setUrl(params: URLSearchParams) {
    const url = new URL(location.href); url.search = params.toString(); history.pushState(null, '', url); shown = 5; render();
  }
  form.addEventListener('submit', event => { event.preventDefault(); const params = new URLSearchParams(location.search);
    const value = query.value.trim(); if (value) params.set('q', value); else params.delete('q'); params.delete('page'); setUrl(params); });
  document.querySelectorAll<HTMLButtonElement>('[data-filter]').forEach(button => button.addEventListener('click', () => {
    const params = new URLSearchParams(location.search); const filter = button.dataset.filter!;
    const numbers = params.getAll('number'); params.delete('number'); params.delete('page');
    if (filter !== 'all') {
      const selected = numbers.includes(filter); const next = selected ? numbers.filter(value => value !== filter) : [...numbers, filter];
      next.forEach(value => params.append('number', value));
    }
    setUrl(params);
  }));
  byId('clear-filters')?.addEventListener('click', () => setUrl(new URLSearchParams()));
  byId('more')?.addEventListener('click', () => { shown += 30; render(); });
  window.addEventListener('popstate', () => { shown = 5; render(); });
  window.addEventListener('storage', event => { if (event.key === 'jpop_today_favorites') { favorites = readFavorites(storage, resolver); render(); } });
  byId('copy-favorites')?.addEventListener('click', () => {
    if (!filtered.length) { announce('복사할 곡이 없습니다.'); return; }
    void copy(filtered.map(song => `${song.titleOriginal} · ${song.artistOriginal} | TJ ${song.karaoke.tj.observedNumber ?? '확인 필요'} | 금영 ${song.karaoke.ky.observedNumber ?? '확인 필요'}`).join('\n'));
  });

  function icon(name: 'copy' | 'star') {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('width', '20'); svg.setAttribute('height', '20'); svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor'); svg.setAttribute('stroke-width', '1.7'); svg.setAttribute('stroke-linecap', 'round'); svg.setAttribute('stroke-linejoin', 'round'); svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', name === 'copy' ? 'M9 6V3h11v14h-3M4 7h11v14H4z' : 'm12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2L3 9.6l6.2-.9z'); svg.append(path); return svg;
  }
  function row(song: Song) {
    const li = document.createElement('li'); li.className = 'song-row'; li.dataset.songId = song.id;
    const name = document.createElement('div'); name.className = 'song-name';
    const link = document.createElement('a'); link.href = songHref(song.id); link.textContent = song.titleOriginal;
    const sub = document.createElement('p'); sub.textContent = [song.titleKo, song.artistKo || song.artistOriginal].filter(Boolean).join(' · '); name.append(link, sub); li.append(name);
    for (const provider of ['tj', 'ky'] as const) {
      const cell = document.createElement('div'); cell.className = 'number-cell';
      const label = document.createElement('span'); label.className = 'mobile-label'; label.textContent = provider === 'tj' ? 'TJ' : '금영'; cell.append(label);
      const value = song.karaoke[provider];
      if (value.observedNumber) { const button = document.createElement('button'); button.type = 'button'; button.className = 'number-button' + (value.conflict ? ' conflict' : '');
        button.dataset.copy = value.observedNumber; button.setAttribute('aria-label', `${song.titleOriginal} ${label.textContent} 관측 번호 ${value.observedNumber} 복사`);
        button.append(document.createTextNode(value.observedNumber), icon('copy')); cell.append(button);
      } else { const unknown = document.createElement('span'); unknown.className = 'unknown'; unknown.textContent = '확인 필요'; cell.append(unknown); }
      li.append(cell);
    }
    const save = document.createElement('button'); save.type = 'button'; save.className = 'save-button'; save.dataset.save = song.id; save.append(icon('star')); li.append(save); return li;
  }
  function renderUnresolved() {
    const wrapper = byId('unresolved-favorites'), unresolvedList = byId('unresolved-list');
    if (!wrapper || !unresolvedList) return;
    const entries = favorites.entries.filter((entry: { status: string }) => entry.status !== 'known');
    wrapper.hidden = !entries.length; unresolvedList.replaceChildren();
    for (const entry of entries) {
      const li = document.createElement('li'); li.textContent = typeof entry.id === 'string' ? entry.id : '손상된 저장 항목 (원본 보존)';
      if (typeof entry.id === 'string' && entry.status === 'missing') { const remove = document.createElement('button'); remove.type = 'button'; remove.dataset.remove = entry.id; remove.textContent = '이 항목 해제'; li.append(' ', remove); }
      unresolvedList.append(li);
    }
  }
  function render() {
    const params = new URLSearchParams(location.search); query.value = params.get('q') ?? '';
    const isFavorites = view?.dataset.listView === 'favorites'; const ids = savedIds();
    filtered = ordered.filter(song => (isFavorites ? ids.has(song.id) : song.availability === 'current') && matchesSong(song, params));
    const page = Math.max(1, Number.parseInt(params.get('page') ?? '', 10) || 1);
    const offset = (page - 1) * 30; const hasQuery = params.toString() !== '';
    const limit = hasQuery || isFavorites ? Math.max(30, shown) : shown;
    list.replaceChildren(...filtered.slice(offset, offset + limit).map(row));
    const count = byId('result-count'); if (count) count.textContent = `${filtered.length.toLocaleString('ko-KR')}곡`;
    const empty = byId('empty-message'); if (empty) { empty.hidden = filtered.length > 0 && offset < filtered.length;
      if (!empty.hidden) empty.textContent = filtered.length && offset >= filtered.length ? '이 페이지에 곡이 없습니다. 조건 해제로 첫 목록을 열어보세요.' : isFavorites ? '저장한 곡이 없거나 조건에 맞는 곡이 없습니다. 노래 찾기에서 곡을 저장하거나 조건을 해제하세요.' : '일치하는 곡이 없습니다. 제목 일부나 가수로 다시 찾아보세요.'; }
    const more = byId('more'); if (more) more.hidden = filtered.length <= offset + limit;
    const numbers = params.getAll('number');
    document.querySelectorAll<HTMLElement>('[data-filter]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.filter === 'all' ? !numbers.length : numbers.includes(button.dataset.filter!))));
    const active = byId('active-filters'); if (active) active.hidden = !hasQuery;
    const summary = byId('filter-summary'); if (summary) summary.textContent = [query.value, ...numbers.map(v => ({ 'has-tj': 'TJ 번호 있음', 'has-ky': '금영 번호 있음', 'only-tj': 'TJ 번호만 확보', 'only-ky': '금영 번호만 확보' })[v] ?? v), ...params.getAll('tag'), ...(params.get('anime') === 'all' ? ['애니메이션 전체'] : []), ...(params.get('artist') === 'all' ? ['가수 전체'] : [])].join(' · ');
    renderUnresolved(); syncSaveButtons();
  }
  const recent = readRecentFilters(storage);
  if (recent.entries.length) {
    const details = document.createElement('details'); details.className = 'recent-filters'; const label = document.createElement('summary'); label.textContent = '최근 사용한 필터'; details.append(label);
    for (const item of recent.entries) { const button = document.createElement('button'); button.type = 'button'; button.textContent = item.value || (item.type === 'anime-all' ? '애니메이션 전체' : '가수 전체');
      button.addEventListener('click', () => { const params = new URLSearchParams(location.search); params.delete('page');
        if (item.type === 'number') params.append('number', item.value); else if (item.type === 'tag') params.append('tag', item.value);
        else params.set(item.type === 'anime-all' ? 'anime' : 'artist', 'all'); setUrl(params); }); details.append(button); }
    view.append(details);
  }
  render();
  document.querySelectorAll<HTMLButtonElement>('[data-filter], #more, #copy-favorites').forEach(button => { button.disabled = false; });
  document.documentElement.dataset.appReady = 'true';
}
