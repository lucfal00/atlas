// Client-side encryption for sync: PBKDF2-SHA256 → AES-256-GCM (WebCrypto, browser and Node), gzip before sealing.
const subtle = globalThis.crypto.subtle;
const enc = new TextEncoder();
const dec = new TextDecoder();

export const ITERATIONS = 310000;

/** Base64 of any byte array; built in chunks so photos and large documents never overflow the call stack. */
export function toB64(buf) {
  const b = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
  return btoa(s);
}

/** Bytes of a base64 string; whitespace is ignored (GitHub wraps `content` with newlines). */
export function fromB64(s) {
  const bin = atob(String(s).replace(/\s+/g, ''));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export const randomBytes = (n) => globalThis.crypto.getRandomValues(new Uint8Array(n));

export async function deriveKey(password, salt, iterations = ITERATIONS) {
  const base = await subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
  return subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    base, { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt'],
  );
}

export const exportKey = async (key) => toB64(await subtle.exportKey('raw', key));

export const importKey = (b64) => subtle.importKey('raw', fromB64(b64), 'AES-GCM', true, ['encrypt', 'decrypt']);

// ---- gzip --------------------------------------------------------------

async function through(stream, bytes) {
  return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(stream)).arrayBuffer());
}

export const gzip = (bytes) => through(new CompressionStream('gzip'), bytes);

export const gunzip = (bytes) => through(new DecompressionStream('gzip'), bytes);

// ---- document envelope -------------------------------------------------

/** Encrypt obj into the JSON envelope stored in atlas.json: AES-GCM of gzip(JSON). */
export async function seal(key, salt, iterations, obj) {
  const iv = randomBytes(12);
  const packed = await gzip(enc.encode(JSON.stringify(obj)));
  const data = await subtle.encrypt({ name: 'AES-GCM', iv }, key, packed);
  return JSON.stringify({
    app: 'atlas',
    v: 1,
    kdf: { name: 'PBKDF2-SHA256', iterations, salt: toB64(salt) },
    iv: toB64(iv),
    z: 'gzip',
    data: toB64(data),
  });
}

/** Parse an envelope; throws if it is not one of ours. */
export function parseEnvelope(text) {
  const e = JSON.parse(text);
  if (e?.app !== 'atlas' || e.v !== 1 || e.z !== 'gzip' || !e.kdf?.salt || !(e.kdf.iterations > 0) || !e.iv || !e.data) {
    throw new Error('not an atlas envelope');
  }
  return e;
}

/** Decrypt an envelope; throws (OperationError) on a wrong key. */
export async function unseal(key, env) {
  const packed = await subtle.decrypt({ name: 'AES-GCM', iv: fromB64(env.iv) }, key, fromB64(env.data));
  return JSON.parse(dec.decode(await gunzip(new Uint8Array(packed))));
}

// ---- binary (photos) ---------------------------------------------------

/** IV (12 B) ‖ AES-GCM(bytes); `aad` (the file name) is authenticated, so a blob cannot be swapped for another. */
export async function sealBytes(key, bytes, aad) {
  const iv = randomBytes(12);
  const ct = await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(aad) }, key, bytes);
  const out = new Uint8Array(12 + ct.byteLength);
  out.set(iv);
  out.set(new Uint8Array(ct), 12);
  return out;
}

/** Inverse of sealBytes; throws (OperationError) on a wrong key, wrong `aad` or altered data. */
export async function openBytes(key, data, aad) {
  const buf = await subtle.decrypt(
    { name: 'AES-GCM', iv: data.subarray(0, 12), additionalData: enc.encode(aad) }, key, data.subarray(12),
  );
  return new Uint8Array(buf);
}
