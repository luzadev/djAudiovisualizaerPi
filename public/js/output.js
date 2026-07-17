// OUTPUT window: renders the visuals + overlays and runs the audio engine.
// It receives commands from the control window via window.djv.onControl and
// sends back reports (meters, fps, device list, play state).

const $ = (s) => document.querySelector(s);

const canvas = $('#gl');
let viz;
try {
  viz = new Visualizer(canvas);
  try {
    const gl = canvas.getContext('webgl2');
    const d = gl && gl.getExtension('WEBGL_debug_renderer_info');
    djv.report({ type: 'gpuInfo', webgl2: !!gl, renderer: d ? gl.getParameter(d.UNMASKED_RENDERER_WEBGL) : (gl && gl.getParameter(gl.RENDERER)) });
  } catch (e2) {}
} catch (e) {
  djv.report({ type: 'gpuInfo', webgl2: false, message: e.message });
  document.body.innerHTML = '<div style="color:#fff;padding:40px;font-family:sans-serif">' +
    'Errore grafica:<br><pre>' + e.message + '</pre></div>';
  throw e;
}

const audio = new AudioEngine();
let speed = 1.0;

// In the Pi/web build, paths are already server URLs (e.g. /media/song.mp3),
// so they can be used directly as the resource URL.
function toFileURL(p) {
  return p;
}

// ---------------------------------------------------------------- overlays
const imgLayer = $('#overlay-images');
let images = [];
let imgIndex = 0;
let slideshow = false, slideshowTimer = null, slideshowMs = 5000;
let beatPulse = true;
let imgBlend = 'screen';

function addImages(paths) {
  paths.forEach(p => {
    const img = document.createElement('img');
    img.src = toFileURL(p);
    img.style.mixBlendMode = imgBlend;
    imgLayer.appendChild(img);
    images.push(img);
  });
  if (images.length) showImage(images.length - paths.length);
  hideHint();
}
function showImage(i) {
  if (!images.length) return;
  imgIndex = (i + images.length) % images.length;
  images.forEach((im, idx) => im.classList.toggle('show', idx === imgIndex));
}
function clearImages() {
  images.forEach(im => im.remove());
  images = []; imgIndex = 0;
}
function restartSlideshow() {
  if (slideshowTimer) { clearInterval(slideshowTimer); slideshowTimer = null; }
  if (slideshow) slideshowTimer = setInterval(() => showImage(imgIndex + 1), slideshowMs);
}

// ---------------------------------------------------------------- recording
// Records the output canvas (video) + the audio tap into a WebM stream that
// main transcodes to MP4 at the chosen aspect ratio.
let recorder = null, recording = false, pendingRecOpts = null;
let recCanvas = null, recCtx = null, composeRAF = null;

function pickMime() {
  const cands = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
  for (const m of cands) if (window.MediaRecorder && MediaRecorder.isTypeSupported(m)) return m;
  return 'video/webm';
}

// Composite the WebGL visual + DOM overlays (images, logos, ticker) into a 2D
// canvas so the recording captures everything that's on screen, not just WebGL.
function drawMediaFit(ctx, media, W, H, fit) {
  const mw = media.videoWidth || media.naturalWidth, mh = media.videoHeight || media.naturalHeight;
  if (!mw || !mh) { ctx.drawImage(media, 0, 0, W, H); return; }
  const scale = fit === 'contain' ? Math.min(W / mw, H / mh) : Math.max(W / mw, H / mh);
  const dw = mw * scale, dh = mh * scale;
  ctx.drawImage(media, (W - dw) / 2, (H - dh) / 2, dw, dh);
}

function composeFrame() {
  const W = recCanvas.width, H = recCanvas.height;
  const sx = W / window.innerWidth, sy = H / window.innerHeight;
  recCtx.globalAlpha = 1;
  recCtx.globalCompositeOperation = 'source-over';
  recCtx.clearRect(0, 0, W, H);
  recCtx.drawImage(canvas, 0, 0, W, H);

  if (bgVideo.classList.contains('show') && bgVideo.readyState >= 2 && bgVideo.videoWidth) {
    recCtx.globalAlpha = parseFloat(getComputedStyle(bgVideo).opacity) || 1;
    const bm = bgVideo.style.mixBlendMode;
    recCtx.globalCompositeOperation = (bm && bm !== 'normal') ? bm : 'source-over';
    try { drawMediaFit(recCtx, bgVideo, W, H, bgVideo.style.objectFit || 'cover'); } catch (e) {}
    recCtx.globalAlpha = 1;
    recCtx.globalCompositeOperation = 'source-over';
  }

  if (trackVideo.classList.contains('show') && trackVideo.readyState >= 2 && trackVideo.videoWidth) {
    recCtx.globalAlpha = parseFloat(getComputedStyle(trackVideo).opacity) || 1;
    const bm = trackVideo.style.mixBlendMode;
    recCtx.globalCompositeOperation = (bm && bm !== 'normal') ? bm : 'source-over';
    try { drawMediaFit(recCtx, trackVideo, W, H, trackVideo.style.objectFit || 'contain'); } catch (e) {}
    recCtx.globalAlpha = 1;
    recCtx.globalCompositeOperation = 'source-over';
  }

  for (const im of images) {
    if (!im.classList.contains('show')) continue;
    const r = im.getBoundingClientRect();
    recCtx.globalAlpha = parseFloat(getComputedStyle(im).opacity) || 1;
    const bm = im.style.mixBlendMode;
    recCtx.globalCompositeOperation = (bm && bm !== 'normal') ? bm : 'source-over';
    try { recCtx.drawImage(im, r.x * sx, r.y * sy, r.width * sx, r.height * sy); } catch (e) {}
  }
  recCtx.globalAlpha = 1;
  recCtx.globalCompositeOperation = 'source-over';

  if (sceneImage.classList.contains('show') && sceneImage.src) {
    const r = sceneImage.getBoundingClientRect();
    try { recCtx.drawImage(sceneImage, r.x * sx, r.y * sy, r.width * sx, r.height * sy); } catch (e) {}
  }

  for (const l of logos) {
    if (!l.classList.contains('show')) continue;
    const r = l.getBoundingClientRect();
    recCtx.globalAlpha = parseFloat(l.style.opacity || '1');
    try { recCtx.drawImage(l, r.x * sx, r.y * sy, r.width * sx, r.height * sy); } catch (e) {}
  }
  recCtx.globalAlpha = 1;

  if (ticker.classList.contains('show') || sideText.classList.contains('show')) {
    recCtx.textBaseline = 'middle';
    for (const span of tickerLetters()) {
      const txt = span.textContent;
      if (!txt || txt === ' ') continue;
      const r = span.getBoundingClientRect();
      if (r.right < 0 || r.left > window.innerWidth) continue;
      const cs = getComputedStyle(span);
      recCtx.globalAlpha = parseFloat(cs.opacity) || 1;
      recCtx.font = cs.fontWeight + ' ' + (parseFloat(cs.fontSize) * sy) + 'px ' + cs.fontFamily;
      recCtx.fillStyle = cs.color;
      recCtx.shadowColor = 'rgba(140,180,255,0.9)';
      recCtx.shadowBlur = 14 * sy;
      recCtx.fillText(txt, r.x * sx, (r.y + r.height / 2) * sy);
      recCtx.shadowBlur = 0;
    }
    recCtx.globalAlpha = 1;
  }
  composeRAF = requestAnimationFrame(composeFrame);
}

function stopCompose() {
  if (composeRAF) { cancelAnimationFrame(composeRAF); composeRAF = null; }
}

async function startRecording() {
  if (recording) return;
  try {
    await djv.recStart();
    recCanvas = document.createElement('canvas');
    recCanvas.width = canvas.width;
    recCanvas.height = canvas.height;
    recCtx = recCanvas.getContext('2d');
    composeFrame();
    const vstream = recCanvas.captureStream(30);
    const astream = audio.recordDest.stream;
    const stream = new MediaStream([...vstream.getVideoTracks(), ...astream.getAudioTracks()]);
    recorder = new MediaRecorder(stream, { mimeType: pickMime(), videoBitsPerSecond: 12e6 });
    // Serialise chunk delivery: ondataavailable is async, so without a chain the
    // header chunk could be sent after a later one and corrupt the WebM.
    let chain = Promise.resolve();
    recorder.ondataavailable = (e) => {
      if (!e.data || !e.data.size) return;
      chain = chain.then(async () => djv.recChunk(new Uint8Array(await e.data.arrayBuffer())));
    };
    recorder.onstop = async () => {
      stopCompose();
      await chain; // ensure every chunk is flushed, in order, before muxing
      const res = await djv.recStop(pendingRecOpts || {});
      recording = false;
      djv.report({ type: 'recState', recording: false });
      if (res && res.ok) djv.report({ type: 'recSaved', path: res.path });
      else djv.report({ type: 'recError', message: (res && res.error) || 'errore sconosciuto' });
    };
    recorder.start(2000); // emit a chunk every 2s
    recording = true;
    djv.report({ type: 'recState', recording: true });
  } catch (e) {
    stopCompose();
    djv.report({ type: 'recError', message: e.message });
  }
}

function stopRecording(opts) {
  if (!recording || !recorder) return;
  pendingRecOpts = { w: opts && opts.w, h: opts && opts.h };
  recorder.stop();
}

// Custom SVG/image source for the "SVG/Immagine" effect family. The image
// arrives as a data: URL (same-origin) so the canvas isn't tainted and the
// pixels can be uploaded to a WebGL texture.
function loadCustomTexture(dataUrl) {
  const img = new Image();
  img.onload = () => {
    const size = 1024;
    const cv = document.createElement('canvas');
    cv.width = cv.height = size;
    const ctx = cv.getContext('2d');
    const iw = img.width || 512, ih = img.height || 512;
    const s = Math.min(size / iw, size / ih);
    const w = iw * s, h = ih * s;
    ctx.clearRect(0, 0, size, size);
    ctx.drawImage(img, (size - w) / 2, (size - h) / 2, w, h);
    try { viz.setTexture(cv); hideHint(); }
    catch (e) { djv.report({ type: 'error', message: 'Texture SVG: ' + e.message }); }
  };
  img.onerror = () => djv.report({ type: 'error', message: 'SVG/immagine non caricata' });
  img.src = dataUrl;
}

const bgVideo = $('#bg-video');
const trackVideo = $('#track-video');
const sceneImage = $('#scene-image');

// Two independent logos.
const logos = [$('#logo-0'), $('#logo-1')];
function setLogo(i, url) {
  if (!logos[i]) return;
  if (url) { logos[i].src = url; logos[i].classList.add('show'); hideHint(); }
  else { logos[i].classList.remove('show'); logos[i].removeAttribute('src'); }
}

const ticker = $('#ticker');
const tickerTrack = $('#ticker-track');
const tickCopies = ticker.querySelectorAll('.tick-copy');
const sideText = $('#side-text');
const sideCopies = sideText.querySelectorAll('.side-copy');
let tickerVisible = false, tickerDir = 'h';
function buildLetters(txt) {
  const full = (txt || '') + '   •   ';
  let html = '';
  for (let i = 0; i < full.length; i++) {
    const c = full[i];
    const ch = c === ' ' ? ' ' : c.replace(/&/g, '&amp;').replace(/</g, '&lt;');
    html += '<span class="tl" style="--i:' + i + '">' + ch + '</span>';
  }
  return html;
}
function setTickerText(t) {
  const h = buildLetters(t);
  tickCopies.forEach(c => c.innerHTML = h);
  sideCopies.forEach(c => c.innerHTML = h);
}
function setTickerSpeed(m) { document.documentElement.style.setProperty('--ticker-dur', (18 / m) + 's'); }
function tickerLetters() {
  let out = [];
  if (ticker.classList.contains('show')) out = out.concat([...tickerTrack.querySelectorAll('.tl')]);
  if (sideText.classList.contains('show')) out = out.concat([...sideText.querySelectorAll('.tl')]);
  return out;
}
function styleBoth(prop, value) { tickerTrack.style[prop] = value; sideText.style[prop] = value; }
function updateTickerVis() {
  const sides = tickerDir === 'sides';
  ticker.classList.toggle('show', tickerVisible && !sides);
  sideText.classList.toggle('show', tickerVisible && sides);
}
ticker.classList.add('pos-bottom');
ticker.classList.add('dir-h');
setTickerSpeed(1);

function hideHint() { $('#drop-hint').classList.add('hidden'); }

// ---------------------------------------------------------------- audio devices
// Probe duration (metadata only) for a list of file paths.
function probeDurations(paths) {
  if (!paths.length) return;
  const results = [];
  let pending = paths.length;
  const finish = () => { if (--pending === 0) djv.report({ type: 'durations', list: results }); };
  paths.forEach(p => {
    // A <video> element reads duration for both audio and video files.
    const a = document.createElement('video');
    a.preload = 'metadata'; a.muted = true;
    let done = false;
    const ok = (dur) => { if (done) return; done = true; results.push({ path: p, duration: isFinite(dur) && dur > 0 ? dur : 0 }); finish(); };
    a.onloadedmetadata = () => ok(a.duration);
    a.onerror = () => ok(0);
    setTimeout(() => ok(0), 6000); // never hang if metadata never fires
    a.src = toFileURL(p);
    a.load(); // some Chromium builds need an explicit load() for detached media
  });
}

async function reportDevices() {
  // Always answer, even with an empty list: getUserMedia can hang/reject when no
  // input device exists (e.g. before a USB sound card is plugged in), so guard
  // each probe with a timeout and still report so the control UI isn't left hanging.
  const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);
  let inputs = [];
  try { inputs = await withTimeout(audio.listInputDevices(), 3000); } catch (e) { /* none/blocked */ }
  djv.report({ type: 'devices', list: inputs.map(d => ({ deviceId: d.deviceId, label: d.label })) });
  let outputs = [];
  try { outputs = await withTimeout(audio.listOutputDevices(), 3000); } catch (e) { /* none/blocked */ }
  djv.report({ type: 'outputs', list: outputs.map(d => ({ deviceId: d.deviceId, label: d.label })) });
}

// ---------------------------------------------------------------- command bus
djv.onControl(async (m) => {
  switch (m.type) {
    case 'effect':
      // A manual pick takes over from the Auto VJ.
      if (autoVj) { autoVj = false; djv.report({ type: 'autoVj', on: false }); }
      viz.setEffect(m.effect);
      break;
    case 'autoVj':
      autoVj = !!m.on;
      if (autoVj) { avLastSwitch = 0; avBeatMark = audio.beatCount || 0; }
      djv.report({ type: 'autoVj', on: autoVj });
      break;
    case 'svg': loadCustomTexture(m.dataUrl); break;
    case 'recStart': startRecording(); break;
    case 'recStop': stopRecording(m); break;
    case 'gain': audio.gain = m.value; break;
    case 'speed': speed = m.value; audio.scrollRate = m.value; break;
    case 'bandGain': audio[m.band + 'Gain'] = m.value; break;
    case 'outputDevice':
      try { await audio.setOutputDevice(m.deviceId || ''); }
      catch (e) { djv.report({ type: 'error', message: e.message }); }
      break;

    case 'loadFile':
      try {
        await audio.loadFile(toFileURL(m.path));
        hideHint();
        djv.report({ type: 'fileLoaded' });
        djv.report({ type: 'playState', playing: true });
      } catch (e) { djv.report({ type: 'error', message: e.message }); }
      break;
    case 'playTrack':
      try {
        // Switching to an audio track: stop/hide any playing video track.
        trackVideo.pause(); trackVideo.classList.remove('show');
        audio.setTrim(m.start || 0, m.end || 0);
        audio.onEnded = () => djv.report({ type: 'trackEnded' });
        await audio.loadFile(toFileURL(m.path), { loop: false, crossfade: m.crossfade || 0 });
        hideHint();
        djv.report({ type: 'playState', playing: true });
      } catch (e) { djv.report({ type: 'error', message: e.message }); }
      break;
    case 'diag':
      djv.report({ type: 'diag', stage: 'poll', ctx: audio.ctx.state, mode: audio.mode });
      break;
    case 'playVideoTrack':
      try {
        audio.setTrim(m.start || 0, m.end || 0);
        audio.onEnded = () => djv.report({ type: 'trackEnded' });
        audio.attachVideo(trackVideo);
        trackVideo.loop = false; trackVideo.muted = false;
        // Force a fresh start even when re-selecting the same file:
        // reassigning the same src may not reload, so pause + load() resets it.
        trackVideo.pause();
        trackVideo.src = toFileURL(m.path);
        trackVideo.load();
        trackVideo.classList.add('show');
        await trackVideo.play();
        audio.seekToTrimStart(trackVideo);
        hideHint();
        djv.report({ type: 'playState', playing: true });
      } catch (e) { djv.report({ type: 'error', message: e.message }); }
      break;
    case 'playSilence':
      // Visual-only interlude: stop audio + hide the video, keep visuals going.
      try {
        trackVideo.pause(); trackVideo.classList.remove('show');
        audio.onEnded = null;
        audio.silence();
        hideHint();
        djv.report({ type: 'playState', playing: true });
      } catch (e) { djv.report({ type: 'error', message: e.message }); }
      break;
    case 'setTrim': audio.setTrim(m.start || 0, m.end || 0); break;
    case 'seek': {
      const el = audio.mediaEl;
      if (el && isFinite(el.duration) && el.duration > 0) {
        el.currentTime = Math.max(0, Math.min(el.duration - 0.05, m.time || 0));
        audio._trimFired = false; // re-arm the trim-end check after seeking
      }
      break;
    }
    case 'probeDurations': probeDurations(m.paths || []); break;
    case 'togglePlay': {
      const playing = audio.togglePlay();
      if (playing !== null) djv.report({ type: 'playState', playing });
      break;
    }
    case 'useInput':
      try { await audio.useInput(m.deviceId || null); hideHint(); await reportDevices(); }
      catch (e) { djv.report({ type: 'error', message: e.message }); }
      break;
    case 'refreshDevices': reportDevices(); break;

    case 'addImages': addImages(m.paths); break;
    case 'clearImages': clearImages(); break;
    case 'imgBlend': imgBlend = m.value; images.forEach(im => im.style.mixBlendMode = m.value); break;
    case 'slideshow': slideshow = m.on; restartSlideshow(); break;
    case 'slideshowInterval': slideshowMs = m.ms; restartSlideshow(); break;
    case 'imgSize': imgLayer.style.setProperty('--img-size', m.value); break;
    case 'imgBeat': beatPulse = m.on; break;
    case 'imgNext': showImage(imgIndex + 1); break;
    case 'imgPrev': showImage(imgIndex - 1); break;

    case 'videoLoad':
      bgVideo.src = toFileURL(m.path);
      bgVideo.loop = true; bgVideo.muted = true;
      bgVideo.classList.add('show');
      bgVideo.play().catch(() => {});
      hideHint();
      break;
    case 'videoToggle':
      if (bgVideo.paused) bgVideo.play().catch(() => {}); else bgVideo.pause();
      break;
    case 'videoClear':
      bgVideo.pause(); bgVideo.removeAttribute('src'); bgVideo.load();
      bgVideo.classList.remove('show');
      break;
    case 'videoOpacity': bgVideo.style.opacity = m.value; break;
    case 'videoFit': bgVideo.style.objectFit = m.value; break;
    case 'videoBlend': bgVideo.style.mixBlendMode = m.value; break;
    case 'trackVideoBlend': trackVideo.style.mixBlendMode = m.value; break;
    case 'trackVideoOpacity': trackVideo.style.opacity = m.value; break;
    case 'trackVideoFit': trackVideo.style.objectFit = m.value; break;

    case 'sceneImage':
      if (m.path) {
        sceneImage.src = toFileURL(m.path);
        const s = m.size || 60;
        sceneImage.style.maxWidth = s + 'vw';
        sceneImage.style.maxHeight = s + 'vh';
        sceneImage.style.left = (m.x != null ? m.x : 50) + '%';
        sceneImage.style.top = (m.y != null ? m.y : 50) + '%';
        sceneImage.classList.add('show'); hideHint();
      } else { sceneImage.classList.remove('show'); sceneImage.removeAttribute('src'); }
      break;
    case 'logo': setLogo(m.index, m.path ? toFileURL(m.path) : ''); break;
    case 'logoX': logos[m.index].style.left = m.value + '%'; break;
    case 'logoY': logos[m.index].style.top = m.value + '%'; break;
    case 'logoSize': logos[m.index].style.width = m.value + 'vw'; break;
    case 'logoOpacity': logos[m.index].style.opacity = m.value; break;

    case 'tickerText': setTickerText(m.text); break;
    case 'tickerOn': tickerVisible = m.on; updateTickerVis(); break;
    case 'tickerPos':
      ticker.classList.remove('pos-bottom', 'pos-top', 'pos-middle');
      ticker.classList.add('pos-' + m.pos);
      break;
    case 'tickerSpeed': setTickerSpeed(m.mult); break;
    case 'tickerDir':
      tickerDir = m.value;
      if (m.value !== 'sides') {
        ticker.classList.remove('dir-h', 'dir-vup', 'dir-vdown');
        ticker.classList.add('dir-' + m.value);
      }
      updateTickerVis();
      break;
    case 'tickerFont': styleBoth('fontFamily', m.value); break;
    case 'tickerSize': styleBoth('fontSize', m.value + 'vh'); break;
    case 'tickerWeight': styleBoth('fontWeight', m.on ? '800' : '400'); break;
    case 'tickerColor': styleBoth('color', m.value); break;
    case 'tickerFx':
      [tickerTrack, sideText].forEach(el => {
        el.classList.remove('fx-updown', 'fx-wave', 'fx-zoom', 'fx-flash', 'fx-rotate');
        if (m.value && m.value !== 'none') el.classList.add('fx-' + m.value);
      });
      break;
  }
});

// ---------------------------------------------------------------- render loop
const startTime = performance.now();
let frames = 0, fpsT = performance.now(), fps = 0, lastReport = 0, prevBeat = 0, lastProgress = 0;

// ---- Auto VJ: a director that adapts the visuals to the playing track ------
// Uses the engine's musical features (mood/bpm/drop/beatCount): switches preset
// every 16 beats (or ~14s without beats), immediately on a detected drop, and
// draws from pools of families that fit the current mood.
let autoVj = false, avLastSwitch = 0, avBeatMark = 0, avRecent = [];
const AV_POOLS = {
  quiet: ['Cielo', 'Aurora', 'Mare', 'Montagne', 'Galassia', 'Nuvole', 'Fluido', 'Onde'],
  groove: ['Plasma', 'Vortice', 'Truchet', 'Esagoni', 'Spirale', 'Cellule', 'Gyroide',
    'Fluido', 'Fluido Onda', 'Fluido Vortici', 'Griglia Neon', 'Solidi 3D'],
  peak: ['Julia', 'Iperspazio', 'Tunnel', 'Moiré', 'Fluido Anello', 'Fluido Fuoco',
    'Vortice', 'Griglia Neon', 'Cristalli']
};
function avPick(mood) {
  const fams = AV_POOLS[mood] || AV_POOLS.groove;
  const cands = window.EFFECTS.list.filter(e => fams.indexOf(e.familyName) >= 0 &&
    (mood === 'peak' ? e.speed >= 1.0 : e.speed <= 1.4) && avRecent.indexOf(e.name) < 0);
  const e = cands.length ? cands[Math.floor(Math.random() * cands.length)] : window.EFFECTS.list[0];
  avRecent = [e.name].concat(avRecent).slice(0, 6); // don't repeat the last few
  return e;
}
function avTick(now) {
  if (!autoVj) return;
  const dropNow = audio.drop === 1;
  const due = (audio.beatCount - avBeatMark) >= 16 || (now - avLastSwitch) > 14000;
  if (!due && !dropNow) return;
  avBeatMark = audio.beatCount; avLastSwitch = now;
  const mood = dropNow ? 'peak' : audio.mood;
  const e = avPick(mood);
  viz.setEffect(e);
  djv.report({ type: 'autoVj', on: true, name: e.name, mood, bpm: audio.bpm || 0 });
}

function frame() {
  const t = (performance.now() - startTime) / 1000;
  audio.update();
  const a = audio.values;
  avTick(performance.now());
  viz.render(t * speed, a);

  // Report beat rising-edges so the control window can auto-cycle effects.
  if (a.beat > 0.6 && prevBeat <= 0.6) djv.report({ type: 'beat' });
  prevBeat = a.beat;

  // Overlays react to audio.
  imgLayer.style.setProperty('--beat-scale',
    (beatPulse && images.length ? 1 + a.beat * 0.12 + a.bass * 0.05 : 1).toFixed(3));
  tickerTrack.style.setProperty('--ticker-glow', (a.level * 24 + a.beat * 20).toFixed(0) + 'px');

  // FPS + meter report to the control window (throttled to ~15 Hz).
  frames++;
  const now = performance.now();
  if (now - fpsT > 500) { fps = frames * 1000 / (now - fpsT); frames = 0; fpsT = now; }
  if (now - lastReport > 66) {
    lastReport = now;
    djv.report({ type: 'meters', bass: a.bass, mid: a.mid, treble: a.treble, fps });
  }
  // Stop at the trim end point if one is set.
  audio.checkTrim();
  // Playback progress for the currently playing file.
  if (now - lastProgress > 400) {
    lastProgress = now;
    const el = audio.mediaEl;
    if (el && !el.paused && isFinite(el.duration) && el.duration > 0) {
      djv.report({ type: 'progress', currentTime: el.currentTime, duration: el.duration });
    }
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// Populate the device list once at startup so the control dropdown fills in.
reportDevices();
