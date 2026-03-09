import os
import json
import uuid
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

def xspf_path(playlist_id):
    meta = read_meta()
    pl   = next((p for p in meta if p['id'] == playlist_id), None)
    if pl:
        fname = pl.get('filename') or sanitize_filename(pl['name'])
        return os.path.join(PLAYLISTS_DIR, f'{fname}.xspf')
    return os.path.join(PLAYLISTS_DIR, f'{playlist_id}.xspf')

# ─── HELPER XSPF ─────────────────────────────────────────────

def build_xspf(playlist_name, tracks):
    """Buat string XML XSPF dari list tracks [{'title': ..., 'url': ...}]"""
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
            loc   = track.find('xspf:location', ns)
            title = track.find('xspf:title', ns)
            tracks.append({
                'url':   loc.text.strip()   if loc   is not None and loc.text   else '',
                'title': title.text.strip() if title is not None and title.text else '',
            })
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

@app.route('/<path:filename>')
def static_files(filename):
    return send_from_directory('static', filename)

# ─── API: PLAYLISTS ──────────────────────────────────────────

@app.route('/api/playlists', methods=['GET'])
def get_playlists():
    return jsonify(read_meta())

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
        'createdAt':   datetime.now().isoformat()
    }

    # Tulis meta dulu
    meta = read_meta()
    meta.append(new_pl)
    write_meta(meta)

    # Buat file XSPF dengan nama yang bersih
    with open(os.path.join(PLAYLISTS_DIR, f'{safe_name}.xspf'), 'w', encoding='utf-8') as f:
        f.write(build_xspf(name, []))

    return jsonify(new_pl), 201

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
    data  = request.get_json()
    title = (data.get('title') or '').strip()
    url   = (data.get('url')   or '').strip()

    if not title or not url:
        return jsonify({'error': 'Title dan URL wajib diisi'}), 400

    path = xspf_path(pl_id)
    if not os.path.exists(path):
        return jsonify({'error': 'Playlist tidak ditemukan'}), 404

    tracks = parse_xspf(path)
    tracks.append({'title': title, 'url': url})
    save_xspf(pl_id, tracks)
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

    tracks[index] = {
        'title': data.get('title', tracks[index]['title']),
        'url':   data.get('url',   tracks[index]['url']),
    }
    save_xspf(pl_id, tracks)
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
    return jsonify({'success': True, 'tracks': tracks})

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
        info = data.get('information', {}).get('category', {}).get('meta', {})
        return jsonify({
            'connected': True,
            'state':     data.get('state', 'stopped'),
            'title':     info.get('title') or info.get('filename') or '(tidak ada judul)',
            'time':      data.get('time', 0),
            'length':    data.get('length', 0),
            'volume':    data.get('volume', 0),
        })
    except Exception:
        return jsonify({
            'connected': False,
            'state':     'disconnected',
            'title':     '-',
            'time':      0,
            'length':    0,
            'volume':    0,
        })

# ─── API: VLC NEXT / PREV ───────────────────────────────────

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
    app.run(host='0.0.0.0', port=3000, debug=True)