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
const viewToggleEl = document.getElementById('view-toggle');
const playerWrap = document.getElementById('player-wrap');
const lbCloseEl = document.getElementById('lb-close');
const lbPrevEl = document.getElementById('lb-prev');
const lbNextEl = document.getElementById('lb-next');
const frameModalEl = document.getElementById('frame-modal');
const frameDialogEl = frameModalEl.querySelector('.frame-dialog');
const frameTitleEl = document.getElementById('frame-title');
const frameStatusEl = document.getElementById('frame-status');
const frameCloseEl = document.getElementById('frame-close');
const frameVideoEl = document.getElementById('frame-video');
const frameSeekEl = document.getElementById('frame-seek');
const frameTimeEl = document.getElementById('frame-time');
const framePlayEl = document.getElementById('frame-play');
const frameSaveEl = document.getElementById('frame-save');
const frameStripEl = document.getElementById('frame-strip');
const frameCropEl = document.getElementById('frame-crop');
const cropRectEl = document.getElementById('frame-crop-rect');
const cropInfoEl = document.getElementById('frame-crop-info');
const cropClearEl = document.getElementById('frame-crop-clear');

let videos = [];              // all media items (images + videos), each with a .type
let categories = [];          // [{id, name, count}]
let storage = null;           // {total, used, free, *_human, percent_used}
let activeId = null;
let selectedType = 'all';     // 'all' | 'image' | 'video' — media-type filter
// 'list' = master-detail; 'grid' = thumbnail grid + fullscreen lightbox.
let viewMode = localStorage.getItem('viewMode') === 'grid' ? 'grid' : 'list';
const selectedFilters = new Set();  // category ids; "__none__" for Uncategorized
const selectedIds = new Set();      // media ids checked for bulk actions
let anchorId = null;                 // pivot for shift-click range selection

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

// The items currently shown, in render order — the set the lightbox steps through.
function visibleItems() {
  return videos.filter(itemMatchesFilters);
}

function renderList() {
  listEl.innerHTML = '';
  const visible = visibleItems();
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
      <span class="card-select" role="checkbox" aria-label="Select for bulk actions"
            aria-checked="${isSelected}">
        <input type="checkbox" tabindex="-1" ${isSelected ? 'checked' : ''} />
      </span>
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
    // The checkbox is an explicit per-item toggle; shift extends a range from
    // it too, mirroring the modifier-clicks on the card body. Using a <span>
    // (not <label>) avoids the label re-dispatching a click to the card.
    const selectEl = card.querySelector('.card-select');
    selectEl.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      if (e.shiftKey) selectRange(v.id);
      else { toggleSelected(v.id); anchorId = v.id; }
      syncSelectionUI();
    });
    card.addEventListener('click', (e) => handleCardClick(v, e));
    listEl.appendChild(card);
  }
  renderBulkBar();
}

// ---- selection: plain = preview, ctrl/cmd = toggle one, shift = range ------

function toggleSelected(id) {
  if (selectedIds.has(id)) selectedIds.delete(id);
  else selectedIds.add(id);
}

// Add every visible item between the anchor and `id` (inclusive) to the group.
function selectRange(id) {
  const items = visibleItems();
  const to = items.findIndex((v) => v.id === id);
  if (to === -1) return;
  let from = anchorId ? items.findIndex((v) => v.id === anchorId) : -1;
  if (from === -1) from = to;            // no anchor yet → just this one
  const [lo, hi] = from <= to ? [from, to] : [to, from];
  for (let i = lo; i <= hi; i++) selectedIds.add(items[i].id);
  // Keep the original anchor so repeated shift-clicks re-range from it.
}

function handleCardClick(v, e) {
  if (e.shiftKey) {
    e.preventDefault();
    selectRange(v.id);
    syncSelectionUI();
  } else if (e.metaKey || e.ctrlKey) {
    e.preventDefault();
    toggleSelected(v.id);
    anchorId = v.id;
    syncSelectionUI();
  } else {
    // Plain click previews/opens the item and arms it as the range anchor;
    // the bulk group is left untouched.
    anchorId = v.id;
    select(v.id);
  }
}

// Reflect selectedIds onto the existing cards without a full re-render.
function syncSelectionUI() {
  for (const card of listEl.querySelectorAll('.card')) {
    const sel = selectedIds.has(card.dataset.id);
    card.classList.toggle('selected', sel);
    const cb = card.querySelector('.card-select input');
    if (cb) cb.checked = sel;
    const box = card.querySelector('.card-select');
    if (box) box.setAttribute('aria-checked', String(sel));
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
  if (v.type === 'video') {
    const frameBtn = document.createElement('button');
    frameBtn.type = 'button';
    frameBtn.className = 'btn-frame';
    frameBtn.textContent = '⛶ Grab frame';
    frameBtn.title = 'Pick a frame from this video and save it as a photo';
    frameBtn.addEventListener('click', () => openFramePicker(v));
    metaInfoEl.appendChild(frameBtn);
  }
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
  // In grid view, selecting an item raises the detail pane as a lightbox.
  document.body.classList.toggle('lightbox-open', viewMode === 'grid');
  renderDetail();
}

// Step to the previous/next item in the visible set (lightbox arrows + keys).
function stepLightbox(delta) {
  const items = visibleItems();
  if (items.length === 0) return;
  let idx = items.findIndex((v) => v.id === activeId);
  idx = idx === -1 ? 0 : (idx + delta + items.length) % items.length;
  const next = items[idx];
  select(next.id);
  next && document.querySelector(`.card[data-id="${next.id}"]`)
    ?.scrollIntoView({ block: 'nearest' });
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
  document.body.classList.remove('lightbox-open');
  for (const c of listEl.querySelectorAll('.card.active')) c.classList.remove('active');
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
  for (const v of visibleItems()) selectedIds.add(v.id);
  renderList();
});
bulkClearBtn.addEventListener('click', () => {
  selectedIds.clear();
  anchorId = null;
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

// ---- view mode (list vs thumbnail grid) -----------------------------------

function applyViewMode() {
  document.body.classList.toggle('view-grid', viewMode === 'grid');
  viewToggleEl.textContent = viewMode === 'grid' ? '☰ List' : '⊞ Grid';
  viewToggleEl.title = viewMode === 'grid'
    ? 'Switch to list view' : 'Switch to thumbnail-grid view';
}

viewToggleEl.addEventListener('click', () => {
  viewMode = viewMode === 'grid' ? 'list' : 'grid';
  localStorage.setItem('viewMode', viewMode);
  clearPlayer();        // drop any selection so we don't leave a video playing behind the grid
  applyViewMode();
});

// Lightbox controls (only reachable while a grid item is open).
lbCloseEl.addEventListener('click', clearPlayer);
lbPrevEl.addEventListener('click', () => stepLightbox(-1));
lbNextEl.addEventListener('click', () => stepLightbox(1));
// Click on the dark letterbox area (not the media/controls) closes the lightbox.
playerWrap.addEventListener('click', (e) => {
  if (e.target === playerWrap && document.body.classList.contains('lightbox-open')) {
    clearPlayer();
  }
});
document.addEventListener('keydown', (e) => {
  if (!document.body.classList.contains('lightbox-open')) return;
  if (!frameModalEl.classList.contains('hidden')) return;  // picker owns the keys
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;  // don't hijack typing
  if (e.key === 'Escape') clearPlayer();
  else if (e.key === 'ArrowLeft') { e.preventDefault(); stepLightbox(-1); }
  else if (e.key === 'ArrowRight') { e.preventDefault(); stepLightbox(1); }
});

// ---- frame picker ----------------------------------------------------------
// Open any video, scrub/step to a moment, and save that exact frame as a new
// photo. The picker always loads the original (HD) stream so saved frames are
// full resolution regardless of the Quality toggle; the actual extraction is
// done server-side from the source file at the chosen timestamp.

const FRAME_STEP = 1 / 30;   // ~one frame at 30fps; fine enough for selection
let framePickerItem = null;  // the video currently open in the picker
let frameScrubbing = false;  // user is dragging the seek slider
let cropFrac = null;         // {x,y,w,h} fractions of the frame, or null = full
let cropDrag = null;         // in-progress crop gesture state

function fmtClock(sec) {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const ms = Math.floor((sec - Math.floor(sec)) * 1000);
  const total = Math.floor(sec);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n) => String(n).padStart(2, '0');
  const base = h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
  return `${base}.${String(ms).padStart(3, '0')}`;
}

function setFrameStatus(text, isError = false) {
  frameStatusEl.textContent = text;
  frameStatusEl.classList.toggle('error', isError);
}

function updateFrameTime() {
  if (!frameScrubbing) frameSeekEl.value = String(frameVideoEl.currentTime || 0);
  frameTimeEl.textContent =
    `${fmtClock(frameVideoEl.currentTime)} / ${fmtClock(frameVideoEl.duration)}`;
}

function seekFrameTo(t) {
  const dur = frameVideoEl.duration || 0;
  const clamped = Math.max(0, Math.min(t, dur > 0 ? dur - 0.001 : t));
  frameVideoEl.pause();
  frameVideoEl.currentTime = clamped;
  frameSeekEl.value = String(clamped);
  updateFrameTime();
}

function stepFrame(delta) {
  seekFrameTo((frameVideoEl.currentTime || 0) + delta);
}

// Sample evenly across the clip and ask the server for small JPEG previews,
// loaded in parallel as plain <img> tags. Clicking one jumps the player there.
function buildFilmstrip() {
  const dur = frameVideoEl.duration;
  frameStripEl.innerHTML = '';
  if (!isFinite(dur) || dur <= 0) {
    frameStripEl.innerHTML = '<span class="strip-empty">No preview frames available.</span>';
    return;
  }
  const n = Math.min(16, Math.max(4, Math.ceil(dur)));
  for (let i = 0; i < n; i++) {
    const t = (dur * (i + 0.5)) / n;
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'strip-item';
    item.dataset.t = String(t);
    item.title = fmtClock(t);
    const img = document.createElement('img');
    img.loading = 'lazy';
    img.alt = fmtClock(t);
    img.src = `/api/frames/${framePickerItem.id}?t=${t.toFixed(3)}&w=200`;
    img.addEventListener('error', () => { item.style.display = 'none'; });
    item.appendChild(img);
    item.addEventListener('click', () => seekFrameTo(t));
    frameStripEl.appendChild(item);
  }
}

function highlightStrip() {
  const cur = frameVideoEl.currentTime || 0;
  let best = null;
  let bestDist = Infinity;
  for (const item of frameStripEl.querySelectorAll('.strip-item')) {
    const d = Math.abs(parseFloat(item.dataset.t) - cur);
    if (d < bestDist) { bestDist = d; best = item; }
    item.classList.remove('active');
  }
  if (best) best.classList.add('active');
}

// ---- crop overlay ----------------------------------------------------------
// Keep the overlay glued to the rendered <video> box so a selection in display
// space maps one-to-one onto source-frame fractions. Sizes change on metadata
// load and window resize.
function positionCropOverlay() {
  if (!frameVideoEl.videoWidth) { frameCropEl.style.display = 'none'; return; }
  frameCropEl.style.display = 'block';
  frameCropEl.style.left = `${frameVideoEl.offsetLeft}px`;
  frameCropEl.style.top = `${frameVideoEl.offsetTop}px`;
  frameCropEl.style.width = `${frameVideoEl.offsetWidth}px`;
  frameCropEl.style.height = `${frameVideoEl.offsetHeight}px`;
  renderCrop();
}

function renderCrop() {
  if (!cropFrac) {
    cropRectEl.hidden = true;
    cropClearEl.hidden = true;
    cropInfoEl.textContent = 'Drag on the frame to crop';
    return;
  }
  cropRectEl.hidden = false;
  cropClearEl.hidden = false;
  cropRectEl.style.left = `${cropFrac.x * 100}%`;
  cropRectEl.style.top = `${cropFrac.y * 100}%`;
  cropRectEl.style.width = `${cropFrac.w * 100}%`;
  cropRectEl.style.height = `${cropFrac.h * 100}%`;
  const pw = Math.round((frameVideoEl.videoWidth || 0) * cropFrac.w);
  const ph = Math.round((frameVideoEl.videoHeight || 0) * cropFrac.h);
  cropInfoEl.textContent = `Crop ${pw}×${ph}px`;
}

function clearCrop() {
  cropFrac = null;
  renderCrop();
}

// Pointer position as a clamped 0..1 fraction of the overlay (= of the frame).
function cropEventFrac(e) {
  const r = frameCropEl.getBoundingClientRect();
  return {
    x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)),
    y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)),
  };
}

// Move one corner to point f while the opposite corner stays put.
function resizeCropRect(c, corner, f) {
  let x1 = c.x, y1 = c.y, x2 = c.x + c.w, y2 = c.y + c.h;
  if (corner.includes('w')) x1 = f.x; else x2 = f.x;
  if (corner.includes('n')) y1 = f.y; else y2 = f.y;
  return { x: Math.min(x1, x2), y: Math.min(y1, y2),
           w: Math.abs(x2 - x1), h: Math.abs(y2 - y1) };
}

frameCropEl.addEventListener('pointerdown', (e) => {
  const handle = e.target.closest('.crop-handle');
  const f = cropEventFrac(e);
  if (handle) {
    cropDrag = { mode: 'resize', corner: handle.dataset.h };
  } else if (cropFrac && e.target === cropRectEl) {
    cropDrag = { mode: 'move', startX: f.x, startY: f.y, orig: { ...cropFrac } };
  } else {
    cropDrag = { mode: 'draw', anchorX: f.x, anchorY: f.y };
    cropFrac = { x: f.x, y: f.y, w: 0, h: 0 };
  }
  frameCropEl.setPointerCapture(e.pointerId);
  e.preventDefault();
});

frameCropEl.addEventListener('pointermove', (e) => {
  if (!cropDrag) return;
  const f = cropEventFrac(e);
  if (cropDrag.mode === 'draw') {
    cropFrac = {
      x: Math.min(cropDrag.anchorX, f.x),
      y: Math.min(cropDrag.anchorY, f.y),
      w: Math.abs(f.x - cropDrag.anchorX),
      h: Math.abs(f.y - cropDrag.anchorY),
    };
  } else if (cropDrag.mode === 'move') {
    const o = cropDrag.orig;
    cropFrac = {
      x: Math.min(Math.max(0, o.x + (f.x - cropDrag.startX)), 1 - o.w),
      y: Math.min(Math.max(0, o.y + (f.y - cropDrag.startY)), 1 - o.h),
      w: o.w, h: o.h,
    };
  } else {
    cropFrac = resizeCropRect(cropFrac, cropDrag.corner, f);
  }
  renderCrop();
});

function endCropDrag() {
  if (!cropDrag) return;
  cropDrag = null;
  // A click or a sliver isn't a crop — drop it so the full frame is saved.
  if (cropFrac && (cropFrac.w < 0.02 || cropFrac.h < 0.02)) cropFrac = null;
  renderCrop();
}
frameCropEl.addEventListener('pointerup', endCropDrag);
frameCropEl.addEventListener('pointercancel', endCropDrag);
cropClearEl.addEventListener('click', clearCrop);
window.addEventListener('resize', () => {
  if (!frameModalEl.classList.contains('hidden')) positionCropOverlay();
});

function openFramePicker(v) {
  framePickerItem = v;
  frameTitleEl.textContent = v.name;
  setFrameStatus('');
  frameSaveEl.disabled = false;
  cropDrag = null;
  clearCrop();
  frameCropEl.style.display = 'none';  // until we know the video's size
  stopVideo();  // don't leave the main player running behind the modal
  frameStripEl.innerHTML = '<span class="strip-empty">Loading frames…</span>';
  framePlayEl.textContent = '▶';
  frameModalEl.classList.remove('hidden');
  frameModalEl.setAttribute('aria-hidden', 'false');
  frameVideoEl.src = v.stream_url;  // original quality, never the mobile transcode
  frameVideoEl.currentTime = 0;
  frameVideoEl.load();
}

function closeFramePicker() {
  frameVideoEl.pause();
  frameVideoEl.removeAttribute('src');
  frameVideoEl.load();
  frameStripEl.innerHTML = '';
  frameModalEl.classList.add('hidden');
  frameModalEl.setAttribute('aria-hidden', 'true');
  framePickerItem = null;
  cropDrag = null;
  cropFrac = null;
  frameCropEl.style.display = 'none';
}

async function saveCurrentFrame() {
  if (!framePickerItem) return;
  frameVideoEl.pause();
  const t = frameVideoEl.currentTime || 0;
  frameSaveEl.disabled = true;
  setFrameStatus('saving…');
  const payload = { t };
  if (cropFrac && cropFrac.w > 0 && cropFrac.h > 0) {
    payload.crop = { x: cropFrac.x, y: cropFrac.y, w: cropFrac.w, h: cropFrac.h };
  }
  try {
    const res = await fetchJson(`/api/frames/${framePickerItem.id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const what = payload.crop ? 'cropped frame' : 'frame';
    setFrameStatus(`saved ${res.item ? res.item.name : what} ✓ (${fmtClock(t)})`);
    await refreshAll();  // surface the new photo in the gallery
  } catch (err) {
    setFrameStatus(`error: ${err.message}`, true);
  } finally {
    frameSaveEl.disabled = false;
  }
}

frameVideoEl.addEventListener('loadedmetadata', () => {
  frameSeekEl.max = String(frameVideoEl.duration || 0);
  updateFrameTime();
  buildFilmstrip();
  positionCropOverlay();
});
// The rendered box can change once the first frame paints / fonts settle.
frameVideoEl.addEventListener('loadeddata', positionCropOverlay);
frameVideoEl.addEventListener('timeupdate', updateFrameTime);
frameVideoEl.addEventListener('seeked', () => { updateFrameTime(); highlightStrip(); });
frameVideoEl.addEventListener('play', () => { framePlayEl.textContent = '⏸'; });
frameVideoEl.addEventListener('pause', () => { framePlayEl.textContent = '▶'; });
frameVideoEl.addEventListener('error', () => {
  setFrameStatus('could not load this video', true);
});

frameSeekEl.addEventListener('input', () => {
  frameScrubbing = true;
  frameVideoEl.currentTime = parseFloat(frameSeekEl.value) || 0;
  updateFrameTime();
});
frameSeekEl.addEventListener('change', () => { frameScrubbing = false; });

framePlayEl.addEventListener('click', () => {
  if (frameVideoEl.paused) frameVideoEl.play().catch(() => {});
  else frameVideoEl.pause();
});
frameDialogEl.querySelector('.frame-steps').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-step]');
  if (!btn) return;
  const raw = btn.dataset.step;
  const delta = raw === 'frame' ? FRAME_STEP : raw === '-frame' ? -FRAME_STEP : parseFloat(raw);
  stepFrame(delta);
});
frameSaveEl.addEventListener('click', saveCurrentFrame);
frameCloseEl.addEventListener('click', closeFramePicker);
frameModalEl.addEventListener('click', (e) => {
  if (e.target === frameModalEl) closeFramePicker();  // click the backdrop
});
document.addEventListener('keydown', (e) => {
  if (frameModalEl.classList.contains('hidden')) return;
  if (e.key === 'Escape') { closeFramePicker(); return; }
  if (e.target === frameSeekEl) return;  // let the slider handle its own keys
  if (e.key === ' ') {
    e.preventDefault();
    if (frameVideoEl.paused) frameVideoEl.play().catch(() => {});
    else frameVideoEl.pause();
  } else if (e.key === 'ArrowLeft') {
    e.preventDefault();
    stepFrame(-FRAME_STEP);
  } else if (e.key === 'ArrowRight') {
    e.preventDefault();
    stepFrame(FRAME_STEP);
  }
});

refreshBtn.addEventListener('click', refreshAll);
qualityToggleEl.addEventListener('click', () => setMobileMode(!mobileMode));
renderQualityToggle();
applyViewMode();
refreshAll();
