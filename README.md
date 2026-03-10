# CCTV Dashboard

Dashboard monitoring dan kontrol stream CCTV berbasis Flask untuk mengelola playlist stream (XSPF) melalui VLC Media Player.

## 🚀 Fitur Utama

- **Auto-Rotate Stream**: Ganti stream secara otomatis sesuai interval (looping aktif).
- **Playlist Management**: CRUD (Create, Read, Update, Delete) playlist dan track stream.
- **Custom Modals**: Sistem konfirmasi aman untuk tindakan krusial.
- **Live Info Stream**: Monitoring FPS, Resolusi, dan Codec langsung di Dashboard.
- **Responsive Design**: Tampilan optimal di desktop (sidebar) maupun mobile (drawer menu).

## 🛠️ Tech Stack

### Backend
- **Python 3.13+**: Bahasa pemrograman utama.
- **Flask**: Micro-framework web server.
- **Requests**: Library untuk komunikasi HTTP ke VLC API.
- **XML ElementTree**: Parsing file `.xspf` (standard playlist VLC).

### Frontend
- **HTML5 & CSS3**: Struktur & modern light mode styling.
- **Vanilla JavaScript**: Logika aplikasi Single-Page Application (SPA).
- **Font Awesome 6.5.1**: Library icon profesional.
- **Google Fonts**: Inter/Segoe UI typography.

### Media Engine
- **VLC Media Player**: Engine pemutar media utama via HTTP Lua API.

## 📋 Persyaratan (Requirements)

1. **Python 3.x** terinstal.
2. **VLC Media Player** (HTTP API harus aktif).
3. Library Python (jalankan `pip install -r requirements.txt`):
   - `flask`
   - `requests`
   - `flask-cors`

### Konfigurasi VLC HTTP API
Agar dashboard bisa mengontrol VLC:
1. Buka VLC → Menu **Tools** → **Preferences**.
2. Di pojok kiri bawah, pilih **Show settings: All**.
3. Cari **Interface** → **Main interfaces**. Centang **Web (Lua HTTP)**.
4. Klik **Main interfaces** → **Lua**. Isi **Lua HTTP Password** (sesuaikan di `app.py`, default: `password`).
5. Restart VLC.

## 🏃 Cara Menjalankan

1. Ekstrak project ke folder lokal.
2. Buka terminal di folder tersebut, install dependensi:
   ```bash
   pip install -r requirements.txt
   ```
3. Pastikan VLC sedang berjalan (dengan pengaturan di atas).
4. Jalankan aplikasi:
   ```bash
   python app.py
   ```
5. Akses dashboard di browser: `http://localhost:3000`

## 📂 Struktur Project

- `app.py`: Backend Flask & VLC Integration.
- `playlists/`: Penyimpanan file `.xspf` dan `_meta.json`.
- `static/`: Frontend (HTML, CSS, JS).
  - `index.html`: Shell SPA (Single Page Application).
  - `css/style.css`: Styling & Responsive Rules.
  - `js/app.js`: Logika frontend & Update realtime.

## 💡 Tips Penggunaan

- **Load ke VLC**: Masuk ke menu **Playlists** → Klik salah satu nama playlist → Tombol **Load ke VLC**. Dashboard akan mulai memutar playlist tersebut.
- **Interval Rotate**: Bisa diubah di menu **Pengaturan**. Dashboard akan mengirim perintah `Next` ke VLC setiap interval habis.
- **Indikator VLC**: Perhatikan titik hijau di pojok kiri bawah (Desktop) atau pojok kanan atas (Mobile) untuk memastikan koneksi ke VLC aktif.

---
*Created by GitHub Vazul — CCTV Dashboard v1.1*
