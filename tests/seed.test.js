import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateDoc } from '../js/merge.js';

const seed = JSON.parse(readFileSync(new URL('../seed/weekend.json', import.meta.url), 'utf8'));
const place = (name) => seed.places.find((p) => p.name === name);
const trip = (title) => seed.trips.find((t) => t.title === title);

test('seed: valid Atlas document', () => {
  assert.ok(validateDoc(seed));
});

test('seed: 8 wish city places with countries computed from coordinates', () => {
  assert.equal(seed.places.length, 8);
  assert.ok(seed.places.every((p) => p.status === 'wish' && p.cat === 'citta' && !p.deleted));
  assert.deepEqual(seed.places.map((p) => p.name), ['Dublino', 'Atene', 'Parigi', 'Berlino', 'Varsavia', 'Cracovia', 'Tirana', 'Tolosa']);
  assert.deepEqual(seed.places.map((p) => p.country), ['IE', 'GR', 'FR', 'DE', 'PL', 'PL', 'AL', 'FR']);
});

test('seed: two planned trips with stop and budget', () => {
  assert.equal(seed.trips.length, 2);
  const d = trip('Dublino');
  assert.equal(d.from, '2026-12-11');
  assert.equal(d.to, '2026-12-13');
  assert.deepEqual(d.stops.map((s) => s.place), [place('Dublino').id]);
  assert.deepEqual({ t: d.budget.trasporti, a: d.budget.alloggio, c: d.budget.cibo }, { t: 132, a: 170, c: 72.5 });
  const a = trip('Atene');
  assert.equal(a.from, '2027-01-01');
  assert.equal(a.to, '2027-01-04');
  assert.deepEqual(a.stops.map((s) => s.place), [place('Atene').id]);
  assert.deepEqual({ t: a.budget.trasporti, a: a.budget.alloggio, c: a.budget.cibo }, { t: 167, a: 125, c: 112.5 });
});

test('seed: place budget, months, todo', () => {
  assert.equal(place('Dublino').budget, 374.5);
  assert.deepEqual(place('Dublino').months, [12]);
  assert.deepEqual(place('Berlino').months, [2]);
  assert.deepEqual(place('Tirana').months, [3]);
  assert.equal(place('Dublino').todo.length, 5);
  assert.ok(place('Dublino').todo.every((t) => t.id && t.text && t.done === false));
  assert.ok(place('Dublino').note.includes('Ha\'penny Bridge'));
});

test('seed: unique ids, importable into an empty document', async () => {
  const ids = [...seed.places, ...seed.trips].map((x) => x.id);
  assert.equal(new Set(ids).size, ids.length);
  const { emptyDoc } = await import('../js/logic.js');
  const { mergeDocs } = await import('../js/merge.js');
  assert.equal(mergeDocs(emptyDoc(), seed).count, 10);
});
