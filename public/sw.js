// App shell cached for offline start; GET API calls are network-first with a cached fallback,
// so today's lists and attendance can be read during internet cuts.
const VERSION = 'v3';
const SHELL = ['/', '/app.js', '/app.css', '/icon.svg', '/manifest.webmanifest', '/fonts/plex-sans-var.woff2'];
self.addEventListener('install', (e) => { e.waitUntil(caches.open('shell-' + VERSION).then((c) => c.addAll(SHELL))); self.skipWaiting(); });
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => !k.endsWith(VERSION)).map((k) => caches.delete(k)))));
  self.clients.claim();
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
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
