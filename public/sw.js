// App shell cached for offline start; GET API calls are network-first with a cached fallback,
// so today's lists and attendance can be read during internet cuts.
const VERSION = 'v4';
const SHELL = ['/', '/app.js', '/app.css', '/icon.svg', '/manifest.webmanifest', '/fonts/plex-sans-var.woff2'];
self.addEventListener('install', (e) => { e.waitUntil(caches.open('shell-' + VERSION).then((c) => c.addAll(SHELL))); self.skipWaiting(); });
self.addEventListener('message', (e) => {
  if (e.data?.type === 'CLEAR_PRIVATE_CACHES') {
    e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key.startsWith('api-')).map((key) => caches.delete(key)))));
  }
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => !k.endsWith(VERSION)).map((k) => caches.delete(k)))));
  self.clients.claim();
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return;
  // A successful authentication changes the active private-data owner. Purge API
  // caches before the newly authenticated account begins to populate them.
  if (e.request.method === 'POST' && ['/api/auth/google', '/api/signup/google', '/api/auth/logout'].includes(url.pathname)) {
    e.respondWith(fetch(e.request).then(async (response) => {
      if (response.ok) {
        const keys = await caches.keys();
        await Promise.all(keys.filter((key) => key.startsWith('api-')).map((key) => caches.delete(key)));
      }
      return response;
    }));
    return;
  }
  if (e.request.method !== 'GET') return;
  if (url.pathname.startsWith('/files/')) return;
  if (url.pathname.startsWith('/api/')) {
    e.respondWith(fetch(e.request).then((r) => {
      if (r.ok) { const copy = r.clone(); caches.open('api-' + VERSION).then((c) => c.put(e.request, copy)); }
      return r;
    }).catch(() => caches.match(e.request).then((r) => r || new Response(JSON.stringify({ error: 'You are offline' }), { status: 503, headers: { 'content-type': 'application/json' } }))));
    return;
  }
  e.respondWith(fetch(e.request).then((r) => {
    if (r.ok && SHELL.includes(url.pathname)) { const copy = r.clone(); caches.open('shell-' + VERSION).then((c) => c.put(e.request, copy)); }
    return r;
  }).catch(() => caches.match(e.request).then((r) => r || caches.match('/'))));
});
