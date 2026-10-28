// Photo processing: EXIF, decode, two reduced JPEGs (spec §7). No storage: callers save the Blobs.
import { readExif } from './exif.js';

const FULL = { side: 1600, quality: 0.82 };
const THUMB = { side: 320, quality: 0.7 };

const isJpeg = (b) => b.length > 2 && b[0] === 0xff && b[1] === 0xd8;

function makeCanvas(w, h) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  return Object.assign(document.createElement('canvas'), { width: w, height: h });
}

/** Draws `src` (bitmap or canvas, w×h) scaled so the long side is ≤ `side`; never upscales. */
function scaled(src, w, h, side) {
  const k = Math.min(1, side / Math.max(w, h));
  const cw = Math.max(1, Math.round(w * k));
  const ch = Math.max(1, Math.round(h * k));
  const canvas = makeCanvas(cw, ch);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';                         // transparent sources would turn black in a JPEG
  ctx.fillRect(0, 0, cw, ch);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, 0, 0, cw, ch);
  return canvas;
}

function toJpeg(canvas, quality) {
  if (canvas.convertToBlob) return canvas.convertToBlob({ type: 'image/jpeg', quality });
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('format'))), 'image/jpeg', quality);
  });
}

/**
 * File → { full: Blob, thumb: Blob, meta: { w, h, bytes, taken, lat, lon } }.
 * w, h, bytes describe the full version; taken / lat / lon come from JPEG EXIF (else null).
 * Throws Error('format') when the image cannot be decoded or re-encoded.
 */
export async function processFile(file) {
  let buf;
  let bitmap;
  try {
    buf = await file.arrayBuffer();
    // older engines reject the option value: retry plain (a real decode failure fails again)
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' }).catch(() => createImageBitmap(file));
  } catch {
    throw new Error('format');
  }
  try {
    const exif = isJpeg(new Uint8Array(buf, 0, Math.min(3, buf.byteLength))) ? readExif(buf) : { taken: null, lat: null, lon: null };
    const { width, height } = bitmap;
    const big = scaled(bitmap, width, height, FULL.side);
    const full = await toJpeg(big, FULL.quality);
    const thumb = await toJpeg(scaled(big, big.width, big.height, THUMB.side), THUMB.quality);
    return {
      full,
      thumb,
      meta: { w: big.width, h: big.height, bytes: full.size, taken: exif.taken, lat: exif.lat, lon: exif.lon },
    };
  } catch {
    throw new Error('format');
  } finally {
    bitmap.close?.();
  }
}
