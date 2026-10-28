// Builds geo/world.json and geo/italia.json from Natural Earth (dev only; results are committed).
// Run: npm run geo
// Pipeline: GeoJSON -> quantize -> shared-arc topology -> Visvalingam-Whyatt weights ->
// area threshold tuned until each file fits LIMIT -> delta-encoded rings (spec 8.1).
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CACHE = join(ROOT, '.cache');
const GEO = join(ROOT, 'geo');
const BASE = 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/v5.1.2/geojson/';
const COUNTRIES = 'ne_50m_admin_0_countries.geojson';
const ADMIN1 = 'ne_10m_admin_1_states_provinces.geojson';
const LIMIT = 300 * 1000; // bytes per output file

// ---- Italian names ----------------------------------------------------------------------------

const REGIONS = ['Abruzzo', 'Basilicata', 'Calabria', 'Campania', 'Emilia-Romagna', 'Friuli-Venezia Giulia', 'Lazio', 'Liguria', 'Lombardia', 'Marche', 'Molise', 'Piemonte', 'Puglia', 'Sardegna', 'Sicilia', 'Toscana', 'Trentino-Alto Adige', 'Umbria', "Valle d'Aosta", 'Veneto'];

const norm = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// Normalized variant (English/abbreviated/official) -> official region name.
const REGION_IT = new Map(REGIONS.map((r) => [norm(r), r]));
for (const [v, r] of Object.entries({
  apulia: 'Puglia', sicily: 'Sicilia', sardinia: 'Sardegna', tuscany: 'Toscana', piedmont: 'Piemonte', lombardy: 'Lombardia',
  'aosta valley': "Valle d'Aosta", aosta: "Valle d'Aosta", 'vallee d aoste': "Valle d'Aosta",
  friuli: 'Friuli-Venezia Giulia', 'friuli venezia giulia': 'Friuli-Venezia Giulia', 'friuli vg': 'Friuli-Venezia Giulia',
  trentino: 'Trentino-Alto Adige', 'trentino alto adige': 'Trentino-Alto Adige', 'trentino south tyrol': 'Trentino-Alto Adige', 'trentino sudtirol': 'Trentino-Alto Adige',
  'emilia romagna': 'Emilia-Romagna', marches: 'Marche', latium: 'Lazio', abruzzi: 'Abruzzo', abruzzes: 'Abruzzo',
})) REGION_IT.set(v, r);

// ISO 3166-2:IT region codes (admin_1 `region_cod`), cross-check and fallback for the region name.
const REGION_BY_CODE = {
  'IT-21': 'Piemonte', 'IT-23': "Valle d'Aosta", 'IT-25': 'Lombardia', 'IT-32': 'Trentino-Alto Adige', 'IT-34': 'Veneto',
  'IT-36': 'Friuli-Venezia Giulia', 'IT-42': 'Liguria', 'IT-45': 'Emilia-Romagna', 'IT-52': 'Toscana', 'IT-55': 'Umbria',
  'IT-57': 'Marche', 'IT-62': 'Lazio', 'IT-65': 'Abruzzo', 'IT-67': 'Molise', 'IT-72': 'Campania', 'IT-75': 'Puglia',
  'IT-77': 'Basilicata', 'IT-78': 'Calabria', 'IT-82': 'Sicilia', 'IT-88': 'Sardegna',
};

// admin_1 `name_it` is wrong for these (taken from a wrong Wikipedia label); keyed by ISO 3166-2 code.
const PROVINCE_IT_FIX = { 'IT-BZ': 'Bolzano', 'IT-SP': 'La Spezia', 'IT-GE': 'Genova', 'IT-TN': 'Trento', 'IT-AQ': "L'Aquila", 'IT-OG': 'Ogliastra' };

// NAME_IT left in English by Natural Earth; keyed by ADM0_A3.
const COUNTRY_IT_FIX = { IOA: "Territori australiani dell'Oceano Indiano" };

function regionOf(p) {
  const byName = REGION_IT.get(norm(p.region));
  const byCode = REGION_BY_CODE[p.region_cod];
  if (!byName && !byCode) throw new Error(`Region not mappable: province "${p.name}" (region "${p.region}", code "${p.region_cod}")`);
  if (byName && byCode && byName !== byCode) throw new Error(`Region mismatch for "${p.name}": "${byName}" vs "${byCode}"`);
  return byName ?? byCode;
}

function provinceFeatures(fc) {
  const out = fc.features.filter((f) => f.properties.adm0_a3 === 'ITA').map((f) => {
    const p = f.properties;
    if (!/^IT-[A-Z]{2}$/.test(p.iso_3166_2)) throw new Error(`Bad province code "${p.iso_3166_2}" for "${p.name}"`);
    const n = PROVINCE_IT_FIX[p.iso_3166_2] ?? p.name_it ?? p.name;
    const r = regionOf(p);
    if (REGIONS.includes(n)) throw new Error(`Province "${n}" (${p.iso_3166_2}) has a region name: fix PROVINCE_IT_FIX`);
    return { meta: { k: p.iso_3166_2.slice(3), n, r }, geometry: f.geometry };
  });
  unique(out, 'k', 'province code');
  unique(out, 'n', 'province name');
  return out;
}

function countryFeatures(fc) {
  // ISO_A2_EH can repeat (AU for Indian Ocean Ter. / Ashmore and Cartier Is.): the owner keeps it, the rest use ADM0_A3.
  const owner = new Map();
  for (const { properties: p } of fc.features) {
    if (p.ISO_A2_EH !== '-99' && (!owner.has(p.ISO_A2_EH) || p.ADM0_A3 === p.ISO_A3_EH)) owner.set(p.ISO_A2_EH, p.ADM0_A3);
  }
  const out = fc.features.map((f) => {
    const p = f.properties;
    const k = p.ISO_A2_EH !== '-99' && owner.get(p.ISO_A2_EH) === p.ADM0_A3 ? p.ISO_A2_EH : p.ADM0_A3;
    return { meta: { k, n: COUNTRY_IT_FIX[p.ADM0_A3] ?? p.NAME_IT ?? p.NAME, c: p.CONTINENT }, geometry: f.geometry };
  });
  unique(out, 'k', 'country code');
  return out;
}

function unique(feats, field, what) {
  const seen = new Set();
  for (const { meta } of feats) {
    if (!meta[field]) throw new Error(`Empty ${what}`);
    if (seen.has(meta[field])) throw new Error(`Duplicate ${what}: ${meta[field]}`);
    seen.add(meta[field]);
  }
}

// ---- Projections (only to weight Visvalingam-Whyatt by on-screen area; units ~ quantized degrees) ----

const RAD = Math.PI / 180;
const EE = { A1: 1.340264, A2: -0.081106, A3: 0.000893, A4: 0.003796, M: Math.sqrt(3) / 2 };
function equalEarth(lon, lat) {
  const l = lon * RAD;
  const t = Math.asin(EE.M * Math.sin(lat * RAD));
  const t2 = t * t;
  const t6 = t2 * t2 * t2;
  const x = (2 * Math.sqrt(3) * l * Math.cos(t)) / (3 * (EE.A1 + 3 * EE.A2 * t2 + t6 * (7 * EE.A3 + 9 * EE.A4 * t2)));
  const y = t * (EE.A1 + EE.A2 * t2 + t6 * (EE.A3 + EE.A4 * t2));
  return [x / RAD, y / RAD];
}
const COS42 = Math.cos(42 * RAD);
const PROJ = {
  world: (q) => (x, y) => equalEarth(x / q, y / q).map((v) => v * q),
  italia: () => (x, y) => [x * COS42, y],
};

// ---- Geometry helpers -----------------------------------------------------------------------------

// Open ring (no closing duplicate) of quantized points, consecutive duplicates removed; null if < 3 points.
function quantizeRing(coords, q) {
  const pts = [];
  for (const [lon, lat] of coords) {
    const x = Math.round(lon * q);
    const y = Math.round(lat * q);
    const last = pts[pts.length - 1];
    if (!last || last[0] !== x || last[1] !== y) pts.push([x, y]);
  }
  const f = pts[0];
  const l = pts[pts.length - 1];
  if (pts.length > 1 && f[0] === l[0] && f[1] === l[1]) pts.pop();
  return pts.length >= 3 ? pts : null;
}

const ringArea = (pts) => {
  let a = 0;
  for (let i = 0, n = pts.length; i < n; i++) {
    const p = pts[i];
    const r = pts[(i + 1) % n];
    a += p[0] * r[1] - r[0] * p[1];
  }
  return Math.abs(a) / 2;
};

// Numeric key of a quantized point (ranges: |x| < 4e5, |y| < 2e5 up to q = 1e4 at lat 90).
const K = (p) => (p[0] + 4e5) * 4e6 + (p[1] + 2e5);

// Visvalingam-Whyatt effective areas along an open polyline; end points get Infinity.
// A point survives threshold t iff its weight >= t (weights are made monotone, as in topojson-simplify).
function vwWeights(pts, proj) {
  const n = pts.length;
  const w = new Float64Array(n).fill(Infinity);
  if (n < 3) return w;
  const X = new Float64Array(n);
  const Y = new Float64Array(n);
  for (let i = 0; i < n; i++) [X[i], Y[i]] = proj(pts[i][0], pts[i][1]);
  const tri = (a, b, c) => Math.abs((X[b] - X[a]) * (Y[c] - Y[a]) - (X[c] - X[a]) * (Y[b] - Y[a])) / 2;
  const prev = new Int32Array(n);
  const next = new Int32Array(n);
  const area = new Float64Array(n);
  const gone = new Uint8Array(n);
  const hk = []; // binary min-heap (key, value) with lazy deletion
  const hv = [];
  const push = (k, v) => {
    let i = hk.length;
    hk.push(k);
    hv.push(v);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (hk[p] <= k) break;
      hk[i] = hk[p]; hv[i] = hv[p];
      i = p;
    }
    hk[i] = k; hv[i] = v;
  };
  const pop = () => {
    const k0 = hk[0];
    const v0 = hv[0];
    const k = hk.pop();
    const v = hv.pop();
    const m = hk.length;
    if (m) {
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= m) break;
        if (c + 1 < m && hk[c + 1] < hk[c]) c++;
        if (hk[c] >= k) break;
        hk[i] = hk[c]; hv[i] = hv[c];
        i = c;
      }
      hk[i] = k; hv[i] = v;
    }
    return [k0, v0];
  };
  for (let i = 0; i < n; i++) { prev[i] = i - 1; next[i] = i + 1; }
  for (let i = 1; i < n - 1; i++) { area[i] = tri(i - 1, i, i + 1); push(area[i], i); }
  let maxA = 0;
  while (hk.length) {
    const [a, i] = pop();
    if (gone[i] || a !== area[i]) continue;
    if (a > maxA) maxA = a;
    w[i] = maxA;
    gone[i] = 1;
    const p = prev[i];
    const s = next[i];
    next[p] = s; prev[s] = p;
    if (p > 0) { area[p] = tri(prev[p], p, s); push(area[p], p); }
    if (s < n - 1) { area[s] = tri(p, s, next[s]); push(area[s], s); }
  }
  return w;
}

// ---- Topology: split rings into arcs shared between features, weight each arc once ------------------

function buildRings(feats, q, proj) {
  // 1. quantized rings
  const rings = [];
  feats.forEach((f, fi) => {
    const g = f.geometry;
    const polys = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
    for (const poly of polys) {
      for (const coords of poly) {
        const pts = quantizeRing(coords, q);
        if (pts) rings.push({ fi, pts, area: ringArea(pts) });
      }
    }
    if (!rings.some((r) => r.fi === fi)) throw new Error(`Feature ${f.meta.k} has no usable ring at q=${q}`);
  });

  // 2. junctions: vertices where rings diverge (different neighbour pairs) or a ring touches itself
  const sigs = new Map(); // key -> neighbour signature, null = junction
  for (const { pts } of rings) {
    const n = pts.length;
    const seen = new Set();
    for (let i = 0; i < n; i++) {
      const k = K(pts[i]);
      const a = K(pts[(i + n - 1) % n]);
      const b = K(pts[(i + 1) % n]);
      const sig = a < b ? `${a}:${b}` : `${b}:${a}`;
      const cur = sigs.get(k);
      if (seen.has(k) || (cur !== undefined && cur !== sig)) sigs.set(k, null);
      else if (cur === undefined) sigs.set(k, sig);
      seen.add(k);
    }
  }

  // 3. arcs between junctions, deduplicated regardless of direction
  const arcs = new Map();
  const register = (pts) => {
    const n = pts.length;
    const fk = K(pts[0]);
    const lk = K(pts[n - 1]);
    const rev = fk !== lk ? fk > lk : K(pts[1]) > K(pts[n - 2]);
    const c = rev ? pts.slice().reverse() : pts;
    const key = `${K(c[0])}:${K(c[n - 1])}:${n}:${K(c[1])}:${K(c[n - 2])}:${K(c[n >> 1])}`;
    let arc = arcs.get(key);
    if (!arc) arcs.set(key, (arc = { pts: c, w: null }));
    return { arc, rev };
  };
  for (const ring of rings) {
    const { pts } = ring;
    const n = pts.length;
    let js = [];
    for (let i = 0; i < n; i++) if (sigs.get(K(pts[i])) === null) js.push(i);
    if (!js.length) { // isolated loop: anchor at its lowest-left vertex
      let m = 0;
      for (let i = 1; i < n; i++) if (pts[i][0] < pts[m][0] || (pts[i][0] === pts[m][0] && pts[i][1] < pts[m][1])) m = i;
      js = [m];
    }
    ring.arcs = js.map((from, j) => {
      const to = js[(j + 1) % js.length];
      const steps = to === from ? n : (to - from + n) % n;
      const seg = [];
      for (let s = 0; s <= steps; s++) seg.push(pts[(from + s) % n]);
      return register(seg);
    });
  }
  for (const arc of arcs.values()) arc.w = vwWeights(arc.pts, proj);

  // 4. each ring as a closed full-resolution point list with weights
  for (const ring of rings) {
    const pts = [];
    const w = [];
    ring.arcs.forEach(({ arc, rev }, a) => {
      const n = arc.pts.length;
      for (let s = a ? 1 : 0; s < n; s++) {
        const i = rev ? n - 1 - s : s;
        pts.push(arc.pts[i]);
        w.push(arc.w[i]);
      }
    });
    ring.pts = pts;
    ring.w = w;
    ring.loop = ring.arcs.length === 1 ? ring.arcs[0].arc : null; // closed single-arc ring (enclave twins share it)
    delete ring.arcs;
  }
  return { rings, arcCount: arcs.size };
}

// ---- Output ---------------------------------------------------------------------------------------------

const keep = (ring, t) => ring.pts.filter((_, i) => ring.w[i] >= t);

// Largest ring reduced to its 3 highest-weight vertices (ties may add more), so no feature is ever empty.
function fallback(ring) {
  const ws = ring.w.slice(0, -1).sort((a, b) => b - a);
  return keep(ring, ws[Math.min(2, ws.length - 1)]);
}

function delta(pts) {
  const out = [pts[0][0], pts[0][1]];
  for (let i = 1; i < pts.length; i++) out.push(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  return out;
}

function encode(feats, rings, q, t) {
  const byFeature = feats.map(() => []);
  for (const r of rings) byFeature[r.fi].push(r);
  const largest = (rs) => rs.reduce((a, b) => (b.area > a.area ? b : a));
  // A tiny enclave (Vatican) forced to a fallback ring keeps its twin hole in the surrounding country (Italy).
  const forced = new Set();
  byFeature.forEach((rs) => {
    if (!rs.some((r) => keep(r, t).length >= 4)) forced.add(largest(rs).loop);
  });
  forced.delete(null);
  let points = 0;
  const features = feats.map((f, fi) => {
    let kept = byFeature[fi].map((r) => {
      const p = keep(r, t);
      return p.length >= 4 ? p : r.loop && forced.has(r.loop) ? fallback(r) : null;
    }).filter(Boolean);
    if (!kept.length) kept = [fallback(largest(byFeature[fi]))];
    points += kept.reduce((s, p) => s + p.length, 0);
    return { ...f.meta, rings: kept.map(delta) };
  });
  const text = JSON.stringify({ q, features });
  return { text, bytes: Buffer.byteLength(text), points };
}

// Smallest area threshold (bisection on log2 t) whose output fits LIMIT.
function tune(feats, rings, q) {
  let res = encode(feats, rings, q, 0);
  if (res.bytes <= LIMIT) return { ...res, t: 0 };
  let lo = -1;
  let hi = 60;
  res = encode(feats, rings, q, 2 ** lo);
  if (res.bytes <= LIMIT) return { ...res, t: 2 ** lo };
  let best = encode(feats, rings, q, 2 ** hi);
  if (best.bytes > LIMIT) throw new Error('Cannot fit size limit even at maximum simplification');
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    const r = encode(feats, rings, q, 2 ** mid);
    if (r.bytes <= LIMIT) { hi = mid; best = r; } else lo = mid;
  }
  return { ...best, t: 2 ** hi };
}

async function load(name) {
  const file = join(CACHE, name);
  if (!existsSync(file)) {
    console.log(`download ${name}`);
    const res = await fetch(BASE + name);
    if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
    mkdirSync(CACHE, { recursive: true });
    writeFileSync(`${file}.part`, Buffer.from(await res.arrayBuffer()));
    renameSync(`${file}.part`, file);
  }
  return JSON.parse(readFileSync(file, 'utf8'));
}

function build(name, feats, q) {
  const { rings, arcCount } = buildRings(feats, q, PROJ[name](q));
  const total = rings.reduce((s, r) => s + r.pts.length, 0);
  const { text, bytes, points, t } = tune(feats, rings, q);
  writeFileSync(join(GEO, `${name}.json`), text);
  const kb = (bytes / 1024).toFixed(1);
  console.log(`${name}: ${feats.length} features, ${rings.length} rings -> ${points}/${total} points, ${arcCount} arcs, ${kb} KB, area threshold ${t.toFixed(1)}`);
}

async function main() {
  mkdirSync(GEO, { recursive: true });
  build('world', countryFeatures(await load(COUNTRIES)), 1000);
  build('italia', provinceFeatures(await load(ADMIN1)), 10000);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
