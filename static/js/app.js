const API = '/api';
let currentPlaylistId   = null;
let currentPlaylistName = null;
let currentLoadedPlaylistName = localStorage.getItem('activePlaylistName') || null;
let _pendingImportTracks = null; // tracks parsed from XSPF, siap diimport saat Simpan

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

  if (page === 'playlist-detail') loadPlaylistDetail(data.id, data.name);

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

  // Progress bar (dashboard only)
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
  document.getElementById('modal-add-stream').classList.add('active');
  setTimeout(() => document.getElementById('add-title').focus(), 80);
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
  tbody.innerHTML = `<tr><td colspan="6" class="tbl-loading">Loading...</td></tr>`;

  try {
    const playlists = await (await fetch(`${API}/playlists`)).json();

    if (!playlists.length) {
      tbody.innerHTML = `<tr><td colspan="6" class="tbl-empty">
        <i class="fas fa-list-check"></i>
        <p>Belum ada playlist. Klik <strong>Tambah Playlist</strong> untuk membuat baru.</p>
      </td></tr>`;
      return;
    }

    const rows = await Promise.all(playlists.map(async (p, idx) => {
      const trackCount = p.track_count ?? 0;
      const date = new Date(p.createdAt).toLocaleDateString('id-ID', {
        day: '2-digit', month: 'short', year: 'numeric'
      });
      const isActive = currentLoadedPlaylistName === p.name;
      return `
        <tr class="${isActive ? 'row-active' : ''}">
          <td class="tbl-num">${idx + 1}</td>
          <td class="tbl-name">
            ${isActive ? '<span class="active-dot" title="Sedang diputar di VLC"></span>' : ''}
            <span class="tbl-name-link" onclick="navigate('playlist-detail', { id: '${p.id}', name: '${escAttr(p.name)}' })">${escHtml(p.name)}</span>
          </td>
          <td class="tbl-desc">${escHtml(p.description || '-')}</td>
          <td class="tbl-center">${trackCount}</td>
          <td class="tbl-date">${date}</td>
          <td class="tbl-actions">
            <button class="btn btn-primary" style="font-size:0.75rem;padding:5px 10px"
              onclick="navigate('playlist-detail', { id: '${p.id}', name: '${escAttr(p.name)}' })">
              <i class="fas fa-folder-open"></i> Buka
            </button>
            <button class="btn btn-danger" style="font-size:0.75rem;padding:5px 10px"
              onclick="deletePlaylist('${p.id}')">
              <i class="fas fa-trash-can"></i> Hapus
            </button>
          </td>
        </tr>`;
    }));
    tbody.innerHTML = rows.join('');

  } catch {
    tbody.innerHTML = `<tr><td colspan="6" class="tbl-error">❌ Gagal memuat playlist.</td></tr>`;
  }
}

async function loadToVlc(id, name) {
  const currentMsg = currentLoadedPlaylistName
    ? `<br>Playlist aktif saat ini <strong>"${escHtml(currentLoadedPlaylistName)}"</strong> akan dihentikan.`
    : '';

  showConfirm({
    title: 'Load ke VLC',
    message: `Playlist <strong>"${escHtml(name)}"</strong> akan segera diputar di VLC.${currentMsg}`,
    confirmLabel: 'Load & Putar',
    confirmClass: 'btn-success',
    iconClass: 'fas fa-circle-play',
    iconType: 'success',
    onConfirm: async () => {
      try {
        const r = await fetch(`${API}/playlists/${id}/load-vlc`, { method: 'POST' });
        const d = await r.json();
        if (d.success) {
          currentLoadedPlaylistName = name || id;
          localStorage.setItem('activePlaylistName', currentLoadedPlaylistName);
          showToast('Playlist berhasil di-load ke VLC!');
          const plPage = document.getElementById('page-playlists');
          if (plPage && plPage.classList.contains('active')) loadPlaylists();

          // Mulai rotasi per-track berdasarkan durasi masing-masing
          try {
            const tracks = await (await fetch(`${API}/playlists/${id}/tracks`)).json();
            startDurationRotate(tracks);
          } catch {}
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
      const durSec = t.duration ? Math.round(t.duration / 1000) : 30;
      return `
      <tr>
        <td style="min-width:160px">
          <input id="t-title-${i}" value="${escHtml(t.title)}" placeholder="Judul">
        </td>
        <td>
          <input id="t-url-${i}" value="${escHtml(t.url)}" placeholder="rtmp://...">
        </td>
        <td style="width:120px">
          <input type="number" id="t-duration-${i}" value="${durSec}" placeholder="dtk" min="1" style="width:100%">
        </td>
        <td style="white-space:nowrap;width:120px">
          <button class="btn btn-primary"
            style="font-size:0.75rem;padding:5px 10px"
            onclick="saveTrack(${i})">
            <i class="fas fa-floppy-disk"></i> Simpan
          </button>
          <button class="btn btn-danger"
            style="font-size:0.75rem;padding:5px 10px;margin-left:4px"
            onclick="deleteTrack(${i})">
            <i class="fas fa-trash-can"></i>
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

async function _vlcNext() {
  try { await fetch(`${API}/vlc/next`, { method: 'POST' }); } catch {}
}

function startDurationRotate(tracks) {
  clearTimeout(_rotateTimer);
  _rotatePlaylist = (tracks || []).filter(t => t.url);
  _rotateIndex    = 0;
  if (_rotatePlaylist.length > 1) _scheduleRotate();
}

function _scheduleRotate() {
  const track = _rotatePlaylist[_rotateIndex];
  const ms    = track.duration ?? 30000;   // fallback 30 detik

  _rotateTimer = setTimeout(async () => {
    _rotateIndex = (_rotateIndex + 1) % _rotatePlaylist.length;
    await _vlcNext();
    _scheduleRotate();
  }, ms);
}

// ─── INIT ─────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  const saved    = localStorage.getItem('lastPage') || 'dashboard';
  const lastPage = document.getElementById(`page-${saved}`) ? saved : 'dashboard';
  navigate(lastPage);
  setInterval(fetchVlcStatus, 3000);  // polling VLC tiap 3 detik
});