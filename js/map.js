// SVG atlas (spec §4.1, §6.6, §8.2): one <path> per area built once per view, pan/zoom by changing only the
// viewBox (Pointer Events: drag, pinch, wheel, double tap), points clustered on a 44 px screen grid after every
// zoom change, optional route line. Used by the map screen and by the small maps of later screens.
//
// createMap(el, opts) appends an <svg> to `el` and returns { update(opts), destroy(), camera() }.
// opts (all optional except view and geo):
//   view 'world' | 'italia' (Italia = regions, each drawn from its provinces); geo { world, italia } (store.getGeo());
//   areas Map<'c:IT' | 'r:Campania', 'visited' | 'wish'> (absent = never);
//   points [{ id, lat, lon, state }]; lines [[lat, lon], …] (first point gets the home marker);
//   interactive (default true; false = static: no gestures, no taps, page scroll passes through);
//   focus { lat, lon, zoom } or fit 'points' | 'lines': one-shot framing, applied at creation, on a view change
//   and whenever passed to update() again (otherwise zoom and pan are kept);
//   onArea(key, { lat, lon }), onPoint(id), onCluster(ids) (cluster tapped at maximum zoom),
//   onLongPress(lat, lon) (not on a point), onTap(lat, lon) (replaces onArea when given: position picker).
// camera() → { lat, lon, zoom } of the current view (usable as `focus`), or null.
import { equalEarth, equalEarthInverse, italyProj, italyInverse, decode, cluster } from './geo.js';

const S = 1e4;                                      // projected unit → path unit: integer paths, ~0.007° steps
const MAX_ZOOM = { world: 40, italia: 20 };
const FIT = 0.96;                                   // 1× leaves a thin margin around the whole view
const TAP_MS = 300, LONG_MS = 500, DBL_MS = 300, SLOP = 8, DBL_PX = 30, ANIM_MS = 260;
const CELL = 44, R_DOT = 6, R_HIT = 22, FIT_PAD = 48;
const CTX_DEG = 10;                                 // neighbouring countries drawn this far around Italy
const STATES = new Set(['visited', 'wish']);
const RANK = { wish: 1, visited: 2 };
const PROJ = { world: [equalEarth, equalEarthInverse], italia: [italyProj, italyInverse] };

const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const clamp = (v, a, b) => Math.min(Math.max(v, a), b);
const sep = (v) => (v < 0 ? `${v}` : ` ${v}`);      // '-' doubles as a separator in path data

/** [lon, lat] → path units of a view (SVG y grows downwards). */
function toXY(view, lon, lat) {
  const [x, y] = PROJ[view][0](lon, lat);
  return [x * S, -y * S];
}

/** Path units → [lon, lat]; null outside the projection (world: beyond the outline, where the inverse diverges). */
function toLL(view, X, Y) {
  const [lon, lat] = PROJ[view][1](X / S, -Y / S);
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

const built = new WeakMap();                        // geo layer → { feats: [{ f, d }], html, box, ctx }

function layers(view, geo) {
  const src = geo[view];
  let b = built.get(src);
  if (b) return b;
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

// ---- Component ---------------------------------------------------------------

export function createMap(el, opts) {
  let o = { interactive: true, ...opts };
  let pendingCam = { focus: o.focus, fit: o.fit };   // framing waits for a non-zero size
  let b = null, paths = [], byKey = new Map(), painted = new Map(), groups = [];
  let W = 0, H = 0, k0 = 1, k = 1, cx = 0, cy = 0, ready = false, drawnK = 0;
  let raf = 0, anim = null, dead = false;
  const reduce = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', o.interactive ? 'map-svg' : 'map-svg static');
  svg.setAttribute('role', 'img');
  svg.innerHTML = '<g class="ctx"></g><g class="areas"></g><path class="route"/><g class="pts"></g>';
  const [ctxG, areasG, route, ptsG] = svg.children;
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
    route.setAttribute('d', ln.map(([lat, lon], i) => {
      const [X, Y] = toXY(o.view, lon, lat);
      return `${i ? 'L' : 'M'}${Math.round(X)} ${Math.round(Y)}`;
    }).join(''));
  }

  /** Points and clusters at constant screen size: groups scaled by 1/k, radii in pixels. */
  function drawPoints() {
    drawnK = k;
    const s = 1 / k, list = [], st = new Map();
    for (const p of o.points || []) {
      if (!finite(p.lat) || !finite(p.lon)) continue;
      const [X, Y] = toXY(o.view, p.lon, p.lat);
      list.push({ id: p.id, x: X * k, y: Y * k });   // grid anchored to the map origin: panning never regroups
      st.set(p.id, STATES.has(p.state) ? p.state : 'wish');
    }
    groups = cluster(list, CELL).map((g) => ({ X: g.x * s, Y: g.y * s, ids: g.ids }));
    let h = '';
    const home = o.lines?.length > 1 ? o.lines[0] : null;
    if (finite(home?.[0]) && finite(home?.[1])) {
      const [X, Y] = toXY(o.view, home[1], home[0]);
      h += `<g class="home" transform="translate(${X} ${Y}) scale(${s})"><rect x="-5" y="-5" width="10" height="10" rx="2"/></g>`;
    }
    groups.forEach((g, i) => {
      let best = 'wish';
      for (const id of g.ids) if (RANK[st.get(id)] > RANK[best]) best = st.get(id);
      const n = g.ids.length, tr = `translate(${g.X} ${g.Y}) scale(${s})`;
      h += n === 1
        ? `<g class="pt" data-i="${i}" transform="${tr}"><circle class="hit" r="${R_HIT}"/><circle class="dot st-${best}" r="${R_DOT}"/></g>`
        : `<g class="pt cl" data-i="${i}" transform="${tr}"><circle class="hit" r="${R_HIT}"/>`
          + `<circle class="dot st-${best}" r="${n < 10 ? 11 : 13}"/><text dy=".35em">${n > 99 ? '99+' : n}</text></g>`;
    });
    ptsG.innerHTML = h;
  }

  // ---- Camera: centre (cx, cy) in path units, k = pixels per path unit ----

  const kMax = () => k0 * MAX_ZOOM[o.view];
  const fitK = () => Math.min(W / (b.box[2] - b.box[0]), H / (b.box[3] - b.box[1])) * FIT;

  /** Zoom limits; the centre stays over the view's content, so the content never leaves the viewport. */
  function clampCam() {
    k = clamp(k, k0, kMax());
    cx = clamp(cx, b.box[0], b.box[2]);
    cy = clamp(cy, b.box[1], b.box[3]);
  }

  function frameTo(cam) {
    k0 = fitK();
    k = k0;
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
    svg.setAttribute('viewBox', `${cx - W / 2 / k} ${cy - H / 2 / k} ${W / k} ${H / k}`);
    if (k !== drawnK) drawPoints();
  }
  const schedule = () => { raf ||= requestAnimationFrame(frame); };
  const paint = () => { cancelAnimationFrame(raf); frame(performance.now()); };

  function zoomAt(px, py, f) {
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
    k = a.k * (a.k1 / a.k) ** e;
    cx = a.X - (a.x0 + (a.sx - a.x0) * e - W / 2) / k;
    cy = a.Y - (a.y0 + (a.sy - a.y0) * e - H / 2) / k;
    clampCam();
    if (t < 1) schedule();
    else anim = null;
  }

  const screenLL = (px, py) => toLL(o.view, cx + (px - W / 2) / k, cy + (py - H / 2) / k);

  // ---- Gestures ----

  const ptrs = new Map();                           // pointerId → [x, y] in element pixels
  let rect = null, g = null, press = null, last = null, longT = 0, tapT = 0;
  const pos = (e) => [e.clientX - rect.left, e.clientY - rect.top];

  /** Re-anchor on the current pointers: the map point under their midpoint follows it; their distance scales. */
  function anchor() {
    const [a, c = a] = ptrs.values();
    const mx = (a[0] + c[0]) / 2, my = (a[1] + c[1]) / 2;
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
      return zoomTo(cx + (p.x - W / 2) / k, cy + (p.y - H / 2) / k, p.x, p.y, k * 2);
    }
    last = { x: p.x, y: p.y, t: performance.now() };
    tapT = setTimeout(() => { last = null; single(p); }, DBL_MS);
  }

  function single(p) {
    if (p.group) {
      if (p.group.ids.length === 1) return o.onPoint?.(p.group.ids[0]);
      if (k < kMax() * 0.999) return zoomTo(p.group.X, p.group.Y, W / 2, H / 2, k * 2);
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
    camera() {
      const ll = ready && !dead ? toLL(o.view, cx, cy) : null;
      return ll ? { lat: ll[1], lon: ll[0], zoom: k / k0 } : null;
    },
    destroy() {
      if (dead) return;
      dead = true;
      ac.abort();
      ro?.disconnect();
      cancelAnimationFrame(raf);
      clearTimeout(longT);
      clearTimeout(tapT);
      svg.remove();
    },
  };
}
