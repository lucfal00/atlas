// Encrypted sync through a secret GitHub Gist (classic token, scope gist only). No storage or DOM: callers own state.
import { mergeDocs, validateDoc, sanitizeDoc } from './merge.js';
import {
  ITERATIONS, deriveKey, exportKey, importKey, seal, unseal, parseEnvelope, randomBytes, fromB64, toB64,
} from './crypto.js';

const API = 'https://api.github.com';
const FILE = 'atlas-sync.json'; // own file name: Habits and Fitness gists (habits-sync.json, fitness-sync.json) are never matched
const DESCRIPTION = 'Atlas – dati sincronizzati (cifrati)';
const MAX_RETRIES = 3; // after a concurrent change: 1 attempt + 3 retries
const RATE_WAIT = 60000; // ms to wait when GitHub limits us without saying until when
const MAX_PAGES = 5; // gist list pages of 100 searched for the Atlas gist

const MSG = {
  network: 'Rete non disponibile',
  token: 'Token non valido o scaduto',
  forbidden: 'Accesso ai gist negato: il token deve avere lo scope gist',
  missing: 'Gist di sincronizzazione non trovato: scollega e ricollega',
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

/** SyncError for an unexpected HTTP answer. */
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

export function makeApi(token, fetchFn = (...a) => fetch(...a)) {
  async function call(method, path, body) {
    let res;
    try {
      res = await fetchFn(API + path, {
        method,
        cache: 'no-store',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch {
      throw new SyncError('network', MSG.network);
    }
    if (!res.ok) throw failure(res);
    return readBody(res, 'json');
  }

  return {
    /** Id of the Atlas gist (the one holding FILE) or null. */
    async findGist() {
      for (let page = 1; page <= MAX_PAGES; page++) {
        const list = await call('GET', `/gists?per_page=100&page=${page}`);
        const hit = list.find((g) => g.files?.[FILE]);
        if (hit) return hit.id;
        if (list.length < 100) return null;
      }
      return null;
    },
    /** {text, version} of the Atlas file; version identifies the gist revision (compared before writing). */
    async read(id) {
      const g = await call('GET', `/gists/${id}`);
      const f = g.files?.[FILE];
      if (!f) throw new SyncError('missing', MSG.missing);
      const version = g.history?.[0]?.version ?? g.updated_at;
      if (f.truncated !== true) return { text: f.content, version };
      // Truncated: fetch the full file from raw_url, never sending the token.
      try {
        const res = await fetchFn(f.raw_url, { cache: 'no-store' });
        if (!res.ok) throw new Error();
        return { text: await res.text(), version };
      } catch {
        throw new SyncError('network', MSG.network);
      }
    },
    /** Current revision of the gist (cheap: newest commit only). */
    async version(id) {
      const [c] = await call('GET', `/gists/${id}/commits?per_page=1`);
      return c?.version;
    },
    async create(content) {
      const g = await call('POST', '/gists', { description: DESCRIPTION, public: false, files: { [FILE]: { content } } });
      return g.id;
    },
    async write(id, content) {
      await call('PATCH', `/gists/${id}`, { files: { [FILE]: { content } } });
    },
  };
}

// ---- document ----------------------------------------------------------

function needGzip() {
  if (!globalThis.CompressionStream || !globalThis.DecompressionStream) throw new SyncError('format', MSG.gzip);
}

/** Remote file text → validated document. Wrong key → password; anything else unreadable or invalid → format. */
async function openRemote(key, text, wrongKeyMsg) {
  let env;
  try {
    env = parseEnvelope(text);
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
 * Read → decrypt → merge → write only if the remote lacks something local. Gists have no sha: before writing, the
 * gist revision is checked against the one just read; if another device wrote meanwhile, re-read and re-merge
 * with the document merged so far (max MAX_RETRIES retries).
 * `pre` = {text, version} already read by the caller; undefined = read it.
 */
async function reconcile({ api, cfg, key, local, pre, wrongKeyMsg }) {
  if (!validateDoc(local)) throw new Error('Documento locale non valido');
  let doc = local;
  let count = 0;
  for (let attempt = 0; ; attempt++) {
    const file = attempt === 0 && pre !== undefined ? pre : await api.read(cfg.gistId);
    const remote = await openRemote(key, file.text, wrongKeyMsg);
    const merged = mergeDocs(doc, remote);
    doc = merged.doc;
    count += merged.count;
    if (mergeDocs(remote, doc).count === 0) return { doc, count, pushed: false };
    if (!file.version || (await api.version(cfg.gistId)) === file.version) {
      await api.write(cfg.gistId, await seal(key, fromB64(cfg.salt), cfg.iterations, doc));
      return { doc, count, pushed: true };
    }
    if (attempt >= MAX_RETRIES) throw new SyncError('conflict', MSG.conflict);
  }
}

/** Link this device: join the existing Atlas gist (merging data) or create it. Returns the cfg to store. */
export async function connect({ token, password, local, fetchFn, api = makeApi(token, fetchFn), iterations = ITERATIONS }) {
  needGzip();
  if (!validateDoc(local)) throw new Error('Documento locale non valido');
  const gistId = await api.findGist();
  if (!gistId) {
    const salt = randomBytes(16);
    const key = await deriveKey(password, salt, iterations);
    const id = await api.create(await seal(key, salt, iterations, local));
    return { cfg: { token, gistId: id, salt: toB64(salt), iterations, key: await exportKey(key) }, doc: local, count: 0 };
  }
  const file = await api.read(gistId);
  let env;
  try {
    env = parseEnvelope(file.text);
  } catch {
    throw new SyncError('format', MSG.remote);
  }
  const key = await deriveKey(password, fromB64(env.kdf.salt), env.kdf.iterations);
  const cfg = { token, gistId, salt: env.kdf.salt, iterations: env.kdf.iterations, key: await exportKey(key) };
  const r = await reconcile({ api, cfg, key, local, pre: file, wrongKeyMsg: MSG.passwordConnect });
  return { cfg, doc: r.doc, count: r.count };
}

/** Pull, merge, push if the remote lacks newer local changes. The caller merges `doc` with its current state. */
export async function syncOnce({ cfg, local, fetchFn, api = makeApi(cfg.token, fetchFn) }) {
  needGzip();
  const { doc, count, pushed } = await reconcile({ api, cfg, key: await importKey(cfg.key), local, wrongKeyMsg: MSG.passwordSync });
  return { doc, count, pushed };
}
