import os
import json
import uuid
import shutil
import signal
import subprocess
import threading
import time
from datetime import datetime
from xml.etree import ElementTree as ET
from flask import Flask, jsonify, request, send_from_directory, send_file, Response
from flask_cors import CORS

app = Flask(__name__, static_folder='static')
CORS(app)

PLAYLISTS_DIR = os.path.join(os.path.dirname(__file__), 'playlists')
META_FILE     = os.path.join(PLAYLISTS_DIR, '_meta.json')
FFMPEG_BIN    = os.environ.get('FFMPEG_BIN') or shutil.which('ffmpeg') or 'ffmpeg'
RTMP_PUBLISH_TEMPLATE = os.environ.get(
    'RTMP_PUBLISH_TEMPLATE',
    'rtmp://jitv:jitv@103.255.15.138:1935/live/{playlist}'
)
RTMP_PLAYBACK_TEMPLATE = os.environ.get(
    'RTMP_PLAYBACK_TEMPLATE',
    'rtmp://103.255.15.138:1935/live/{playlist}'
)
RTMP_RELAY_SUFFIX = os.environ.get('RTMP_RELAY_SUFFIX', '')
DEFAULT_ROTATE_DELAY = int(os.environ.get('RTMP_ROTATE_DELAY_SECONDS', '30'))

META_LOCK = threading.RLock()
RTMP_LOCK = threading.RLock()
RTMP_SESSIONS = {}

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

def playlist_stream_key(playlist_name):
    return sanitize_filename(playlist_name)

def playlist_publish_key(playlist_name):
    key = playlist_stream_key(playlist_name)
    if RTMP_RELAY_SUFFIX:
        return f'{key}{RTMP_RELAY_SUFFIX}'
    return key

def playlist_publish_url(playlist_name):
    return RTMP_PUBLISH_TEMPLATE.format(playlist=playlist_publish_key(playlist_name))

def playlist_playback_url(playlist_name):
    return RTMP_PLAYBACK_TEMPLATE.format(playlist=playlist_stream_key(playlist_name))

def get_playlist_by_id(playlist_id):
    return next((p for p in read_meta() if p['id'] == playlist_id), None)

def set_playlist_status(playlist_id, status):
    meta = read_meta()
    playlist = next((p for p in meta if p['id'] == playlist_id), None)
    if not playlist:
        return None
    playlist['rtmpStatus'] = status
    playlist['updatedAt'] = datetime.now().isoformat()
    write_meta(meta)
    return playlist

def session_snapshot(playlist_id):
    with RTMP_LOCK:
        session = RTMP_SESSIONS.get(playlist_id)
        if not session:
            return {
                'running': False,
                'mode': None,
                'rotateDelaySeconds': None,
                'pid': None,
                'outputUrl': None,
                'lastError': None,
            }

        process = session.get('process')
        running = bool(process and process.poll() is None)
        return {
            'running': running,
            'mode': session.get('mode'),
            'rotateDelaySeconds': session.get('rotateDelaySeconds'),
            'pid': process.pid if running else None,
            'outputUrl': session.get('outputUrl'),
            'playbackUrl': session.get('playbackUrl'),
            'lastError': session.get('lastError'),
            'startedAt': session.get('startedAt'),
        }

def _terminate_process(process, timeout=5):
    if process is None:
        return
    if process.poll() is not None:
        return

    try:
        if process.stdin:
            try:
                process.stdin.write('q\n')
                process.stdin.flush()
            except Exception:
                pass

        if os.name == 'nt':
            process.terminate()
        else:
            process.send_signal(signal.SIGTERM)
        process.wait(timeout=timeout)
    except Exception:
        try:
            process.kill()
        except Exception:
            pass

def _build_single_cycle_command(tracks, output_url, rotate_delay_seconds):
    prepared = []
    for idx, track in enumerate(tracks):
        input_url = (track.get('url') or '').strip()
        if not input_url:
            raise RuntimeError(f'Track ke-{idx + 1} tidak memiliki URL')

        track_duration_ms = track.get('duration')
        try:
            track_duration_ms = int(track_duration_ms) if track_duration_ms is not None else None
        except (TypeError, ValueError):
            track_duration_ms = None

        if track_duration_ms and track_duration_ms > 0:
            track_seconds = max(1, round(track_duration_ms / 1000))
        else:
            track_seconds = max(1, rotate_delay_seconds or DEFAULT_ROTATE_DELAY)

        prepared.append({
            'url': input_url,
            'seconds': track_seconds,
        })

    if not prepared:
        raise RuntimeError('Playlist tidak memiliki stream')

    command = [
        FFMPEG_BIN,
        '-hide_banner',
        '-loglevel', 'info',
    ]

    filter_parts = []
    for idx, item in enumerate(prepared):
        command += [
            '-thread_queue_size', '1024',
            '-rw_timeout', '15000000',
            '-fflags', '+discardcorrupt',
            '-err_detect', 'ignore_err',
            '-re',
            '-t', str(item['seconds']),
            '-i', item['url'],
        ]
        filter_parts.append(
            f'[{idx}:v:0]fps=15,scale=854:480:force_original_aspect_ratio=decrease,pad=854:480:(ow-iw)/2:(oh-ih)/2,setsar=1,format=yuv420p,setpts=PTS-STARTPTS[v{idx}]'
        )

    total_seconds = sum(item['seconds'] for item in prepared)
    concat_inputs = ''.join(f'[v{idx}]' for idx in range(len(prepared)))
    filter_parts.append(f'{concat_inputs}concat=n={len(prepared)}:v=1:a=0[vout]')

    command += [
        '-f', 'lavfi',
        '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100',
        '-filter_complex', ';'.join(filter_parts),
        '-map', '[vout]',
        '-map', f'{len(prepared)}:a:0',
        '-c:v', 'libx264',
        '-tune', 'zerolatency',
        '-preset', 'superfast',
        '-x264-params', 'keyint=30:min-keyint=30:scenecut=0',
        '-maxrate', '1200k',
        '-bufsize', '2400k',
        '-pix_fmt', 'yuv420p',
        '-g', '30',
        '-c:a', 'aac',
        '-b:a', '64k',
        '-ar', '44100',
        '-t', str(total_seconds),
        '-rtmp_live', 'live',
        '-flvflags', 'no_duration_filesize',
        '-f', 'flv',
        output_url,
    ]

    return command

def _build_quad_command(inputs, output_url):
    layout = '0_0|960_0|0_540|960_540'
    filter_complex = (
        '[0:v]fps=15,scale=960:540:force_original_aspect_ratio=decrease,pad=960:540:(ow-iw)/2:(oh-ih)/2,setsar=1,format=yuv420p[v0];'
        '[1:v]fps=15,scale=960:540:force_original_aspect_ratio=decrease,pad=960:540:(ow-iw)/2:(oh-ih)/2,setsar=1,format=yuv420p[v1];'
        '[2:v]fps=15,scale=960:540:force_original_aspect_ratio=decrease,pad=960:540:(ow-iw)/2:(oh-ih)/2,setsar=1,format=yuv420p[v2];'
        '[3:v]fps=15,scale=960:540:force_original_aspect_ratio=decrease,pad=960:540:(ow-iw)/2:(oh-ih)/2,setsar=1,format=yuv420p[v3];'
        f'[v0][v1][v2][v3]xstack=inputs=4:layout={layout}[v]'
    )

    command = [
        FFMPEG_BIN,
        '-hide_banner',
        '-loglevel', 'info',
        '-re',
        '-fflags', '+genpts',
        '-use_wallclock_as_timestamps', '1',
    ]
    for input_url in inputs:
        command += ['-i', input_url]
    command += ['-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100']
    command += [
        '-filter_complex', filter_complex,
        '-map', '[v]',
        '-map', '4:a:0',
        '-c:v', 'libx264',
        '-tune', 'zerolatency',
        '-preset', 'veryfast',
        '-maxrate', '4000k',
        '-bufsize', '8000k',
        '-pix_fmt', 'yuv420p',
        '-g', '60',
        '-c:a', 'aac',
        '-b:a', '128k',
        '-ar', '44100',
        '-flvflags', 'no_duration_filesize',
        '-f', 'flv',
        output_url,
    ]
    return command

def _build_quad_batches(tracks):
    if len(tracks) < 4:
        raise RuntimeError('Mode 4 Channel membutuhkan minimal 4 stream')

    urls = []
    for idx, track in enumerate(tracks):
        input_url = (track.get('url') or '').strip()
        if not input_url:
            raise RuntimeError(f'Track ke-{idx + 1} tidak memiliki URL')
        urls.append(input_url)

    batches = []
    start = 0
    total = len(urls)
    while start < total:
        batch = [urls[(start + offset) % total] for offset in range(4)]
        batches.append(batch)
        start += 4
    return batches

def _drain_process_logs(playlist_id, process):
    try:
        for line in process.stderr:
            if not line:
                break
            text = line.rstrip()
            if text:
                app.logger.info('[RTMP %s] %s', playlist_id, text)
    except Exception as exc:
        app.logger.exception('Gagal membaca log FFmpeg untuk playlist %s: %s', playlist_id, exc)

def _spawn_ffmpeg(command, playlist_id, mode, rotate_delay_seconds, output_url):
    process = subprocess.Popen(
        command,
        stdin=subprocess.PIPE,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        text=True,
        bufsize=1,
    )

    worker = threading.Thread(target=_drain_process_logs, args=(playlist_id, process), daemon=True)
    worker.start()

    with RTMP_LOCK:
        session = RTMP_SESSIONS.setdefault(playlist_id, {})
        session['process'] = process
        session['mode'] = mode
        session['rotateDelaySeconds'] = rotate_delay_seconds
        session['outputUrl'] = output_url
        session['lastError'] = None
        session['startedAt'] = datetime.now().isoformat()

    return process

def _run_rtmp_worker(playlist_id, mode, rotate_delay_seconds, output_url):
    try:
        tracks = parse_xspf(xspf_path(playlist_id))
        if not tracks:
            raise RuntimeError('Playlist tidak memiliki stream')

        if mode == 'quad':
            while True:
                with RTMP_LOCK:
                    session = RTMP_SESSIONS.get(playlist_id)
                    stop_event = session.get('stop_event') if session else None
                    if not session or (stop_event and stop_event.is_set()):
                        break

                tracks = parse_xspf(xspf_path(playlist_id))
                batches = _build_quad_batches(tracks)

                for batch in batches:
                    with RTMP_LOCK:
                        session = RTMP_SESSIONS.get(playlist_id)
                        stop_event = session.get('stop_event') if session else None
                        if not session or (stop_event and stop_event.is_set()):
                            return

                    command = _build_quad_command(batch, output_url)
                    process = _spawn_ffmpeg(command, playlist_id, mode, rotate_delay_seconds, output_url)

                    deadline = None if rotate_delay_seconds <= 0 else time.monotonic() + rotate_delay_seconds
                    while True:
                        if process.poll() is not None:
                            with RTMP_LOCK:
                                session = RTMP_SESSIONS.get(playlist_id)
                                stop_event = session.get('stop_event') if session else None
                            if stop_event and stop_event.is_set():
                                break
                            if process.returncode != 0:
                                raise RuntimeError(f'FFmpeg berhenti dengan kode {process.returncode}')
                            break

                        with RTMP_LOCK:
                            session = RTMP_SESSIONS.get(playlist_id)
                            stop_event = session.get('stop_event') if session else None
                            if not session or (stop_event and stop_event.is_set()):
                                _terminate_process(process)
                                return

                        if deadline is not None and time.monotonic() >= deadline:
                            break
                        time.sleep(0.5)

                    if deadline is None:
                        return

                    _terminate_process(process)

        else:
            while True:
                with RTMP_LOCK:
                    session = RTMP_SESSIONS.get(playlist_id)
                    stop_event = session.get('stop_event') if session else None
                    if not session or (stop_event and stop_event.is_set()):
                        break

                # Gunakan satu proses FFmpeg untuk satu siklus playlist penuh agar output RTMP lebih stabil.
                tracks = parse_xspf(xspf_path(playlist_id))
                command = _build_single_cycle_command(tracks, output_url, rotate_delay_seconds)
                process = _spawn_ffmpeg(command, playlist_id, mode, rotate_delay_seconds, output_url)

                while True:
                    if process.poll() is not None:
                        with RTMP_LOCK:
                            session = RTMP_SESSIONS.get(playlist_id)
                            stop_event = session.get('stop_event') if session else None
                        if stop_event and stop_event.is_set():
                            break
                        if process.returncode != 0:
                            raise RuntimeError(f'FFmpeg berhenti dengan kode {process.returncode}')
                        break

                    with RTMP_LOCK:
                        session = RTMP_SESSIONS.get(playlist_id)
                        stop_event = session.get('stop_event') if session else None
                        if not session or (stop_event and stop_event.is_set()):
                            _terminate_process(process)
                            return

                    time.sleep(0.3)

                _terminate_process(process, timeout=2)
                time.sleep(0.2)

    except Exception as exc:
        app.logger.exception('Gagal menjalankan RTMP untuk playlist %s: %s', playlist_id, exc)
        with RTMP_LOCK:
            session = RTMP_SESSIONS.get(playlist_id)
            if session:
                session['lastError'] = str(exc)
                session['running'] = False
        set_playlist_status(playlist_id, 'pause')
    finally:
        with RTMP_LOCK:
            session = RTMP_SESSIONS.get(playlist_id)
            if session:
                session['running'] = False
                process = session.get('process')
                if process and process.poll() is None:
                    _terminate_process(process)
        

def start_rtmp_session(playlist_id, mode, rotate_delay_seconds=None):
    playlist = get_playlist_by_id(playlist_id)
    if not playlist:
        return None, 'Playlist tidak ditemukan'

    if shutil.which(FFMPEG_BIN) is None and not os.path.exists(FFMPEG_BIN):
        return None, 'FFmpeg tidak ditemukan di sistem'

    tracks = parse_xspf(xspf_path(playlist_id))
    if not tracks:
        return None, 'Playlist tidak memiliki stream'

    mode = (mode or '').strip().lower()
    if mode not in {'single', 'quad'}:
        return None, 'Mode tidak valid'

    try:
        rotate_delay_seconds = int(rotate_delay_seconds if rotate_delay_seconds is not None else DEFAULT_ROTATE_DELAY)
    except (TypeError, ValueError):
        rotate_delay_seconds = DEFAULT_ROTATE_DELAY

    if rotate_delay_seconds < 0:
        rotate_delay_seconds = 0

    if mode == 'quad' and len(tracks) < 4:
        return None, 'Mode 4 Channel membutuhkan minimal 4 stream'

    stop_rtmp_session(playlist_id)

    output_url = playlist_publish_url(playlist['name'])
    playback_url = playlist_playback_url(playlist['name'])
    stop_event = threading.Event()

    with RTMP_LOCK:
        RTMP_SESSIONS[playlist_id] = {
            'process': None,
            'thread': None,
            'stop_event': stop_event,
            'running': True,
            'mode': mode,
            'rotateDelaySeconds': rotate_delay_seconds,
            'outputUrl': output_url,
            'playbackUrl': playback_url,
            'lastError': None,
            'startedAt': datetime.now().isoformat(),
        }

    worker = threading.Thread(
        target=_run_rtmp_worker,
        args=(playlist_id, mode, rotate_delay_seconds, output_url),
        daemon=True,
    )
    with RTMP_LOCK:
        RTMP_SESSIONS[playlist_id]['thread'] = worker
    worker.start()

    set_playlist_status(playlist_id, 'play')
    return session_snapshot(playlist_id), None

def stop_rtmp_session(playlist_id):
    thread = None
    process = None
    with RTMP_LOCK:
        session = RTMP_SESSIONS.get(playlist_id)
        if not session:
            set_playlist_status(playlist_id, 'pause')
            return {'running': False}
        session['stop_event'].set()
        process = session.get('process')
        thread = session.get('thread')

    _terminate_process(process)

    with RTMP_LOCK:
        RTMP_SESSIONS.pop(playlist_id, None)

    if thread and thread.is_alive():
        thread.join(timeout=2)

    set_playlist_status(playlist_id, 'pause')
    return {'running': False}

# ─── HELPER XSPF ─────────────────────────────────────────────

def build_xspf(playlist_name, tracks, rotate_seconds=None):
    """Buat string XML XSPF dari list tracks [{'title': ..., 'url': ..., 'duration': ...}]"""
    use_track_duration = False
    if isinstance(rotate_seconds, str) and rotate_seconds.strip().lower() in {'list', 'track', 'track-duration'}:
        use_track_duration = True
        rotate_seconds = None
    else:
        try:
            rotate_seconds = int(rotate_seconds) if rotate_seconds is not None else None
        except (TypeError, ValueError):
            rotate_seconds = None

        if rotate_seconds is not None and rotate_seconds < 1:
            rotate_seconds = None

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
        ]
        if use_track_duration:
            duration_ms = t.get('duration')
            try:
                duration_ms = int(duration_ms) if duration_ms is not None else None
            except (TypeError, ValueError):
                duration_ms = None

            if duration_ms and duration_ms > 0:
                run_time = max(1, round(duration_ms / 1000))
            else:
                run_time = DEFAULT_ROTATE_DELAY
            lines.append(f'        <vlc:option>run-time={run_time}</vlc:option>')
        elif rotate_seconds is not None:
            lines.append(f'        <vlc:option>run-time={rotate_seconds}</vlc:option>')
        lines += [
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
        try:
            p['track_count'] = len(parse_xspf(xspf_path(p['id'])))
        except Exception:
            p['track_count'] = 0
        session = session_snapshot(p['id'])
        # Service restart akan mengosongkan session runtime.
        # Jika meta masih "play" tapi tidak ada process aktif, paksa kembali ke "pause".
        if not session['running'] and (p.get('rtmpStatus') or 'pause').lower() == 'play':
            p['rtmpStatus'] = 'pause'
            meta_dirty = True
        p['rtmpRunning'] = session['running']
        p['rtmpMode'] = session['mode']
        p['rtmpRotateDelaySeconds'] = session['rotateDelaySeconds']
        p['rtmpLastError'] = session['lastError']
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
        'rtmpStatus':  'pause',
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

@app.route('/api/playlists/<pl_id>/rtmp-status', methods=['POST'])
def update_playlist_rtmp_status(pl_id):
    data = request.get_json() or {}
    status = (data.get('status') or '').strip().lower()

    if status not in {'play', 'pause'}:
        return jsonify({'error': 'Status tidak valid'}), 400

    playlist = get_playlist_by_id(pl_id)
    if not playlist:
        return jsonify({'error': 'Playlist tidak ditemukan'}), 404

    if status == 'play':
        mode = data.get('mode')
        rotate_delay_seconds = data.get('rotateDelaySeconds')
        session, error = start_rtmp_session(pl_id, mode, rotate_delay_seconds)
        if error:
            return jsonify({'error': error}), 400
        updated = get_playlist_by_id(pl_id) or playlist
        return jsonify({
            'success': True,
            'playlist': updated,
            'session': session,
        })

    stop_rtmp_session(pl_id)
    updated = get_playlist_by_id(pl_id) or playlist
    return jsonify({
        'success': True,
        'playlist': updated,
        'session': session_snapshot(pl_id),
    })

@app.route('/api/playlists/<pl_id>/rtmp-session', methods=['GET'])
def get_playlist_rtmp_session(pl_id):
    playlist = get_playlist_by_id(pl_id)
    if not playlist:
        return jsonify({'error': 'Playlist tidak ditemukan'}), 404
    return jsonify(session_snapshot(pl_id))

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

@app.route('/api/playlists/<pl_id>/xspf', methods=['GET'])
def serve_playlist_xspf(pl_id):
    playlist = get_playlist_by_id(pl_id)
    if not playlist:
        return jsonify({'error': 'Playlist tidak ditemukan'}), 404

    tracks = parse_xspf(xspf_path(pl_id))
    rotate_raw = request.args.get('rotate')
    rotate_seconds = None
    if rotate_raw is not None and str(rotate_raw).strip() != '':
        rotate_clean = str(rotate_raw).strip().lower()
        if rotate_clean in {'list', 'track', 'track-duration'}:
            rotate_seconds = 'list'
        else:
            try:
                rotate_seconds = int(rotate_raw)
            except (TypeError, ValueError):
                return jsonify({'error': 'Parameter rotate harus angka (detik) atau "list"'}), 400
            if rotate_seconds < 1 or rotate_seconds > 3600:
                return jsonify({'error': 'Parameter rotate harus antara 1-3600 detik'}), 400

    content = build_xspf(playlist['name'], tracks, rotate_seconds=rotate_seconds)
    return Response(content, mimetype='application/xspf+xml')

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

# ─── MAIN ─────────────────────────────────────────────────────

if __name__ == '__main__':
    print('✅ CCTV Dashboard running at http://localhost:3000')
    app.run(host='0.0.0.0', port=3000, debug=True, use_reloader=False)