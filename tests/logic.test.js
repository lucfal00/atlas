import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as L from '../js/logic.js';

const TODAY = '2026-10-28';

const place = (id, o = {}) => ({
  id, name: id, cat: 'borgo', status: 'wish', lat: 0, lon: 0, country: 'IT', region: null, deleted: false, ...o,
});
const trip = (id, from, to, o = {}) => ({ id, title: id, from, to, stops: [], deleted: false, ...o });
const mk = (o = {}) => ({ ...L.emptyDoc(), ...o });
const stop = (p) => ({ place: p });
const state = (doc, id) => L.placeState(doc, doc.places.find((p) => p.id === id), TODAY);

// ---- Dates & document --------------------------------------------------

test('date helpers: local keys', () => {
  assert.equal(L.toKey(new Date(2026, 0, 5)), '2026-01-05');
  assert.equal(L.todayKey(new Date(2026, 9, 28, 23, 59)), '2026-10-28');
});

test('newId: prefix + 6 base36 chars, distinct', () => {
  assert.match(L.newId('l'), /^l_[0-9a-z]{6}$/);
  assert.match(L.newId('v'), /^v_[0-9a-z]{6}$/);
  assert.equal(new Set(Array.from({ length: 100 }, () => L.newId('f'))).size, 100);
});

test('emptyDoc: shape, independent instances', () => {
  const d = L.emptyDoc();
  assert.deepEqual(d, {
    version: 1, places: [], trips: [], marks: {},
    settings: { theme: 'auto', home: { name: 'Napoli', lat: 40.85, lon: 14.27 }, lastBackup: 0 },
  });
  d.places.push(1);
  d.settings.home.lat = 0;
  assert.deepEqual(L.emptyDoc().places, []);
  assert.equal(L.emptyDoc().settings.home.lat, 40.85);
});

// ---- Place / trip state ------------------------------------------------

test('placeState: visited by status or by a stop of a past or ongoing trip', () => {
  const doc = mk({
    places: [place('a', { status: 'visited' }), place('c'), place('f'), place('w')],
    trips: [
      trip('t1', '2026-06-10', '2026-06-14', { stops: [stop('c')] }),
      trip('t2', TODAY, '2026-10-30', { stops: [stop('f')] }), // starts today
    ],
  });
  for (const id of ['a', 'c', 'f']) assert.equal(state(doc, id), 'visited', id);
  assert.equal(state(doc, 'w'), 'wish');
});

test('placeState: future trip, deleted trip and missing place leave a wish a wish; there is no planned state', () => {
  const doc = mk({
    places: [place('d'), place('e'), place('v', { status: 'visited' })],
    trips: [
      trip('t1', '2026-12-01', '2026-12-05', { stops: [stop('d'), stop('v')] }),
      trip('t3', '2026-01-01', '2026-01-05', { deleted: true, stops: [stop('e')] }),
      trip('t4', '2026-01-10', '2026-01-12', { stops: [stop('gone')] }),
    ],
  });
  assert.equal(state(doc, 'd'), 'wish');
  assert.equal(state(doc, 'e'), 'wish');
  assert.equal(state(doc, 'v'), 'visited');
});

test('placeState: an old planned status reads as wish', () => {
  assert.equal(state(mk({ places: [place('a', { status: 'planned' })] }), 'a'), 'wish');
});

test('tripState: boundaries', () => {
  assert.equal(L.tripState(trip('t', TODAY, '2026-10-30'), TODAY), 'current');
  assert.equal(L.tripState(trip('t', '2026-10-20', TODAY), TODAY), 'current');
  assert.equal(L.tripState(trip('t', '2026-10-20', '2026-10-27'), TODAY), 'past'); // to = yesterday
  assert.equal(L.tripState(trip('t', '2026-10-29', '2026-10-30'), TODAY), 'planned');
});

// ---- Areas -------------------------------------------------------------

test('areaStates: visited place feeds country and region; only wish / visited exist; absent = never', () => {
  const doc = mk({
    places: [
      place('p', { status: 'visited', country: 'IT', region: 'Campania' }),
      place('q', { country: 'PT', region: null }),
    ],
  });
  const m = L.areaStates(doc, TODAY);
  assert.equal(m.get('c:IT'), 'visited');
  assert.equal(m.get('r:Campania'), 'visited');
  assert.equal(m.get('c:PT'), 'wish');
  assert.equal(m.has('c:FR'), false);
  assert.equal(m.has('r:null'), false);
  assert.ok([...m.values()].every((s) => s === 'wish' || s === 'visited'));
});

test('areaStates: visited beats wish; deleted places ignored; a past trip makes its places visited', () => {
  const doc = mk({
    places: [
      place('a', { country: 'ES' }),
      place('c', { country: 'DE' }),
      place('d', { country: 'DE', status: 'visited' }),
      place('e', { country: 'FR', status: 'visited', deleted: true }),
      place('g', { country: 'GR' }),
    ],
    trips: [trip('t1', '2026-06-01', '2026-06-05', { stops: [stop('g')] })],
  });
  const m = L.areaStates(doc, TODAY);
  assert.equal(m.get('c:ES'), 'wish');
  assert.equal(m.get('c:DE'), 'visited');
  assert.equal(m.has('c:FR'), false);
  assert.equal(m.get('c:GR'), 'visited');
});

test('areaStates: manual marks; old province marks are ignored', () => {
  const doc = mk({
    places: [place('w', { country: 'GR' })],
    marks: {
      'c:PT': { s: 'visited', t: 1 },
      'c:GR': { s: 'visited', t: 1 },
      'c:ES': { s: null, t: 2 },
      'r:Toscana': { s: 'visited', t: 1 },
      'p:Lecce': { s: 'visited', t: 1 },
    },
  });
  const m = L.areaStates(doc, TODAY);
  assert.equal(m.get('c:PT'), 'visited');
  assert.equal(m.get('c:GR'), 'visited'); // mark upgrades a wish
  assert.equal(m.has('c:ES'), false); // s = null: no effect
  assert.equal(m.has('p:Lecce'), false);
  assert.equal(m.get('r:Toscana'), 'visited');
  assert.equal(m.get('c:IT'), 'visited'); // visited region implies Italy
});

test('areaStates: a merely wished Italian region does not mark Italy visited', () => {
  const doc = mk({ places: [place('a', { region: 'Toscana' })] });
  const m = L.areaStates(doc, TODAY);
  assert.equal(m.get('r:Toscana'), 'wish');
  assert.equal(m.get('c:IT'), 'wish');
});

test('visitedCounts: countries, regions and places visited', () => {
  const doc = mk({
    places: [
      place('a', { status: 'visited', country: 'IT', region: 'Toscana' }),
      place('b', { country: 'IT', region: 'Lazio' }), // wish
      place('c', { country: 'FR' }),
      place('d', { country: 'ES', deleted: true, status: 'visited' }),
    ],
    trips: [trip('t', '2026-01-01', '2026-01-03', { stops: [stop('c')] })],
    marks: { 'r:Puglia': { s: 'visited', t: 1 }, 'c:PT': { s: 'visited', t: 1 } },
  });
  assert.deepEqual(L.visitedCounts(doc, TODAY), { countries: 3, regions: 2, places: 2 });
  assert.deepEqual(L.visitedCounts(mk(), TODAY), { countries: 0, regions: 0, places: 0 });
});

test('fold: accent- and case-insensitive form', () => {
  assert.equal(L.fold('Forlì'), 'forli');
  assert.equal(L.fold('CITTÀ'), 'citta');
  assert.equal(L.fold(null), '');
});

test('monthRange: empty to = from, to < from rejected', async () => {
  const { monthRange, isMonth } = await import('../js/logic.js');
  assert.deepEqual(monthRange('2024-03', ''), { from: '2024-03', to: '2024-03' });
  assert.deepEqual(monthRange('2023-12', '2024-01'), { from: '2023-12', to: '2024-01' });
  assert.deepEqual(monthRange('', ''), { from: null, to: null });
  for (const [f, t] of [['2024-05', '2024-04'], ['', '2024-04'], ['2024-13', ''], ['2024-05', 'x']]) assert.equal(monthRange(f, t), null, `${f} ${t}`);
  assert.equal(isMonth('2024-12'), true);
  assert.equal(isMonth('2024-00'), false);
});
