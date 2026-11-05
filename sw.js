// Offline support. Pages: network first (a new version shows on the next launch), cache when offline.
// Other same-origin files: answer from cache, refresh the cache in the background.
// Cross-origin requests (api.github.com, nominatim.openstreetmap.org) are never touched.
const CACHE = 'atlas-v6';
const FILES = [
  './', './index.html', './style.css', './manifest.webmanifest',
  './js/app.js', './js/db.js', './js/store.js', './js/logic.js', './js/geo.js', './js/merge.js',
  './js/map.js', './js/crypto.js', './js/sync.js', './js/search.js', './js/ui.js',
  './js/views/map.js', './js/views/places.js', './js/views/place.js', './js/views/place-edit.js',
  './js/views/trips.js', './js/views/trip.js', './js/views/trip-edit.js', './js/views/settings.js',
  './geo/world.json', './geo/italia.json',
  './icons/atlas-v1.svg', './icons/atlas-v1-192.png', './icons/atlas-v1-512.png',
  './icons/atlas-v1-maskable-512.png', './icons/atlas-v1-apple-180.png',
];
const PAGE_TIMEOUT_MS = 3000;

self.addEventListener('install', (e) => {
  // 'reload' bypasses the HTTP cache (GitHub Pages sends max-age=600) so a new version precaches fresh files.
  const requests = FILES.map((f) => new Request(f, { cache: 'reload' }));
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(requests)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    // Same origin as the other apps on lucfal00.github.io: only Atlas' own old caches are ours to delete.
    .then((keys) => Promise.all(keys.filter((k) => k.startsWith('atlas-') && k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

async function page(req) {
  const cache = await caches.open(CACHE);
  const cached = async () => (await cache.match(req, { ignoreSearch: true })) || (await cache.match('./'));
  try {
    const timeout = new Promise((_, reject) => { setTimeout(reject, PAGE_TIMEOUT_MS); });
    // By URL: a navigate-mode Request cannot be re-issued with options.
    const res = await Promise.race([fetch(req.url, { cache: 'no-cache' }), timeout]);
    if (res.status >= 500) return (await cached()) || res;     // server error: the cached app beats an error page
    if (res.ok && (res.headers.get('content-type') || '').includes('text/html')) {
      try {
        await cache.put('./', res.clone());
      } catch { /* quota or similar: the good network response is still returned */ }
    }
    return res;
  } catch {
    return (await cached()) || Response.error();
  }
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  if (req.mode === 'navigate') {
    e.respondWith(page(req));
    return;
  }
  e.respondWith(caches.open(CACHE).then(async (cache) => {
    const hit = await cache.match(req, { ignoreSearch: true });
    const net = fetch(req, { cache: 'no-cache' })      // revalidate: GitHub Pages' max-age=600 would refresh from the HTTP cache
      .then((res) => {
        if (res.ok) cache.put(req, res.clone());
        return res;
      })
      .catch(() => hit || Response.error());
    if (hit) {
      e.waitUntil(net);
      return hit;
    }
    return net;
  }));
});
