// IndexedDB: the only module that touches it. Database `atlas` v1; stores doc, meta (out-of-line keys).
// Errors propagate as the original DOMException (e.g. name === 'QuotaExceededError') so callers can map them.

const NAME = 'atlas';
const VERSION = 1;

let opening = null;

/** Opens the database once; rejects if IndexedDB is missing, blocked or fails (a later call may retry). */
export function openDb() {
  if (opening) return opening;
  opening = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB non disponibile'));
      return;
    }
    let settled = false;
    const req = indexedDB.open(NAME, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const s of ['doc', 'meta']) db.createObjectStore(s);
    };
    req.onsuccess = () => {
      const db = req.result;
      if (settled) {                              // already rejected as blocked: do not keep a stray connection
        db.close();
        return;
      }
      settled = true;
      db.onversionchange = () => {                // another tab upgrades: let it, reopen on next use
        db.close();
        opening = null;
      };
      db.onclose = () => { opening = null; };
      resolve(db);
    };
    req.onerror = () => {
      settled = true;
      reject(req.error);
    };
    req.onblocked = () => {
      settled = true;
      reject(new Error('IndexedDB bloccato da un\'altra scheda'));
    };
  });
  opening.catch(() => { opening = null; });
  return opening;
}

/** One transaction on `store`; `fn(objectStore)` returns the request whose result is resolved after commit. */
async function run(store, mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const req = fn(t.objectStore(store));
    t.oncomplete = () => resolve(req.result);
    t.onabort = () => reject(t.error ?? req.error ?? new Error('Transazione annullata'));
  });
}

export const dbGet = (store, key) => run(store, 'readonly', (s) => s.get(key));
export const dbPut = (store, key, value) => run(store, 'readwrite', (s) => s.put(value, key));
export const dbDel = (store, key) => run(store, 'readwrite', (s) => s.delete(key));
export const dbKeys = (store) => run(store, 'readonly', (s) => s.getAllKeys());
