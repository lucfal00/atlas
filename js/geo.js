// Pure geometry: projections, ring decoding, point location, distances, clustering.
// No DOM, no network, no storage. Coordinates are degrees (x = lon, y = lat); y is positive north.

const RAD = Math.PI / 180;
const R_EARTH = 6371; // km
const NEAR_KM = 20; // coast / simplification tolerance (spec 8.3)

// ---- Decoding ----------------------------------------------------------

/** Delta-encoded integer rings [x0,y0,dx1,dy1,…] → [[lon,lat][]] (closed rings keep their end point). */
export function decode(feature, q) {
  return feature.rings.map((r) => {
    const pts = [];
    let x = 0, y = 0;
    for (let i = 0; i < r.length; i += 2) {
      x += r[i];
      y += r[i + 1];
      pts.push([x / q, y / q]);
    }
    return pts;
  });
}

export function bbox(rings) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const r of rings) {
    for (const [x, y] of r) {
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  return [x0, y0, x1, y1];
}

// ---- Projections -------------------------------------------------------

// Orthographic globe (unit sphere) centred on (lon0, lat0), degrees; x east, y north, both in [-1, 1] on the disc.
export function orthographic(lon, lat, lon0, lat0) {
  const f = lat * RAD, f0 = lat0 * RAD, dl = (lon - lon0) * RAD;
  const c = Math.sin(f0) * Math.sin(f) + Math.cos(f0) * Math.cos(f) * Math.cos(dl);   // cos of the angle from the centre
  return [Math.cos(f) * Math.sin(dl), Math.cos(f0) * Math.sin(f) - Math.sin(f0) * Math.cos(f) * Math.cos(dl), c >= 0];
}

/** Disc point → [lon, lat] (lon in [-180, 180]); null outside the disc (not finite or beyond the horizon). */
export function orthographicInverse(x, y, lon0, lat0) {
  const rho = Math.hypot(x, y);
  if (!Number.isFinite(rho) || rho > 1) return null;
  const f0 = lat0 * RAD;
  if (rho === 0) return [lon0, lat0];
  const c = Math.asin(rho);
  const lat = Math.asin(Math.cos(c) * Math.sin(f0) + (y * Math.sin(c) * Math.cos(f0)) / rho) / RAD;
  let lon = lon0 + Math.atan2(x * Math.sin(c), rho * Math.cos(f0) * Math.cos(c) - y * Math.sin(f0) * Math.sin(c)) / RAD;
  lon = ((((lon + 180) % 360) + 360) % 360) - 180;
  return [lon, lat];
}

// Italy: equirectangular centred on 12.5E, scaled at 42N.
const COS42 = Math.cos(42 * RAD);

export const italyProj = (lon, lat) => [(lon - 12.5) * COS42, lat];

export const italyInverse = (x, y) => [x / COS42 + 12.5, y];

// ---- Distance ----------------------------------------------------------

/** Great-circle distance in km. */
export function haversine(lat1, lon1, lat2, lon2) {
  const dLat = (lat2 - lat1) * RAD, dLon = (lon2 - lon1) * RAD;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * RAD) * Math.cos(lat2 * RAD) * Math.sin(dLon / 2) ** 2;
  return 2 * R_EARTH * Math.asin(Math.min(1, Math.sqrt(a)));
}

// ---- Point location ----------------------------------------------------

/** Even-odd rule over all rings (holes are rings too). Closed or open rings. */
export function pointInRings(lon, lat, rings) {
  let inside = false;
  for (const r of rings) {
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
      const [xi, yi] = r[i], [xj, yj] = r[j];
      if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
    }
  }
  return inside;
}

// Decoded rings + bbox per feature, computed once.
const cache = new WeakMap();

function prep(feature, q) {
  let c = cache.get(feature);
  if (!c) {
    const rings = decode(feature, q);
    c = { rings, box: bbox(rings) };
    cache.set(feature, c);
  }
  return c;
}

// Is (lat, lon) within ~m degrees of the box? Longitude margin widens with latitude; also tries ±360.
function nearBox(b, lat, lon, m = 0.3) {
  if (lat < b[1] - m || lat > b[3] + m) return false;
  const mx = m / Math.max(Math.cos(lat * RAD), 0.01);
  return [0, 360, -360].some((s) => lon + s >= b[0] - mx && lon + s <= b[2] + mx);
}

function minDist(lat, lon, rings) {
  let best = Infinity;
  for (const r of rings) {
    for (const [x, y] of r) {
      const d = haversine(lat, lon, y, x);
      if (d < best) best = d;
    }
  }
  return best;
}

// Feature containing the point; else nearest within NEAR_KM; else null.
function find(lat, lon, layer) {
  if (!layer) return null;
  for (const f of layer.features) {
    const { rings, box } = prep(f, layer.q);
    if (lon >= box[0] && lon <= box[2] && lat >= box[1] && lat <= box[3] && pointInRings(lon, lat, rings)) return f;
  }
  let best = null, bestD = NEAR_KM;
  for (const f of layer.features) {
    const { rings, box } = prep(f, layer.q);
    if (!nearBox(box, lat, lon)) continue;
    const d = minDist(lat, lon, rings);
    if (d <= bestD) { best = f; bestD = d; }
  }
  return best;
}

/** Country (world layer), then region/province (Italy layer). Unknowns are null (spec 8.3). */
export function locate(lat, lon, world, italia) {
  const c = find(lat, lon, world);
  let country = c ? c.k : null;
  let region = null, province = null;
  if (country === 'IT' || country === null) {
    const p = find(lat, lon, italia);
    if (p) {
      country = 'IT';
      region = p.r ?? null;
      province = p.n;
    }
  }
  return { country, region, province };
}

// ---- Clustering --------------------------------------------------------

/** Screen-space grid: one point per cell stays as is, several collapse to their mean. */
export function cluster(points, cell = 44) {
  const cells = new Map();
  for (const p of points) {
    const key = `${Math.floor(p.x / cell)},${Math.floor(p.y / cell)}`;
    const g = cells.get(key);
    if (g) g.push(p);
    else cells.set(key, [p]);
  }
  return [...cells.values()].map((g) => {
    if (g.length === 1) return { x: g[0].x, y: g[0].y, ids: [g[0].id] };
    return {
      x: g.reduce((s, p) => s + p.x, 0) / g.length,
      y: g.reduce((s, p) => s + p.y, 0) / g.length,
      ids: g.map((p) => p.id),
    };
  });
}
