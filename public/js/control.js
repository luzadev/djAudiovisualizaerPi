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

// Auto VJ: the output-side director picks presets in time with the music.
let autoVjOn = false;
$('#auto-vj').addEventListener('click', () => send({ type: 'autoVj', on: !autoVjOn }));
function setAutoVj(m) {
  autoVjOn = !!m.on;
  const b = $('#auto-vj');
  b.classList.toggle('vj-on', autoVjOn);
  b.textContent = autoVjOn ? '🤖 Auto VJ ● attivo' : '🤖 Auto VJ';
  if (autoVjOn && m.name) $('#now').textContent = m.name + (m.bpm ? ' · ' + m.bpm + ' BPM' : '');
}
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
const baseName = (u) => decodeURIComponent((u || '').split('/').pop());

// ---- Scene model (timed elements: effect / text / image) -------------------
// Each queue item may carry a `cues` list of independent timed elements. The
// three channels (effect, text, image) appear/disappear on their own schedule;
// dur 0 = stays until the next element of the same type. Mirrors the Mac app.
const TXT_DIRS = [['h', '➡️ Orizzontale'], ['vup', '⬆️ Vert. su'], ['vdown', '⬇️ Vert. giù'], ['sides', '↕️ Bordi']];
const TXT_FX = [['none', 'Nessuno'], ['updown', 'Su e giù'], ['wave', 'Onda'], ['zoom', 'Zoom'], ['flash', 'Flash'], ['rotate', 'Rotazione']];
const TXT_POS = [['bottom', 'Basso'], ['top', 'Alto'], ['middle', 'Centro']];
const TXT_FONTS = [
  ['-apple-system, BlinkMacSystemFont, sans-serif', 'Sistema'],
  ["'Arial Black', Impact, sans-serif", 'Arial Black'],
  ['Impact, sans-serif', 'Impact'],
  ["Georgia, 'Times New Roman', serif", 'Georgia'],
  ["'Courier New', monospace", 'Monospace'],
  ['Verdana, Geneva, sans-serif', 'Verdana'],
];
const IMG_POS = { center: { x: 50, y: 50 }, top: { x: 50, y: 18 }, bottom: { x: 50, y: 82 }, left: { x: 20, y: 50 }, right: { x: 80, y: 50 } };
const IMG_POS_LABELS = { center: 'Centro', top: 'Alto', bottom: 'Basso', left: 'Sinistra', right: 'Destra' };
const EL_ICON = { effect: '🌀', text: '🔤', image: '🖼' };
const EL_LABEL = { effect: 'Effetto', text: 'Testo', image: 'Immagine' };

function optList(pairs, sel) {
  return pairs.map(([v, l]) => '<option value="' + String(v).replace(/"/g, '&quot;') + '"' + (v === sel ? ' selected' : '') + '>' + l + '</option>').join('');
}
function parseTime(str) {
  str = String(str).trim();
  if (str.indexOf(':') >= 0) { const p = str.split(':').map(Number); return (p[0] || 0) * 60 + (p[1] || 0); }
  return parseFloat(str) || 0;
}
function cueFamilyOptions(selFam) {
  let o = '<option value="-1"' + (selFam < 0 ? ' selected' : '') + '>— nessuno —</option>';
  EFFECTS.families.forEach((n, i) => { o += '<option value="' + i + '"' + (i === selFam ? ' selected' : '') + '>' + n + '</option>'; });
  return o;
}
function firstPresetOfFamily(fam) { return EFFECTS.list.findIndex((e) => e.family === fam); }
function cuePresetOptions(fam, selIdx) {
  let o = '';
  EFFECTS.list.forEach((e, idx) => { if (e.family !== fam) return; o += '<option value="' + idx + '"' + (idx === selIdx ? ' selected' : '') + '>' + e.name + '</option>'; });
  return o;
}
function newEffectEl(time) { return { type: 'effect', time, effectIndex: EFFECTS.list.indexOf(curEffect), effectName: curEffect.name, dur: 0 }; }
function newTextEl(time) { return { type: 'text', time, text: '', dir: 'h', fx: 'none', font: TXT_FONTS[0][0], size: 6, weight: true, color: '#ffffff', pos: 'bottom', speed: 1, dur: 0 }; }
function newImageEl(time) { return { type: 'image', time, image: null, imageSize: 60, imagePos: 'center', dur: 0 }; }
function hasScene(it) {
  return !!(it && it.cues && it.cues.some((c) =>
    (c.type === 'effect' && c.effectIndex != null) ||
    (c.type === 'text' && c.text && c.text.trim()) ||
    (c.type === 'image' && c.image)));
}

// Runtime: re-evaluate the active element per channel and diff-apply it.
let activeCues = [];
let lastScene = { effect: null, text: null, image: null };
let userTrackBlend = 'normal', sentTrackBlend = null;
function startCues(it) {
  activeCues = (it.cues || []).slice().sort((a, b) => a.time - b.time);
  sentTrackBlend = null;
  // `undefined` (not null) forces advanceCues to APPLY each channel once, so a
  // stale text/image from the previous track is cleared even if nothing is active.
  lastScene = { effect: undefined, text: undefined, image: undefined };
  advanceCues(0);
}
function sceneActive(type, t) {
  let best = null;
  for (const el of activeCues) {
    if (el.type !== type || el.time > t) continue;
    if (el.dur && el.time + el.dur <= t) continue;
    if (!best || el.time >= best.time) best = el;
  }
  return best;
}
function advanceCues(t) {
  const ef = sceneActive('effect', t);
  if (ef !== lastScene.effect) { lastScene.effect = ef; if (ef && EFFECTS.list[ef.effectIndex]) applyEffect(EFFECTS.list[ef.effectIndex]); }
  const curIt = queue[qIndex];
  if (curIt && curIt.kind === 'video') {
    const effOn = !!(ef && ef.effectIndex != null && EFFECTS.list[ef.effectIndex]);
    const wantBlend = (effOn && userTrackBlend === 'normal') ? 'screen' : userTrackBlend;
    if (wantBlend !== sentTrackBlend) { sentTrackBlend = wantBlend; send({ type: 'trackVideoBlend', value: wantBlend }); }
  }
  const tx = sceneActive('text', t);
  if (tx !== lastScene.text) { lastScene.text = tx; applyTextEl(tx); }
  const im = sceneActive('image', t);
  if (im !== lastScene.image) { lastScene.image = im; applyImageEl(im); }
}
function applyTextEl(el) {
  const show = !!(el && el.text && el.text.trim());
  send({ type: 'tickerText', text: show ? el.text : '' });
  send({ type: 'tickerOn', on: show });
  if (show) {
    send({ type: 'tickerDir', value: el.dir });
    send({ type: 'tickerFx', value: el.fx });
    send({ type: 'tickerFont', value: el.font });
    send({ type: 'tickerSize', value: el.size });
    send({ type: 'tickerWeight', on: el.weight });
    send({ type: 'tickerColor', value: el.color });
    send({ type: 'tickerPos', pos: el.pos });
    send({ type: 'tickerSpeed', mult: el.speed });
  }
}
function applyImageEl(el) {
  if (el && el.image) {
    const p = IMG_POS[el.imagePos || 'center'] || IMG_POS.center;
    send({ type: 'sceneImage', path: el.image, size: el.imageSize || 60, x: p.x, y: p.y });
  } else { send({ type: 'sceneImage', path: null }); }
}
// Live preview: when editing the scene of the current item, re-apply at now.
function refreshScenePreview(i) {
  if (i !== qIndex) return;
  activeCues = (queue[i].cues || []).slice().sort((a, b) => a.time - b.time);
  lastScene = { effect: undefined, text: undefined, image: undefined };
  advanceCues(curCur || 0);
}

// ---- Timed visual segment (gap / interlude), drives the scene with no audio --
let segTimer = null, segMode = null, segDur = 0, segBase = 0, segElapsed = 0, segT0 = 0, segPaused = false, segDone = null;
function clearGap() { if (segTimer) { clearInterval(segTimer); segTimer = null; } segMode = null; segPaused = false; }
function segTick() {
  if (segPaused) return;
  const elapsed = segElapsed + (Date.now() - segT0) / 1000;
  curCur = Math.min(segDur, elapsed); curDur = segDur;
  $('#np-time').textContent = fmt(curCur) + ' / ' + fmt(curDur);
  advanceCues(segBase + elapsed);
  if (elapsed >= segDur) { const d = segDone; clearGap(); if (d) d(); }
}
function runSeg(mode, durSecs, base, onDone) {
  clearGap();
  segMode = mode; segDur = durSecs; segBase = base; segDone = onDone;
  segElapsed = 0; segT0 = Date.now(); segPaused = false;
  segTimer = setInterval(segTick, 200); segTick();
}
function pauseSeg() { if (segTimer && !segPaused) { segElapsed += (Date.now() - segT0) / 1000; segPaused = true; } }
function resumeSeg() { if (segTimer && segPaused) { segT0 = Date.now(); segPaused = false; } }
function startGap(it, secs) { runSeg('gap', secs, curDur || curCur || 0, () => advanceQueue()); }
function playInterlude(it) {
  send({ type: 'playSilence' });
  startCues(it);
  const dur = Math.max(1, it.duration || 15);
  runSeg('interlude', dur, 0, () => { if (it.gap > 0) startGap(it, it.gap); else advanceQueue(); });
}

// Each queue entry is an independent CLONE so its trim/gap/scene don't leak
// back into the shared library object (or other queue rows of the same file).
function enqueue(it) {
  const q = Object.assign({}, it, {
    start: it.start || 0, end: it.end || 0, gap: it.gap || 0,
    cues: (it.cues || []).map((c) => Object.assign({}, c))
  });
  queue.push(q); saveQueue(); return q;
}
function makeInterlude() {
  return { name: 'Intermezzo', url: '', kind: 'interlude', isInterlude: true, duration: 15, gap: 0, cues: [] };
}
let _saveQT = null;
function saveQueue() { clearTimeout(_saveQT); _saveQT = setTimeout(() => djv.saveState('queue', queue), 400); }

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
function advanceQueue() { if (qIndex + 1 < queue.length) playAt(qIndex + 1); else { playing = false; $('#np-play').textContent = '▶'; } }
function afterTrackEnd() {
  const it = queue[qIndex];
  if (it && it.gap > 0) startGap(it, it.gap); // gap: scene keeps running with no audio
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
function mediaIcon(k) { return k === 'video' ? '🎞 ' : (k === 'image' ? '🖼 ' : (k === 'interlude' ? '✨ ' : '🎵 ')); }
function renderLib() {
  const el = $('#lib'); el.innerHTML = '';
  if (!library.length) { el.innerHTML = '<div class="empty">Nessun file. Caricane con ⬆️ o copiali nella cartella <b>media/</b> del dispositivo.</div>'; return; }
  library.forEach((it) => {
    const d = document.createElement('div'); d.className = 'item';
    d.innerHTML = '<span>' + mediaIcon(it.kind) + it.name + '</span>';
    const add = document.createElement('button'); add.textContent = '＋'; add.title = 'In coda';
    add.addEventListener('click', (ev) => { ev.stopPropagation(); enqueue(it); renderQueue(); });
    d.appendChild(add);
    d.addEventListener('click', () => {
      if (assignPad >= 0) { assignToPad(assignPad, it); assignPad = -1; switchTab('pad'); return; }
      if (it.kind === 'image') { send({ type: 'sceneImage', path: it.url, size: 60, x: 50, y: 50 }); return; }
      enqueue(it); playAt(queue.length - 1);
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
    head.innerHTML = '<span>' + mediaIcon(it.kind) + it.name + (hasScene(it) ? ' <em class="scbadge">🎬</em>' : '') + '</span>';
    head.addEventListener('click', () => playAt(i));
    const cog = document.createElement('button'); cog.textContent = '⚙'; cog.title = 'Trim / scena';
    cog.addEventListener('click', (ev) => { ev.stopPropagation(); openDetail = openDetail === i ? -1 : i; renderQueue(); });
    if (it.kind !== 'image') head.appendChild(cog);
    const del = document.createElement('button'); del.textContent = '✕';
    del.addEventListener('click', (ev) => { ev.stopPropagation(); queue.splice(i, 1); if (i < qIndex) qIndex--; if (openDetail === i) openDetail = -1; saveQueue(); renderQueue(); });
    head.appendChild(del);
    card.appendChild(head);

    if (openDetail === i && it.kind !== 'image') {
      const det = document.createElement('div'); det.className = 'qdetail';
      if (it.isInterlude) {
        det.innerHTML = '<div class="qgap">✨ Durata intermezzo <input class="segv" type="number" min="1" step="1" value="' + (it.duration || 15) + '"> s</div>';
        card.appendChild(det);
        det.querySelector('.segv').addEventListener('change', (e) => { it.duration = Math.max(1, parseFloat(e.target.value) || 15); saveQueue(); });
      } else {
        probeDur(it.url); ensureWave(it);
        const dur = durCache[it.url] || (i === qIndex ? curDur : 0);
        const elp = i === qIndex ? Math.max(0, curCur - (it.start || 0)) : 0;
        const tot = Math.max(0, (it.end > 0 ? it.end : dur) - (it.start || 0));
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
        det.querySelector('.here-s').addEventListener('click', () => { if (i === qIndex) { it.start = Math.max(0, curCur); send({ type: 'setTrim', start: it.start, end: it.end || 0 }); saveQueue(); renderQueue(); } });
        det.querySelector('.here-e').addEventListener('click', () => { if (i === qIndex) { it.end = Math.max(0.5, curCur); send({ type: 'setTrim', start: it.start || 0, end: it.end }); saveQueue(); renderQueue(); } });
        det.querySelector('.rst').addEventListener('click', () => { it.start = 0; it.end = 0; if (i === qIndex) send({ type: 'setTrim', start: 0, end: 0 }); saveQueue(); renderQueue(); });
        det.querySelector('.gapv').addEventListener('change', (e) => { it.gap = Math.max(0, parseFloat(e.target.value) || 0); saveQueue(); });
      }
      det.appendChild(buildScene(it, i));
    }
    el.appendChild(card);
  });
}

// Mobile scene editor: a list of timed elements (effect / text / image), each
// with its own appearance time and visible duration. Appended into the detail.
function buildScene(it, i) {
  const cues = it.cues = (it.cues || []); cues.sort((a, b) => a.time - b.time);
  const wrap = document.createElement('div'); wrap.className = 'scene';
  const imgOpts = () => library.filter((x) => x.kind === 'image')
    .map((x) => '<option value="' + x.url + '">' + x.name + '</option>').join('');
  let html = '<div class="sc-title">🎬 Scena a tempo <small>ogni elemento appare al suo tempo · durata 0 = resta</small></div>';
  if (!cues.length) html += '<div class="sc-empty">Nessun elemento. Aggiungi effetto / testo / immagine qui sotto.</div>';
  cues.forEach((c, ci) => {
    html += '<div class="cue cue-' + c.type + '" data-c="' + ci + '">' +
      '<div class="cue-head"><span>' + EL_ICON[c.type] + ' ' + EL_LABEL[c.type] + '</span>' +
      '<span class="cue-at">@</span><input class="cue-time" type="text" value="' + fmt(Math.floor(c.time)) + '" />' +
      '<span>⏱</span><input class="cue-dur" type="number" min="0" step="1" value="' + (c.dur || 0) + '" />' +
      '<button class="cue-del">✕</button></div>';
    if (c.type === 'effect') {
      const ce = (c.effectIndex != null && EFFECTS.list[c.effectIndex]) ? EFFECTS.list[c.effectIndex] : null;
      const cFam = ce ? ce.family : -1;
      html += '<div class="cue-body">' +
        '<div class="cue-row"><select class="cue-eff-fam">' + cueFamilyOptions(cFam) + '</select>' +
        '<select class="cue-eff-pre"' + (cFam < 0 ? ' disabled' : '') + '>' + cuePresetOptions(cFam, c.effectIndex) + '</select></div>' +
        '<div class="cue-row"><button class="cue-eff-cur">🎯 Usa corrente</button><span class="cue-eff-name">' + (ce ? ce.name : 'nessuno') + '</span></div></div>';
    } else if (c.type === 'text') {
      html += '<div class="cue-body"><input class="cue-text" placeholder="Testo da mostrare" />' +
        '<div class="cue-row"><select class="cue-tx-dir">' + optList(TXT_DIRS, c.dir) + '</select><select class="cue-tx-fx">' + optList(TXT_FX, c.fx) + '</select></div>' +
        '<div class="cue-row"><select class="cue-tx-font">' + optList(TXT_FONTS, c.font) + '</select><select class="cue-tx-pos">' + optList(TXT_POS, c.pos) + '</select></div>' +
        '<div class="cue-row"><span>Dim</span><input class="cue-tx-size" type="range" min="2" max="18" step="0.5" value="' + c.size + '" />' +
        '<label class="chk"><input class="cue-tx-bold" type="checkbox"' + (c.weight ? ' checked' : '') + '/>B</label>' +
        '<input class="cue-tx-color" type="color" value="' + c.color + '" /></div>' +
        '<div class="cue-row"><span>Vel</span><input class="cue-tx-speed" type="range" min="0.2" max="4" step="0.1" value="' + c.speed + '" /></div></div>';
    } else {
      html += '<div class="cue-body"><div class="cue-row"><select class="cue-img-sel"><option value="">— scegli immagine —</option>' + imgOpts() + '</select></div>' +
        '<div class="cue-row"><span class="cue-name">' + (c.image ? baseName(c.image) : 'nessuna') + '</span></div>' +
        '<div class="cue-row"><select class="cue-img-pos">' +
        Object.keys(IMG_POS_LABELS).map((p) => '<option value="' + p + '"' + ((c.imagePos || 'center') === p ? ' selected' : '') + '>' + IMG_POS_LABELS[p] + '</option>').join('') +
        '</select><span>Dim</span><input class="cue-img-size" type="range" min="10" max="100" step="1" value="' + (c.imageSize || 60) + '" /></div></div>';
    }
    html += '</div>';
  });
  html += '<div class="sc-foot"><button class="add-eff">➕🌀</button><button class="add-txt">➕🔤</button>' +
    '<button class="add-img">➕🖼</button><button class="sc-clear">🗑 Scena</button></div>';
  wrap.innerHTML = html;

  const save = () => { saveQueue(); refreshScenePreview(i); renderQueue(); };
  const saveLive = () => { saveQueue(); refreshScenePreview(i); };
  wrap.querySelectorAll('.cue').forEach((cueEl) => {
    const ci = parseInt(cueEl.dataset.c, 10); const c = cues[ci];
    cueEl.querySelector('.cue-time').addEventListener('change', (e) => { c.time = parseTime(e.target.value); save(); });
    cueEl.querySelector('.cue-dur').addEventListener('change', (e) => { c.dur = Math.max(0, parseFloat(e.target.value) || 0); saveLive(); });
    cueEl.querySelector('.cue-del').addEventListener('click', () => { cues.splice(ci, 1); save(); });
    if (c.type === 'effect') {
      cueEl.querySelector('.cue-eff-fam').addEventListener('change', (e) => {
        const fam = parseInt(e.target.value, 10);
        if (fam < 0) { c.effectIndex = null; c.effectName = ''; }
        else { const idx = firstPresetOfFamily(fam); c.effectIndex = idx; c.effectName = idx >= 0 ? EFFECTS.list[idx].name : ''; }
        save();
      });
      cueEl.querySelector('.cue-eff-pre').addEventListener('change', (e) => {
        const idx = parseInt(e.target.value, 10);
        if (idx >= 0 && EFFECTS.list[idx]) { c.effectIndex = idx; c.effectName = EFFECTS.list[idx].name; save(); }
      });
      cueEl.querySelector('.cue-eff-cur').addEventListener('click', () => { c.effectIndex = EFFECTS.list.indexOf(curEffect); c.effectName = curEffect.name; save(); });
    } else if (c.type === 'text') {
      const ti = cueEl.querySelector('.cue-text'); ti.value = c.text || '';
      ti.addEventListener('input', (e) => { c.text = e.target.value; saveLive(); });
      cueEl.querySelector('.cue-tx-dir').addEventListener('change', (e) => { c.dir = e.target.value; saveLive(); });
      cueEl.querySelector('.cue-tx-fx').addEventListener('change', (e) => { c.fx = e.target.value; saveLive(); });
      cueEl.querySelector('.cue-tx-font').addEventListener('change', (e) => { c.font = e.target.value; saveLive(); });
      cueEl.querySelector('.cue-tx-pos').addEventListener('change', (e) => { c.pos = e.target.value; saveLive(); });
      cueEl.querySelector('.cue-tx-size').addEventListener('input', (e) => { c.size = parseFloat(e.target.value); saveLive(); });
      cueEl.querySelector('.cue-tx-bold').addEventListener('change', (e) => { c.weight = e.target.checked; saveLive(); });
      cueEl.querySelector('.cue-tx-color').addEventListener('input', (e) => { c.color = e.target.value; saveLive(); });
      cueEl.querySelector('.cue-tx-speed').addEventListener('input', (e) => { c.speed = parseFloat(e.target.value); saveLive(); });
    } else {
      const sel = cueEl.querySelector('.cue-img-sel'); sel.value = c.image || '';
      sel.addEventListener('change', (e) => { c.image = e.target.value || null; save(); });
      cueEl.querySelector('.cue-img-pos').addEventListener('change', (e) => { c.imagePos = e.target.value; saveLive(); });
      cueEl.querySelector('.cue-img-size').addEventListener('input', (e) => { c.imageSize = parseInt(e.target.value, 10); saveLive(); });
    }
  });
  const addEl = (mk) => { const lastT = cues.length ? cues[cues.length - 1].time : 0; cues.push(mk(cues.length ? lastT : 0)); save(); };
  wrap.querySelector('.add-eff').addEventListener('click', () => addEl(newEffectEl));
  wrap.querySelector('.add-txt').addEventListener('click', () => addEl(newTextEl));
  wrap.querySelector('.add-img').addEventListener('click', () => addEl(newImageEl));
  wrap.querySelector('.sc-clear').addEventListener('click', () => { it.cues = []; save(); });
  return wrap;
}
function playAt(i, fromTime) {
  if (i < 0 || i >= queue.length) return;
  clearGap();
  qIndex = i; const it = queue[i]; playing = true;
  $('#np-name').textContent = it.name; $('#np-play').textContent = '⏸';
  $('#nowbar').classList.remove('hidden');
  if (it.isInterlude) { renderQueue(); playInterlude(it); return; }
  probeDur(it.url);
  const startAt = fromTime != null ? Math.max(0, fromTime) : (it.start || 0);
  send({ type: it.kind === 'video' ? 'playVideoTrack' : 'playTrack', path: it.url, start: startAt, end: it.end || 0 });
  startCues(it); // drive the timed scene from playback progress
  renderQueue();
}
$('#np-next').addEventListener('click', () => { if (qIndex + 1 < queue.length) playAt(qIndex + 1); else { clearGap(); advanceQueue(); } });
$('#np-prev').addEventListener('click', () => { if (qIndex > 0) playAt(qIndex - 1); });
$('#np-play').addEventListener('click', () => {
  if (segTimer) { // a gap/interlude segment is running: pause/resume it locally
    if (segPaused) resumeSeg(); else pauseSeg();
    $('#np-play').textContent = segPaused ? '▶' : '⏸';
  } else send({ type: 'togglePlay' });
});
$('#add-interlude').addEventListener('click', () => { queue.push(makeInterlude()); openDetail = queue.length - 1; saveQueue(); renderQueue(); });
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
djv.loadState('queue').then((s) => { if (Array.isArray(s) && s.length) { queue = s; renderQueue(); } });

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

// ---- Sorgente audio (file vs ingresso live USB) ----------------------------
let inputDevices = [];
function renderAudioSrc(selId) {
  const sel = $('#audio-src'); if (!sel) return;
  const cur = selId != null ? selId : sel.value;
  sel.innerHTML = '<option value="">🎵 File / Playlist</option>' +
    inputDevices.map((d) => '<option value="' + d.deviceId + '">🎚 ' + (d.label || 'Ingresso ' + d.deviceId.slice(0, 6)) + '</option>').join('');
  sel.value = cur;
  const hint = $('#audio-src-hint');
  if (hint) hint.textContent = inputDevices.length
    ? inputDevices.length + ' ingresso/i rilevato/i. Scegli la scheda USB: i visual reagiranno alla sorgente (l\'audio resta sul mixer).'
    : 'Nessun ingresso rilevato. Collega una scheda audio USB al Pi, poi premi ↻ Rileva.';
}
$('#audio-src').addEventListener('change', (e) => {
  const id = e.target.value;
  if (id) { send({ type: 'useInput', deviceId: id }); $('#now').textContent = 'Ingresso live'; }
  else { send({ type: 'playSilence' }); } // back to file: stops the live input
});
$('#audio-src-refresh').addEventListener('click', () => send({ type: 'refreshDevices' }));
send({ type: 'refreshDevices' }); // ask the output for the current input device list

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

// Power: reboot / shutdown the Pi. Two-tap confirm to avoid accidental taps.
function armPower(btnId, action) {
  const btn = $('#' + btnId); if (!btn) return;
  const orig = btn.textContent; let armed = false, t = null;
  btn.addEventListener('click', () => {
    if (!armed) {
      armed = true; btn.classList.add('armed'); btn.textContent = '⚠️ Tocca per confermare';
      t = setTimeout(() => { armed = false; btn.classList.remove('armed'); btn.textContent = orig; }, 4000);
      return;
    }
    clearTimeout(t); armed = false; btn.classList.remove('armed'); btn.textContent = orig;
    $('#pw-status').textContent = action === 'reboot' ? '🔄 Riavvio in corso… il telecomando si riconnette da solo tra ~40s.' : '⏻ Spegnimento in corso… per riaccendere stacca e riattacca l\'alimentazione.';
    fetch('/api/power/' + action, { method: 'POST' }).catch(() => {});
  });
}
armPower('pw-reboot', 'reboot');
armPower('pw-shutdown', 'shutdown');

// ---- Reports ---------------------------------------------------------------
function setMeter(id, v) { const e = $('#' + id); if (e) e.style.width = Math.min(100, (v || 0) * 100) + '%'; }
djv.onReport((m) => {
  switch (m.type) {
    case 'progress':
      if (segTimer) break; // a gap/interlude segment drives time itself
      curCur = m.currentTime; curDur = m.duration;
      $('#np-time').textContent = fmt(curCur) + ' / ' + fmt(curDur);
      if (curDur > 0) $('#seek').value = Math.round(curCur / curDur * 1000);
      if (qIndex >= 0) advanceCues(curCur); // drive the timed scene
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
    case 'autoVj': setAutoVj(m); break;
    case 'devices': inputDevices = m.list || []; renderAudioSrc(); break;
    case 'recState': recOn = m.recording; updateRec(); break;
    case 'recSaved': $('#rec-status').textContent = '✅ Salvato: ' + m.path; break;
    case 'recError': $('#rec-status').textContent = '⚠️ ' + m.message; break;
  }
});

function switchTab(tab) { const b = document.querySelector('#tabs button[data-tab="' + tab + '"]'); if (b) b.click(); }
renderPads();
