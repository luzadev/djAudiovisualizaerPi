// Minimal dependency-free PNG icon generator (solid bg + glowing disc + bars).
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}
function png(size, draw) {
  const rgba = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const [r, g, b, a] = draw(x, y, size);
    const i = (y * size + x) * 4; rgba[i] = r; rgba[i + 1] = g; rgba[i + 2] = b; rgba[i + 3] = a;
  }
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) { raw[y * (size * 4 + 1)] = 0; rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4); }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
function draw(x, y, s) {
  const cx = s / 2, cy = s / 2, d = Math.hypot(x - cx, y - cy) / (s / 2);
  // background gradient (dark navy -> black)
  let r = 11 + (1 - y / s) * 10, g = 11 + (1 - y / s) * 8, b = 20 + (1 - y / s) * 18;
  // glowing disc
  const glow = Math.max(0, 1 - d * 1.15);
  r += glow * 90; g += glow * 130; b += glow * 255;
  // 3 vertical bars (equalizer)
  const bw = s * 0.10, gap = s * 0.06, total = bw * 3 + gap * 2, x0 = cx - total / 2;
  const heights = [0.30, 0.52, 0.40];
  for (let k = 0; k < 3; k++) {
    const bx = x0 + k * (bw + gap);
    const bh = s * heights[k], by = cy + s * 0.18 - bh;
    if (x >= bx && x <= bx + bw && y >= by && y <= cy + s * 0.18) { r = 240; g = 245; b = 255; }
  }
  return [Math.min(255, r) | 0, Math.min(255, g) | 0, Math.min(255, b) | 0, 255];
}
const outDir = path.join(__dirname, '..', 'public', 'icons');
fs.mkdirSync(outDir, { recursive: true });
for (const size of [192, 512]) fs.writeFileSync(path.join(outDir, 'icon-' + size + '.png'), png(size, draw));
console.log('icone generate in', outDir);
