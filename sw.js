// TIME ATTACKER — smart service worker
// App shell cache + auto update for CSS / JS / HTML

const CACHE = `timeattacker-v${Date.now()}`;

const APP_SHELL = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './manifest.json',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js'
];

/* =========================
   INSTALL
========================= */
self.addEventListener('install', event => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then(cache => cache.addAll(APP_SHELL))
      .catch(() => {})
  );

  self.skipWaiting();
});

/* =========================
   ACTIVATE
========================= */
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(key => key !== CACHE)
          .map(key => caches.delete(key))
      )
    )
  );

  self.clients.claim();
});

/* =========================
   FETCH
========================= */
self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);

  /* -------------------------
     OpenStreetMap tiles
     Network First
  ------------------------- */
  if (url.host.includes('tile.openstreetmap.org')) {
    event.respondWith(
      fetch(request).catch(() => caches.match(request))
    );
    return;
  }

  /* -------------------------
     HTML / CSS / JS
     Always update from network
  ------------------------- */
  if (
    request.url.includes('index.html') ||
    request.url.includes('styles.css') ||
    request.url.includes('app.js')
  ) {
    event.respondWith(
      fetch(request)
        .then(response => {
          const responseClone = response.clone();

          caches.open(CACHE).then(cache => {
            cache.put(request, responseClone);
          });

          return response;
        })
        .catch(() => caches.match(request))
    );

    return;
  }

  /* -------------------------
     Other files
     Cache First
  ------------------------- */
  event.respondWith(
    caches.match(request).then(cached => {
      return cached || fetch(request);
    })
  );
});
