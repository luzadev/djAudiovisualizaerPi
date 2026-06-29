// WebGL2 engine: renders a fullscreen quad through the parametric uber-shader,
// driven by the current effect's parameters + live audio.

class Visualizer {
  constructor(canvas) {
    this.canvas = canvas;
    // preserveDrawingBuffer keeps the rendered frame readable so canvas
    // captureStream() (used by the MP4 recorder) captures real frames.
    const gl = canvas.getContext('webgl2', { antialias: false, alpha: false, preserveDrawingBuffer: true, powerPreference: 'high-performance' });
    if (!gl) throw new Error('WebGL2 non disponibile su questo sistema.');
    this.gl = gl;

    this.program = this._buildProgram(window.SHADERS.vert, window.SHADERS.frag);

    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    this.vbo = buf;

    gl.useProgram(this.program);
    const U = (n) => gl.getUniformLocation(this.program, n);
    this.aPos = gl.getAttribLocation(this.program, 'aPos');
    this.u = {
      uRes: U('uRes'), uTime: U('uTime'),
      uBass: U('uBass'), uMid: U('uMid'), uTreble: U('uTreble'), uLevel: U('uLevel'), uBeat: U('uBeat'),
      uFamily: U('uFamily'), uScale: U('uScale'), uRot: U('uRot'), uRotSpeed: U('uRotSpeed'), uSym: U('uSym'),
      uHueBase: U('uHueBase'), uHueCycle: U('uHueCycle'), uSat: U('uSat'), uContrast: U('uContrast'),
      uInvert: U('uInvert'), uWarp: U('uWarp'), uAudioMix: U('uAudioMix'), uSpeed: U('uSpeed'),
      uColorA: U('uColorA'), uColorB: U('uColorB'), uTex: U('uTex'), uSpectrum: U('uSpectrum'), uBgDark: U('uBgDark'), uWave: U('uWave'), uWaveHist: U('uWaveHist')
    };

    // Custom-source texture (for the SVG/Image effect family). Starts empty.
    this.tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 0]));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

    this.effect = (window.EFFECTS && window.EFFECTS.defaults()) || this._fallbackEffect();

    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  _fallbackEffect() {
    return { family: 2, scale: 1.0, rot: 0, rotSpeed: 0, sym: 0, hueBase: 0, hueCycle: 0.02,
      sat: 1, contrast: 0.8, invert: 0, warp: 0, audioMix: 1, speed: 1, colorA: [0.1, 0.2, 0.8], colorB: [1, 0.4, 0.9] };
  }

  _compile(type, src) {
    const gl = this.gl;
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS))
      throw new Error('Errore compilazione shader:\n' + gl.getShaderInfoLog(sh));
    return sh;
  }

  _buildProgram(vsrc, fsrc) {
    const gl = this.gl;
    const p = gl.createProgram();
    gl.attachShader(p, this._compile(gl.VERTEX_SHADER, vsrc));
    gl.attachShader(p, this._compile(gl.FRAGMENT_SHADER, fsrc));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS))
      throw new Error('Errore link programma: ' + gl.getProgramInfoLog(p));
    return p;
  }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.floor(window.innerWidth * dpr), h = Math.floor(window.innerHeight * dpr);
    if (this.canvas.width !== w || this.canvas.height !== h) { this.canvas.width = w; this.canvas.height = h; }
    this.gl.viewport(0, 0, w, h);
  }

  setEffect(effect) {
    // Merge onto current so partial updates (e.g. only family) are safe.
    this.effect = Object.assign({}, this.effect, effect);
  }

  // Upload a custom source (HTMLImageElement / HTMLCanvasElement) for the
  // SVG/Image effect family. Flipped on the Y axis to match screen space.
  setTexture(source) {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  }

  render(timeSec, audio) {
    const gl = this.gl, u = this.u, e = this.effect;
    gl.useProgram(this.program);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.enableVertexAttribArray(this.aPos);
    gl.vertexAttribPointer(this.aPos, 2, gl.FLOAT, false, 0, 0);

    gl.uniform2f(u.uRes, this.canvas.width, this.canvas.height);
    gl.uniform1f(u.uTime, timeSec);
    gl.uniform1f(u.uBass, audio.bass);
    gl.uniform1f(u.uMid, audio.mid);
    gl.uniform1f(u.uTreble, audio.treble);
    gl.uniform1f(u.uLevel, audio.level);
    gl.uniform1f(u.uBeat, audio.beat);

    gl.uniform1i(u.uFamily, e.family | 0);
    gl.uniform1f(u.uScale, e.scale);
    gl.uniform1f(u.uRot, e.rot);
    gl.uniform1f(u.uRotSpeed, e.rotSpeed);
    gl.uniform1f(u.uSym, e.sym);
    gl.uniform1f(u.uHueBase, e.hueBase);
    gl.uniform1f(u.uHueCycle, e.hueCycle);
    gl.uniform1f(u.uSat, e.sat);
    gl.uniform1f(u.uContrast, e.contrast);
    gl.uniform1f(u.uInvert, e.invert);
    gl.uniform1f(u.uWarp, e.warp);
    gl.uniform1f(u.uAudioMix, e.audioMix);
    gl.uniform1f(u.uSpeed, e.speed);
    gl.uniform3fv(u.uColorA, e.colorA);
    gl.uniform3fv(u.uColorB, e.colorB);
    gl.uniform1f(u.uBgDark, e.bgDark || 0);

    if (u.uSpectrum && audio.spectrum) gl.uniform1fv(u.uSpectrum, audio.spectrum);
    if (u.uWave && audio.wave) gl.uniform1fv(u.uWave, audio.wave);
    if (u.uWaveHist && audio.waveHist) gl.uniform1fv(u.uWaveHist, audio.waveHist);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.uniform1i(u.uTex, 0);

    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
}

window.Visualizer = Visualizer;
