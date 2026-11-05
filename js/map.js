// SVG atlas (spec §4.1, §6.6, §8.2). Italia: flat, one <path> per area built once, pan/zoom by changing only the
// viewBox. Mondo: an orthographic globe re-projected on every change (drag rotates, pinch / wheel / double tap zoom,
// rings clipped at the horizon). Pointer Events for both; points clustered on a 44 px screen grid after every
// zoom change, optional route line. Used by the map screen and by the small maps of later screens.
//
// createMap(el, opts) appends an <svg> to `el` and returns { update(opts), destroy(), camera() }.
// opts (all optional except view and geo):
//   view 'world' (globe) | 'italia' (Italia = regions, each drawn from its provinces); geo { world, italia } (store.getGeo());
//   areas Map<'c:IT' | 'r:Campania', 'visited' | 'wish'> (absent = never);
//   points [{ id, lat, lon, state }]; lines [[lat, lon], …] (first point gets the home marker);
//   interactive (default true; false = static: no gestures, no taps, page scroll passes through);
//   focus { lat, lon, zoom } or fit 'points' | 'lines': one-shot framing, applied at creation, on a view change
//   and whenever passed to update() again (otherwise zoom and pan are kept);
//   onAway(bool) (camera left / returned to the initial framing); onArea(key, { lat, lon }), onPoint(id), onCluster(ids) (cluster tapped at maximum zoom),
//   onLongPress(lat, lon) (not on a point), onTap(lat, lon) (replaces onArea when given: position picker).
// camera() → { lat, lon, zoom } of the current view (usable as `focus`), or null; reset() animates back to the initial framing.
import { italyProj, italyInverse, orthographicInverse, decode, cluster } from './geo.js';

const S = 1e4;                                      // projected unit → path unit: integer paths, ~0.007° steps
const MAX_ZOOM = { world: 8, italia: 20 };      // world = globe scale
const FIT = 0.96;                                   // 1× leaves a thin margin around the whole view
const TAP_MS = 300, LONG_MS = 500, DBL_MS = 300, SLOP = 8, DBL_PX = 30, ANIM_MS = 260;
const CELL = 44, R_DOT = 6, R_HIT = 22, FIT_PAD = 48;
const CTX_DEG = 10;                                 // neighbouring countries drawn this far around Italy
const STATES = new Set(['visited', 'wish']);
const RANK = { wish: 1, visited: 2 };
const PROJ = { italia: [italyProj, italyInverse] };
const RAD = Math.PI / 180;
const HOME = { lon: 12, lat: 40 };                  // initial globe centre (Europe)
const SPIN_DEG_S = 6;
const MAX_LAT0 = 80, ARC_STEP = 8 * RAD, SLERP = 3 * RAD, MIN_PX = 0.4;

const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const clamp = (v, a, b) => Math.min(Math.max(v, a), b);
const sep = (v) => (v < 0 ? `${v}` : ` ${v}`);      // '-' doubles as a separator in path data

/** [lon, lat] → path units of the Italia view (SVG y grows downwards). */
function toXY(view, lon, lat) {
  const [x, y] = PROJ.italia[0](lon, lat);
  return [x * S, -y * S];
}

/** Path units → [lon, lat] (Italia view). */
function toLL(view, X, Y) {
  const [lon, lat] = PROJ.italia[1](X / S, -Y / S);
  return finite(lon) && finite(lat) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180 ? [lon, lat] : null;
}

// ---- Paths: built once per view, cached per geo layer ----------------------

/** Relative path of one decoded ring ('M x y l dx dy … z'); grows `box` when given. '' if degenerate. */
function ringD(view, ring, box) {
  let d = '', n = 0, X0 = 0, Y0 = 0;
  const a = ring[0], z = ring[ring.length - 1];
  const end = ring.length - (a[0] === z[0] && a[1] === z[1] ? 1 : 0);   // decoded rings repeat the first point
  for (let i = 0; i < end; i++) {
    const [x, y] = toXY(view, ring[i][0], ring[i][1]);
    const X = Math.round(x), Y = Math.round(y);
    if (box) {
      if (X < box[0]) box[0] = X;
      if (X > box[2]) box[2] = X;
      if (Y < box[1]) box[1] = Y;
      if (Y > box[3]) box[3] = Y;
    }
    if (i === 0) d = `M${X} ${Y}l`;
    else if (X !== X0 || Y !== Y0) {
      d += sep(X - X0) + sep(Y - Y0);
      n++;
    } else continue;
    X0 = X;
    Y0 = Y;
  }
  return n > 1 ? `${d}z` : '';
}

const vec = (lon, lat) => {
  const f = lat * RAD, l = lon * RAD;
  return [Math.cos(f) * Math.sin(l), Math.sin(f), Math.cos(f) * Math.cos(l)];
};

/**
 * Orientation of a ring on the sphere, seen from outside at its own centre `c` (sum of its vertices): true = counter-clockwise.
 * Unlike a shoelace on lon / lat this is right for rings that enclose a pole (Antarctica), whose longitudes do not close.
 */
function spinCcw(v, n, c) {
  let s = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n, a = 3 * i, b = 3 * j;
    s += (v[a + 1] * v[b + 2] - v[a + 2] * v[b + 1]) * c[0] + (v[a + 2] * v[b] - v[a] * v[b + 2]) * c[1] + (v[a] * v[b + 1] - v[a + 1] * v[b]) * c[2];
  }
  return s > 0;
}

/** World features as unit vectors (x east-ish, y north, z toward lon 0): rings, winding, bounding cap. Built once. */
export function globeData(src) {
  const feats = [];
  for (const f of src.features) {
    const rings = [], sum = [0, 0, 0];
    for (const r of decode(f, src.q)) {
      const end = r.length - (r.length > 1 && r[0][0] === r[r.length - 1][0] && r[0][1] === r[r.length - 1][1] ? 1 : 0);
      if (end < 3) continue;
      const v = new Float64Array(end * 3);
      const rs = [0, 0, 0];
      for (let i = 0; i < end; i++) {
        const q = vec(r[i][0], r[i][1]);
        v.set(q, i * 3);
        rs[0] += q[0]; rs[1] += q[1]; rs[2] += q[2];
      }
      for (let m = 0; m < 3; m++) sum[m] += rs[m];
      rings.push({ v, ccw: spinCcw(v, end, rs) });
    }
    if (!rings.length) continue;
    const m = Math.hypot(...sum) || 1, c = sum.map((x) => x / m);
    let cos = 1;
    for (const { v } of rings) for (let i = 0; i < v.length; i += 3) cos = Math.min(cos, c[0] * v[i] + c[1] * v[i + 1] + c[2] * v[i + 2]);
    feats.push({ f, rings, c, rho: Math.acos(Math.max(-1, Math.min(1, cos))) });
  }
  return { feats, html: feats.map(() => '<path d=""/>').join(''), box: [0, 0, 1, 1], ctx: '' };
}

const built = new WeakMap();                        // geo layer → { feats: [{ f, d }], html, box, ctx }

function layers(view, geo) {
  const src = geo[view];
  let b = built.get(src);
  if (b) return b;
  if (view === 'world') {
    b = globeData(src);
    built.set(src, b);
    return b;
  }
  const box = [Infinity, Infinity, -Infinity, -Infinity];
  const feats = src.features
    .map((f) => ({ f, d: decode(f, src.q).map((r) => ringD(view, r, box)).join('') }))
    .filter((x) => x.d);
  let ctx = '';
  if (view === 'italia') {
    // Muted context: the world's countries near Italy in the Italian projection, ring by ring (Italy itself excluded).
    const [w, n] = toLL(view, box[0], box[1]), [e, s] = toLL(view, box[2], box[3]);
    const near = (r) => r.some(([lon, lat]) => lon > w - CTX_DEG && lon < e + CTX_DEG && lat > s - CTX_DEG && lat < n + CTX_DEG);
    for (const f of geo.world.features) {
      if (f.k === 'IT') continue;
      const d = decode(f, geo.world.q).filter(near).map((r) => ringD(view, r, null)).join('');
      if (d) ctx += `<path d="${d}"/>`;
    }
  }
  b = { feats, html: feats.map((x) => `<path d="${x.d}"/>`).join(''), box, ctx };
  built.set(src, b);
  return b;
}

// ---- Globe: one ring clipped at the horizon -------------------------------------

let SX = new Float64Array(2048), SY = new Float64Array(2048), SC = new Float64Array(2048);
const mod = (a, m) => ((a % m) + m) % m;

/** Path data of a ring seen from basis B (e, n, v), radius R px, centre (X0, Y0): the visible part, closed along the horizon. */
export function ringPath(ring, B, R, X0, Y0) {
  const { v, ccw } = ring, n = v.length / 3, { e, n: nn, v: vw } = B;
  if (SX.length < n) { SX = new Float64Array(n * 2); SY = new Float64Array(n * 2); SC = new Float64Array(n * 2); }
  let hidden = -1, seen = 0;
  for (let i = 0; i < n; i++) {
    const x = v[3 * i], y = v[3 * i + 1], z = v[3 * i + 2];
    SX[i] = x * e[0] + z * e[2];
    SY[i] = x * nn[0] + y * nn[1] + z * nn[2];
    const c = x * vw[0] + y * vw[1] + z * vw[2];
    SC[i] = c;
    if (c < 0) { if (hidden < 0) hidden = i; } else seen++;
  }
  if (!seen) return '';
  const tol = MIN_PX / R, f = (x) => Math.round(x * 10) / 10;
  if (hidden < 0) {                                 // wholly visible
    let d = '', lx = Infinity, ly = Infinity, m = 0;
    for (let i = 0; i < n; i++) {
      if (Math.abs(SX[i] - lx) + Math.abs(SY[i] - ly) < tol) continue;
      lx = SX[i]; ly = SY[i];
      d += `${m++ ? 'L' : 'M'}${f(X0 + R * lx)} ${f(Y0 - R * ly)}`;
    }
    return m > 2 ? `${d}z` : '';
  }
  const cross = (i, j) => {                         // crossing of the horizon on edge i to j
    const t = SC[i] / (SC[i] - SC[j]);
    const p = [0, 1, 2].map((m) => v[3 * i + m] + t * (v[3 * j + m] - v[3 * i + m])), h = Math.hypot(...p) || 1;
    const x = (p[0] * e[0] + p[2] * e[2]) / h, y = (p[0] * nn[0] + p[1] * nn[1] + p[2] * nn[2]) / h;
    const r = Math.hypot(x, y) || 1;
    return [x / r, y / r];
  };
  const runs = [];
  let run = null;
  for (let t = 0; t < n; t++) {
    const i = (hidden + t) % n, j = (i + 1) % n;
    if (SC[i] >= 0 && run) {
      const L = run.pts.length;
      if (Math.abs(SX[i] - run.pts[L - 2]) + Math.abs(SY[i] - run.pts[L - 1]) >= tol) run.pts.push(SX[i], SY[i]);
    }
    if (SC[i] < 0 && SC[j] >= 0) {
      const [x, y] = cross(i, j);
      run = { pts: [x, y], ea: Math.atan2(y, x), xa: 0 };
      runs.push(run);
    } else if (SC[i] >= 0 && SC[j] < 0 && run) {
      const [x, y] = cross(i, j);
      run.pts.push(x, y);
      run.xa = Math.atan2(y, x);
      run = null;
    }
  }
  const dir = ccw ? 1 : -1, used = new Set();
  let d = '';
  for (const first of runs) {
    if (used.has(first)) continue;
    let r = first, m = 0;
    for (;;) {
      used.add(r);
      for (let i = 0; i < r.pts.length; i += 2) d += `${m++ ? 'L' : 'M'}${f(X0 + R * r.pts[i])} ${f(Y0 - R * r.pts[i + 1])}`;
      let nx = first, best = mod(dir * (first.ea - r.xa), 2 * Math.PI);   // angle to travel along the horizon
      for (const q of runs) {
        if (used.has(q)) continue;
        const a = mod(dir * (q.ea - r.xa), 2 * Math.PI);
        if (a < best) { best = a; nx = q; }
      }
      const steps = Math.ceil(best / ARC_STEP);
      for (let i = 1; i < steps; i++) {
        const a = r.xa + (dir * best * i) / steps;
        d += `L${f(X0 + R * Math.cos(a))} ${f(Y0 - R * Math.sin(a))}`;
      }
      if (nx === first) break;
      r = nx;
    }
    d += 'z';
  }
  return d;
}

/** Graticule every 30°, as path data: only the visible hemisphere (pen up on the far side). */
const GRAT = (() => {
  const lines = [];
  for (let lo = -180; lo < 180; lo += 30) {
    const l = [];
    for (let la = -90; la <= 90; la += 5) l.push(vec(lo, la));
    lines.push(l);
  }
  for (let la = -60; la <= 60; la += 30) {
    const l = [];
    for (let lo = -180; lo <= 180; lo += 5) l.push(vec(lo, la));
    lines.push(l);
  }
  return lines;
})();

export function graticule(B, R, X0, Y0) {
  const { e, n, v } = B, f = (x) => Math.round(x * 10) / 10;
  let d = '';
  for (const line of GRAT) {
    let pen = false;
    for (const p of line) {
      if (p[0] * v[0] + p[1] * v[1] + p[2] * v[2] < 0) { pen = false; continue; }
      d += `${pen ? 'L' : 'M'}${f(X0 + R * (p[0] * e[0] + p[2] * e[2]))} ${f(Y0 - R * (p[0] * n[0] + p[1] * n[1] + p[2] * n[2]))}`;
      pen = true;
    }
  }
  return d;
}

// ---- Component ---------------------------------------------------------------

export function createMap(el, opts) {
  let o = { interactive: true, ...opts };
  let pendingCam = { focus: o.focus, fit: o.fit };   // framing waits for a non-zero size
  let b = null, paths = [], byKey = new Map(), painted = new Map(), groups = [];
  let W = 0, H = 0, k0 = 1, k = 1, cx = 0, cy = 0, ready = false, drawnK = 0;
  let raf = 0, anim = null, dead = false, lon0 = HOME.lon, lat0 = HOME.lat, away = null;
  const globe = () => o.view === 'world';
  const reduce = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', o.interactive ? 'map-svg' : 'map-svg static');
  svg.setAttribute('role', 'img');
  svg.innerHTML = '<defs><radialGradient id="globe-shade" cx=".5" cy=".5" r=".5" fx=".38" fy=".32">'
    + '<stop offset=".55" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity=".3"/></radialGradient></defs>'
    + '<circle class="sea"/><circle class="atmo"/><path class="grat"/><g class="ctx"></g><g class="areas"></g><circle class="shade"/><path class="route"/><g class="pts"></g>';
  const [, sea, atmo, grat, ctxG, areasG, shade, route, ptsG] = svg.children;
  el.append(svg);

  // ---- Layers ----

  const keyOf = (f) => (o.view === 'world' ? `c:${f.k}` : `r:${f.r}`);
  const stateOf = (key) => {
    const s = o.areas instanceof Map ? o.areas.get(key) : o.areas?.[key];
    return STATES.has(s) ? s : '';
  };

  function buildView() {
    b = layers(o.view, o.geo);
    ctxG.innerHTML = b.ctx;
    areasG.innerHTML = b.html;
    paths = [...areasG.children];
    shown = [];
    svg.classList.toggle('globe', globe());
    for (const c of [sea, atmo, grat, shade]) c.style.display = globe() ? '' : 'none';
    svg.setAttribute('aria-label', o.view === 'world' ? 'Mappa del mondo' : "Mappa dell'Italia");
    rekey();
    drawLines();
  }

  /** Area keys follow the view; Italy = provinces coloured by their region, borderless. */
  function rekey() {
    byKey = new Map();
    painted = new Map();
    b.feats.forEach(({ f }, i) => {
      const key = keyOf(f);
      paths[i].setAttribute('data-key', key);
      if (!byKey.has(key)) byKey.set(key, []);
      byKey.get(key).push(paths[i]);
    });
    areasG.setAttribute('class', `areas v-${o.view}`);
    restyle();
  }

  /** Touch only the paths whose state changed. */
  function restyle() {
    for (const [key, els] of byKey) {
      const s = stateOf(key);
      if (painted.get(key) === s) continue;
      painted.set(key, s);
      for (const p of els) p.setAttribute('class', s ? `area st-${s}` : 'area');
    }
  }

  function drawLines() {
    const ln = (o.lines || []).filter((p) => finite(p?.[0]) && finite(p?.[1]));
    if (ln.length < 2) return route.removeAttribute('d');
    if (globe()) {                                  // great-circle steps, pen up on the far side
      let d = '', up = true;
      const put = (p) => {
        const q = proj(p);
        if (q[2] < 0) return void (up = true);
        d += `${up ? 'M' : 'L'}${q[0].toFixed(1)} ${q[1].toFixed(1)}`;
        up = false;
      };
      for (let i = 0; i < ln.length; i++) {
        const b1 = vec(ln[i][1], ln[i][0]);
        if (!i) { put(b1); continue; }
        const a1 = vec(ln[i - 1][1], ln[i - 1][0]);
        const ang = Math.acos(Math.max(-1, Math.min(1, a1[0] * b1[0] + a1[1] * b1[1] + a1[2] * b1[2])));
        const n = Math.max(1, Math.ceil(ang / SLERP));
        for (let j = 1; j <= n; j++) {
          const t = j / n, p = [0, 1, 2].map((m) => a1[m] * (1 - t) + b1[m] * t), h = Math.hypot(...p) || 1;
          put([p[0] / h, p[1] / h, p[2] / h]);
        }
      }
      return route.setAttribute('d', d);
    }
    route.setAttribute('d', ln.map(([lat, lon], i) => {
      const [X, Y] = toXY(o.view, lon, lat);
      return `${i ? 'L' : 'M'}${Math.round(X)} ${Math.round(Y)}`;
    }).join(''));
  }

  /** Points and clusters at constant screen size: groups scaled by 1/k, radii in pixels. */
  function drawPoints() {
    drawnK = k;
    const gl = globe(), kk = gl ? 1 : k, s = 1 / kk, list = [], st = new Map(), pr = new Set();
    for (const p of o.points || []) {
      if (!finite(p.lat) || !finite(p.lon)) continue;
      const xy = pxy(p.lon, p.lat);
      if (!xy) continue;                            // far side of the globe
      const [X, Y] = xy;
      list.push({ id: p.id, x: X * kk, y: Y * kk });   // grid anchored to the map origin: panning never regroups
      st.set(p.id, STATES.has(p.state) ? p.state : 'wish');
      if (p.partner === true && p.state === 'visited') pr.add(p.id);   // blue: visited with the partner
    }
    groups = cluster(list, CELL).map((g) => ({ X: g.x * s, Y: g.y * s, ids: g.ids }));
    let h = '';
    const home = o.lines?.length > 1 ? o.lines[0] : null;
    const hxy = finite(home?.[0]) && finite(home?.[1]) ? pxy(home[1], home[0]) : null;
    if (hxy) {
      const [X, Y] = hxy;
      h += `<g class="home" transform="translate(${X} ${Y}) scale(${s})"><rect x="-5" y="-5" width="10" height="10" rx="2"/></g>`;
    }
    groups.forEach((g, i) => {
      let best = 'wish';
      for (const id of g.ids) if (RANK[st.get(id)] > RANK[best]) best = st.get(id);
      const n = g.ids.length, tr = `translate(${g.X} ${g.Y}) scale(${s})`;
      const r = n === 1 ? R_DOT : n < 10 ? 11 : 13, blue = g.ids.every((id) => pr.has(id));
      // Wish = white ring without fill, outlined dark on both sides so it reads on light and dark areas.
      const sym = best === 'wish'
        ? `<circle class="halo" r="${r + 2.25}"/><circle class="halo" r="${r - 2.25}"/><circle class="dot st-wish" r="${r}"/>`
        : `<circle class="dot st-visited${blue ? ' partner' : ''}" r="${r}"/>`;
      h += `<g class="pt${n === 1 ? '' : ' cl'}${blue ? ' partner' : ''}" data-i="${i}" transform="${tr}"><circle class="hit" r="${R_HIT}"/>${sym}`
        + `${n === 1 ? '' : `<text dy=".35em">${n > 99 ? '99+' : n}</text>`}</g>`;
    });
    ptsG.innerHTML = h;
  }

  // ---- Globe ----

  let B = null, shown = [];
  /** View basis for the current centre: east, north and the direction to the viewer. */
  function basis() {
    if (B && B.l === lon0 && B.a === lat0) return B;
    const l = lon0 * RAD, a = lat0 * RAD;
    B = { l: lon0, a: lat0, v: vec(lon0, lat0), e: [Math.cos(l), 0, -Math.sin(l)], n: [-Math.sin(a) * Math.sin(l), Math.cos(a), -Math.sin(a) * Math.cos(l)] };
    return B;
  }
  /** Unit vector to [px x, px y, depth]; depth < 0 = far side. */
  function proj(p) {
    const { v, e, n } = basis(), R = rBase() * k;
    return [W / 2 + R * (p[0] * e[0] + p[2] * e[2]), H / 2 - R * (p[0] * n[0] + p[1] * n[1] + p[2] * n[2]), p[0] * v[0] + p[1] * v[1] + p[2] * v[2]];
  }
  /** [lon, lat] to view units (path units for Italia, pixels for the globe); null on the far side. */
  function pxy(lon, lat) {
    if (!globe()) return toXY(o.view, lon, lat);
    const q = proj(vec(lon, lat));
    return q[2] >= 0 ? [q[0], q[1]] : null;
  }

  function drawGlobe() {
    const Bs = basis(), R = rBase() * k, X0 = W / 2, Y0 = H / 2;
    for (const c of [sea, shade, atmo]) {
      c.setAttribute('cx', X0);
      c.setAttribute('cy', Y0);
      c.setAttribute('r', R);
    }
    grat.setAttribute('d', graticule(Bs, R, X0, Y0));
    b.feats.forEach((ft, i) => {
      const dc = ft.c[0] * Bs.v[0] + ft.c[1] * Bs.v[1] + ft.c[2] * Bs.v[2];
      let d = '';
      if (Math.acos(clamp(dc, -1, 1)) - ft.rho < Math.PI / 2 && ft.rho * R >= MIN_PX) d = ft.rings.map((r) => ringPath(r, Bs, R, X0, Y0)).join('');
      if (d !== shown[i]) {
        paths[i].setAttribute('d', d);
        shown[i] = d;
      }
    });
  }

  /** Animate the globe to centre (lon, lat) at zoom z. */
  function fly(lon, lat, z) {
    anim = { globe: true, l0: lon0, dl: mod(lon - lon0 + 180, 360) - 180, a0: lat0, a1: clamp(lat, -MAX_LAT0, MAX_LAT0), z0: k, z1: clamp(z, k0, kMax()), t0: performance.now() };
    if (reduce) anim.t0 = -Infinity;
    schedule();
  }

  // ---- Camera: centre (cx, cy) in path units, k = pixels per path unit ----

  const kMax = () => k0 * MAX_ZOOM[o.view];
  const rBase = () => (Math.min(W, H) / 2) * FIT;   // globe radius in pixels at 1×
  const fitK = () => globe() ? 1 : Math.min(W / (b.box[2] - b.box[0]), H / (b.box[3] - b.box[1])) * FIT;

  /** Zoom limits; the centre stays over the view's content, so the content never leaves the viewport. */
  function clampCam() {
    k = clamp(k, k0, kMax());
    if (globe()) {
      lat0 = clamp(lat0, -MAX_LAT0, MAX_LAT0);
      lon0 = ((((lon0 + 180) % 360) + 360) % 360) - 180;
      return;
    }
    cx = clamp(cx, b.box[0], b.box[2]);
    cy = clamp(cy, b.box[1], b.box[3]);
  }

  function frameGlobe(cam) {
    const f = cam?.focus;
    lon0 = HOME.lon;
    lat0 = HOME.lat;
    k = k0;
    const pts = cam?.fit === 'lines' ? o.lines || [] : cam?.fit === 'points' ? (o.points || []).map((p) => [p.lat, p.lon]) : [];
    if (f && finite(f.lat) && finite(f.lon)) {
      lon0 = f.lon;
      lat0 = f.lat;
      k = k0 * (finite(f.zoom) ? f.zoom : 1);
    } else if (pts.length) {
      const vs = pts.filter((p) => finite(p?.[0]) && finite(p?.[1])).map((p) => vec(p[1], p[0]));
      if (vs.length) {
        const m = [0, 1, 2].map((i) => vs.reduce((a, v) => a + v[i], 0)), h = Math.hypot(...m);
        if (h > 1e-6) {
          const c = m.map((x) => x / h);
          lat0 = Math.asin(c[1]) / RAD;
          lon0 = Math.atan2(c[0], c[2]) / RAD;
          const sin = Math.sqrt(1 - Math.min(...vs.map((v) => v[0] * c[0] + v[1] * c[1] + v[2] * c[2])) ** 2);
          k = sin > 0.02 ? ((Math.min(W, H) / 2 - FIT_PAD) / rBase()) / sin : Infinity;   // far points: whole globe
          if (vs.some((v) => v[0] * c[0] + v[1] * c[1] + v[2] * c[2] < 0.1)) k = k0;
        }
      }
    }
    clampCam();
  }

  function frameTo(cam) {
    k0 = fitK();
    k = k0;
    if (globe()) return frameGlobe(cam);
    cx = (b.box[0] + b.box[2]) / 2;
    cy = (b.box[1] + b.box[3]) / 2;
    const f = cam?.focus;
    const pts = cam?.fit === 'lines' ? o.lines || [] : cam?.fit === 'points' ? (o.points || []).map((p) => [p.lat, p.lon]) : [];
    if (f && finite(f.lat) && finite(f.lon)) {
      [cx, cy] = toXY(o.view, f.lon, f.lat);
      k = k0 * (finite(f.zoom) ? f.zoom : 1);
    } else if (pts.length) {
      const a = [Infinity, Infinity, -Infinity, -Infinity];
      for (const p of pts) {
        if (!finite(p?.[0]) || !finite(p?.[1])) continue;
        const [X, Y] = toXY(o.view, p[1], p[0]);
        a[0] = Math.min(a[0], X); a[1] = Math.min(a[1], Y); a[2] = Math.max(a[2], X); a[3] = Math.max(a[3], Y);
      }
      if (a[0] <= a[2]) {                             // a single point gives an infinite zoom, clamped to the limit
        cx = (a[0] + a[2]) / 2;
        cy = (a[1] + a[3]) / 2;
        k = Math.min(Math.max(W - 2 * FIT_PAD, W / 2) / (a[2] - a[0]), Math.max(H - 2 * FIT_PAD, H / 2) / (a[3] - a[1]));
      }
    }
    clampCam();
  }

  function measure() {
    const w = svg.clientWidth, h = svg.clientHeight;
    if (!w || !h || (w === W && h === H)) return false;
    const z = k / k0;
    W = w;
    H = h;
    if (ready) {
      k0 = fitK();
      k = k0 * z;
      clampCam();
    } else {
      ready = true;
      frameTo(pendingCam);
      pendingCam = null;
    }
    if (ptrs.size) anchor();
    return true;
  }

  function frame(now) {
    raf = 0;
    if (!ready || dead) return;
    if (anim) stepAnim(now);
    if (globe()) {
      svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
      drawGlobe();
      drawLines();
      drawPoints();
    } else {
      svg.setAttribute('viewBox', `${cx - W / 2 / k} ${cy - H / 2 / k} ${W / k} ${H / k}`);
      if (k !== drawnK) drawPoints();
    }
    const far = k > k0 * 1.01 || (globe()
      ? Math.abs(mod(lon0 - HOME.lon + 180, 360) - 180) > 0.5 || Math.abs(lat0 - HOME.lat) > 0.5
      : Math.abs(cx - (b.box[0] + b.box[2]) / 2) * k > 3 || Math.abs(cy - (b.box[1] + b.box[3]) / 2) * k > 3);
    if (far !== away && !spinning) {
      away = far;
      o.onAway?.(far);
    }
  }
  const schedule = () => { raf ||= requestAnimationFrame(frame); };
  const paint = () => { cancelAnimationFrame(raf); frame(performance.now()); };

  function zoomAt(px, py, f) {
    if (globe()) {
      k = clamp(k * f, k0, kMax());
      return schedule();
    }
    const X = cx + (px - W / 2) / k, Y = cy + (py - H / 2) / k;
    k = clamp(k * f, k0, kMax());
    cx = X - (px - W / 2) / k;
    cy = Y - (py - H / 2) / k;
    clampCam();
    schedule();
  }

  /** Animate so the map point (X, Y) moves to screen (sx, sy) while the zoom goes to k1. */
  function zoomTo(X, Y, sx, sy, k1) {
    anim = { X, Y, sx, sy, k: k, k1: clamp(k1, k0, kMax()), x0: (X - cx) * k + W / 2, y0: (Y - cy) * k + H / 2, t0: performance.now() };
    if (reduce) anim.t0 = -Infinity;
    schedule();
  }

  function stepAnim(now) {
    const a = anim, t = clamp((now - a.t0) / ANIM_MS, 0, 1), e = 1 - (1 - t) ** 3;
    if (a.globe) {
      lon0 = a.l0 + a.dl * e;
      lat0 = a.a0 + (a.a1 - a.a0) * e;
      k = a.z0 * (a.z1 / a.z0) ** e;
      clampCam();
      if (t < 1) schedule();
      else anim = null;
      return;
    }
    k = a.k * (a.k1 / a.k) ** e;
    cx = a.X - (a.x0 + (a.sx - a.x0) * e - W / 2) / k;
    cy = a.Y - (a.y0 + (a.sy - a.y0) * e - H / 2) / k;
    clampCam();
    if (t < 1) schedule();
    else anim = null;
  }

  const screenLL = (px, py) => {
    if (!globe()) return toLL(o.view, cx + (px - W / 2) / k, cy + (py - H / 2) / k);
    const R = rBase() * k;
    return orthographicInverse((px - W / 2) / R, -(py - H / 2) / R, lon0, lat0);
  };

  // ---- Gestures ----

  const ptrs = new Map();                           // pointerId → [x, y] in element pixels
  let rect = null, g = null, press = null, last = null, longT = 0, tapT = 0;
  const pos = (e) => [e.clientX - rect.left, e.clientY - rect.top];

  /** Re-anchor on the current pointers: the map point under their midpoint follows it; their distance scales. */
  function anchor() {
    const [a, c = a] = ptrs.values();
    const mx = (a[0] + c[0]) / 2, my = (a[1] + c[1]) / 2;
    if (globe()) {
      g = { lon: lon0, lat: lat0, x: mx, y: my, d: Math.hypot(a[0] - c[0], a[1] - c[1]), k };
      return;
    }
    g = { X: cx + (mx - W / 2) / k, Y: cy + (my - H / 2) / k, d: Math.hypot(a[0] - c[0], a[1] - c[1]), k };
  }

  function onDown(e) {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (!ptrs.size) rect = svg.getBoundingClientRect();
    try {
      svg.setPointerCapture(e.pointerId);
    } catch { /* pointer already gone */ }
    anim = null;
    ptrs.set(e.pointerId, pos(e));
    clearTimeout(longT);
    if (ptrs.size === 1) {
      const pt = e.target.closest?.('.pt');
      const [x, y] = ptrs.get(e.pointerId);
      press = { x, y, t: performance.now(), el: e.target, group: pt ? groups[+pt.getAttribute('data-i')] : null };
      if (o.onLongPress && !pt) longT = setTimeout(onLong, LONG_MS);
    } else if (press) press.multi = true;
    anchor();
  }

  function onMove(e) {
    if (!ptrs.has(e.pointerId)) return;
    const p = pos(e);
    ptrs.set(e.pointerId, p);
    if (press && !press.moved) {
      if (ptrs.size === 1 && Math.hypot(p[0] - press.x, p[1] - press.y) <= SLOP) return;
      press.moved = true;
      clearTimeout(longT);
      svg.classList.add('drag');
    }
    const [a, c = a] = ptrs.values();
    if (globe()) {                                  // drag rotates, pinch scales
      if (ptrs.size > 1 && g.d > 0) k = clamp((g.k * Math.hypot(a[0] - c[0], a[1] - c[1])) / g.d, k0, kMax());
      const R = rBase() * g.k;
      lon0 = g.lon - ((a[0] + c[0]) / 2 - g.x) / (R * Math.max(Math.cos(g.lat * RAD), 0.25)) / RAD;
      lat0 = g.lat + ((a[1] + c[1]) / 2 - g.y) / R / RAD;
      clampCam();
      return schedule();
    }
    if (ptrs.size > 1 && g.d > 0) k = clamp((g.k * Math.hypot(a[0] - c[0], a[1] - c[1])) / g.d, k0, kMax());
    cx = g.X - ((a[0] + c[0]) / 2 - W / 2) / k;
    cy = g.Y - ((a[1] + c[1]) / 2 - H / 2) / k;
    clampCam();
    schedule();
  }

  function onUp(e) {
    if (!ptrs.delete(e.pointerId)) return;
    if (ptrs.size) return anchor();                 // pinch → pan with the remaining finger, no jump
    clearTimeout(longT);
    svg.classList.remove('drag');
    const p = press;
    press = null;
    if (e.type === 'pointerup' && p && !p.moved && !p.multi && !p.long && performance.now() - p.t < TAP_MS) tap(p);
  }

  /** A second tap close in time and space zooms ×2 there; otherwise the single tap fires once the wait is over. */
  function tap(p) {
    clearTimeout(tapT);
    if (last && performance.now() - last.t < DBL_MS && Math.hypot(p.x - last.x, p.y - last.y) < DBL_PX) {
      last = null;
      if (globe()) {
        const ll = screenLL(p.x, p.y);
        return ll && fly(ll[0], ll[1], k * 2);
      }
      return zoomTo(cx + (p.x - W / 2) / k, cy + (p.y - H / 2) / k, p.x, p.y, k * 2);
    }
    last = { x: p.x, y: p.y, t: performance.now() };
    tapT = setTimeout(() => { last = null; single(p); }, DBL_MS);
  }

  function single(p) {
    if (p.group) {
      if (p.group.ids.length === 1) return o.onPoint?.(p.group.ids[0]);
      if (k < kMax() * 0.999) {
        if (!globe()) return zoomTo(p.group.X, p.group.Y, W / 2, H / 2, k * 2);
        const ll = screenLL(p.group.X, p.group.Y);
        return ll && fly(ll[0], ll[1], k * 2);
      }
      return o.onCluster?.(p.group.ids);
    }
    const ll = screenLL(p.x, p.y);
    if (!ll) return;
    if (o.onTap) return o.onTap(ll[1], ll[0]);
    const area = p.el.closest?.('[data-key]');
    if (area && o.onArea) o.onArea(area.getAttribute('data-key'), { lat: ll[1], lon: ll[0] });
  }

  function onLong() {
    if (!press || press.moved || ptrs.size !== 1) return;
    press.long = true;                              // the release is not a tap
    const ll = screenLL(press.x, press.y);
    if (ll) o.onLongPress(ll[1], ll[0]);
  }

  function onWheel(e) {
    e.preventDefault();
    anim = null;
    const r = svg.getBoundingClientRect();
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? H : 1;
    const dy = clamp(e.deltaY * unit, -300, 300);
    zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-dy * (e.ctrlKey ? 0.01 : 0.0025)));   // ctrl = trackpad pinch
    if (ptrs.size) anchor();
  }

  // Slow auto-rotation of the globe (option `spin`): stops for good at the first touch of the map, and when hidden / destroyed.
  let spinning = !!o.spin && o.view === 'world' && !reduce, spinRaf = 0, spinLast = 0;
  const stopSpin = () => { spinning = false; cancelAnimationFrame(spinRaf); };
  function spinStep(now) {
    if (!spinning || dead) return;
    const dt = Math.min(0.1, (now - (spinLast || now)) / 1000);
    spinLast = now;
    if (ready && globe() && !anim && !ptrs.size) {
      lon0 = mod(lon0 + SPIN_DEG_S * dt + 180, 360) - 180;
      schedule();
    }
    spinRaf = requestAnimationFrame(spinStep);
  }
  const onVis = () => { if (document.hidden) stopSpin(); };
  if (spinning) {
    spinRaf = requestAnimationFrame(spinStep);
    document.addEventListener('visibilitychange', onVis);
    for (const t of ['pointerdown', 'wheel', 'touchstart']) svg.addEventListener(t, stopSpin, { once: true, passive: true });
  }

  const ac = new AbortController();
  if (o.interactive) {
    const on = (type, fn, extra) => svg.addEventListener(type, fn, { signal: ac.signal, ...extra });
    on('pointerdown', onDown);
    on('pointermove', onMove);
    on('pointerup', onUp);
    on('pointercancel', onUp);
    on('wheel', onWheel, { passive: false });
    on('contextmenu', (e) => e.preventDefault());
    on('gesturestart', (e) => e.preventDefault());  // iOS: no page pinch-zoom over the map
  }
  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => { if (measure()) schedule(); }) : null;
  ro?.observe(svg);

  buildView();
  measure();
  paint();

  return {
    update(next = {}) {
      if (dead) return;
      const prev = o;
      o = { ...o, ...next };
      const cam = 'focus' in next || 'fit' in next ? { focus: next.focus, fit: next.fit } : null;
      const rebuilt = o.view !== prev.view || o.geo !== prev.geo;
      if (rebuilt) buildView();
      else if ('areas' in next) restyle();
      if (!rebuilt && 'lines' in next) drawLines();
      if (rebuilt || cam) {
        anim = null;
        if (ready) frameTo(cam);
        else pendingCam = cam;
      }
      if (rebuilt || cam || 'points' in next || 'lines' in next) drawnK = 0;
      if (rebuilt) paint();
      else schedule();
    },
    reset() {
      if (dead || !ready) return;
      if (globe()) fly(HOME.lon, HOME.lat, k0);
      else zoomTo((b.box[0] + b.box[2]) / 2, (b.box[1] + b.box[3]) / 2, W / 2, H / 2, k0);
    },
    camera() {
      if (globe()) return ready && !dead ? { lat: lat0, lon: lon0, zoom: k / k0 } : null;
      const ll = ready && !dead ? toLL(o.view, cx, cy) : null;
      return ll ? { lat: ll[1], lon: ll[0], zoom: k / k0 } : null;
    },
    destroy() {
      if (dead) return;
      dead = true;
      ac.abort();
      ro?.disconnect();
      stopSpin();
      document.removeEventListener('visibilitychange', onVis);
      cancelAnimationFrame(raf);
      clearTimeout(longT);
      clearTimeout(tapT);
      svg.remove();
    },
  };
}
