// Generates icons/atlas-v1.svg and icons/atlas-v1-*.png (no dependencies): terracotta gradient tile with the
// Equal Earth world map (cream; visited countries solid, the others at 38 %, as the bars in Habits) and a
// cream teardrop pin with a terracotta halo on Naples. The map is built at run time from geo/world.json with
// js/geo.js (Antarctica left out, fitted into a box of the 100x100 tile). "any" icons keep transparent corners;
// maskable (symbol inside the 80 % safe zone) and apple-touch are full bleed (iOS fills transparency with
// black and rounds the corners itself). Run: node scripts/make-icons.mjs  (npm run icons)
import { deflateSync } from 'node:zlib';
import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { decode, equalEarth } from '../js/geo.js';

const ROOT = new URL('../', import.meta.url);
const OUT = new URL('icons/', ROOT);
const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const GRADIENT = ['#f0a07a', '#b8461f'];      // terracotta, top-left → bottom-right, from (5,5) to (95,95)
const CREAM = '#fffaf4';
const HALO = '#d4683d';
const HOLE = '#b8461f';
const SAFE = 0.8;                             // maskable: symbol scaled to the safe zone
const BOX = [4, 25, 92, 50];                  // world map: x, y, w, h in the 100x100 tile
const MIN_STEP = 0.9;                         // points closer than this are dropped
const MIN_AREA = 0.8;                         // rings smaller than this (square units) are dropped
const COUNTRY_SW = 0.35;                      // country outline, same colour as the fill, round joins
const DIM = 0.38;
const VISITED = new Set(['IT', 'FR', 'ES', 'PT', 'DE', 'GB', 'IE', 'GR', 'NL', 'AT', 'CH', 'US', 'JP', 'MA', 'EG', 'AL', 'PL']);
const NAPLES = [14.27, 40.85];                // lon, lat
// Teardrop, tip at the origin; placed on Naples at PIN_SCALE; halo = stroke painted behind the fill.
const DROP = 'M0 0C-2.6-6.5-11-12.2-11-20.5a11 11 0 0 1 22 0C11-12.2 2.6-6.5 0 0Z';
const PIN_SCALE = 0.73;
const PIN_HALO = 4.5;
const PIN_HOLE = { y: -20.5, r: 4.6 };
const SUB = 16;                               // sub-scanlines per pixel

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

// ---- Art (geometry in 0..100 tile units) -------------------------------

const r1 = (v) => Math.round(v * 10) / 10;

/** World rings (Equal Earth, Antarctica excluded) fitted into BOX; Naples position in tile units. */
function buildWorld() {
  const wo = JSON.parse(readFileSync(new URL('geo/world.json', ROOT)));
  const all = wo.features.filter((f) => f.c !== 'Antarctica').map((f) => ({
    k: f.k,
    rings: decode(f, wo.q).map((r) => r.map(([lon, lat]) => { const [x, y] = equalEarth(lon, lat); return [x, -y]; })),
  }));
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const f of all) for (const r of f.rings) for (const [x, y] of r) {
    minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y);
  }
  const [bx, by, bw, bh] = BOX;
  const s = Math.min(bw / (maxX - minX), bh / (maxY - minY));
  const ox = bx + (bw - (maxX - minX) * s) / 2;
  const oy = by + (bh - (maxY - minY) * s) / 2;
  const tf = ([x, y]) => [r1((x - minX) * s + ox), r1((y - minY) * s + oy)];
  const lit = [], dim = [];
  for (const f of all) {
    for (const r of f.rings) {
      const pts = [];
      for (const p of r.map(tf)) {
        const l = pts[pts.length - 1];
        if (!l || Math.hypot(p[0] - l[0], p[1] - l[1]) >= MIN_STEP) pts.push(p);
      }
      if (pts.length < 4) continue;
      let a = 0;
      for (let i = 0; i < pts.length - 1; i++) a += pts[i][0] * pts[i + 1][1] - pts[i + 1][0] * pts[i][1];
      if (Math.abs(a / 2) < MIN_AREA) continue;
      (VISITED.has(f.k) ? lit : dim).push(pts);
    }
  }
  const [lon, lat] = NAPLES;
  const [x, y] = equalEarth(lon, lat);
  return { lit, dim, naples: tf([x, -y]) };
}

/** Teardrop outline as a closed polyline (local units, tip at the origin). */
function dropPoly() {
  const bez = (p0, p1, p2, p3, n) => Array.from({ length: n }, (_, i) => {
    const t = (i + 1) / n, u = 1 - t;
    return [0, 1].map((k) => u * u * u * p0[k] + 3 * u * u * t * p1[k] + 3 * u * t * t * p2[k] + t * t * t * p3[k]);
  });
  const pts = [[0, 0]];
  pts.push(...bez([0, 0], [-2.6, -6.5], [-11, -12.2], [-11, -20.5], 24));
  for (let i = 1; i <= 48; i++) {               // semicircle over the top, left → right
    const a = Math.PI + (Math.PI * i) / 48;
    pts.push([11 * Math.cos(a), -20.5 + 11 * Math.sin(a)]);
  }
  pts.push(...bez([11, -20.5], [11, -12.2], [2.6, -6.5], [0, 0], 24));
  return pts;
}

const circlePoly = (cx, cy, r, n = 64) => Array.from({ length: n }, (_, i) => {
  const a = (2 * Math.PI * i) / n;
  return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
});

/** Compact path data: implicit lineto after the first point. */
const pathData = (rings) => rings.map((r) => `M${r.map((p) => p.join(' ')).join(' ')}Z`).join('');

function svgMaster(world) {
  const [px, py] = world.naples;
  const pin = `<path d="${DROP}" fill="none" stroke="${HALO}" stroke-width="${PIN_HALO}" stroke-linejoin="round" stroke-linecap="round"/>`
    + `<path d="${DROP}" fill="${CREAM}"/><circle cy="${PIN_HOLE.y}" r="${PIN_HOLE.r}" fill="${HOLE}"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
<defs><linearGradient id="g" x1="5" y1="5" x2="95" y2="95" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="${GRADIENT[0]}"/><stop offset="1" stop-color="${GRADIENT[1]}"/></linearGradient></defs>
<rect x="1" y="1" width="98" height="98" rx="23" fill="url(#g)"/>
<g fill="${CREAM}" stroke="${CREAM}" stroke-width="${COUNTRY_SW}" stroke-linejoin="round"><path opacity="${DIM}" d="${pathData(world.dim)}"/><path d="${pathData(world.lit)}"/></g>
<g transform="translate(${px} ${py}) scale(${PIN_SCALE})">${pin}</g>
</svg>
`;
}

// ---- Rasterizer --------------------------------------------------------
// Antialiased scanline fill: SUB sub-scanlines per pixel, exact horizontal coverage on each. Fill = nonzero
// winding (SVG default); stroke = union of capsules (round joins). Fill and stroke of one shape are united
// on every sub-scanline, so the result is a single coverage mask (what an SVG group with opacity paints).

/** Coverage mask (Float32Array size*size, 0..1) of polygons given in pixel coordinates. */
function coverage(size, polys, { fill = true, sw = 0 } = {}) {
  const H = size * SUB;
  const xs = new Array(H);                       // fill crossings per sub-scanline: [x, winding]
  const bands = new Array(H);                    // stroke intervals per sub-scanline: [x0, x1]
  const rowOf = (y) => Math.ceil(y * SUB - 0.5);  // first sub-scanline whose centre is >= y
  const add = (arr, j, v) => { (arr[j] ||= []).push(v); };
  const rad = sw / 2;
  for (const poly of polys) {
    for (let i = 0; i < poly.length; i++) {
      const [x0, y0] = poly[i];
      const [x1, y1] = poly[(i + 1) % poly.length];
      if (fill && y0 !== y1) {
        const dir = y1 > y0 ? 1 : -1;
        const j0 = Math.max(0, rowOf(Math.min(y0, y1)));
        const j1 = Math.min(H, rowOf(Math.max(y0, y1)));
        for (let j = j0; j < j1; j++) {
          const y = (j + 0.5) / SUB;
          add(xs, j, [x0 + ((y - y0) * (x1 - x0)) / (y1 - y0), dir]);
        }
      }
      if (rad > 0) {
        const dx = x1 - x0, dy = y1 - y0, len = Math.hypot(dx, dy);
        const nx = len ? (-dy / len) * rad : 0, ny = len ? (dx / len) * rad : 0;
        const j0 = Math.max(0, rowOf(Math.min(y0, y1) - rad));
        const j1 = Math.min(H, rowOf(Math.max(y0, y1) + rad));
        const quad = len ? [[x0 + nx, y0 + ny], [x1 + nx, y1 + ny], [x1 - nx, y1 - ny], [x0 - nx, y0 - ny]] : [];
        for (let j = j0; j < j1; j++) {
          const y = (j + 0.5) / SUB;
          let lo = Infinity, hi = -Infinity;
          for (const [cx, cy] of [[x0, y0], [x1, y1]]) {     // end discs
            const d = rad * rad - (y - cy) * (y - cy);
            if (d >= 0) { const w = Math.sqrt(d); lo = Math.min(lo, cx - w); hi = Math.max(hi, cx + w); }
          }
          for (let q = 0; q < quad.length; q++) {          // body rectangle
            const [ax, ay] = quad[q], [bx, by] = quad[(q + 1) % 4];
            if (ay === by || (y < ay) === (y < by)) continue;
            const x = ax + ((y - ay) * (bx - ax)) / (by - ay);
            lo = Math.min(lo, x); hi = Math.max(hi, x);
          }
          if (hi >= lo) add(bands, j, [lo, hi]);
        }
      }
    }
  }
  const mask = new Float32Array(size * size);
  for (let j = 0; j < H; j++) {
    const spans = bands[j] ? bands[j].slice() : [];
    if (xs[j]) {
      const c = xs[j].sort((a, b) => a[0] - b[0]);
      let wind = 0, start = 0;
      for (const [x, d] of c) {
        const was = wind;
        wind += d;
        if (was === 0 && wind !== 0) start = x;
        else if (was !== 0 && wind === 0) spans.push([start, x]);
      }
    }
    if (!spans.length) continue;
    spans.sort((a, b) => a[0] - b[0]);
    const row = Math.floor(j / SUB) * size;
    let [a, b] = spans[0];
    const flush = () => {
      a = Math.max(a, 0);
      b = Math.min(b, size);
      for (let px = Math.floor(a); px < b && px < size; px++) mask[row + px] += (Math.min(b, px + 1) - Math.max(a, px)) / SUB;
    };
    for (let i = 1; i < spans.length; i++) {
      if (spans[i][0] <= b) b = Math.max(b, spans[i][1]);
      else { flush(); [a, b] = spans[i]; }
    }
    flush();
  }
  for (let i = 0; i < mask.length; i++) if (mask[i] > 1) mask[i] = 1;
  return mask;
}

/** Straight-alpha "over" of a flat colour through a coverage mask into img (Float32Array RGBA). */
function paint(img, mask, rgb, alpha = 1) {
  for (let i = 0; i < mask.length; i++) {
    const a = mask[i] * alpha;
    if (a <= 0) continue;
    const o = i * 4;
    const outA = a + img[o + 3] * (1 - a);
    for (let c = 0; c < 3; c++) img[o + c] = (rgb[c] * a + img[o + c] * img[o + 3] * (1 - a)) / outA;
    img[o + 3] = outA;
  }
}

const clamp01 = (v) => Math.max(0, Math.min(1, v));

/** Rounded square spanning 1..99 with radius 23: signed distance, negative inside. */
function tile(u, v) {
  const q = (p) => Math.abs(p - 50) - 49 + 23;
  const qx = q(u);
  const qy = q(v);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - 23;
}

/** kind: 'any' (transparent corners) | 'maskable' (full bleed, symbol in the safe zone) | 'apple' (full bleed). */
export function draw(size, kind, world = buildWorld()) {
  const s = size / 100;
  const k = kind === 'maskable' ? SAFE : 1;
  const m = k * s;                               // tile units → pixels for the symbol
  const at = (v) => (50 + (v - 50) * k) * s;     // symbol coordinate → pixel
  const toPx = (poly) => poly.map(([x, y]) => [at(x), at(y)]);
  const [ga, gb] = GRADIENT.map(hex);
  const img = new Float32Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = (x + 0.5) / s, v = (y + 0.5) / s;
      const t = clamp01((u + v - 10) / 180);
      const o = (y * size + x) * 4;
      for (let c = 0; c < 3; c++) img[o + c] = ga[c] + (gb[c] - ga[c]) * t;
      img[o + 3] = kind === 'any' ? clamp01(-tile(u, v) * s + 0.5) : 1;
    }
  }
  const cream = hex(CREAM);
  const dim = coverage(size, world.dim.map(toPx), { sw: COUNTRY_SW * m });
  const lit = coverage(size, world.lit.map(toPx), { sw: COUNTRY_SW * m });
  paint(img, dim, cream, DIM);
  paint(img, lit, cream);
  const [px, py] = world.naples;
  const pin = dropPoly().map(([x, y]) => [at(px + x * PIN_SCALE), at(py + y * PIN_SCALE)]);
  paint(img, coverage(size, [pin], { fill: false, sw: PIN_HALO * PIN_SCALE * m }), hex(HALO));
  paint(img, coverage(size, [pin]), cream);
  const hole = circlePoly(at(px), at(py + PIN_HOLE.y * PIN_SCALE), PIN_HOLE.r * PIN_SCALE * m);
  paint(img, coverage(size, [hole]), hex(HOLE));
  const out = Buffer.alloc(size * size * 4);
  for (let i = 0; i < img.length; i++) out[i] = Math.round(i % 4 === 3 ? img[i] * 255 : img[i]);
  return png(size, out);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  mkdirSync(OUT, { recursive: true });
  const t0 = performance.now();
  const world = buildWorld();
  writeFileSync(new URL('atlas-v1.svg', OUT), svgMaster(world));
  console.log('wrote icons/atlas-v1.svg');
  // Names carry the design version: devices cache icons by URL, so a redesign needs new names.
  const ICONS = [
    ['atlas-v1-192.png', 192, 'any'],
    ['atlas-v1-512.png', 512, 'any'],
    ['atlas-v1-maskable-512.png', 512, 'maskable'],
    ['atlas-v1-apple-180.png', 180, 'apple'],
  ];
  for (const [name, size, kind] of ICONS) {
    writeFileSync(new URL(name, OUT), draw(size, kind, world));
    console.log('wrote icons/' + name);
  }
  console.log(`done in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
}
