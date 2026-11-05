// Encrypted sync through a private GitHub repository (Contents API). No storage or DOM: callers own state.
import { mergeDocs, validateDoc, sanitizeDoc } from './merge.js';
import {
  ITERATIONS, deriveKey, exportKey, importKey, seal, unseal, parseEnvelope, randomBytes, fromB64, toB64,
} from './crypto.js';

const API = 'https://api.github.com';
const DOC = 'atlas.json';
const MAX_RETRIES = 3; // after a 409: 1 attempt + 3 retries
const RATE_WAIT = 60000; // ms to wait when GitHub limits us without saying until when
// object: JSON for a file of 1–100 MB too (content empty, read through the blob).
const ACCEPT = {
  json: 'application/vnd.github+json',
  object: 'application/vnd.github.object+json',
};
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
  else if (limited) e = new SyncError('rate', MSG.rate, reset > 0 ? reset * 1000 : Date.now() + (retry > 0 ? retry * 1000 : RATE_WAIT));
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
  /** One request; `accept` is a key of ACCEPT, `pass` lists the error statuses the caller handles itself. */
  async function call(method, url, { body, accept = 'json', pass = [] } = {}) {
    let res;
    try {
      res = await fetchFn(API + url, {
        method,
        cache: 'no-store',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: ACCEPT[accept],
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

    /** {sha, bytes} or null. Files over 1 MB come without content: read through the blob. */
    async getFile(owner, repo, path) {
      const res = await call('GET', fileUrl(owner, repo, path), { accept: 'object', pass: [404] });
      if (res.status === 404) return null;
      const f = await readBody(res, 'json');
      if (f.content && f.encoding === 'base64') return { sha: f.sha, bytes: fromB64(f.content) };
      const blob = await readBody(await call('GET', `${repoUrl(owner, repo)}/git/blobs/${f.sha}`), 'json');
      return { sha: f.sha, bytes: fromB64(blob.content) };
    },

    /** Create (no sha) or update (current sha); returns the new content sha. 409 → conflict, 422 → http with status 422. */
    async putFile(owner, repo, path, bytes, sha, message) {
      const res = await call('PUT', fileUrl(owner, repo, path), {
        body: { message, content: toB64(bytes), ...(sha ? { sha } : {}) },
      });
      return (await readBody(res, 'json')).content.sha;
    },
  };
}

// ---- document ----------------------------------------------------------

function needGzip() {
  if (!globalThis.CompressionStream || !globalThis.DecompressionStream) throw new SyncError('format', MSG.gzip);
}

/** Remote file bytes → validated document. Wrong key → password; anything else unreadable or invalid → format. */
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
  } catch (e) {
    // AES-GCM failure = wrong key; bad base64, gunzip or JSON after a successful decryption = damaged data
    throw e?.name === 'OperationError' ? new SyncError('password', wrongKeyMsg) : new SyncError('format', MSG.remote);
  }
  const clean = sanitizeDoc(remote);              // single malformed items are dropped, not the whole document
  if (!clean) throw new SyncError('format', MSG.remote);
  return clean.doc;
}

/**
 * Read → decrypt → merge → PUT (with sha) only if the remote lacks something local.
 * A raced PUT (409, or 422 when creating) re-reads and re-merges with the document merged so far.
 * `pre` = file already read by the caller (null = absent); undefined = read it.
 * `rekey(bytes, {cfg, key})` (connect only): key material for the file just read; a file created by another device
 * meanwhile brings its own salt and iterations. Returns the {cfg, key} actually used.
 */
async function reconcile({ api, cfg, key, local, pre, wrongKeyMsg, rekey }) {
  if (!validateDoc(local)) throw new Error('Documento locale non valido');
  let doc = local;
  let count = 0;
  for (let attempt = 0; ; attempt++) {
    const file = attempt === 0 && pre !== undefined ? pre : await api.getFile(cfg.owner, cfg.repo, DOC);
    let behind = true;
    if (file) {
      if (rekey) ({ cfg, key } = await rekey(file.bytes, { cfg, key }));
      const remote = await openRemote(key, file.bytes, wrongKeyMsg);
      const merged = mergeDocs(doc, remote);
      doc = merged.doc;
      count += merged.count;
      behind = mergeDocs(remote, doc).count > 0;
    }
    if (!behind) return { doc, count, pushed: false, cfg };
    try {
      const text = await seal(key, fromB64(cfg.salt), cfg.iterations, doc);
      await api.putFile(cfg.owner, cfg.repo, DOC, enc.encode(text), file?.sha, 'Atlas sync');
      return { doc, count, pushed: true, cfg };
    } catch (e) {
      const raced = e instanceof SyncError && (e.code === 'conflict' || (e.code === 'http' && e.status === 422 && !file));
      if (!raced) throw e;
      if (attempt >= MAX_RETRIES) throw new SyncError('conflict', MSG.conflict);
    }
  }
}

/**
 * {cfg, key} for `password` on atlas.json: the salt and iterations of the file `bytes` when there is one
 * (an unreadable envelope → format), else a fresh salt. `prev` is reused when it already has those parameters.
 */
async function deriveCfg(base, password, bytes, prev) {
  let salt;
  let iterations;
  if (bytes) {
    try {
      const env = parseEnvelope(dec.decode(bytes));
      salt = fromB64(env.kdf.salt);
      iterations = env.kdf.iterations;
    } catch {
      throw new SyncError('format', MSG.remote);
    }
  } else {
    salt = randomBytes(16);
    iterations = ITERATIONS;
  }
  const b64 = toB64(salt);
  if (prev && prev.cfg.salt === b64 && prev.cfg.iterations === iterations) return prev;
  const key = await deriveKey(password, salt, iterations);
  return { cfg: { ...base, salt: b64, iterations, key: await exportKey(key) }, key };
}

/** Link this device: join the existing atlas.json (merging data) or create it. Returns the cfg to store. */
export async function connect({ token, repo, password, local, fetchFn }) {
  needGzip();
  const api = makeRepoApi(token, fetchFn);
  const owner = await api.getUser();
  await api.repoSize(owner, repo); // validates the repository (404 → missing)
  const file = await api.getFile(owner, repo, DOC);
  const base = { token, owner, repo };
  const { cfg, key } = await deriveCfg(base, password, file?.bytes);
  const r = await reconcile({
    api, cfg, key, local, pre: file, wrongKeyMsg: MSG.passwordConnect,
    rekey: (bytes, prev) => deriveCfg(base, password, bytes, prev),
  });
  return { cfg: r.cfg, doc: r.doc, count: r.count };
}

/** Pull, merge, push if the remote lacks newer local changes. The caller merges `doc` with its current state. */
export async function syncOnce({ cfg, local, fetchFn }) {
  needGzip();
  const api = makeRepoApi(cfg.token, fetchFn);
  const { doc, count, pushed } = await reconcile({ api, cfg, key: await importKey(cfg.key), local, wrongKeyMsg: MSG.passwordSync });
  return { doc, count, pushed };
}
