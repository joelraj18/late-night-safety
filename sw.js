// Service worker: makes the app work with no internet after the first visit.
//
// On install it downloads everything the app needs (pages, scripts, the face
// tracking engine and model, ~15 MB) into the browser's cache. After that,
// every request is answered from the cache first, so the app opens and runs
// offline, e.g. on a night drive with no signal.
//
// Updating: bump VERSION. The new worker downloads in the background and the
// app shows "Update ready"; the big vendor/ files are copied from the old
// cache instead of being downloaded again.

const VERSION = '1.0.0';
const CACHE = `late-night-safety-${VERSION}`;

const ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/app.css',
  './js/alarm.js',
  './js/app.js',
  './js/camera.js',
  './js/chart.js',
  './js/detector.js',
  './js/drowsiness.js',
  './js/native.js',
  './js/night-light.js',
  './js/pwa.js',
  './js/screen-awake.js',
  './js/session-log.js',
  './js/settings.js',
  './js/ticker-worker.js',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png',
  './vendor/mediapipe/0.10.35/vision_bundle.js',
  './vendor/mediapipe/0.10.35/wasm/vision_wasm_internal.js',
  './vendor/mediapipe/0.10.35/wasm/vision_wasm_internal.wasm',
  './vendor/mediapipe/models/face_landmarker.task',
];

const absolute = (path) => new URL(path, self.registration.scope).href;
const isImmutable = (url) => url.includes('/vendor/');

async function broadcast(message) {
  const clients = await self.clients.matchAll({ includeUncontrolled: true, type: 'window' });
  for (const client of clients) client.postMessage(message);
}

async function cacheStatus() {
  const cache = await caches.open(CACHE);
  let done = 0;
  for (const path of ASSETS) if (await cache.match(absolute(path))) done += 1;
  return { type: 'cache-status', done, total: ASSETS.length, version: VERSION };
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      let done = 0;
      const total = ASSETS.length;
      const saveOne = async (path) => {
        const url = absolute(path);
        if (!(await cache.match(url))) {
          const previous = isImmutable(url) ? await caches.match(url) : null;
          if (previous) {
            await cache.put(url, previous);
          } else {
            const response = await fetch(new Request(url, { cache: 'reload' }));
            if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
            await cache.put(url, response);
          }
        }
        done += 1;
        await broadcast({ type: 'precache-progress', done, total, version: VERSION });
      };
      // A few downloads at a time is kind to slow mobile connections.
      const queue = [...ASSETS];
      const workers = Array.from({ length: 4 }, async () => {
        while (queue.length) await saveOne(queue.shift());
      });
      try {
        await Promise.all(workers);
      } catch (err) {
        await broadcast({ type: 'precache-error', message: String(err?.message || err) });
        throw err; // install fails; the browser retries on the next visit
      }
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k.startsWith('late-night-safety-') && k !== CACHE).map((k) => caches.delete(k)));
      await self.clients.claim();
      await broadcast(await cacheStatus());
    })(),
  );
});

self.addEventListener('message', (event) => {
  const type = event.data?.type;
  if (type === 'skip-waiting') self.skipWaiting();
  if (type === 'cache-status') {
    event.waitUntil(cacheStatus().then((status) => event.source?.postMessage(status)));
  }
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    // Single-page app: always answer with the saved index.html (works offline).
    event.respondWith(
      (async () => {
        const cached = await caches.match(absolute('./index.html'), { cacheName: CACHE });
        if (cached) return cached;
        try {
          return await fetch(request);
        } catch {
          return new Response('<h1>Offline</h1><p>Open the app once with internet to save it for offline use.</p>', {
            status: 503,
            headers: { 'Content-Type': 'text/html; charset=utf-8' },
          });
        }
      })(),
    );
    return;
  }

  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      const cached = await cache.match(request, { ignoreSearch: true });
      if (cached) return cached;
      const response = await fetch(request);
      if (response.ok && response.type === 'basic' && !url.pathname.endsWith('/sw.js')) {
        cache.put(request, response.clone()).catch(() => {});
      }
      return response;
    })(),
  );
});
