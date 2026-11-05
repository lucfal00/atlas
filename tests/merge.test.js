import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateDoc, sanitizeDoc, mergeDocs } from '../js/merge.js';
import { emptyDoc } from '../js/logic.js';

// ---- helpers -----------------------------------------------------------

const place = (id, updatedAt, extra = {}) => ({ id, name: id, status: 'wish', deleted: false, updatedAt, ...extra });
const trip = (id, updatedAt, extra = {}) => ({ id, title: id, from: '2026-06-10', to: '2026-06-12', deleted: false, updatedAt, ...extra });

function docWith(parts = {}) {
  return { ...emptyDoc(), ...parts };
}

function deepFreeze(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    Object.values(o).forEach(deepFreeze);
  }
  return o;
}

const ids = (list) => list.map((x) => x.id);

// ---- validateDoc -------------------------------------------------------

test('validateDoc: accepts the empty document and a populated one', () => {
  assert.equal(validateDoc(emptyDoc()), true);
  const d = docWith({
    places: [place('l_a', 1)],
    trips: [trip('v_a', 1)],
    marks: { 'c:PT': { s: 'visited', t: 1 } },
  });
  assert.equal(validateDoc(d), true);
});

test('validateDoc: rejects non-objects and wrong version', () => {
  for (const bad of [null, undefined, 0, 42, 'x', true, [], () => {}]) assert.equal(validateDoc(bad), false);
  assert.equal(validateDoc({ ...emptyDoc(), version: 2 }), false);
  assert.equal(validateDoc({ ...emptyDoc(), version: '1' }), false);
  const { version, ...noVersion } = emptyDoc();
  assert.equal(validateDoc(noVersion), false);
});

test('validateDoc: places and trips must be arrays of objects with a string id', () => {
  for (const key of ['places', 'trips']) {
    assert.equal(validateDoc({ ...emptyDoc(), [key]: {} }), false);
    assert.equal(validateDoc({ ...emptyDoc(), [key]: null }), false);
    assert.equal(validateDoc({ ...emptyDoc(), [key]: undefined }), false);
    assert.equal(validateDoc({ ...emptyDoc(), [key]: [null] }), false);
    assert.equal(validateDoc({ ...emptyDoc(), [key]: ['x'] }), false);
    assert.equal(validateDoc({ ...emptyDoc(), [key]: [[]] }), false);
    assert.equal(validateDoc({ ...emptyDoc(), [key]: [{}] }), false);
    assert.equal(validateDoc({ ...emptyDoc(), [key]: [{ id: 7 }] }), false);
    assert.equal(validateDoc({ ...emptyDoc(), [key]: [{ id: 'a' }, { name: 'no id' }] }), false);
  }
  assert.equal(validateDoc({ ...emptyDoc(), places: [place('a', 1)] }), true);
  assert.equal(validateDoc({ ...emptyDoc(), trips: [trip('a', 1)] }), true);
});

test('validateDoc: deep checks on places', () => {
  const ok = (extra) => validateDoc({ ...emptyDoc(), places: [place('a', 1, extra)] });
  assert.equal(ok({ lat: 40.8, lon: 14.2, date: '2026-06-10', region: 'Campania' }), true);
  assert.equal(ok({ lat: null, lon: null }), true);
  assert.equal(ok({ rating: 9, tags: 'x', visits: 'x', todo: [1] }), true, 'old fields are ignored, never rejected');
  for (const bad of [{ name: 5 }, { name: undefined }, { lat: '40' }, { lon: NaN }]) {
    assert.equal(ok(bad), false, JSON.stringify(bad));
  }
});

test('validateDoc: deep checks on trips and marks', () => {
  const okT = (extra) => validateDoc({ ...emptyDoc(), trips: [trip('a', 1, extra)] });
  assert.equal(okT({ stops: [{ place: 'l_a' }], spend: 12.5, note: 'x' }), true);
  assert.equal(okT({ spend: null }), true);
  assert.equal(okT({ costs: 'x', budget: [], with: 'a' }), true, 'old fields are ignored');
  for (const bad of [{ from: undefined }, { to: '2026-6-1' }, { from: '2026-06-13' }, { title: 3 }, { stops: {} }, { stops: [1] },
    { stops: [{ place: 3 }] }, { spend: '12' }, { spend: NaN }]) {
    assert.equal(okT(bad), false, JSON.stringify(bad));
  }
  assert.equal(validateDoc({ ...emptyDoc(), marks: { 'c:IT': { s: null, t: 1 } } }), true);
  assert.equal(validateDoc({ ...emptyDoc(), marks: { 'c:IT': 'visited' } }), false);
  assert.equal(validateDoc({ ...emptyDoc(), marks: { 'c:IT': { s: 5 } } }), false);
});

test('sanitizeDoc: drops single malformed items and counts them; wrong overall shape → null', () => {
  const d = docWith({
    places: [place('a', 1), place('bad', 1, { name: 3 }), { id: 'x' }],
    trips: [trip('t', 1), trip('tbad', 1, { from: null })],
    marks: { 'c:IT': { s: 'visited', t: 1 }, 'c:FR': 7 },
  });
  const r = sanitizeDoc(d);
  assert.equal(r.dropped, 4);
  assert.deepEqual(ids(r.doc.places), ['a']);
  assert.deepEqual(ids(r.doc.trips), ['t']);
  assert.deepEqual(Object.keys(r.doc.marks), ['c:IT']);
  assert.equal(validateDoc(r.doc), true);
  assert.equal(d.places.length, 3, 'input untouched');
  assert.equal(sanitizeDoc(emptyDoc()).dropped, 0);
  for (const bad of [null, [], { ...emptyDoc(), version: 2 }, { ...emptyDoc(), places: {} }, { ...emptyDoc(), settings: null }]) {
    assert.equal(sanitizeDoc(bad), null);
  }
});

test('sanitizeDoc: an old document loses its extra fields and maps onto the new model', () => {
  const old = {
    version: 1,
    places: [
      place('a', 5, { status: 'planned', rating: 4, fav: true, tags: ['x'], with: ['y'], todo: [{ id: 't', text: 'z' }], links: [],
        months: [3], budget: 100, visits: ['2024-05-01', '2025-07-02'], province: 'Napoli', cover: 'f_1', region: 'Campania', country: 'IT', lat: 1, lon: 2 }),
      place('b', 6, { status: 'visited', date: '2026-01-02' }),
    ],
    trips: [trip('t', 7, { with: ['q'], links: [{ url: 'https://x.y' }], budget: { cibo: 5 },
      costs: [{ id: 'c', cat: 'cibo', amount: 10.25 }, { id: 'd', cat: 'altro', amount: 4 }], stops: [{ place: 'a', from: '2026-06-10', to: '2026-06-11' }] })],
    diary: { 't:2026-06-10': { text: 'ciao', t: 1 } },
    marks: { 'c:IT': { s: 'visited', t: 1 } },
    settings: { theme: 'dark', home: { name: 'Roma', lat: 41.9, lon: 12.5 }, lastBackup: 3 },
  };
  const r = sanitizeDoc(old);
  assert.equal(r.dropped, 0);
  assert.equal('diary' in r.doc, false);
  assert.deepEqual(r.doc.places[0], { id: 'a', name: 'a', status: 'wish', date: '2025-07-02', lat: 1, lon: 2, country: 'IT', region: 'Campania', deleted: false, updatedAt: 5 });
  assert.equal(r.doc.places[1].date, '2026-01-02');
  assert.deepEqual(r.doc.trips[0].stops, [{ place: 'a' }]);
  assert.equal(r.doc.trips[0].spend, 14.25);
  for (const k of ['with', 'links', 'budget', 'costs']) assert.equal(k in r.doc.trips[0], false, k);
  assert.deepEqual(r.doc.settings, old.settings);
  assert.equal(validateDoc(r.doc), true);
});

test('validateDoc: marks and settings must be plain non-null non-array objects', () => {
  for (const key of ['marks', 'settings']) {
    assert.equal(validateDoc({ ...emptyDoc(), [key]: [] }), false);
    assert.equal(validateDoc({ ...emptyDoc(), [key]: null }), false);
    assert.equal(validateDoc({ ...emptyDoc(), [key]: undefined }), false);
    assert.equal(validateDoc({ ...emptyDoc(), [key]: 'x' }), false);
    assert.equal(validateDoc({ ...emptyDoc(), [key]: 0 }), false);
    assert.equal(validateDoc({ ...emptyDoc(), [key]: {} }), true);
  }
});

// ---- mergeDocs: validation ---------------------------------------------

test('mergeDocs: throws "Documento non valido" when either side is invalid', () => {
  const ok = emptyDoc();
  assert.throws(() => mergeDocs(null, ok), { name: 'Error', message: 'Documento non valido' });
  assert.throws(() => mergeDocs(ok, null), { name: 'Error', message: 'Documento non valido' });
  assert.throws(() => mergeDocs({ ...ok, version: 2 }, ok), { message: 'Documento non valido' });
  assert.throws(() => mergeDocs(ok, { ...ok, places: {} }), { message: 'Documento non valido' });
  assert.throws(() => mergeDocs(ok, { ...ok, marks: [] }), { message: 'Documento non valido' });
  assert.throws(() => mergeDocs(undefined, undefined), { message: 'Documento non valido' });
});

// ---- mergeDocs: arrays by id -------------------------------------------

test('mergeDocs: places, trips — greater updatedAt wins per id', () => {
  const local = docWith({
    places: [place('l_new', 9, { name: 'local' }), place('l_old', 1, { name: 'local' })],
    trips: [trip('v_new', 9, { title: 'local' }), trip('v_old', 1, { title: 'local' })],
  });
  const incoming = docWith({
    places: [place('l_new', 5, { name: 'incoming' }), place('l_old', 4, { name: 'incoming' })],
    trips: [trip('v_new', 5, { title: 'incoming' }), trip('v_old', 4, { title: 'incoming' })],
  });
  const { doc, count } = mergeDocs(local, incoming);
  assert.deepEqual(doc.places.map((p) => p.name), ['local', 'incoming']);
  assert.deepEqual(doc.trips.map((t) => t.title), ['local', 'incoming']);
  assert.deepEqual(doc.places.map((p) => p.updatedAt), [9, 4]);
  assert.equal(count, 2);
});

test('mergeDocs: tie on updatedAt keeps local', () => {
  const local = docWith({ places: [place('l_a', 5, { name: 'local' })], trips: [trip('v_a', 5, { title: 'local' })] });
  const incoming = docWith({ places: [place('l_a', 5, { name: 'incoming' })], trips: [trip('v_a', 5, { title: 'incoming' })] });
  const { doc, count } = mergeDocs(local, incoming);
  assert.equal(doc.places[0].name, 'local');
  assert.equal(doc.trips[0].title, 'local');
  assert.equal(count, 0);
});

test('mergeDocs: missing updatedAt counts as 0', () => {
  const local = docWith({ places: [{ id: 'l_a', name: 'local' }, place('l_b', 3, { name: 'local' }), { id: 'l_c', name: 'local' }] });
  const incoming = docWith({ places: [place('l_a', 1, { name: 'incoming' }), { id: 'l_b', name: 'incoming' }, { id: 'l_c', name: 'incoming' }] });
  const { doc, count } = mergeDocs(local, incoming);
  assert.deepEqual(doc.places.map((p) => p.name), ['incoming', 'local', 'local']); // 1>0 wins; 0<3 loses; 0=0 tie → local
  assert.equal(count, 1);
});

test('mergeDocs: items present on one side only are kept', () => {
  const local = docWith({ places: [place('l_loc', 1)], trips: [trip('v_loc', 1)] });
  const incoming = docWith({ places: [place('l_inc', 1)], trips: [trip('v_inc', 1)] });
  const { doc, count } = mergeDocs(local, incoming);
  assert.deepEqual(ids(doc.places), ['l_loc', 'l_inc']);
  assert.deepEqual(ids(doc.trips), ['v_loc', 'v_inc']);
  assert.equal(count, 2); // only the incoming-only ones are taken from incoming
});

test('mergeDocs: order is local order (winner replaced in place), then incoming-only in incoming order', () => {
  const local = docWith({ places: [place('c', 1, { name: 'L' }), place('a', 1, { name: 'L' }), place('b', 1, { name: 'L' })] });
  const incoming = docWith({
    places: [place('z', 1), place('b', 2, { name: 'I' }), place('y', 1), place('c', 1, { name: 'I' }), place('x', 1)],
  });
  const { doc } = mergeDocs(local, incoming);
  assert.deepEqual(ids(doc.places), ['c', 'a', 'b', 'z', 'y', 'x']);
  assert.equal(doc.places[2].name, 'I'); // b replaced where it was
  assert.equal(doc.places[0].name, 'L');
});

test('mergeDocs: soft-deleted item with newer updatedAt wins over a live one', () => {
  const local = docWith({ places: [place('l_a', 1, { deleted: false })] });
  const incoming = docWith({ places: [place('l_a', 2, { deleted: true })] });
  const { doc } = mergeDocs(local, incoming);
  assert.equal(doc.places[0].deleted, true);
});

// ---- mergeDocs: marks by key ---------------------------------

test('mergeDocs: marks — greater t wins, a newer s:null overrides an older visited', () => {
  const local = docWith({
    marks: {
      'c:PT': { s: 'visited', t: 5 },
      'c:FR': { s: 'visited', t: 5 },
      'r:Campania': { s: null, t: 5 },
      'p:Salerno': { s: 'visited', t: 5 },
    },
  });
  const incoming = docWith({
    marks: {
      'c:PT': { s: null, t: 9 },            // removal is newer → wins
      'c:FR': { s: null, t: 3 },            // removal is older → loses
      'r:Campania': { s: 'visited', t: 9 }, // re-marked after removal
      'p:Napoli': { s: 'visited', t: 1 },   // incoming only
    },
  });
  const { doc, count } = mergeDocs(local, incoming);
  assert.deepEqual(doc.marks, {
    'c:PT': { s: null, t: 9 },
    'c:FR': { s: 'visited', t: 5 },
    'r:Campania': { s: 'visited', t: 9 },
    'p:Salerno': { s: 'visited', t: 5 },
    'p:Napoli': { s: 'visited', t: 1 },
  });
  assert.equal(count, 3);
});

test('mergeDocs: missing t counts as 0 for marks', () => {
  const local = docWith({ marks: { a: { s: 'visited' }, b: { s: 'visited', t: 2 }, c: { s: 'visited' } } });
  const incoming = docWith({ marks: { a: { s: null, t: 1 }, b: { s: null }, c: { s: null } } });
  const { doc, count } = mergeDocs(local, incoming);
  assert.deepEqual(doc.marks.a, { s: null, t: 1 });
  assert.equal(doc.marks.b.s, 'visited');
  assert.equal(doc.marks.c.s, 'visited'); // 0 = 0 → local
  assert.equal(count, 1);
});

test('mergeDocs: keys named like Object.prototype members are handled as plain keys', () => {
  const local = docWith({ marks: { 'c:PT': { s: 'visited', t: 1 } } });
  const incoming = docWith({
    marks: JSON.parse('{"constructor":{"s":"visited","t":1},"toString":{"s":"visited","t":1},"__proto__":{"s":"visited","t":1}}'),
  });
  const { doc, count } = mergeDocs(local, incoming);
  assert.equal(count, 3);
  assert.equal(Object.getPrototypeOf(doc.marks), Object.prototype);
  assert.equal(Object.hasOwn(doc.marks, 'constructor'), true);
  assert.equal(Object.hasOwn(doc.marks, 'toString'), true);
  assert.equal(Object.hasOwn(doc.marks, '__proto__'), true);
  assert.equal(Object.keys(doc.marks).length, 4);
});

// ---- mergeDocs: settings -----------------------------------------------

test('mergeDocs: settings stay local, lastBackup is the max', () => {
  const local = docWith({ settings: { theme: 'dark', home: { name: 'Roma', lat: 41.9, lon: 12.5 }, lastBackup: 100 } });
  const incoming = docWith({ settings: { theme: 'light', home: { name: 'Napoli', lat: 40.85, lon: 14.27 }, lastBackup: 500, extra: 1 } });
  const { doc, count } = mergeDocs(local, incoming);
  assert.equal(doc.settings.theme, 'dark');
  assert.deepEqual(doc.settings.home, { name: 'Roma', lat: 41.9, lon: 12.5 });
  assert.equal('extra' in doc.settings, false);
  assert.equal(doc.settings.lastBackup, 500);
  assert.equal(count, 0); // lastBackup does not count

  const back = mergeDocs(
    docWith({ settings: { theme: 'dark', lastBackup: 900 } }),
    docWith({ settings: { theme: 'light', lastBackup: 500 } }),
  );
  assert.equal(back.doc.settings.lastBackup, 900);
  assert.equal(back.doc.settings.theme, 'dark');
});

test('mergeDocs: missing lastBackup counts as 0', () => {
  const a = mergeDocs(docWith({ settings: { theme: 'auto' } }), docWith({ settings: { lastBackup: 7 } }));
  assert.equal(a.doc.settings.lastBackup, 7);
  const b = mergeDocs(docWith({ settings: { lastBackup: 7 } }), docWith({ settings: {} }));
  assert.equal(b.doc.settings.lastBackup, 7);
  const c = mergeDocs(docWith({ settings: {} }), docWith({ settings: {} }));
  assert.equal(c.doc.settings.lastBackup, 0);
});

// ---- mergeDocs: result shape -------------------------------------------

test('mergeDocs: count sums items taken from incoming across all collections', () => {
  const local = docWith({
    places: [place('l_a', 1)],
    trips: [trip('v_a', 5)],
    marks: { 'c:PT': { s: 'visited', t: 5 } },
  });
  const incoming = docWith({
    places: [place('l_a', 2), place('l_b', 1)],  // newer + new → 2
    trips: [trip('v_a', 1)],                     // older → 0
    marks: { 'c:PT': { s: null, t: 1 }, 'c:FR': { s: 'visited', t: 1 } }, // older + new → 1
    settings: { lastBackup: 1000 },              // not counted
  });
  const r = mergeDocs(local, incoming);
  assert.equal(r.count, 3);
  assert.deepEqual(Object.keys(r).sort(), ['count', 'doc']);
});

test('mergeDocs: merging identical documents changes nothing and counts 0', () => {
  const d = docWith({
    places: [place('l_a', 1)], trips: [trip('v_a', 2)],
    marks: { 'c:PT': { s: 'visited', t: 1 } },
    settings: { theme: 'auto', lastBackup: 4 },
  });
  const r = mergeDocs(d, structuredClone(d));
  assert.equal(r.count, 0);
  assert.deepEqual(r.doc, d);
});

test('mergeDocs: result is a valid version-1 document', () => {
  const r = mergeDocs(
    docWith({ places: [place('l_a', 1)] }),
    docWith({ places: [place('l_b', 1)], marks: { 'c:PT': { s: 'visited', t: 1 } } }),
  );
  assert.equal(r.doc.version, 1);
  assert.equal(validateDoc(r.doc), true);
});

// ---- mergeDocs: purity ---------------------------------------------------

test('mergeDocs: does not mutate the inputs (deep-frozen inputs do not throw)', () => {
  const local = deepFreeze(docWith({
    places: [place('l_a', 1, { name: 'L', note: 'x' })],
    trips: [trip('v_a', 5)],
    marks: { 'c:PT': { s: 'visited', t: 1 } },
    settings: { theme: 'dark', lastBackup: 1 },
  }));
  const incoming = deepFreeze(docWith({
    places: [place('l_a', 2, { name: 'I', note: 'y' }), place('l_b', 1)],
    trips: [trip('v_b', 1)],
    marks: { 'c:PT': { s: null, t: 2 } },
    settings: { theme: 'light', lastBackup: 9 },
  }));
  const snapLocal = structuredClone(local);
  const snapIncoming = structuredClone(incoming);
  const r = mergeDocs(local, incoming);
  assert.deepEqual(local, snapLocal);
  assert.deepEqual(incoming, snapIncoming);
  assert.equal(r.doc.places[0].name, 'I');
});

test('mergeDocs: result shares no references with the inputs', () => {
  const local = docWith({ places: [place('l_a', 1, { note: 'x' })], settings: { home: { name: 'Roma' }, lastBackup: 0 } });
  const incoming = docWith({ places: [place('l_a', 2, { stops: ['y'] }), place('l_b', 1, { stops: ['z'] })], marks: { m: { s: 'visited', t: 1 } } });
  const { doc } = mergeDocs(local, incoming);
  doc.places[0].stops.push('mutated');
  doc.places[1].stops.push('mutated');
  doc.settings.home.name = 'mutated';
  doc.marks.m.s = 'mutated';
  assert.deepEqual(incoming.places[0].stops, ['y']);
  assert.deepEqual(incoming.places[1].stops, ['z']);
  assert.deepEqual(incoming.marks.m, { s: 'visited', t: 1 });
  assert.equal(local.settings.home.name, 'Roma');
  assert.equal(local.places[0].note, 'x');
});
