// IndexedDB: the only module that touches it. Database `atlas` v1; stores doc, full, thumb, meta (out-of-line keys), queue (auto-increment).
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
      for (const s of ['doc', 'full', 'thumb', 'meta']) db.createObjectStore(s);
      db.createObjectStore('queue', { autoIncrement: true });
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

// ---- Photo queue ---------------------------------------------------------

/** op: { op: 'put' | 'del', id } → its queue key. */
export const queueAdd = (op) => run('queue', 'readwrite', (s) => s.add(op));

/** All pending operations in key (= insertion) order: [{ key, op, id }]. */
export async function queueAll() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction('queue', 'readonly');
    const out = [];
    const req = t.objectStore('queue').openCursor();
    req.onsuccess = () => {
      const c = req.result;
      if (!c) return;
      out.push({ key: c.key, op: c.value.op, id: c.value.id });
      c.continue();
    };
    t.oncomplete = () => resolve(out);
    t.onabort = () => reject(t.error ?? req.error ?? new Error('Transazione annullata'));
  });
}

export const queueRemove = (key) => run('queue', 'readwrite', (s) => s.delete(key));
