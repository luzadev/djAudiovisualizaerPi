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
    const d = document.createElement('div'); d.className = 'item' + (i === qIndex ? ' active' : '');
    d.innerHTML = '<span>' + mediaIcon(it.kind) + it.name + '</span>';
    const del = document.createElement('button'); del.textContent = '✕';
    del.addEventListener('click', (ev) => { ev.stopPropagation(); queue.splice(i, 1); if (i < qIndex) qIndex--; renderQueue(); });
    d.appendChild(del);
    d.addEventListener('click', () => playAt(i));
    el.appendChild(d);
  });
}
function playAt(i) {
  if (i < 0 || i >= queue.length) return;
  qIndex = i; const it = queue[i]; playing = true;
  send({ type: it.kind === 'video' ? 'playVideoTrack' : 'playTrack', path: it.url, start: 0, end: 0 });
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
  const fd = new FormData(); [...e.target.files].forEach((f) => fd.append('files', f));
  $('#media-upload-btn').textContent = '⏳ Carico…';
  fetch('/api/upload', { method: 'POST', body: fd }).then(() => { e.target.value = ''; $('#media-upload-btn').textContent = '⬆️ Carica file'; loadLibrary(); });
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
      break;
    case 'playState':
      playing = m.playing; $('#np-play').textContent = playing ? '⏸' : '▶';
      break;
    case 'trackEnded':
      if (qIndex >= 0 && qIndex + 1 < queue.length) playAt(qIndex + 1);
      else { playing = false; $('#np-play').textContent = '▶'; }
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
