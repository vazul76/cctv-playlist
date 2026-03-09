const API = '/api';
let currentPlaylistId   = null;
let currentPlaylistName = null;
let currentLoadedPlaylistName = null;  // playlist yang sedang di-load ke VLC

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
  if (page === 'settings')        updateArStatus();

  if (page === 'playlist-detail') loadPlaylistDetail(data.id, data.name);
}

// ─── MODAL KONFIRMASI ────────────────────────────────────────
function showConfirm({ title, message, confirmLabel = 'Ya', confirmClass = 'btn-primary', iconClass = 'fas fa-question-circle', iconType = 'info', onConfirm }) {
  const modal      = document.getElementById('confirm-modal');
  const iconWrap   = document.getElementById('cm-icon-wrap');
  const iconEl     = document.getElementById('cm-icon');
  const titleEl    = document.getElementById('cm-title');
  const msgEl      = document.getElementById('cm-message');
  const confirmBtn = document.getElementById('cm-confirm');

  iconWrap.className   = `modal-icon-wrap ${iconType}`;
  iconEl.className     = iconClass;
  titleEl.textContent  = title;
  msgEl.innerHTML      = message;
  confirmBtn.className = `btn ${confirmClass}`;
  confirmBtn.textContent = confirmLabel;
  confirmBtn.onclick   = () => { closeConfirm(); onConfirm(); };

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
    const timeEl  = bar.querySelector('.np-time');

    if (titleEl) titleEl.textContent = d.title || '-';
    if (badgeEl) {
      badgeEl.textContent = d.state || 'disconnected';
      badgeEl.className   = `state-badge ${d.state || 'disconnected'}`;
    }
    if (timeEl) {
      timeEl.textContent = (d.length > 0)
        ? `${fmtTime(d.time)} / ${fmtTime(d.length)}`
        : '';
    }
  });

  // Update sidebar VLC dot
  const dot = document.getElementById('sidebar-vlc-dot');
  if (dot) {
    if (d.connected && d.state !== 'disconnected') {
      dot.classList.add('connected');
    } else {
      dot.classList.remove('connected');
    }
  }
}

// ─── DASHBOARD ────────────────────────────────────────────────
async function loadDashboard() {
  // VLC status
  const vlc = await fetchVlcStatus();
  const stateEl = document.getElementById('dash-vlc-state');
  if (stateEl) stateEl.textContent = vlc?.state || '-';

  // Playlists & total tracks
  try {
    const playlists = await (await fetch(`${API}/playlists`)).json();
    const totalPlEl = document.getElementById('dash-total-playlists');
    if (totalPlEl) totalPlEl.textContent = playlists.length;

    let totalTracks = 0;
    for (const p of playlists) {
      try {
        const tracks = await (await fetch(`${API}/playlists/${p.id}/tracks`)).json();
        totalTracks += Array.isArray(tracks) ? tracks.length : 0;
      } catch {}
    }

    const totalTrEl = document.getElementById('dash-total-tracks');
    if (totalTrEl) totalTrEl.textContent = totalTracks;
  } catch {}
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
}

function openAddStreamModal() {
  document.getElementById('add-title').value = '';
  document.getElementById('add-url').value   = '';
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
      let trackCount = 0;
      try {
        const tracks = await (await fetch(`${API}/playlists/${p.id}/tracks`)).json();
        trackCount = Array.isArray(tracks) ? tracks.length : 0;
      } catch {}
      const date = new Date(p.createdAt).toLocaleDateString('id-ID', {
        day: '2-digit', month: 'short', year: 'numeric'
      });
      const isActive = currentLoadedPlaylistName === p.name;
      return `
        <tr class="${isActive ? 'row-active' : ''}">
          <td class="tbl-num">${idx + 1}</td>
          <td class="tbl-name">
            ${isActive ? '<span class="active-dot" title="Sedang diputar di VLC"></span>' : ''}
            ${escHtml(p.name)}
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
              <i class="fas fa-trash-can"></i>
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
          showToast('Playlist berhasil di-load ke VLC!');
          const plPage = document.getElementById('page-playlists');
          if (plPage && plPage.classList.contains('active')) loadPlaylists();
          const actEl = document.getElementById('dash-active-playlist');
          if (actEl) actEl.textContent = currentLoadedPlaylistName;
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

    if (r.ok) {
      showToast(`Playlist "${d.name}" berhasil dibuat!`);
      closeAddPlaylistModal();
      loadPlaylists();
    } else {
      showToast('❌ ' + (d.error || 'Gagal membuat playlist'), '#DC2626');
    }
  } catch {
    showToast('❌ Tidak bisa konek ke server', '#DC2626');
  }
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
      <td colspan="3" style="color:#888;text-align:center;padding:20px">
        Loading...
      </td>
    </tr>`;

  try {
    const tracks = await (await fetch(`${API}/playlists/${currentPlaylistId}/tracks`)).json();

    if (!tracks.length) {
      tbody.innerHTML = `
        <tr>
          <td colspan="3" style="color:#555;text-align:center;padding:30px">
            Belum ada stream. Tambah di form bawah.
          </td>
        </tr>`;
      return;
    }

    tbody.innerHTML = tracks.map((t, i) => `
      <tr>
        <td style="min-width:160px">
          <input id="t-title-${i}" value="${escHtml(t.title)}" placeholder="Judul">
        </td>
        <td>
          <input id="t-url-${i}" value="${escHtml(t.url)}" placeholder="rtmp://...">
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
      </tr>`).join('');

  } catch {
    tbody.innerHTML = `
      <tr>
        <td colspan="3" style="color:#c0392b;text-align:center;padding:20px">
          ❌ Gagal memuat daftar stream.
        </td>
      </tr>`;
  }
}

async function saveTrack(i) {
  const title = document.getElementById(`t-title-${i}`)?.value || '';
  const url   = document.getElementById(`t-url-${i}`)?.value   || '';

  if (!title || !url) {
    showToast('❌ Judul dan URL tidak boleh kosong!', '#c0392b');
    return;
  }

  try {
    const r = await fetch(`${API}/playlists/${currentPlaylistId}/tracks/${i}`, {
      method:  'PUT',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ title, url })
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
  const title = (document.getElementById('add-title')?.value || '').trim();
  const url   = (document.getElementById('add-url')?.value   || '').trim();

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
      document.getElementById('add-title').value = '';
      document.getElementById('add-url').value   = '';
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

// ─── VLC NEXT / PREV ──────────────────────────────────────────
async function vlcNext() {
  try {
    await fetch(`${API}/vlc/next`, { method: 'POST' });
  } catch {}
}

async function vlcPrev() {
  try {
    await fetch(`${API}/vlc/prev`, { method: 'POST' });
  } catch {}
}

// ─── AUTO-ROTATE (selalu aktif, hanya interval yang bisa diubah) ───────────
let arRotateTimer    = null;
let arCountdownTimer = null;
let arSecondsLeft    = 0;
let arInterval       = 30;

function startAutoRotate(secs) {
  // Hentikan timer lama
  clearInterval(arRotateTimer);
  clearInterval(arCountdownTimer);

  arInterval    = Math.max(5, secs || 30);
  arSecondsLeft = arInterval;
  updateArStatus();

  arCountdownTimer = setInterval(() => {
    arSecondsLeft = Math.max(0, arSecondsLeft - 1);
    updateArStatus();
  }, 1000);

  arRotateTimer = setInterval(async () => {
    await vlcNext();
    arSecondsLeft = arInterval;
  }, arInterval * 1000);
}

function applyInterval() {
  const input = document.getElementById('ar-interval');
  const secs  = Math.max(5, parseInt(input.value) || 30);
  input.value = secs;
  startAutoRotate(secs);
  showToast(`Auto-rotate: ganti tiap ${secs} detik`);
}

function updateArStatus() {
  const statusEl = document.getElementById('ar-status');
  if (!statusEl) return;
  const m = Math.floor(arSecondsLeft / 60);
  const s = arSecondsLeft % 60;
  const timeStr = m > 0 ? `${m}m ${s}s` : `${s}s`;
  statusEl.innerHTML = `<i class="fas fa-circle-play"></i> Ganti dalam ${timeStr}`;
}

// ─── INIT ─────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  navigate('dashboard');
  setInterval(fetchVlcStatus, 3000);  // polling VLC tiap 3 detik
  startAutoRotate(30);                // auto-rotate langsung nyala
});