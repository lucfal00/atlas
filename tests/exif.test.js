import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readExif } from '../js/exif.js';

// ---- JPEG builder ------------------------------------------------------

const ascii = (s) => [...s].map((c) => c.charCodeAt(0));

/** TIFF block: IFD0 → ExifIFD (0x9003) and GPS IFD (tags 1–4). Values > 4 bytes go in a data area after each IFD. */
function buildTiff({ le, date, dateTime, gps }) {
  const u16 = (v) => (le ? [v & 255, v >> 8] : [v >> 8, v & 255]);
  const u32 = (v) => {
    const b = [v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255];
    return le ? b : b.reverse();
  };
  const E = (tag, type, count, value) => ({ tag, type, count, value });
  const str = (tag, s) => E(tag, 2, s.length + 1, [...ascii(s), 0]);
  const rats = (tag, triple) => E(tag, 5, 3, triple.flatMap(([n, d]) => [...u32(n), ...u32(d)]));
  const size = (es) => 2 + 12 * es.length + 4
    + es.reduce((a, e) => a + (e.value.length > 4 ? e.value.length + (e.value.length & 1) : 0), 0);
  const ifd = (es, start) => {
    const head = [...u16(es.length)];
    const data = [];
    const dataStart = start + 2 + 12 * es.length + 4;
    for (const e of es) {
      head.push(...u16(e.tag), ...u16(e.type), ...u32(e.count));
      if (e.value.length <= 4) head.push(...e.value, ...Array(4 - e.value.length).fill(0));
      else {
        head.push(...u32(dataStart + data.length));
        data.push(...e.value);
        if (data.length & 1) data.push(0);
      }
    }
    return [...head, ...u32(0), ...data];
  };

  const exifEs = date ? [str(0x9003, date)] : [];
  const gpsEs = [];
  if (gps) {
    if (gps.latRef) gpsEs.push(str(0x0001, gps.latRef));
    if (gps.lat) gpsEs.push(rats(0x0002, gps.lat));
    if (gps.lonRef) gpsEs.push(str(0x0003, gps.lonRef));
    if (gps.lon) gpsEs.push(rats(0x0004, gps.lon));
  }
  const ifd0 = (exifOff, gpsOff) => [
    ...(dateTime ? [str(0x0132, dateTime)] : []),
    ...(exifEs.length ? [E(0x8769, 4, 1, u32(exifOff))] : []),
    ...(gpsEs.length ? [E(0x8825, 4, 1, u32(gpsOff))] : []),
  ];
  const off0 = 8;
  const off1 = off0 + size(ifd0(0, 0));
  const off2 = off1 + (exifEs.length ? size(exifEs) : 0);
  return [
    ...ascii(le ? 'II' : 'MM'), ...u16(42), ...u32(off0),
    ...ifd(ifd0(off1, off2), off0),
    ...(exifEs.length ? ifd(exifEs, off1) : []),
    ...(gpsEs.length ? ifd(gpsEs, off2) : []),
  ];
}

/** SOI [APP0 JFIF] [APP1 XMP] [APP1 Exif] EOI → ArrayBuffer. */
function buildJpeg({ le = true, date, dateTime, gps, app1 = true, jfif = false, xmp = false } = {}) {
  const seg = (marker, payload) => [0xff, marker, (payload.length + 2) >> 8, (payload.length + 2) & 255, ...payload];
  const bytes = [0xff, 0xd8];
  if (jfif) bytes.push(...seg(0xe0, [...ascii('JFIF'), 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]));
  if (xmp) bytes.push(...seg(0xe1, [...ascii('http://ns.adobe.com/xap/1.0/'), 0, ...ascii('<x:xmpmeta/>')]));
  if (app1) bytes.push(...seg(0xe1, [...ascii('Exif'), 0, 0, ...buildTiff({ le, date, dateTime, gps })]));
  bytes.push(0xff, 0xd9);
  return new Uint8Array(bytes).buffer;
}

const DATE = '2026:06:10 14:30:00';
const TAKEN = new Date(2026, 5, 10, 14, 30).getTime();
const GPS_NE = {
  latRef: 'N', lat: [[40, 1], [37, 1], [4080, 100]],
  lonRef: 'E', lon: [[14, 1], [29, 1], [600, 100]],
};
const NONE = { taken: null, lat: null, lon: null };
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg ?? ''} ${a} vs ${b} (±${tol})`);

// ---- Tests -------------------------------------------------------------

test('little-endian: date as local time and N/E position', () => {
  const r = readExif(buildJpeg({ le: true, date: DATE, gps: GPS_NE }));
  assert.equal(r.taken, TAKEN);
  near(r.lat, 40.628, 1e-4, 'lat');
  near(r.lon, 14.485, 1e-4, 'lon');
});

test('big-endian: same values, same result', () => {
  const r = readExif(buildJpeg({ le: false, date: DATE, gps: GPS_NE }));
  assert.equal(r.taken, TAKEN);
  near(r.lat, 40.628, 1e-4, 'lat');
  near(r.lon, 14.485, 1e-4, 'lon');
});

test('S / W references give negative values (both byte orders)', () => {
  for (const le of [true, false]) {
    const r = readExif(buildJpeg({ le, date: DATE, gps: { ...GPS_NE, latRef: 'S', lonRef: 'W' } }));
    near(r.lat, -40.628, 1e-4, 'lat');
    near(r.lon, -14.485, 1e-4, 'lon');
    assert.equal(r.taken, TAKEN);
  }
  const mixed = readExif(buildJpeg({ date: DATE, gps: { ...GPS_NE, latRef: 'S' } }));
  near(mixed.lat, -40.628, 1e-4);
  near(mixed.lon, 14.485, 1e-4);
});

test('no APP1 / no GPS / not a JPEG → missing fields null, no throw', () => {
  assert.deepEqual(readExif(buildJpeg({ app1: false })), NONE);
  assert.deepEqual(readExif(buildJpeg({ app1: false, jfif: true })), NONE);

  const noGps = readExif(buildJpeg({ date: DATE }));
  assert.equal(noGps.taken, TAKEN);
  assert.equal(noGps.lat, null);
  assert.equal(noGps.lon, null);

  const noDate = readExif(buildJpeg({ gps: GPS_NE }));
  assert.equal(noDate.taken, null);
  near(noDate.lat, 40.628, 1e-4);

  assert.deepEqual(readExif(buildJpeg({})), NONE); // Exif segment with an empty IFD0

  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]).buffer;
  assert.deepEqual(readExif(png), NONE);
  assert.deepEqual(readExif(new ArrayBuffer(0)), NONE);
  assert.deepEqual(readExif(new ArrayBuffer(1)), NONE);
  // bare TIFF (not JPEG) is ignored
  assert.deepEqual(readExif(new Uint8Array(buildTiff({ le: true, date: DATE, gps: GPS_NE })).buffer), NONE);
  for (const bad of [null, undefined, 'x', 42, {}, []]) assert.deepEqual(readExif(bad), NONE);
});

test('skips JFIF APP0 and non-Exif APP1 before the Exif segment', () => {
  const r = readExif(buildJpeg({ jfif: true, xmp: true, date: DATE, gps: GPS_NE }));
  assert.equal(r.taken, TAKEN);
  near(r.lat, 40.628, 1e-4);
  near(r.lon, 14.485, 1e-4);
});

test('accepts Uint8Array views, with byte offset', () => {
  const jpeg = buildJpeg({ date: DATE, gps: GPS_NE });
  const padded = new Uint8Array(jpeg.byteLength + 11);
  padded.set(new Uint8Array(jpeg), 7);
  const view = new Uint8Array(padded.buffer, 7, jpeg.byteLength);
  const r = readExif(view);
  assert.equal(r.taken, TAKEN);
  near(r.lat, 40.628, 1e-4);
  assert.deepEqual(readExif(new Uint8Array(jpeg)), readExif(jpeg));
});

test('DateTime (0x0132) is the fallback only when DateTimeOriginal is absent', () => {
  assert.equal(readExif(buildJpeg({ dateTime: '2025:01:02 03:04:05' })).taken, new Date(2025, 0, 2, 3, 4, 5).getTime());
  assert.equal(readExif(buildJpeg({ date: DATE, dateTime: '2025:01:02 03:04:05' })).taken, TAKEN);
});

test('invalid or zeroed dates → taken null, GPS still read', () => {
  for (const date of ['0000:00:00 00:00:00', '    :  :     :  :  ', '2026:02:31 10:00:00', '2026:13:01 10:00:00', '2026:06:10 25:00:00', 'not a date']) {
    const r = readExif(buildJpeg({ date, gps: GPS_NE }));
    assert.equal(r.taken, null, date);
    near(r.lat, 40.628, 1e-4, date);
  }
});

test('GPS: zero denominator, missing part, missing or unknown reference → both null', () => {
  const zeroDen = { ...GPS_NE, lat: [[40, 1], [37, 0], [4080, 100]] };
  const noLon = { latRef: 'N', lat: GPS_NE.lat };
  const noLonRef = { ...GPS_NE, lonRef: undefined };
  const noLatRef = { ...GPS_NE, latRef: undefined };
  const badRef = { ...GPS_NE, latRef: 'X' };
  const tooFar = { ...GPS_NE, lat: [[91, 1], [0, 1], [0, 1]] };
  for (const gps of [zeroDen, noLon, noLonRef, noLatRef, badRef, tooFar]) {
    const r = readExif(buildJpeg({ date: DATE, gps }));
    assert.equal(r.lat, null);
    assert.equal(r.lon, null);
    assert.equal(r.taken, TAKEN);
  }
});

test('truncated buffers never throw; fields are either null or the full values', () => {
  for (const le of [true, false]) {
    const buf = buildJpeg({ le, jfif: true, date: DATE, gps: GPS_NE });
    const full = readExif(buf);
    assert.equal(full.taken, TAKEN);
    for (let n = 0; n <= buf.byteLength; n++) {
      const r = readExif(buf.slice(0, n));
      assert.ok(r.taken === null || r.taken === full.taken, `taken @${n}`);
      assert.ok((r.lat === null) === (r.lon === null), `lat/lon pair @${n}`);
      assert.ok(r.lat === null || r.lat === full.lat, `lat @${n}`);
      assert.ok(r.lon === null || r.lon === full.lon, `lon @${n}`);
    }
  }
});

test('corrupted bytes never throw', () => {
  const buf = new Uint8Array(buildJpeg({ jfif: true, date: DATE, gps: GPS_NE }));
  let seed = 12345;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff);
  for (let i = 0; i < 2000; i++) {
    const copy = buf.slice();
    for (let k = 0; k < 4; k++) copy[rnd() % copy.length] = rnd() & 255;
    const r = readExif(copy.buffer);
    assert.deepEqual(Object.keys(r), ['taken', 'lat', 'lon']);
  }
});
