/* GoPro gallery frontend. Talks only to its own origin's /api/* endpoints,
   which the Express server proxies to the Python service. */

const listEl = document.getElementById('list');
const player = document.getElementById('player');
const imageView = document.getElementById('image-view');
const emptyEl = document.getElementById('empty');
const metaInfoEl = document.getElementById('meta-info');
const metaCatsEl = document.getElementById('meta-categories');
const activeChipsEl = document.getElementById('active-chips');
const catInput = document.getElementById('cat-input');
const catSuggestionsEl = document.getElementById('cat-suggestions');
const catAddBtn = document.getElementById('cat-add-btn');
const filterChipsEl = document.getElementById('filter-chips');
const statusEl = document.getElementById('status');
const refreshBtn = document.getElementById('refresh');
const storageEl = document.getElementById('storage');
const qualityToggleEl = document.getElementById('quality-toggle');
const bulkBarEl = document.getElementById('bulk-bar');
const bulkCountEl = document.getElementById('bulk-count');
const bulkSelectAllBtn = document.getElementById('bulk-select-all');
const bulkClearBtn = document.getElementById('bulk-clear');
const bulkDeleteBtn = document.getElementById('bulk-delete');
const bulkCatInput = document.getElementById('bulk-cat-input');
const bulkCatAddBtn = document.getElementById('bulk-cat-add-btn');
const typeFilterEl = document.getElementById('type-filter');

let videos = [];              // all media items (images + videos), each with a .type
let categories = [];          // [{id, name, count}]
let storage = null;           // {total, used, free, *_human, percent_used}
let activeId = null;
let selectedType = 'all';     // 'all' | 'image' | 'video' — media-type filter
const selectedFilters = new Set();  // category ids; "__none__" for Uncategorized
const selectedIds = new Set();      // media ids checked for bulk actions

// Mobile-friendly stream toggle. Stored choice wins; otherwise default on for
// phones. The backend will transcode a 720p MP4 on first request.
let mobileMode = (() => {
  const stored = localStorage.getItem('mobileMode');
  if (stored === '1') return true;
  if (stored === '0') return false;
  return /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent);
})();

function streamUrlFor(v) {
  return mobileMode ? `${v.stream_url}?q=mobile` : v.stream_url;
}

function renderQualityToggle() {
  qualityToggleEl.textContent = mobileMode ? 'Quality: Mobile' : 'Quality: HD';
  qualityToggleEl.classList.toggle('active', mobileMode);
}

function fmtDate(unix) {
  if (!unix) return '';
  return new Date(unix * 1000).toLocaleString();
}

function setStatus(text, isError = false) {
  statusEl.textContent = text;
  statusEl.style.color = isError ? '#ffb4b4' : '';
}

// "8 videos · 12 photos" — a quick breakdown of what's loaded.
function mediaCountLabel() {
  const imgs = videos.filter((v) => v.type === 'image').length;
  const vids = videos.length - imgs;
  const parts = [];
  if (vids) parts.push(`${vids} video${vids === 1 ? '' : 's'}`);
  if (imgs) parts.push(`${imgs} photo${imgs === 1 ? '' : 's'}`);
  return parts.join(' · ') || 'no media';
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

// An item matches when its media type is allowed AND its categories satisfy
// the category filter. Category semantics: no filter matches everything;
// otherwise OR across selected categories, with "__none__" matching items that
// have no categories at all.
function itemMatchesFilters(v) {
  if (selectedType !== 'all' && v.type !== selectedType) return false;
  if (selectedFilters.size === 0) return true;
  const wantUncategorized = selectedFilters.has('__none__');
  if (wantUncategorized && v.categories.length === 0) return true;
  return v.categories.some((c) => selectedFilters.has(c.id));
}

function renderFilters() {
  filterChipsEl.innerHTML = '';
  const mkChip = (key, label, count) => {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chip filter-chip' + (selectedFilters.has(key) ? ' active' : '');
    chip.innerHTML = `${escapeHtml(label)} <span class="chip-count">${count}</span>`;
    chip.addEventListener('click', () => {
      if (selectedFilters.has(key)) selectedFilters.delete(key);
      else selectedFilters.add(key);
      renderFilters();
      renderList();
    });
    return chip;
  };
  const uncategorizedCount = videos.filter((v) => v.categories.length === 0).length;
  filterChipsEl.appendChild(mkChip('__none__', 'Uncategorized', uncategorizedCount));
  for (const c of categories) {
    filterChipsEl.appendChild(mkChip(c.id, c.name, c.count));
  }
}

function renderList() {
  listEl.innerHTML = '';
  const visible = videos.filter(itemMatchesFilters);
  // Drop any selections that are no longer visible/present.
  for (const id of [...selectedIds]) {
    if (!visible.find((v) => v.id === id)) selectedIds.delete(id);
  }
  if (visible.length === 0) {
    const msg = videos.length === 0
      ? 'No media found in the served directory.'
      : 'No media match the selected filters.';
    listEl.innerHTML = `<div class="error">${msg}</div>`;
    renderBulkBar();
    return;
  }
  for (const v of visible) {
    const card = document.createElement('div');
    const isSelected = selectedIds.has(v.id);
    card.className = 'card'
      + (v.id === activeId ? ' active' : '')
      + (isSelected ? ' selected' : '');
    card.dataset.id = v.id;
    const cardCats = v.categories.map(
      (c) => `<span class="chip chip-sm">${escapeHtml(c.name)}</span>`,
    ).join('');
    const badge = v.type === 'video'
      ? '<span class="type-badge play">▶</span>'
      : '<span class="type-badge photo">PHOTO</span>';
    card.innerHTML = `
      <label class="card-select" aria-label="Select for bulk actions">
        <input type="checkbox" ${isSelected ? 'checked' : ''} />
      </label>
      <div class="thumb-wrap">
        <img class="thumb" loading="lazy" alt="" src="${v.thumbnail_url}"
             onerror="this.style.background='#222';this.removeAttribute('src');" />
        ${badge}
      </div>
      <div class="card-meta">
        <div class="card-name" title="${escapeHtml(v.relpath)}">${escapeHtml(v.name)}</div>
        <div class="card-sub">${v.size_human} · ${fmtDate(v.mtime)}</div>
        ${cardCats ? `<div class="card-chips chip-row">${cardCats}</div>` : ''}
      </div>
    `;
    const checkbox = card.querySelector('.card-select input');
    const checkboxLabel = card.querySelector('.card-select');
    checkboxLabel.addEventListener('click', (e) => e.stopPropagation());
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) selectedIds.add(v.id);
      else selectedIds.delete(v.id);
      card.classList.toggle('selected', checkbox.checked);
      renderBulkBar();
    });
    card.addEventListener('click', () => select(v.id));
    listEl.appendChild(card);
  }
  renderBulkBar();
}

function renderBulkBar() {
  const n = selectedIds.size;
  if (n === 0) {
    bulkBarEl.classList.add('hidden');
    bulkCatInput.value = '';
    return;
  }
  bulkBarEl.classList.remove('hidden');
  bulkCountEl.textContent = `${n} selected`;
}

function renderSuggestions() {
  catSuggestionsEl.innerHTML = '';
  for (const c of categories) {
    const opt = document.createElement('option');
    opt.value = c.name;
    catSuggestionsEl.appendChild(opt);
  }
}

function renderDetail() {
  if (!activeId) {
    metaInfoEl.innerHTML = '';
    metaCatsEl.classList.add('hidden');
    return;
  }
  const v = videos.find((x) => x.id === activeId);
  if (!v) return;
  const fileUrl = v.type === 'image' ? v.image_url : v.stream_url;
  metaInfoEl.innerHTML = `
    <strong>${escapeHtml(v.name)}</strong>
    <span>${v.size_human}</span>
    <span>${fmtDate(v.mtime)}</span>
    <span class="muted">${escapeHtml(v.relpath)}</span>
    <a href="${fileUrl}" download="${escapeHtml(v.name)}">download</a>
  `;
  const deleteBtn = document.createElement('button');
  deleteBtn.type = 'button';
  deleteBtn.className = 'btn-danger';
  deleteBtn.textContent = 'Delete';
  deleteBtn.addEventListener('click', () => deleteActiveVideo());
  metaInfoEl.appendChild(deleteBtn);
  metaCatsEl.classList.remove('hidden');
  activeChipsEl.innerHTML = '';
  if (v.categories.length === 0) {
    const hint = document.createElement('span');
    hint.className = 'muted';
    hint.textContent = 'No categories yet.';
    activeChipsEl.appendChild(hint);
  } else {
    for (const c of v.categories) {
      const chip = document.createElement('span');
      chip.className = 'chip chip-removable';
      chip.innerHTML = `${escapeHtml(c.name)} <button type="button" class="chip-x" aria-label="Remove">×</button>`;
      chip.querySelector('.chip-x').addEventListener('click', () => detachCategory(v.id, c.id));
      activeChipsEl.appendChild(chip);
    }
  }
}

// Fully stop and detach the video element so a backgrounded clip doesn't keep
// downloading or playing audio after we switch to an image.
function stopVideo() {
  player.pause();
  player.removeAttribute('src');
  player.load();
  player.classList.remove('active');
}

function showVideo(v) {
  imageView.classList.remove('active');
  imageView.removeAttribute('src');
  player.src = streamUrlFor(v);
  player.classList.add('active');
  if (mobileMode) setStatus('preparing mobile version…');
  player.play().catch(() => { /* autoplay may be blocked; user can press play */ });
}

function showImage(v) {
  stopVideo();
  imageView.src = v.image_url;
  imageView.classList.add('active');
}

function select(id) {
  const v = videos.find((x) => x.id === id);
  if (!v) return;
  activeId = id;
  for (const c of listEl.querySelectorAll('.card')) {
    c.classList.toggle('active', c.dataset.id === id);
  }
  emptyEl.classList.add('hidden');
  if (v.type === 'image') showImage(v);
  else showVideo(v);
  // The Quality (HD/mobile transcode) toggle only applies to videos.
  qualityToggleEl.classList.toggle('hidden', v.type === 'image');
  renderDetail();
}

function setMobileMode(on) {
  if (mobileMode === on) return;
  mobileMode = on;
  localStorage.setItem('mobileMode', on ? '1' : '0');
  renderQualityToggle();
  if (!activeId) return;
  const v = videos.find((x) => x.id === activeId);
  if (!v || v.type !== 'video') return;  // toggle is a no-op while viewing an image
  // Preserve the playhead and play state when switching mid-playback.
  const wasPaused = player.paused;
  const currentTime = player.currentTime;
  player.src = streamUrlFor(v);
  if (on) setStatus('preparing mobile version…');
  const onLoaded = () => {
    player.removeEventListener('loadedmetadata', onLoaded);
    try { player.currentTime = currentTime; } catch { /* ignore */ }
    if (!wasPaused) player.play().catch(() => {});
  };
  player.addEventListener('loadedmetadata', onLoaded);
}

player.addEventListener('loadeddata', () => {
  if (statusEl.textContent === 'preparing mobile version…') {
    setStatus(mediaCountLabel());
  }
});
player.addEventListener('error', () => {
  if (mobileMode && player.error) {
    setStatus('mobile transcode failed — try Quality: HD', true);
  }
});

async function fetchJson(url, opts = {}) {
  const res = await fetch(url, { cache: 'no-store', ...opts });
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const j = await res.json();
      if (j && j.error) detail = j.error;
    } catch { /* ignore */ }
    throw new Error(detail);
  }
  return res.json();
}

async function loadCategories() {
  categories = await fetchJson('/api/categories');
}

async function loadVideos() {
  videos = await fetchJson('/api/media');
}

async function loadStorage() {
  try {
    storage = await fetchJson('/api/storage');
  } catch {
    storage = null;
  }
}

function renderStorage() {
  if (!storage) {
    storageEl.textContent = '';
    storageEl.classList.remove('low');
    return;
  }
  storageEl.textContent = `Disk: ${storage.free_human} free of ${storage.total_human} (${storage.percent_used}% used)`;
  storageEl.title = `Volume containing ${storage.root}`;
  storageEl.classList.toggle('low', storage.percent_used >= 90);
}

async function refreshAll() {
  setStatus('loading…');
  try {
    await Promise.all([loadVideos(), loadCategories(), loadStorage()]);
    setStatus(mediaCountLabel());
    renderStorage();
    renderFilters();
    renderSuggestions();
    renderList();
    if (activeId && !videos.find((v) => v.id === activeId)) {
      clearPlayer();
    }
    renderDetail();
  } catch (err) {
    setStatus(`error: ${err.message}`, true);
    listEl.innerHTML = `<div class="error">Failed to load: ${escapeHtml(err.message)}.<br/>Is gopro.py serve running?</div>`;
  }
}

async function attachCategory(name) {
  if (!activeId || !name.trim()) return;
  try {
    await fetchJson(`/api/videos/${activeId}/categories`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name.trim() }),
    });
    catInput.value = '';
    await refreshAll();
  } catch (err) {
    setStatus(`error: ${err.message}`, true);
  }
}

async function detachCategory(videoId, catId) {
  try {
    await fetchJson(`/api/videos/${videoId}/categories/${catId}`, { method: 'DELETE' });
    await refreshAll();
  } catch (err) {
    setStatus(`error: ${err.message}`, true);
  }
}

catAddBtn.addEventListener('click', () => attachCategory(catInput.value));
catInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    attachCategory(catInput.value);
  }
});

async function bulkAttachCategory(name) {
  const trimmed = name.trim();
  if (!trimmed || selectedIds.size === 0) return;
  const ids = [...selectedIds];
  setStatus(`assigning "${trimmed}" to ${ids.length}…`);
  try {
    const results = await Promise.allSettled(ids.map((id) => fetchJson(
      `/api/videos/${id}/categories`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: trimmed }),
      },
    )));
    const failed = results.filter((r) => r.status === 'rejected');
    bulkCatInput.value = '';
    await refreshAll();
    if (failed.length) {
      setStatus(`assigned to ${ids.length - failed.length}/${ids.length} — ${failed.length} failed`, true);
    }
  } catch (err) {
    setStatus(`error: ${err.message}`, true);
  }
}

function clearPlayer() {
  activeId = null;
  stopVideo();
  imageView.classList.remove('active');
  imageView.removeAttribute('src');
  qualityToggleEl.classList.remove('hidden');
  emptyEl.classList.remove('hidden');
}

async function deleteVideo(id) {
  return fetchJson(`/api/videos/${id}`, { method: 'DELETE' });
}

async function deleteActiveVideo() {
  if (!activeId) return;
  const v = videos.find((x) => x.id === activeId);
  if (!v) return;
  if (!confirm(`Delete "${v.name}"?\n\nThis removes the file, its cached thumbnail, and all category tags.`)) return;
  try {
    setStatus(`deleting ${v.name}…`);
    clearPlayer();
    await deleteVideo(v.id);
    await refreshAll();
  } catch (err) {
    setStatus(`error: ${err.message}`, true);
  }
}

async function bulkDelete() {
  if (selectedIds.size === 0) return;
  const ids = [...selectedIds];
  if (!confirm(`Delete ${ids.length} video${ids.length === 1 ? '' : 's'}?\n\nThis removes the files, cached thumbnails, and all category tags.`)) return;
  setStatus(`deleting ${ids.length}…`);
  if (ids.includes(activeId)) clearPlayer();
  try {
    const results = await Promise.allSettled(ids.map((id) => deleteVideo(id)));
    const failed = results.filter((r) => r.status === 'rejected');
    selectedIds.clear();
    await refreshAll();
    if (failed.length) {
      setStatus(`deleted ${ids.length - failed.length}/${ids.length} — ${failed.length} failed`, true);
    }
  } catch (err) {
    setStatus(`error: ${err.message}`, true);
  }
}

bulkCatAddBtn.addEventListener('click', () => bulkAttachCategory(bulkCatInput.value));
bulkCatInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    bulkAttachCategory(bulkCatInput.value);
  }
});
bulkSelectAllBtn.addEventListener('click', () => {
  for (const v of videos.filter(itemMatchesFilters)) selectedIds.add(v.id);
  renderList();
});
bulkClearBtn.addEventListener('click', () => {
  selectedIds.clear();
  renderList();
});
bulkDeleteBtn.addEventListener('click', () => bulkDelete());

typeFilterEl.addEventListener('click', (e) => {
  const btn = e.target.closest('.type-btn');
  if (!btn) return;
  selectedType = btn.dataset.type;
  for (const b of typeFilterEl.querySelectorAll('.type-btn')) {
    b.classList.toggle('active', b === btn);
  }
  renderList();
});

refreshBtn.addEventListener('click', refreshAll);
qualityToggleEl.addEventListener('click', () => setMobileMode(!mobileMode));
renderQualityToggle();
refreshAll();
