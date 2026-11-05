import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ITERATIONS, toB64, fromB64, randomBytes, deriveKey, exportKey, importKey,
  seal, parseEnvelope, unseal, gzip, gunzip,
} from '../js/crypto.js';
import {
  SyncError, makeApi, connect, syncOnce,
} from '../js/sync.js';
import { emptyDoc } from '../js/logic.js';
import { validateDoc } from '../js/merge.js';

// ---- constants and builders --------------------------------------------

const enc = new TextEncoder();

const TOKEN = 'ghp_test';
const FILE = 'atlas-sync.json';
const PASSWORD = 'correct horse battery';
const RESET = 1893456000; // x-ratelimit-reset (seconds)

const place = (id, updatedAt, extra = {}) => ({ id, name: id, status: 'wish', deleted: false, updatedAt, ...extra });
const docWith = (parts = {}) => ({ ...emptyDoc(), ...parts });
const ids = (doc) => doc.places.map((p) => p.id).sort();

const docA = docWith({ places: [place('l_a', 100, { name: 'Dublino segreta' })] });
const docB = docWith({ places: [place('l_b', 200, { name: 'Atene antica' })] });

/** Rejects with a SyncError of this code (and message, when given). */
const rejectsSync = (promise, code, message) => assert.rejects(promise, (e) => {
  assert.ok(e instanceof SyncError, `SyncError expected, got ${e}`);
  assert.equal(e.code, code);
  if (message !== undefined) assert.equal(e.message, message);
  return true;
});

// ---- fake GitHub gists -------------------------------------------------

const reply = (status, body, headers = {}) => new Response(
  body === undefined ? null : JSON.stringify(body),
  { status, headers: { 'content-type': 'application/json', ...headers } },
);

/**
 * In-memory gists API: list, get, commits (revision), create, patch, raw. `gists` = Map id → {description, files, rev}.
 * `hook(req)` may return a Response to replace the answer. `truncateOver`: files longer than this come truncated.
 */
function makeGithub({ gists = [], counter = 0, truncateOver = 1e6 } = {}) {
  const store = new Map(gists.map(([id, g]) => [id, { ...g, files: { ...g.files } }]));
  const gh = {
    store, calls: [], hook: null, offline: false,
    add(id, files, description = '') {
      store.set(id, { description, files, rev: String(++counter) });
    },
    setContent(id, content, name = FILE) {
      const g = store.get(id);
      g.files[name] = { content };
      g.rev = String(++counter);
    },
    snapshot: () => ({ gists: [...store], counter }),
    reqs: (method, path) => gh.calls.filter((c) => c.method === method && c.path.startsWith(path)),
  };
  const view = (id, g) => ({
    id, description: g.description, updated_at: `t${g.rev}`, history: [{ version: g.rev }],
    files: Object.fromEntries(Object.entries(g.files).map(([n, f]) => {
      const big = f.content.length > truncateOver;
      return [n, { filename: n, truncated: big, content: big ? f.content.slice(0, 10) : f.content, raw_url: `https://gist.githubusercontent.com/raw/${id}/${n}` }];
    })),
  });

  function route(req) {
    const { path, method } = req;
    if (path.startsWith('/raw/')) {
      const [, , id, name] = path.split('/');
      return new Response(store.get(id).files[name].content, { status: 200 });
    }
    if (path === '/gists' && method === 'GET') {
      const per = Number(new URL(req.url).searchParams.get('per_page'));
      const page = Number(new URL(req.url).searchParams.get('page') || 1);
      const all = [...store].map(([id, g]) => view(id, g));
      return reply(200, all.slice((page - 1) * per, page * per));
    }
    if (path === '/gists' && method === 'POST') {
      const id = `g${++counter}`;
      store.set(id, { description: req.body.description, files: { ...req.body.files }, rev: String(++counter), public: req.body.public });
      return reply(201, { id });
    }
    const m = path.match(/^\/gists\/([^/]+)(\/commits)?$/);
    const g = m && store.get(m[1]);
    if (!g) return reply(404, { message: 'Not Found' });
    if (m[2]) return reply(200, [{ version: g.rev }]);
    if (method === 'GET') return reply(200, view(m[1], g));
    if (method === 'PATCH') {
      Object.assign(g.files, req.body.files);
      g.rev = String(++counter);
      return reply(200, view(m[1], g));
    }
    return reply(405, {});
  }

  gh.fetch = async (url, init = {}) => {
    const u = new URL(url);
    const req = {
      method: init.method ?? 'GET', url, path: u.pathname,
      headers: init.headers ?? {}, cache: init.cache,
      body: init.body === undefined ? undefined : JSON.parse(init.body),
    };
    gh.calls.push(req);
    if (gh.offline) throw new TypeError('fetch failed');
    const injected = await gh.hook?.(req);
    return injected ?? route(req);
  };
  return gh;
}

/** The id of the Atlas gist in the fake. */
const atlasId = (gh) => [...gh.store].find(([, g]) => g.files[FILE])[0];

/** Another device writes this document to the Atlas gist, sealed with the cfg key. */
async function remoteWrite(gh, cfg, doc) {
  gh.setContent(cfg.gistId, await seal(await importKey(cfg.key), fromB64(cfg.salt), cfg.iterations, doc));
}

async function remoteDoc(gh, cfg) {
  return unseal(await importKey(cfg.key), parseEnvelope(gh.store.get(cfg.gistId).files[FILE].content));
}

/** Gist text sealed with the cfg key around arbitrary plaintext bytes (not through seal()); `patch` overrides envelope fields. */
async function rawEnvelope(cfg, plain, patch = {}) {
  const iv = randomBytes(12);
  const data = await globalThis.crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await importKey(cfg.key), plain);
  return JSON.stringify({
    app: 'atlas', v: 1, kdf: { name: 'PBKDF2-SHA256', iterations: cfg.iterations, salt: cfg.salt },
    iv: toB64(iv), z: 'gzip', data: toB64(data), ...patch,
  });
}

/** Gists + cfg of a device that has connected once (one PBKDF2 derivation for the whole file). */
let baseP;
const base = () => (baseP ??= (async () => {
  const gh = makeGithub();
  const { cfg } = await connect({ token: TOKEN, password: PASSWORD, local: docA, fetchFn: gh.fetch });
  return { snap: gh.snapshot(), cfg };
})());

async function fresh() {
  const { snap, cfg } = await base();
  return { gh: makeGithub(snap), cfg };
}

/** Runs fn with CompressionStream missing, as on an old browser. */
async function withoutGzip(fn) {
  const desc = Object.getOwnPropertyDescriptor(globalThis, 'CompressionStream');
  Object.defineProperty(globalThis, 'CompressionStream', { value: undefined, configurable: true, writable: true });
  try {
    return await fn();
  } finally {
    Object.defineProperty(globalThis, 'CompressionStream', desc);
  }
}

// ---- crypto: base64 ----------------------------------------------------

test('base64: round trip on every byte value and on a large array', () => {
  const all = Uint8Array.from({ length: 256 }, (_, i) => i);
  assert.deepEqual(fromB64(toB64(all)), all);
  const big = new Uint8Array(400000);
  for (let i = 0; i < big.length; i += 65536) globalThis.crypto.getRandomValues(big.subarray(i, i + 65536));
  const text = toB64(big);
  assert.equal(text, Buffer.from(big).toString('base64'));
  assert.deepEqual(fromB64(text), big);
});

test('base64: toB64 takes ArrayBuffer and subarray views; fromB64 ignores the newlines GitHub inserts', () => {
  const bytes = Uint8Array.from({ length: 200 }, (_, i) => (i * 7) & 255);
  assert.equal(toB64(bytes.buffer), Buffer.from(bytes).toString('base64'));
  assert.equal(toB64(bytes.subarray(10, 20)), Buffer.from(bytes.subarray(10, 20)).toString('base64'));
  const wrapped = `${Buffer.from(bytes).toString('base64').replace(/(.{60})/g, '$1\n')}\n`;
  assert.ok(wrapped.includes('\n'));
  assert.deepEqual(fromB64(wrapped), bytes);
});

// ---- crypto: envelope --------------------------------------------------

test('envelope: seal → parseEnvelope → unseal round trip, gzip + AES-GCM, nothing readable', async () => {
  const salt = randomBytes(16);
  const key = await deriveKey('pw-di-prova', salt, 1000);
  const doc = docWith({ places: [place('l_a', 1, { name: 'Dublino segreta' })] });
  const text = await seal(key, salt, 1000, doc);
  assert.ok(!text.includes('Dublino'));
  const env = parseEnvelope(text);
  assert.deepEqual(Object.keys(env), ['app', 'v', 'kdf', 'iv', 'z', 'data']);
  assert.equal(env.app, 'atlas');
  assert.equal(env.v, 1);
  assert.equal(env.z, 'gzip');
  assert.deepEqual(env.kdf, { name: 'PBKDF2-SHA256', iterations: 1000, salt: toB64(salt) });
  assert.equal(fromB64(env.iv).length, 12);
  assert.deepEqual(await unseal(key, env), doc);
  const again = parseEnvelope(await seal(key, salt, 1000, doc));
  assert.notEqual(again.iv, env.iv, 'fresh IV for every seal');
  assert.notEqual(again.data, env.data);
});

test('envelope: unseal with another key throws; the key survives export/import', async () => {
  const salt = randomBytes(16);
  const key = await deriveKey('uno', salt, 1000);
  const other = await deriveKey('due', salt, 1000);
  const env = parseEnvelope(await seal(key, salt, 1000, { x: 1 }));
  await assert.rejects(unseal(other, env));
  const back = await importKey(await exportKey(key));
  assert.deepEqual(await unseal(back, env), { x: 1 });
  assert.equal(ITERATIONS, 310000);
});

test('envelope: unseal fails with OperationError on a wrong key, with another error on damaged data', async () => {
  const salt = randomBytes(16);
  const key = await deriveKey('uno', salt, 1000);
  const env = parseEnvelope(await seal(key, salt, 1000, { x: 1 }));
  await assert.rejects(unseal(await deriveKey('due', salt, 1000), env), { name: 'OperationError' });
  const damaged = async (plain, patch) => {
    const iv = randomBytes(12);
    const data = await globalThis.crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plain);
    return { ...env, iv: toB64(iv), data: toB64(data), ...patch };
  };
  const ok = await gzip(enc.encode('{"x":1}'));
  const cases = [
    ['not gzip', await damaged(enc.encode('plain text, not gzip'))],
    ['gzip of non-JSON', await damaged(await gzip(enc.encode('{oops')))],
    ['invalid base64 in data', await damaged(ok, { data: '***' })],
    ['invalid base64 in iv', await damaged(ok, { iv: '***' })],
  ];
  assert.deepEqual(await unseal(key, await damaged(ok)), { x: 1 }, 'the helper builds a valid envelope');
  for (const [name, e] of cases) {
    await assert.rejects(unseal(key, e), (err) => err.name !== 'OperationError', name);
  }
});

test('envelope: parseEnvelope rejects other apps, other compression, bad shapes and non-JSON', async () => {
  const salt = randomBytes(16);
  const key = await deriveKey('pw', salt, 1000);
  const good = JSON.parse(await seal(key, salt, 1000, {}));
  const bad = (patch) => JSON.stringify({ ...good, ...patch });
  assert.doesNotThrow(() => parseEnvelope(JSON.stringify(good)));
  assert.throws(() => parseEnvelope(bad({ app: 'habits' })));
  assert.throws(() => parseEnvelope(bad({ z: undefined })));
  assert.throws(() => parseEnvelope(bad({ z: 'deflate' })));
  assert.throws(() => parseEnvelope(bad({ v: 2 })));
  assert.throws(() => parseEnvelope(bad({ kdf: {} })));
  assert.throws(() => parseEnvelope(bad({ iv: '' })));
  assert.throws(() => parseEnvelope(bad({ data: undefined })));
  assert.throws(() => parseEnvelope('null'));
  assert.throws(() => parseEnvelope('not json'));
});

// ---- crypto: gzip --------------------------------------

test('gzip/gunzip: round trip, real compression, garbage rejected', async () => {
  const input = enc.encode('abc'.repeat(5000));
  const z = await gzip(input);
  assert.ok(z instanceof Uint8Array);
  assert.deepEqual([z[0], z[1]], [0x1f, 0x8b]);
  assert.ok(z.length < input.length / 10);
  assert.deepEqual(await gunzip(z), input);
  await assert.rejects(gunzip(randomBytes(64)));
});

// ---- makeApi -----------------------------------------------------------

test('api: every request carries the auth, version and no-store headers', async () => {
  const gh = makeGithub();
  const api = makeApi(TOKEN, gh.fetch);
  assert.equal(await api.findGist(), null);
  const id = await api.create('hello');
  await api.read(id);
  await api.version(id);
  await api.write(id, 'bye');
  assert.equal(gh.calls.length, 5);
  for (const c of gh.calls) {
    assert.ok(c.url.startsWith('https://api.github.com/'));
    assert.equal(c.headers.Authorization, `Bearer ${TOKEN}`);
    assert.equal(c.headers.Accept, 'application/vnd.github+json');
    assert.equal(c.headers['X-GitHub-Api-Version'], '2022-11-28');
    assert.equal(c.cache, 'no-store');
  }
});

test('api: create makes a SECRET gist with the Atlas file only; write patches only that file', async () => {
  const gh = makeGithub();
  const api = makeApi(TOKEN, gh.fetch);
  const id = await api.create('uno');
  const post = gh.reqs('POST', '/gists')[0];
  assert.equal(post.body.public, false);
  assert.deepEqual(Object.keys(post.body.files), [FILE]);
  assert.match(post.body.description, /Atlas/);
  await api.write(id, 'due');
  assert.deepEqual(Object.keys(gh.reqs('PATCH', `/gists/${id}`)[0].body.files), [FILE]);
  assert.deepEqual(await api.read(id), { text: 'due', version: gh.store.get(id).rev });
});

test('api: findGist matches only the Atlas file, never the gists of Habits or Fitness', async () => {
  const gh = makeGithub();
  gh.add('h1', { 'habits-sync.json': { content: 'x' } }, 'Habits – dati sincronizzati (cifrati)');
  gh.add('f1', { 'fitness-sync.json': { content: 'x' } }, 'Fitness – dati sincronizzati (cifrati)');
  gh.add('o1', { 'note.txt': { content: 'x' } }, 'Atlas notes');
  const api = makeApi(TOKEN, gh.fetch);
  assert.equal(await api.findGist(), null);
  gh.add('a1', { [FILE]: { content: 'x' } });
  assert.equal(await api.findGist(), 'a1');
});

test('api: findGist follows the pages of the list', async () => {
  const gh = makeGithub();
  for (let i = 0; i < 100; i++) gh.add(`o${i}`, { 'note.txt': { content: 'x' } });
  gh.add('a1', { [FILE]: { content: 'x' } });
  assert.equal(await makeApi(TOKEN, gh.fetch).findGist(), 'a1');
  assert.equal(gh.reqs('GET', '/gists').length, 2);
});

test('api: truncated file is read from raw_url without the token', async () => {
  const gh = makeGithub({ truncateOver: 100 });
  const api = makeApi(TOKEN, gh.fetch);
  const text = 'z'.repeat(5000);
  const id = await api.create(text);
  assert.equal((await api.read(id)).text, text);
  const raw = gh.calls.at(-1);
  assert.ok(raw.url.startsWith('https://gist.githubusercontent.com/'));
  assert.equal(raw.headers.Authorization, undefined);
});

test('api: gist without the Atlas file, or unknown gist → missing', async () => {
  const gh = makeGithub();
  gh.add('x1', { 'other.txt': { content: 'x' } });
  const api = makeApi(TOKEN, gh.fetch);
  await rejectsSync(api.read('x1'), 'missing', 'Gist di sincronizzazione non trovato: scollega e ricollega');
  await rejectsSync(api.read('nope'), 'missing');
  await rejectsSync(api.write('nope', 'x'), 'missing');
});

const ERRORS = [
  ['401 → token', () => reply(401, {}), 'token', 'Token non valido o scaduto'],
  ['403 → forbidden', () => reply(403, {}), 'forbidden', 'Accesso ai gist negato: il token deve avere lo scope gist'],
  ['403 with x-ratelimit-remaining 0 → rate', () => reply(403, {}, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(RESET) }),
    'rate', 'Limite di richieste GitHub raggiunto'],
  ['429 → rate', () => reply(429, {}, { 'x-ratelimit-reset': String(RESET) }), 'rate', 'Limite di richieste GitHub raggiunto'],
  ['500 → http', () => reply(500, {}), 'http', 'Errore GitHub 500'],
];
for (const [name, make, code, message] of ERRORS) {
  test(`api: ${name}`, async () => {
    const gh = makeGithub();
    gh.hook = make;
    await rejectsSync(makeApi(TOKEN, gh.fetch).findGist(), code, message);
  });
}

test('api: rate limit carries resetAt in ms; a 403 with remaining > 0 is not a rate limit', async () => {
  const gh = makeGithub();
  gh.hook = () => reply(403, {}, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(RESET) });
  await assert.rejects(makeApi(TOKEN, gh.fetch).findGist(), (e) => e.code === 'rate' && e.resetAt === RESET * 1000);
  gh.hook = () => reply(403, {}, { 'x-ratelimit-remaining': '4999', 'x-ratelimit-reset': String(RESET) });
  await rejectsSync(makeApi(TOKEN, gh.fetch).findGist(), 'forbidden');
});

test('api: secondary rate limit (retry-after) and no reset header → resetAt about now + wait', async () => {
  const gh = makeGithub();
  const api = makeApi(TOKEN, gh.fetch);
  const cases = [[reply(403, {}, { 'retry-after': '60' }), 60000], [reply(429, {}), 60000],
    [reply(403, {}, { 'x-ratelimit-remaining': '0' }), 60000]];
  for (const [answer, wait] of cases) {
    gh.hook = () => answer.clone();
    const t0 = Date.now();
    await assert.rejects(api.findGist(), (e) => {
      assert.equal(e.code, 'rate');
      assert.ok(e.resetAt >= t0 + wait && e.resetAt <= Date.now() + wait, `resetAt ${e.resetAt - t0} ms ahead`);
      return true;
    });
  }
});

test('api: a 200 body that is not JSON, or that errors while read → network', async () => {
  const gh = makeGithub();
  const api = makeApi(TOKEN, gh.fetch);
  gh.hook = () => new Response('<html>captive portal</html>', { status: 200 });
  await rejectsSync(api.findGist(), 'network', 'Rete non disponibile');
  gh.hook = () => new Response(new ReadableStream({ start: (c) => c.error(new TypeError('terminated')) }), { status: 200 });
  await rejectsSync(api.findGist(), 'network', 'Rete non disponibile');
});

test('api: fetch that throws → network', async () => {
  const gh = makeGithub();
  gh.offline = true;
  const api = makeApi(TOKEN, gh.fetch);
  await rejectsSync(api.findGist(), 'network', 'Rete non disponibile');
  await rejectsSync(api.read('a'), 'network');
  await rejectsSync(api.write('a', 'x'), 'network');
});

// ---- connect -----------------------------------------------------------

test('connect: no Atlas gist → creates a secret one (valid envelope, unreadable)', async () => {
  const gh = makeGithub();
  gh.add('h1', { 'habits-sync.json': { content: 'habits data' } });
  const r = await connect({ token: TOKEN, password: PASSWORD, local: docA, fetchFn: gh.fetch });
  assert.deepEqual(Object.keys(r.cfg).sort(), ['gistId', 'iterations', 'key', 'salt', 'token']);
  assert.equal(r.cfg.token, TOKEN);
  assert.equal(r.cfg.iterations, ITERATIONS);
  assert.equal(fromB64(r.cfg.salt).length, 16);
  assert.ok(!JSON.stringify(r.cfg).includes(PASSWORD), 'the password is never stored');
  assert.deepEqual(r.doc, docA);
  assert.equal(r.count, 0);

  assert.equal(gh.reqs('POST', '/gists').length, 1);
  assert.equal(gh.reqs('POST', '/gists')[0].body.public, false);
  assert.equal(r.cfg.gistId, atlasId(gh));
  const text = gh.store.get(r.cfg.gistId).files[FILE].content;
  assert.ok(!text.includes('Dublino'));
  const env = parseEnvelope(text);
  assert.equal(env.app, 'atlas');
  assert.equal(env.z, 'gzip');
  assert.equal(env.kdf.name, 'PBKDF2-SHA256');
  assert.equal(env.kdf.salt, r.cfg.salt);
  assert.deepEqual(await unseal(await importKey(r.cfg.key), env), docA);
  // the other apps' gists are untouched
  assert.equal(gh.store.get('h1').files['habits-sync.json'].content, 'habits data');
  assert.equal(gh.calls.filter((c) => c.method !== 'GET' && !c.path.startsWith('/gists/g')).length, 1);
});

test('connect: second device with the same password merges the data and pushes its news', async () => {
  const { gh, cfg: cfgA } = await fresh();
  const r = await connect({ token: TOKEN, password: PASSWORD, local: docB, fetchFn: gh.fetch });
  assert.deepEqual(ids(r.doc), ['l_a', 'l_b']);
  assert.equal(r.count, 1);
  assert.equal(r.cfg.gistId, cfgA.gistId);
  assert.equal(r.cfg.key, cfgA.key, 'same password and salt → same key');
  assert.equal(r.cfg.salt, cfgA.salt);
  assert.equal(gh.reqs('PATCH', '/gists/').length, 1);
  assert.equal(gh.reqs('POST', '/gists').length, 0, 'no second gist');
  assert.deepEqual(ids(await remoteDoc(gh, r.cfg)), ['l_a', 'l_b']);
  // the first device now receives what the second added
  const back = await syncOnce({ cfg: cfgA, local: docA, fetchFn: gh.fetch });
  assert.deepEqual(ids(back.doc), ['l_a', 'l_b']);
  assert.equal(back.count, 1);
});

test('connect: wrong password → password error, nothing written', async () => {
  const { gh } = await fresh();
  await rejectsSync(
    connect({ token: TOKEN, password: 'password sbagliata', local: docB, fetchFn: gh.fetch }),
    'password', 'Password errata',
  );
  assert.equal(gh.calls.filter((c) => c.method !== 'GET').length, 0);
});

test('connect: bad token → token; rate limit → rate', async () => {
  const gh = makeGithub();
  gh.hook = () => reply(401, {});
  await rejectsSync(connect({ token: TOKEN, password: PASSWORD, local: docA, fetchFn: gh.fetch }), 'token', 'Token non valido o scaduto');
  gh.hook = () => reply(403, {}, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(RESET) });
  await rejectsSync(connect({ token: TOKEN, password: PASSWORD, local: docA, fetchFn: gh.fetch }), 'rate');
});

test('connect: remote file that is not an Atlas envelope → format, nothing written', async () => {
  for (const text of ['not json', JSON.stringify({ app: 'habits', v: 1 }), JSON.stringify({ hello: 'world' })]) {
    const gh = makeGithub();
    gh.add('a1', { [FILE]: { content: text } });
    await rejectsSync(connect({ token: TOKEN, password: PASSWORD, local: docA, fetchFn: gh.fetch }), 'format', 'Dati remoti non validi');
    assert.equal(gh.calls.filter((c) => c.method !== 'GET').length, 0);
  }
});

test('connect: right password but damaged payload → format, not "Password errata"', async () => {
  const { gh, cfg } = await fresh();
  gh.setContent(cfg.gistId, await rawEnvelope(cfg, enc.encode('plain text, not gzip')));
  await rejectsSync(connect({ token: TOKEN, password: PASSWORD, local: docB, fetchFn: gh.fetch }), 'format', 'Dati remoti non validi');
  assert.equal(gh.reqs('PATCH', '/gists/').length, 0);
});

test('connect/syncOnce: CompressionStream missing → format, before any network call', async () => {
  const { gh, cfg } = await fresh();
  await withoutGzip(async () => {
    await rejectsSync(connect({ token: TOKEN, password: PASSWORD, local: docA, fetchFn: gh.fetch }),
      'format', 'Browser non supportato per la sincronizzazione');
    await rejectsSync(syncOnce({ cfg, local: docA, fetchFn: gh.fetch }),
      'format', 'Browser non supportato per la sincronizzazione');
  });
  assert.equal(gh.calls.length, 0);
});

// ---- syncOnce ----------------------------------------------------------

test('syncOnce: nothing newer locally → no write', async () => {
  const { gh, cfg } = await fresh();
  const r = await syncOnce({ cfg, local: docA, fetchFn: gh.fetch });
  assert.equal(r.pushed, false);
  assert.equal(r.count, 0);
  assert.deepEqual(r.doc, docA);
  assert.equal(gh.reqs('PATCH', '/gists/').length, 0);
});

test('syncOnce: remote newer → merged into the returned document, still no write', async () => {
  const { gh, cfg } = await fresh();
  await remoteWrite(gh, cfg, docWith({ places: [place('l_a', 300, { name: 'Dublino nuova' }), place('l_c', 50)] }));
  const r = await syncOnce({ cfg, local: docA, fetchFn: gh.fetch });
  assert.equal(r.pushed, false);
  assert.equal(r.count, 2);
  assert.equal(r.doc.places.find((p) => p.id === 'l_a').name, 'Dublino nuova');
  assert.deepEqual(ids(r.doc), ['l_a', 'l_c']);
  assert.equal(gh.reqs('PATCH', '/gists/').length, 0);
});

test('syncOnce: local newer → PATCH with fresh IV, same salt and iterations', async () => {
  const { gh, cfg } = await fresh();
  const ivBefore = parseEnvelope(gh.store.get(cfg.gistId).files[FILE].content).iv;
  const local = docWith({ places: [place('l_a', 400, { name: 'Dublino locale' }), place('l_n', 10)] });
  const r = await syncOnce({ cfg, local, fetchFn: gh.fetch });
  assert.equal(r.pushed, true);
  assert.equal(gh.reqs('PATCH', '/gists/').length, 1);
  const env = parseEnvelope(gh.store.get(cfg.gistId).files[FILE].content);
  assert.notEqual(env.iv, ivBefore);
  assert.equal(env.kdf.salt, cfg.salt);
  assert.equal(env.kdf.iterations, cfg.iterations);
  const stored = await remoteDoc(gh, cfg);
  assert.ok(validateDoc(stored));
  assert.deepEqual(stored.places.map((p) => p.name), ['Dublino locale', 'l_n']);
});

test('syncOnce: gist deleted → missing', async () => {
  const { gh, cfg } = await fresh();
  gh.store.clear();
  await rejectsSync(syncOnce({ cfg, local: docA, fetchFn: gh.fetch }), 'missing');
});

test('syncOnce: remote sealed with another key → password changed', async () => {
  const { gh, cfg } = await fresh();
  const salt = randomBytes(16);
  const other = await deriveKey('nuova password', salt, 1000);
  gh.setContent(cfg.gistId, await seal(other, salt, 1000, docB));
  await rejectsSync(syncOnce({ cfg, local: docA, fetchFn: gh.fetch }),
    'password', 'Password cambiata su un altro dispositivo: ricollega');
  assert.equal(gh.reqs('PATCH', '/gists/').length, 0);
});

test('syncOnce: remote that decrypts to an invalid document, or is not an envelope → format', async () => {
  const { gh, cfg } = await fresh();
  await remoteWrite(gh, cfg, { version: 2, nonsense: true });
  await rejectsSync(syncOnce({ cfg, local: docA, fetchFn: gh.fetch }), 'format', 'Dati remoti non validi');
  gh.setContent(cfg.gistId, '{"app":"atlas"}');
  await rejectsSync(syncOnce({ cfg, local: docA, fetchFn: gh.fetch }), 'format', 'Dati remoti non validi');
});

test('syncOnce: right key but damaged payload (not gzip, not JSON, bad base64) → format, not password', async () => {
  const { gh, cfg } = await fresh();
  const goodZ = await gzip(enc.encode(JSON.stringify(docA)));
  const damaged = [
    ['not gzip', await rawEnvelope(cfg, enc.encode('plain text, not gzip'))],
    ['gzip of non-JSON', await rawEnvelope(cfg, await gzip(enc.encode('{oops')))],
    ['bad base64 in data', await rawEnvelope(cfg, goodZ, { data: '***' })],
    ['bad base64 in iv', await rawEnvelope(cfg, goodZ, { iv: '***' })],
  ];
  assert.ok(validateDoc(JSON.parse(new TextDecoder().decode(await gunzip(goodZ)))), 'control: the undamaged payload is valid');
  for (const [name, text] of damaged) {
    gh.setContent(cfg.gistId, text);
    await assert.rejects(
      syncOnce({ cfg, local: docA, fetchFn: gh.fetch }),
      (e) => e instanceof SyncError && e.code === 'format' && e.message === 'Dati remoti non validi',
      name,
    );
  }
  assert.equal(gh.reqs('PATCH', '/gists/').length, 0);
  gh.setContent(cfg.gistId, await rawEnvelope(cfg, goodZ));
  assert.deepEqual((await syncOnce({ cfg, local: docA, fetchFn: gh.fetch })).doc, docA);
});

test('syncOnce: concurrent change between read and write → re-read, merge with what was merged so far, retry', async () => {
  const { gh, cfg } = await fresh();
  let raced = false;
  gh.hook = async (req) => {
    if (req.path.endsWith('/commits') && !raced) {
      raced = true; // another device writes between our read and our write
      await remoteWrite(gh, cfg, docWith({ places: [place('l_a', 100, { name: 'Dublino segreta' }), place('l_x', 150)] }));
    }
    return undefined;
  };
  const local = docWith({ places: [place('l_a', 100, { name: 'Dublino segreta' }), place('l_y', 160)] });
  const r = await syncOnce({ cfg, local, fetchFn: gh.fetch });
  assert.equal(r.pushed, true);
  assert.deepEqual(ids(r.doc), ['l_a', 'l_x', 'l_y']);
  assert.equal(gh.reqs('PATCH', '/gists/').length, 1, 'only the retry writes');
  assert.equal(gh.reqs('GET', `/gists/${cfg.gistId}`).filter((c) => !c.path.endsWith('/commits')).length, 2);
  assert.deepEqual(ids(await remoteDoc(gh, cfg)), ['l_a', 'l_x', 'l_y']);
});

test('syncOnce: 4 consecutive concurrent changes → conflict error, nothing written', async () => {
  const { gh, cfg } = await fresh();
  gh.hook = (req) => {
    if (req.path.endsWith('/commits')) gh.setContent(cfg.gistId, gh.store.get(cfg.gistId).files[FILE].content);
    return undefined;
  };
  const local = docWith({ places: [place('l_y', 160)] });
  await rejectsSync(syncOnce({ cfg, local, fetchFn: gh.fetch }), 'conflict', 'Riprova più tardi');
  assert.equal(gh.reqs('PATCH', '/gists/').length, 0);
  assert.equal(gh.reqs('GET', '/gists/').filter((c) => c.path.endsWith('/commits')).length, 4);
});

test('syncOnce: file over 1 MB (truncated in the response) is read through raw_url', async () => {
  const { gh, cfg } = await fresh();
  const noise = new Uint8Array(1500000);
  for (let i = 0; i < noise.length; i += 65536) globalThis.crypto.getRandomValues(noise.subarray(i, i + 65536));
  const note = Buffer.from(noise).toString('base64');
  await syncOnce({ cfg, local: docWith({ places: [place('l_big', 500, { note })] }), fetchFn: gh.fetch });
  assert.ok(gh.store.get(cfg.gistId).files[FILE].content.length > 1e6);

  gh.calls.length = 0;
  const r = await syncOnce({ cfg, local: docWith(), fetchFn: gh.fetch });
  assert.deepEqual(ids(r.doc), ['l_a', 'l_big']);
  assert.equal(r.doc.places.find((p) => p.id === 'l_big').note, note);
  assert.equal(gh.calls.filter((c) => c.url.startsWith('https://gist.githubusercontent.com/')).length, 1);
});

test('syncOnce: 401 → token, 403 → forbidden, 403 with limit → rate + resetAt, throw → network', async () => {
  const { gh, cfg } = await fresh();
  const run = () => syncOnce({ cfg, local: docA, fetchFn: gh.fetch });
  gh.hook = () => reply(401, {});
  await rejectsSync(run(), 'token', 'Token non valido o scaduto');
  gh.hook = () => reply(403, {});
  await rejectsSync(run(), 'forbidden');
  gh.hook = () => reply(403, {}, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(RESET) });
  await assert.rejects(run(), (e) => e instanceof SyncError && e.code === 'rate' && e.resetAt === RESET * 1000);
  gh.hook = null;
  gh.offline = true;
  await rejectsSync(run(), 'network', 'Rete non disponibile');
});
