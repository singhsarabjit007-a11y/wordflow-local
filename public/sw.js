// Static cache only: WordFlow does not make API calls or store cloud data.
// Increment this when the static app shell changes, so installed PWAs fetch
// the new JavaScript and interface instead of continuing to use an old shell.
const CACHE_NAME = 'wordflow-push-v13';
const STATIC_ASSETS = ['/', '/index.html', '/css/styles.css', '/js/app.js', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(STATIC_ASSETS)));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))));
  self.clients.claim();
});

// The HTML, CSS and JavaScript are network-first, making releases available on
// the next launch when online. Only the explicit public static list is cached;
// future same-origin APIs and account data are always handled by the network.
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET' || new URL(event.request.url).origin !== self.location.origin) return;
  const path = new URL(event.request.url).pathname;
  const isAppShell = path === '/' || path === '/index.html' || path === '/css/styles.css' || path === '/js/app.js';
  const isStaticAsset = STATIC_ASSETS.includes(path);
  const cacheResponse = (response) => {
    if (response.ok) void caches.open(CACHE_NAME).then((cache) => cache.put(event.request, response.clone()));
    return response;
  };
  if (isAppShell) {
    event.respondWith(fetch(event.request).then(cacheResponse).catch(() => caches.match(event.request)));
    return;
  }
  if (isStaticAsset) {
    event.respondWith(caches.match(event.request).then((cached) => cached || fetch(event.request).then(cacheResponse)));
    return;
  }
  event.respondWith(fetch(event.request));
});

// A waiting worker is activated only after the person chooses Refresh in the
// app, avoiding a surprise reload while they are studying a word.
self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
    const openClient = clients[0];
    if (openClient) return openClient.focus();
    return self.clients.openWindow('/#today');
  }));
});

// Push events are delivered to the service worker, so this still runs when
// WordFlow's browser tab and installed PWA window are both closed.
self.addEventListener('push', (event) => {
  const fallback = { title: 'WordFlow reminder', body: 'Open WordFlow for today’s word.', url: '/#today' };
  let payload = fallback;
  try { payload = { ...fallback, ...event.data?.json() }; } catch { /* A malformed push still gets a useful reminder. */ }
  event.waitUntil(self.registration.showNotification(payload.title, {
    body: payload.body,
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    tag: payload.tag || 'wordflow-reminder',
    data: { url: payload.url || '/#today' }
  }));
});
