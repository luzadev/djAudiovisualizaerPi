// Audio engine: builds a Web Audio graph from either a loaded file or a live
// input device, runs an FFT analyser, and exposes smoothed bass/mid/treble/
// level values plus a simple beat detector.

class AudioEngine {
  constructor() {
    this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    this.analyser.smoothingTimeConstant = 0.78;
    this.freq = new Uint8Array(this.analyser.frequencyBinCount);

    // Output gain so a loaded file is audible; live input stays muted to
    // avoid feedback (it's already playing through the system).
    this.outGain = this.ctx.createGain();
    this.outGain.gain.value = 1.0;
    this.outGain.connect(this.ctx.destination);

    // Tap for recording: every source also feeds this destination so the
    // recorder captures file playback and live input alike.
    this.recordDest = this.ctx.createMediaStreamDestination();
    // Silent keep-alive so the audio track always produces frames (otherwise,
    // with no source connected, the recorder stalls with empty data).
    try {
      const keep = this.ctx.createConstantSource();
      keep.offset.value = 0;
      keep.connect(this.recordDest);
      keep.start();
    } catch (e) { /* ConstantSource unsupported: live/file audio still flows */ }

    this.sourceNode = null;   // current MediaElement / MediaStream source
    this.sourceGain = null;   // per-source gain (for crossfades)
    this.mediaEl = null;      // <audio> element when playing a file
    this.stream = null;       // MediaStream when using live input
    this.mode = 'none';
    this.onEnded = null;      // callback fired when a (non-looping) track ends
    this.trimStart = 0;       // playback start point (s); seek here on load
    this.trimEnd = 0;         // playback end point (s); 0 = play to the natural end
    this._trimFired = false;
    this._videoSrc = null;    // persistent source for the playlist video element
    this._videoGain = null;
    this._videoSrcEl = null;

    // Smoothed band values and beat state.
    this.gain = 1.0;          // master reactivity multiplier
    this.bassGain = 1.0;      // per-band visual intensity
    this.midGain = 1.0;
    this.trebleGain = 1.0;
    this.bass = 0; this.mid = 0; this.treble = 0; this.level = 0;
    this.beat = 0;
    this._bassAvg = 0;        // running average for beat detection
    this._beatCooldown = 0;

    // Log-spaced spectrum for VU/bar visualisers.
    this.NB = 32;
    this.spectrum = new Float32Array(this.NB);

    // Time-domain waveform (oscilloscope), -1..1.
    this.NW = 256;
    this.wave = new Float32Array(this.NW);
    this.timeData = new Uint8Array(this.analyser.fftSize);

    // Scrolling amplitude history (song-style waveform envelope).
    this.NH = 256;
    this.waveHist = new Float32Array(this.NH);
    this.histPeak = 0;
    this.histAccum = 0;
    this.PUSH_EVERY = 2.4;   // frames between samples at scrollRate 1 (~40ms)
    this.scrollRate = 1;     // tied to the visual speed slider
  }

  resume() { if (this.ctx.state === 'suspended') this.ctx.resume(); }

  // Trim the current/next track to [start, end] seconds (end 0 = natural end).
  setTrim(start, end) {
    this.trimStart = Math.max(0, start || 0);
    this.trimEnd = Math.max(0, end || 0);
    this._trimFired = false;
  }
  // Seek a freshly-loaded media element to the trim start (waits for metadata).
  seekToTrimStart(el) {
    const go = () => { if (this.trimStart > 0) { try { el.currentTime = this.trimStart; } catch (e) {} } };
    if (el.readyState >= 1) go(); else el.addEventListener('loadedmetadata', go, { once: true });
  }
  // Called every frame from the output loop: stop at the trim end point.
  checkTrim() {
    const el = this.mediaEl;
    if (!el || el.paused || this._trimFired) return;
    if (this.trimEnd > 0 && el.currentTime >= this.trimEnd) {
      this._trimFired = true;
      try { el.pause(); } catch (e) {}
      if (this.onEnded) this.onEnded();
    }
  }

  // Stop any current audio/video source but keep the context & analyser alive
  // (meters read 0, recording keep-alive continues). Used for visual-only
  // playlist interludes.
  silence() {
    this.resume();
    this._disconnectSource();
    this.mediaEl = null;
    this.mode = 'silence';
  }

  _disconnectSource() {
    if (this.sourceNode) { try { this.sourceNode.disconnect(); } catch (e) {} this.sourceNode = null; }
    if (this.sourceGain) { try { this.sourceGain.disconnect(); } catch (e) {} this.sourceGain = null; }
    if (this.mediaEl) { this.mediaEl.pause(); this.mediaEl.src = ''; this.mediaEl = null; }
    if (this.stream) { this.stream.getTracks().forEach(t => t.stop()); this.stream = null; }
  }

  // Play a File/Blob, or a src URL (e.g. file://…), through the analyser and
  // the speakers. opts.loop controls looping; opts.crossfade (ms) fades the
  // previous file out while the new one fades in.
  async loadFile(fileOrSrc, opts = {}) {
    this.resume();
    const fadeMs = Math.max(0, opts.crossfade || 0);

    const el = new Audio();
    el.src = typeof fileOrSrc === 'string' ? fileOrSrc : URL.createObjectURL(fileOrSrc);
    el.loop = opts.loop !== undefined ? opts.loop : true;
    el.crossOrigin = 'anonymous';
    el.onended = () => { if (this.onEnded) this.onEnded(); };

    const src = this.ctx.createMediaElementSource(el);
    const g = this.ctx.createGain();
    src.connect(g);
    g.connect(this.analyser);
    g.connect(this.outGain);       // audible
    g.connect(this.recordDest);    // captured by the recorder

    if (fadeMs > 0 && this.mediaEl && this.mode === 'file' && this.sourceGain) {
      const now = this.ctx.currentTime, dur = fadeMs / 1000;
      g.gain.setValueAtTime(0.0001, now);
      g.gain.linearRampToValueAtTime(1, now + dur);
      const oldEl = this.mediaEl, oldSrc = this.sourceNode, oldGain = this.sourceGain;
      oldGain.gain.cancelScheduledValues(now);
      oldGain.gain.setValueAtTime(oldGain.gain.value, now);
      oldGain.gain.linearRampToValueAtTime(0.0001, now + dur);
      setTimeout(() => {
        try { oldEl.pause(); oldEl.src = ''; } catch (e) {}
        try { oldSrc.disconnect(); } catch (e) {}
        try { oldGain.disconnect(); } catch (e) {}
      }, fadeMs + 80);
    } else {
      this._disconnectSource();
      g.gain.value = 1;
    }

    this.mediaEl = el;
    this.sourceNode = src;
    this.sourceGain = g;
    this.stream = null;
    this.mode = 'file';
    this._trimFired = false;

    await el.play();
    this.seekToTrimStart(el);
    return el;
  }

  // Use a live input device (mic / line-in / BlackHole). Not routed to output
  // to avoid feedback loops.
  async useInput(deviceId) {
    this.resume();
    this._disconnectSource();

    const constraints = {
      audio: {
        deviceId: deviceId ? { exact: deviceId } : undefined,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false
      },
      video: false
    };
    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    this.stream = stream;

    const src = this.ctx.createMediaStreamSource(stream);
    src.connect(this.analyser); // analyser only — no output (avoid feedback)
    src.connect(this.recordDest); // but capture it when recording
    this.sourceNode = src;
    this.mode = 'input';
  }

  // Play a playlist video track: route the given <video> element's audio
  // through the analyser/output so visuals react and it's audible/recordable.
  attachVideo(videoEl) {
    this.resume();
    this._disconnectSource();
    if (this._videoSrcEl !== videoEl) {
      // createMediaElementSource may only be called once per element.
      this._videoSrc = this.ctx.createMediaElementSource(videoEl);
      this._videoGain = this.ctx.createGain();
      this._videoSrc.connect(this._videoGain);
      this._videoGain.connect(this.analyser);
      this._videoGain.connect(this.outGain);
      this._videoGain.connect(this.recordDest);
      this._videoSrcEl = videoEl;
    }
    videoEl.onended = () => { if (this.onEnded) this.onEnded(); };
    this.mediaEl = videoEl;
    this.sourceNode = null;
    this.sourceGain = null;
    this.mode = 'video';
  }

  async listInputDevices() {
    // Labels are only populated after permission is granted.
    try { await navigator.mediaDevices.getUserMedia({ audio: true }).then(s => s.getTracks().forEach(t => t.stop())); } catch (e) {}
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.filter(d => d.kind === 'audioinput');
  }

  async listOutputDevices() {
    try { await navigator.mediaDevices.getUserMedia({ audio: true }).then(s => s.getTracks().forEach(t => t.stop())); } catch (e) {}
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.filter(d => d.kind === 'audiooutput');
  }

  // Route the file/playback audio to a specific output device (speaker).
  // Uses AudioContext.setSinkId (Chromium 110+); empty id = system default.
  async setOutputDevice(deviceId) {
    if (typeof this.ctx.setSinkId !== 'function') return false;
    try {
      await this.ctx.setSinkId(deviceId || '');
      return true;
    } catch (e) {
      console.warn('setSinkId fallito:', e);
      return false;
    }
  }

  togglePlay() {
    if (!this.mediaEl) return null;
    if (this.mediaEl.paused) { this.mediaEl.play(); return true; }
    this.mediaEl.pause();
    return false;
  }

  // Sample the analyser and update smoothed values. Call once per frame.
  update() {
    this.analyser.getByteFrequencyData(this.freq);
    const bins = this.freq.length;          // 1024 bins, ~0..(sr/2)
    // Roughly: bass 0-6%, mid 6-25%, treble 25-65% of spectrum.
    const bassEnd = Math.floor(bins * 0.06);
    const midEnd = Math.floor(bins * 0.25);
    const trebEnd = Math.floor(bins * 0.65);

    let b = 0, m = 0, t = 0;
    for (let i = 0; i < bassEnd; i++) b += this.freq[i];
    for (let i = bassEnd; i < midEnd; i++) m += this.freq[i];
    for (let i = midEnd; i < trebEnd; i++) t += this.freq[i];
    b = b / (bassEnd * 255);
    m = m / ((midEnd - bassEnd) * 255);
    t = t / ((trebEnd - midEnd) * 255);

    const g = this.gain;
    // Smooth toward new values (attack/release), applying master + per-band gain.
    this.bass = this._smooth(this.bass, Math.min(1, b * 1.6 * g * this.bassGain), 0.5, 0.12);
    this.mid = this._smooth(this.mid, Math.min(1, m * 2.2 * g * this.midGain), 0.5, 0.12);
    this.treble = this._smooth(this.treble, Math.min(1, t * 3.0 * g * this.trebleGain), 0.6, 0.15);
    this.level = this._smooth(this.level, Math.min(1, (b + m + t) / 3 * 2.0 * g), 0.4, 0.1);

    // Beat detection: bass spike above running average.
    this._bassAvg = this._bassAvg * 0.94 + b * 0.06;
    this._beatCooldown -= 1;
    if (b > this._bassAvg * 1.35 && b > 0.12 && this._beatCooldown <= 0) {
      this.beat = 1.0;
      this._beatCooldown = 8; // ~min frames between beats
    } else {
      this.beat *= 0.86; // decay
    }

    // Log-spaced spectrum bands (for VU-meter style effects).
    const NB = this.NB;
    const minBin = 1;
    for (let i = 0; i < NB; i++) {
      const lo = Math.floor(minBin * Math.pow(bins / minBin, i / NB));
      let hi = Math.floor(minBin * Math.pow(bins / minBin, (i + 1) / NB));
      if (hi <= lo) hi = lo + 1;
      let sum = 0;
      for (let k = lo; k < hi; k++) sum += this.freq[k];
      let val = sum / ((hi - lo) * 255);
      val = Math.min(1, val * (1.4 + i * 0.06) * g); // tilt up the highs + user gain
      this.spectrum[i] = this.spectrum[i] * 0.55 + val * 0.45; // smooth
    }

    // Time-domain waveform.
    this.analyser.getByteTimeDomainData(this.timeData);
    const wstep = this.timeData.length / this.NW;
    let peak = 0;
    for (let i = 0; i < this.NW; i++) {
      const s = (this.timeData[Math.floor(i * wstep)] - 128) / 128;
      this.wave[i] = s;
      const a = Math.abs(s);
      if (a > peak) peak = a;
    }

    // Scrolling waveform: accumulate the peak, push into history at a rate
    // controlled by the speed slider (so it reads as a song's waveform).
    this.histPeak = Math.max(this.histPeak, peak);
    this.histAccum += Math.max(0.04, this.scrollRate);
    while (this.histAccum >= this.PUSH_EVERY) {
      this.histAccum -= this.PUSH_EVERY;
      this.waveHist.copyWithin(0, 1);
      this.waveHist[this.NH - 1] = this.histPeak;
      this.histPeak = peak;
    }

    return this;
  }

  _smooth(cur, target, attack, release) {
    const k = target > cur ? attack : release;
    return cur + (target - cur) * k;
  }

  get values() {
    return { bass: this.bass, mid: this.mid, treble: this.treble, level: this.level, beat: this.beat, spectrum: this.spectrum, wave: this.wave, waveHist: this.waveHist };
  }
}

window.AudioEngine = AudioEngine;
