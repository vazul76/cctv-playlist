import os
import json
import uuid
import shutil
import subprocess
import tempfile
import threading
import time
from datetime import datetime
from xml.etree import ElementTree as ET
from flask import Flask, jsonify, request, send_from_directory, send_file
from flask_cors import CORS

app = Flask(__name__, static_folder='static')
CORS(app)

PLAYLISTS_DIR = os.path.join(os.path.dirname(__file__), 'playlists')
META_FILE     = os.path.join(PLAYLISTS_DIR, '_meta.json')
FFMPEG_BIN    = os.environ.get('FFMPEG_BIN') or shutil.which('ffmpeg') or 'ffmpeg'

META_LOCK = threading.RLock()
HLS_PREVIEW_LOCK = threading.RLock()
HLS_PREVIEW_SESSIONS = {}
ACTIVE_PREVIEW = {'sessionId': None, 'clientId': None}
PREVIEW_EVENTS = {}

os.makedirs(PLAYLISTS_DIR, exist_ok=True)

# ─── HELPER METADATA ─────────────────────────────────────────

def read_meta():
    with META_LOCK:
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
    with META_LOCK:
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

def get_playlist_by_id(playlist_id):
    return next((p for p in read_meta() if p['id'] == playlist_id), None)

def _terminate_process(process, timeout=5):
    if process is None:
        return
    if process.poll() is not None:
        return
    try:
        process.terminate()
        process.wait(timeout=timeout)
    except Exception:
        try:
            process.kill()
        except Exception:
            pass

def _cleanup_hls_preview_session(session_id):
    with HLS_PREVIEW_LOCK:
        session = HLS_PREVIEW_SESSIONS.pop(session_id, None)
        if ACTIVE_PREVIEW.get('sessionId') == session_id:
            ACTIVE_PREVIEW['sessionId'] = None
            ACTIVE_PREVIEW['clientId'] = None

    if not session:
        return

    process = session.get('process')
    temp_dir = session.get('tempDir')
    _terminate_process(process)

    if temp_dir and os.path.exists(temp_dir):
        try:
            shutil.rmtree(temp_dir, ignore_errors=True)
        except Exception:
            pass

def _queue_preview_event(client_id, event_type, message):
    if not client_id:
        return
    with HLS_PREVIEW_LOCK:
        queue = PREVIEW_EVENTS.setdefault(client_id, [])
        queue.append({
            'type': event_type,
            'message': message,
            'at': datetime.now().isoformat(),
        })
        if len(queue) > 20:
            del queue[:-20]

def _pop_preview_events(client_id):
    if not client_id:
        return []
    with HLS_PREVIEW_LOCK:
        return PREVIEW_EVENTS.pop(client_id, [])

def _build_hls_preview_command(input_url, output_dir):
    playlist_path = os.path.join(output_dir, 'index.m3u8')
    segment_pattern = os.path.join(output_dir, 'segment_%05d.ts')
    return [
        FFMPEG_BIN,
        '-hide_banner',
        '-loglevel', 'error',
        '-thread_queue_size', '1024',
        '-rw_timeout', '15000000',
        '-fflags', '+discardcorrupt',
        '-err_detect', 'ignore_err',
        '-re',
        '-i', input_url,
        '-an',
        '-vf', 'fps=15,scale=854:480:force_original_aspect_ratio=decrease,pad=854:480:(ow-iw)/2:(oh-ih)/2,setsar=1,format=yuv420p',
        '-c:v', 'libx264',
        '-tune', 'zerolatency',
        '-preset', 'veryfast',
        '-profile:v', 'baseline',
        '-level', '3.0',
        '-pix_fmt', 'yuv420p',
        '-g', '30',
        '-keyint_min', '30',
        '-sc_threshold', '0',
        '-f', 'hls',
        '-hls_time', '2',
        '-hls_list_size', '6',
        '-hls_flags', 'delete_segments+append_list+independent_segments+omit_endlist',
        '-hls_segment_filename', segment_pattern,
        playlist_path,
    ]

def _create_hls_preview_session(playlist_id, track_index, client_id):
    path = xspf_path(playlist_id)
    if not os.path.exists(path):
        return None, 'Playlist tidak ditemukan'

    tracks = parse_xspf(path)
    if track_index < 0 or track_index >= len(tracks):
        return None, 'Index stream tidak valid'

    track = tracks[track_index]
    source_url = (track.get('url') or '').strip()
    if not source_url:
        return None, 'URL stream kosong'

    previous_session_id = None
    previous_client_id = None
    with HLS_PREVIEW_LOCK:
        previous_session_id = ACTIVE_PREVIEW.get('sessionId')
        previous_client_id = ACTIVE_PREVIEW.get('clientId')

    if previous_session_id:
        _cleanup_hls_preview_session(previous_session_id)
        if previous_client_id and previous_client_id != client_id:
            _queue_preview_event(
                previous_client_id,
                'preview_taken_over',
                'Preview sedang dijalankan di device lain.',
            )

    session_id = uuid.uuid4().hex
    temp_dir = tempfile.mkdtemp(prefix=f'cctv-hls-{playlist_id}-{track_index}-')
    command = _build_hls_preview_command(source_url, temp_dir)

    process = subprocess.Popen(
        command,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        text=True,
        bufsize=1,
    )

    with HLS_PREVIEW_LOCK:
        HLS_PREVIEW_SESSIONS[session_id] = {
            'process': process,
            'tempDir': temp_dir,
            'playlistId': playlist_id,
            'trackIndex': track_index,
            'sourceUrl': source_url,
            'title': track.get('title') or f'Stream {track_index + 1}',
            'startedAt': datetime.now().isoformat(),
            'clientId': client_id,
        }
        ACTIVE_PREVIEW['sessionId'] = session_id
        ACTIVE_PREVIEW['clientId'] = client_id

    return {
        'sessionId': session_id,
        'manifestUrl': f'/api/hls-preview/{session_id}/index.m3u8',
        'title': track.get('title') or f'Stream {track_index + 1}',
        'sourceUrl': source_url,
    }, None

def _get_hls_preview_session(session_id):
    with HLS_PREVIEW_LOCK:
        return HLS_PREVIEW_SESSIONS.get(session_id)

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
            loc      = track.find('xspf:location', ns)
            title    = track.find('xspf:title', ns)
            t = {
                'url':   loc.text.strip()   if loc   is not None and loc.text   else '',
                'title': title.text.strip() if title is not None and title.text else '',
            }
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

# ─── ROUTES: STATIC ──────────────────────────────────────────

@app.route('/')
def index():
    return send_from_directory('static', 'index.html')

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
    meta_dirty = False
    for p in playlists:
        # Bersihkan field legacy RTMP dari versi sebelumnya
        for legacy_key in ('rtmpStatus', 'rtmpRunning', 'rtmpMode', 'rtmpRotateDelaySeconds', 'rtmpLastError'):
            if legacy_key in p:
                p.pop(legacy_key, None)
                meta_dirty = True
        try:
            p['track_count'] = len(parse_xspf(xspf_path(p['id'])))
        except Exception:
            p['track_count'] = 0
    if meta_dirty:
        write_meta(playlists)
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

@app.route('/api/playlists/<pl_id>/download', methods=['GET'])
def download_playlist_xspf(pl_id):
    path = xspf_path(pl_id)
    if not os.path.exists(path):
        return jsonify({'error': 'Playlist tidak ditemukan'}), 404

    meta = read_meta()
    pl = next((p for p in meta if p['id'] == pl_id), None)
    filename = f"{sanitize_filename(pl['name']) if pl else pl_id}.xspf"
    return send_file(path, as_attachment=True, download_name=filename)

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

    if not title or not url:
        return jsonify({'error': 'Title dan URL wajib diisi'}), 400

    path = xspf_path(pl_id)
    if not os.path.exists(path):
        return jsonify({'error': 'Playlist tidak ditemukan'}), 404

    tracks = parse_xspf(path)
    track  = {'title': title, 'url': url}
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
        tracks.append(track)

    save_xspf(pl_id, tracks)
    update_playlist_timestamp(pl_id)
    return jsonify({'success': True, 'count': len(tracks)})

@app.route('/api/playlists/<pl_id>/tracks/<int:index>/preview/start', methods=['POST'])
def start_track_preview(pl_id, index):
    data = request.get_json(silent=True) or {}
    client_id = (data.get('clientId') or '').strip() or 'anonymous'
    preview, error = _create_hls_preview_session(pl_id, index, client_id)
    if error:
        return jsonify({'error': error}), 400
    return jsonify(preview)

@app.route('/api/preview/events', methods=['GET'])
def get_preview_events():
    client_id = (request.args.get('clientId') or '').strip()
    return jsonify({'events': _pop_preview_events(client_id)})

@app.route('/api/preview/active', methods=['GET'])
def get_active_preview():
    with HLS_PREVIEW_LOCK:
        session_id = ACTIVE_PREVIEW.get('sessionId')
        client_id = ACTIVE_PREVIEW.get('clientId')
    return jsonify({
        'sessionId': session_id,
        'clientId': client_id,
    })

@app.route('/api/hls-preview/<session_id>/stop', methods=['POST'])
def stop_hls_preview(session_id):
    _cleanup_hls_preview_session(session_id)
    return jsonify({'success': True})

@app.route('/api/hls-preview/<session_id>/<path:filename>', methods=['GET'])
def serve_hls_preview_file(session_id, filename):
    session = _get_hls_preview_session(session_id)
    if not session:
        return jsonify({'error': 'Preview session tidak ditemukan'}), 404

    temp_dir = session.get('tempDir')
    if not temp_dir or not os.path.exists(temp_dir):
        return jsonify({'error': 'Preview directory tidak ditemukan'}), 404

    file_path = os.path.join(temp_dir, filename)
    if not os.path.exists(file_path):
        if filename.endswith('.m3u8'):
            deadline = time.monotonic() + 5
            while time.monotonic() < deadline and not os.path.exists(file_path):
                process = session.get('process')
                if process and process.poll() is not None:
                    break
                time.sleep(0.2)

        if not os.path.exists(file_path):
            return jsonify({'error': 'File preview belum siap'}), 404

    response = send_from_directory(temp_dir, filename)
    response.headers['Cache-Control'] = 'no-store, no-cache, must-revalidate, max-age=0'
    response.headers['Pragma'] = 'no-cache'
    response.headers['Expires'] = '0'
    return response

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

# ─── MAIN ─────────────────────────────────────────────────────

if __name__ == '__main__':
    print('✅ CCTV Dashboard running at http://localhost:3000')
    app.run(host='0.0.0.0', port=3000, debug=True, use_reloader=False)