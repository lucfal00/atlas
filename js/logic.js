// Pure logic: dates, place/trip/area states, map counters.
// No DOM, no network, no storage. Dates are local 'YYYY-MM-DD' keys (string order = date order).

const pad = (n) => String(n).padStart(2, '0');

const RANK = { wish: 1, visited: 2 };

// ---- Dates -------------------------------------------------------------

export function toKey(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export const todayKey = (now = new Date()) => toKey(now);

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

/** True for a 'YYYY-MM' month key. */
export const isMonth = (v) => typeof v === 'string' && MONTH.test(v);

/**
 * Month range of a place: { from, to } ('YYYY-MM'); empty `to` = `from`. Null if `from` is missing / invalid,
 * `to` is invalid, or `to` < `from`. Empty `from` and `to` → { from: null, to: null }.
 */
export function monthRange(from, to) {
  const f = from || null, t = to || null;
  if (!f) return t ? null : { from: null, to: null };
  if (!isMonth(f) || (t && !isMonth(t)) || (t && t < f)) return null;
  return { from: f, to: t || f };
}

/** Score categories of a visited place (1–5 stars each, higher = better value). */
export const SCORES = [
  { key: 'cibo', label: 'Cibo' }, { key: 'cultura', label: 'Cultura' }, { key: 'paesaggio', label: 'Paesaggio' },
  { key: 'atmosfera', label: 'Atmosfera' }, { key: 'prezzi', label: 'Prezzi' },
];

/** Only valid keys with integer values 1–5; null if none is left. */
export function cleanScores(s) {
  if (!s || typeof s !== 'object' || Array.isArray(s)) return null;
  const out = {};
  for (const { key } of SCORES) if (Number.isInteger(s[key]) && s[key] >= 1 && s[key] <= 5) out[key] = s[key];
  return Object.keys(out).length ? out : null;
}

// ---- Document ----------------------------------------------------------

/** Prefix + 6 random base36 chars: 'l_ab12cd'. */
export function newId(prefix) {
  const b = globalThis.crypto.getRandomValues(new Uint8Array(6));
  return `${prefix}_${Array.from(b, (x) => (x % 36).toString(36)).join('')}`;
}

export function emptyDoc() {
  return {
    version: 1, places: [], trips: [], marks: {},
    settings: { theme: 'auto', home: { name: 'Napoli', lat: 40.85, lon: 14.27 }, lastBackup: 0 },
  };
}

const live = (list) => (list || []).filter((x) => !x.deleted);

/** Lower-case, accent-free form of a string for searching ('Forlì' → 'forli'). */
export const fold = (s) => String(s ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

// ---- States ------------------------------------------------------------

/** Ids of the places in a live trip that has started (past or ongoing). */
function tripVisited(doc, today) {
  const ids = new Set();
  for (const t of live(doc.trips)) {
    if (t.from <= today) for (const s of t.stops || []) ids.add(s.place);
  }
  return ids;
}

const stateOf = (place, visitedIds) => (place.status === 'visited' || visitedIds.has(place.id) ? 'visited' : 'wish');

/** 'visited' | 'wish': visited by its own status or by a stop of a trip that has started. */
export const placeState = (doc, place, today) => stateOf(place, tripVisited(doc, today));

/** 'current' | 'planned' | 'past'. */
export function tripState(trip, today) {
  if (trip.from > today) return 'planned';
  return trip.to < today ? 'past' : 'current';
}

/** Map 'c:IT' | 'r:Campania' → best state ('wish' | 'visited'); absent = never. */
export function areaStates(doc, today) {
  const m = new Map();
  const up = (key, s) => {
    if (RANK[s] > (RANK[m.get(key)] || 0)) m.set(key, s);
  };
  const ids = tripVisited(doc, today);
  for (const p of live(doc.places)) {
    const s = stateOf(p, ids);
    if (p.country) up(`c:${p.country}`, s);
    if (p.region) up(`r:${p.region}`, s);
  }
  for (const [key, mark] of Object.entries(doc.marks || {})) {
    if (mark?.s === 'visited' && /^[cr]:/.test(key)) up(key, 'visited');
  }
  for (const [key, s] of m) {
    if (s === 'visited' && key.startsWith('r:')) {
      up('c:IT', 'visited');
      break;
    }
  }
  return m;
}

/** { countries, regions, places } visited, for the numbers on the map. */
export function visitedCounts(doc, today) {
  let countries = 0, regions = 0;
  for (const [key, s] of areaStates(doc, today)) {
    if (s !== 'visited') continue;
    if (key.startsWith('c:')) countries++;
    else regions++;
  }
  const ids = tripVisited(doc, today);
  return { countries, regions, places: live(doc.places).filter((p) => stateOf(p, ids) === 'visited').length };
}
