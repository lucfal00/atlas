import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as L from '../js/logic.js';
import { haversine } from '../js/geo.js';

const TODAY = '2026-10-28';
const NAPOLI = { lat: 40.85, lon: 14.27 };
const ROMA = { lat: 41.9028, lon: 12.4964 };

const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg ?? ''} ${a} vs ${b} (±${tol})`);

const place = (id, o = {}) => ({
  id, name: id, cat: 'borgo', status: 'wish', lat: 0, lon: 0, country: 'IT', region: null, province: null,
  rating: null, visits: [], deleted: false, ...o,
});
const trip = (id, from, to, o = {}) => ({ id, title: id, from, to, stops: [], budget: {}, costs: [], deleted: false, ...o });
const mk = (o = {}) => ({ ...L.emptyDoc(), ...o });
const stop = (p, o = {}) => ({ place: p, ...o });
const local = (y, m, d, h = 12, mi = 0) => new Date(y, m - 1, d, h, mi).getTime();

// ---- Dates & document --------------------------------------------------

test('date helpers: local keys, addDays across months and DST, diffDays', () => {
  assert.equal(L.toKey(new Date(2026, 0, 5)), '2026-01-05');
  assert.equal(L.toKey(L.fromKey('2026-12-31')), '2026-12-31');
  assert.equal(L.todayKey(new Date(2026, 9, 28, 23, 59)), '2026-10-28');
  assert.equal(L.addDays('2026-01-31', 1), '2026-02-01');
  assert.equal(L.addDays('2025-12-31', 1), '2026-01-01');
  assert.equal(L.addDays('2026-03-01', -1), '2026-02-28');
  assert.equal(L.diffDays('2026-06-10', '2026-06-14'), 4);
  assert.equal(L.diffDays('2026-06-14', '2026-06-10'), -4);
  assert.equal(L.diffDays('2026-03-28', '2026-03-30'), 2); // EU spring-forward in between
  assert.equal(L.diffDays('2026-10-24', '2026-10-26'), 2); // EU fall-back in between
  assert.equal(L.diffDays('2025-12-30', '2026-01-02'), 3);
});

test('newId: prefix + 6 base36 chars, distinct', () => {
  assert.match(L.newId('l'), /^l_[0-9a-z]{6}$/);
  assert.match(L.newId('v'), /^v_[0-9a-z]{6}$/);
  assert.equal(new Set(Array.from({ length: 100 }, () => L.newId('f'))).size, 100);
});

test('emptyDoc: spec 5 shape, independent instances', () => {
  const d = L.emptyDoc();
  assert.deepEqual(d, {
    version: 1, places: [], trips: [], diary: {}, marks: {},
    settings: { theme: 'auto', home: { name: 'Napoli', lat: 40.85, lon: 14.27 }, lastBackup: 0 },
  });
  d.places.push(1);
  d.settings.home.lat = 0;
  assert.deepEqual(L.emptyDoc().places, []);
  assert.equal(L.emptyDoc().settings.home.lat, 40.85);
  assert.deepEqual(L.COST_CATS, ['trasporti', 'alloggio', 'cibo', 'attivita', 'altro']);
});

// ---- Place / trip state ------------------------------------------------

test('placeState: visited by status, visits, past or current stop', () => {
  const doc = mk({
    places: [
      place('a', { status: 'visited' }),
      place('b', { visits: ['2024-01-01'] }),
      place('c'), place('f'),
    ],
    trips: [
      trip('t1', '2026-06-10', '2026-06-14', { stops: [stop('c')] }),
      trip('t2', TODAY, '2026-10-30', { stops: [stop('f')] }), // starts today
    ],
  });
  for (const id of ['a', 'b', 'c', 'f']) {
    assert.equal(L.placeState(doc, doc.places.find((p) => p.id === id), TODAY), 'visited', id);
  }
});

test('placeState: planned by future stop, stop dates override trip dates, else wish', () => {
  const doc = mk({
    places: [place('d'), place('g'), place('e'), place('h'), place('m'), place('v', { status: 'visited' })],
    trips: [
      trip('t1', '2026-12-01', '2026-12-05', { stops: [stop('d'), stop('v')] }),
      trip('t2', '2026-10-20', '2026-11-05', { stops: [stop('g', { from: '2026-11-01' })] }), // trip started, stop not yet
      trip('t3', '2026-12-01', '2026-12-05', { deleted: true, stops: [stop('e')] }), // deleted trip
      trip('t4', '2026-12-10', '2026-12-12', { stops: [stop('gone')] }), // missing place ignored
    ],
  });
  const st = (id) => L.placeState(doc, doc.places.find((p) => p.id === id), TODAY);
  assert.equal(st('d'), 'planned');
  assert.equal(st('g'), 'planned');
  assert.equal(st('e'), 'wish');
  assert.equal(st('h'), 'wish');
  assert.equal(st('v'), 'visited'); // visited wins over a future stop
});

test('placeState: past stop wins over a future stop on the same place', () => {
  const p = place('a');
  const doc = mk({
    places: [p],
    trips: [
      trip('t1', '2026-01-10', '2026-01-12', { stops: [stop('a')] }),
      trip('t2', '2026-12-10', '2026-12-12', { stops: [stop('a')] }),
    ],
  });
  assert.equal(L.placeState(doc, p, TODAY), 'visited');
});

test('tripState: boundaries; nights', () => {
  assert.equal(L.tripState(trip('t', TODAY, '2026-10-30'), TODAY), 'current');
  assert.equal(L.tripState(trip('t', '2026-10-20', TODAY), TODAY), 'current');
  assert.equal(L.tripState(trip('t', '2026-10-20', '2026-10-27'), TODAY), 'past'); // to = yesterday
  assert.equal(L.tripState(trip('t', '2026-10-29', '2026-10-30'), TODAY), 'planned');
  assert.equal(L.nights(trip('t', '2026-06-10', '2026-06-14')), 4);
  assert.equal(L.nights(trip('t', '2026-06-10', '2026-06-10')), 0);
});

// ---- Areas -------------------------------------------------------------

test('areaStates: visited place feeds country, region, province; absent = never', () => {
  const doc = mk({
    places: [
      place('p', { status: 'visited', country: 'IT', region: 'Campania', province: 'Napoli' }),
      place('q', { country: 'PT', region: null, province: null }),
    ],
  });
  const m = L.areaStates(doc, TODAY);
  assert.equal(m.get('c:IT'), 'visited');
  assert.equal(m.get('r:Campania'), 'visited');
  assert.equal(m.get('p:Napoli'), 'visited');
  assert.equal(m.get('c:PT'), 'wish');
  assert.equal(m.has('c:FR'), false);
  assert.equal(m.has('r:null'), false);
  assert.equal(m.has('p:null'), false);
});

test('areaStates: planned beats wish, visited beats planned; deleted places ignored', () => {
  const doc = mk({
    places: [
      place('a', { country: 'ES' }),
      place('b', { country: 'ES' }),
      place('c', { country: 'DE' }),
      place('d', { country: 'DE', status: 'visited' }),
      place('e', { country: 'FR', status: 'visited', deleted: true }),
    ],
    trips: [
      trip('t1', '2026-12-01', '2026-12-05', { stops: [stop('b'), stop('c')] }),
    ],
  });
  const m = L.areaStates(doc, TODAY);
  assert.equal(m.get('c:ES'), 'planned'); // wish + planned
  assert.equal(m.get('c:DE'), 'visited'); // planned + visited
  assert.equal(m.has('c:FR'), false);
});

test('areaStates: manual marks', () => {
  const doc = mk({
    places: [place('w', { country: 'GR' })],
    marks: {
      'c:PT': { s: 'visited', t: 1 },
      'c:GR': { s: 'visited', t: 1 },
      'c:ES': { s: null, t: 2 },
      'r:Toscana': { s: 'visited', t: 1 },
      'p:Lecce': { s: null, t: 1 },
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

test('areaStates: visited province mark implies Italy, and its region with regionOf', () => {
  const doc = mk({ marks: { 'p:Lecce': { s: 'visited', t: 1 } } });
  const plain = L.areaStates(doc, TODAY);
  assert.equal(plain.get('p:Lecce'), 'visited');
  assert.equal(plain.get('c:IT'), 'visited');
  assert.equal(plain.has('r:Puglia'), false);
  const withRegion = L.areaStates(doc, TODAY, (prov) => (prov === 'Lecce' ? 'Puglia' : null));
  assert.equal(withRegion.get('r:Puglia'), 'visited');
  assert.equal(L.areaStates(mk({ marks: { 'p:Zzz': { s: 'visited', t: 1 } } }), TODAY, () => null).has('r:null'), false);
});

test('areaStates: a merely planned or wished Italian region does not mark Italy visited', () => {
  const doc = mk({ places: [place('a', { region: 'Toscana', province: 'Siena' })] });
  const m = L.areaStates(doc, TODAY);
  assert.equal(m.get('r:Toscana'), 'wish');
  assert.equal(m.get('c:IT'), 'wish');
});

// ---- Statistics --------------------------------------------------------

test('travelDays: overlapping trips count distinct days', () => {
  const doc = mk({ trips: [trip('a', '2026-06-10', '2026-06-14'), trip('b', '2026-06-13', '2026-06-16')] });
  assert.equal(L.travelDays(doc, 2026, TODAY), 7);
  assert.equal(L.travelDays(doc, 2025, TODAY), 0);
});

test('travelDays: trip across the new year splits between years', () => {
  const doc = mk({ trips: [trip('a', '2025-12-30', '2026-01-02')] });
  assert.equal(L.travelDays(doc, 2025, TODAY), 2);
  assert.equal(L.travelDays(doc, 2026, TODAY), 2);
});

test('travelDays: future trips and days after today excluded; deleted trips ignored', () => {
  const doc = mk({
    trips: [
      trip('f', '2026-12-01', '2026-12-05'),
      trip('c', '2026-10-26', '2026-11-02'), // 26, 27, 28 are <= today
      trip('d', '2026-02-01', '2026-02-10', { deleted: true }),
    ],
  });
  assert.equal(L.travelDays(doc, 2026, TODAY), 3);
  assert.equal(L.travelDays(mk({ trips: [trip('f', '2026-12-01', '2026-12-05')] }), 2026, TODAY), 0);
});

test('tripsByYear: non-future, non-deleted, by year of from', () => {
  const doc = mk({
    trips: [
      trip('a', '2025-12-30', '2026-01-02'),
      trip('b', '2026-06-10', '2026-06-14'),
      trip('c', '2026-07-01', '2026-07-03'),
      trip('d', '2026-12-01', '2026-12-05'), // future
      trip('e', '2024-01-01', '2024-01-02', { deleted: true }),
      trip('f', TODAY, '2026-10-30'), // current counts
    ],
  });
  assert.deepEqual(L.tripsByYear(doc, TODAY), { 2025: 1, 2026: 3 });
});

test('tripKm: home to stop and back; no stops = 0; missing or deleted places skipped', () => {
  const doc = mk({
    places: [
      place('r', ROMA),
      place('x', { lat: 10, lon: 10, deleted: true }),
      place('n', { lat: null, lon: null }),
    ],
  });
  const t = trip('t', '2026-06-10', '2026-06-14', { stops: [stop('r')] });
  near(L.tripKm(doc, t), 376.5, 2);
  assert.equal(L.tripKm(doc, trip('t', '2026-06-10', '2026-06-14')), 0);
  const t2 = trip('t', '2026-06-10', '2026-06-14', { stops: [stop('x'), stop('r'), stop('gone'), stop('n')] });
  assert.equal(L.tripKm(doc, t2), L.tripKm(doc, t));
});

test('tripKm: stops in order, closing leg back home', () => {
  const doc = mk({ places: [place('r', ROMA), place('f', { lat: 43.7696, lon: 11.2558 })] });
  const t = trip('t', '2026-06-10', '2026-06-14', { stops: [stop('r'), stop('f')] });
  const want = haversine(NAPOLI.lat, NAPOLI.lon, ROMA.lat, ROMA.lon)
    + haversine(ROMA.lat, ROMA.lon, 43.7696, 11.2558)
    + haversine(43.7696, 11.2558, NAPOLI.lat, NAPOLI.lon);
  near(L.tripKm(doc, t), want, 1e-9);
});

test('yearKm: past and current trips with from in the year', () => {
  const doc = mk({ places: [place('r', ROMA)] });
  doc.trips = [
    trip('a', '2026-06-10', '2026-06-14', { stops: [stop('r')] }),
    trip('b', '2026-10-26', '2026-11-02', { stops: [stop('r')] }), // current
    trip('c', '2026-12-01', '2026-12-05', { stops: [stop('r')] }), // future
    trip('d', '2025-06-10', '2025-06-14', { stops: [stop('r')] }), // other year
    trip('e', '2026-03-01', '2026-03-02', { stops: [stop('r')], deleted: true }),
  ];
  const one = L.tripKm(doc, doc.trips[0]);
  near(L.yearKm(doc, 2026, TODAY), 2 * one, 1e-9);
  near(L.yearKm(doc, 2025, TODAY), one, 1e-9);
  assert.equal(L.yearKm(doc, 2024, TODAY), 0);
});

test('tripSpend: totals, per category, delta against budget, per night', () => {
  const t = trip('t', '2026-06-10', '2026-06-14', {
    budget: { alloggio: 400 },
    costs: [{ id: 'c1', cat: 'alloggio', amount: 380 }, { id: 'c2', cat: 'cibo', amount: 50 }],
  });
  const s = L.tripSpend(t);
  assert.equal(s.total, 430);
  assert.deepEqual(s.byCat, { trasporti: 0, alloggio: 380, cibo: 50, attivita: 0, altro: 0 });
  assert.deepEqual(s.delta, { trasporti: 0, alloggio: -20, cibo: 50, attivita: 0, altro: 0 });
  assert.equal(s.perNight, 107.5);
});

test('tripSpend: zero nights gives total; unknown category goes to altro; no costs', () => {
  const t = trip('t', '2026-06-10', '2026-06-10', {
    costs: [{ id: 'c1', cat: 'cibo', amount: 12.1 }, { id: 'c2', cat: 'cibo', amount: 0.2 }, { id: 'c3', cat: '???', amount: 5 }],
  });
  const s = L.tripSpend(t);
  assert.equal(s.total, 17.3);
  assert.equal(s.byCat.cibo, 12.3);
  assert.equal(s.byCat.altro, 5);
  assert.equal(s.perNight, 17.3);
  const e = L.tripSpend(trip('t', '2026-06-10', '2026-06-12'));
  assert.equal(e.total, 0);
  assert.equal(e.perNight, 0);
  assert.deepEqual(Object.keys(e.delta), L.COST_CATS);
});

test('countriesByContinent: visited places and marks, sorted, unknown continent', () => {
  const cont = { IT: 'Europe', PT: 'Europe', JP: 'Asia' };
  const doc = mk({
    places: [
      place('a', { status: 'visited', country: 'PT' }),
      place('b', { status: 'visited', country: 'IT' }),
      place('c', { status: 'visited', country: 'IT' }),
      place('w', { country: 'FR' }), // wish: excluded
      place('z', { status: 'visited', country: 'XX' }),
      place('d', { status: 'visited', country: 'DE', deleted: true }),
    ],
    marks: { 'c:JP': { s: 'visited', t: 1 }, 'c:ES': { s: null, t: 1 } },
  });
  assert.deepEqual(L.countriesByContinent(doc, TODAY, (c) => cont[c]), {
    Europe: ['IT', 'PT'], Asia: ['JP'], Altro: ['XX'],
  });
  assert.deepEqual(L.countriesByContinent(mk(), TODAY, (c) => cont[c]), {});
});

const world = () => mk({
  places: [
    place('rey', { status: 'visited', lat: 64.15, lon: -21.94 }),
    place('syd', { status: 'visited', lat: -33.87, lon: 151.21 }),
    place('lim', { status: 'visited', lat: -12.05, lon: -77.04 }),
    place('ant', { lat: -77.8, lon: 166.7 }), // wish: ignored
    place('del', { status: 'visited', lat: 80, lon: 0, deleted: true }),
    place('nul', { status: 'visited', lat: null, lon: null }),
  ],
});

test('farthest: visited place with max distance from home', () => {
  const f = L.farthest(world(), TODAY);
  assert.equal(f.place.id, 'syd');
  near(f.km, haversine(NAPOLI.lat, NAPOLI.lon, -33.87, 151.21), 1e-9);
  near(f.km, 16300, 200);
  assert.equal(L.farthest(mk({ places: [place('a')] }), TODAY), null);
  assert.equal(L.farthest(mk(), TODAY), null);
});

test('extremes: north, south, east, west among visited places', () => {
  const e = L.extremes(world(), TODAY);
  assert.equal(e.north.id, 'rey');
  assert.equal(e.south.id, 'syd');
  assert.equal(e.east.id, 'syd');
  assert.equal(e.west.id, 'lim');
  assert.equal(L.extremes(mk({ places: [place('a')] }), TODAY), null);
});

test('favoriteMonth: most travel days summed over all years; ties go to the earliest month', () => {
  const doc = mk({
    trips: [
      trip('a', '2025-08-01', '2025-08-03'), // Aug 3
      trip('b', '2026-07-01', '2026-07-04'), // Jul 4
      trip('c', '2026-08-10', '2026-08-12'), // Aug 3 -> 6 in total
      trip('f', '2026-11-10', '2026-11-30'), // future: ignored
    ],
  });
  assert.equal(L.favoriteMonth(doc, TODAY), 8);
  const tie = mk({ trips: [trip('a', '2026-05-01', '2026-05-02'), trip('b', '2026-03-01', '2026-03-02')] });
  assert.equal(L.favoriteMonth(tie, TODAY), 3);
  assert.equal(L.favoriteMonth(mk(), TODAY), null);
  assert.equal(L.favoriteMonth(mk({ trips: [trip('f', '2026-12-01', '2026-12-05')] }), TODAY), null);
});

// ---- First visit & year in travel --------------------------------------

test('firstVisit: earliest of visits and stop dates; marks and undated visited give null', () => {
  const doc = mk({
    places: [
      place('a', { country: 'IT', visits: ['2024-05-01'] }),
      place('b', { country: 'IT' }),
      place('c', { country: 'PT', status: 'visited' }), // undated
      place('d', { country: 'ES', visits: ['2027-01-01'] }), // future date
      place('e', { country: 'FR', visits: ['2020-01-01'], deleted: true }),
      place('g', { country: 'DE' }),
    ],
    trips: [
      trip('t1', '2026-06-10', '2026-06-14', { stops: [stop('b')] }),
      trip('t2', '2019-03-01', '2019-03-05', { stops: [stop('g', { from: '2019-03-02' })], deleted: true }),
    ],
    marks: { 'c:JP': { s: 'visited', t: 1 } },
  });
  assert.equal(L.firstVisit(doc, 'IT', TODAY), '2024-05-01');
  assert.equal(L.firstVisit(doc, 'PT', TODAY), null);
  assert.equal(L.firstVisit(doc, 'JP', TODAY), null);
  assert.equal(L.firstVisit(doc, 'ES', TODAY), null); // only a future date
  assert.equal(L.firstVisit(doc, 'ES'), '2027-01-01'); // no today: nothing filtered
  assert.equal(L.firstVisit(doc, 'FR', TODAY), null); // deleted place
  assert.equal(L.firstVisit(doc, 'DE', TODAY), null); // deleted trip
  assert.equal(L.firstVisit(doc, 'US', TODAY), null);
});

test('firstVisit: stop date overrides trip date; earliest wins', () => {
  const doc = mk({
    places: [place('a', { country: 'IT' }), place('b', { country: 'IT', visits: ['2026-09-01'] })],
    trips: [trip('t', '2026-06-10', '2026-06-14', { stops: [stop('a', { from: '2026-06-12' })] })],
  });
  assert.equal(L.firstVisit(doc, 'IT', TODAY), '2026-06-12');
});

const yearDoc = () => mk({
  places: [
    place('it', { country: 'IT', rating: 4 }),
    place('pt', { country: 'PT', rating: 5 }),
    place('jp', { country: 'JP', rating: 3, visits: ['2024-05-01'] }),
    place('fr', { country: 'FR' }),
    place('de', { country: 'DE', status: 'visited', rating: 5, deleted: true }),
    place('r', ROMA),
  ],
  trips: [
    trip('t1', '2026-06-10', '2026-06-14', {
      stops: [stop('pt'), stop('it')], costs: [{ id: 'c1', cat: 'alloggio', amount: 100 }],
    }),
    trip('t2', '2026-09-01', '2026-09-05', {
      stops: [stop('jp')], costs: [{ id: 'c2', cat: 'cibo', amount: 250 }],
    }),
    trip('t3', '2025-08-01', '2025-08-03', { stops: [stop('fr')], costs: [{ id: 'c3', cat: 'cibo', amount: 999 }] }),
    trip('t4', '2026-12-01', '2026-12-05', { stops: [stop('fr')], costs: [{ id: 'c4', cat: 'cibo', amount: 999 }] }),
    trip('t5', '2026-02-01', '2026-02-02', { deleted: true, costs: [{ id: 'c5', cat: 'cibo', amount: 999 }] }),
  ],
  marks: { 'c:ES': { s: 'visited', t: 1 } },
});

test('yearInTravel: trips, days, km, spend', () => {
  const doc = yearDoc();
  doc.trips[0].stops.push(stop('r'));
  const y = L.yearInTravel(doc, 2026, TODAY);
  assert.deepEqual(y.trips.map((t) => t.id), ['t1', 't2']);
  assert.equal(y.days, 10);
  assert.equal(y.days, L.travelDays(doc, 2026, TODAY));
  assert.equal(y.km, L.yearKm(doc, 2026, TODAY));
  assert.ok(y.km > 0);
  assert.equal(y.spend, 350);
});

test('yearInTravel: new countries exclude earlier visits and mark-only countries', () => {
  const y = L.yearInTravel(yearDoc(), 2026, TODAY);
  assert.deepEqual(y.newCountries, ['IT', 'PT']); // JP seen in 2024, ES only marked, FR only future/other
  assert.deepEqual(y.countries, ['IT', 'JP', 'PT']);
  assert.equal(y.bestPlace.id, 'pt');
  const y25 = L.yearInTravel(yearDoc(), 2025, TODAY);
  assert.deepEqual(y25.newCountries, ['FR']);
  assert.deepEqual(y25.trips.map((t) => t.id), ['t3']);
});

test('yearInTravel: empty year', () => {
  const y = L.yearInTravel(mk(), 2026, TODAY);
  assert.deepEqual(y, { trips: [], days: 0, km: 0, spend: 0, newCountries: [], bestPlace: null, countries: [] });
});

test('fold: accent- and case-insensitive form', () => {
  assert.equal(L.fold('Forlì'), 'forli');
  assert.equal(L.fold('CITTÀ'), 'citta');
  assert.equal(L.fold(null), '');
});
