// Pure document validation and last-writer-wins merge (sync and backup import).
// No DOM, no network, no storage.

const isObj = (o) => !!o && typeof o === 'object' && !Array.isArray(o);
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isStr = (v) => typeof v === 'string';
const isDay = (v) => isStr(v) && /^\d{4}-\d{2}-\d{2}$/.test(v);
const optArr = (v) => v === undefined || Array.isArray(v);
const optNum = (v) => v === undefined || v === null || isNum(v);

/** Timestamp of a record: `field` as a finite number, otherwise 0. */
const stamp = (o, field) => (Number.isFinite(o?.[field]) ? o[field] : 0);

/** A place that screens can render without throwing. */
function validPlace(p) {
  return isObj(p) && isStr(p.id) && isStr(p.name)
    && optNum(p.lat) && optNum(p.lon) && optNum(p.budget)
    && (p.rating == null || (Number.isInteger(p.rating) && p.rating >= 1 && p.rating <= 5))
    && ['tags', 'with', 'todo', 'links', 'months', 'visits'].every((k) => optArr(p[k]))
    && (p.todo || []).every(isObj)
    && (p.visits || []).every(isDay);
}

/** A trip with valid dates and well-formed stops / costs. */
function validTrip(t) {
  return isObj(t) && isStr(t.id) && isStr(t.title)
    && isDay(t.from) && isDay(t.to) && t.from <= t.to
    && ['with', 'links'].every((k) => optArr(t[k]))
    && optArr(t.stops) && (t.stops || []).every((s) => isObj(s) && isStr(s.place)
      && (s.from === undefined || isDay(s.from)) && (s.to === undefined || isDay(s.to)))
    && optArr(t.costs) && (t.costs || []).every((c) => isObj(c) && isNum(c.amount))
    && (t.budget === undefined || isObj(t.budget));
}

const validDiary = (e) => isObj(e) && (e.text === undefined || isStr(e.text)) && optArr(e.places);
const validMark = (e) => isObj(e) && (e.s === null || e.s === undefined || isStr(e.s));

const allValid = (o, fn) => Object.values(o).every(fn);

export function validateDoc(d) {
  return isObj(d) && d.version === 1
    && Array.isArray(d.places) && d.places.every(validPlace)
    && Array.isArray(d.trips) && d.trips.every(validTrip)
    && isObj(d.diary) && allValid(d.diary, validDiary)
    && isObj(d.marks) && allValid(d.marks, validMark)
    && isObj(d.settings);
}

/**
 * Lenient import: drop single malformed places / trips / diary pages / marks instead of rejecting the whole document.
 * → { doc, dropped } (a clean copy), or null if the document has the wrong overall shape.
 */
export function sanitizeDoc(d) {
  if (!isObj(d) || d.version !== 1 || !Array.isArray(d.places) || !Array.isArray(d.trips)
    || !isObj(d.diary) || !isObj(d.marks) || !isObj(d.settings)) return null;
  let dropped = 0;
  const keep = (list, ok) => list.filter((x) => (ok(x) ? true : (dropped++, false)));
  const keepMap = (m, ok) => Object.fromEntries(Object.entries(m).filter(([, v]) => (ok(v) ? true : (dropped++, false))));
  const doc = {
    ...d,
    places: keep(d.places, validPlace),
    trips: keep(d.trips, validTrip),
    diary: keepMap(d.diary, validDiary),
    marks: keepMap(d.marks, validMark),
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
  for (const key of ['diary', 'marks']) {
    const r = mergeByKey(doc[key], inc[key]);
    doc[key] = r.map;
    count += r.count;
  }
  doc.settings.lastBackup = Math.max(stamp(doc.settings, 'lastBackup'), stamp(inc.settings, 'lastBackup'));
  return { doc, count };
}
