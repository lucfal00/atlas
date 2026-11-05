// Pure logic: dates, place/trip/area states, travel statistics, year in travel.
// No DOM, no network, no storage. Dates are local 'YYYY-MM-DD' keys (string order = date order).

import { haversine } from './geo.js';

const pad = (n) => String(n).padStart(2, '0');

export const COST_CATS = ['trasporti', 'alloggio', 'cibo', 'attivita', 'altro'];

const RANK = { wish: 1, planned: 2, visited: 3 };

// ---- Dates -------------------------------------------------------------

export function toKey(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function fromKey(key) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d);
}

export const todayKey = (now = new Date()) => toKey(now);

export function addDays(key, n) {
  const d = fromKey(key);
  d.setDate(d.getDate() + n);
  return toKey(d);
}

/** Whole days from a to b (b − a); rounding absorbs the 23/25 h DST days. */
export const diffDays = (a, b) => Math.round((fromKey(b) - fromKey(a)) / 864e5);

function* days(from, to) {
  for (let k = from; k <= to; k = addDays(k, 1)) yield k;
}

// ---- Document ----------------------------------------------------------

/** Prefix + 6 random base36 chars: 'l_ab12cd'. */
export function newId(prefix) {
  const b = globalThis.crypto.getRandomValues(new Uint8Array(6));
  return `${prefix}_${Array.from(b, (x) => (x % 36).toString(36)).join('')}`;
}

export function emptyDoc() {
  return {
    version: 1, places: [], trips: [], diary: {}, marks: {},
    settings: { theme: 'auto', home: { name: 'Napoli', lat: 40.85, lon: 14.27 }, lastBackup: 0 },
  };
}

const num = (v) => typeof v === 'number' && Number.isFinite(v);
const live = (list) => (list || []).filter((x) => !x.deleted);
const byFrom = (a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0);
const r2 = (x) => Math.round(x * 100) / 100; // cents

/** Date of a stop: its own, else the trip's. */
const stopDate = (s, trip) => s.from ?? trip.from;

/** placeId → stop dates, over live trips (callers only look up live places). */
function stopMap(doc) {
  const m = new Map();
  for (const t of live(doc.trips)) {
    for (const s of t.stops || []) {
      if (!m.has(s.place)) m.set(s.place, []);
      m.get(s.place).push(stopDate(s, t));
    }
  }
  return m;
}

/** Lower-case, accent-free form of a string for searching ('Forlì' → 'forli'). */
export const fold = (s) => String(s ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

// ---- States ------------------------------------------------------------

function stateOf(place, stops, today) {
  if (place.status === 'visited' || place.visits?.length || stops.some((d) => d <= today)) return 'visited';
  return stops.length ? 'planned' : 'wish';
}

/** 'visited' | 'planned' | 'wish' (spec 6.1). */
export const placeState = (doc, place, today) => stateOf(place, stopMap(doc).get(place.id) || [], today);

/** 'current' | 'planned' | 'past' (spec 6.2). */
export function tripState(trip, today) {
  if (trip.from > today) return 'planned';
  return trip.to < today ? 'past' : 'current';
}

export const nights = (trip) => diffDays(trip.from, trip.to);

/**
 * Map 'c:IT' | 'r:Campania' | 'p:Napoli' → best state (spec 6.3); absent = never.
 * regionOf(provinceName) → regionName | null lets a visited province mark light up its region.
 */
export function areaStates(doc, today, regionOf) {
  const m = new Map();
  const up = (key, s) => {
    if (RANK[s] > (RANK[m.get(key)] || 0)) m.set(key, s);
  };
  const stops = stopMap(doc);
  for (const p of live(doc.places)) {
    const s = stateOf(p, stops.get(p.id) || [], today);
    if (p.country) up(`c:${p.country}`, s);
    if (p.region) up(`r:${p.region}`, s);
    if (p.province) up(`p:${p.province}`, s);
  }
  for (const [key, mark] of Object.entries(doc.marks || {})) {
    if (mark?.s !== 'visited') continue;
    up(key, 'visited');
    const region = key.startsWith('p:') && regionOf ? regionOf(key.slice(2)) : null;
    if (region) up(`r:${region}`, 'visited');
  }
  for (const [key, s] of m) {
    if (s === 'visited' && (key.startsWith('r:') || key.startsWith('p:'))) {
      up('c:IT', 'visited');
      break;
    }
  }
  return m;
}

// ---- Statistics --------------------------------------------------------

/** Every local day (≤ today) covered by a trip that has started, from..to inclusive. */
function travelSet(doc, today) {
  const set = new Set();
  for (const t of live(doc.trips)) {
    if (t.from > today) continue;
    for (const k of days(t.from, t.to < today ? t.to : today)) set.add(k);
  }
  return set;
}

export function travelDays(doc, year, today) {
  let n = 0;
  for (const k of travelSet(doc, today)) if (k.startsWith(`${year}-`)) n++;
  return n;
}

/** { [year]: n } over started trips, by year of `from`. */
export function tripsByYear(doc, today) {
  const out = {};
  for (const t of live(doc.trips)) {
    if (t.from > today) continue;
    const y = t.from.slice(0, 4);
    out[y] = (out[y] || 0) + 1;
  }
  return out;
}

/** Km home → stop 1 → … → stop n → home; places missing, deleted or without coordinates are skipped. */
export function tripKm(doc, trip) {
  const home = doc.settings?.home;
  if (!home || !num(home.lat) || !num(home.lon)) return 0;
  const byId = new Map(live(doc.places).map((p) => [p.id, p]));
  const pts = [home];
  for (const s of trip.stops || []) {
    const p = byId.get(s.place);
    if (p && num(p.lat) && num(p.lon)) pts.push(p);
  }
  if (pts.length === 1) return 0;
  pts.push(home);
  let km = 0;
  for (let i = 1; i < pts.length; i++) km += haversine(pts[i - 1].lat, pts[i - 1].lon, pts[i].lat, pts[i].lon);
  return km;
}

export function yearKm(doc, year, today) {
  let km = 0;
  for (const t of live(doc.trips)) {
    if (t.from <= today && t.from.startsWith(`${year}-`)) km += tripKm(doc, t);
  }
  return km;
}

/** { total, byCat, delta (spent − budget), perNight }; unknown categories count as 'altro'. */
export function tripSpend(trip) {
  const byCat = Object.fromEntries(COST_CATS.map((c) => [c, 0]));
  for (const c of trip.costs || []) {
    byCat[c.cat in byCat ? c.cat : 'altro'] += Number(c.amount) || 0;
  }
  const delta = {};
  let total = 0;
  for (const c of COST_CATS) {
    byCat[c] = r2(byCat[c]);
    delta[c] = r2(byCat[c] - (trip.budget?.[c] || 0));
    total += byCat[c];
  }
  total = r2(total);
  const n = nights(trip);
  return { total, byCat, delta, perNight: n > 0 ? total / n : total };
}

/** Live places that count as visited and have coordinates. */
function visitedPlaces(doc, today) {
  const stops = stopMap(doc);
  return live(doc.places).filter(
    (p) => num(p.lat) && num(p.lon) && stateOf(p, stops.get(p.id) || [], today) === 'visited',
  );
}

/** Visited place farthest from home: { place, km } | null. */
export function farthest(doc, today) {
  const h = doc.settings?.home;
  if (!h) return null;
  let best = null;
  for (const place of visitedPlaces(doc, today)) {
    const km = haversine(h.lat, h.lon, place.lat, place.lon);
    if (!best || km > best.km) best = { place, km };
  }
  return best;
}

/** Visited places at the north / south / east / west extremes, or null when none. */
export function extremes(doc, today) {
  const v = visitedPlaces(doc, today);
  if (!v.length) return null;
  const pick = (key, sign) => v.reduce((a, b) => (sign * b[key] > sign * a[key] ? b : a));
  return { north: pick('lat', 1), south: pick('lat', -1), east: pick('lon', 1), west: pick('lon', -1) };
}

/** Month 1..12 with the most travel days over all years (ties → earliest), or null. */
export function favoriteMonth(doc, today) {
  const count = new Array(13).fill(0);
  for (const k of travelSet(doc, today)) count[+k.slice(5, 7)]++;
  let best = 0;
  for (let m = 1; m <= 12; m++) if (count[m] > count[best]) best = m;
  return best || null;
}

/** { [continent]: sorted country codes } for visited countries; continentOf(code) falsy → 'Altro'. */
export function countriesByContinent(doc, today, continentOf) {
  const codes = [];
  for (const [key, s] of areaStates(doc, today)) {
    if (s === 'visited' && key.startsWith('c:')) codes.push(key.slice(2));
  }
  const out = {};
  for (const code of codes.sort()) (out[continentOf(code) || 'Altro'] ||= []).push(code);
  return out;
}

// ---- Year in travel ----------------------------------------------------

/** Dated visits (visit dates + stop dates), not after `today` when given. */
function visitDates(place, stops, today) {
  return [...(place.visits || []), ...stops].filter((d) => !today || d <= today);
}

/** country → earliest dated visit over live places. */
function firstDates(doc, today) {
  const stops = stopMap(doc);
  const m = new Map();
  for (const p of live(doc.places)) {
    if (!p.country) continue;
    for (const d of visitDates(p, stops.get(p.id) || [], today)) {
      if (!m.has(p.country) || d < m.get(p.country)) m.set(p.country, d);
    }
  }
  return m;
}

/** Earliest dated visit of a country, or null (mark-only and undated countries have none). */
export const firstVisit = (doc, countryCode, today) => firstDates(doc, today).get(countryCode) ?? null;

export function yearInTravel(doc, year, today) {
  const inYear = (key) => key.startsWith(`${year}-`);
  const trips = live(doc.trips).filter((t) => t.from <= today && inYear(t.from)).sort(byFrom);
  const spend = trips.reduce((sum, t) => sum + tripSpend(t).total, 0);

  const newCountries = [...firstDates(doc, today)].filter(([, d]) => inYear(d)).map(([c]) => c).sort();

  const stops = stopMap(doc);
  const countries = new Set();
  let bestPlace = null;
  for (const p of live(doc.places)) {
    if (!visitDates(p, stops.get(p.id) || [], today).some(inYear)) continue;
    if (p.country) countries.add(p.country);
    if (num(p.rating) && (!bestPlace || p.rating > bestPlace.rating)) bestPlace = p;
  }

  return {
    trips, days: travelDays(doc, year, today), km: yearKm(doc, year, today), spend,
    newCountries, bestPlace, countries: [...countries].sort(),
  };
}
