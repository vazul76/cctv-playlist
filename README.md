# CCTV Dashboard

Dashboard monitoring dan kontrol stream CCTV berbasis Flask untuk mengelola playlist stream (XSPF) melalui VLC Media Player.

## Fitur Utama

- **Playlist Management**: CRUD playlist beserta track stream (Judul, URL, Durasi).
- **Import XSPF**: Import file playlist `.xspf` yang sudah ada langsung ke dashboard — nama playlist otomatis diambil dari nama file.
- **Durasi per Track**: Setiap stream bisa diset durasinya (detik). VLC akan otomatis pindah ke stream berikutnya saat durasi habis, tanpa perlu timer manual.
- **VLC Loop Otomatis**: Saat playlist di-load, VLC dikonfigurasi otomatis untuk loop (kembali ke awal setelah stream terakhir) dan menonaktifkan repeat per-track.
- **Live Info Stream**: Monitoring FPS, Resolusi, dan Codec langsung di halaman Dashboard.
- **Responsive Design**: Tampilan optimal di desktop (sidebar) maupun mobile (drawer menu).
- **CCTV Name Overlay**: Endpoint `/cctvName` untuk overlay nama CCTV di atas video player eksternal.

## Tech Stack

### Backend
- **Python 3.x**: Bahasa pemrograman utama.
- **Flask**: Micro-framework web server.
- **Requests**: Komunikasi HTTP ke VLC HTTP API.
- **XML ElementTree**: Parsing & generate file `.xspf`.

### Frontend
- **HTML5 & CSS3**: Struktur & modern light mode styling.
- **Vanilla JavaScript**: Logika SPA (Single Page Application).
- **Font Awesome 6.5.1**: Library icon.

### Media Engine
- **VLC Media Player**: Engine pemutar media via HTTP Lua API.

## Persyaratan

1. **Python 3.x** terinstal.
2. **VLC Media Player** dengan HTTP API aktif (lihat konfigurasi di bawah).
3. Install library Python:
   ```bash
   pip install -r requirements.txt
   ```

### Konfigurasi VLC HTTP API

1. Buka VLC → **Tools** → **Preferences**.
2. Di pojok kiri bawah, pilih **Show settings: All**.
3. **Interface** → **Main interfaces** → centang **Web (Lua HTTP)**.
4. **Main interfaces** → **Lua** → isi **Lua HTTP Password** (sesuaikan dengan `VLC_PASSWORD` di `app.py`, default: `password`).
5. Restart VLC.

> Koneksi VLC: `host` dan `port` juga bisa disesuaikan di bagian atas `app.py` (`VLC_HOST`, `VLC_PORT`).

## Cara Menjalankan

1. Pastikan VLC sudah berjalan dengan HTTP API aktif.
2. Jalankan server:
   ```bash
   python app.py
   ```
3. Akses dashboard di browser: `http://localhost:3000`

## Struktur Project

```
cctv-dashboard/
├── app.py                  # Backend Flask + VLC integration + REST API
├── requirements.txt
├── playlists/              # Menyimpan file .xspf dan _meta.json per playlist
└── static/
    ├── index.html          # Shell SPA
    ├── cctvName.html       # Overlay nama CCTV (akses via /cctvName)
    ├── css/style.css       # Styling + responsive rules
    └── js/app.js           # Logika frontend
```

## Cara Pakai

### Membuat Playlist Baru
1. Menu **Playlists** → klik **Tambah Playlist**.
2. Isi nama dan deskripsi, lalu klik **Simpan**.

### Import dari File XSPF
1. Menu **Playlists** → klik **Tambah Playlist**.
2. Klik **Import XSPF** → pilih file `.xspf`.
3. Nama playlist otomatis terisi dari nama file. Jika ada track tanpa judul, akan muncul peringatan dan nama diambil otomatis dari URL.
4. Klik **Simpan** untuk membuat playlist beserta semua track-nya sekaligus.

### Menambah / Mengedit Stream
- Buka detail playlist → klik **Tambah Stream** atau edit langsung di tabel.
- **Judul**: nama tampilan stream.
- **URL**: alamat RTMP / stream (contoh: `rtmp://host:port/live/nama`).
- **Durasi (detik)**: berapa lama VLC memutar stream ini sebelum pindah ke berikutnya. Default: 30 detik. Kosongkan jika stream tidak memiliki batas waktu (live stream manual).

### Format XSPF yang Didukung
```xml
<track>
    <location>rtmp://host:port/live/nama_stream</location>
    <title>Nama CCTV</title>
    <duration>30000</duration>  <!-- dalam milidetik -->
</track>
```
> Catatan: `<duration>` di XSPF menggunakan **milidetik**. Input durasi di dashboard menggunakan **detik** dan dikonversi otomatis.

### Load Playlist ke VLC
1. Menu **Playlists** → klik nama playlist → **Load ke VLC**.
2. VLC akan langsung memutar playlist tersebut dengan **loop otomatis aktif**.
3. VLC akan berpindah ke stream berikutnya otomatis sesuai durasi yang ditentukan.

### Indikator Koneksi VLC
- Titik hijau di pojok kiri bawah (desktop) atau kanan atas (mobile) menunjukkan VLC terhubung dan aktif.

## Ketentuan Durasi & Loop

| Kondisi | Perilaku VLC |
|---|---|
| Track punya `<duration>` | VLC otomatis pindah ke track berikutnya saat durasi habis |
| Track tanpa `<duration>` | VLC menunggu stream selesai sendiri (cocok untuk file VOD) |
| Sampai track terakhir | VLC kembali ke track pertama (loop aktif otomatis) |
| `repeat` per-track | Selalu dinonaktifkan saat load playlist |

---
*CCTV Dashboard v1.2 — Created by GitHub Vazul*
