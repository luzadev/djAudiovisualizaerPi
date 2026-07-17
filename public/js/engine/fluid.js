// GPU fluid simulation ("ink in water") for the Fluido effect family.
// Classic stable-fluids solver on ping-pong framebuffers: advection, vorticity
// confinement, Jacobi pressure solve, gradient subtraction, plus audio-driven
// dye/force splats. The Visualizer delegates rendering here when the current
// effect has isFluid set; everything runs on the shared WebGL2 context.
//
// Audio mapping: bass = injection strength & stirring force, beat = burst
// splats, treble = extra swirl (vorticity). Effect params reuse the catalog's
// universal modifiers: colorA/colorB+hueCycle = dye colours, warp = swirl,
// speed = sim speed, sym = kaleidoscope on the final pass, contrast/invert =
// display, audioMix = how much audio drives vs. autonomous ambient motion.

class FluidSim {
  constructor(gl) {
    this.gl = gl;
    // RGBA16F is color-renderable only with this extension; linear filtering
    // of half-float textures is core WebGL2. Fall back to RGBA8 (lower quality
    // but functional) if unavailable.
    this.float = !!gl.getExtension('EXT_color_buffer_float');

    this.SIM_RES = 192;   // velocity/pressure grid
    this.DYE_RES = 1024;  // dye (what you actually see)
    this.PRESSURE_ITERS = 22;

    this._buildPrograms();

    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    this.vbo = buf;

    this.simW = 0; this.simH = 0; this.dyeW = 0; this.dyeH = 0;
    this.lastTime = 0;
    this.beatCool = 0;
    this.emitters = [
      { phase: 0.0, fx: 0.56, fy: 0.41, hue: 0.0 },
      { phase: 2.1, fx: 0.31, fy: 0.52, hue: 0.33 },
      { phase: 4.2, fx: 0.41, fy: 0.31, hue: 0.66 },
    ];
  }

  // ---- GL plumbing ---------------------------------------------------------
  _compile(type, src) {
    const gl = this.gl, sh = gl.createShader(type);
    gl.shaderSource(sh, src); gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS))
      throw new Error('FluidSim shader: ' + gl.getShaderInfoLog(sh));
    return sh;
  }
  _program(fsrc) {
    const gl = this.gl, p = gl.createProgram();
    p._u = {};
    gl.attachShader(p, this._vs || (this._vs = this._compile(gl.VERTEX_SHADER, FluidSim.VERT)));
    gl.attachShader(p, this._compile(gl.FRAGMENT_SHADER, fsrc));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS))
      throw new Error('FluidSim link: ' + gl.getProgramInfoLog(p));
    p._aPos = gl.getAttribLocation(p, 'aPos');
    const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) { const info = gl.getActiveUniform(p, i); p._u[info.name] = gl.getUniformLocation(p, info.name); }
    return p;
  }
  _buildPrograms() {
    this.pAdvect = this._program(FluidSim.ADVECT);
    this.pSplat = this._program(FluidSim.SPLAT);
    this.pCurl = this._program(FluidSim.CURL);
    this.pVort = this._program(FluidSim.VORT);
    this.pDiv = this._program(FluidSim.DIV);
    this.pPress = this._program(FluidSim.PRESS);
    this.pGrad = this._program(FluidSim.GRAD);
    this.pBuoy = this._program(FluidSim.BUOY);
    this.pShow = this._program(FluidSim.SHOW);
  }

  _fbo(w, h, internal, format, type) {
    const gl = this.gl;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, internal, w, h, 0, format, type, null);
    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.clearColor(0, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT);
    return { tex, fb, w, h, texelX: 1 / w, texelY: 1 / h };
  }
  _pair(w, h, internal, format, type) {
    return { a: this._fbo(w, h, internal, format, type), b: this._fbo(w, h, internal, format, type),
      swap() { const t = this.a; this.a = this.b; this.b = t; } };
  }

  _allocate(canvasW, canvasH) {
    const gl = this.gl, aspect = canvasW / Math.max(1, canvasH);
    const dim = (res) => aspect >= 1
      ? { w: Math.round(res * aspect), h: res }
      : { w: res, h: Math.round(res / aspect) };
    const s = dim(this.SIM_RES), d = dim(this.DYE_RES);
    if (s.w === this.simW && s.h === this.simH && d.w === this.dyeW && d.h === this.dyeH) return;
    this.simW = s.w; this.simH = s.h; this.dyeW = d.w; this.dyeH = d.h;
    const I = this.float ? gl.RGBA16F : gl.RGBA8;
    const T = this.float ? gl.HALF_FLOAT : gl.UNSIGNED_BYTE;
    this.vel = this._pair(s.w, s.h, I, gl.RGBA, T);
    this.dye = this._pair(d.w, d.h, I, gl.RGBA, T);
    this.press = this._pair(s.w, s.h, I, gl.RGBA, T);
    this.div = this._fbo(s.w, s.h, I, gl.RGBA, T);
    this.curl = this._fbo(s.w, s.h, I, gl.RGBA, T);
  }

  _blit(target, program) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, target ? target.fb : null);
    gl.viewport(0, 0, target ? target.w : this._cw, target ? target.h : this._ch);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.enableVertexAttribArray(program._aPos);
    gl.vertexAttribPointer(program._aPos, 2, gl.FLOAT, false, 0, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
  _bind(program, unit, tex) { const gl = this.gl; gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, tex); return unit; }

  // ---- Simulation ----------------------------------------------------------
  _splat(x, y, dx, dy, r, g, b, radius) {
    const gl = this.gl, p = this.pSplat;
    gl.useProgram(p);
    const aspect = this.simW / this.simH;
    // velocity impulse
    gl.uniform1i(p._u.uTarget, this._bind(p, 0, this.vel.a.tex));
    gl.uniform2f(p._u.uPoint, x, y);
    gl.uniform3f(p._u.uValue, dx, dy, 0);
    gl.uniform1f(p._u.uRadius, radius);
    gl.uniform1f(p._u.uAspect, aspect);
    this._blit(this.vel.b, p); this.vel.swap();
    // dye
    gl.uniform1i(p._u.uTarget, this._bind(p, 0, this.dye.a.tex));
    gl.uniform3f(p._u.uValue, r, g, b);
    this._blit(this.dye.b, p); this.dye.swap();
  }

  // Rotate an [r,g,b] colour's hue by `rot` (0..1) and desaturate toward luma.
  static _hue(c, rot, sat) {
    if (rot) {
      const a = rot * Math.PI * 2, cs = Math.cos(a), sn = Math.sin(a), t = 1 / 3, st = Math.sqrt(t);
      const m = [cs + (1 - cs) * t, t * (1 - cs) - st * sn, t * (1 - cs) + st * sn];
      c = [
        c[0] * m[0] + c[1] * m[1] + c[2] * m[2],
        c[0] * m[2] + c[1] * m[0] + c[2] * m[1],
        c[0] * m[1] + c[1] * m[2] + c[2] * m[0]];
    }
    if (sat < 1) { const l = 0.3 * c[0] + 0.6 * c[1] + 0.1 * c[2]; c = c.map(v => l + (v - l) * sat); }
    return c.map(v => Math.max(0, v));
  }

  render(timeSec, audio, e, canvas) {
    const gl = this.gl;
    this._cw = canvas.width; this._ch = canvas.height;
    this._allocate(canvas.width, canvas.height);

    let dtReal = this.lastTime ? (timeSec - this.lastTime) : 1 / 60;
    this.lastTime = timeSec;
    dtReal = Math.min(Math.max(dtReal, 0), 1 / 30);
    const dt = dtReal * (e.speed || 1); // sim speed scales motion, not brightness
    const t = timeSec * (e.speed || 1);
    const mix = e.audioMix !== undefined ? e.audioMix : 1;
    const bass = audio.bass * mix, treble = audio.treble * mix, beat = audio.beat * mix;

    gl.disable(gl.BLEND);

    // -- audio-driven splats --------------------------------------------------
    // Each fluidMode is a different emitter choreography over the same solver:
    // 'ink' wandering brushes, 'fire' bottom jets + buoyancy, 'ring' rotating
    // circle with radial beat bursts, 'vortex' two counter-rotating stirrers,
    // 'wave' a curtain sweeping across the screen.
    const hueShift = (e.hueBase || 0) + t * (e.hueCycle || 0) * 0.5;
    const sat = e.sat !== undefined ? e.sat : 1;
    const mode = e.fluidMode || 'ink';
    // Palette colour helper: A<->B oscillation, hue cycling, then normalized
    // to full brightness (palette 'a' colours are near-black backgrounds in
    // the shader families; the palette identity lives in the hue).
    const dyeCol = (ph) => {
      const k = 0.5 + 0.5 * Math.sin(t * 0.21 + ph * Math.PI * 2);
      let col = [
        (e.colorA[0] * (1 - k) + e.colorB[0] * k),
        (e.colorA[1] * (1 - k) + e.colorB[1] * k),
        (e.colorA[2] * (1 - k) + e.colorB[2] * k)];
      col = FluidSim._hue(col, hueShift + ph * 0.16, sat);
      const mx = Math.max(col[0], col[1], col[2], 1e-4);
      return [col[0] / mx, col[1] / mx, col[2] / mx];
    };
    // Injection is balanced against the dye dissipation below: too much and
    // the whole screen saturates to a solid colour, too little and it fades.
    const force = (14 + 320 * bass) * dt * 60;
    const inj = (0.5 + 2.8 * bass) * dtReal;
    const rad = 0.0009 + 0.0013 * bass;
    this.beatCool -= dt;
    const onBeat = beat > 0.85 && this.beatCool <= 0;
    if (onBeat) this.beatCool = 0.18;

    if (mode === 'fire') {
      // flickering upward jets along the bottom edge (buoyancy pass below)
      for (let i = 0; i < 3; i++) {
        const bx = 0.5 + (i - 1) * 0.24 + 0.05 * Math.sin(t * (1.3 + i * 0.37) + i * 2.1);
        const flick = 0.6 + 0.4 * Math.sin(t * (5.1 + i) + i * 13.7);
        const c = dyeCol(i / 3);
        this._splat(bx, 0.04, 0, force * 0.22 * (0.7 + 0.8 * flick),
          c[0] * inj * 2.2, c[1] * inj * 2.2, c[2] * inj * 2.2, rad * 1.2);
      }
      if (onBeat) {
        const c = dyeCol(0.5);
        this._splat(0.5, 0.06, 0, 1400 * (0.4 + bass), c[0] * 0.8, c[1] * 0.8, c[2] * 0.8, 0.006);
      }
    } else if (mode === 'ring') {
      // emitters on a slowly spinning circle, stirring tangentially
      const N = 6, R = 0.27, spin = t * 0.5;
      for (let i = 0; i < N; i++) {
        const a = spin + i * Math.PI * 2 / N;
        const c = dyeCol(i / N);
        this._splat(0.5 + R * Math.cos(a), 0.5 + R * Math.sin(a),
          -Math.sin(a) * force, Math.cos(a) * force, c[0] * inj, c[1] * inj, c[2] * inj, rad);
      }
      if (onBeat) { // radial shockwave from the centre
        const c = dyeCol(Math.sin(t * 3.1) * 0.5 + 0.5);
        for (let i = 0; i < N; i++) {
          const a = spin + (i + 0.5) * Math.PI * 2 / N, F = 1100 * (0.4 + bass);
          this._splat(0.5 + 0.06 * Math.cos(a), 0.5 + 0.06 * Math.sin(a),
            Math.cos(a) * F, Math.sin(a) * F, c[0] * 0.35, c[1] * 0.35, c[2] * 0.35, 0.0025);
        }
      }
    } else if (mode === 'vortex') {
      // two counter-rotating stirrers -> double spiral galaxies
      for (let s = 0; s < 2; s++) {
        const sgn = s ? -1 : 1;
        const cx = 0.5 + sgn * (0.20 + 0.05 * Math.sin(t * 0.4));
        const cy = 0.5 + 0.08 * Math.sin(t * 0.31 + s * 2.6);
        const a = t * 1.6 * sgn + s * Math.PI, R = 0.11;
        const c = dyeCol(s * 0.5 + 0.1);
        this._splat(cx + R * Math.cos(a), cy + R * Math.sin(a),
          -Math.sin(a) * sgn * force * 1.3, Math.cos(a) * sgn * force * 1.3,
          c[0] * inj * 1.4, c[1] * inj * 1.4, c[2] * inj * 1.4, rad);
      }
      if (onBeat) { // bright puff where the spirals meet
        const c = dyeCol(0.8);
        this._splat(0.5, 0.5, 0, 0, c[0] * 0.5, c[1] * 0.5, c[2] * 0.5, 0.004);
      }
    } else if (mode === 'wave') {
      // travelling sine curtain sweeping rightwards
      const N = 4;
      for (let i = 0; i < N; i++) {
        const x = (t * 0.07 + i / N) % 1;
        const ph = t * 0.9 + i * 1.7 + x * 6.28;
        const c = dyeCol(i / N);
        this._splat(x, 0.5 + 0.28 * Math.sin(ph),
          force * 0.6, Math.cos(ph) * force * 0.35, c[0] * inj * 1.6, c[1] * inj * 1.6, c[2] * inj * 1.6, rad * 1.3);
      }
      if (onBeat) { // side blast riding the wave
        const c = dyeCol(0.3);
        this._splat(0.06, 0.5 + 0.3 * Math.sin(t * 5.3), 1000 * (0.4 + bass), 0,
          c[0] * 0.5, c[1] * 0.5, c[2] * 0.5, 0.0018);
      }
    } else {
      // 'ink': wandering brushes (the original mode)
      for (let i = 0; i < this.emitters.length; i++) {
        const em = this.emitters[i];
        const x = 0.5 + 0.36 * Math.sin(t * em.fx + em.phase) * Math.cos(t * 0.09 + em.phase);
        const y = 0.5 + 0.36 * Math.sin(t * em.fy + em.phase * 1.7);
        // movement direction (numeric derivative of the wander path)
        const h = 0.01;
        const dx = (0.5 + 0.36 * Math.sin((t + h) * em.fx + em.phase) * Math.cos((t + h) * 0.09 + em.phase)) - x;
        const dy = (0.5 + 0.36 * Math.sin((t + h) * em.fy + em.phase * 1.7)) - y;
        const inv = 1 / Math.max(1e-5, Math.hypot(dx, dy));
        const c = dyeCol(em.hue);
        this._splat(x, y, dx * inv * force, dy * inv * force,
          c[0] * inj, c[1] * inj, c[2] * inj, rad);
      }
      if (onBeat) { // bright directional shot from a pseudo-random edge point
        const a = Math.sin(t * 37.7) * Math.PI * 2;
        const c = dyeCol(0.0);
        const F = 900 * (0.4 + bass);
        this._splat(0.5 + 0.30 * Math.cos(a), 0.5 + 0.30 * Math.sin(a),
          -Math.cos(a) * F, -Math.sin(a) * F, c[0] * 0.7, c[1] * 0.7, c[2] * 0.7, 0.003 + 0.003 * bass);
      }
    }

    // -- solver ---------------------------------------------------------------
    const v = this.vel;
    let p;
    if (mode === 'fire') {
      // buoyancy: hot (bright) dye rises, like smoke over a flame
      p = this.pBuoy;
      gl.useProgram(p);
      gl.uniform1i(p._u.uVel, this._bind(p, 0, v.a.tex));
      gl.uniform1i(p._u.uDye, this._bind(p, 1, this.dye.a.tex));
      gl.uniform1f(p._u.uK, 170);
      gl.uniform1f(p._u.uDt, dt);
      this._blit(v.b, p); v.swap();
    }
    p = this.pCurl;
    gl.useProgram(p);
    gl.uniform2f(p._u.uTexel, v.a.texelX, v.a.texelY);
    gl.uniform1i(p._u.uVel, this._bind(p, 0, v.a.tex));
    this._blit(this.curl, p);

    p = this.pVort;
    gl.useProgram(p);
    gl.uniform2f(p._u.uTexel, v.a.texelX, v.a.texelY);
    gl.uniform1i(p._u.uVel, this._bind(p, 0, v.a.tex));
    gl.uniform1i(p._u.uCurl, this._bind(p, 1, this.curl.tex));
    gl.uniform1f(p._u.uStrength, 18 + (e.warp || 0) * 30 + treble * 20);
    gl.uniform1f(p._u.uDt, dt);
    this._blit(v.b, p); v.swap();

    p = this.pDiv;
    gl.useProgram(p);
    gl.uniform2f(p._u.uTexel, v.a.texelX, v.a.texelY);
    gl.uniform1i(p._u.uVel, this._bind(p, 0, v.a.tex));
    this._blit(this.div, p);

    p = this.pPress;
    gl.useProgram(p);
    gl.uniform2f(p._u.uTexel, v.a.texelX, v.a.texelY);
    gl.uniform1i(p._u.uDiv, this._bind(p, 1, this.div.tex));
    for (let i = 0; i < this.PRESSURE_ITERS; i++) {
      gl.uniform1i(p._u.uPress, this._bind(p, 0, this.press.a.tex));
      this._blit(this.press.b, p); this.press.swap();
    }

    p = this.pGrad;
    gl.useProgram(p);
    gl.uniform2f(p._u.uTexel, v.a.texelX, v.a.texelY);
    gl.uniform1i(p._u.uPress, this._bind(p, 0, this.press.a.tex));
    gl.uniform1i(p._u.uVel, this._bind(p, 1, v.a.tex));
    this._blit(v.b, p); v.swap();

    p = this.pAdvect;
    gl.useProgram(p);
    gl.uniform2f(p._u.uTexel, v.a.texelX, v.a.texelY);
    gl.uniform1f(p._u.uDt, dt);
    gl.uniform1i(p._u.uVel, this._bind(p, 0, v.a.tex));
    gl.uniform1i(p._u.uSrc, this._bind(p, 1, v.a.tex));
    gl.uniform1f(p._u.uDiss, mode === 'fire' ? 1.1 : 0.25);
    gl.uniform1f(p._u.uHeightK, 0.0);
    this._blit(v.b, p); v.swap();

    gl.uniform1i(p._u.uVel, this._bind(p, 0, v.a.tex));
    gl.uniform1i(p._u.uSrc, this._bind(p, 1, this.dye.a.tex));
    gl.uniform1f(p._u.uDiss, (mode === 'fire' ? 1.0 : 0.6) / (e.speed || 1));  // fire: short-lived flames; others: slow fade
    gl.uniform1f(p._u.uHeightK, mode === 'fire' ? 8.0 : 0.0);
    this._blit(this.dye.b, p); this.dye.swap();

    // -- display --------------------------------------------------------------
    p = this.pShow;
    gl.useProgram(p);
    gl.uniform1i(p._u.uDye, this._bind(p, 0, this.dye.a.tex));
    gl.uniform1f(p._u.uSym, e.sym || 0);
    gl.uniform1f(p._u.uRot, (e.rot || 0) + t * (e.rotSpeed || 0) * 6.2831853);
    gl.uniform1f(p._u.uContrast, e.contrast !== undefined ? e.contrast : 0.8);
    gl.uniform1f(p._u.uInvert, e.invert || 0);
    gl.uniform1f(p._u.uGlow, 0.15 + 0.4 * beat);
    gl.uniform2f(p._u.uRes, this._cw, this._ch);
    this._blit(null, p);

    // restore expected state for the uber-shader path
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this._cw, this._ch);
    gl.activeTexture(gl.TEXTURE0);
  }
}

// ---- GLSL ------------------------------------------------------------------
FluidSim.VERT = `#version 300 es
in vec2 aPos; out vec2 vUv;
void main(){ vUv = aPos*0.5+0.5; gl_Position = vec4(aPos,0.,1.); }`;

FluidSim.ADVECT = `#version 300 es
precision highp float; in vec2 vUv; out vec4 o;
uniform sampler2D uVel, uSrc; uniform vec2 uTexel; uniform float uDt, uDiss, uHeightK;
void main(){
  vec2 pos = vUv - uDt * texture(uVel, vUv).xy * uTexel;
  float diss = uDiss * (1.0 + uHeightK * vUv.y);  // fire mode: fade with altitude
  o = clamp(texture(uSrc, pos) / (1.0 + diss * uDt), -1200., 1200.); // NaN/Inf guard
}`;

FluidSim.SPLAT = `#version 300 es
precision highp float; in vec2 vUv; out vec4 o;
uniform sampler2D uTarget; uniform vec2 uPoint; uniform vec3 uValue;
uniform float uRadius, uAspect;
void main(){
  vec2 d = vUv - uPoint; d.x *= uAspect;
  o = texture(uTarget, vUv) + vec4(uValue * exp(-dot(d,d)/uRadius), 0.0);
}`;

FluidSim.CURL = `#version 300 es
precision highp float; in vec2 vUv; out vec4 o;
uniform sampler2D uVel; uniform vec2 uTexel;
void main(){
  float L = texture(uVel, vUv - vec2(uTexel.x,0.)).y;
  float R = texture(uVel, vUv + vec2(uTexel.x,0.)).y;
  float B = texture(uVel, vUv - vec2(0.,uTexel.y)).x;
  float T = texture(uVel, vUv + vec2(0.,uTexel.y)).x;
  o = vec4(0.5*((R-L)-(T-B)), 0., 0., 1.);
}`;

FluidSim.VORT = `#version 300 es
precision highp float; in vec2 vUv; out vec4 o;
uniform sampler2D uVel, uCurl; uniform vec2 uTexel; uniform float uStrength, uDt;
void main(){
  float L = texture(uCurl, vUv - vec2(uTexel.x,0.)).x;
  float R = texture(uCurl, vUv + vec2(uTexel.x,0.)).x;
  float B = texture(uCurl, vUv - vec2(0.,uTexel.y)).x;
  float T = texture(uCurl, vUv + vec2(0.,uTexel.y)).x;
  float C = texture(uCurl, vUv).x;
  vec2 force = 0.5 * vec2(abs(T)-abs(B), abs(R)-abs(L));
  force = force / (length(force) + 1e-4) * uStrength * C * vec2(1.,-1.);
  // Clamp: unbounded confinement makes velocity blow up -> half-float Inf/NaN
  // -> the whole field dies and dye freezes into static blobs.
  o = vec4(clamp(texture(uVel, vUv).xy + force * uDt, -1200., 1200.), 0., 1.);
}`;

FluidSim.DIV = `#version 300 es
precision highp float; in vec2 vUv; out vec4 o;
uniform sampler2D uVel; uniform vec2 uTexel;
void main(){
  float L = texture(uVel, vUv - vec2(uTexel.x,0.)).x;
  float R = texture(uVel, vUv + vec2(uTexel.x,0.)).x;
  float B = texture(uVel, vUv - vec2(0.,uTexel.y)).y;
  float T = texture(uVel, vUv + vec2(0.,uTexel.y)).y;
  o = vec4(0.5*((R-L)+(T-B)), 0., 0., 1.);
}`;

FluidSim.PRESS = `#version 300 es
precision highp float; in vec2 vUv; out vec4 o;
uniform sampler2D uPress, uDiv; uniform vec2 uTexel;
void main(){
  float L = texture(uPress, vUv - vec2(uTexel.x,0.)).x;
  float R = texture(uPress, vUv + vec2(uTexel.x,0.)).x;
  float B = texture(uPress, vUv - vec2(0.,uTexel.y)).x;
  float T = texture(uPress, vUv + vec2(0.,uTexel.y)).x;
  float div = texture(uDiv, vUv).x;
  o = vec4((L+R+B+T-div)*0.25, 0., 0., 1.);
}`;

FluidSim.GRAD = `#version 300 es
precision highp float; in vec2 vUv; out vec4 o;
uniform sampler2D uPress, uVel; uniform vec2 uTexel;
void main(){
  float L = texture(uPress, vUv - vec2(uTexel.x,0.)).x;
  float R = texture(uPress, vUv + vec2(uTexel.x,0.)).x;
  float B = texture(uPress, vUv - vec2(0.,uTexel.y)).x;
  float T = texture(uPress, vUv + vec2(0.,uTexel.y)).x;
  o = vec4(texture(uVel, vUv).xy - 0.5*vec2(R-L, T-B), 0., 1.);
}`;

FluidSim.BUOY = `#version 300 es
precision highp float; in vec2 vUv; out vec4 o;
uniform sampler2D uVel, uDye; uniform float uK, uDt;
void main(){
  float l = dot(texture(uDye, vUv).rgb, vec3(0.333));
  vec2 v = texture(uVel, vUv).xy;
  // Relax the vertical velocity toward uK*luma: a bounded updraft, unlike an
  // additive force which integrates to the clamp and turns flames into a wall.
  float a = min(1., uDt * 4.) * step(0.01, l);
  v.y += (uK * min(l, 1.5) - v.y) * a;
  o = vec4(v, 0., 1.);
}`;

FluidSim.SHOW = `#version 300 es
precision highp float; in vec2 vUv; out vec4 o;
uniform sampler2D uDye; uniform float uSym, uContrast, uInvert, uGlow, uRot;
uniform vec2 uRes;
void main(){
  vec2 uv = vUv;
  if (uSym > 0.5) {
    // kaleidoscope fold in aspect-corrected space around the centre
    vec2 p = uv - 0.5; p.x *= uRes.x / uRes.y;
    float a = atan(p.y, p.x) + uRot, r = length(p);
    float seg = 6.2831853 / uSym;
    a = abs(mod(a, seg) - seg*0.5);
    p = vec2(cos(a), sin(a)) * r;
    p.x /= uRes.x / uRes.y;
    uv = clamp(p + 0.5, 0.0, 1.0);
  }
  vec3 c = texture(uDye, uv).rgb;
  // soft wide glow from a heavily blurred (mip-less) 5-tap sample
  vec3 g = ( texture(uDye, uv + vec2( 0.006, 0.0)).rgb
           + texture(uDye, uv + vec2(-0.006, 0.0)).rgb
           + texture(uDye, uv + vec2(0.0,  0.006)).rgb
           + texture(uDye, uv + vec2(0.0, -0.006)).rgb ) * 0.25;
  c += g * uGlow;
  c = pow(max(c * 1.25, 0.0), vec3(0.92));                  // gentle mid lift
  c = mix(c, smoothstep(0.0, 1.0, c), clamp(uContrast, 0., 1.5) * 0.6);
  if (uInvert > 0.5) c = 1.0 - c;
  o = vec4(c, 1.0);
}`;

window.FluidSim = FluidSim;
