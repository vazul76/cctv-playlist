# CCTV Dashboard (RTMP Playlist Builder)

Web ini dipakai untuk manajemen playlist stream CCTV dan output RTMP.
Konsep saat ini: fokus ke pembuatan playlist, bukan kontrol VLC.

## Fitur Utama

- Dashboard ringkas: total playlist, total stream, total playlist RTMP aktif.
- Playlist management: tambah, edit, hapus playlist.
- Track management: tambah, edit, hapus, drag-drop urutan stream per playlist.
- Durasi per stream (detik): tetap bisa diatur seperti sebelumnya.
- Play RTMP per playlist:
    - Pilih mode `Per Stream` atau `4 Channel`.
    - Link output otomatis dicopy ke clipboard:
        - `rtmp://jitv:jitv@103.255.15.138:1935/live/<nama_playlist>`
    - Status tombol berubah `Play RTMP` -> `Pause RTMP`.
- Validasi mode `4 Channel`:
    - Muncul peringatan jika jumlah stream bukan kelipatan 4.
- Download XSPF per playlist dari halaman Playlist.

## Struktur Project

```
cctv-dashboard/
├── app.py
├── requirements.txt
├── playlists/
│   ├── _meta.json
│   └── *.xspf
└── static/
        ├── index.html
        ├── css/style.css
        └── js/app.js
```

## Tutorial Awal Penerapan Perubahan

1. Install dependency Python.
```bash
pip install -r requirements.txt
```

2. Jalankan server Flask.
```bash
python app.py
```

3. Buka web di browser.
```text
http://localhost:3000
```

4. Buat playlist pertama:
- Masuk menu `Playlist`.
- Klik `Tambah Playlist`.
- Isi nama + deskripsi.

5. Isi stream per playlist:
- Klik nama playlist untuk masuk detail.
- Tambahkan stream dengan URL `rtmp://`, `rtsp://`, atau `http(s)://`.
- Set `Durasi (detik)` per stream sesuai kebutuhan.

6. Uji output RTMP:
- Kembali ke halaman Playlist.
- Klik `Play RTMP`.
- Pilih `Per Stream` atau `4 Channel`.
- Link output otomatis tersalin ke clipboard.

7. Download XSPF bila diperlukan:
- Klik `Download xspf` pada baris playlist.

## Catatan Integrasi FFmpeg (Quad 4-Channel)

Script FFmpeg gabungan 4 input seperti contoh kamu tetap kompatibel dengan alur dashboard ini.
Dashboard dipakai untuk menyusun daftar stream + durasi, lalu output RTMP dipakai di pipeline ingest/transcode kamu.

## Format Track XSPF

```xml
<track>
    <location>rtmp://host/app/stream</location>
    <title>Nama Kamera</title>
    <duration>30000</duration>
</track>
```

`duration` disimpan dalam milidetik di XSPF, input UI tetap dalam detik.
