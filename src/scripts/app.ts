import { createIdentityResolver, readFavorites, updateFavorites, mergeFavorites, readRecentFilters, resolveLegacyUrl } from '../../contracts/legacy-compatibility.mjs';
import { hasConfirmedNumber, matchesSong, songHref } from '../../contracts/public-catalog.mjs';
import { formatFavoritesExport } from '../../contracts/favorites-export.mjs';
import { MAX_FAVORITES_BACKUP_BYTES, formatFavoritesBackup, parseFavoritesBackup } from '../../contracts/favorites-backup.mjs';
import type { Song } from '../lib/catalog';

const byId = (id: string) => document.getElementById(id);
const numberFilterLabels: Record<string, string> = {
  'has-tj': 'TJ 번호 있음', 'has-ky': '금영 번호 있음',
  'only-tj': 'TJ 번호만 확보', 'only-ky': '금영 번호만 확보',
  'confirmed-tj': 'TJ 공식 확인', 'confirmed-ky': '금영 공식 확인',
};
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
    if (![1, 2].includes(payload.version) || !Array.isArray(payload.songs) || !payload.songs.length) throw new Error('Invalid catalog');
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
  const backupFile = byId('favorites-backup-file') as HTMLInputElement | null;
  const backupPreview = byId('favorites-backup-preview');
  const backupMerge = byId('merge-favorites-backup') as HTMLButtonElement | null;
  const backupCancel = byId('cancel-favorites-backup') as HTMLButtonElement | null;
  let backupGeneration = 0;
  let backupReading = false;
  let pendingBackup: { values: ReturnType<typeof parseFavoritesBackup>['values']; expectedRaw: string | null } | null = null;
  function backupMessage(message: string) {
    const note = byId('favorites-backup-status'); if (note) note.textContent = message;
  }
  function invalidateBackup(message = '') {
    const wasPending = pendingBackup !== null || backupReading;
    backupGeneration++; backupReading = false; pendingBackup = null;
    if (backupPreview) backupPreview.hidden = true;
    if (backupMerge) backupMerge.disabled = true;
    if (backupCancel) backupCancel.disabled = true;
    if (backupFile) backupFile.value = '';
    if (message && wasPending) backupMessage(message);
  }
  const savedIds = () => new Set(favorites.entries.filter((entry: { status: string }) => entry.status === 'known').map((entry: { canonicalId: string }) => entry.canonicalId));
  const recoveryUnverified = () => favorites.diagnostics.some((item: { code: string }) => ['rollback-failed', 'rollback-concurrent-change'].includes(item.code));
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
    if (note) {
      note.hidden = favorites.mode !== 'session';
      note.textContent = recoveryUnverified()
        ? '저장 결과와 원본 복구를 확인하지 못했습니다. 이동 전에 현재 읽을 수 있는 목록을 복사하거나 즐겨찾기에서 파일로 보관해 주세요.'
        : sessionAvailable ? '브라우저에 영구 저장할 수 없어 이 탭에서만 유지합니다. 기존 저장값은 보존했습니다. 번호 목록을 복사하거나 즐겨찾기에서 유효한 목록을 파일로 보관해 두세요.' : '브라우저에 저장할 수 없어 현재 화면에서만 유지합니다. 이동 전에 번호 목록을 복사하거나 즐겨찾기에서 유효한 목록을 파일로 보관해 두세요. 기존 저장값은 보존했습니다.';
    }
  }
  document.addEventListener('click', event => {
    const button = (event.target as Element).closest<HTMLButtonElement>('[data-save]');
    const remove = (event.target as Element).closest<HTMLButtonElement>('[data-remove]');
    const id = button?.dataset.save ?? remove?.dataset.remove;
    if (!id) return;
    invalidateBackup('저장 목록이 바뀌어 가져오기 확인을 취소했습니다. 파일을 다시 선택해 주세요.');
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
  window.addEventListener('storage', event => {
    // sessionStorage has its own events; clearing it must not discard a valid
    // session-only favorites list held by this page.
    try { if (event.storageArea !== null && event.storageArea !== window.localStorage) return; } catch { return; }
    if (event.key === 'jpop_today_favorites' || event.key === null) {
    invalidateBackup('다른 탭의 저장 목록 변경으로 가져오기 확인을 취소했습니다. 파일을 다시 선택해 주세요.');
    favorites = readFavorites(storage, resolver); preserveSession(); render();
  } });
  byId('copy-favorites')?.addEventListener('click', () => {
    if (!filtered.length) { announce('복사할 곡이 없습니다.'); return; }
    void copy(formatFavoritesExport(filtered));
  });
  byId('download-favorites-backup')?.addEventListener('click', () => {
    try {
      // Damaged/unreadable storage is represented as an empty values array.
      // Do not pass that placeholder off as a successful empty backup.
      if (['invalid-json', 'invalid-shape', 'invalid-storage', 'read-failed'].includes(favorites.status)) {
        backupMessage('원래 저장 목록을 정상적으로 읽을 수 없어 파일로 보관하지 않았습니다. 원본을 빈 파일로 대신하지 않았습니다.'); return;
      }
      const contents = formatFavoritesBackup(favorites.values, resolver);
      const url = URL.createObjectURL(new Blob([contents], { type: 'application/json;charset=utf-8' }));
      const link = document.createElement('a'); link.href = url; link.download = 'jpoptoday-favorites-v1.json'; link.hidden = true;
      document.body.append(link);
      try { link.click(); } finally { link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
      backupMessage(favorites.mode === 'session'
        ? '현재 읽을 수 있는 임시 목록의 파일 저장을 요청했습니다. 손상되거나 읽을 수 없는 원본 데이터는 포함하지 않습니다. 다운로드 폴더에서 확인하고 직접 보관해 주세요.'
        : '파일 저장을 요청했습니다. 다운로드 폴더에서 파일을 확인하고 직접 보관해 주세요.');
    } catch {
      backupMessage('파일로 보관하지 못했습니다. 손상된 항목이 있거나 파일 크기 한도를 넘었을 수 있습니다. 원래 저장값은 그대로 두었습니다.');
    }
  });
  backupFile?.addEventListener('change', async () => {
    const file = backupFile.files?.[0];
    invalidateBackup();
    if (!file) { backupMessage('가져올 보관 파일을 선택해 주세요. 저장 목록은 바꾸지 않았습니다.'); return; }
    if (file.size > MAX_FAVORITES_BACKUP_BYTES) { backupMessage('파일이 256KiB를 넘습니다. 저장 목록은 바꾸지 않았습니다.'); return; }
    const generation = backupGeneration;
    const expectedRaw = typeof favorites.raw === 'string' ? favorites.raw : null;
    backupReading = true;
    if (backupCancel) backupCancel.disabled = false;
    backupMessage('파일을 확인하고 있습니다. 아직 저장 목록은 바꾸지 않았습니다.');
    try {
      const bytes = await file.arrayBuffer();
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      const backup = parseFavoritesBackup(text, resolver);
      if (generation !== backupGeneration) return;
      backupReading = false; pendingBackup = { values: backup.values, expectedRaw };
      const counts = byId('favorites-backup-counts');
      if (counts) counts.textContent = `파일 항목 ${backup.total}개: 현재 곡 자료에서 찾은 ID ${backup.known}개, 다시 확인할 ID ${backup.unresolved}개입니다. 중복 항목도 개수에 포함합니다.`;
      if (backupPreview) backupPreview.hidden = false;
      if (backupMerge) backupMerge.disabled = false;
      backupMessage('파일 확인을 마쳤습니다. 아직 저장 목록은 바꾸지 않았습니다. 내용을 확인한 뒤 현재 목록에 합쳐 주세요.');
    } catch {
      if (generation !== backupGeneration) return;
      invalidateBackup();
      backupMessage('보관 파일을 읽지 못했습니다. UTF-8 JSON, 지원 형식·버전과 유효한 ID인지 확인해 주세요. 저장 목록은 바꾸지 않았습니다.');
    }
  });
  backupCancel?.addEventListener('click', () => {
    invalidateBackup(); backupMessage('가져오기를 취소했습니다. 저장 목록은 바꾸지 않았습니다.');
  });
  backupMerge?.addEventListener('click', () => {
    if (!pendingBackup) return;
    const candidate = pendingBackup; invalidateBackup();
    try {
      const result = mergeFavorites(storage, resolver, candidate.values, { state: favorites, expectedRaw: candidate.expectedRaw });
      if (result.status === 'conflict') {
        favorites = readFavorites(storage, resolver); preserveSession(); render();
        backupMessage('저장 목록이 바뀌어 합치지 않았습니다. 파일을 다시 선택하고 확인해 주세요.'); return;
      }
      favorites = result; preserveSession(); render();
      if (recoveryUnverified()) backupMessage('저장 결과와 원본 복구를 확인하지 못했습니다. 이동 전에 현재 읽을 수 있는 합친 목록을 파일로 보관해 주세요.');
      else if (favorites.mode === 'session') backupMessage(sessionAvailable
        ? '영구 저장하지 못해 합친 목록을 이 탭에서만 유지합니다. 기존 저장값은 보존했습니다. 이동 전에 유효한 목록을 파일로 보관해 주세요.'
        : '영구 저장하지 못해 합친 목록을 현재 화면에서만 유지합니다. 기존 저장값은 보존했습니다. 이동 전에 유효한 목록을 파일로 보관해 주세요.');
      else backupMessage(`현재 목록에 새 ID ${result.addedCount}개를 합쳤습니다. 기존 항목과 다시 확인할 ID는 보존했습니다.`);
    } catch {
      backupMessage('합치기를 완료하지 못했습니다. 파일을 다시 확인해 주세요.');
    }
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
      if (value.conflict) { const withheld = document.createElement('span'); withheld.className = 'unknown'; withheld.textContent = '번호 충돌 · 재확인 필요'; cell.append(withheld);
      } else if (value.observedNumber) { const button = document.createElement('button'); button.type = 'button'; button.className = 'number-button';
        const confirmed = hasConfirmedNumber(song, provider);
        button.dataset.copy = value.observedNumber; button.setAttribute('aria-label', `${song.titleOriginal} ${label.textContent} ${confirmed ? '공식 확인' : '관측'} 번호 ${value.observedNumber} 복사`);
        button.append(document.createTextNode(value.observedNumber), icon('copy')); cell.append(button);
        if (confirmed) { const badge = document.createElement('small'); badge.className = 'verification-badge'; badge.textContent = '공식 확인'; cell.append(badge); }
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
    const numbers = params.getAll('number');
    const hasConfirmedFilter = numbers.some(value => value === 'confirmed-tj' || value === 'confirmed-ky');
    const empty = byId('empty-message');
    if (empty) {
      empty.hidden = filtered.length > 0 && offset < filtered.length;
      if (!empty.hidden) {
        if (filtered.length && offset >= filtered.length) empty.textContent = '이 페이지에 곡이 없습니다. 조건 해제로 첫 목록을 열어보세요.';
        else if (hasConfirmedFilter) empty.textContent = isFavorites
          ? '저장한 곡 중 현재 공식 확인 조건에 맞는 곡이 없습니다. 노래 찾기에서 곡을 저장하거나 조건을 줄여 보세요. 결과가 없어도 공식 미수록을 뜻하지 않습니다.'
          : '현재 조건에 맞는 공식 확인곡이 없습니다. 조건을 줄여 보세요. 결과가 없어도 공식 미수록을 뜻하지 않습니다.';
        else empty.textContent = isFavorites ? '저장한 곡이 없거나 조건에 맞는 곡이 없습니다. 노래 찾기에서 곡을 저장하거나 조건을 해제하세요.' : '일치하는 곡이 없습니다. 제목 일부나 가수로 다시 찾아보세요.';
      }
    }
    const more = byId('more'); if (more) more.hidden = filtered.length <= offset + limit;
    document.querySelectorAll<HTMLElement>('[data-filter]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.filter === 'all' ? !numbers.length : numbers.includes(button.dataset.filter!))));
    const active = byId('active-filters'); if (active) active.hidden = !hasQuery;
    const summary = byId('filter-summary'); if (summary) summary.textContent = [query.value, ...numbers.map(value => numberFilterLabels[value] ?? value), ...params.getAll('tag'), ...(params.get('anime') === 'all' ? ['애니메이션 전체'] : []), ...(params.get('artist') === 'all' ? ['가수 전체'] : [])].join(' · ');
    renderUnresolved(); syncSaveButtons();
  }
  const recent = readRecentFilters(storage);
  if (recent.entries.length) {
    const details = document.createElement('details'); details.className = 'recent-filters'; const label = document.createElement('summary'); label.textContent = '최근 사용한 필터'; details.append(label);
    for (const item of recent.entries) { const button = document.createElement('button'); button.type = 'button'; button.textContent = (item.type === 'number' ? numberFilterLabels[item.value] : undefined) ?? (item.value || (item.type === 'anime-all' ? '애니메이션 전체' : '가수 전체'));
      button.addEventListener('click', () => { const params = new URLSearchParams(location.search); params.delete('page');
        if (item.type === 'number') params.append('number', item.value); else if (item.type === 'tag') params.append('tag', item.value);
        else params.set(item.type === 'anime-all' ? 'anime' : 'artist', 'all'); setUrl(params); }); details.append(button); }
    view.append(details);
  }
  render();
  document.querySelectorAll<HTMLButtonElement>('[data-filter], #more, #copy-favorites').forEach(button => { button.disabled = false; });
  const backupDownload = byId('download-favorites-backup') as HTMLButtonElement | null;
  if (backupDownload) backupDownload.disabled = false;
  if (backupFile) { backupFile.disabled = false; backupMessage('파일로 보관하거나 보관한 파일을 선택해 주세요. 자동 동기화는 하지 않습니다.'); }
  document.documentElement.dataset.appReady = 'true';
}
