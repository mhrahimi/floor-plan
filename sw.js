/* Floor Planner service worker
 * - Works offline: the app and its icons are cached on first visit.
 * - Stays up to date: the page itself is fetched from the network first,
 *   so a new deploy shows up on the next launch while online.
 * When you change icons or the manifest, bump VERSION so the cache refreshes.
 */
const VERSION = 'v1';
const CACHE = 'floorplanner-' + VERSION;
const NETWORK_TIMEOUT_MS = 3500;   // after this, an open-but-slow network falls back to the cached app
const ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icons/icon.svg',
  './icons/favicon-32.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-192.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png',
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE)
      .then(cache => cache.addAll(ASSETS.map(url => new Request(url, {cache: 'reload'}))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k.startsWith('floorplanner-') && k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // The app page: always ask the network for the latest version (so a new deploy
  // shows up straight away), but fall back to the cached copy when offline or
  // when the network takes too long.
  if (req.mode === 'navigate') {
    const isApp = url.pathname.endsWith('/') || url.pathname.endsWith('/index.html');
    const network = fetch(new Request(req.url, {cache: 'no-cache', redirect: 'manual', credentials: 'same-origin'}))
      .then(async res => {
        if (isApp && res.ok) await (await caches.open(CACHE)).put('./index.html', res.clone());
        return res;
      });
    event.waitUntil(network.catch(() => {}));
    event.respondWith((async () => {
      const cached = isApp ? await caches.match('./index.html', {cacheName: CACHE}) : null;
      if (!cached) return network.catch(() => Response.error());
      const slow = new Promise(resolve => setTimeout(() => resolve(null), NETWORK_TIMEOUT_MS));
      const res = await Promise.race([network.catch(() => null), slow]);
      return res || cached;
    })());
    return;
  }

  // Icons, manifest and anything else from this site: cache first, then network.
  event.respondWith((async () => {
    const hit = await caches.match(req);
    if (hit) return hit;
    const res = await fetch(req);
    if (res.ok && res.type === 'basic') {
      const copy = res.clone();
      caches.open(CACHE).then(cache => cache.put(req, copy));
    }
    return res;
  })());
});
