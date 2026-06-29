// Parametric "uber" shader: 16 visual families selected by uFamily, plus a set
// of universal modifiers (zoom, rotation, kaleidoscope symmetry, domain warp,
// palette, hue cycle, saturation, contrast, invert, audio mix). Combining these
// with the effect catalog (effects.js) yields hundreds of distinct looks.

const VERT = `#version 300 es
in vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }
`;

const FRAG = `#version 300 es
precision highp float;
out vec4 fragColor;

uniform vec2  uRes;
uniform float uTime;
uniform float uBass, uMid, uTreble, uLevel, uBeat;

uniform int   uFamily;
uniform float uScale, uRot, uRotSpeed, uSym;
uniform float uHueBase, uHueCycle, uSat, uContrast, uInvert, uWarp, uAudioMix, uSpeed;
uniform vec3  uColorA, uColorB;
uniform sampler2D uTex;   // custom SVG / image source (uploaded flipped-Y)
uniform float uSpectrum[32];   // live 32-band spectrum for VU meters
uniform float uWave[256];      // live time-domain waveform (-1..1)
uniform float uWaveHist[256];  // scrolling amplitude history (song waveform)
uniform float uBgDark;         // 1 = force the empty field (v→0) to black

float uT = 0.0;     // time * effect speed (set in main)
float aMix = 1.0;   // audio mix (set in main)

mat2 rot(float a) { float s = sin(a), c = cos(a); return mat2(c, -s, s, c); }

vec3 hsv2rgb(vec3 c) {
  vec4 K = vec4(1.0, 2.0/3.0, 1.0/3.0, 3.0);
  vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
  return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y);
}
vec3 rgb2hsv(vec3 c) {
  vec4 K = vec4(0.0, -1.0/3.0, 2.0/3.0, -1.0);
  vec4 p = mix(vec4(c.bg, K.wz), vec4(c.gb, K.xy), step(c.b, c.g));
  vec4 q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r));
  float d = q.x - min(q.w, q.y);
  float e = 1.0e-10;
  return vec3(abs(q.z + (q.w - q.y) / (6.0 * d + e)), d / (q.x + e), q.x);
}

float hash(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = hash(i), b = hash(i + vec2(1, 0)), c = hash(i + vec2(0, 1)), d = hash(i + vec2(1, 1));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
float fbm(vec2 p) { float v = 0.0, a = 0.5; for (int i = 0; i < 6; i++) { v += a * noise(p); p *= 2.02; a *= 0.5; } return v; }

// ---- Families: each returns a scalar field in roughly [0,1] ----
float famJulia(vec2 uv) {
  vec2 c = vec2(0.7885 * cos(uT * 0.15), 0.7885 * sin(uT * 0.17));
  c += uTreble * 0.1 * aMix * vec2(sin(uT * 6.0), cos(uT * 5.0));
  vec2 z = uv * 1.4; float it = 0.0;
  for (float i = 0.0; i < 128.0; i++) { z = vec2(z.x*z.x - z.y*z.y, 2.0*z.x*z.y) + c; if (dot(z, z) > 16.0) break; it++; }
  if (it >= 128.0) return 0.0;
  return (it - log2(log2(dot(z, z))) + 4.0) / 128.0;
}
float famMandel(vec2 uv) {
  vec2 c = uv * 1.5 - vec2(0.5, 0.0); vec2 z = vec2(0.0); float it = 0.0;
  for (float i = 0.0; i < 128.0; i++) { z = vec2(z.x*z.x - z.y*z.y, 2.0*z.x*z.y) + c; if (dot(z, z) > 16.0) break; it++; }
  if (it >= 128.0) return 0.0;
  return (it - log2(log2(dot(z, z))) + 4.0) / 128.0;
}
float famPlasma(vec2 uv) {
  float t = uT * 0.2;
  vec2 q = vec2(fbm(uv * 1.5 + t), fbm(uv * 1.5 - t + 5.2));
  vec2 r = vec2(fbm(uv * 2.0 + 1.7 * q + 0.15 * t), fbm(uv * 2.0 + 1.7 * q + vec2(8.3, 2.8) - 0.12 * t));
  return fbm(uv * 2.0 + 3.0 * r + uBass * aMix);
}
float famVortex(vec2 uv) {
  float r = length(uv), a = atan(uv.y, uv.x);
  float swirl = a + (1.2 + uBass * 2.0 * aMix) / (r + 0.15) - uT * 0.6;
  return (sin(swirl * 5.0 + r * 12.0 - uT * 2.0) * 0.5 + 0.5) * (0.4 + 0.8 * fbm(uv * 3.0));
}
float famWaves(vec2 uv) {
  float r = length(uv);
  float energy = mix(uBass, uTreble, clamp(r, 0.0, 1.0)) * aMix + 0.3;
  return (1.0 - smoothstep(0.0, 0.6, abs(sin(r * 24.0 - uT * 4.0)))) * energy;
}
float famCells(vec2 uv) {
  vec2 p = uv * 4.0 + 8.0; vec2 ip = floor(p), fp = fract(p);
  float d1 = 8.0, d2 = 8.0;
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
    vec2 g = vec2(float(x), float(y));
    vec2 o = vec2(hash(ip + g), hash(ip + g + 3.7));
    float d = length(g + 0.5 + 0.45 * sin(uT * 0.6 + o * 6.283) - fp);
    if (d < d1) { d2 = d1; d1 = d; } else if (d < d2) d2 = d;
  }
  return clamp(d2 - d1, 0.0, 1.0);
}
float famHyper(vec2 uv) {
  float v = 0.0, warp = 0.4 + uBass * 2.0 * aMix;
  for (int i = 0; i < 40; i++) {
    float fi = float(i);
    float ang = hash(vec2(fi, 1.0)) * 6.283;
    float z = fract(hash(vec2(fi, 3.0)) + uT * (0.25 + hash(vec2(fi, 2.0)) * 0.9) * warp);
    vec2 pos = vec2(cos(ang), sin(ang)) * z * z * 1.6;
    v += smoothstep(0.06 * z + 0.004, 0.0, length(uv - pos)) * z;
  }
  return clamp(v, 0.0, 1.0);
}
float famTunnel(vec2 uv) {
  float a = atan(uv.y, uv.x), r = length(uv);
  float depth = 0.35 / (r + 0.05) + uT * (0.3 + uBass * 1.2 * aMix);
  float pattern = fbm(vec2(a * 2.0, depth) * 3.0) + 0.5 * sin(a * 8.0 + uT);
  return clamp(pattern * (sin(depth * 10.0 - uT * 2.0) * 0.5 + 0.5) * smoothstep(0.0, 0.5, r), 0.0, 1.0);
}
float famMoire(vec2 uv) {
  float r = length(uv);
  return (sin(r * 40.0 - uT * 2.0) * sin(dot(uv, uv) * 30.0 + uT) * sin(atan(uv.y, uv.x) * 20.0 + uT)) * 0.5 + 0.5;
}
float famTruchet(vec2 uv) {
  vec2 p = uv * 3.0; vec2 fp = fract(p) - 0.5;
  if (hash(floor(p)) < 0.5) fp.x = -fp.x;
  float dd = min(abs(length(fp - 0.5) - 0.5), abs(length(fp + 0.5) - 0.5));
  return smoothstep(0.08, 0.0, dd - 0.02 * sin(uT * 2.0));
}
float famGyroid(vec2 uv) {
  vec2 p = uv * 4.0;
  return (sin(p.x + uT) * cos(p.y) + sin(p.y + uT * 0.7) * cos(p.x * 1.3)) * 0.25 + 0.5;
}
float famHex(vec2 uv) {
  vec2 p = uv * 3.0; vec2 h = vec2(1.0, 1.732);
  vec2 a = mod(p, h) - h * 0.5, b = mod(p - h * 0.5, h) - h * 0.5;
  vec2 gv = dot(a, a) < dot(b, b) ? a : b;
  return smoothstep(0.5, 0.45, length(gv) + 0.05 * sin(uT * 2.0));
}
float famGrid(vec2 uv) {
  vec2 g = sin(uv * 8.0 + vec2(uT, uT * 1.3));
  return g.x * g.y * 0.5 + 0.5;
}
float famClouds(vec2 uv) { return fbm(uv * 2.5 + vec2(uT * 0.1, uT * 0.07)); }
float famSpiral(vec2 uv) {
  float r = length(uv), a = atan(uv.y, uv.x);
  return sin(6.0 * a + log(r + 0.001) * 6.0 - uT * 2.0) * 0.5 + 0.5;
}
float famCrystals(vec2 uv) {
  vec2 p = fract(uv * 2.0) - 0.5;
  float a = atan(p.y, p.x), r = length(p);
  float star = cos(a * 5.0 + uT) * 0.2 + 0.3;
  return smoothstep(star, star - 0.05, r);
}

// ---- Silhouette families (people & objects via signed distance fields) ----
float sdSeg(vec2 p, vec2 a, vec2 b, float r) {
  vec2 pa = p - a, ba = b - a;
  float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
  return length(pa - ba * h) - r;
}

// A dancing humanoid: torso, head, swinging arms and stepping legs. t drives
// the dance; e (audio energy) raises the arms and adds a vertical bounce.
float sdDancer(vec2 p, float t, float e) {
  float b = 0.06 * e * sin(t * 6.0);            // bounce on the beat
  vec2 hip  = vec2(0.0, -0.05 + b);
  vec2 neck = vec2(0.0,  0.30 + b);
  vec2 head = vec2(0.0,  0.46 + b);
  float s = sin(t * 3.0);
  float raise = e * 0.55;

  float d = sdSeg(p, hip, neck, 0.06);          // torso
  d = min(d, length(p - head) - 0.10);          // head

  vec2 shL = neck + vec2(-0.10, 0.0), shR = neck + vec2(0.10, 0.0);
  vec2 elbL = shL + vec2(-0.12, -0.10 + 0.18 * s + raise);
  vec2 hndL = elbL + vec2(-0.10,  0.02 + 0.20 * s + raise);
  vec2 elbR = shR + vec2( 0.12, -0.10 - 0.18 * s + raise);
  vec2 hndR = elbR + vec2( 0.10,  0.02 - 0.20 * s + raise);
  d = min(d, sdSeg(p, shL, elbL, 0.045));
  d = min(d, sdSeg(p, elbL, hndL, 0.038));
  d = min(d, sdSeg(p, shR, elbR, 0.045));
  d = min(d, sdSeg(p, elbR, hndR, 0.038));

  vec2 kneeL = hip + vec2(-0.06, -0.22 + 0.06 * s);
  vec2 footL = kneeL + vec2(-0.02 - 0.06 * s, -0.22);
  vec2 kneeR = hip + vec2( 0.06, -0.22 - 0.06 * s);
  vec2 footR = kneeR + vec2( 0.02 + 0.06 * s, -0.22);
  d = min(d, sdSeg(p, hip, kneeL, 0.05));
  d = min(d, sdSeg(p, kneeL, footL, 0.04));
  d = min(d, sdSeg(p, hip, kneeR, 0.05));
  d = min(d, sdSeg(p, kneeR, footR, 0.04));
  return d;
}

float famDancers(vec2 uv) {
  float d = 1e9;
  float energy = uBass * aMix + 0.3;
  for (int i = 0; i < 5; i++) {
    float fi = float(i);
    vec2 p = (uv - vec2(-0.9 + fi * 0.45, -0.32)) / 0.55;
    d = min(d, sdDancer(p, uT + fi * 1.3, energy));
  }
  return smoothstep(0.02, 0.0, d);
}

float famDancerSolo(vec2 uv) {
  vec2 p = (uv - vec2(0.0, -0.15)) / 0.95;
  return smoothstep(0.018, 0.0, sdDancer(p, uT * 1.2, uBass * aMix * 1.2 + 0.4));
}

float sdNote(vec2 p) {
  float d = length(p * vec2(1.15, 1.0)) - 0.12;        // note head
  d = min(d, sdSeg(p, vec2(0.10, 0.0), vec2(0.10, 0.5), 0.022)); // stem
  d = min(d, sdSeg(p, vec2(0.10, 0.5), vec2(0.24, 0.40), 0.022)); // flag
  return d;
}

float famSilhouettes(vec2 uv) {
  float d = 1e9;
  for (int i = 0; i < 6; i++) {
    float fi = float(i);
    float y = 0.32 * sin(uT + fi * 1.7) + 0.06 * uBeat * aMix;
    vec2 p = (uv - vec2(-0.8 + fi * 0.32, y)) / (0.5 + 0.15 * sin(fi));
    d = min(d, sdNote(p));
  }
  return smoothstep(0.02, 0.0, d);
}

// Custom source: sample the uploaded SVG/image as the scalar field. Coverage
// (alpha) defines the shape; brightness adds inner detail.
float famCustom(vec2 uv) {
  // Fit the square texture to ~70% of screen height (coeff > 1 shrinks it).
  vec2 tc = uv * 1.45 + 0.5;
  if (tc.x < 0.0 || tc.x > 1.0 || tc.y < 0.0 || tc.y > 1.0) return 0.0;
  vec4 t = texture(uTex, tc);
  float luma = dot(t.rgb, vec3(0.299, 0.587, 0.114));
  return t.a * (0.55 + 0.45 * luma);  // coverage dominates so dark silhouettes stay visible
}

// ---- VU-meter families (use the live spectrum) ----
float specAt(int i) { return uSpectrum[i]; }

// Classic spectrum-analyser bars rising from the bottom.
float famVUBars(vec2 uv) {
  float xn = uv.x * 0.62 + 0.5;          // map width to [0,1]
  if (xn < 0.0 || xn > 1.0) return 0.0;
  float N = 32.0;
  int col = int(clamp(xn * N, 0.0, N - 1.0));
  float level = specAt(col);
  float yb = (uv.y + 0.46) / 0.92;        // 0 bottom -> 1 top
  if (yb < 0.0 || yb > 1.0) return 0.0;
  float bx = fract(xn * N);
  float gap = smoothstep(0.04, 0.12, bx) * smoothstep(0.96, 0.88, bx); // bar spacing
  float lit = step(yb, level) * gap;
  // peak cap line just above the level
  float cap = smoothstep(0.03, 0.0, abs(yb - level)) * gap;
  return max(lit * (0.2 + 0.8 * yb), cap);
}

// Analogue needle gauge.
float famVUNeedle(vec2 uv) {
  vec2 p = uv - vec2(0.0, -0.28);
  float r = length(p);
  float ang = atan(p.x, p.y);             // 0 = straight up
  float na = (clamp(uLevel, 0.0, 1.0) - 0.5) * 1.7 + uBass * 0.15;
  float needle = smoothstep(0.045, 0.0, abs(ang - na)) * step(r, 0.62) * step(0.04, r);
  float arc = smoothstep(0.018, 0.0, abs(r - 0.62)) * step(abs(ang), 0.9);
  float hub = smoothstep(0.06, 0.045, r);
  // red zone near the top of the scale
  float redzone = step(0.55, ang) * arc;
  return max(max(needle, hub), arc * (0.5 + 0.5 * redzone));
}

// Stereo LED level meters (two segmented horizontal bars).
float famVUStereo(vec2 uv) {
  float xn = uv.x * 0.6 + 0.5;
  if (xn < 0.0 || xn > 1.0) return 0.0;
  float lvlTop = clamp(uLevel * 1.1, 0.0, 1.0);
  float lvlBot = clamp((uBass + uTreble) * 0.6, 0.0, 1.0);
  float seg = step(0.18, fract(xn * 26.0));          // LED gaps
  float v = 0.0;
  if (abs(uv.y - 0.12) < 0.07) v = step(xn, lvlTop) * seg * (0.25 + 0.75 * xn);
  if (abs(uv.y + 0.12) < 0.07) v = step(xn, lvlBot) * seg * (0.25 + 0.75 * xn);
  return v;
}

// ---- Waveform + band-reactive families ----
float waveAt(int i) { return uWave[i]; }

// Scrolling song waveform: a mirrored filled envelope that moves with time,
// like the waveform display in DJ software (newest sample at the right edge).
float famWave(vec2 uv) {
  float xn = uv.x * 0.5 + 0.5;
  if (xn < 0.0 || xn > 1.0) return 0.0;
  float fx = xn * 255.0;
  int i0 = int(floor(fx));
  int i1 = min(i0 + 1, 255);
  float amp = mix(uWaveHist[i0], uWaveHist[i1], fract(fx)) * 0.85;
  float ay = abs(uv.y);
  float fill = smoothstep(amp, amp - 0.012, ay);          // solid body
  float edge = smoothstep(0.014, 0.0, abs(ay - amp));     // bright crest
  // a faint centre line so silence still reads as a waveform
  float centre = smoothstep(0.006, 0.0, ay) * 0.4;
  return clamp(fill * 0.55 + edge + centre, 0.0, 1.5);
}

// Radial oscilloscope: the waveform wrapped around a circle (interpolated).
float famWaveCircle(vec2 uv) {
  float a = atan(uv.y, uv.x);
  float r = length(uv);
  float ft = (a / 6.2831853 + 0.5) * 255.0;
  int i0 = int(floor(clamp(ft, 0.0, 255.0)));
  int i1 = min(i0 + 1, 255);
  float w = mix(waveAt(i0), waveAt(i1), fract(ft));
  float radius = 0.42 + w * 0.2 * (0.6 + uLevel * aMix);
  float d = abs(r - radius);
  return smoothstep(0.012, 0.0, d) + 0.28 * smoothstep(0.07, 0.0, d);
}

// Concentric zones, each reacting to a different band (inner=bass … outer=treble).
float famTriBand(vec2 uv) {
  float r = length(uv);
  float band = r < 0.33 ? uBass : (r < 0.66 ? uMid : uTreble);
  float rings = 0.5 + 0.5 * sin(r * 30.0 - uT * 3.0);
  return rings * (0.18 + 1.6 * band * aMix) * smoothstep(1.1, 0.05, r);
}

float famBass(vec2 uv) {
  float r = length(uv), b = uBass * aMix;
  float blob = smoothstep(0.7 + b * 0.6, 0.0, r);
  float rings = (0.5 + 0.5 * sin(r * 12.0 - uT * 2.0)) * smoothstep(1.2, 0.2, r);
  return (blob + rings * 0.6) * (0.3 + 1.4 * b);
}
float famMid(vec2 uv) {
  float r = length(uv), a = atan(uv.y, uv.x), m = uMid * aMix;
  float petals = 0.5 + 0.5 * sin(a * 6.0 + uT * 2.0 + r * 8.0);
  return petals * smoothstep(0.95, 0.0, r) * (0.25 + 1.6 * m);
}
float famTreble(vec2 uv) {
  float t = uTreble * aMix, r = length(uv);
  float g = hash(floor(uv * 42.0) + floor(vec2(uT * 8.0)));
  float sparkle = step(0.72, g) * g;
  return sparkle * (0.2 + 2.2 * t) * smoothstep(1.1, 0.1, r);
}

float field(int f, vec2 uv) {
  if (f == 0) return famJulia(uv);
  if (f == 1) return famMandel(uv);
  if (f == 2) return famPlasma(uv);
  if (f == 3) return famVortex(uv);
  if (f == 4) return famWaves(uv);
  if (f == 5) return famCells(uv);
  if (f == 6) return famHyper(uv);
  if (f == 7) return famTunnel(uv);
  if (f == 8) return famMoire(uv);
  if (f == 9) return famTruchet(uv);
  if (f == 10) return famGyroid(uv);
  if (f == 11) return famHex(uv);
  if (f == 12) return famGrid(uv);
  if (f == 13) return famClouds(uv);
  if (f == 14) return famSpiral(uv);
  if (f == 16) return famDancers(uv);
  if (f == 17) return famDancerSolo(uv);
  if (f == 18) return famSilhouettes(uv);
  if (f == 19) return famCustom(uv);
  if (f == 20) return famVUBars(uv);
  if (f == 21) return famVUNeedle(uv);
  if (f == 22) return famVUStereo(uv);
  if (f == 23) return famWave(uv);
  if (f == 24) return famWaveCircle(uv);
  if (f == 25) return famTriBand(uv);
  if (f == 26) return famBass(uv);
  if (f == 27) return famMid(uv);
  if (f == 28) return famTreble(uv);
  return famCrystals(uv); // f == 15
}

vec3 colorize(float v, vec2 uv0) {
  v = clamp(v, 0.0, 1.0);
  vec3 hsv = rgb2hsv(mix(uColorA, uColorB, v));
  hsv.x = fract(hsv.x + uHueBase + uHueCycle * uT + uTreble * 0.06 * aMix);
  hsv.y = clamp(hsv.y * uSat, 0.0, 1.0);
  // Brightness clearly pulses with the loudness and punches on the beat.
  hsv.z = pow(clamp(hsv.z, 0.0, 1.0), uContrast) * (0.5 + 1.3 * uLevel * aMix + 0.6 * uBeat * aMix);
  vec3 col = hsv2rgb(hsv);
  if (uInvert > 0.5) col = vec3(1.0) - col;
  // For silhouette/meter effects, fade the empty field to black.
  col *= mix(1.0, smoothstep(0.0, 0.04, v), uBgDark);
  col += (uBeat * 0.35 + uLevel * 0.12) * aMix;
  col *= 1.0 - 0.28 * dot(uv0, uv0);
  return col;
}

void main() {
  uT = uTime * uSpeed;
  aMix = uAudioMix;
  vec2 uv0 = (gl_FragCoord.xy - 0.5 * uRes) / uRes.y;
  vec2 uv = rot(uRot + uRotSpeed * uT) * uv0;
  uv /= (uScale * (1.0 + uBass * 0.8 * aMix));

  if (uSym > 0.5) {
    float a = atan(uv.y, uv.x), r = length(uv);
    a = mod(a, 6.2831853 / uSym);
    a = abs(a - 3.14159265 / uSym);
    uv = vec2(cos(a), sin(a)) * r;
  }
  if (uWarp > 0.001) {
    uv += uWarp * vec2(fbm(uv * 2.0 + uT * 0.1), fbm(uv * 2.0 - uT * 0.1 + 3.3));
  }

  float v = field(uFamily, uv);
  fragColor = vec4(colorize(v, uv0), 1.0);
}
`;

window.SHADERS = { vert: VERT, frag: FRAG };
