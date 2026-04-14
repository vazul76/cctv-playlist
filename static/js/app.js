const API = '/api';
let currentPlaylistId   = null;
let currentPlaylistName = null;
let currentPlaylistDescription = '';
let lastDetailPlaylistId = localStorage.getItem('lastDetailPlaylistId') || null;
let lastDetailPlaylistName = localStorage.getItem('lastDetailPlaylistName') || null;
let _pendingImportTracks = null; // tracks parsed from XSPF, siap diimport saat Simpan
let _skipHashPush = false;

// Track change detection
let _originalTracks = [];          // Original track state from API
let _tracksWithChanges = new Set(); // Set of track indices with unsaved changes
let _originalPlaylistMeta = { name: '', description: '' };
let _playlistMetaDirty = false;
let _hlsPlayer = null;
let _currentPreviewSessionId = null;
let _previewEventTimer = null;
let _previewClientId = sessionStorage.getItem('previewClientId') || '';
let _previewTakeoverNotified = false;

if (!_previewClientId) {
  _previewClientId = (window.crypto && crypto.randomUUID)
    ? crypto.randomUUID()
    : `client-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  sessionStorage.setItem('previewClientId', _previewClientId);
}

// ─── NAVIGASI ─────────────────────────────────────────────────
function navigate(page, data = {}) {
  // Check for unsaved track changes when leaving playlist-detail
  const detailPageActive = document.getElementById('page-playlist-detail')?.classList.contains('active');
  const leavingDetailPage = detailPageActive && page !== 'playlist-detail';
  if (leavingDetailPage && currentPlaylistId && (_tracksWithChanges.size > 0 || _playlistMetaDirty)) {
    showUnsavedChangesModal(page, data);
    return; // Don't navigate yet
  }

  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('#sidebar nav a').forEach(a => a.classList.remove('active'));

  const pageEl = document.getElementById(`page-${page}`);
  if (pageEl) pageEl.classList.add('active');

  const navEl = document.querySelector(`[data-page="${page}"]`);
  if (navEl) navEl.classList.add('active');

  if (page === 'dashboard')       loadDashboard();
  if (page === 'playlists')       loadPlaylists();

  if (page === 'playlist-detail') {
    const el = document.getElementById('track-search');
    if (el) el.value = '';
    loadPlaylistDetail(data.id, data.name, data.description || '');
  }

  // Update URL path (tanpa #)
  if (!_skipHashPush) {
    const newPath = page === 'playlist-detail' ? `/${data.id}`
                  : page === 'dashboard' ? '/'
                  : `/${page}`;
    if (location.pathname !== newPath) history.pushState(null, '', newPath);
  }

  // Simpan halaman aktif (kecuali detail — butuh data tambahan)
  if (page !== 'playlist-detail') {
    localStorage.setItem('lastPage', page);
  }

  closeSidebar();
}

function toggleSidebar() {
  const sidebar  = document.getElementById('sidebar');
  const backdrop = document.getElementById('sidebar-backdrop');
  const isOpen   = sidebar.classList.contains('open');
  if (isOpen) {
    sidebar.classList.remove('open');
    backdrop.classList.remove('active');
  } else {
    sidebar.classList.add('open');
    backdrop.classList.add('active');
  }
}

function closeSidebar() {
  document.getElementById('sidebar')?.classList.remove('open');
  document.getElementById('sidebar-backdrop')?.classList.remove('active');
}

// ─── MODAL KONFIRMASI ────────────────────────────────────────
function showConfirm({ title, message, confirmLabel = 'Ya', confirmClass = 'btn-primary', iconClass = 'fas fa-question-circle', iconType = 'info', onConfirm, onCancel, hideCancel = false }) {
  const modal      = document.getElementById('confirm-modal');
  const iconWrap   = document.getElementById('cm-icon-wrap');
  const iconEl     = document.getElementById('cm-icon');
  const titleEl    = document.getElementById('cm-title');
  const msgEl      = document.getElementById('cm-message');
  const confirmBtn = document.getElementById('cm-confirm');
  const cancelBtn  = document.getElementById('cm-cancel');

  iconWrap.className   = `modal-icon-wrap ${iconType}`;
  iconEl.className     = iconClass;
  titleEl.textContent  = title;
  msgEl.innerHTML      = message;
  confirmBtn.className = `btn ${confirmClass}`;
  confirmBtn.innerHTML = `<i class="${iconClass}"></i> ${confirmLabel}`;
  confirmBtn.onclick   = () => { closeConfirm(); onConfirm(); };
  cancelBtn.onclick    = () => { closeConfirm(); if (onCancel) onCancel(); };
  cancelBtn.style.display = hideCancel ? 'none' : '';

  modal.classList.add('active');
}

function closeConfirm() {
  document.getElementById('confirm-modal').classList.remove('active');
  document.getElementById('cm-cancel').style.display = '';
}

function _modalOverlayClick(e) {
  if (e.target === document.getElementById('confirm-modal')) closeConfirm();
}

// ─── TOAST ────────────────────────────────────────────────────
function showToast(msg, color = '#27ae60') {
  const t = document.getElementById('toast');
  t.textContent  = msg;
  t.style.background = color;
  t.style.display    = 'block';
  setTimeout(() => { t.style.display = 'none'; }, 2800);
}

// ─── FORMAT WAKTU ─────────────────────────────────────────────
function fmtTime(s) {
  const m   = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${String(sec).padStart(2, '0')}`;
}

// ─── ESCAPE HTML ──────────────────────────────────────────────
function escHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escAttr(s) {
  return String(s || '').replace(/'/g, "\\'");
}

// ─── DASHBOARD ────────────────────────────────────────────────
async function loadDashboard() {
  const playlists = await fetch(`${API}/playlists`).then(r => r.json()).catch(() => []);

  const totalPlEl = document.getElementById('dash-total-playlists');
  if (totalPlEl) totalPlEl.textContent = playlists.length;

  const totalTracks = playlists.reduce((sum, p) => sum + (p.track_count || 0), 0);
  const totalTrEl = document.getElementById('dash-total-tracks');
  if (totalTrEl) totalTrEl.textContent = totalTracks;
}

// ─── PLAYLISTS ────────────────────────────────────────────────
function openAddPlaylistModal() {
  document.getElementById('new-pl-name').value = '';
  document.getElementById('new-pl-desc').value = '';
  document.getElementById('modal-add-playlist').classList.add('active');
  setTimeout(() => document.getElementById('new-pl-name').focus(), 80);
}

function closeAddPlaylistModal() {
  document.getElementById('modal-add-playlist').classList.remove('active');
  _pendingImportTracks = null;
}

function openAddStreamModal() {
  document.getElementById('add-title').value    = '';
  document.getElementById('add-url').value      = '';
  document.getElementById('modal-add-stream').classList.add('active');
  setTimeout(() => document.getElementById('add-title').focus(), 80);
}

function _setStreamOverlayState({ loading = false, error = '' } = {}) {
  const loadingEl = document.getElementById('stream-loading');
  const errorEl = document.getElementById('stream-error');
  const errorTextEl = document.getElementById('stream-error-text');

  if (loadingEl) loadingEl.style.display = loading ? 'flex' : 'none';
  if (errorEl) errorEl.style.display = error ? 'flex' : 'none';
  if (errorTextEl && error) errorTextEl.textContent = error;
}

async function openStreamPlayerModal(playlistId, trackIndex, title) {
  const modal = document.getElementById('modal-stream-player');
  const titleEl = document.getElementById('player-title');
  const video = document.getElementById('stream-video');

  if (!modal || !titleEl || !video) return;

  closeStreamPlayerModal();

  titleEl.innerHTML = `<i class="fas fa-play-circle"></i> ${escHtml(title)}`;
  _setStreamOverlayState({ loading: true, error: '' });
  modal.classList.add('active');

  try {
    const response = await fetch(`${API}/playlists/${encodeURIComponent(playlistId)}/tracks/${trackIndex}/preview/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId: _previewClientId }),
    });
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || 'Gagal memulai preview stream');
    }

    _currentPreviewSessionId = data.sessionId;
    _previewTakeoverNotified = false;
    const manifestUrl = `${window.location.origin}${data.manifestUrl}`;

    video.muted = true;
    video.playsInline = true;

    if (window.Hls && Hls.isSupported()) {
      _hlsPlayer = new Hls({
        lowLatencyMode: true,
        enableWorker: true,
        backBufferLength: 30,
        maxBufferLength: 8,
      });
      _hlsPlayer.on(Hls.Events.ERROR, (_, details) => {
        if (details && details.fatal) {
          _setStreamOverlayState({ error: 'Gagal memutar stream HLS.' });
          showToast('❌ Gagal memutar stream HLS', '#DC2626');
        }
      });
      _hlsPlayer.loadSource(manifestUrl);
      _hlsPlayer.attachMedia(video);
      _hlsPlayer.on(Hls.Events.MANIFEST_PARSED, () => {
        _setStreamOverlayState({ loading: false, error: '' });
        video.play().catch(() => {});
      });
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = manifestUrl;
      video.addEventListener('loadedmetadata', () => {
        _setStreamOverlayState({ loading: false, error: '' });
        video.play().catch(() => {});
      }, { once: true });
    } else {
      throw new Error('Browser tidak mendukung HLS');
    }
  } catch (error) {
    _setStreamOverlayState({ loading: false, error: error.message || 'Gagal memutar stream' });
    showToast(`❌ ${error.message || 'Gagal memutar stream'}`, '#DC2626');
  }
}

function closeStreamPlayerModal(options = {}) {
  const { skipServerStop = false } = options;

  if (_hlsPlayer) {
    try {
      _hlsPlayer.destroy();
    } catch (error) {
      console.warn('[HLS Cleanup]', error);
    }
    _hlsPlayer = null;
  }

  const video = document.getElementById('stream-video');
  if (video) {
    video.pause();
    video.removeAttribute('src');
    video.load();
  }

  if (_currentPreviewSessionId && !skipServerStop) {
    fetch(`${API}/hls-preview/${encodeURIComponent(_currentPreviewSessionId)}/stop`, { method: 'POST' }).catch(() => {});
  }
  _currentPreviewSessionId = null;
  _previewTakeoverNotified = false;

  _setStreamOverlayState({ loading: false, error: '' });
  document.getElementById('modal-stream-player')?.classList.remove('active');
}

async function pollPreviewEvents() {
  if (!_previewClientId) return;
  try {
    const [eventsResp, activeResp] = await Promise.all([
      fetch(`${API}/preview/events?clientId=${encodeURIComponent(_previewClientId)}`),
      fetch(`${API}/preview/active`),
    ]);

    const eventsData = eventsResp.ok ? await eventsResp.json() : { events: [] };
    const activeData = activeResp.ok ? await activeResp.json() : { sessionId: null };
    const events = Array.isArray(eventsData?.events) ? eventsData.events : [];

    const modalOpen = document.getElementById('modal-stream-player')?.classList.contains('active');
    const activeSessionId = activeData?.sessionId || null;
    if (modalOpen && _currentPreviewSessionId && activeSessionId && activeSessionId !== _currentPreviewSessionId) {
      closeStreamPlayerModal({ skipServerStop: true });
      if (!_previewTakeoverNotified) {
        showToast('⚠️ Preview dibuka di device lain. Preview di device ini otomatis ditutup.', '#e67e22');
        _previewTakeoverNotified = true;
      }
      return;
    }

    for (const event of events) {
      if (event?.type === 'preview_taken_over') {
        if (modalOpen && _currentPreviewSessionId) {
          closeStreamPlayerModal({ skipServerStop: true });
        }
        if (!_previewTakeoverNotified) {
          showToast('⚠️ Preview dibuka di device lain. Preview di device ini otomatis ditutup.', '#e67e22');
          _previewTakeoverNotified = true;
        }
      }
    }
  } catch {
    // silent polling
  }
}

function downloadPlaylistXspf(id) {
  const url = `${API}/playlists/${id}/download`;
  const link = document.createElement('a');
  link.href = url;
  link.download = '';
  document.body.appendChild(link);
  link.click();
  link.remove();
}

function toggleDurationByUrl(inputId, url) {
  // Deprecated: duration per stream dihapus.
}

function closeAddStreamModal() {
  document.getElementById('modal-add-stream').classList.remove('active');
}

function _mfOverlayClick(id, e) {
  if (e.target === document.getElementById(id)) {
    if (id === 'modal-stream-player') {
      closeStreamPlayerModal();
    } else {
      document.getElementById(id).classList.remove('active');
    }
  }
}

async function loadPlaylists() {
  const tbody = document.getElementById('playlist-tbody');
  if (!tbody) return;
  tbody.innerHTML = `<tr><td colspan="7" class="tbl-loading">Loading...</td></tr>`;

  try {
    const playlists = await (await fetch(`${API}/playlists`)).json();

    if (!playlists.length) {
      tbody.innerHTML = `<tr><td colspan="7" class="tbl-empty">
        <i class="fas fa-list-check"></i>
        <p>Belum ada playlist. Klik <strong>Tambah Playlist</strong> untuk membuat baru.</p>
      </td></tr>`;
      return;
    }

    const rows = playlists.map((p, idx) => {
      const trackCount  = p.track_count ?? 0;
      const fmtDate = iso => iso ? new Date(iso).toLocaleDateString('id-ID', {
        day: '2-digit', month: 'short', year: 'numeric'
      }) : '-';
      return `
        <tr>
          <td class="tbl-num">${idx + 1}</td>
          <td class="tbl-name">
            <span class="tbl-name-link" onclick="navigate('playlist-detail', { id: '${p.id}', name: '${escAttr(p.name)}' })">${escHtml(p.name)}</span>
          </td>
          <td class="tbl-desc tbl-center">${escHtml(p.description || '-')}</td>
          <td class="tbl-center">${trackCount}</td>
          <td class="tbl-date">${fmtDate(p.createdAt)}</td>
          <td class="tbl-date">${fmtDate(p.updatedAt)}</td>
          <td class="tbl-actions">
            <button class="btn btn-outline action-icon-btn btn-edit" data-tooltip="Stream" title="Stream"
              onclick="navigate('playlist-detail', { id: '${p.id}', name: '${escAttr(p.name)}', description: '${escAttr(p.description || '')}' })">
              <i class="fas fa-list"></i>
              <span class="btn-text">Stream</span>
            </button>
            <button class="btn action-icon-btn btn-xspf-download" data-tooltip="Download XSPF" title="Download XSPF"
              onclick="downloadPlaylistXspf('${p.id}')">
              <i class="fas fa-download"></i>
              <span class="btn-text">Download xspf</span>
            </button>
            <button class="btn btn-danger action-icon-btn" data-tooltip="Delete" title="Delete"
              onclick="deletePlaylist('${p.id}')">
              <i class="fas fa-trash-can"></i>
              <span class="btn-text">Delete</span>
            </button>
          </td>
        </tr>`;
    });
    tbody.innerHTML = rows.join('');

  } catch {
    tbody.innerHTML = `<tr><td colspan="7" class="tbl-error">❌ Gagal memuat playlist.</td></tr>`;
  }
}

async function deletePlaylist(id) {
  showConfirm({
    title: 'Hapus Playlist',
    message: 'Playlist ini beserta semua stream di dalamnya akan dihapus permanen. Tindakan tidak bisa dibatalkan.',
    confirmLabel: 'Hapus',
    confirmClass: 'btn-danger',
    iconClass: 'fas fa-trash-can',
    iconType: 'danger',
    onConfirm: async () => {
      try {
        await fetch(`${API}/playlists/${id}`, { method: 'DELETE' });
        showToast('Playlist berhasil dihapus');
        loadPlaylists();
      } catch {
        showToast('❌ Gagal menghapus playlist', '#DC2626');
      }
    }
  });
}

// ─── ADD PLAYLIST
async function submitAddPlaylist() {
  const name = (document.getElementById('new-pl-name')?.value || '').trim();
  const desc = (document.getElementById('new-pl-desc')?.value || '').trim();

  if (!name) {
    showToast('❌ Nama playlist wajib diisi!', '#c0392b');
    return;
  }

  try {
    const r = await fetch(`${API}/playlists`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ name, description: desc })
    });
    const d = await r.json();

    if (!r.ok) {
      showToast('❌ ' + (d.error || 'Gagal membuat playlist'), '#DC2626');
      return;
    }

    // Jika ada tracks dari import XSPF, bulk-import sekarang
    if (_pendingImportTracks && _pendingImportTracks.length > 0) {
      try {
        const br = await fetch(`${API}/playlists/${d.id}/tracks/bulk`, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ tracks: _pendingImportTracks })
        });
        const bd = await br.json();
        if (br.ok) {
          showToast(`✅ Playlist "${d.name}" dibuat dengan ${_pendingImportTracks.length} track!`);
        } else {
          showToast(`Playlist dibuat, import gagal: ${bd.error || ''}`, '#e67e22');
        }
      } catch {
        showToast(`Playlist dibuat, tapi import tracks gagal`, '#e67e22');
      }
      _pendingImportTracks = null;
    } else {
      showToast(`Playlist "${d.name}" berhasil dibuat!`);
    }

    closeAddPlaylistModal();
    loadPlaylists();
  } catch {
    showToast('❌ Tidak bisa konek ke server', '#DC2626');
  }
}

// ─── IMPORT XSPF ──────────────────────────────────────────────
function triggerXspfImport() {
  document.getElementById('xspf-file-input').click();
}

function _onXspfFileSelected(e) {
  const file = e.target.files[0];
  if (!file) return;
  e.target.value = ''; // reset agar file yang sama bisa dipilih lagi
  const reader = new FileReader();
  reader.onload = (ev) => _processXspfContent(ev.target.result, file.name);
  reader.readAsText(file);
}

function _processXspfContent(xmlText, fileName = '') {
  const parser = new DOMParser();
  const doc    = parser.parseFromString(xmlText, 'application/xml');

  if (doc.querySelector('parsererror')) {
    showToast('❌ File XSPF tidak valid atau rusak', '#c0392b');
    return;
  }

  const ns = 'http://xspf.org/ns/0/';

  // Ambil judul playlist dari <title> di dalam <playlist>
  const plTitleEl = Array.from(doc.getElementsByTagNameNS(ns, 'title'))
    .find(el => el.parentElement?.localName === 'playlist');
  const playlistTitle = plTitleEl?.textContent?.trim() || '';

  // Parse semua track
  const tracks = [];
  Array.from(doc.getElementsByTagNameNS(ns, 'track')).forEach((track, i) => {
    const locEl = track.getElementsByTagNameNS(ns, 'location')[0];
    const titEl = track.getElementsByTagNameNS(ns, 'title')[0];

    const url      = locEl?.textContent?.trim() || '';
    const title    = titEl?.textContent?.trim() || '';

    if (url) {
      tracks.push({ url, title });
    }
  });

  if (!tracks.length) {
    showToast('❌ Tidak ada track ditemukan dalam file XSPF', '#c0392b');
    return;
  }

  // Auto-fill nama playlist: utamakan nama file, fallback ke <title> XSPF
  const nameInput = document.getElementById('new-pl-name');
  if (nameInput && !nameInput.value.trim()) {
    const nameFromFile = fileName.replace(/\.xspf$/i, '').trim();
    nameInput.value = nameFromFile || playlistTitle;
  }

  // Cek track tanpa judul
  const noTitle = tracks.filter(t => !t.title);
  if (noTitle.length > 0) {
    const listHtml = noTitle.slice(0, 5)
      .map(t => `<li style="font-size:0.8em;word-break:break-all;text-align:left">${escHtml(t.url)}</li>`)
      .join('');
    const more = noTitle.length > 5 ? `<li style="font-size:0.8em">...dan ${noTitle.length - 5} lainnya</li>` : '';

    showConfirm({
      title:        'Judul Tidak Lengkap',
      message:      `<strong>${noTitle.length} track</strong> tidak memiliki judul. Track-track tersebut akan menggunakan nama file dari URL sebagai judul.<ul style="margin:8px 0 0;padding-left:18px">${listHtml}${more}</ul>`,
      confirmLabel: 'Tetap Import',
      confirmClass: 'btn-primary',
      iconClass:    'fas fa-triangle-exclamation',
      iconType:     'warning',
      onCancel:     () => closeAddPlaylistModal(),
      onConfirm:    () => {
        tracks.forEach((t, i) => {
          if (!t.title) {
            try {
              // Ambil nama file dari URL, buang ekstensi & query string
              let fname = t.url.split('/').pop().split('?')[0];
              fname = fname.replace(/\.(mp4|mkv|avi|flv|m3u8|ts)$/i, '').replace(/_/g, ' ').trim();
              t.title = fname || `Track ${i + 1}`;
            } catch {
              t.title = `Track ${i + 1}`;
            }
          }
        });
        _pendingImportTracks = tracks;
        showToast(`✅ ${tracks.length} track siap diimport — klik Simpan`);
      }
    });
    return;
  }

  _pendingImportTracks = tracks;
  showToast(`✅ ${tracks.length} track siap diimport — klik Simpan`);
}

// ─── PLAYLIST DETAIL ──────────────────────────────────────────
async function loadPlaylistDetail(id, name, description = '') {
  currentPlaylistId   = id;
  currentPlaylistName = name;
  currentPlaylistDescription = description;
  lastDetailPlaylistId = id;
  lastDetailPlaylistName = name;
  localStorage.setItem('lastDetailPlaylistId', id);
  localStorage.setItem('lastDetailPlaylistName', name);

  const titleInput = document.getElementById('detail-title-inline');
  const descInput = document.getElementById('detail-desc-inline');
  if (titleInput) titleInput.value = name || '';
  if (descInput) descInput.value = description || '';
  _originalPlaylistMeta = {
    name: (name || '').trim(),
    description: (description || '').trim(),
  };
  _playlistMetaDirty = false;
  titleInput?.classList.remove('playlist-meta-modified');
  descInput?.classList.remove('playlist-meta-modified');

  await refreshTracks();
}

async function refreshTracks() {
  const tbody = document.getElementById('tracks-tbody');
  if (!tbody) return;

  tbody.innerHTML = `
    <tr>
      <td colspan="3" style="color:#888;text-align:center;padding:20px">
        Loading...
      </td>
    </tr>`;

  try {
    const tracks = await (await fetch(`${API}/playlists/${currentPlaylistId}/tracks`)).json();

    // Store original tracks for change detection
    _originalTracks = JSON.parse(JSON.stringify(tracks));
    _tracksWithChanges.clear();

    if (!tracks.length) {
      tbody.innerHTML = `
        <tr>
          <td colspan="3" style="color:#555;text-align:center;padding:30px">
            Belum ada stream. Tambah di form bawah.
          </td>
        </tr>`;
      return;
    }

    tbody.innerHTML = tracks.map((t, i) => {
      return `
      <tr draggable="true" data-index="${i}"
        ondragstart="handleDragStart(event, ${i})"
        ondragover="handleDragOver(event)"
        ondrop="handleDrop(event, ${i})"
        ondragend="handleDragEnd(event)">
        <td style="min-width:120px;width:34%">
          <input id="t-title-${i}" value="${escHtml(t.title)}" placeholder="Judul" oninput="detectTrackChange(${i})">
        </td>
        <td style="width:48%">
          <input id="t-url-${i}" value="${escHtml(t.url)}" placeholder="URL stream..."
            oninput="detectTrackChange(${i})">
        </td>
        <td class="track-actions-cell" style="white-space:nowrap;width:18%">
          <div class="track-actions-wrap">
            <button class="btn drag-handle" style="cursor:grab"
              onmousedown="this.style.cursor='grabbing'" onmouseup="this.style.cursor='grab'">
              <i class="fas fa-grip-vertical"></i>
            </button>
            <button class="btn btn-outline"
              data-tooltip="Play Preview" title="Play Preview"
              onclick="openStreamPlayerModal('${currentPlaylistId}', ${i}, '${escAttr(t.title)}')">
              <i class="fas fa-play"></i> Play Preview
            </button>
            <button class="btn btn-danger"
              onclick="deleteTrack(${i})">
              <i class="fas fa-trash-can"></i> Hapus
            </button>
          </div>
        </td>
      </tr>`;
    }).join('');

  } catch {
    tbody.innerHTML = `
      <tr>
        <td colspan="3" style="color:#c0392b;text-align:center;padding:20px">
          ❌ Gagal memuat daftar stream.
        </td>
      </tr>`;
  }
}

// ─── DETECT TRACK CHANGES ──────────────────────────────────────
function detectTrackChange(index) {
  if (!_originalTracks[index]) return;

  const currentTitle = (document.getElementById(`t-title-${index}`)?.value || '').trim();
  const currentUrl = (document.getElementById(`t-url-${index}`)?.value || '').trim();

  const original = _originalTracks[index];

  const hasChanged = currentTitle !== original.title ||
                     currentUrl !== original.url;

  const row = document.querySelector(`#tracks-tbody tr[data-index="${index}"]`);
  if (!row) return;

  if (hasChanged) {
    _tracksWithChanges.add(index);
    row.classList.add('track-modified');
  } else {
    _tracksWithChanges.delete(index);
    row.classList.remove('track-modified');
  }
}

function detectPlaylistMetaChange() {
  const titleInput = document.getElementById('detail-title-inline');
  const descInput = document.getElementById('detail-desc-inline');
  if (!titleInput || !descInput) return;

  const name = (titleInput.value || '').trim();
  const description = (descInput.value || '').trim();
  const hasChanged = name !== _originalPlaylistMeta.name || description !== _originalPlaylistMeta.description;

  _playlistMetaDirty = hasChanged;
  titleInput.classList.toggle('playlist-meta-modified', hasChanged);
  descInput.classList.toggle('playlist-meta-modified', hasChanged);
}

async function savePlaylistMetaIfNeeded() {
  if (!currentPlaylistId || !_playlistMetaDirty) {
    return { saved: false };
  }

  const titleInput = document.getElementById('detail-title-inline');
  const descInput = document.getElementById('detail-desc-inline');
  const name = (titleInput?.value || '').trim();
  const description = (descInput?.value || '').trim();

  if (!name) {
    showToast('❌ Nama playlist wajib diisi!', '#DC2626');
    titleInput?.focus();
    return { saved: false, error: true };
  }

  try {
    const r = await fetch(`${API}/playlists/${currentPlaylistId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, description })
    });
    const d = await r.json();
    if (!r.ok) {
      showToast('❌ ' + (d.error || 'Gagal memperbarui playlist'), '#DC2626');
      return { saved: false, error: true };
    }

    _originalPlaylistMeta = { name, description };
    _playlistMetaDirty = false;
    currentPlaylistName = name;
    currentPlaylistDescription = description;
    localStorage.setItem('lastDetailPlaylistName', name);
    titleInput?.classList.remove('playlist-meta-modified');
    descInput?.classList.remove('playlist-meta-modified');
    return { saved: true };
  } catch {
    showToast('❌ Tidak bisa konek ke server', '#DC2626');
    return { saved: false, error: true };
  }
}

// ─── ASYNC SAVE ALL TRACKS ────────────────────────────────────
async function _saveTracksByIndices(indices, successLabel = 'perubahan') {
  const uniqueIndices = [...new Set(indices)].sort((a, b) => a - b);
  if (!uniqueIndices.length) {
    showToast('Tidak ada data untuk disimpan');
    return { successCount: 0, totalCount: 0 };
  }

  showToast('Menyimpan perubahan...');

  let successCount = 0;

  for (const i of uniqueIndices) {
    const title = (document.getElementById(`t-title-${i}`)?.value || '').trim();
    const url = (document.getElementById(`t-url-${i}`)?.value || '').trim();

    if (!title || !url) {
      showToast(`❌ Baris ${i + 1} masih kosong. Lengkapi dulu sebelum simpan.`, '#DC2626');
      return { successCount, totalCount: uniqueIndices.length, aborted: true };
    }

    try {
      const r = await fetch(`${API}/playlists/${currentPlaylistId}/tracks/${i}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, url })
      });

      if (r.ok) {
        _originalTracks[i] = { title, url };
        _tracksWithChanges.delete(i);
        const row = document.querySelector(`#tracks-tbody tr[data-index="${i}"]`);
        if (row) row.classList.remove('track-modified');
        successCount++;
      }
    } catch {
      // lanjut ke baris berikutnya
    }
  }

  const totalCount = uniqueIndices.length;
  const failCount = totalCount - successCount;

  if (failCount === 0) {
    showToast(`✅ Semua ${successCount} ${successLabel} berhasil disimpan!`);
  } else if (successCount > 0) {
    showToast(`⚠️ ${successCount} dari ${totalCount} ${successLabel} tersimpan`, '#e67e22');
  } else {
    showToast(`❌ Gagal menyimpan ${successLabel}`, '#DC2626');
  }

  return { successCount, totalCount, failCount };
}

async function saveAllTracks() {
  if (!currentPlaylistId) return;
  const metaResult = await savePlaylistMetaIfNeeded();
  if (metaResult?.error) return;

  const indices = Array.from(document.querySelectorAll('#tracks-tbody tr[data-index]'))
    .map(row => Number(row.dataset.index))
    .filter(index => Number.isInteger(index));

  if (!indices.length) {
    if (metaResult?.saved) showToast('✅ Playlist berhasil diperbarui!');
    else showToast('Tidak ada data untuk disimpan');
    return;
  }

  await _saveTracksByIndices(indices, 'stream');
}

async function saveAllTracksAndNavigate(targetPage, targetData) {
  const metaResult = await savePlaylistMetaIfNeeded();
  if (metaResult?.error) return;

  const indicesToSave = Array.from(_tracksWithChanges);
  if (!indicesToSave.length) {
    navigate(targetPage, targetData);
    return;
  }

  const result = await _saveTracksByIndices(indicesToSave, 'perubahan');
  if (result && result.totalCount > 0 && result.successCount === 0) return;
  navigate(targetPage, targetData);
}

// ─── UNSAVED CHANGES MODAL ────────────────────────────────────
function showUnsavedChangesModal(targetPage, targetData) {
  const changedTrackList = [..._tracksWithChanges].map(i => {
    const title = document.getElementById(`t-title-${i}`)?.value || 'Untitled';
    const url = document.getElementById(`t-url-${i}`)?.value || '-';
    return `<li style="font-size:0.85em;margin-bottom:6px"><strong>${escHtml(title)}</strong><br><span style="color:#666;font-size:0.8em">${escHtml(url.substring(0, 60))}${url.length > 60 ? '...' : ''}</span></li>`;
  });

  const changedItems = [];
  if (_playlistMetaDirty) {
    changedItems.push('<li style="font-size:0.85em;margin-bottom:6px"><strong>Metadata Playlist</strong><br><span style="color:#666;font-size:0.8em">Nama/Deskripsi playlist belum disimpan</span></li>');
  }
  changedItems.push(...changedTrackList);

  const totalChanges = _tracksWithChanges.size + (_playlistMetaDirty ? 1 : 0);
  const message = `<strong>${totalChanges} perubahan</strong> akan hilang jika tidak disimpan:<ul style="margin:8px 0 0 0;padding-left:18px;text-align:left">${changedItems.join('')}</ul><br><em style="color:#666;font-size:0.85em">💡 Simpan dulu perubahan ini sebelum lanjut ke halaman lain.</em>`;

  showConfirm({
    title: 'Perubahan Belum Disimpan',
    message: message,
    confirmLabel: 'Simpan & Keluar',
    confirmClass: 'btn-primary',
    iconClass: 'fas fa-floppy-disk',
    iconType: 'warning',
    onConfirm: () => saveAllTracksAndNavigate(targetPage, targetData),
    onCancel: () => {} // Just close, stay on page
  });
}

async function deleteTrack(i) {
  showConfirm({
    title: 'Hapus Stream',
    message: 'Stream ini akan dihapus dari playlist. Tindakan tidak bisa dibatalkan.',
    confirmLabel: 'Hapus',
    confirmClass: 'btn-danger',
    iconClass: 'fas fa-trash-can',
    iconType: 'danger',
    onConfirm: async () => {
      try {
        await fetch(`${API}/playlists/${currentPlaylistId}/tracks/${i}`, { method: 'DELETE' });
        showToast('Stream berhasil dihapus');
        refreshTracks();
      } catch {
        showToast('❌ Gagal menghapus stream', '#DC2626');
      }
    }
  });
}

// ─── MOVE TRACK ───────────────────────────────────────────────
async function moveTrack(fromIdx, toIdx) {
  try {
    const r = await fetch(`${API}/playlists/${currentPlaylistId}/tracks/move`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ from: fromIdx, to: toIdx })
    });
    if (r.ok) refreshTracks();
    else showToast('❌ Gagal mengubah urutan', '#DC2626');
  } catch {
    showToast('❌ Tidak bisa konek ke server', '#DC2626');
  }
}

async function addTrack() {
  const title    = (document.getElementById('add-title')?.value    || '').trim();
  const url      = (document.getElementById('add-url')?.value      || '').trim();

  if (!title || !url) {
    showToast('❌ Judul dan URL wajib diisi!', '#c0392b');
    return;
  }

  try {
    const r = await fetch(`${API}/playlists/${currentPlaylistId}/tracks`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ title, url })
    });

    if (r.ok) {
      document.getElementById('add-title').value    = '';
      document.getElementById('add-url').value      = '';
      closeAddStreamModal();
      showToast('✅ Stream berhasil ditambahkan!');
      refreshTracks();
    } else {
      const d = await r.json();
      showToast('❌ ' + (d.error || 'Gagal menambah stream'), '#c0392b');
    }
  } catch {
    showToast('❌ Tidak bisa konek ke server', '#c0392b');
  }
}

// ─── DRAG & DROP HANDLERS ─────────────────────────────────────
let _dragSourceIndex = null;

function handleDragStart(e, index) {
  _dragSourceIndex = index;
  e.currentTarget.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/html', e.currentTarget.innerHTML);
}

function handleDragOver(e) {
  if (e.preventDefault) e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  const row = e.currentTarget;
  row.classList.add('drag-over');
  return false;
}

function handleDrop(e, targetIndex) {
  if (e.stopPropagation) e.stopPropagation();
  e.currentTarget.classList.remove('drag-over');

  if (_dragSourceIndex !== null && _dragSourceIndex !== targetIndex) {
    moveTrack(_dragSourceIndex, targetIndex);
  }
  return false;
}

function handleDragEnd(e) {
  e.currentTarget.classList.remove('dragging');
  document.querySelectorAll('#tracks-tbody tr').forEach(row => {
    row.classList.remove('drag-over');
  });
  _dragSourceIndex = null;
}

// ─── SEARCH / FILTER ──────────────────────────────────────────
function filterPlaylists() {
  const q = (document.getElementById('pl-search')?.value || '').toLowerCase();
  let visible = 0;
  document.querySelectorAll('#playlist-tbody tr:not(#pl-empty-search)').forEach(row => {
    if (row.querySelector('td[colspan]')) return;
    const match = row.textContent.toLowerCase().includes(q);
    row.style.display = match ? '' : 'none';
    if (match) visible++;
  });

  const existing = document.getElementById('pl-empty-search');
  if (q && visible === 0) {
    if (!existing) {
      const tr = document.createElement('tr');
      tr.id = 'pl-empty-search';
      tr.innerHTML = `<td colspan="7" class="tbl-empty" style="padding:40px">
        <i class="fas fa-magnifying-glass"></i>
        <p>Tidak ada hasil untuk <strong>"${escHtml(q)}"</strong></p>
      </td>`;
      document.getElementById('playlist-tbody').appendChild(tr);
    }
  } else if (existing) {
    existing.remove();
  }
}

function filterTracks() {
  const q = (document.getElementById('track-search')?.value || '').toLowerCase();
  let visible = 0;
  document.querySelectorAll('#tracks-tbody tr:not(#track-empty-search)').forEach(row => {
    if (row.querySelector('td[colspan]')) return;
    // Hanya cari berdasarkan judul (input pertama di baris)
    const text = (row.querySelector('input')?.value || '').toLowerCase();
    const match = text.includes(q);
    row.style.display = match ? '' : 'none';
    if (match) visible++;
  });

  const existing = document.getElementById('track-empty-search');
  if (q && visible === 0) {
    if (!existing) {
      const tr = document.createElement('tr');
      tr.id = 'track-empty-search';
      tr.innerHTML = `<td colspan="3" class="tbl-empty" style="padding:40px">
        <i class="fas fa-magnifying-glass"></i>
        <p>Tidak ada hasil untuk <strong>"${escHtml(q)}"</strong></p>
      </td>`;
      document.getElementById('tracks-tbody').appendChild(tr);
    }
  } else if (existing) {
    existing.remove();
  }
}

// ─── PATH ROUTER ──────────────────────────────────────────────
async function _routeFromPath() {
  const path = location.pathname.replace(/^\//, ''); // hilangkan slash depan
  _skipHashPush = true;

  if (!currentPlaylistId && lastDetailPlaylistId && lastDetailPlaylistName) {
    currentPlaylistId = lastDetailPlaylistId;
    currentPlaylistName = lastDetailPlaylistName;
  }

  if (!path || path === 'dashboard') {
    navigate('dashboard');
  } else if (path === 'playlists') {
    navigate('playlists');
  } else {
    // Coba cocokkan sebagai playlist ID
    try {
      const playlists = await fetch(`${API}/playlists`).then(r => r.json());
      const pl = playlists.find(p => p.id === path);
      if (pl) navigate('playlist-detail', { id: pl.id, name: pl.name, description: pl.description || '' });
      else    navigate('playlists');
    } catch {
      navigate('dashboard');
    }
  }

  _skipHashPush = false;
}

// ─── INIT ─────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  _routeFromPath();
  if (!_previewEventTimer) {
    _previewEventTimer = setInterval(pollPreviewEvents, 1200);
  }
});

window.addEventListener('popstate', _routeFromPath);