import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as G from '../js/geo.js';

const load = (name) => JSON.parse(readFileSync(new URL(`../geo/${name}.json`, import.meta.url), 'utf8'));
const world = load('world');
const italia = load('italia');

const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg ?? ''} ${a} vs ${b} (±${tol})`);

test('decode: delta rings to [lon, lat]', () => {
  const f = { k: 'XX', rings: [[1000, 2000, 500, 0, 0, 500, -500, -500]] };
  assert.deepEqual(G.decode(f, 1000), [[[1, 2], [1.5, 2], [1.5, 2.5], [1, 2]]]);
  assert.deepEqual(G.decode({ rings: [[-5, 7, 5, -7]] }, 1), [[[-5, 7], [0, 0]]]);
});

test('bbox: [minX, minY, maxX, maxY] over all rings', () => {
  const rings = [[[0, 0], [10, 0], [10, 5], [0, 0]], [[-3, 2], [4, 9], [-3, 2]]];
  assert.deepEqual(G.bbox(rings), [-3, 0, 10, 9]);
});

test('orthographic: centre, horizon, back side, round trip', () => {
  assert.deepEqual(G.orthographic(12, 40, 12, 40), [0, 0, true]);
  const [ex, ey, ev] = G.orthographic(102, 0, 12, 0);          // 90° east of the centre: on the horizon
  near(ex, 1, 1e-12);
  near(ey, 0, 1e-12);
  assert.equal(ev, true);
  assert.equal(G.orthographic(-168, 0, 12, 0)[2], false);       // antipode
  assert.equal(G.orthographic(12, 85, 12, 0)[2], true);
  assert.equal(G.orthographic(192, 10, 12, 0)[2], false);
  assert.ok(G.orthographic(12, 50, 12, 40)[1] > 0 && G.orthographic(12, 30, 12, 40)[1] < 0); // y positive north
  assert.ok(G.orthographic(20, 40, 12, 40)[0] > 0);             // east is right
  for (const [lo, la, lo0, la0] of [[14.27, 40.85, 12, 40], [151.2, -33.9, 151, -30], [-9, 38, 12, 40], [0, 0, 0, 0], [100, 50, 60, 80], [-170, -20, 170, 10]]) {
    const [x, y, vis] = G.orthographic(lo, la, lo0, la0);
    assert.equal(vis, true);
    const r = G.orthographicInverse(x, y, lo0, la0);
    near(r[0], lo, 1e-9, 'lon');
    near(r[1], la, 1e-9, 'lat');
  }
  assert.deepEqual(G.orthographicInverse(0, 0, 12, 40), [12, 40]);
  assert.equal(G.orthographicInverse(1.01, 0, 12, 40), null);
  assert.equal(G.orthographicInverse(0.8, 0.8, 12, 40), null);
  assert.equal(G.orthographicInverse(NaN, 0, 12, 40), null);
});

test('italyProj: equirectangular around 12.5E, 42N', () => {
  assert.deepEqual(G.italyProj(12.5, 42), [0, 42]);
  const [x, y] = G.italyProj(14.27, 40.85);
  near(x, 1.77 * Math.cos((42 * Math.PI) / 180), 1e-12);
  assert.equal(y, 40.85);
  const [lon, lat] = G.italyInverse(x, y);
  near(lon, 14.27, 1e-9);
  near(lat, 40.85, 1e-12);
});

test('haversine: km on R = 6371', () => {
  near(G.haversine(0, 0, 0, 1), 111.195, 0.01);
  near(G.haversine(40.85, 14.27, 41.9, 12.5), 188.3, 1);
  assert.equal(G.haversine(10, 20, 10, 20), 0);
  near(G.haversine(0, 179.5, 0, -179.5), 111.195, 0.01); // across the antimeridian
});

test('pointInRings: even-odd with hole, tolerates closed rings', () => {
  const sq = [[0, 0], [10, 0], [10, 10], [0, 10]];
  const hole = [[4, 4], [6, 4], [6, 6], [4, 6]];
  assert.equal(G.pointInRings(5, 5, [sq, hole]), false); // in the hole
  assert.equal(G.pointInRings(2, 2, [sq, hole]), true); // in the ring
  assert.equal(G.pointInRings(11, 5, [sq, hole]), false);
  assert.equal(G.pointInRings(5, -1, [sq, hole]), false);
  const closed = [...sq, sq[0]]; // duplicate end point
  assert.equal(G.pointInRings(2, 2, [closed, [...hole, hole[0]]]), true);
  assert.equal(G.pointInRings(5, 5, [closed, [...hole, hole[0]]]), false);
});

test('locate: real data, inside polygons', () => {
  assert.deepEqual(G.locate(40.85, 14.27, world, italia), { country: 'IT', region: 'Campania', province: 'Napoli' });
  assert.deepEqual(G.locate(41.9, 12.5, world, italia), { country: 'IT', region: 'Lazio', province: 'Roma' });
  assert.deepEqual(G.locate(38.72, -9.14, world, italia), { country: 'PT', region: null, province: null });
});

test('locate: coast fallback within 20 km', () => {
  assert.deepEqual(G.locate(40.8, 14.17, world, italia), { country: 'IT', region: 'Campania', province: 'Napoli' });
});

test('locate: island missing from the world layer resolves via Italy layer', () => {
  const r = G.locate(35.5, 12.6, world, italia); // Lampedusa
  assert.equal(r.country, 'IT');
  assert.equal(r.region, 'Sicilia');
  assert.equal(r.province, 'Agrigento');
});

test('locate: open sea is all null', () => {
  assert.deepEqual(G.locate(40.0, 12.0, world, italia), { country: null, region: null, province: null });
  assert.deepEqual(G.locate(0, -30, world, italia), { country: null, region: null, province: null });
});

test('locate: repeated calls are stable (decode cache)', () => {
  const a = G.locate(40.85, 14.27, world, italia);
  const b = G.locate(40.85, 14.27, world, italia);
  assert.deepEqual(a, b);
});

test('cluster: 44 px grid, mean position, singles untouched', () => {
  assert.deepEqual(
    G.cluster([{ id: 'a', x: 10, y: 10 }, { id: 'b', x: 20, y: 20 }]),
    [{ x: 15, y: 15, ids: ['a', 'b'] }],
  );
  assert.deepEqual(
    G.cluster([{ id: 'a', x: 10, y: 10 }, { id: 'b', x: 100, y: 100 }]),
    [{ x: 10, y: 10, ids: ['a'] }, { x: 100, y: 100, ids: ['b'] }],
  );
  assert.deepEqual(G.cluster([]), []);
  assert.equal(G.cluster([{ id: 'a', x: 43, y: 0 }, { id: 'b', x: 44, y: 0 }]).length, 2); // cell boundary
  assert.equal(G.cluster([{ id: 'a', x: 10, y: 10 }, { id: 'b', x: 20, y: 20 }], 5).length, 2); // custom cell
});
