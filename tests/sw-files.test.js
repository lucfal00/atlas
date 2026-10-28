import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, posix } from 'node:path';

// cache.addAll() rejects as a whole when one file is missing, so a stale FILES list breaks the service worker install.
// A file added later (a module, an icon, a geo file) must be added to FILES in sw.js: this test fails until it is.
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const source = readFileSync(join(ROOT, 'sw.js'), 'utf8');
const block = /const FILES = \[([\s\S]*?)\];/.exec(source);
const FILES = block ? [...block[1].matchAll(/'([^']+)'/g)].map((m) => m[1]) : [];
const listed = new Set(FILES.map((f) => posix.normalize(f)));

/** Files (not directories) under `dir`, as ROOT-relative POSIX paths, optionally recursive and filtered by name. */
function walk(dir, { deep = false, match = () => true } = {}) {
  const out = [];
  for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    const rel = posix.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (deep) out.push(...walk(rel, { deep, match }));
    } else if (match(entry.name)) {
      out.push(rel);
    }
  }
  return out;
}

test('sw.js FILES parses and has no duplicates', () => {
  assert.ok(block, 'const FILES = [...] not found in sw.js');
  assert.ok(FILES.length > 0);
  assert.equal(listed.size, FILES.length, 'duplicate entries in FILES');
  assert.ok(FILES.includes('./'), "FILES must include './'");
});

test('every FILES entry exists on disk', () => {
  for (const f of FILES) assert.ok(existsSync(join(ROOT, f)), `${f} is in FILES but missing on disk`);
});

test('every shell file, module, icon and geo file is precached', () => {
  const required = [
    'index.html', 'style.css', 'manifest.webmanifest',
    ...walk('js', { deep: true, match: (n) => n.endsWith('.js') }),
    ...walk('icons'),
    ...walk('geo', { match: (n) => n.endsWith('.json') }),
  ];
  assert.ok(required.some((f) => f.startsWith('js/views/')), 'expected to find js/views/*.js');
  assert.ok(required.some((f) => f.startsWith('icons/')), 'expected to find icons/*');
  assert.ok(required.some((f) => f.startsWith('geo/')), 'expected to find geo/*.json');
  for (const f of required) assert.ok(listed.has(posix.normalize(`./${f}`)), `${f} exists but is not in sw.js FILES`);
});
