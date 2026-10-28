// Generates icons/atlas-v1-*.png (no dependencies): teal→blue gradient tile with a globe and a map pin.
// Same family as the other apps' icons: rounded square, radius 23 %, warm-white symbol. "any" icons keep
// transparent corners; maskable (content inside the 80 % safe zone) and apple-touch are full-bleed
// (iOS fills transparency with black and rounds the corners itself). Geometry in 0..100 units,
// matching icons/atlas-v1.svg. Run: node scripts/make-icons.mjs  (npm run icons)
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const OUT = new URL('../icons/', import.meta.url);
const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const GRADIENT = ['#5eead4', '#2563eb'];      // top-left → bottom-right
const INK = hex('#fffaf4');
const SAFE = 0.8;                             // maskable: symbol scaled to the safe zone

// Globe: circle + meridian ellipse + two parallels (chords of the circle), stroke SW.
const G = { cx: 44, cy: 44, r: 28, mer: 11, par: 13, sw: 5.2 };
// Pin: head circle (PH) and tip circle (PT) joined by tangents; hole in the head; background halo around it.
const PIN = { x: 69, headY: 61, headR: 14, tipY: 86, tipR: 2, hole: 5.2, halo: 3.5 };

// ---- PNG encoding ------------------------------------------------------

const CRC = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
function crc32(buf) {
  let c = -1;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(size, rgba) {
  const stride = size * 4;
  const raw = Buffer.alloc(size * (stride + 1));
  for (let y = 0; y < size; y++) rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;                    // bit depth
  ihdr[9] = 6;                    // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---- Geometry (signed distances: negative inside) ----------------------

const clamp01 = (v) => Math.max(0, Math.min(1, v));
const lerp = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);

/** Rounded square spanning 1..99 with radius 23. */
function tile(u, v) {
  const q = (p) => Math.abs(p - 50) - 49 + 23;
  const qx = q(u);
  const qy = q(v);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - 23;
}

/** Horizontal capsule from x0 to x1 at height y. */
const capsule = (u, v, x0, x1, y, r) => Math.hypot(u - Math.max(x0, Math.min(x1, u)), v - y) - r;

/** Outline of an ellipse (first-order distance estimate), as a stroke of width sw. */
function ellipseStroke(u, v, cx, cy, a, b, sw) {
  const x = u - cx;
  const y = v - cy;
  const k0 = Math.hypot(x / a, y / b);
  const k1 = Math.hypot(x / (a * a), y / (b * b));
  const d = k1 === 0 ? -Math.min(a, b) : (k0 * (k0 - 1)) / k1;
  return Math.abs(d) - sw / 2;
}

/** Pin outline: head circle and tip circle joined by their outer tangents (uneven capsule). */
function pin(u, v) {
  const h = PIN.tipY - PIN.headY;
  const px = Math.abs(u - PIN.x);
  const py = PIN.tipY - v;                       // up from the tip
  const b = (PIN.tipR - PIN.headR) / h;
  const a = Math.sqrt(1 - b * b);
  const k = -b * px + a * py;
  if (k < 0) return Math.hypot(px, py) - PIN.tipR;
  if (k > a * h) return Math.hypot(px, py - h) - PIN.headR;
  return a * px + b * py - PIN.tipR;
}

/** Straight-alpha "over" compositing into dst = [r, g, b, a]. */
function over(dst, rgb, a) {
  if (a <= 0) return;
  const outA = a + dst[3] * (1 - a);
  for (let i = 0; i < 3; i++) dst[i] = (rgb[i] * a + dst[i] * dst[3] * (1 - a)) / outA;
  dst[3] = outA;
}

/** kind: 'any' (transparent corners) | 'maskable' (full bleed, symbol in the safe zone) | 'apple' (full bleed). */
export function draw(size, kind) {
  const s = size / 100;
  const k = kind === 'maskable' ? SAFE : 1;
  const px1 = 1 / (s * k);                       // one output pixel in symbol units
  const cover = (d) => clamp01(-d / px1 + 0.5);
  const [ga, gb] = GRADIENT.map(hex);
  const out = Buffer.alloc(size * size * 4);
  const chord = Math.sqrt(G.r * G.r - G.par * G.par);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const ru = (x + 0.5) / s;
      const rv = (y + 0.5) / s;
      const u = 50 + (ru - 50) / k;              // symbol coordinates
      const v = 50 + (rv - 50) / k;
      const bg = lerp(ga, gb, clamp01((ru + rv - 10) / 180));
      const c = [0, 0, 0, 0];
      over(c, bg, kind === 'any' ? clamp01(-tile(ru, rv) / (1 / s) + 0.5) : 1);
      const ring = Math.abs(Math.hypot(u - G.cx, v - G.cy) - G.r) - G.sw / 2;
      over(c, INK, cover(ring));
      over(c, INK, cover(ellipseStroke(u, v, G.cx, G.cy, G.mer, G.r, G.sw)));
      for (const dy of [-G.par, G.par]) over(c, INK, cover(capsule(u, v, G.cx - chord, G.cx + chord, G.cy + dy, G.sw / 2)));
      const d = pin(u, v);
      over(c, bg, cover(d - PIN.halo));          // wipe the globe around the pin
      over(c, INK, cover(d));
      over(c, bg, cover(Math.hypot(u - PIN.x, v - PIN.headY) - PIN.hole));
      out.set(c.map((ch, i) => Math.round(i === 3 ? ch * 255 : ch)), (y * size + x) * 4);
    }
  }
  return png(size, out);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  mkdirSync(OUT, { recursive: true });
  // Names carry the design version: devices cache icons by URL, so a redesign needs new names.
  const ICONS = [
    ['atlas-v1-192.png', 192, 'any'],
    ['atlas-v1-512.png', 512, 'any'],
    ['atlas-v1-maskable-512.png', 512, 'maskable'],
    ['atlas-v1-apple-180.png', 180, 'apple'],
  ];
  for (const [name, size, kind] of ICONS) {
    writeFileSync(new URL(name, OUT), draw(size, kind));
    console.log('wrote icons/' + name);
  }
}
