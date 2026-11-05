import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ITERATIONS, toB64, fromB64, randomBytes, deriveKey, exportKey, importKey,
  seal, parseEnvelope, unseal, gzip, gunzip,
} from '../js/crypto.js';
import {
  SyncError, makeRepoApi, connect, syncOnce,
} from '../js/sync.js';
import { emptyDoc } from '../js/logic.js';
import { validateDoc } from '../js/merge.js';

// ---- constants and builders --------------------------------------------

const enc = new TextEncoder();
const dec = new TextDecoder();

const TOKEN = 'github_pat_test';
const OWNER = 'luca-test';
const REPO = 'atlas-data';
const PASSWORD = 'correct horse battery';
const RESET = 1893456000; // x-ratelimit-reset (seconds)
const JSON_ACCEPT = 'application/vnd.github+json';
const OBJECT = 'application/vnd.github.object+json';

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

// ---- fake GitHub -------------------------------------------------------

const reply = (status, body, headers = {}) => new Response(
  body === undefined ? null : JSON.stringify(body),
  { status, headers: { 'content-type': 'application/json', ...headers } },
);
const notFound = () => reply(404, { message: 'Not Found' });
/** GitHub wraps base64 `content` every 60 characters. */
const wrap = (bytes) => `${Buffer.from(bytes).toString('base64').replace(/(.{60})/g, '$1\n')}\n`;

/**
 * In-memory GitHub: GET /user, GET /repos/o/r, contents GET/PUT/DELETE (sha checks), git/blobs, raw Accept.
 * `repo` = Map path → {sha, bytes}; sha = incrementing counter. `hook(req)` may return a Response to replace the answer.
 */
function makeGithub({ files = [], counter = 0, inlineLimit = 1e6, size = 42 } = {}) {
  const repo = new Map(files.map(([p, f]) => [p, { sha: f.sha, bytes: f.bytes.slice() }]));
  const base = `/repos/${OWNER}/${REPO}`;
  const gh = {
    repo, calls: [], hook: null, offline: false, inlineLimit,
    put(path, bytes) {
      const sha = String(++counter);
      repo.set(path, { sha, bytes: Uint8Array.from(bytes) });
      return sha;
    },
    snapshot: () => ({ files: [...repo], counter }),
    reqs: (method, path) => gh.calls.filter((c) => c.method === method && c.path.endsWith(path)),
  };

  function contents(req, file) {
    const cur = repo.get(file);
    if (req.method === 'GET') {
      if (!cur) return notFound();
      // like GitHub, a file of 1–100 MB is only served through the raw or the object media type
      if (req.headers.Accept !== OBJECT) return reply(415, { message: 'Unsupported Media Type' });
      const big = cur.bytes.length > gh.inlineLimit;
      return reply(200, {
        type: 'file', path: file, sha: cur.sha, size: cur.bytes.length,
        encoding: big ? 'none' : 'base64', content: big ? '' : wrap(cur.bytes),
      });
    }
    if (req.method === 'PUT') {
      const { content, sha } = req.body;
      if (!cur && sha !== undefined) return reply(422, { message: 'Invalid request.' });
      if (cur && sha === undefined) return reply(422, { message: 'Invalid request. "sha" wasn\'t supplied.' });
      if (cur && sha !== cur.sha) return reply(409, { message: `${file} does not match ${sha}` });
      const newSha = gh.put(file, Buffer.from(content, 'base64'));
      return reply(cur ? 200 : 201, { content: { path: file, sha: newSha }, commit: { message: req.body.message } });
    }
    if (req.method === 'DELETE') {
      if (!cur) return notFound();
      if (req.body.sha !== cur.sha) return reply(409, { message: 'does not match' });
      repo.delete(file);
      return reply(200, { commit: {} });
    }
    return reply(405, {});
  }

  function route(req) {
    const { path } = req;
    if (path === '/user') return reply(200, { login: OWNER });
    if (path === base) return reply(200, { name: REPO, size });
    if (path.startsWith(`${base}/git/blobs/`)) {
      const sha = path.slice(`${base}/git/blobs/`.length);
      const f = [...repo.values()].find((x) => x.sha === sha);
      return f ? reply(200, { sha, size: f.bytes.length, encoding: 'base64', content: wrap(f.bytes) }) : notFound();
    }
    if (path.startsWith(`${base}/contents/`)) {
      const file = path.slice(`${base}/contents/`.length).split('/').map(decodeURIComponent).join('/');
      return contents(req, file);
    }
    return notFound();
  }

  gh.fetch = async (url, init = {}) => {
    const req = {
      method: init.method ?? 'GET', url, path: new URL(url).pathname,
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

/** Another device writes this document to atlas.json, sealed with the cfg key. */
async function remoteWrite(gh, cfg, doc) {
  const text = await seal(await importKey(cfg.key), fromB64(cfg.salt), cfg.iterations, doc);
  return gh.put('atlas.json', enc.encode(text));
}

async function remoteDoc(gh, cfg) {
  const env = parseEnvelope(dec.decode(gh.repo.get('atlas.json').bytes));
  return unseal(await importKey(cfg.key), env);
}

/** atlas.json text sealed with the cfg key around arbitrary plaintext bytes (not through seal()); `patch` overrides envelope fields. */
async function rawEnvelope(cfg, plain, patch = {}) {
  const iv = randomBytes(12);
  const data = await globalThis.crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await importKey(cfg.key), plain);
  return JSON.stringify({
    app: 'atlas', v: 1, kdf: { name: 'PBKDF2-SHA256', iterations: cfg.iterations, salt: cfg.salt },
    iv: toB64(iv), z: 'gzip', data: toB64(data), ...patch,
  });
}

/** Repository + cfg of a device that has connected once (one PBKDF2 derivation for the whole file). */
let baseP;
const base = () => (baseP ??= (async () => {
  const gh = makeGithub();
  const { cfg } = await connect({ token: TOKEN, repo: REPO, password: PASSWORD, local: docA, fetchFn: gh.fetch });
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

// ---- makeRepoApi -------------------------------------------------------

test('api: every request carries the auth, version and no-store headers', async () => {
  const gh = makeGithub();
  gh.put('atlas.json', enc.encode('hi'));
  const api = makeRepoApi(TOKEN, gh.fetch);
  assert.equal(await api.getUser(), OWNER);
  await api.repoSize(OWNER, REPO);
  await api.getFile(OWNER, REPO, 'atlas.json');
  await api.putFile(OWNER, REPO, 'b.bin', enc.encode('x'), undefined, 'msg');
  assert.equal(gh.calls.length, 4);
  for (const c of gh.calls) {
    assert.ok(c.url.startsWith('https://api.github.com/'));
    assert.equal(c.headers.Authorization, `Bearer ${TOKEN}`);
    assert.equal(c.headers['X-GitHub-Api-Version'], '2022-11-28');
    assert.equal(c.cache, 'no-store');
  }
  assert.equal(gh.calls[0].headers.Accept, JSON_ACCEPT);
  assert.equal(gh.calls[1].headers.Accept, JSON_ACCEPT);
  assert.equal(gh.calls[2].headers.Accept, OBJECT, 'getFile: object media type, works for 1–100 MB files');
  assert.equal(gh.calls[3].headers.Accept, JSON_ACCEPT);
});

test('api: getFile decodes wrapped base64, returns null on 404, encodes each path segment', async () => {
  const gh = makeGithub();
  const bytes = randomBytes(500);
  const sha = gh.put('dir/a b.bin', bytes);
  const api = makeRepoApi(TOKEN, gh.fetch);
  const f = await api.getFile(OWNER, REPO, 'dir/a b.bin');
  assert.equal(f.sha, sha);
  assert.deepEqual(f.bytes, bytes);
  assert.ok(gh.calls[0].url.endsWith('/contents/dir/a%20b.bin'));
  assert.equal(await api.getFile(OWNER, REPO, 'nope.json'), null);
});

test('api: content missing (file > 1 MB) → read through git/blobs/{sha}', async () => {
  const gh = makeGithub({ inlineLimit: 100 });
  const bytes = randomBytes(5000);
  const sha = gh.put('atlas.json', bytes);
  const api = makeRepoApi(TOKEN, gh.fetch);
  const f = await api.getFile(OWNER, REPO, 'atlas.json');
  assert.equal(f.sha, sha);
  assert.deepEqual(f.bytes, bytes);
  assert.equal(gh.reqs('GET', `/git/blobs/${sha}`).length, 1);
});

test('api: putFile body and result, repoSize', async () => {
  const gh = makeGithub({ size: 1234 });
  const api = makeRepoApi(TOKEN, gh.fetch);
  const bytes = randomBytes(100);
  const sha1 = await api.putFile(OWNER, REPO, 'x.bin', bytes, undefined, 'first');
  assert.equal(gh.repo.get('x.bin').sha, sha1);
  const put = gh.calls.at(-1);
  assert.equal(put.method, 'PUT');
  assert.equal(put.body.message, 'first');
  assert.equal(put.body.content, Buffer.from(bytes).toString('base64'));
  assert.ok(!('sha' in put.body));
  const sha2 = await api.putFile(OWNER, REPO, 'x.bin', randomBytes(10), sha1, 'second');
  assert.notEqual(sha2, sha1);
  assert.equal(gh.calls.at(-1).body.sha, sha1);
  assert.equal(await api.repoSize(OWNER, REPO), 1234);
});

test('api: PUT 409 → conflict; PUT 422 → http with status 422; unknown repo → missing', async () => {
  const gh = makeGithub();
  gh.put('x.bin', randomBytes(4));
  const api = makeRepoApi(TOKEN, gh.fetch);
  await rejectsSync(api.putFile(OWNER, REPO, 'x.bin', randomBytes(4), 'old', 'm'), 'conflict', 'Riprova più tardi');
  await assert.rejects(api.putFile(OWNER, REPO, 'x.bin', randomBytes(4), undefined, 'm'), (e) => {
    assert.ok(e instanceof SyncError);
    assert.equal(e.code, 'http');
    assert.equal(e.status, 422);
    return true;
  });
  await rejectsSync(makeRepoApi(TOKEN, gh.fetch).repoSize('altro', 'repo'), 'missing', 'Repository non trovato');
  await rejectsSync(api.putFile('altro', 'repo', 'x', randomBytes(1), undefined, 'm'), 'missing');
});

const ERRORS = [
  ['401 → token', () => reply(401, {}), 'token', 'Token non valido o scaduto'],
  ['403 → forbidden', () => reply(403, {}), 'forbidden', 'Il token non ha accesso al repository'],
  ['403 with x-ratelimit-remaining 0 → rate', () => reply(403, {}, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(RESET) }),
    'rate', 'Limite di richieste GitHub raggiunto'],
  ['429 → rate', () => reply(429, {}, { 'x-ratelimit-reset': String(RESET) }), 'rate', 'Limite di richieste GitHub raggiunto'],
  ['404 → missing', () => reply(404, {}), 'missing', 'Repository non trovato'],
  ['500 → http', () => reply(500, {}), 'http', 'Errore GitHub 500'],
];
for (const [name, make, code, message] of ERRORS) {
  test(`api: ${name}`, async () => {
    const gh = makeGithub();
    gh.hook = make;
    await rejectsSync(makeRepoApi(TOKEN, gh.fetch).getUser(), code, message);
  });
}

test('api: rate limit carries resetAt in ms; a 403 with remaining > 0 is not a rate limit', async () => {
  const gh = makeGithub();
  gh.hook = () => reply(403, {}, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(RESET) });
  await assert.rejects(makeRepoApi(TOKEN, gh.fetch).getUser(), (e) => e.code === 'rate' && e.resetAt === RESET * 1000);
  gh.hook = () => reply(403, {}, { 'x-ratelimit-remaining': '4999', 'x-ratelimit-reset': String(RESET) });
  await rejectsSync(makeRepoApi(TOKEN, gh.fetch).getUser(), 'forbidden');
});

test('api: secondary rate limit (403 or 429 with retry-after) → rate with resetAt', async () => {
  const gh = makeGithub();
  const api = makeRepoApi(TOKEN, gh.fetch);
  for (const status of [403, 429]) {
    gh.hook = () => reply(status, {}, { 'retry-after': '60' });
    const t0 = Date.now();
    await assert.rejects(api.getUser(), (e) => {
      assert.equal(e.code, 'rate');
      assert.ok(e.resetAt >= t0 + 60000 && e.resetAt <= Date.now() + 60000);
      return true;
    });
  }
});

test('api: rate limit with neither x-ratelimit-reset nor retry-after → resetAt = now + 60 s', async () => {
  const gh = makeGithub();
  const api = makeRepoApi(TOKEN, gh.fetch);
  const cases = [reply(429, {}), reply(403, {}, { 'x-ratelimit-remaining': '0' })];
  for (const answer of cases) {
    gh.hook = () => answer.clone();
    const t0 = Date.now();
    await assert.rejects(api.getUser(), (e) => {
      assert.equal(e.code, 'rate');
      assert.ok(Number.isFinite(e.resetAt), 'resetAt is set');
      assert.ok(e.resetAt >= t0 + 60000 && e.resetAt <= Date.now() + 60000, `resetAt ${e.resetAt - t0} ms ahead`);
      return true;
    });
  }
});

test('api: a 200 body that is not JSON → network', async () => {
  const gh = makeGithub();
  const api = makeRepoApi(TOKEN, gh.fetch);
  gh.hook = () => new Response('<html>captive portal</html>', { status: 200 });
  await rejectsSync(api.getUser(), 'network', 'Rete non disponibile');
  await rejectsSync(api.getFile(OWNER, REPO, 'atlas.json'), 'network');
});

test('api: a body that errors while it is read (connection dropped) → network', async () => {
  const gh = makeGithub();
  gh.put('atlas.json', randomBytes(10));
  const api = makeRepoApi(TOKEN, gh.fetch);
  gh.hook = () => new Response(new ReadableStream({ start: (c) => c.error(new TypeError('terminated')) }), { status: 200 });
  await rejectsSync(api.getUser(), 'network', 'Rete non disponibile');
  await rejectsSync(api.getFile(OWNER, REPO, 'atlas.json'), 'network');
});

test('api: fetch that throws → network', async () => {
  const gh = makeGithub();
  gh.offline = true;
  const api = makeRepoApi(TOKEN, gh.fetch);
  await rejectsSync(api.getUser(), 'network', 'Rete non disponibile');
  await rejectsSync(api.getFile(OWNER, REPO, 'a'), 'network');
  await rejectsSync(api.putFile(OWNER, REPO, 'a', randomBytes(1), undefined, 'm'), 'network');
});

// ---- connect -----------------------------------------------------------

test('connect: empty repository → creates atlas.json (valid envelope, unreadable), PUT without sha', async () => {
  const gh = makeGithub();
  const r = await connect({ token: TOKEN, repo: REPO, password: PASSWORD, local: docA, fetchFn: gh.fetch });
  assert.deepEqual(Object.keys(r.cfg).sort(), ['iterations', 'key', 'owner', 'repo', 'salt', 'token']);
  assert.equal(r.cfg.token, TOKEN);
  assert.equal(r.cfg.owner, OWNER);
  assert.equal(r.cfg.repo, REPO);
  assert.equal(r.cfg.iterations, ITERATIONS);
  assert.equal(fromB64(r.cfg.salt).length, 16);
  assert.ok(!JSON.stringify(r.cfg).includes(PASSWORD), 'the password is never stored');
  assert.deepEqual(r.doc, docA);
  assert.equal(r.count, 0);

  const puts = gh.reqs('PUT', '/contents/atlas.json');
  assert.equal(puts.length, 1);
  assert.ok(!('sha' in puts[0].body));
  const text = dec.decode(gh.repo.get('atlas.json').bytes);
  assert.ok(!text.includes('Dublino'));
  const env = parseEnvelope(text);
  assert.equal(env.app, 'atlas');
  assert.equal(env.z, 'gzip');
  assert.equal(env.kdf.name, 'PBKDF2-SHA256');
  assert.equal(env.kdf.iterations, ITERATIONS);
  assert.equal(env.kdf.salt, r.cfg.salt);
  assert.deepEqual(await unseal(await importKey(r.cfg.key), env), docA);
});

test('connect: second device with the same password merges the data and pushes its news', async () => {
  const { gh, cfg: cfgA } = await fresh();
  const before = gh.repo.get('atlas.json').sha;
  const r = await connect({ token: TOKEN, repo: REPO, password: PASSWORD, local: docB, fetchFn: gh.fetch });
  assert.deepEqual(ids(r.doc), ['l_a', 'l_b']);
  assert.equal(r.count, 1);
  assert.equal(r.cfg.key, cfgA.key, 'same password and salt → same key');
  assert.equal(r.cfg.salt, cfgA.salt);
  const puts = gh.reqs('PUT', '/contents/atlas.json');
  assert.equal(puts.length, 1);
  assert.equal(puts[0].body.sha, before);
  assert.deepEqual(ids(await remoteDoc(gh, r.cfg)), ['l_a', 'l_b']);
  // the first device now receives what the second added
  const back = await syncOnce({ cfg: cfgA, local: docA, fetchFn: gh.fetch });
  assert.deepEqual(ids(back.doc), ['l_a', 'l_b']);
  assert.equal(back.count, 1);
});

test('connect: wrong password → password error, nothing written', async () => {
  const { gh } = await fresh();
  await rejectsSync(
    connect({ token: TOKEN, repo: REPO, password: 'password sbagliata', local: docB, fetchFn: gh.fetch }),
    'password', 'Password errata',
  );
  assert.equal(gh.calls.filter((c) => c.method !== 'GET').length, 0);
});

test('connect: another device creates atlas.json first (422) → adopts its salt and iterations, not a false "Password errata"', async () => {
  const gh = makeGithub();
  // the other device: same password, different salt, cheaper KDF so that the test stays fast
  const otherSalt = randomBytes(16);
  const otherKey = await deriveKey(PASSWORD, otherSalt, 1000);
  const otherText = await seal(otherKey, otherSalt, 1000, docA);
  let otherSha;
  gh.hook = (req) => {
    if (req.method === 'PUT' && req.path.endsWith('/atlas.json') && otherSha === undefined) {
      otherSha = gh.put('atlas.json', enc.encode(otherText)); // between our read (absent) and our PUT
    }
    return undefined;
  };

  const r = await connect({ token: TOKEN, repo: REPO, password: PASSWORD, local: docB, fetchFn: gh.fetch });
  assert.equal(r.cfg.salt, toB64(otherSalt), 'cfg carries the remote salt');
  assert.equal(r.cfg.iterations, 1000, 'cfg carries the remote iterations');
  assert.equal(r.cfg.key, await exportKey(otherKey));
  assert.deepEqual(ids(r.doc), ['l_a', 'l_b']);
  assert.equal(r.count, 1);

  const puts = gh.reqs('PUT', '/contents/atlas.json');
  assert.equal(puts.length, 2);
  assert.ok(!('sha' in puts[0].body), 'first attempt creates the file');
  assert.equal(puts[1].body.sha, otherSha, 'the retry updates the other device\'s file');
  const env = parseEnvelope(dec.decode(gh.repo.get('atlas.json').bytes));
  assert.equal(env.kdf.salt, toB64(otherSalt));
  assert.equal(env.kdf.iterations, 1000);
  assert.deepEqual(ids(await remoteDoc(gh, r.cfg)), ['l_a', 'l_b']);
  // the returned cfg is coherent: a later sync with it needs nothing
  const again = await syncOnce({ cfg: r.cfg, local: r.doc, fetchFn: gh.fetch });
  assert.equal(again.pushed, false);
});

test('connect: wrong password still → password error when the file shows up during the race', async () => {
  const gh = makeGithub();
  const otherSalt = randomBytes(16);
  const otherKey = await deriveKey('un\'altra password', otherSalt, 1000);
  const text = await seal(otherKey, otherSalt, 1000, docA);
  let created = false;
  gh.hook = (req) => {
    if (req.method === 'PUT' && req.path.endsWith('/atlas.json') && !created) {
      created = true;
      gh.put('atlas.json', enc.encode(text));
    }
    return undefined;
  };
  await rejectsSync(
    connect({ token: TOKEN, repo: REPO, password: PASSWORD, local: docB, fetchFn: gh.fetch }),
    'password', 'Password errata',
  );
});

test('connect: unknown repository → missing; bad token → token', async () => {
  const gh = makeGithub();
  await rejectsSync(
    connect({ token: TOKEN, repo: 'non-esiste', password: PASSWORD, local: docA, fetchFn: gh.fetch }),
    'missing', 'Repository non trovato',
  );
  gh.hook = () => reply(401, {});
  await rejectsSync(
    connect({ token: TOKEN, repo: REPO, password: PASSWORD, local: docA, fetchFn: gh.fetch }),
    'token', 'Token non valido o scaduto',
  );
});

test('connect: remote atlas.json that is not an Atlas envelope → format', async () => {
  for (const text of ['not json', JSON.stringify({ app: 'habits', v: 1 }), JSON.stringify({ hello: 'world' })]) {
    const gh = makeGithub();
    gh.put('atlas.json', enc.encode(text));
    await rejectsSync(
      connect({ token: TOKEN, repo: REPO, password: PASSWORD, local: docA, fetchFn: gh.fetch }),
      'format', 'Dati remoti non validi',
    );
    assert.equal(gh.calls.filter((c) => c.method !== 'GET').length, 0);
  }
});

test('connect/syncOnce: CompressionStream missing → format, before any network call', async () => {
  const { gh, cfg } = await fresh();
  await withoutGzip(async () => {
    await rejectsSync(
      connect({ token: TOKEN, repo: REPO, password: PASSWORD, local: docA, fetchFn: gh.fetch }),
      'format', 'Browser non supportato per la sincronizzazione',
    );
    await rejectsSync(
      syncOnce({ cfg, local: docA, fetchFn: gh.fetch }),
      'format', 'Browser non supportato per la sincronizzazione',
    );
  });
  assert.equal(gh.calls.length, 0);
});

// ---- syncOnce ----------------------------------------------------------

test('syncOnce: nothing newer locally → no PUT', async () => {
  const { gh, cfg } = await fresh();
  const r = await syncOnce({ cfg, local: docA, fetchFn: gh.fetch });
  assert.equal(r.pushed, false);
  assert.equal(r.count, 0);
  assert.deepEqual(r.doc, docA);
  assert.equal(gh.reqs('PUT', 'atlas.json').length, 0);
});

test('syncOnce: remote newer → merged into the returned document, still no PUT', async () => {
  const { gh, cfg } = await fresh();
  await remoteWrite(gh, cfg, docWith({ places: [place('l_a', 300, { name: 'Dublino nuova' }), place('l_c', 50)] }));
  const r = await syncOnce({ cfg, local: docA, fetchFn: gh.fetch });
  assert.equal(r.pushed, false);
  assert.equal(r.count, 2);
  assert.equal(r.doc.places.find((p) => p.id === 'l_a').name, 'Dublino nuova');
  assert.deepEqual(ids(r.doc), ['l_a', 'l_c']);
  assert.equal(gh.reqs('PUT', 'atlas.json').length, 0);
});

test('syncOnce: local newer → PUT with the current sha, fresh IV, same salt and iterations', async () => {
  const { gh, cfg } = await fresh();
  const sha = gh.repo.get('atlas.json').sha;
  const ivBefore = parseEnvelope(dec.decode(gh.repo.get('atlas.json').bytes)).iv;
  const local = docWith({ places: [place('l_a', 400, { name: 'Dublino locale' }), place('l_n', 10)] });
  const r = await syncOnce({ cfg, local, fetchFn: gh.fetch });
  assert.equal(r.pushed, true);
  const puts = gh.reqs('PUT', 'atlas.json');
  assert.equal(puts.length, 1);
  assert.equal(puts[0].body.sha, sha);
  assert.notEqual(gh.repo.get('atlas.json').sha, sha);
  const env = parseEnvelope(dec.decode(gh.repo.get('atlas.json').bytes));
  assert.notEqual(env.iv, ivBefore);
  assert.equal(env.kdf.salt, cfg.salt);
  assert.equal(env.kdf.iterations, cfg.iterations);
  const stored = await remoteDoc(gh, cfg);
  assert.ok(validateDoc(stored));
  assert.deepEqual(stored.places.map((p) => p.name), ['Dublino locale', 'l_n']);
});

test('syncOnce: atlas.json absent → seals the local document and PUTs without sha', async () => {
  const { gh, cfg } = await fresh();
  gh.repo.delete('atlas.json');
  const r = await syncOnce({ cfg, local: docB, fetchFn: gh.fetch });
  assert.equal(r.pushed, true);
  const puts = gh.reqs('PUT', 'atlas.json');
  assert.equal(puts.length, 1);
  assert.ok(!('sha' in puts[0].body));
  assert.deepEqual(ids(await remoteDoc(gh, cfg)), ['l_b']);
});

test('syncOnce: remote sealed with another key → password changed', async () => {
  const { gh, cfg } = await fresh();
  const salt = randomBytes(16);
  const other = await deriveKey('nuova password', salt, 1000);
  gh.put('atlas.json', enc.encode(await seal(other, salt, 1000, docB)));
  await rejectsSync(
    syncOnce({ cfg, local: docA, fetchFn: gh.fetch }),
    'password', 'Password cambiata su un altro dispositivo: ricollega',
  );
  assert.equal(gh.reqs('PUT', 'atlas.json').length, 0);
});

test('syncOnce: remote that decrypts to an invalid document, or is not an envelope → format', async () => {
  const { gh, cfg } = await fresh();
  await remoteWrite(gh, cfg, { version: 2, nonsense: true });
  await rejectsSync(syncOnce({ cfg, local: docA, fetchFn: gh.fetch }), 'format', 'Dati remoti non validi');
  gh.put('atlas.json', enc.encode('{"app":"atlas"}'));
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
  assert.ok(validateDoc(JSON.parse(dec.decode(await gunzip(goodZ)))), 'control: the undamaged payload is a valid document');
  for (const [name, text] of damaged) {
    gh.put('atlas.json', enc.encode(text));
    await assert.rejects(
      syncOnce({ cfg, local: docA, fetchFn: gh.fetch }),
      (e) => e instanceof SyncError && e.code === 'format' && e.message === 'Dati remoti non validi',
      name,
    );
  }
  assert.equal(gh.reqs('PUT', 'atlas.json').length, 0);
  // the same file, undamaged, is read fine
  gh.put('atlas.json', enc.encode(await rawEnvelope(cfg, goodZ)));
  assert.deepEqual((await syncOnce({ cfg, local: docA, fetchFn: gh.fetch })).doc, docA);
});

test('connect: right password but damaged payload → format, not "Password errata"', async () => {
  const { gh, cfg } = await fresh();
  gh.put('atlas.json', enc.encode(await rawEnvelope(cfg, enc.encode('plain text, not gzip'))));
  await rejectsSync(
    connect({ token: TOKEN, repo: REPO, password: PASSWORD, local: docB, fetchFn: gh.fetch }),
    'format', 'Dati remoti non validi',
  );
  assert.equal(gh.reqs('PUT', 'atlas.json').length, 0);
});

test('syncOnce: PUT 409 → reread, merge with what was merged so far, retry', async () => {
  const { gh, cfg } = await fresh();
  let raced = false;
  gh.hook = async (req) => {
    if (req.method === 'PUT' && req.path.endsWith('/atlas.json') && !raced) {
      raced = true; // another device writes between our read and our PUT
      await remoteWrite(gh, cfg, docWith({ places: [place('l_a', 100, { name: 'Dublino segreta' }), place('l_x', 150)] }));
    }
    return undefined;
  };
  const local = docWith({ places: [place('l_a', 100, { name: 'Dublino segreta' }), place('l_y', 160)] });
  const r = await syncOnce({ cfg, local, fetchFn: gh.fetch });
  assert.equal(r.pushed, true);
  assert.deepEqual(ids(r.doc), ['l_a', 'l_x', 'l_y']);
  const puts = gh.reqs('PUT', 'atlas.json');
  assert.equal(puts.length, 2);
  assert.notEqual(puts[1].body.sha, puts[0].body.sha, 'the retry uses the sha it just read');
  assert.equal(gh.reqs('GET', '/contents/atlas.json').length, 2);
  assert.deepEqual(ids(await remoteDoc(gh, cfg)), ['l_a', 'l_x', 'l_y']);
});

test('syncOnce: 4 consecutive conflicts → conflict error after exactly 4 PUT attempts', async () => {
  const { gh, cfg } = await fresh();
  gh.hook = (req) => {
    if (req.method === 'PUT' && req.path.endsWith('/atlas.json')) {
      gh.put('atlas.json', gh.repo.get('atlas.json').bytes); // someone else wins every time
    }
    return undefined;
  };
  const local = docWith({ places: [place('l_y', 160)] });
  await rejectsSync(syncOnce({ cfg, local, fetchFn: gh.fetch }), 'conflict', 'Riprova più tardi');
  assert.equal(gh.reqs('PUT', 'atlas.json').length, 4);
});

test('syncOnce: atlas.json over 1 MB (response without content) is read through the blob', async () => {
  const { gh, cfg } = await fresh();
  const noise = new Uint8Array(1500000);
  for (let i = 0; i < noise.length; i += 65536) globalThis.crypto.getRandomValues(noise.subarray(i, i + 65536));
  const note = Buffer.from(noise).toString('base64');
  const bigDoc = docWith({ places: [place('l_big', 500, { note })] });
  await syncOnce({ cfg, local: bigDoc, fetchFn: gh.fetch });
  const file = gh.repo.get('atlas.json');
  assert.ok(file.bytes.length > 1e6, `atlas.json is ${file.bytes.length} bytes`);

  gh.calls.length = 0;
  const r = await syncOnce({ cfg, local: docWith(), fetchFn: gh.fetch });
  assert.deepEqual(ids(r.doc), ['l_a', 'l_big']); // l_a was already in the repository
  assert.equal(r.doc.places.find((p) => p.id === 'l_big').note, note);
  assert.equal(r.count, 2);
  assert.equal(gh.reqs('GET', `/git/blobs/${file.sha}`).length, 1);
});

test('syncOnce: 401 → token, 403 → forbidden, 403 with limit → rate + resetAt, throw → network', async () => {
  const { gh, cfg } = await fresh();
  const run = () => syncOnce({ cfg, local: docA, fetchFn: gh.fetch });
  gh.hook = () => reply(401, {});
  await rejectsSync(run(), 'token', 'Token non valido o scaduto');
  gh.hook = () => reply(403, {});
  await rejectsSync(run(), 'forbidden', 'Il token non ha accesso al repository');
  gh.hook = () => reply(403, {}, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(RESET) });
  await assert.rejects(run(), (e) => e instanceof SyncError && e.code === 'rate' && e.resetAt === RESET * 1000);
  gh.hook = null;
  gh.offline = true;
  await rejectsSync(run(), 'network', 'Rete non disponibile');
});
