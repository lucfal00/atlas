// Pure document validation and last-writer-wins merge (sync and backup import).
// No DOM, no network, no storage.

import { isMonth, cleanScores, SCORES } from './logic.js';

const isObj = (o) => !!o && typeof o === 'object' && !Array.isArray(o);
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isStr = (v) => typeof v === 'string';
const isDay = (v) => isStr(v) && /^\d{4}-\d{2}-\d{2}$/.test(v);
const optNum = (v) => v === undefined || v === null || isNum(v);

/** Timestamp of a record: `field` as a finite number, otherwise 0. */
const stamp = (o, field) => (Number.isFinite(o?.[field]) ? o[field] : 0);

// Unknown fields (old documents: rating, tags, costs, diary…) are ignored here and dropped by sanitizeDoc.

/** A place that screens can render without throwing. */
const optMonth = (v) => v === undefined || v === null || isMonth(v);
const validScores = (s) => s === undefined || s === null || (isObj(s) && Object.entries(s).every(([k, v]) => SCORES.some((x) => x.key === k) && Number.isInteger(v) && v >= 1 && v <= 5));
const basePlace = (p) => isObj(p) && isStr(p.id) && isStr(p.name) && optNum(p.lat) && optNum(p.lon);
/** Strict form (validateDoc): the new fields must also be well-formed; sanitizeDoc repairs them instead. */
const validPlace = (p) => basePlace(p)
  && optMonth(p.from) && optMonth(p.to) && !(p.from && p.to && p.to < p.from)
  && (p.partner === undefined || typeof p.partner === 'boolean') && validScores(p.scores);

/** A trip with valid dates and well-formed stops. */
function validTrip(t) {
  return isObj(t) && isStr(t.id) && isStr(t.title) && isDay(t.from) && isDay(t.to) && t.from <= t.to
    && (t.stops === undefined || (Array.isArray(t.stops) && t.stops.every((s) => isObj(s) && isStr(s.place))))
    && optNum(t.spend);
}

const validMark = (e) => isObj(e) && (e.s === null || e.s === undefined || isStr(e.s));

export function validateDoc(d) {
  return isObj(d) && d.version === 1
    && Array.isArray(d.places) && d.places.every(validPlace)
    && Array.isArray(d.trips) && d.trips.every(validTrip)
    && isObj(d.marks) && Object.values(d.marks).every(validMark)
    && isObj(d.settings);
}

const PLACE_KEYS = ['id', 'name', 'cat', 'status', 'from', 'to', 'partner', 'scores', 'note', 'lat', 'lon', 'country', 'region', 'deleted', 'updatedAt'];
const TRIP_KEYS = ['id', 'title', 'from', 'to', 'stops', 'note', 'spend', 'deleted', 'updatedAt'];
const pick = (o, keys) => Object.fromEntries(keys.filter((k) => o[k] !== undefined).map((k) => [k, o[k]]));

/** Known fields only; the old model maps over: planned → wish, last visit → date, costs → spend. */
function cleanPlace(p) {
  const c = pick(p, PLACE_KEYS);
  if (c.status !== 'visited') c.status = 'wish';
  // Old model: a day (or the last visit) becomes a month range; invalid values are dropped.
  const old = isDay(p.date) ? p.date : Array.isArray(p.visits) ? p.visits.filter(isDay).sort().pop() : undefined;
  if (!isMonth(c.from)) c.from = old ? old.slice(0, 7) : null;
  c.to = c.from ? (isMonth(c.to) && c.to >= c.from ? c.to : c.from) : null;
  c.partner = c.partner === true;
  const sc = cleanScores(c.scores);
  if (sc) c.scores = sc;
  else delete c.scores;
  return c;
}

function cleanTrip(t) {
  const c = pick(t, TRIP_KEYS);
  c.stops = (t.stops || []).map((s) => ({ place: s.place }));
  if (!isNum(c.spend)) {
    const sum = Array.isArray(t.costs) ? t.costs.reduce((a, x) => a + (isNum(x?.amount) ? x.amount : 0), 0) : 0;
    c.spend = sum > 0 ? Math.round(sum * 100) / 100 : null;
  }
  return c;
}

/**
 * Lenient import: drop single malformed places / trips / marks instead of rejecting the whole document, and
 * drop fields of the old model. → { doc, dropped } (a clean copy), or null if the overall shape is wrong.
 */
export function sanitizeDoc(d) {
  if (!isObj(d) || d.version !== 1 || !Array.isArray(d.places) || !Array.isArray(d.trips)
    || !isObj(d.marks) || !isObj(d.settings)) return null;
  let dropped = 0;
  const keep = (list, ok, clean) => list.filter((x) => (ok(x) ? true : (dropped++, false))).map(clean);
  const doc = {
    version: 1,
    places: keep(d.places, basePlace, cleanPlace),
    trips: keep(d.trips, validTrip, cleanTrip),
    marks: Object.fromEntries(Object.entries(d.marks).filter(([, v]) => (validMark(v) ? true : (dropped++, false)))),
    settings: d.settings,
  };
  return { doc, dropped };
}

/** Union by id; the greater updatedAt wins, a tie keeps local. Local order, then incoming-only items. */
function mergeById(local, incoming) {
  const out = [...local];
  const index = new Map(out.map((x, i) => [x.id, i]));
  const taken = new Set();
  for (const x of incoming) {
    const i = index.get(x.id);
    if (i === undefined) {
      index.set(x.id, out.length);
      taken.add(out.length);
      out.push(x);
    } else if (stamp(x, 'updatedAt') > stamp(out[i], 'updatedAt')) {
      out[i] = x;
      taken.add(i);
    }
  }
  return { list: out, count: taken.size };
}

/** Union by key; the greater t wins, a tie keeps local. */
function mergeByKey(local, incoming) {
  const out = new Map(Object.entries(local));
  let count = 0;
  for (const [k, v] of Object.entries(incoming)) {
    if (!out.has(k) || stamp(v, 't') > stamp(out.get(k), 't')) {
      out.set(k, v);
      count++;
    }
  }
  return { map: Object.fromEntries(out), count };
}

/** Merge incoming into a copy of local (newest wins). `count` = elements taken from incoming. */
export function mergeDocs(local, incoming) {
  if (!validateDoc(local) || !validateDoc(incoming)) throw new Error('Documento non valido');
  const doc = structuredClone(local);
  const inc = structuredClone(incoming);
  let count = 0;
  for (const key of ['places', 'trips']) {
    const r = mergeById(doc[key], inc[key]);
    doc[key] = r.list;
    count += r.count;
  }
  const r = mergeByKey(doc.marks, inc.marks);
  doc.marks = r.map;
  count += r.count;
  doc.settings.lastBackup = Math.max(stamp(doc.settings, 'lastBackup'), stamp(inc.settings, 'lastBackup'));
  return { doc, count };
}
