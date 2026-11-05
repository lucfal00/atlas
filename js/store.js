// Document store: the only module that changes the document. Persists to IndexedDB (db.js), syncs through sync.js.
// Emits 'change' after data mutations and 'sync' when sync status or the banner changes.
// Rule: no object taken from `doc` is kept across an await (a sync may replace `doc` meanwhile).
import { emptyDoc, newId, todayKey, COST_CATS } from './logic.js';
import { validateDoc, sanitizeDoc, mergeDocs } from './merge.js';
import { locate } from './geo.js';
import { connect, syncOnce } from './sync.js';
import { openDb, dbGet, dbPut, dbDel } from './db.js';

const bus = new EventTarget();
const fetchFn = (...a) => globalThis.fetch(...a);   // looked up at call time, so a later stub of fetch is honoured

const MSG = {
  noDb: 'Archivio del browser non disponibile: le modifiche non verranno salvate',
  corrupt: 'Dati danneggiati: salvata una copia, avvio con archivio vuoto',
  corruptNoCopy: 'Dati danneggiati e copia non riuscita: le modifiche non verranno salvate',
  full: 'Spazio esaurito: impossibile salvare. Esporta un backup.',
  saveFail: 'Salvataggio non riuscito. Esporta un backup.',
  badBackup: 'Backup non valido',
  offline: 'Offline: sincronizzo appena torna la rete.',
};

let doc = emptyDoc();
let notice = '';          // banner message
let persistent = false;   // the database opened: without it nothing is saved

let cfg = null;           // { token, owner, repo, salt, iterations, key, at } (meta.sync)
let sync = { state: 'off', message: '', at: 0 };   // off | idle | syncing | offline | paused | error
let syncTimer = 0;
let rateTimer = 0;
let pausedUntil = 0;      // GitHub rate limit: no request before this time
let syncing = false;
let syncAgain = false;

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isQuota = (e) => e?.name === 'QuotaExceededError' || e?.code === 22;
const defined = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
const emit = (type = 'change') => bus.dispatchEvent(new Event(type));

function upsert(list, item) {
  const i = list.findIndex((x) => x.id === item.id);
  if (i < 0) list.push(item);
  else list[i] = item;
}

export async function load() {
  let raw;
  try {
    await openDb();
    raw = await dbGet('doc', 'v1');
    cfg = (await dbGet('meta', 'sync')) ?? null;
  } catch {
    notice = MSG.noDb;                            // persistent stays false: every write becomes a no-op
    cfg = null;
    return;
  }
  persistent = true;
  if (!cfg?.token) cfg = null;
  if (raw !== undefined) {
    const clean = sanitizeDoc(raw);
    if (clean && !clean.dropped) {
      doc = clean.doc;
    } else {
      if (clean) doc = clean.doc;                 // only some items were bad: keep the rest
      try {
        await dbPut('meta', 'v1.corrupt', raw);
        notice = MSG.corrupt;
      } catch {
        persistent = false;                       // do not overwrite data we could not copy
        notice = MSG.corruptNoCopy;
      }
    }
  }
  const def = emptyDoc().settings;
  doc.settings = { ...def, ...doc.settings };
  if (!isNum(doc.settings.home?.lat) || !isNum(doc.settings.home?.lon)) doc.settings.home = def.home;
  if (cfg) sync = { state: 'idle', message: '', at: cfg.at || 0 };
  try {
    Promise.resolve(navigator.storage?.persist?.()).catch(() => {});
  } catch { /* best effort */ }
}

export const getDoc = () => doc;
export const getNotice = () => notice;
export const onChange = (fn) => bus.addEventListener('change', fn);
export const onSync = (fn) => bus.addEventListener('sync', fn);

export function clearNotice() {
  notice = '';
  emit('sync');
}

// Several windows (tab + installed PWA) share one IndexedDB document: after each write the others merge it in
// (newest wins) before their own next write, so a stale window cannot overwrite newer edits.
const channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel('atlas') : null;
if (channel) {
  channel.onmessage = async () => {
    if (!persistent) return;
    try {
      const stored = await dbGet('doc', 'v1');
      const clean = sanitizeDoc(stored);
      if (!clean) return;
      const r = mergeDocs(doc, clean.doc);
      if (r.count) {
        doc = r.doc;
        emit();
      }
    } catch { /* best effort */ }
  };
}

/** Write the document and notify views, without scheduling a sync. */
async function persist() {
  if (persistent) {
    try {
      await dbPut('doc', 'v1', doc);
      channel?.postMessage('doc');
    } catch (e) {
      notice = isQuota(e) ? MSG.full : MSG.saveFail;
    }
  }
  emit();
}

/** User change: persist and upload a few seconds later. */
async function save() {
  await persist();
  scheduleSync();
}

// ---- Geography -----------------------------------------------------------

let geoLoad = null;

async function getJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Dati geografici non disponibili (${res.status})`);
  return res.json();
}

/** { world, italia } layers from geo/*.json, loaded on first use and kept in memory. */
export function getGeo() {
  if (!geoLoad) {
    geoLoad = Promise.all([getJson('geo/world.json'), getJson('geo/italia.json')]).then(([world, italia]) => ({ world, italia }));
    geoLoad.catch(() => { geoLoad = null; });     // a failed load may be retried
  }
  return geoLoad;
}

/** { country, region, province } of a point (spec §8.3); rejects if the geographic data cannot be loaded. */
export async function locateCoords(lat, lon) {
  const { world, italia } = await getGeo();
  return locate(lat, lon, world, italia);
}

// ---- Places and trips ----------------------------------------------------

const PLACE_DEFAULTS = () => ({
  country: null, region: null, province: null,
  cat: 'altro', status: 'wish', rating: null, fav: false, tags: [], note: '', with: [], todo: [], links: [],
  months: [], budget: null, visits: [], deleted: false,
});

const TRIP_DEFAULTS = () => ({
  with: [], note: '', links: [], stops: [], costs: [], deleted: false,
  budget: Object.fromEntries(COST_CATS.map((k) => [k, 0])),
});

/**
 * Create (no id) or update a place → its id. Country / region / province:
 * - `country` provided (even null): exactly the provided country / region / province (missing → null);
 * - else coordinates explicitly set to null: cleared (a provided region / province is kept);
 * - else computed from the coordinates when the place is new or its coordinates changed.
 */
export async function savePlace(p) {
  const before = p.id ? doc.places.find((x) => x.id === p.id) : undefined;
  const lat = p.lat === undefined ? before?.lat : p.lat;   // null in `p` means "removed", not "unchanged"
  const lon = p.lon === undefined ? before?.lon : p.lon;
  let geo = null;
  if (p.country !== undefined) {
    geo = { country: p.country, region: p.region ?? null, province: p.province ?? null };
  } else if (p.lat === null || p.lon === null) {
    geo = { country: null, region: p.region ?? null, province: p.province ?? null };
  } else if (isNum(lat) && isNum(lon) && (!before || lat !== before.lat || lon !== before.lon)) {
    geo = await locateCoords(lat, lon).catch(() => ({ country: null, region: null, province: null }));
  }
  const old = p.id ? doc.places.find((x) => x.id === p.id) : undefined;   // doc may have changed meanwhile
  const id = p.id ?? newId('l');
  const next = { ...PLACE_DEFAULTS(), ...old, ...defined(p), ...geo, id, updatedAt: Date.now() };
  next.todo = next.todo.map((t) => (t.id ? t : { ...t, id: newId('a') }));
  upsert(doc.places, next);
  await save();
  return id;
}

/** Soft delete of a place / trip (`list` = 'places' | 'trips'). */
async function softDelete(list, id) {
  const o = doc[list].find((x) => x.id === id);
  if (!o) return;
  o.deleted = true;
  o.updatedAt = Date.now();
  await save();
}

export function deletePlace(id) {
  return softDelete('places', id);
}

/** Create (no id) or update a trip → its id. */
export async function saveTrip(t) {
  const id = t.id ?? newId('v');
  const old = t.id ? doc.trips.find((x) => x.id === t.id) : undefined;
  const next = { ...TRIP_DEFAULTS(), ...old, ...defined(t), id, updatedAt: Date.now() };
  next.budget = { ...TRIP_DEFAULTS().budget, ...next.budget };
  next.costs = next.costs.map((c) => (c.id ? c : { ...c, id: newId('c') }));
  upsert(doc.trips, next);
  await save();
  return id;
}

export function deleteTrip(id) {
  return softDelete('trips', id);
}

/** Diary page of one trip day; fields not in `patch` are kept. */
export function setDiary(tripId, day, patch) {
  const key = `${tripId}:${day}`;
  doc.diary[key] = { text: '', places: [], ...doc.diary[key], ...patch, t: Date.now() };
  return save();
}

/** Manual area mark (`c:IT`, `r:Campania`, `p:Salerno`): s = 'visited', or null to remove it (the key stays for merge). */
export function setMark(key, s) {
  doc.marks[key] = { s, t: Date.now() };
  return save();
}

/** { localBytes: origin usage or null }. */
export async function storageInfo() {
  let localBytes = null;
  try {
    localBytes = (await navigator.storage.estimate()).usage ?? null;
  } catch { /* unsupported */ }
  return { localBytes };
}

// ---- Settings and backup -------------------------------------------------

export function setSetting(k, v) {
  doc.settings[k] = v;
  return persist();                               // device-local: nothing to upload
}

/** Share sheet on touch devices (iPhone → "Salva in File"), download elsewhere. False if cancelled. */
export async function exportBackup() {
  const name = `atlas-backup-${todayKey()}.json`;
  const file = new File([JSON.stringify(doc, null, 2)], name, { type: 'application/json' });
  const touch = matchMedia('(pointer: coarse)').matches;
  if (touch && navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file] });
    } catch (e) {
      if (e.name === 'AbortError') return false;
      throw e;
    }
  } else {
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(file), download: name });
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
  doc.settings.lastBackup = Date.now();
  await persist();
  return true;
}

/** Merge a backup file into the document → { count }. An invalid file changes nothing. */
export async function importBackup(file) {
  let data;
  try {
    data = JSON.parse(await file.text());
  } catch {
    throw new Error(MSG.badBackup);
  }
  const clean = sanitizeDoc(data);
  if (!clean) throw new Error(MSG.badBackup);
  const r = mergeDocs(doc, clean.doc);
  doc = r.doc;
  await save();
  return { count: r.count, dropped: clean.dropped };
}

// ---- Sync ----------------------------------------------------------------

export const getSync = () => ({
  connected: !!cfg,
  ...sync,
});

function setSync(state, message = '', at = sync.at) {
  sync = { state, message, at };
  emit('sync');
}

async function storeCfg() {
  if (!persistent) return;                        // the link lives in memory for this session
  try {
    if (cfg) await dbPut('meta', 'sync', cfg);
    else await dbDel('meta', 'sync');
  } catch { /* best effort */ }
}

/** Keep anything edited while a network round trip was in flight (newest wins). */
async function adopt(incoming) {
  const r = mergeDocs(doc, incoming);
  if (!r.count) return;
  doc = r.doc;
  await persist();
}

/** Link this device → { count } (items updated from the repository). Throws SyncError (wrong password, bad token…). */
export async function connectSync(token, repo, password) {
  const r = await connect({ token: token.trim(), repo: (repo || '').trim() || 'atlas-data', password, local: doc, fetchFn });
  cfg = { ...r.cfg, at: Date.now() };
  await storeCfg();
  await adopt(r.doc);
  clearTimeout(rateTimer);
  pausedUntil = 0;
  setSync('idle', '', cfg.at);
  runSync();
  return { count: r.count };
}

export async function disconnectSync() {
  clearTimeout(syncTimer);
  clearTimeout(rateTimer);
  syncTimer = 0;
  rateTimer = 0;
  pausedUntil = 0;
  cfg = null;
  await storeCfg();
  setSync('off');
}

export function scheduleSync(delay = 3000) {
  if (!cfg) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(runSync, delay);
}

/** Upload a pending change right away (the app is going to the background). */
export function flushSync() {
  if (syncTimer) runSync();
}

/** Document round trip: upload local changes, adopt the merged result. Throws SyncError. */
async function syncDoc() {
  const r = await syncOnce({ cfg, local: doc, fetchFn });
  if (cfg) await adopt(r.doc);                    // null: disconnected meanwhile
}

/** GitHub rate limit: stay quiet until the limit resets, then resume. */
function pauseUntilReset(e) {
  const wait = e.resetAt ? Math.min(Math.max(e.resetAt - Date.now() + 1000, 1000), 2 * 3600e3) : 60e3;
  pausedUntil = Date.now() + wait;
  clearTimeout(rateTimer);
  rateTimer = setTimeout(() => {
    pausedUntil = 0;
    rateTimer = 0;
    runSync();
  }, wait);
  const at = new Date(pausedUntil).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
  setSync('paused', `${e.message}: riprendo alle ${at}`);
}

/** Document round trip. Single flight; a request during a run repeats it once afterwards. */
export async function runSync() {
  clearTimeout(syncTimer);
  syncTimer = 0;
  if (!cfg || Date.now() < pausedUntil) return;
  if (syncing) {
    syncAgain = true;
    return;
  }
  if (!navigator.onLine) {
    setSync('offline', MSG.offline);
    return;
  }
  syncing = true;
  const c = cfg;
  setSync('syncing');
  try {
    await syncDoc();
    if (!cfg) return;                             // disconnected meanwhile
    cfg.at = Date.now();
    await storeCfg();
    setSync('idle', '', cfg.at);
  } catch (e) {
    if (cfg !== c) return;                        // disconnected (or relinked) meanwhile: this failure is stale
    if (e.code === 'network') {
      setSync('offline', e.message);
    } else if (e.code === 'rate') {
      pauseUntilReset(e);
    } else {
      notice = e.code === 'token' ? 'Token scaduto o non valido: creane uno nuovo'
        : `Sincronizzazione: ${e.message || 'errore imprevisto.'}`;
      setSync('error', e.message || 'Errore imprevisto.');
    }
  } finally {
    syncing = false;
    if (syncAgain) {
      syncAgain = false;
      scheduleSync(500);
    }
  }
}
