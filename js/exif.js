// Pure EXIF reader for JPEG: capture date (local time) and GPS position.
// No DOM, no network, no storage. Never throws: whatever cannot be read comes back null.

const SOI = 0xffd8;
const TYPE_ASCII = 2;
const TYPE_LONG = 4;
const TYPE_RATIONAL = 5;
const MAX_ENTRIES = 1024; // sanity cap on IFD entry count
const TYPE_SIZE = [0, 1, 1, 2, 4, 8, 1, 1, 2, 4, 8, 4, 8]; // bytes per value, by TIFF type

const safe = (fn) => {
  try { return fn(); } catch { return null; }
};

/** ArrayBuffer | ArrayBufferView → DataView, or null. */
function toView(input) {
  if (ArrayBuffer.isView(input)) return new DataView(input.buffer, input.byteOffset, input.byteLength);
  return safe(() => new DataView(input));
}

/** Walks JPEG markers from SOI to the APP1 "Exif\0\0" segment → { start, end } of the TIFF block, or null. */
function findTiff(dv) {
  const len = dv.byteLength;
  if (len < 4 || dv.getUint16(0) !== SOI) return null;
  let p = 2;
  while (p + 4 <= len) {
    if (dv.getUint8(p) !== 0xff) return null; // lost sync
    const m = dv.getUint8(p + 1);
    if (m === 0xff) { p++; continue; } // fill byte
    if (m === 0xd9 || m === 0xda) return null; // EOI / SOS: no metadata beyond
    if (m === 0x01 || (m >= 0xd0 && m <= 0xd8)) { p += 2; continue; } // standalone markers
    const size = dv.getUint16(p + 2);
    if (size < 2) return null;
    if (m === 0xe1 && size >= 8 && p + 10 <= len
      && dv.getUint32(p + 4) === 0x45786966 && dv.getUint16(p + 8) === 0) { // "Exif\0\0"
      return { start: p + 10, end: Math.min(p + 2 + size, len) };
    }
    p += 2 + size;
  }
  return null;
}

/** Bounds-checked TIFF reader; offsets are relative to the TIFF header. */
function tiffReader(dv, { start, end }) {
  const size = end - start;
  if (size < 8) return null;
  const b0 = dv.getUint8(start);
  const b1 = dv.getUint8(start + 1);
  const le = b0 === 0x49 && b1 === 0x49 ? true : b0 === 0x4d && b1 === 0x4d ? false : null;
  if (le === null) return null;
  const fits = (o, n) => Number.isInteger(o) && o >= 0 && o + n <= size;
  const r = {
    size,
    u8: (o) => (fits(o, 1) ? dv.getUint8(start + o) : null),
    u16: (o) => (fits(o, 2) ? dv.getUint16(start + o, le) : null),
    u32: (o) => (fits(o, 4) ? dv.getUint32(start + o, le) : null),
    fits,
  };
  if (r.u16(2) !== 0x2a) return null;
  return r;
}

/** IFD at `off` → Map(tag → { type, count, at }); `at` = offset of the value bytes. */
function readIfd(r, off) {
  const tags = new Map();
  const n = r.u16(off);
  if (n === null) return tags;
  for (let i = 0; i < Math.min(n, MAX_ENTRIES); i++) {
    const e = off + 2 + 12 * i;
    const tag = r.u16(e), type = r.u16(e + 2), count = r.u32(e + 4);
    if (tag === null || type === null || count === null) break;
    const bytes = (TYPE_SIZE[type] ?? 1) * count;
    const at = bytes <= 4 ? e + 8 : r.u32(e + 8);
    if (at === null || tags.has(tag)) continue;
    tags.set(tag, { type, count, at });
  }
  return tags;
}

/** Sub-IFD referenced by a LONG pointer tag. */
function subIfd(r, ifd, tag) {
  const e = ifd.get(tag);
  if (!e || e.type !== TYPE_LONG || e.count !== 1) return null;
  const off = r.u32(e.at);
  return off === null ? null : readIfd(r, off);
}

function ascii(r, e) {
  if (!e || e.type !== TYPE_ASCII || !r.fits(e.at, e.count)) return null;
  let s = '';
  for (let i = 0; i < e.count; i++) {
    const c = r.u8(e.at + i);
    if (c === 0) break;
    s += String.fromCharCode(c);
  }
  return s;
}

/** "YYYY:MM:DD HH:MM:SS" → local-time epoch ms, or null (zeroed, blank or impossible dates). */
function parseDate(s) {
  const m = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(s ?? '');
  if (!m) return null;
  const [y, mo, d, h, mi, sec] = m.slice(1).map(Number);
  if (y < 1900 || h > 23 || mi > 59 || sec > 59) return null;
  const t = new Date(y, mo - 1, d, h, mi, sec);
  if (t.getFullYear() !== y || t.getMonth() !== mo - 1 || t.getDate() !== d) return null;
  const ms = t.getTime();
  return Number.isFinite(ms) ? ms : null;
}

/** DateTimeOriginal (0x9003); DateTime (0x0132) only when 0x9003 is absent. */
function readTaken(r, ifd0) {
  const exif = subIfd(r, ifd0, 0x8769);
  const orig = exif?.get(0x9003);
  return parseDate(ascii(r, orig ?? ifd0.get(0x0132)));
}

/** GPS coordinate: 3 rationals (deg, min, sec) → decimal degrees, or null. */
function dms(r, e) {
  if (!e || e.type !== TYPE_RATIONAL || e.count < 3 || !r.fits(e.at, 24)) return null;
  const v = [];
  for (let i = 0; i < 3; i++) {
    const num = r.u32(e.at + 8 * i), den = r.u32(e.at + 8 * i + 4);
    if (num === null || !den) return null; // den 0 → invalid
    v.push(num / den);
  }
  return v[0] + v[1] / 60 + v[2] / 3600;
}

/** Applies a hemisphere reference: neg/pos letters; anything else → null. */
function signed(value, ref, pos, neg) {
  if (value === null || !Number.isFinite(value)) return null;
  const c = (ref ?? '').charAt(0).toUpperCase();
  return c === pos ? value : c === neg ? -value : null;
}

/** GPS IFD → { lat, lon } with both set or both null. */
function readGps(r, ifd0) {
  const g = subIfd(r, ifd0, 0x8825);
  if (!g) return null;
  const lat = signed(dms(r, g.get(2)), ascii(r, g.get(1)), 'N', 'S');
  const lon = signed(dms(r, g.get(4)), ascii(r, g.get(3)), 'E', 'W');
  if (lat === null || lon === null || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return { lat, lon };
}

/**
 * Reads capture date and GPS from a JPEG (ArrayBuffer or typed array).
 * → { taken: ms (local time) | null, lat: number | null, lon: number | null }
 */
export function readExif(input) {
  const out = { taken: null, lat: null, lon: null };
  safe(() => {
    const dv = toView(input);
    const seg = dv && findTiff(dv);
    const r = seg && tiffReader(dv, seg);
    if (!r) return;
    const ifd0 = readIfd(r, r.u32(4));
    out.taken = safe(() => readTaken(r, ifd0));
    const gps = safe(() => readGps(r, ifd0));
    if (gps) {
      out.lat = gps.lat;
      out.lon = gps.lon;
    }
  });
  return out;
}
