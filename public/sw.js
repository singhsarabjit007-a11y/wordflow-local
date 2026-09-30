// Static cache only: WordFlow does not make API calls or store cloud data.
// Increment this when the static app shell changes, so installed PWAs fetch
// the new JavaScript and interface instead of continuing to use an old shell.
const CACHE_NAME = 'wordflow-push-v4';
const STATIC_ASSETS = ['/', '/index.html', '/css/styles.css', '/js/app.js', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(STATIC_ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))));
  self.clients.claim();
});

// Cache-first makes the shell available offline; a successful network response
// refreshes the cache for the next launch.
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET' || new URL(event.request.url).origin !== self.location.origin) return;
  event.respondWith(caches.match(event.request).then((cached) => cached || fetch(event.request).then((response) => {
    if (response.ok) caches.open(CACHE_NAME).then((cache) => cache.put(event.request, response.clone()));
    return response;
  })));
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
