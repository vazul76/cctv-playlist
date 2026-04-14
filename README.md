# CCTV Dashboard

Aplikasi web ringan untuk mengelola playlist stream CCTV berbasis XSPF.

Fokus utama:
- Membuat dan mengatur playlist stream.
- Menyimpan urutan stream ke file XSPF.
- Download playlist XSPF kapan saja.
- Preview stream langsung di browser untuk pengecekan cepat.

## Fitur Utama

- Dashboard ringkas: total playlist dan total stream.
- Manajemen playlist: tambah, edit metadata, hapus.
- Manajemen stream per playlist:
    - Tambah stream
    - Edit judul dan URL inline
    - Hapus stream
    - Drag-and-drop urutan stream
    - Simpan semua perubahan sekaligus
- Import XSPF saat membuat playlist baru.
- Download XSPF per playlist.
- Play Preview stream di browser (HLS).
- Batasan preview global: hanya satu preview aktif dalam satu waktu lintas device/tab.

## Arsitektur Singkat

- Backend: Flask (`app.py`)
- Frontend: HTML + CSS + Vanilla JavaScript (`static/`)
- Penyimpanan metadata playlist: `playlists/_meta.json`
- Penyimpanan isi track playlist: file `*.xspf` di folder `playlists/`

## Struktur Project

```text
cctv-playlist/
├── app.py
├── requirements.txt
├── README.md
├── playlists/
│   ├── _meta.json
│   └── *.xspf
└── static/
        ├── index.html
        ├── css/
        │   └── style.css
        └── js/
                └── app.js
```

## Prasyarat

- Python 3.9+
- FFmpeg tersedia di PATH (wajib untuk fitur Play Preview)

Contoh cek FFmpeg:

```bash
ffmpeg -version
```

## Instalasi dan Menjalankan

1. Masuk ke folder project.

```bash
cd /root/cctv-playlist
```

2. (Opsional tapi direkomendasikan) Buat virtual environment.

```bash
python -m venv venv
source venv/bin/activate
```

3. Install dependency Python.

```bash
pip install -r requirements.txt
```

4. Jalankan server.

```bash
python app.py
```

5. Buka aplikasi di browser.

```text
http://localhost:3000
```

## Tutorial Penggunaan

1. Buat playlist baru
- Buka menu Playlist.
- Klik Tambah Playlist.
- Isi nama dan deskripsi (opsional), lalu Simpan.

2. Tambahkan stream
- Buka detail playlist.
- Klik Tambah Stream.
- Isi judul dan URL stream, lalu simpan.

3. Atur urutan stream
- Di halaman detail playlist, gunakan tombol drag pada kolom aksi.
- Pindahkan stream sesuai urutan yang diinginkan.

4. Edit cepat dan simpan
- Ubah judul playlist/deskripsi langsung di atas.
- Ubah judul/url stream langsung di tabel.
- Klik Simpan untuk menyimpan semua perubahan.

5. Cek stream lewat Play Preview
- Di baris stream, klik Play Preview.
- Modal preview akan tampil di browser.

Catatan preview:
- Hanya 1 preview aktif secara global.
- Jika preview dibuka dari device/tab lain, preview sebelumnya otomatis ditutup dan muncul notifikasi.

6. Download XSPF
- Kembali ke daftar playlist.
- Klik tombol Download XSPF pada playlist yang diinginkan.

## Format Track XSPF

Contoh track yang disimpan:

```xml
<track>
    <location>rtmp://host/app/stream</location>
    <title>Nama Kamera</title>
</track>
```

## Catatan Operasional

- URL stream bisa berasal dari `rtmp://`, `rtsp://`, atau `http(s)://` selama sumbernya valid.
- Jika preview gagal diputar:
    - pastikan URL stream bisa diakses dari server,
    - pastikan FFmpeg terpasang,
    - cek firewall/network ke sumber stream.
