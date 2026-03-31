const API = '/api';
let currentPlaylistId   = null;
let currentPlaylistName = null;
let currentLoadedPlaylistName = localStorage.getItem('activePlaylistName') || null;
let _pendingImportTracks = null; // tracks parsed from XSPF, siap diimport saat Simpan
let _skipHashPush = false;

// ─── NAVIGASI ─────────────────────────────────────────────────
function navigate(page, data = {}) {
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
    loadPlaylistDetail(data.id, data.name);
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
function showConfirm({ title, message, confirmLabel = 'Ya', confirmClass = 'btn-primary', iconClass = 'fas fa-question-circle', iconType = 'info', onConfirm, onCancel }) {
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

  modal.classList.add('active');
}

function closeConfirm() {
  document.getElementById('confirm-modal').classList.remove('active');
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

// ─── VLC STATUS ───────────────────────────────────────────────
async function fetchVlcStatus() {
  try {
    const r = await fetch(`${API}/vlc/status`);
    const d = await r.json();
    updateAllNowPlayingBars(d);
    return d;
  } catch {
    updateAllNowPlayingBars({ connected: false, state: 'disconnected', title: '-' });
  }
}

function updateAllNowPlayingBars(d) {
  document.querySelectorAll('.now-playing-bar').forEach(bar => {
    const titleEl = bar.querySelector('.np-title');
    const badgeEl = bar.querySelector('.state-badge');
    if (titleEl) titleEl.textContent = d.title || '-';
    if (badgeEl) {
      badgeEl.textContent = d.state || 'disconnected';
      badgeEl.className   = `state-badge ${d.state || 'disconnected'}`;
    }
  });

  // VLC Status card (dashboard)
  const stateEl = document.getElementById('dash-vlc-state');
  if (stateEl) stateEl.textContent = d.state || '-';
  const fill    = document.getElementById('np-fill');
  const timeDash = document.getElementById('np-time-dash');
  if (fill) {
    const pct = (d.length > 0) ? Math.min(100, (d.time / d.length) * 100) : 0;
    fill.style.width = pct + '%';
  }
  if (timeDash) {
    timeDash.textContent = (d.length > 0)
      ? `${fmtTime(d.time)} / ${fmtTime(d.length)}`
      : (d.connected ? 'Live' : '');
  }

  // Stream info fields
  const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val || '-'; };
  set('si-fps',   d.fps   ? `${parseFloat(d.fps).toFixed(2)} fps` : null);
  set('si-res',   d.resolution);
  set('si-codec', d.codec);

  // Sidebar VLC dots (desktop + mobile)
  const dot = document.getElementById('sidebar-vlc-dot');
  if (dot) {
    if (d.connected && d.state !== 'disconnected') dot.classList.add('connected');
    else dot.classList.remove('connected');
  }
  const mobileDot = document.getElementById('mobile-vlc-dot');
  if (mobileDot) {
    if (d.connected && d.state !== 'disconnected') mobileDot.classList.add('connected');
    else mobileDot.classList.remove('connected');
  }
}

// ─── DASHBOARD ────────────────────────────────────────────────
async function loadDashboard() {
  const [vlc, playlists] = await Promise.all([
    fetchVlcStatus(),
    fetch(`${API}/playlists`).then(r => r.json()).catch(() => [])
  ]);

  const stateEl = document.getElementById('dash-vlc-state');
  if (stateEl) stateEl.textContent = vlc?.state || '-';

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
  document.getElementById('add-duration').value = '30';
  toggleDurationByUrl('add-duration', '');
  document.getElementById('modal-add-stream').classList.add('active');
  setTimeout(() => document.getElementById('add-title').focus(), 80);
}

function toggleDurationByUrl(inputId, url) {
  const el = document.getElementById(inputId);
  if (!el) return;
  const isVod = /\.mp4/i.test(url);
  el.disabled = isVod;
  el.title    = isVod ? 'File MP4 — durasi otomatis dari VLC, tidak bisa diubah' : '';
}

function closeAddStreamModal() {
  document.getElementById('modal-add-stream').classList.remove('active');
}

function _mfOverlayClick(id, e) {
  if (e.target === document.getElementById(id)) {
    document.getElementById(id).classList.remove('active');
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
      const isPlaying   = currentLoadedPlaylistName === p.name;
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
            <button class="btn btn-outline" style="font-size:0.75rem;padding:5px 10px"
              ${isPlaying ? 'disabled title="Tidak bisa diedit saat sedang diputar di VLC"' : `onclick="openEditPlaylistModal('${p.id}', '${escAttr(p.name)}', '${escAttr(p.description || '')}')"`}>
              <i class="fas fa-pen-to-square"></i> Edit
            </button>
            <button class="btn btn-primary" style="font-size:0.75rem;padding:5px 10px"
              onclick="navigate('playlist-detail', { id: '${p.id}', name: '${escAttr(p.name)}' })">
              <i class="fas fa-folder-open"></i> Buka
            </button>
            <button class="btn btn-danger" style="font-size:0.75rem;padding:5px 8px"
              onclick="deletePlaylist('${p.id}')">
              <i class="fas fa-trash-can"></i> Hapus
            </button>
          </td>
        </tr>`;
    });
    tbody.innerHTML = rows.join('');

  } catch {
    tbody.innerHTML = `<tr><td colspan="7" class="tbl-error">❌ Gagal memuat playlist.</td></tr>`;
  }
}

// ─── EDIT PLAYLIST ────────────────────────────────────────────
function openEditPlaylistModal(id, name, desc) {
  document.getElementById('edit-pl-id').value   = id;
  document.getElementById('edit-pl-name').value = name;
  document.getElementById('edit-pl-desc').value = desc;
  document.getElementById('modal-edit-playlist').classList.add('active');
  setTimeout(() => document.getElementById('edit-pl-name').focus(), 80);
}

function closeEditPlaylistModal() {
  document.getElementById('modal-edit-playlist').classList.remove('active');
}

async function submitEditPlaylist() {
  const id   = document.getElementById('edit-pl-id').value;
  const name = (document.getElementById('edit-pl-name').value || '').trim();
  const desc = (document.getElementById('edit-pl-desc').value || '').trim();

  if (!name) {
    showToast('❌ Nama playlist wajib diisi!', '#c0392b');
    return;
  }

  try {
    const r = await fetch(`${API}/playlists/${id}`, {
      method:  'PUT',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ name, description: desc })
    });
    const d = await r.json();
    if (r.ok) {
      // Sync nama yang sedang aktif jika playlist ini sedang diplay
      if (currentLoadedPlaylistName && currentPlaylistId === id) {
        currentLoadedPlaylistName = d.name;
        localStorage.setItem('activePlaylistName', d.name);
      }
      showToast(`✅ Playlist berhasil diperbarui!`);
      closeEditPlaylistModal();
      loadPlaylists();
    } else {
      showToast('❌ ' + (d.error || 'Gagal memperbarui playlist'), '#DC2626');
    }
  } catch (e) {
    showToast('❌ ' + (e?.message || 'Tidak bisa konek ke server'), '#DC2626');
  }
}

async function ensureVlcFullscreen() {
  try {
    const st = await fetchVlcStatus();
    if (st && !st.fullscreen) {
      await fetch(`${API}/vlc/fullscreen`, { method: 'POST' });
    }
  } catch {}
}

async function loadToVlc(id, name) {
  showConfirm({
    title: 'Load ke VLC',
    message: `Playlist <strong>"${escHtml(name)}"</strong> akan segera diputar dan dimulai dari awal di VLC. Playlist yang sedang diputar akan dihentikan.`,
    confirmLabel: 'Load & Putar',
    confirmClass: 'btn-success',
    iconClass: 'fas fa-circle-play',
    iconType: 'success',
    onConfirm: async () => {
      try {
        const r = await fetch(`${API}/playlists/${id}/load-vlc`, { method: 'POST' });
        const d = await r.json();
        if (d.success) {
          showToast('Playlist berhasil di-load ke VLC!');
          const plPage = document.getElementById('page-playlists');
          if (plPage && plPage.classList.contains('active')) loadPlaylists();

          try {
            const tracks = await (await fetch(`${API}/playlists/${id}/tracks`)).json();
            startDurationRotate(tracks);
          } catch {}

          setTimeout(ensureVlcFullscreen, 1500);
        } else {
          showToast('\u274c ' + (d.error || 'Gagal load ke VLC'), '#DC2626');
        }
      } catch {
        showToast('\u274c Tidak bisa konek ke server', '#DC2626');
      }
    }
  });
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
    const durEl = track.getElementsByTagNameNS(ns, 'duration')[0];

    const url      = locEl?.textContent?.trim() || '';
    const title    = titEl?.textContent?.trim() || '';
    const duration = durEl ? parseInt(durEl.textContent) : null;

    if (url) {
      tracks.push({ url, title, duration: isNaN(duration) ? null : duration });
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
async function loadPlaylistDetail(id, name) {
  currentPlaylistId   = id;
  currentPlaylistName = name;

  const titleEl = document.getElementById('detail-title');
  if (titleEl) titleEl.textContent = name;

  const loadBtn = document.getElementById('detail-load-vlc');
  if (loadBtn) loadBtn.onclick = () => loadToVlc(id, name);

  await refreshTracks();
}

async function refreshTracks() {
  const tbody = document.getElementById('tracks-tbody');
  if (!tbody) return;

  tbody.innerHTML = `
    <tr>
      <td colspan="4" style="color:#888;text-align:center;padding:20px">
        Loading...
      </td>
    </tr>`;

  try {
    const tracks = await (await fetch(`${API}/playlists/${currentPlaylistId}/tracks`)).json();

    if (!tracks.length) {
      tbody.innerHTML = `
        <tr>
          <td colspan="4" style="color:#555;text-align:center;padding:30px">
            Belum ada stream. Tambah di form bawah.
          </td>
        </tr>`;
      return;
    }

    tbody.innerHTML = tracks.map((t, i) => {
      const durSec  = t.duration ? Math.round(t.duration / 1000) : 30;
      const isVod   = /\.mp4/i.test(t.url);
      const durAttr = isVod
        ? 'disabled title="File MP4 — durasi otomatis dari VLC, tidak bisa diubah"'
        : '';
      return `
      <tr draggable="true" data-index="${i}"
        ondragstart="handleDragStart(event, ${i})"
        ondragover="handleDragOver(event)"
        ondrop="handleDrop(event, ${i})"
        ondragend="handleDragEnd(event)">
        <td style="min-width:160px">
          <input id="t-title-${i}" value="${escHtml(t.title)}" placeholder="Judul">
        </td>
        <td>
          <input id="t-url-${i}" value="${escHtml(t.url)}" placeholder="rtmp://..."
            oninput="toggleDurationByUrl('t-duration-${i}', this.value)">
        </td>
        <td style="width:120px">
          <input type="number" id="t-duration-${i}" value="${durSec}" placeholder="dtk" min="1"
            style="width:100%" ${durAttr}>
        </td>
        <td style="white-space:nowrap;width:142px">
          <button class="btn drag-handle" style="font-size:0.75rem;padding:5px 8px;cursor:grab"
            onmousedown="this.style.cursor='grabbing'" onmouseup="this.style.cursor='grab'">
            <i class="fas fa-grip-vertical"></i>
          </button>
          <button class="btn btn-primary"
            style="font-size:0.75rem;padding:5px 10px;margin-left:2px"
            onclick="saveTrack(${i})">
            <i class="fas fa-floppy-disk"></i> Simpan
          </button>
          <button class="btn btn-danger"
            style="font-size:0.75rem;padding:5px 8px;margin-left:2px"
            onclick="deleteTrack(${i})">
            <i class="fas fa-trash-can"></i> Hapus
          </button>
        </td>
      </tr>`;
    }).join('');

  } catch {
    tbody.innerHTML = `
      <tr>
        <td colspan="4" style="color:#c0392b;text-align:center;padding:20px">
          ❌ Gagal memuat daftar stream.
        </td>
      </tr>`;
  }
}

async function saveTrack(i) {
  const title    = document.getElementById(`t-title-${i}`)?.value    || '';
  const url      = document.getElementById(`t-url-${i}`)?.value      || '';
  const durInput = (document.getElementById(`t-duration-${i}`)?.value || '').trim();
  const duration = durInput ? Math.round(parseFloat(durInput) * 1000) : null;

  if (!title || !url) {
    showToast('❌ Judul dan URL tidak boleh kosong!', '#c0392b');
    return;
  }

  try {
    const r = await fetch(`${API}/playlists/${currentPlaylistId}/tracks/${i}`, {
      method:  'PUT',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ title, url, duration })
    });
    if (r.ok) showToast('✅ Stream berhasil diperbarui!');
    else      showToast('❌ Gagal memperbarui stream', '#c0392b');
  } catch {
    showToast('❌ Tidak bisa konek ke server', '#c0392b');
  }
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

// ─── SET ALL DURATION ─────────────────────────────────────────
function openSetAllDurationModal() {
  document.getElementById('set-all-duration-input').value = '';
  document.getElementById('modal-set-all-duration').classList.add('active');
  setTimeout(() => document.getElementById('set-all-duration-input').focus(), 50);
}

function closeSetAllDurationModal() {
  document.getElementById('modal-set-all-duration').classList.remove('active');
}

async function submitSetAllDuration() {
  const val = (document.getElementById('set-all-duration-input')?.value || '').trim();
  const sec = parseFloat(val);
  if (!val || isNaN(sec) || sec < 1) {
    showToast('❌ Masukkan durasi yang valid (min. 1 detik)', '#c0392b');
    return;
  }
  const durationMs = Math.round(sec * 1000);

  // Kumpulkan semua track dari tabel
  const tracks = [];
  let i = 0;
  while (document.getElementById(`t-url-${i}`)) {
    const url   = document.getElementById(`t-url-${i}`).value || '';
    const title = document.getElementById(`t-title-${i}`).value || '';
    tracks.push({ index: i, url, title, isVod: /\.mp4/i.test(url) });
    i++;
  }

  const nonVodTracks = tracks.filter(t => !t.isVod);
  if (!nonVodTracks.length) {
    showToast('⚠️ Semua track adalah MP4 — tidak ada yang diubah', '#e67e22');
    closeSetAllDurationModal();
    return;
  }

  closeSetAllDurationModal();

  try {
    await Promise.all(nonVodTracks.map(t =>
      fetch(`${API}/playlists/${currentPlaylistId}/tracks/${t.index}`, {
        method:  'PUT',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ title: t.title, url: t.url, duration: durationMs })
      })
    ));
    refreshTracks();

    const hasVod    = tracks.length !== nonVodTracks.length;
    const mp4Warn   = hasVod
      ? `<br><br><i class="fas fa-triangle-exclamation" style="color:#f59e0b"></i> <strong>Track MP4 tidak ikut berubah</strong> — durasi mengikuti VLC secara otomatis.`
      : '';

    showConfirm({
      title:        'Durasi Diperbarui',
      message:      `Durasi <strong>${sec} detik</strong> diterapkan ke <strong>${nonVodTracks.length} stream</strong>.${mp4Warn}<br><br><i class="fas fa-rotate" style="color:#3b82f6"></i> Klik <strong>Load ke VLC</strong> untuk menerapkan perubahan.`,
      confirmLabel: 'Mengerti',
      confirmClass: 'btn-primary',
      iconClass:    'fas fa-circle-check',
      iconType:     'success',
      onConfirm:    () => {}
    });
  } catch {
    showToast('❌ Gagal memperbarui beberapa stream', '#DC2626');
  }
}

async function addTrack() {
  const title    = (document.getElementById('add-title')?.value    || '').trim();
  const url      = (document.getElementById('add-url')?.value      || '').trim();
  const durInput = (document.getElementById('add-duration')?.value || '').trim();
  const duration = durInput ? Math.round(parseFloat(durInput) * 1000) : null;

  if (!title || !url) {
    showToast('❌ Judul dan URL wajib diisi!', '#c0392b');
    return;
  }

  try {
    const r = await fetch(`${API}/playlists/${currentPlaylistId}/tracks`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ title, url, duration })
    });

    if (r.ok) {
      document.getElementById('add-title').value    = '';
      document.getElementById('add-url').value      = '';
      document.getElementById('add-duration').value = '';
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

// ─── ROTASI PER-TRACK (berdasarkan durasi tiap stream) ────────
let _rotatePlaylist = [];
let _rotateIndex    = 0;
let _rotateTimer    = null;
let _lastVlcTitle   = null;   // double-skip guard: title di-snapshot saat schedule

async function _vlcNext() {
  try { await fetch(`${API}/vlc/next`, { method: 'POST' }); } catch {}
}

function startDurationRotate(tracks) {
  clearTimeout(_rotateTimer);
  _rotatePlaylist = (tracks || []).filter(t => t.url);
  _rotateIndex    = 0;
  _lastVlcTitle   = null;   // clear title dari session sebelumnya
  if (_rotatePlaylist.length > 1) _scheduleRotate();
}

async function _scheduleRotate() {
  const track = _rotatePlaylist[_rotateIndex];

  // Tunggu VLC settle setelah pergantian track
  await new Promise(r => setTimeout(r, 500));

  // Tanya VLC: VOD (length > 0) atau live stream (length == 0)?
  const d = await fetchVlcStatus();

  let ms;
  if (d && d.length > 0) {
    // VOD/file: gunakan actual remaining duration dari VLC + 1s buffer anti double-skip
    const remainingMs = (d.length - d.time) * 1000;
    ms = Math.max(1000, remainingMs + 1000);
    _lastVlcTitle = d.title;   // snapshot untuk deteksi apakah VLC sudah maju sendiri
  } else {
    // Live RTMP stream (atau VLC tidak bisa dihubungi): gunakan configured duration
    ms = track.duration ?? 30000;
    _lastVlcTitle = null;
  }

  _rotateTimer = setTimeout(async () => {
    _rotateIndex = (_rotateIndex + 1) % _rotatePlaylist.length;

    // Untuk VOD: cek apakah VLC sudah auto-advance (title berubah = sudah maju sendiri)
    let vlcAlreadyAdvanced = false;
    if (_lastVlcTitle !== null) {
      const current = await fetchVlcStatus();
      if (current && current.title !== _lastVlcTitle) vlcAlreadyAdvanced = true;
    }

    // Kirim pl_next hanya kalau VLC belum maju sendiri
    if (!vlcAlreadyAdvanced) await _vlcNext();
    _scheduleRotate();
  }, ms);
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
      tr.innerHTML = `<td colspan="6" class="tbl-empty" style="padding:40px">
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
      tr.innerHTML = `<td colspan="4" class="tbl-empty" style="padding:40px">
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

  if (!path || path === 'dashboard') {
    const saved    = localStorage.getItem('lastPage') || 'dashboard';
    const lastPage = document.getElementById(`page-${saved}`) ? saved : 'dashboard';
    navigate(lastPage);
  } else if (path === 'playlists') {
    navigate('playlists');
  } else {
    // Coba cocokkan sebagai playlist ID
    try {
      const playlists = await fetch(`${API}/playlists`).then(r => r.json());
      const pl = playlists.find(p => p.id === path);
      if (pl) navigate('playlist-detail', { id: pl.id, name: pl.name });
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
  setInterval(fetchVlcStatus, 3000);  // polling VLC tiap 3 detik
});

window.addEventListener('popstate', _routeFromPath);