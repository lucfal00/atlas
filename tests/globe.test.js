import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { globeData, ringPath } from '../js/map.js';

const world = JSON.parse(readFileSync(new URL('../geo/world.json', import.meta.url), 'utf8'));
const RAD = Math.PI / 180;

function basis(lon0, lat0) {
  const l = lon0 * RAD, a = lat0 * RAD;
  const v = [Math.cos(a) * Math.sin(l), Math.sin(a), Math.cos(a) * Math.cos(l)];
  return { v, e: [Math.cos(l), 0, -Math.sin(l)], n: [-Math.sin(a) * Math.sin(l), Math.cos(a), -Math.sin(a) * Math.cos(l)] };
}

const data = globeData(world);
const R = 400, X0 = 500, Y0 = 400;
const pathOf = (k, lon0 = 12, lat0 = 40) => data.feats.find((x) => x.f.k === k).rings.map((r) => ringPath(r, basis(lon0, lat0), R, X0, Y0)).join('');

/** Rough area of the first subpath by shoelace on the M/L points. */
function area(d) {
  const pts = [...d.matchAll(/[ML](-?[\d.]+) (-?[\d.]+)/g)].map((m) => [+m[1], +m[2]]);
  let s = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x1, y1] = pts[i], [x2, y2] = pts[(i + 1) % pts.length];
    s += x1 * y2 - x2 * y1;
  }
  return Math.abs(s / 2);
}

test('globe: countries facing the viewer produce small, on-disc paths', () => {
  for (const k of ['IT', 'FR', 'DE', 'ES', 'GR']) {
    const d = pathOf(k);
    assert.ok(d.length > 20, `${k} has a path`);
    assert.ok(area(d) < Math.PI * R * R * 0.2, `${k} does not fill the disc`);
    for (const m of d.matchAll(/[ML](-?[\d.]+) (-?[\d.]+)/g)) {
      assert.ok(Math.hypot(+m[1] - X0, +m[2] - Y0) <= R + 1, `${k} point inside the disc`);
    }
  }
});

test('globe: far-side country is empty', () => {
  assert.equal(pathOf('AU', 12, 40), '');
});

// Regression: Antarctica (a ring around the pole) had the wrong winding, so the horizon closed the long way
// and it covered the whole disc, hiding every country, depending on the rotation.
test('globe: no feature exceeds its own angular size at any rotation', () => {
  for (let lon0 = -180; lon0 < 180; lon0 += 15) {
    for (let lat0 = -60; lat0 <= 60; lat0 += 15) {
      for (const ft of data.feats) {
        const d = ft.rings.map((r) => ringPath(r, basis(lon0, lat0), R, 0, 0)).join('');
        if (!d) continue;
        const cap = 1 - Math.cos(ft.rho);                // generous bound: fraction of the disc
        assert.ok(area(d) / (Math.PI * R * R) <= Math.min(1, cap + 0.02), `${ft.f.k} at ${lon0},${lat0}`);
      }
    }
  }
});
