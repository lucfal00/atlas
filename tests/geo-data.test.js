import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';

const KB = 1024;
const load = (name) => {
  const url = new URL(`../geo/${name}.json`, import.meta.url);
  return { size: statSync(url).size, data: JSON.parse(readFileSync(url, 'utf8')) };
};
const CONTINENTS = new Set(['Africa', 'Antarctica', 'Asia', 'Europe', 'North America', 'Oceania', 'Seven seas (open ocean)', 'South America']);
const REGIONS = ['Abruzzo', 'Basilicata', 'Calabria', 'Campania', 'Emilia-Romagna', 'Friuli-Venezia Giulia', 'Lazio', 'Liguria', 'Lombardia', 'Marche', 'Molise', 'Piemonte', 'Puglia', 'Sardegna', 'Sicilia', 'Toscana', 'Trentino-Alto Adige', 'Umbria', "Valle d'Aosta", 'Veneto'];

// Every ring: [x0, y0, dx1, dy1, ...] integers, >= 4 points, closed (deltas sum to zero).
const assertRings = (f) => {
  assert.ok(Array.isArray(f.rings) && f.rings.length > 0, `${f.k}: no rings`);
  for (const r of f.rings) {
    assert.ok(r.length >= 8 && r.length % 2 === 0, `${f.k}: ring length ${r.length}`);
    assert.ok(r.every(Number.isInteger), `${f.k}: non-integer value`);
    let x = 0, y = 0;
    for (let i = 2; i < r.length; i += 2) { x += r[i]; y += r[i + 1]; }
    assert.equal(x, 0, `${f.k}: ring not closed (x)`);
    assert.equal(y, 0, `${f.k}: ring not closed (y)`);
  }
};

test('world.json: size, features, codes, names, continents', () => {
  const { size, data } = load('world');
  assert.ok(size <= 350 * KB, `world.json is ${size} bytes`);
  assert.equal(data.q, 1000);
  assert.ok(data.features.length >= 200);
  assert.equal(new Set(data.features.map((f) => f.k)).size, data.features.length, 'duplicate k');
  for (const f of data.features) {
    assert.match(f.k, /^(?:[A-Z]{2}|[A-Z]{3})$/);
    assert.ok(typeof f.n === 'string' && f.n.length > 0, `${f.k}: empty name`);
    assert.ok(CONTINENTS.has(f.c), `${f.k}: continent ${f.c}`);
    assertRings(f);
  }
});

test('italia.json: size, provinces, regions, Napoli', () => {
  const { size, data } = load('italia');
  assert.ok(size <= 350 * KB, `italia.json is ${size} bytes`);
  assert.equal(data.q, 10000);
  assert.ok(data.features.length >= 100);
  assert.equal(new Set(data.features.map((f) => f.k)).size, data.features.length, 'duplicate k');
  assert.equal(new Set(data.features.map((f) => f.n)).size, data.features.length, 'duplicate province name');
  for (const f of data.features) {
    assert.ok(typeof f.n === 'string' && f.n.length > 0, `${f.k}: empty name`);
    assertRings(f);
  }
  assert.deepEqual([...new Set(data.features.map((f) => f.r))].sort(), [...REGIONS].sort());
  const napoli = data.features.find((f) => f.n === 'Napoli');
  assert.ok(napoli);
  assert.equal(napoli.r, 'Campania');
});
