// Mobile control: speaks the same JSON message protocol as the Electron app,
// over WebSocket (window.djv from net.js). Engine catalog (window.EFFECTS) is
// loaded for the effect library; everything else is plain commands + REST.
const $ = (s) => document.querySelector(s);
const send = (m) => djv.send(m);
const fmt = (s) => { s = Math.max(0, Math.floor(s || 0)); return Math.floor(s / 60) + ':' + ('0' + (s % 60)).slice(-2); };

// ---- Tabs ------------------------------------------------------------------
document.querySelectorAll('#tabs button').forEach((b) => b.addEventListener('click', () => {
  document.querySelectorAll('#tabs button').forEach((x) => x.classList.toggle('active', x === b));
  document.querySelectorAll('.panel').forEach((p) => p.classList.toggle('hidden', p.dataset.tab !== b.dataset.tab));
}));

// ---- Connection status -----------------------------------------------------
djv.onStatus((ok) => { const e = $('#conn'); e.textContent = ok ? 'online' : 'offline'; e.className = ok ? 'on' : 'off'; });

// ---- Effetti ---------------------------------------------------------------
const EFFECTS = window.EFFECTS;
const famSel = $('#fx-fam');
EFFECTS.families.forEach((n, i) => { const o = document.createElement('option'); o.value = i; o.textContent = n; famSel.appendChild(o); });
let curEffect = EFFECTS.list[0];
function applyEffect(e) { curEffect = e; send({ type: 'effect', effect: e }); $('#now').textContent = e.name; renderFx(); }
function renderFx() {
  const fam = parseInt(famSel.value, 10);
  const q = $('#fx-search').value.trim().toLowerCase();
  const list = $('#fx-list'); list.innerHTML = '';
  let count = 0;
  for (const e of EFFECTS.list) {
    if (fam >= 0 && e.family !== fam) continue;
    if (q && e.name.toLowerCase().indexOf(q) < 0) continue;
    const d = document.createElement('div');
    d.className = 'item' + (e === curEffect ? ' active' : '');
    d.textContent = e.name;
    d.addEventListener('click', () => applyEffect(e));
    list.appendChild(d);
    if (++count >= 250) break;
  }
}
famSel.addEventListener('change', () => {
  const fam = parseInt(famSel.value, 10);
  if (fam >= 0) { const f = EFFECTS.list.find((e) => e.family === fam); if (f) applyEffect(f); }
  else renderFx();
});
$('#fx-search').addEventListener('input', renderFx);
renderFx();
send({ type: 'effect', effect: curEffect }); // push the starting effect

// SVG sagome
djv.listSvgs().then((svgs) => {
  const sel = $('#svg-sel');
  svgs.forEach((s) => { const o = document.createElement('option'); o.value = s.url; o.textContent = s.name; sel.appendChild(o); });
});
$('#svg-sel').addEventListener('change', (e) => {
  if (!e.target.value) return;
  const fam = EFFECTS.families.indexOf('SVG/Immagine');
  const eff = EFFECTS.list.find((x) => x.family === fam);
  if (eff) applyEffect(eff);
  send({ type: 'svg', dataUrl: e.target.value });
});

// ---- Media / Playlist ------------------------------------------------------
let library = [], queue = [], qIndex = -1, playing = false, curDur = 0, curCur = 0;
const durCache = {};       // url -> seconds
const wavePeaks = {};      // file(base) -> peaks[] | 'loading' | null
const WAVE_BUCKETS = 400;
let openDetail = -1;       // queue index whose trim/waveform panel is open
let gapTimer = null;
const baseName = (u) => decodeURIComponent((u || '').split('/').pop());

function probeDur(url) { if (url && !(url in durCache)) send({ type: 'probeDurations', paths: [url] }); }
function ensureWave(it) {
  const file = baseName(it.url);
  if (!file || wavePeaks[file]) return;
  wavePeaks[file] = 'loading';
  djv.peaks(file, WAVE_BUCKETS).then((res) => {
    const peaks = Array.isArray(res) ? res : (res && res.peaks);
    wavePeaks[file] = (peaks && peaks.length) ? peaks : null;
    if (res && res.duration && !(it.url in durCache)) durCache[it.url] = res.duration; // exact duration from the server
    renderQueue();
  }).catch(() => { wavePeaks[file] = null; });
}
function drawWave(canvas, it, isCur) {
  const peaks = wavePeaks[baseName(it.url)];
  const ctx = canvas.getContext('2d'), w = canvas.width, h = canvas.height, mid = h / 2;
  ctx.clearRect(0, 0, w, h);
  if (!Array.isArray(peaks)) { ctx.fillStyle = 'rgba(255,255,255,.08)'; ctx.fillRect(0, mid - 1, w, 2); return; }
  const dur = durCache[it.url] || (isCur ? curDur : 0);
  const s = it.start || 0, e = it.end > 0 ? it.end : dur;
  const sx = dur > 0 ? s / dur * w : 0, ex = dur > 0 ? e / dur * w : w, N = peaks.length;
  for (let x = 0; x < w; x++) {
    const bar = Math.max(1, peaks[Math.min(N - 1, Math.floor(x / w * N))] * h * 0.46);
    ctx.fillStyle = (x >= sx && x <= ex) ? 'rgba(140,182,255,.9)' : 'rgba(140,182,255,.2)';
    ctx.fillRect(x, mid - bar, 1, bar * 2);
  }
  if (dur > 0) { ctx.fillStyle = '#6ee7a0'; ctx.fillRect(sx, 0, 2, h); ctx.fillStyle = '#ff9a9a'; ctx.fillRect(ex - 2, 0, 2, h); }
  if (isCur && curDur > 0) { ctx.fillStyle = '#fff'; ctx.fillRect(Math.min(w, curCur / curDur * w), 0, 1.5, h); }
}
// Pointer on the waveform: grab a trim handle if near one, else seek/scrub.
function wireWave(canvas, it, i) {
  const HANDLE = 12; let mode = null;
  const dur = () => durCache[it.url] || (i === qIndex ? curDur : 0) || 0;
  const tAt = (e) => { const r = canvas.getBoundingClientRect(); return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * dur(); };
  const refreshLabels = () => { const d = canvas.parentNode; d.querySelector('.t-in').textContent = fmt(it.start || 0); d.querySelector('.t-out').textContent = it.end > 0 ? fmt(it.end) : 'fine'; };
  canvas.addEventListener('pointerdown', (e) => {
    const d = dur(), r = canvas.getBoundingClientRect(), x = e.clientX - r.left;
    const sx = d ? (it.start || 0) / d * r.width : 0, ex = d ? (it.end > 0 ? it.end : d) / d * r.width : r.width;
    if (d && Math.abs(x - sx) <= HANDLE) mode = 'start'; else if (d && Math.abs(x - ex) <= HANDLE) mode = 'end'; else mode = 'seek';
    canvas.setPointerCapture(e.pointerId); e.preventDefault();
    if (mode === 'seek' && i === qIndex) { curCur = tAt(e); send({ type: 'seek', time: curCur }); drawWave(canvas, it, true); }
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!mode) return; const t = tAt(e);
    if (mode === 'start') { it.start = Math.max(0, Math.min(t, (it.end > 0 ? it.end : dur()) - 0.5)); }
    else if (mode === 'end') { it.end = Math.min(dur(), Math.max(t, (it.start || 0) + 0.5)); }
    else { if (i === qIndex) { curCur = t; send({ type: 'seek', time: t }); drawWave(canvas, it, true); } return; }
    drawWave(canvas, it, i === qIndex); refreshLabels();
  });
  const end = (e) => {
    if (!mode) return;
    if (mode !== 'seek') { if (i === qIndex) send({ type: 'setTrim', start: it.start || 0, end: it.end || 0 }); }
    else if (i !== qIndex) playAt(i, tAt(e));
    mode = null;
  };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', () => { mode = null; });
}
function clearGap() { if (gapTimer) { clearTimeout(gapTimer); gapTimer = null; } }
function advanceQueue() { if (qIndex + 1 < queue.length) playAt(qIndex + 1); else { playing = false; $('#np-play').textContent = '▶'; } }
function afterTrackEnd() {
  const it = queue[qIndex];
  if (it && it.gap > 0) gapTimer = setTimeout(() => { gapTimer = null; advanceQueue(); }, it.gap * 1000);
  else advanceQueue();
}
function updateOpenDetail() {
  if (openDetail !== qIndex || qIndex < 0) return;
  const card = document.querySelectorAll('#queue .qcard')[qIndex]; if (!card) return;
  const det = card.querySelector('.qdetail'); if (!det) return;
  const it = queue[qIndex], canvas = det.querySelector('.wave'); if (canvas) drawWave(canvas, it, true);
  const tot = Math.max(0, (it.end > 0 ? it.end : (durCache[it.url] || curDur)) - (it.start || 0));
  const el = Math.max(0, curCur - (it.start || 0));
  det.querySelector('.tt-el').textContent = '▶ ' + fmt(el);
  det.querySelector('.tt-rem').textContent = '⧗ -' + fmt(Math.max(0, tot - el));
}
function loadLibrary() { djv.listMedia().then((items) => { library = items; renderLib(); }); }
function mediaIcon(k) { return k === 'video' ? '🎞 ' : (k === 'image' ? '🖼 ' : '🎵 '); }
function renderLib() {
  const el = $('#lib'); el.innerHTML = '';
  if (!library.length) { el.innerHTML = '<div class="empty">Nessun file. Caricane con ⬆️ o copiali nella cartella <b>media/</b> del dispositivo.</div>'; return; }
  library.forEach((it) => {
    const d = document.createElement('div'); d.className = 'item';
    d.innerHTML = '<span>' + mediaIcon(it.kind) + it.name + '</span>';
    const add = document.createElement('button'); add.textContent = '＋'; add.title = 'In coda';
    add.addEventListener('click', (ev) => { ev.stopPropagation(); queue.push(it); renderQueue(); });
    d.appendChild(add);
    d.addEventListener('click', () => {
      if (assignPad >= 0) { assignToPad(assignPad, it); assignPad = -1; switchTab('pad'); return; }
      if (it.kind === 'image') { send({ type: 'sceneImage', path: it.url, size: 60, x: 50, y: 50 }); return; }
      queue.push(it); playAt(queue.length - 1);
    });
    el.appendChild(d);
  });
}
function renderQueue() {
  $('#queue-count').textContent = queue.length;
  const el = $('#queue'); el.innerHTML = '';
  queue.forEach((it, i) => {
    const card = document.createElement('div'); card.className = 'qcard' + (i === qIndex ? ' active' : '');
    const head = document.createElement('div'); head.className = 'item';
    head.innerHTML = '<span>' + mediaIcon(it.kind) + it.name + '</span>';
    head.addEventListener('click', () => playAt(i));
    if (it.kind !== 'image') {
      const cog = document.createElement('button'); cog.textContent = '⚙'; cog.title = 'Trim / forma d\'onda';
      cog.addEventListener('click', (ev) => { ev.stopPropagation(); openDetail = openDetail === i ? -1 : i; renderQueue(); });
      head.appendChild(cog);
    }
    const del = document.createElement('button'); del.textContent = '✕';
    del.addEventListener('click', (ev) => { ev.stopPropagation(); queue.splice(i, 1); if (i < qIndex) qIndex--; if (openDetail === i) openDetail = -1; renderQueue(); });
    head.appendChild(del);
    card.appendChild(head);

    if (openDetail === i && it.kind !== 'image') {
      probeDur(it.url); ensureWave(it);
      const dur = durCache[it.url] || (i === qIndex ? curDur : 0);
      const elp = i === qIndex ? Math.max(0, curCur - (it.start || 0)) : 0;
      const tot = Math.max(0, (it.end > 0 ? it.end : dur) - (it.start || 0));
      const det = document.createElement('div'); det.className = 'qdetail';
      det.innerHTML =
        '<div class="qtimes"><span class="tt-el">▶ ' + fmt(elp) + '</span>' +
        '<span class="tt-tot">⏱ ' + fmt(tot) + '</span>' +
        '<span class="tt-rem">⧗ -' + fmt(Math.max(0, tot - elp)) + '</span></div>' +
        '<canvas class="wave" width="' + WAVE_BUCKETS + '" height="46" title="Clic/trascina = sposta riproduzione · maniglie 🟢🔴 = inizio/fine"></canvas>' +
        '<div class="qtrim"><span class="lblg">Inizio <b class="t-in">' + fmt(it.start || 0) + '</b></span>' +
        '<button class="here-s" title="Inizio = punto attuale">📍</button>' +
        '<span class="lblr">Fine <b class="t-out">' + (it.end > 0 ? fmt(it.end) : 'fine') + '</b></span>' +
        '<button class="here-e" title="Fine = punto attuale">📍</button>' +
        '<button class="rst" title="Azzera">↺</button></div>' +
        '<div class="qgap">⏸ Pausa dopo <input class="gapv" type="number" min="0" step="1" value="' + (it.gap || 0) + '"> s</div>';
      card.appendChild(det);
      const canvas = det.querySelector('.wave');
      drawWave(canvas, it, i === qIndex); wireWave(canvas, it, i);
      det.querySelector('.here-s').addEventListener('click', () => { if (i === qIndex) { it.start = Math.max(0, curCur); send({ type: 'setTrim', start: it.start, end: it.end || 0 }); renderQueue(); } });
      det.querySelector('.here-e').addEventListener('click', () => { if (i === qIndex) { it.end = Math.max(0.5, curCur); send({ type: 'setTrim', start: it.start || 0, end: it.end }); renderQueue(); } });
      det.querySelector('.rst').addEventListener('click', () => { it.start = 0; it.end = 0; if (i === qIndex) send({ type: 'setTrim', start: 0, end: 0 }); renderQueue(); });
      det.querySelector('.gapv').addEventListener('change', (e) => { it.gap = Math.max(0, parseFloat(e.target.value) || 0); });
    }
    el.appendChild(card);
  });
}
function playAt(i, fromTime) {
  if (i < 0 || i >= queue.length) return;
  clearGap();
  qIndex = i; const it = queue[i]; playing = true;
  probeDur(it.url);
  const startAt = fromTime != null ? Math.max(0, fromTime) : (it.start || 0);
  send({ type: it.kind === 'video' ? 'playVideoTrack' : 'playTrack', path: it.url, start: startAt, end: it.end || 0 });
  $('#np-name').textContent = it.name; $('#np-play').textContent = '⏸';
  $('#nowbar').classList.remove('hidden'); renderQueue();
}
$('#np-next').addEventListener('click', () => { if (qIndex + 1 < queue.length) playAt(qIndex + 1); });
$('#np-prev').addEventListener('click', () => { if (qIndex > 0) playAt(qIndex - 1); });
$('#np-play').addEventListener('click', () => send({ type: 'togglePlay' }));
$('#seek').addEventListener('input', (e) => { if (curDur > 0) send({ type: 'seek', time: e.target.value / 1000 * curDur }); });
$('#media-refresh').addEventListener('click', loadLibrary);
$('#media-upload-btn').addEventListener('click', () => $('#media-upload').click());
$('#media-upload').addEventListener('change', (e) => {
  const files = [...e.target.files];
  if (!files.length) return;
  const fd = new FormData(); files.forEach((f) => fd.append('files', f));
  const btn = $('#media-upload-btn');
  btn.textContent = '⏳ Carico ' + files.length + '…';
  const reset = (txt) => { e.target.value = ''; btn.textContent = txt; setTimeout(() => { btn.textContent = '⬆️ Carica file'; }, 2500); };
  fetch('/api/upload', { method: 'POST', body: fd })
    .then((r) => r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status)))
    .then((res) => { reset('✅ ' + (res && res.count || files.length) + ' caricati'); loadLibrary(); })
    .catch((err) => { reset('❌ Errore: ' + err.message); });
});
loadLibrary();

// ---- Testo (ticker) --------------------------------------------------------
const tk = (id) => $('#tk-' + id);
tk('text').addEventListener('input', (e) => send({ type: 'tickerText', text: e.target.value.replace(/\s*\n\s*/g, ' · ') }));
tk('on').addEventListener('change', (e) => send({ type: 'tickerOn', on: e.target.checked }));
tk('dir').addEventListener('change', (e) => send({ type: 'tickerDir', value: e.target.value }));
tk('pos').addEventListener('change', (e) => send({ type: 'tickerPos', pos: e.target.value }));
tk('fx').addEventListener('change', (e) => send({ type: 'tickerFx', value: e.target.value }));
tk('size').addEventListener('input', (e) => { $('#tk-size-v').textContent = e.target.value; send({ type: 'tickerSize', value: parseFloat(e.target.value) }); });
tk('speed').addEventListener('input', (e) => { $('#tk-speed-v').textContent = (+e.target.value).toFixed(1) + '×'; send({ type: 'tickerSpeed', mult: parseFloat(e.target.value) }); });
tk('bold').addEventListener('change', (e) => send({ type: 'tickerWeight', on: e.target.checked }));
tk('color').addEventListener('input', (e) => send({ type: 'tickerColor', value: e.target.value }));

// ---- Pad -------------------------------------------------------------------
const PAD_N = 12;
let pads = new Array(PAD_N).fill(null);
let assignPad = -1, activePad = -1;
function renderPads() {
  const grid = $('#pads'); grid.innerHTML = '';
  for (let i = 0; i < PAD_N; i++) {
    const p = pads[i];
    const b = document.createElement('button');
    b.className = 'pad' + (p ? ' set' : '') + (i === activePad ? ' active' : '') + (i === assignPad ? ' assign' : '');
    b.innerHTML = p ? mediaIcon(p.kind) + '<small>' + p.name + '</small>' : '<small>vuoto</small>';
    let timer = null;
    b.addEventListener('pointerdown', () => { timer = setTimeout(() => { timer = null; assignPad = i; switchTab('media'); }, 550); });
    b.addEventListener('pointerup', () => {
      if (timer) { clearTimeout(timer); timer = null; padTap(i); }
    });
    b.addEventListener('pointerleave', () => { if (timer) { clearTimeout(timer); timer = null; } });
    grid.appendChild(b);
  }
}
function padTap(i) {
  const p = pads[i]; if (!p) { assignPad = i; switchTab('media'); return; }
  if (i === activePad && playing) { send({ type: 'togglePlay' }); return; }
  activePad = i; playing = true; qIndex = -1;
  send({ type: p.kind === 'video' ? 'playVideoTrack' : 'playTrack', path: p.url, start: 0, end: 0 });
  $('#now').textContent = p.name; renderPads();
}
function assignToPad(i, it) { pads[i] = { name: it.name, url: it.url, kind: it.kind }; savePads(); renderPads(); }
function savePads() { djv.saveState('pads', pads); }
djv.loadState('pads').then((s) => { if (Array.isArray(s)) { pads = s.concat(new Array(PAD_N).fill(null)).slice(0, PAD_N); } renderPads(); });

// ---- Audio -----------------------------------------------------------------
function slider(id, on) { const el = $('#' + id); el.addEventListener('input', (e) => on(parseFloat(e.target.value), e)); }
slider('gain', (v) => { $('#gain-v').textContent = v.toFixed(2) + '×'; send({ type: 'gain', value: v }); });
slider('speed', (v) => { $('#speed-v').textContent = v.toFixed(2) + '×'; send({ type: 'speed', value: v }); });
slider('bass', (v) => { $('#bass-v').textContent = v.toFixed(2) + '×'; send({ type: 'bandGain', band: 'bass', value: v }); });
slider('mid', (v) => { $('#mid-v').textContent = v.toFixed(2) + '×'; send({ type: 'bandGain', band: 'mid', value: v }); });
slider('treble', (v) => { $('#treble-v').textContent = v.toFixed(2) + '×'; send({ type: 'bandGain', band: 'treble', value: v }); });

// ---- Output / Rec ----------------------------------------------------------
let recOn = false;
$('#fs').addEventListener('click', () => send({ type: 'outputFullscreen' }));
$('#rec').addEventListener('click', () => {
  if (!recOn) { send({ type: 'recStart' }); }
  else { const [w, h] = $('#rec-fmt').value.split('x').map(Number); send({ type: 'recStop', w, h }); }
});
function updateRec() {
  $('#rec').textContent = recOn ? '⏹ Ferma registrazione' : '🔴 Avvia registrazione';
  $('#rec').classList.toggle('recording', recOn);
}

// ---- Reports ---------------------------------------------------------------
function setMeter(id, v) { const e = $('#' + id); if (e) e.style.width = Math.min(100, (v || 0) * 100) + '%'; }
djv.onReport((m) => {
  switch (m.type) {
    case 'progress':
      curCur = m.currentTime; curDur = m.duration;
      $('#np-time').textContent = fmt(curCur) + ' / ' + fmt(curDur);
      if (curDur > 0) $('#seek').value = Math.round(curCur / curDur * 1000);
      updateOpenDetail();
      break;
    case 'durations':
      (m.list || []).forEach((d) => { durCache[d.path] = d.duration; });
      if (openDetail >= 0) renderQueue();
      break;
    case 'playState':
      playing = m.playing; $('#np-play').textContent = playing ? '⏸' : '▶';
      break;
    case 'trackEnded':
      afterTrackEnd();
      break;
    case 'meters':
      setMeter('m-bass', m.bass); setMeter('m-mid', m.mid); setMeter('m-treble', m.treble);
      break;
    case 'recState': recOn = m.recording; updateRec(); break;
    case 'recSaved': $('#rec-status').textContent = '✅ Salvato: ' + m.path; break;
    case 'recError': $('#rec-status').textContent = '⚠️ ' + m.message; break;
  }
});

function switchTab(tab) { const b = document.querySelector('#tabs button[data-tab="' + tab + '"]'); if (b) b.click(); }
renderPads();
