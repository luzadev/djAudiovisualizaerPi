// DJ Visualizer Pi — standalone server.
// Serves the visual output page (Chromium kiosk on the Pi's HDMI) and the mobile
// control PWA, and relays JSON commands between them over WebSocket. Also exposes
// a small REST API for the media library, JSON state, waveform peaks and MP4
// recording. The control<->output message protocol is the SAME JSON used by the
// Electron app (ctl/rpt), so the engine code is reused almost unchanged.

const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFile, spawn } = require('child_process');
const multer = require('multer');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 8080;
const ROOT = __dirname;
const MEDIA_DIR = process.env.MEDIA_DIR || path.join(ROOT, 'media');
const STATE_DIR = path.join(ROOT, 'state');
const SVG_DIR = path.join(ROOT, 'svg');
const REC_DIR = process.env.REC_DIR || path.join(ROOT, 'recordings');
for (const d of [MEDIA_DIR, STATE_DIR, REC_DIR]) fs.mkdirSync(d, { recursive: true });

function ffmpegPath() {
  const cands = [process.env.FFMPEG, 'ffmpeg', '/usr/bin/ffmpeg', '/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg'];
  for (const c of cands) { if (!c) continue; if (c === 'ffmpeg' || fs.existsSync(c)) return c; }
  return 'ffmpeg';
}

const app = express();
app.use(express.json({ limit: '4mb' }));
// Never cache the app shell (HTML/JS/CSS): on a local appliance the network is
// fast and this guarantees the kiosk/phone always run the latest deployed code.
// Media files (large) stay cacheable.
app.use((req, res, next) => { if (!req.path.startsWith('/media')) res.set('Cache-Control', 'no-store'); next(); });
app.use(express.static(path.join(ROOT, 'public'), { etag: false, lastModified: false }));
app.use('/media', express.static(MEDIA_DIR));
app.use('/svg', express.static(SVG_DIR));

// ---- Media library ---------------------------------------------------------
const AUDIO_RE = /\.(mp3|m4a|aac|wav|flac|ogg|opus|aif|aiff)$/i;
const VIDEO_RE = /\.(mp4|mov|m4v|webm|mkv)$/i;
const IMAGE_RE = /\.(png|jpe?g|gif|webp|svg)$/i;

app.get('/api/media', (_req, res) => {
  let files = [];
  try { files = fs.readdirSync(MEDIA_DIR); } catch (e) {}
  const items = files.filter(f => AUDIO_RE.test(f) || VIDEO_RE.test(f) || IMAGE_RE.test(f))
    .sort((a, b) => a.localeCompare(b))
    .map(f => ({
      name: f,
      url: '/media/' + encodeURIComponent(f),
      kind: VIDEO_RE.test(f) ? 'video' : (IMAGE_RE.test(f) ? 'image' : 'audio')
    }));
  res.json(items);
});

const upload = multer({
  storage: multer.diskStorage({
    destination: (_r, _f, cb) => cb(null, MEDIA_DIR),
    filename: (_r, file, cb) => cb(null, file.originalname)
  }),
  limits: { fileSize: 1024 * 1024 * 1024 }
});
app.post('/api/upload', upload.array('files'), (req, res) => {
  res.json({ ok: true, count: (req.files || []).length });
});

app.get('/api/clients', (_req, res) => { res.json([...wss.clients].map((c) => ({ role: c.role, open: c.readyState === 1 }))); });

app.get('/api/svgs', (_req, res) => {
  let files = [];
  try { files = fs.readdirSync(SVG_DIR).filter(f => /\.svg$/i.test(f)); } catch (e) {}
  res.json(files.sort().map(f => ({ name: f, url: '/svg/' + encodeURIComponent(f) })));
});

// ---- Simple JSON state store (pads / playlist) -----------------------------
app.get('/api/state/:key', (req, res) => {
  const f = path.join(STATE_DIR, path.basename(req.params.key) + '.json');
  try { res.json(JSON.parse(fs.readFileSync(f, 'utf8'))); }
  catch (e) { res.json(null); }
});
app.post('/api/state/:key', (req, res) => {
  const f = path.join(STATE_DIR, path.basename(req.params.key) + '.json');
  try { fs.writeFileSync(f, JSON.stringify(req.body)); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ---- Waveform peaks (ffmpeg -> mono 8kHz PCM -> N normalized buckets) -------
const peaksCache = new Map();
app.get('/api/peaks', (req, res) => {
  const name = path.basename(req.query.file || '');
  const buckets = Math.max(40, Math.min(2000, parseInt(req.query.buckets, 10) || 400));
  const file = path.join(MEDIA_DIR, name);
  const key = name + '|' + buckets;
  if (peaksCache.has(key)) return res.json(peaksCache.get(key));
  if (!fs.existsSync(file)) return res.json(null);
  execFile(ffmpegPath(), ['-v', 'quiet', '-i', file, '-ac', '1', '-ar', '8000', '-f', 's16le', '-'],
    { encoding: 'buffer', maxBuffer: 1 << 28 }, (err, stdout) => {
      if (err || !stdout || stdout.length < 4) return res.json(null);
      const u8 = Uint8Array.from(stdout);
      const s = new Int16Array(u8.buffer, 0, u8.length >> 1);
      const n = s.length, per = Math.max(1, Math.floor(n / buckets)), peaks = new Array(buckets).fill(0);
      let top = 0.0001;
      for (let b = 0; b < buckets; b++) {
        let m = 0; const a = b * per, e = Math.min(n, a + per);
        for (let i = a; i < e; i++) { const v = s[i] < 0 ? -s[i] : s[i]; if (v > m) m = v; }
        peaks[b] = m; if (m > top) top = m;
      }
      for (let b = 0; b < buckets; b++) peaks[b] = Math.min(1, peaks[b] / top);
      // Exact duration from the decoded mono 8 kHz stream: samples / 8000.
      const out = { peaks, duration: n / 8000 };
      peaksCache.set(key, out);
      res.json(out);
    });
});

// ---- Recording: output streams WebM chunks, we mux/transcode to MP4 --------
let rec = null; // { ws stream, tmp }
function startRec() {
  const tmp = path.join(os.tmpdir(), 'djvpi-rec-' + Date.now() + '.webm');
  rec = { tmp, stream: fs.createWriteStream(tmp) };
  return true;
}
function transcode(input, output, w, h) {
  const vf = `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h}`;
  const args = ['-y', '-i', input, '-vf', vf, '-c:v', 'libx264', '-preset', 'veryfast',
    '-crf', '20', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', output];
  return new Promise((resolve, reject) => {
    execFile(ffmpegPath(), args, { maxBuffer: 1 << 24 }, (err, _o, stderr) =>
      err ? reject(new Error(String(stderr || err.message).slice(-400))) : resolve());
  });
}
app.post('/api/rec/start', (_req, res) => { startRec(); res.json({ ok: true }); });
app.post('/api/rec/chunk', express.raw({ type: 'application/octet-stream', limit: '64mb' }), (req, res) => {
  if (rec && req.body && req.body.length) rec.stream.write(req.body);
  res.json({ ok: true });
});
app.post('/api/rec/stop', async (req, res) => {
  if (!rec) return res.json({ ok: false, error: 'nessuna registrazione' });
  const { w = 1920, h = 1080 } = req.body || {};
  const cur = rec; rec = null;
  await new Promise(r => cur.stream.end(r));
  const out = path.join(REC_DIR, 'DJV-' + Date.now() + '.mp4');
  try { await transcode(cur.tmp, out, w, h); fs.unlink(cur.tmp, () => {}); res.json({ ok: true, path: out }); }
  catch (e) { res.json({ ok: false, error: e.message }); }
});

// ---- WebSocket relay (the ctl/rpt hub) -------------------------------------
const server = http.createServer(app);
const wss = new WebSocketServer({ server });
let lastEffect = null; // remember last effect so a freshly-opened output syncs

wss.on('connection', (ws, req) => {
  ws.role = new URL(req.url, 'http://x').searchParams.get('role') || 'control';
  ws.on('message', (data) => {
    let msg; try { msg = JSON.parse(data.toString()); } catch (e) { return; }
    if (msg.ch === 'ctl') {
      if (msg.msg && msg.msg.type === 'effect') lastEffect = msg.msg;
      broadcast('output', data);          // control -> output(s)
    } else if (msg.ch === 'rpt') {
      broadcast('control', data);          // output -> control(s)
    }
  });
  // Sync a newly-connected output with the current effect.
  if (ws.role === 'output' && lastEffect) {
    ws.send(JSON.stringify({ ch: 'ctl', msg: lastEffect }));
  }
});
function broadcast(role, data) {
  // Always send a TEXT frame: browsers receive binary frames as Blob and would
  // fail JSON.parse, so commands would silently never reach the output page.
  const txt = typeof data === 'string' ? data : data.toString();
  wss.clients.forEach(c => { if (c.readyState === 1 && c.role === role) c.send(txt); });
}

server.listen(PORT, () => {
  const ip = Object.values(os.networkInterfaces()).flat().find(i => i && i.family === 'IPv4' && !i.internal);
  console.log('DJ Visualizer Pi server su:');
  console.log('  Output (Pi/HDMI):  http://localhost:' + PORT + '/output.html');
  console.log('  Controllo (phone): http://' + (ip ? ip.address : 'localhost') + ':' + PORT + '/');
  console.log('  Media dir:         ' + MEDIA_DIR);
});
