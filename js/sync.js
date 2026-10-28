// Encrypted sync through a private GitHub repository (Contents API). No storage or DOM: callers own state.
import { mergeDocs, validateDoc } from './merge.js';
import {
  ITERATIONS, deriveKey, exportKey, importKey, seal, unseal, parseEnvelope, randomBytes, fromB64, toB64,
  sealBytes, openBytes,
} from './crypto.js';

const API = 'https://api.github.com';
const DOC = 'atlas.json';
const MAX_RETRIES = 3; // after a 409: 1 attempt + 3 retries
const enc = new TextEncoder();
const dec = new TextDecoder();

const MSG = {
  network: 'Rete non disponibile',
  token: 'Token non valido o scaduto',
  forbidden: 'Il token non ha accesso al repository',
  missing: 'Repository non trovato',
  rate: 'Limite di richieste GitHub raggiunto',
  conflict: 'Riprova più tardi',
  gzip: 'Browser non supportato per la sincronizzazione',
  remote: 'Dati remoti non validi',
  photo: 'Foto remota non valida',
  passwordConnect: 'Password errata',
  passwordSync: 'Password cambiata su un altro dispositivo: ricollega',
};

export class SyncError extends Error {
  /** code: network | token | forbidden | missing | rate | conflict | http | password | format. resetAt: ms epoch (rate). */
  constructor(code, message, resetAt) {
    super(message);
    this.name = 'SyncError';
    this.code = code;
    if (resetAt !== undefined) this.resetAt = resetAt;
  }
}

/** SyncError for an unexpected HTTP answer; `status` is attached for callers that care (e.g. 422). */
function failure(res) {
  const { status } = res;
  const reset = Number(res.headers.get('x-ratelimit-reset'));
  const retry = Number(res.headers.get('retry-after'));
  const limited = status === 429 || (status === 403 && (res.headers.get('x-ratelimit-remaining') === '0' || retry > 0));
  let e;
  if (status === 401) e = new SyncError('token', MSG.token);
  else if (limited) e = new SyncError('rate', MSG.rate, reset > 0 ? reset * 1000 : retry > 0 ? Date.now() + retry * 1000 : undefined);
  else if (status === 403) e = new SyncError('forbidden', MSG.forbidden);
  else if (status === 404) e = new SyncError('missing', MSG.missing);
  else if (status === 409) e = new SyncError('conflict', MSG.conflict);
  else e = new SyncError('http', `Errore GitHub ${status}`);
  e.status = status;
  return e;
}

/** Body of a response; a body that cannot be read is a dropped connection. */
async function readBody(res, kind) {
  try {
    return await res[kind]();
  } catch {
    throw new SyncError('network', MSG.network);
  }
}

const enPath = (path) => path.split('/').map(encodeURIComponent).join('/');

export function makeRepoApi(token, fetchFn = (...a) => fetch(...a)) {
  /** One request; `pass` lists the error statuses the caller handles itself. */
  async function call(method, url, { body, raw = false, pass = [] } = {}) {
    let res;
    try {
      res = await fetchFn(API + url, {
        method,
        cache: 'no-store',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: raw ? 'application/vnd.github.raw+json' : 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch {
      throw new SyncError('network', MSG.network);
    }
    if (res.ok || pass.includes(res.status)) return res;
    throw failure(res);
  }

  const repoUrl = (owner, repo) => `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  const fileUrl = (owner, repo, path) => `${repoUrl(owner, repo)}/contents/${enPath(path)}`;

  return {
    /** Login of the token's user. */
    async getUser() {
      return (await readBody(await call('GET', '/user'), 'json')).login;
    },

    /** Repository size in KB. */
    async repoSize(owner, repo) {
      return (await readBody(await call('GET', repoUrl(owner, repo)), 'json')).size;
    },

    /** {sha, bytes} or null. Files over 1 MB come without content: read through the blob (`metaOnly` skips that). */
    async getFile(owner, repo, path, { metaOnly = false } = {}) {
      const res = await call('GET', fileUrl(owner, repo, path), { pass: [404] });
      if (res.status === 404) return null;
      const f = await readBody(res, 'json');
      if (f.content && f.encoding === 'base64') return { sha: f.sha, bytes: fromB64(f.content) };
      if (metaOnly) return { sha: f.sha, bytes: null };
      const blob = await readBody(await call('GET', `${repoUrl(owner, repo)}/git/blobs/${f.sha}`), 'json');
      return { sha: f.sha, bytes: fromB64(blob.content) };
    },

    /** Raw file bytes or null. */
    async getRaw(owner, repo, path) {
      const res = await call('GET', fileUrl(owner, repo, path), { raw: true, pass: [404] });
      if (res.status === 404) return null;
      return new Uint8Array(await readBody(res, 'arrayBuffer'));
    },

    /** Create (no sha) or update (current sha); returns the new content sha. 409 → conflict, 422 → http with status 422. */
    async putFile(owner, repo, path, bytes, sha, message) {
      const res = await call('PUT', fileUrl(owner, repo, path), {
        body: { message, content: toB64(bytes), ...(sha ? { sha } : {}) },
      });
      return (await readBody(res, 'json')).content.sha;
    },

    /** Delete with the current sha; an already missing file is fine. */
    async deleteFile(owner, repo, path, sha) {
      await call('DELETE', fileUrl(owner, repo, path), { body: { message: `Delete ${path}`, sha }, pass: [404] });
    },
  };
}

// ---- document ----------------------------------------------------------

function needGzip() {
  if (!globalThis.CompressionStream || !globalThis.DecompressionStream) throw new SyncError('format', MSG.gzip);
}

/** Remote file bytes → validated document. Wrong key → password; anything else unreadable → format. */
async function openRemote(key, bytes, wrongKeyMsg) {
  let env;
  try {
    env = parseEnvelope(dec.decode(bytes));
  } catch {
    throw new SyncError('format', MSG.remote);
  }
  let remote;
  try {
    remote = await unseal(key, env);
  } catch {
    throw new SyncError('password', wrongKeyMsg);
  }
  if (!validateDoc(remote)) throw new SyncError('format', MSG.remote);
  return remote;
}

/**
 * Read → decrypt → merge → PUT (with sha) only if the remote lacks something local.
 * A raced PUT (409, or 422 when creating) re-reads and re-merges with the document merged so far.
 * `pre` = file already read by the caller (null = absent); undefined = read it.
 */
async function reconcile({ api, cfg, key, local, pre, wrongKeyMsg }) {
  if (!validateDoc(local)) throw new Error('Documento locale non valido');
  let doc = local;
  let count = 0;
  for (let attempt = 0; ; attempt++) {
    const file = attempt === 0 && pre !== undefined ? pre : await api.getFile(cfg.owner, cfg.repo, DOC);
    let behind = true;
    if (file) {
      const remote = await openRemote(key, file.bytes, wrongKeyMsg);
      const merged = mergeDocs(doc, remote);
      doc = merged.doc;
      count += merged.count;
      behind = mergeDocs(remote, doc).count > 0;
    }
    if (!behind) return { doc, count, pushed: false };
    try {
      const text = await seal(key, fromB64(cfg.salt), cfg.iterations, doc);
      await api.putFile(cfg.owner, cfg.repo, DOC, enc.encode(text), file?.sha, 'Atlas sync');
      return { doc, count, pushed: true };
    } catch (e) {
      const raced = e instanceof SyncError && (e.code === 'conflict' || (e.code === 'http' && e.status === 422 && !file));
      if (!raced) throw e;
      if (attempt >= MAX_RETRIES) throw new SyncError('conflict', MSG.conflict);
    }
  }
}

/** Link this device: join the existing atlas.json (merging data) or create it. Returns the cfg to store. */
export async function connect({ token, repo, password, local, fetchFn }) {
  needGzip();
  const api = makeRepoApi(token, fetchFn);
  const owner = await api.getUser();
  await api.repoSize(owner, repo); // validates the repository (404 → missing)
  const file = await api.getFile(owner, repo, DOC);
  let salt;
  let iterations;
  if (file) {
    try {
      const env = parseEnvelope(dec.decode(file.bytes));
      salt = fromB64(env.kdf.salt);
      iterations = env.kdf.iterations;
    } catch {
      throw new SyncError('format', MSG.remote);
    }
  } else {
    salt = randomBytes(16);
    iterations = ITERATIONS;
  }
  const key = await deriveKey(password, salt, iterations);
  const cfg = { token, owner, repo, salt: toB64(salt), iterations, key: await exportKey(key) };
  const { doc, count } = await reconcile({ api, cfg, key, local, pre: file, wrongKeyMsg: MSG.passwordConnect });
  return { cfg, doc, count };
}

/** Pull, merge, push if the remote lacks newer local changes. The caller merges `doc` with its current state. */
export async function syncOnce({ cfg, local, fetchFn }) {
  needGzip();
  const api = makeRepoApi(cfg.token, fetchFn);
  return reconcile({ api, cfg, key: await importKey(cfg.key), local, wrongKeyMsg: MSG.passwordSync });
}

// ---- photos ------------------------------------------------------------

function photoName(id, kind) {
  if (kind !== 'thumb' && kind !== 'full') throw new Error(`Tipo foto non valido: ${kind}`);
  return `${id}.${kind}`;
}

/** Upload one encrypted file `photos/<id>.<kind>`; an existing file (422) counts as already uploaded. */
export async function uploadPhoto({ cfg, id, kind, bytes, fetchFn }) {
  const name = photoName(id, kind);
  const api = makeRepoApi(cfg.token, fetchFn);
  const sealed = await sealBytes(await importKey(cfg.key), bytes, name);
  try {
    await api.putFile(cfg.owner, cfg.repo, `photos/${name}`, sealed, undefined, 'Add photo');
  } catch (e) {
    if (!(e instanceof SyncError && e.code === 'http' && e.status === 422)) throw e;
  }
}

/** Decrypted photo bytes, or null when the file does not exist. */
export async function downloadPhoto({ cfg, id, kind, fetchFn }) {
  const name = photoName(id, kind);
  const raw = await makeRepoApi(cfg.token, fetchFn).getRaw(cfg.owner, cfg.repo, `photos/${name}`);
  if (!raw) return null;
  try {
    return await openBytes(await importKey(cfg.key), raw, name);
  } catch {
    throw new SyncError('format', MSG.photo);
  }
}

/** Delete thumb then full; a file that is already gone is fine. */
export async function deletePhoto({ cfg, id, fetchFn }) {
  const api = makeRepoApi(cfg.token, fetchFn);
  for (const kind of ['thumb', 'full']) {
    const path = `photos/${photoName(id, kind)}`;
    const file = await api.getFile(cfg.owner, cfg.repo, path, { metaOnly: true });
    if (file) await api.deleteFile(cfg.owner, cfg.repo, path, file.sha);
  }
}
