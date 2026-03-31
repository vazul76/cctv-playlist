import os
import json
import uuid
import time
import requests
from datetime import datetime
from xml.etree import ElementTree as ET
from flask import Flask, jsonify, request, send_from_directory, abort
from flask_cors import CORS

app = Flask(__name__, static_folder='static')
CORS(app)

# ─── KONFIGURASI ─────────────────────────────────────────────
VLC_URL      = 'http://localhost:8080'
VLC_PASSWORD = 'dentri'          # sesuaikan password VLC kamu
VLC_AUTH     = ('', VLC_PASSWORD)

PLAYLISTS_DIR = os.path.join(os.path.dirname(__file__), 'playlists')
META_FILE     = os.path.join(PLAYLISTS_DIR, '_meta.json')

os.makedirs(PLAYLISTS_DIR, exist_ok=True)

# ─── HELPER METADATA ─────────────────────────────────────────

def read_meta():
    if not os.path.exists(META_FILE):
        return []
    # Kalau file kosong / 0 byte, kembalikan list kosong
    if os.path.getsize(META_FILE) == 0:
        return []
    try:
        with open(META_FILE, 'r', encoding='utf-8') as f:
            return json.load(f)
    except (json.JSONDecodeError, ValueError):
        # File corrupt / isi invalid → reset
        return []

def write_meta(data):
    with open(META_FILE, 'w', encoding='utf-8') as f:
        json.dump(data, f, indent=2, ensure_ascii=False)

def update_playlist_timestamp(pl_id):
    """Update the updatedAt field of a playlist to current time"""
    meta = read_meta()
    pl = next((p for p in meta if p['id'] == pl_id), None)
    if pl:
        pl['updatedAt'] = datetime.now().isoformat()
        write_meta(meta)

def xspf_path(playlist_id):
    meta = read_meta()
    pl   = next((p for p in meta if p['id'] == playlist_id), None)
    if pl:
        fname = pl.get('filename') or sanitize_filename(pl['name'])
        return os.path.join(PLAYLISTS_DIR, f'{fname}.xspf')
    return os.path.join(PLAYLISTS_DIR, f'{playlist_id}.xspf')

# ─── HELPER XSPF ─────────────────────────────────────────────

def build_xspf(playlist_name, tracks):
    """Buat string XML XSPF dari list tracks [{'title': ..., 'url': ..., 'duration': ...}]"""
    lines = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<playlist version="1" xmlns="http://xspf.org/ns/0/" xmlns:vlc="http://www.videolan.org/vlc/playlist/0">',
        f'  <title>{_esc(playlist_name)}</title>',
        '  <trackList>',
    ]
    for i, t in enumerate(tracks):
        lines += [
            '    <track>',
            f'      <location>{_esc(t.get("url", ""))}</location>',
            f'      <title>{_esc(t.get("title", ""))}</title>',
        ]
        if t.get('duration') is not None:
            lines.append(f'      <duration>{int(t["duration"])}</duration>')
        lines += [
            '      <extension application="http://www.videolan.org/vlc/playlist/0">',
            f'        <vlc:id>{i}</vlc:id>',
            '      </extension>',
            '    </track>',
        ]
    lines += ['  </trackList>', '</playlist>']
    return '\n'.join(lines)

def parse_xspf(file_path):
    """Baca file XSPF, return list [{'title': ..., 'url': ...}]"""
    if not os.path.exists(file_path):
        return []
    try:
        tree = ET.parse(file_path)
        root = tree.getroot()
        ns = {'xspf': 'http://xspf.org/ns/0/'}
        tracks = []
        for track in root.findall('.//xspf:track', ns):
            loc      = track.find('xspf:location', ns)
            title    = track.find('xspf:title', ns)
            duration = track.find('xspf:duration', ns)
            t = {
                'url':   loc.text.strip()   if loc   is not None and loc.text   else '',
                'title': title.text.strip() if title is not None and title.text else '',
            }
            if duration is not None and duration.text:
                try:
                    t['duration'] = int(duration.text.strip())
                except ValueError:
                    pass
            tracks.append(t)
        return tracks
    except Exception:
        return []

def save_xspf(playlist_id, tracks):
    meta   = next((p for p in read_meta() if p['id'] == playlist_id), {})
    name   = meta.get('name', playlist_id)
    content = build_xspf(name, tracks)
    with open(xspf_path(playlist_id), 'w', encoding='utf-8') as f:
        f.write(content)

def _esc(s):
    return (str(s)
        .replace('&', '&amp;')
        .replace('<', '&lt;')
        .replace('>', '&gt;')
        .replace('"', '&quot;'))
    
def sanitize_filename(name):
    """Bersihkan nama playlist jadi nama file yang aman di Windows"""
    import re
    # Hapus karakter yang tidak boleh ada di nama file Windows
    name = re.sub(r'[\\/*?:"<>|]', '', name)
    # Ganti spasi dengan underscore
    name = name.replace(' ', '_')
    # Trim titik dan spasi di ujung (Windows tidak suka)
    name = name.strip('. ')
    # Batasi panjang nama file
    return name[:60] if name else 'playlist'

# ─── HELPER VLC ───────────────────────────────────────────────

def vlc_get(command_params):
    """Kirim command ke VLC HTTP API"""
    url = f'{VLC_URL}/requests/status.json'
    return requests.get(url, params=command_params, auth=VLC_AUTH, timeout=3)

# ─── ROUTES: STATIC ──────────────────────────────────────────

@app.route('/')
def index():
    return send_from_directory('static', 'index.html')

@app.route('/cctvName')
def cctv_name_overlay():
    return send_from_directory('static', 'cctvName.html')

@app.route('/<path:filename>')
def static_files(filename):
    # File statis (punya ekstensi) → serve langsung dari folder static
    if '.' in filename.split('/')[-1]:
        return send_from_directory('static', filename)
    # SPA route (misal /playlists, /2f3fd123) → serve index.html
    return send_from_directory('static', 'index.html')

# ─── API: PLAYLISTS ──────────────────────────────────────────

@app.route('/api/playlists', methods=['GET'])
def get_playlists():
    playlists = read_meta()
    for p in playlists:
        try:
            p['track_count'] = len(parse_xspf(xspf_path(p['id'])))
        except Exception:
            p['track_count'] = 0
    return jsonify(playlists)

@app.route('/api/playlists', methods=['POST'])
def create_playlist():
    data = request.get_json()
    name = (data.get('name') or '').strip()
    desc = (data.get('description') or '').strip()

    if not name:
        return jsonify({'error': 'Nama playlist wajib diisi'}), 400

    short_id  = str(uuid.uuid4()).split('-')[0]
    safe_name = sanitize_filename(name)

    # Kalau nama file sudah ada, tambahkan ID pendek di belakang
    target_path = os.path.join(PLAYLISTS_DIR, f'{safe_name}.xspf')
    if os.path.exists(target_path):
        safe_name = f'{safe_name}_{short_id}'

    new_pl = {
        'id':          short_id,
        'name':        name,
        'filename':    safe_name,       # ← simpan nama file di meta
        'description': desc,
        'createdAt':   datetime.now().isoformat(),
        'updatedAt':   None
    }

    # Tulis meta dulu
    meta = read_meta()
    meta.append(new_pl)
    write_meta(meta)

    # Buat file XSPF dengan nama yang bersih
    with open(os.path.join(PLAYLISTS_DIR, f'{safe_name}.xspf'), 'w', encoding='utf-8') as f:
        f.write(build_xspf(name, []))

    return jsonify(new_pl), 201

@app.route('/api/playlists/<pl_id>', methods=['PUT'])
def update_playlist(pl_id):
    data = request.get_json() or {}
    name = (data.get('name') or '').strip()
    desc = (data.get('description') or '').strip()

    if not name:
        return jsonify({'error': 'Nama playlist wajib diisi'}), 400

    meta = read_meta()
    pl   = next((p for p in meta if p['id'] == pl_id), None)
    if not pl:
        return jsonify({'error': 'Playlist tidak ditemukan'}), 404

    pl['name']        = name
    pl['description'] = desc
    pl['updatedAt']   = datetime.now().isoformat()
    write_meta(meta)
    return jsonify(pl)

@app.route('/api/playlists/<pl_id>', methods=['DELETE'])
def delete_playlist(pl_id):
    path = xspf_path(pl_id)
    if os.path.exists(path):
        os.remove(path)

    meta = [p for p in read_meta() if p['id'] != pl_id]
    write_meta(meta)
    return jsonify({'success': True})

# ─── API: TRACKS ─────────────────────────────────────────────

@app.route('/api/playlists/<pl_id>/tracks', methods=['GET'])
def get_tracks(pl_id):
    path = xspf_path(pl_id)
    if not os.path.exists(path):
        return jsonify({'error': 'Playlist tidak ditemukan'}), 404
    return jsonify(parse_xspf(path))

@app.route('/api/playlists/<pl_id>/tracks', methods=['POST'])
def add_track(pl_id):
    data     = request.get_json()
    title    = (data.get('title') or '').strip()
    url      = (data.get('url')   or '').strip()
    duration = data.get('duration')

    if not title or not url:
        return jsonify({'error': 'Title dan URL wajib diisi'}), 400

    path = xspf_path(pl_id)
    if not os.path.exists(path):
        return jsonify({'error': 'Playlist tidak ditemukan'}), 404

    tracks = parse_xspf(path)
    track  = {'title': title, 'url': url}
    if duration is not None:
        try:
            track['duration'] = int(duration)
        except (ValueError, TypeError):
            pass
    tracks.append(track)
    save_xspf(pl_id, tracks)
    update_playlist_timestamp(pl_id)
    return jsonify({'success': True, 'tracks': tracks}), 201

@app.route('/api/playlists/<pl_id>/tracks/<int:index>', methods=['PUT'])
def update_track(pl_id, index):
    data  = request.get_json()
    path  = xspf_path(pl_id)

    if not os.path.exists(path):
        return jsonify({'error': 'Playlist tidak ditemukan'}), 404

    tracks = parse_xspf(path)
    if index < 0 or index >= len(tracks):
        return jsonify({'error': 'Index tidak valid'}), 404

    existing = tracks[index]
    updated  = {
        'title': data.get('title', existing['title']),
        'url':   data.get('url',   existing['url']),
    }
    if 'duration' in data:
        if data['duration'] is not None:
            try:
                val = int(data['duration'])
                if val > 0:
                    updated['duration'] = val
            except (ValueError, TypeError):
                pass
        # duration: null → tidak disimpan (hapus durasi)
    elif existing.get('duration') is not None:
        updated['duration'] = existing['duration']  # preserve

    tracks[index] = updated
    save_xspf(pl_id, tracks)
    update_playlist_timestamp(pl_id)
    return jsonify({'success': True, 'tracks': tracks})

@app.route('/api/playlists/<pl_id>/tracks/<int:index>', methods=['DELETE'])
def delete_track(pl_id, index):
    path = xspf_path(pl_id)

    if not os.path.exists(path):
        return jsonify({'error': 'Playlist tidak ditemukan'}), 404

    tracks = parse_xspf(path)
    if index < 0 or index >= len(tracks):
        return jsonify({'error': 'Index tidak valid'}), 404

    tracks.pop(index)
    save_xspf(pl_id, tracks)
    update_playlist_timestamp(pl_id)
    return jsonify({'success': True, 'tracks': tracks})

@app.route('/api/playlists/<pl_id>/tracks/bulk', methods=['POST'])
def bulk_add_tracks(pl_id):
    path = xspf_path(pl_id)
    if not os.path.exists(path):
        return jsonify({'error': 'Playlist tidak ditemukan'}), 404

    data       = request.get_json()
    new_tracks = data.get('tracks', [])

    tracks = parse_xspf(path)
    for t in new_tracks:
        url   = (t.get('url')   or '').strip()
        title = (t.get('title') or '').strip()
        if not url:
            continue
        track = {'title': title, 'url': url}
        if t.get('duration') is not None:
            try:
                track['duration'] = int(t['duration'])
            except (ValueError, TypeError):
                pass
        tracks.append(track)

    save_xspf(pl_id, tracks)
    update_playlist_timestamp(pl_id)
    return jsonify({'success': True, 'count': len(tracks)})

@app.route('/api/playlists/<pl_id>/tracks/move', methods=['POST'])
def move_track(pl_id):
    data     = request.get_json() or {}
    from_idx = data.get('from')
    to_idx   = data.get('to')

    if from_idx is None or to_idx is None:
        return jsonify({'error': 'from dan to wajib diisi'}), 400

    path = xspf_path(pl_id)
    if not os.path.exists(path):
        return jsonify({'error': 'Playlist tidak ditemukan'}), 404

    tracks = parse_xspf(path)
    n = len(tracks)
    if not (0 <= from_idx < n and 0 <= to_idx < n) or from_idx == to_idx:
        return jsonify({'error': 'Index tidak valid'}), 400

    tracks.insert(to_idx, tracks.pop(from_idx))
    save_xspf(pl_id, tracks)
    update_playlist_timestamp(pl_id)
    return jsonify({'success': True})

# ─── API: LOAD KE VLC ────────────────────────────────────────

@app.route('/api/playlists/<pl_id>/load-vlc', methods=['POST'])
def load_vlc(pl_id):
    path = xspf_path(pl_id)
    if not os.path.exists(path):
        return jsonify({'error': 'File tidak ditemukan'}), 404

    try:
        # Windows path → pakai forward slash + encode
        abs_path = os.path.abspath(path).replace('\\', '/')
        file_uri = f'file:///{abs_path}'

        vlc_get({'command': 'pl_empty'})
        vlc_get({'command': 'in_play', 'input': file_uri})

        # Pastikan playlist loop aktif, repeat per-track mati
        time.sleep(0.6)
        status = requests.get(f'{VLC_URL}/requests/status.json', auth=VLC_AUTH, timeout=3).json()
        if not status.get('loop', False):
            vlc_get({'command': 'pl_loop'})    # nyalakan playlist loop
        if status.get('repeat', False):
            vlc_get({'command': 'pl_repeat'})  # matikan repeat track

        return jsonify({'success': True, 'message': 'Playlist berhasil di-load ke VLC!'})
    except requests.exceptions.ConnectionError:
        return jsonify({'error': 'Gagal konek ke VLC. Pastikan VLC HTTP API sudah aktif!'}), 503
    except Exception as e:
        return jsonify({'error': str(e)}), 500

# ─── API: VLC STATUS ─────────────────────────────────────────

@app.route('/api/vlc/status', methods=['GET'])
def vlc_status():
    try:
        r    = requests.get(f'{VLC_URL}/requests/status.json', auth=VLC_AUTH, timeout=3)
        data = r.json()
        categories = data.get('information', {}).get('category', {})
        meta = categories.get('meta', {})

        fps = resolution = codec = None
        for val in categories.values():
            if not isinstance(val, dict):
                continue
            if val.get('Type') == 'Video':
                fps        = val.get('Frame_rate') or val.get('Frame rate')
                resolution = val.get('Video_resolution') or val.get('Video Resolution')
                raw_codec  = val.get('Codec', '')
                # ambil nama pendek dalam kurung, misal "H264 - MPEG-4 AVC (avc1)" → "avc1"
                if '(' in raw_codec:
                    codec = raw_codec.split('(')[-1].rstrip(')').strip()
                else:
                    codec = raw_codec or None

        return jsonify({
            'connected':  True,
            'state':      data.get('state', 'stopped'),
            'title':      meta.get('title') or meta.get('filename') or '(tidak ada yang diputar)',
            'time':       data.get('time', 0),
            'length':     data.get('length', 0),
            'fullscreen': bool(data.get('fullscreen', False)),
            'fps':        fps,
            'resolution': resolution,
            'codec':      codec,
        })
    except Exception:
        return jsonify({
            'connected':   False,
            'state':       'disconnected',
            'title':       '-',
            'time':        0,
            'length':      0,
            'fps':        None,
            'resolution': None,
            'codec':      None,
        })

# ─── API: VLC NEXT / PREV ───────────────────────────────────

@app.route('/api/vlc/fullscreen', methods=['POST'])
def vlc_fullscreen():
    try:
        vlc_get({'command': 'fullscreen'})
        return jsonify({'success': True})
    except requests.exceptions.ConnectionError:
        return jsonify({'error': 'Gagal konek ke VLC'}), 503
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@app.route('/api/vlc/next', methods=['POST'])
def vlc_next():
    try:
        vlc_get({'command': 'pl_next'})
        return jsonify({'success': True})
    except requests.exceptions.ConnectionError:
        return jsonify({'error': 'Gagal konek ke VLC'}), 503
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@app.route('/api/vlc/prev', methods=['POST'])
def vlc_prev():
    try:
        vlc_get({'command': 'pl_prev'})
        return jsonify({'success': True})
    except requests.exceptions.ConnectionError:
        return jsonify({'error': 'Gagal konek ke VLC'}), 503
    except Exception as e:
        return jsonify({'error': str(e)}), 500

# ─── MAIN ─────────────────────────────────────────────────────

if __name__ == '__main__':
    print('✅ CCTV Dashboard running at http://localhost:3000')
    app.run(host='0.0.0.0', port=3000, debug=True, use_reloader=False)