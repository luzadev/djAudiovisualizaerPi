// Effect catalog generator. Combines 16 shader families × color palettes ×
// style variants to produce hundreds of named presets. Shared by both windows.
// Wrapped in an IIFE so its locals don't leak into the shared global scope
// (control.js also defines an EFFECTS reference).
(function () {

const FAMILIES = [
  { name: 'Julia', scale: 1.35 },
  { name: 'Mandelbrot', scale: 1.1 },
  { name: 'Plasma', scale: 1.0 },
  { name: 'Vortice', scale: 1.0 },
  { name: 'Onde', scale: 1.0 },
  { name: 'Cellule', scale: 1.0 },
  { name: 'Iperspazio', scale: 1.0 },
  { name: 'Tunnel', scale: 1.0 },
  { name: 'Moiré', scale: 1.0 },
  { name: 'Truchet', scale: 1.0 },
  { name: 'Gyroide', scale: 1.0 },
  { name: 'Esagoni', scale: 1.0 },
  { name: 'Reticolo', scale: 1.0 },
  { name: 'Nuvole', scale: 1.0 },
  { name: 'Spirale', scale: 1.0 },
  { name: 'Cristalli', scale: 1.0 },
  { name: 'Ballerini', scale: 1.0, bgDark: true },
  { name: 'Ballerino', scale: 1.0, bgDark: true },
  { name: 'Sagome', scale: 1.0, bgDark: true },
  { name: 'SVG/Immagine', scale: 1.0, bgDark: true },
  { name: 'VU Barre', scale: 1.0, bgDark: true },
  { name: 'VU Analogico', scale: 1.0, bgDark: true },
  { name: 'VU Stereo', scale: 1.0, bgDark: true },
  { name: 'Waveform', scale: 1.0, bgDark: true },
  { name: 'Waveform Radiale', scale: 1.0, bgDark: true },
  { name: 'Tri-Banda', scale: 1.0, bgDark: true },
  { name: 'Reattivo Bassi', scale: 1.0, bgDark: true },
  { name: 'Reattivo Medi', scale: 1.0, bgDark: true },
  { name: 'Reattivo Alti', scale: 1.0, bgDark: true }
];

// Palettes: low colour (a) -> high colour (b), plus optional hue-cycle/sat.
const PALETTES = [
  { name: 'Neon', a: [0.05, 0.0, 0.2], b: [0.2, 1.0, 1.0], cycle: 0.02 },
  { name: 'Tramonto', a: [0.15, 0.0, 0.1], b: [1.0, 0.65, 0.1], cycle: 0.01 },
  { name: 'Oceano', a: [0.0, 0.05, 0.18], b: [0.1, 0.8, 1.0], cycle: 0.01 },
  { name: 'Foresta', a: [0.0, 0.08, 0.03], b: [0.5, 1.0, 0.2], cycle: 0.01 },
  { name: 'Lava', a: [0.1, 0.0, 0.0], b: [1.0, 0.3, 0.0], cycle: 0.015 },
  { name: 'Ghiaccio', a: [0.02, 0.05, 0.1], b: [0.7, 0.9, 1.0], cycle: 0.005 },
  { name: 'Viola', a: [0.08, 0.0, 0.15], b: [0.8, 0.2, 1.0], cycle: 0.02 },
  { name: 'Oro', a: [0.1, 0.06, 0.0], b: [1.0, 0.85, 0.3], cycle: 0.008 },
  { name: 'Arcobaleno', a: [0.6, 0.1, 0.8], b: [0.1, 0.9, 0.3], cycle: 0.12 },
  { name: 'Monocromo', a: [0.0, 0.0, 0.0], b: [1.0, 1.0, 1.0], cycle: 0.0, sat: 0.0 },
  { name: 'Acido', a: [0.1, 0.2, 0.0], b: [0.7, 1.0, 0.0], cycle: 0.03 },
  { name: 'Pastello', a: [0.4, 0.3, 0.5], b: [1.0, 0.8, 0.9], cycle: 0.02, sat: 0.7 },
  { name: 'Cyberpunk', a: [0.2, 0.0, 0.3], b: [1.0, 0.1, 0.6], cycle: 0.04 },
  { name: 'Infrarosso', a: [0.0, 0.0, 0.1], b: [1.0, 0.0, 0.2], cycle: 0.02 },
  { name: 'Menta', a: [0.0, 0.1, 0.08], b: [0.4, 1.0, 0.8], cycle: 0.01 },
  { name: 'Sabbia', a: [0.15, 0.1, 0.05], b: [0.95, 0.8, 0.55], cycle: 0.006 },
  { name: 'Semaforo', a: [0.0, 1.0, 0.2], b: [1.0, 0.0, 0.0], cycle: 0.0 }   // green -> red (VU)
];

// Style variants: how the universal modifiers are set.
const VARIANTS = [
  { suffix: '', sym: 0, warp: 0.0, speed: 1.0, rotSpeed: 0.0, contrast: 0.8 },
  { suffix: ' · Kaleido', sym: 6, warp: 0.0, speed: 1.0, rotSpeed: 0.04, contrast: 0.9 },
  { suffix: ' · Specchio8', sym: 8, warp: 0.1, speed: 1.0, rotSpeed: 0.02, contrast: 0.9 },
  { suffix: ' · Warp', sym: 0, warp: 0.5, speed: 1.4, rotSpeed: 0.0, contrast: 0.8 },
  { suffix: ' · Turbo', sym: 0, warp: 0.2, speed: 2.2, rotSpeed: 0.06, contrast: 1.0 },
  { suffix: ' · Mirror12', sym: 12, warp: 0.0, speed: 0.8, rotSpeed: 0.03, contrast: 0.95 }
];

function makeEffect(fi, pi, vi) {
  const fam = FAMILIES[fi], pal = PALETTES[pi], v = VARIANTS[vi];
  return {
    name: `${fam.name} · ${pal.name}${v.suffix}`,
    familyName: fam.name,
    paletteName: pal.name,
    family: fi,
    scale: fam.scale,
    rot: 0,
    rotSpeed: v.rotSpeed,
    sym: v.sym,
    hueBase: 0,
    hueCycle: pal.cycle,
    sat: pal.sat !== undefined ? pal.sat : 1.0,
    contrast: v.contrast,
    invert: 0,
    warp: v.warp,
    audioMix: 1.0,
    speed: v.speed,
    colorA: pal.a,
    colorB: pal.b,
    bgDark: fam.bgDark ? 1 : 0
  };
}

// Build the full catalog (16 × 16 × 6 = 1536 presets).
const EFFECTS = [];
for (let fi = 0; fi < FAMILIES.length; fi++)
  for (let pi = 0; pi < PALETTES.length; pi++)
    for (let vi = 0; vi < VARIANTS.length; vi++)
      EFFECTS.push(makeEffect(fi, pi, vi));

window.EFFECTS = {
  list: EFFECTS,
  families: FAMILIES.map(f => f.name),
  palettes: PALETTES.map(p => p.name),
  count: EFFECTS.length,
  defaults: () => makeEffect(2, 0, 0) // Plasma · Neon
};

})();
