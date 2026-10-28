// Nominatim (OpenStreetMap) forward and reverse search, spec §8.4. Only the query text or coordinates leave the device.
// Called only on an explicit tap on "Cerca"; at most one request per second across both functions.

const BASE = 'https://nominatim.openstreetmap.org';
const GAP = 1000;                                 // ms between requests

let nextAt = 0;                                   // earliest start of the next request

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** GET → parsed JSON. No network → Error('offline'); bad answer → Error('search'). */
async function request(path) {
  if (navigator.onLine === false) throw new Error('offline');
  const start = Math.max(Date.now(), nextAt);     // reserve the slot now so concurrent calls queue up
  nextAt = start + GAP;
  if (start > Date.now()) await sleep(start - Date.now());
  let res;
  try {
    res = await fetch(`${BASE}/${path}`);
  } catch {
    throw new Error('offline');
  }
  if (!res.ok) throw new Error('search');
  try {
    return await res.json();
  } catch {
    throw new Error('search');
  }
}

const first = (s) => String(s ?? '').split(',')[0].trim();

/** Free text → [{ name, label, lat, lon, type }] (up to 8, Italian names). */
export async function searchPlaces(q) {
  const data = await request(`search?format=jsonv2&q=${encodeURIComponent(q)}&accept-language=it&limit=8`);
  if (!Array.isArray(data)) throw new Error('search');
  return data
    .map((r) => ({
      name: String(r.name || first(r.display_name)),
      label: String(r.display_name ?? ''),
      lat: Number(r.lat),
      lon: Number(r.lon),
      type: String(r.type ?? ''),
    }))
    .filter((r) => r.name && Number.isFinite(r.lat) && Number.isFinite(r.lon));
}

/** Coordinates → short place name, or null when nothing is known there. */
export async function reversePlace(lat, lon) {
  const r = await request(`reverse?format=jsonv2&lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lon)}&accept-language=it&zoom=14`);
  if (!r || typeof r !== 'object' || r.error) return null;
  const a = r.address ?? {};
  const name = r.name || a.city || a.town || a.village || a.hamlet || a.suburb || a.municipality || first(r.display_name);
  return name ? String(name) : null;
}
