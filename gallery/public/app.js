/* GoPro gallery frontend. Talks only to its own origin's /api/* endpoints,
   which the Express server proxies to the Python service. */

const listEl = document.getElementById('list');
const player = document.getElementById('player');
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

let videos = [];
let categories = [];          // [{id, name, count}]
let activeId = null;
const selectedFilters = new Set();  // category ids; "__none__" for Uncategorized

function fmtDate(unix) {
  if (!unix) return '';
  return new Date(unix * 1000).toLocaleString();
}

function setStatus(text, isError = false) {
  statusEl.textContent = text;
  statusEl.style.color = isError ? '#ffb4b4' : '';
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

// A video matches the filter when no filter is active, or when it has at
// least one of the selected categories (OR semantics). The "__none__"
// pseudo-filter matches videos with no categories at all.
function videoMatchesFilters(v) {
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
  const visible = videos.filter(videoMatchesFilters);
  if (visible.length === 0) {
    const msg = videos.length === 0
      ? 'No videos found in the served directory.'
      : 'No videos match the selected filters.';
    listEl.innerHTML = `<div class="error">${msg}</div>`;
    return;
  }
  for (const v of visible) {
    const card = document.createElement('div');
    card.className = 'card' + (v.id === activeId ? ' active' : '');
    card.dataset.id = v.id;
    const cardCats = v.categories.map(
      (c) => `<span class="chip chip-sm">${escapeHtml(c.name)}</span>`,
    ).join('');
    card.innerHTML = `
      <img class="thumb" loading="lazy" alt="" src="${v.thumbnail_url}"
           onerror="this.style.background='#222';this.removeAttribute('src');" />
      <div class="card-meta">
        <div class="card-name" title="${escapeHtml(v.relpath)}">${escapeHtml(v.name)}</div>
        <div class="card-sub">${v.size_human} · ${fmtDate(v.mtime)}</div>
        ${cardCats ? `<div class="card-chips chip-row">${cardCats}</div>` : ''}
      </div>
    `;
    card.addEventListener('click', () => select(v.id));
    listEl.appendChild(card);
  }
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
  metaInfoEl.innerHTML = `
    <strong>${escapeHtml(v.name)}</strong>
    <span>${v.size_human}</span>
    <span>${fmtDate(v.mtime)}</span>
    <span class="muted">${escapeHtml(v.relpath)}</span>
    <a href="${v.stream_url}" download="${escapeHtml(v.name)}">download</a>
  `;
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

function select(id) {
  const v = videos.find((x) => x.id === id);
  if (!v) return;
  activeId = id;
  for (const c of listEl.querySelectorAll('.card')) {
    c.classList.toggle('active', c.dataset.id === id);
  }
  player.src = v.stream_url;
  player.classList.add('active');
  emptyEl.classList.add('hidden');
  player.play().catch(() => { /* autoplay may be blocked; user can press play */ });
  renderDetail();
}

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
  videos = await fetchJson('/api/videos');
}

async function refreshAll() {
  setStatus('loading…');
  try {
    await Promise.all([loadVideos(), loadCategories()]);
    setStatus(`${videos.length} video${videos.length === 1 ? '' : 's'}`);
    renderFilters();
    renderSuggestions();
    renderList();
    if (activeId && !videos.find((v) => v.id === activeId)) {
      activeId = null;
      player.removeAttribute('src');
      player.load();
      player.classList.remove('active');
      emptyEl.classList.remove('hidden');
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
refreshBtn.addEventListener('click', refreshAll);
refreshAll();
