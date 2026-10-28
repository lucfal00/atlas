// Document store: the only module that changes the document. Persists to IndexedDB (db.js), syncs through sync.js.
// Emits 'change' after data mutations and 'sync' when sync status, photo progress or the banner changes.
// Rule: no object taken from `doc` is kept across an await (a sync may replace `doc` meanwhile).
import { emptyDoc, newId, todayKey, COST_CATS } from './logic.js';
import { validateDoc, mergeDocs } from './merge.js';
import { locate } from './geo.js';
import {
  connect, syncOnce, uploadPhoto, downloadPhoto, deletePhoto as deleteRemotePhoto, makeRepoApi,
} from './sync.js';
import { openDb, dbGet, dbPut, dbDel, dbKeys, queueAdd, queueAll, queueRemove } from './db.js';
import { processFile } from './photos.js';

const bus = new EventTarget();
const fetchFn = (...a) => globalThis.fetch(...a);   // looked up at call time, so a later stub of fetch is honoured

const MSG = {
  noDb: 'Archivio del browser non disponibile: le modifiche non verranno salvate',
  corrupt: 'Dati danneggiati: salvata una copia, avvio con archivio vuoto',
  corruptNoCopy: 'Dati danneggiati e copia non riuscita: le modifiche non verranno salvate',
  full: 'Spazio esaurito: impossibile salvare. Esporta un backup.',
  saveFail: 'Salvataggio non riuscito. Esporta un backup.',
  format: 'Formato non supportato: convertila in JPEG',
  process: 'Impossibile elaborare la foto',
  quota: 'Spazio esaurito sul dispositivo',
  photoSave: 'Impossibile salvare la foto',
  badBackup: 'Backup non valido',
  offline: 'Offline: sincronizzo appena torna la rete.',
};

let doc = emptyDoc();
let notice = '';          // banner message
let persistent = false;   // the database opened: without it nothing is saved

let cfg = null;           // { token, owner, repo, salt, iterations, key, at } (meta.sync)
let sync = { state: 'off', message: '', at: 0 };   // off | idle | syncing | offline | paused | error
let queued = 0;           // photo operations waiting in the queue
let uploading = 0;        // 1 while a queue item is in flight
let run = { done: 0, total: 0 };                   // progress of the current queue run
let syncTimer = 0;
let rateTimer = 0;
let pausedUntil = 0;      // GitHub rate limit: no request before this time
let syncing = false;
let syncAgain = false;

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isQuota = (e) => e?.name === 'QuotaExceededError' || e?.code === 22;
const defined = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
const warn = (what) => (e) => console.warn(`Atlas: ${what}`, e);   // best-effort step failed: leave a trace, carry on
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
    queued = (await queueAll()).length;
  } catch {
    notice = MSG.noDb;                            // persistent stays false: every write becomes a no-op
    cfg = null;
    return;
  }
  persistent = true;
  if (!cfg?.token) cfg = null;
  if (raw !== undefined) {
    if (validateDoc(raw)) {
      doc = raw;
    } else {
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

/** Write the document and notify views, without scheduling a sync. */
async function persist() {
  if (persistent) {
    try {
      await dbPut('doc', 'v1', doc);
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
  months: [], budget: null, visits: [], cover: null, deleted: false,
});

const TRIP_DEFAULTS = () => ({
  with: [], cover: null, note: '', links: [], stops: [], costs: [], deleted: false,
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

/** Soft delete of a place / trip (`list` = 'places' | 'trips'); `photos` also deletes the photos whose `field` is its id. */
async function softDelete(list, field, id, photos) {
  const o = doc[list].find((x) => x.id === id);
  if (!o) return;
  o.deleted = true;
  o.updatedAt = Date.now();
  const gone = photos ? markPhotosDeleted(doc.photos.filter((f) => f[field] === id).map((f) => f.id)) : [];
  await cleanupPhotos(gone);
  await save();
}

/** Soft delete; `photos` also deletes the place's photos. */
export function deletePlace(id, { photos = false } = {}) {
  return softDelete('places', 'place', id, photos);
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

/** Soft delete; `photos` also deletes the trip's photos. */
export function deleteTrip(id, { photos = false } = {}) {
  return softDelete('trips', 'trip', id, photos);
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

// ---- Photos --------------------------------------------------------------

const urls = new Map();       // 'id:kind' → object URL
const loading = new Map();    // 'id:kind' → pending photoUrl promise

function revokeUrls(id) {
  for (const kind of ['full', 'thumb']) {
    const k = `${id}:${kind}`;
    if (urls.has(k)) URL.revokeObjectURL(urls.get(k));
    urls.delete(k);
    loading.delete(k);
  }
}

/** Drop the local copy of a photo: Blobs, upload flag, object URLs. */
async function dropBlobs(id) {
  revokeUrls(id);
  if (!persistent) return;
  for (const [store, key] of [['full', id], ['thumb', id], ['meta', `up:${id}`]]) await dbDel(store, key).catch(() => {});
}

/** Synchronous part of a photo deletion: flag, covers. → ids actually deleted. */
function markPhotosDeleted(ids) {
  const now = Date.now();
  const out = [];
  for (const id of ids) {
    const f = doc.photos.find((x) => x.id === id);
    if (!f || f.deleted) continue;
    f.deleted = true;
    f.updatedAt = now;
    for (const o of [...doc.places, ...doc.trips]) {
      if (o.cover !== id) continue;
      o.cover = null;
      o.updatedAt = now;
    }
    out.push(id);
  }
  return out;
}

/** Local Blobs go away at once; the remote files are removed by a queued `del`. */
async function cleanupPhotos(ids) {
  for (const id of ids) {
    await dropBlobs(id);
    if (cfg) await enqueue({ op: 'del', id }).catch(warn('coda foto: eliminazione non accodata'));   // the deletion itself must still be saved
  }
}

async function enqueue(op) {
  if (!persistent) return;
  await queueAdd(op);
  queued++;
}

async function dequeue(key) {
  await queueRemove(key);
  queued = Math.max(0, queued - 1);
}

/**
 * files (FileList or array) → { added: [photo id], errors: [{ name, reason }] }. One file at a time; a failing file
 * does not stop the others. Saved once at the end. onProgress(done, total) is optional.
 */
export async function addPhotos(files, { place, trip, day, onProgress } = {}) {
  const list = Array.from(files);
  const metas = [];
  const errors = [];
  for (const file of list) {
    onProgress?.(metas.length + errors.length, list.length);
    if (!persistent) {
      errors.push({ name: file.name, reason: MSG.noDb });
      continue;
    }
    let out;
    try {
      out = await processFile(file);
    } catch (e) {
      errors.push({ name: file.name, reason: e?.message === 'format' ? MSG.format : MSG.process });
      continue;
    }
    const id = newId('f');
    try {
      await dbPut('full', id, out.full);
      await dbPut('thumb', id, out.thumb);
    } catch (e) {
      await dbDel('full', id).catch(() => {});
      await dbDel('thumb', id).catch(() => {});
      errors.push({ name: file.name, reason: isQuota(e) ? MSG.quota : MSG.photoSave });
      continue;
    }
    const { w, h, bytes, taken, lat, lon } = out.meta;
    metas.push({
      id, place: place ?? null, trip: trip ?? null, day: day ?? null, taken, lat, lon, w, h, bytes,
      caption: '', deleted: false, updatedAt: Date.now(),
    });
  }
  onProgress?.(list.length, list.length);
  if (metas.length) {
    doc.photos.push(...metas);                    // before queueing: a running sync drops items whose photo it cannot find
    if (cfg) {
      // best effort: a photo whose put is not queued here is queued by the next runQueue (enqueueLocalPhotos)
      for (const m of metas) await enqueue({ op: 'put', id: m.id }).catch(warn('coda foto: caricamento non accodato'));
    }
    await save();
  }
  return { added: metas.map((m) => m.id), errors };
}

/** Caption and assignment of a photo: only caption, place, trip, day can change. */
export async function updatePhoto(id, patch) {
  const f = doc.photos.find((x) => x.id === id);
  if (!f) return;
  for (const k of ['caption', 'place', 'trip', 'day']) if (k in patch) f[k] = patch[k];
  f.updatedAt = Date.now();
  await save();
}

/** Soft delete: Blobs go, covers are cleared, the remote files are removed by a queued `del`. */
export async function deletePhoto(id) {
  const gone = markPhotosDeleted([id]);
  if (!gone.length) return;
  await cleanupPhotos(gone);
  await save();
}

const MAX_DOWNLOADS = 4;
let activeDownloads = 0;
const waiting = [];

/** At most MAX_DOWNLOADS photo requests in flight (a new device may show hundreds of thumbnails). */
async function limited(fn) {
  if (activeDownloads >= MAX_DOWNLOADS) await new Promise((r) => waiting.push(r));   // the slot is handed over
  else activeDownloads++;
  try {
    return await fn();
  } finally {
    const next = waiting.shift();
    if (next) next();
    else activeDownloads--;
  }
}

/** Blob from GitHub (stored locally if possible); null if sync is off or the file does not exist. Throws SyncError. */
async function remoteBlob(id, kind) {
  const c = cfg;
  if (!c) return null;
  const bytes = await limited(() => downloadPhoto({ cfg: c, id, kind, fetchFn }));
  if (!bytes) return null;
  const blob = new Blob([bytes], { type: 'image/jpeg' });
  if (persistent && !doc.photos.some((x) => x.id === id && x.deleted)) await dbPut(kind, id, blob).catch(() => {});
  return blob;
}

async function loadUrl(id, kind) {
  if (!persistent) return null;
  try {
    let blob = await dbGet(kind, id);
    blob ??= await remoteBlob(id, kind);
    if (!blob || doc.photos.some((x) => x.id === id && x.deleted)) return null;
    const url = URL.createObjectURL(blob);
    urls.set(`${id}:${kind}`, url);
    return url;
  } catch {
    return null;                                  // offline, no access: the view shows a placeholder
  }
}

/** Object URL of a photo ('thumb' | 'full'): local Blob, else downloaded and stored; null if unavailable. Cached per id:kind. */
export function photoUrl(id, kind = 'thumb') {
  const k = `${id}:${kind}`;
  if (urls.has(k)) return Promise.resolve(urls.get(k));
  if (!loading.has(k)) {
    const p = loadUrl(id, kind).finally(() => { if (loading.get(k) === p) loading.delete(k); });
    loading.set(k, p);
  }
  return loading.get(k);
}

/**
 * Revoke and forget the cached object URL of one photo ('thumb' | 'full'): the viewer calls it for `full` when it
 * closes, so full-size images do not pile up in memory. The next photoUrl() makes a new URL from the Blob.
 */
export function releasePhotoUrl(id, kind = 'full') {
  const k = `${id}:${kind}`;
  if (urls.has(k)) URL.revokeObjectURL(urls.get(k));
  urls.delete(k);                                 // a load still in flight is left alone: a new request shares it
}

/**
 * Download every missing Blob (thumb and full) of the non-deleted photos, for offline use.
 * onProgress(done, total) counts photos. Throws SyncError (network, rate…) after the photos done so far.
 * → { done, total, missing } (missing = photos with no file on GitHub).
 */
export async function downloadAllPhotos(onProgress) {
  if (!cfg || !persistent) return { done: 0, total: 0, missing: 0 };
  const have = { full: new Set(await dbKeys('full')), thumb: new Set(await dbKeys('thumb')) };
  const todo = doc.photos.filter((f) => !f.deleted && !(have.full.has(f.id) && have.thumb.has(f.id)));
  let done = 0;
  let missing = 0;
  onProgress?.(0, todo.length);
  for (const f of todo) {
    let absent = false;
    for (const kind of ['thumb', 'full']) {
      if (have[kind].has(f.id)) continue;
      if (!(await remoteBlob(f.id, kind))) absent = true;
    }
    if (absent) missing++;
    done++;
    onProgress?.(done, todo.length);
  }
  return { done, total: todo.length, missing };
}

export const queueState = () => ({ pending: queued, uploading });

/** { localBytes: origin usage or null, repoKB: GitHub repository size (history included) or null }. */
export async function storageInfo() {
  let localBytes = null;
  let repoKB = null;
  try {
    localBytes = (await navigator.storage.estimate()).usage ?? null;
  } catch { /* unsupported */ }
  const c = cfg;
  if (c) {
    try {
      repoKB = await makeRepoApi(c.token, fetchFn).repoSize(c.owner, c.repo);
    } catch { /* offline or no access */ }
  }
  return { localBytes, repoKB };
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
  if (!validateDoc(data)) throw new Error(MSG.badBackup);
  const r = mergeDocs(doc, data);
  doc = r.doc;
  await purgeDeletedBlobs();                      // photos the backup marks as deleted
  await save();
  return { count: r.count };
}

// ---- Sync ----------------------------------------------------------------

export const getSync = () => ({
  connected: !!cfg,
  ...sync,
  photos: { pending: queued, uploading, done: run.done, total: run.total },
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

/** Forget the queue and every upload flag (another repository, or no repository). */
async function resetUploads() {
  queued = 0;
  run = { done: 0, total: 0 };
  if (!persistent) return;
  for (const { key } of await queueAll()) await queueRemove(key);
  for (const k of await dbKeys('meta')) if (String(k).startsWith('up:')) await dbDel('meta', k);
}

/** Local Blobs of deleted photos (deleted on another device or by an import) are not needed any more (spec §9.3). */
async function purgeDeletedBlobs() {
  const gone = doc.photos.filter((f) => f.deleted).map((f) => f.id);
  for (const id of gone) revokeUrls(id);          // cached object URLs go even when no Blob is left
  if (!persistent || !gone.length) return;
  const have = new Set([...(await dbKeys('full')), ...(await dbKeys('thumb'))]);
  for (const id of gone) if (have.has(id)) await dropBlobs(id);
}

/** Keep anything edited while a network round trip was in flight (newest wins). */
async function adopt(incoming) {
  const r = mergeDocs(doc, incoming);
  if (!r.count) return;
  doc = r.doc;
  await purgeDeletedBlobs();
  await persist();
}

/** Queue a `put` for every local photo that was never uploaded and is not queued yet. */
async function enqueueLocalPhotos() {
  if (!persistent) return;
  const full = new Set(await dbKeys('full'));
  const thumb = new Set(await dbKeys('thumb'));
  const flags = new Set(await dbKeys('meta'));
  const pending = new Set((await queueAll()).filter((q) => q.op === 'put').map((q) => q.id));   // last: freshest view of the queue
  const ids = doc.photos
    .filter((f) => !f.deleted && full.has(f.id) && thumb.has(f.id) && !flags.has(`up:${f.id}`) && !pending.has(f.id))
    .map((f) => f.id);
  for (const id of ids) await enqueue({ op: 'put', id });
}

/** Link this device → { count } (items updated from the repository). Throws SyncError (wrong password, bad token…). */
export async function connectSync(token, repo, password) {
  const before = cfg;
  const r = await connect({ token: token.trim(), repo: (repo || '').trim() || 'atlas-data', password, local: doc, fetchFn });
  cfg = { ...r.cfg, at: Date.now() };
  if (before && (before.owner !== cfg.owner || before.repo !== cfg.repo)) await resetUploads();
  await storeCfg();
  await adopt(r.doc);
  await enqueueLocalPhotos().catch(warn('coda foto: scansione iniziale non riuscita'));   // runQueue repeats it
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
  await resetUploads().catch(() => {});
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

const toBytes = async (blob) => new Uint8Array(await blob.arrayBuffer());

/** One queue item. Photos deleted or without Blobs are dropped silently. Throws SyncError. */
async function processItem({ key, op, id }, c) {
  if (op === 'del') {
    await deleteRemotePhoto({ cfg: c, id, fetchFn });
  } else {
    const f = doc.photos.find((x) => x.id === id);
    const thumb = f && !f.deleted ? await dbGet('thumb', id) : null;
    const full = thumb ? await dbGet('full', id) : null;
    if (thumb && full) {
      await uploadPhoto({ cfg: c, id, kind: 'thumb', bytes: await toBytes(thumb), fetchFn });
      await uploadPhoto({ cfg: c, id, kind: 'full', bytes: await toBytes(full), fetchFn });
      if (cfg !== c) return;                      // disconnected meanwhile
      await dbPut('meta', `up:${id}`, true);
    }
  }
  if (cfg === c) await dequeue(key);
}

/** Document round trip: upload local changes, adopt the merged result. Throws SyncError. */
async function syncDoc() {
  const r = await syncOnce({ cfg, local: doc, fetchFn });
  if (cfg) await adopt(r.doc);                    // null: disconnected meanwhile
}

/**
 * Photo queue, in order, one photo at a time. Throws on the first error; the item stays queued.
 * First queues any local photo that is not queued yet (a failed queue write must not strand a photo).
 * A document change during a long run is pushed between two photos, not after the last one.
 */
async function runQueue() {
  if (!persistent) return;
  run = { done: 0, total: 0 };
  try {
    await enqueueLocalPhotos().catch(warn('coda foto: scansione non riuscita'));
    for (;;) {
      if (syncAgain && cfg) {
        syncAgain = false;
        await syncDoc();
      }
      const c = cfg;
      if (!c) return;
      const items = await queueAll();
      queued = items.length;
      if (!items.length) break;
      run.total = run.done + items.length;
      uploading = 1;
      emit('sync');
      try {
        await processItem(items[0], c);
      } finally {
        uploading = 0;
      }
      run.done++;
      emit('sync');
    }
  } finally {
    run = { done: 0, total: 0 };                  // also after an error: no stale "3/12" in the status
  }
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

/** Document first, then the photo queue. Single flight; a request during a run repeats it once afterwards. */
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
    await runQueue();
    if (!cfg) return;
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
      notice = `Sincronizzazione: ${e.message || 'errore imprevisto.'}`;
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
