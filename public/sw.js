// Cache only public application assets. Authenticated API responses and private files are never cached here.
const VERSION = 'v6';
const SHELL = ['/', '/app.js', '/app.css', '/icon.svg', '/manifest.webmanifest', '/fonts/plex-sans-var.woff2'];
self.addEventListener('install', (e) => { e.waitUntil(caches.open('shell-' + VERSION).then((c) => c.addAll(SHELL))); self.skipWaiting(); });
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => !k.endsWith(VERSION)).map((k) => caches.delete(k)))));
  self.clients.claim();
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return;
  if (e.request.method !== 'GET') return;
  if (url.pathname.startsWith('/files/')) return;
  // Never put private API responses, authentication state, or school files in Cache Storage.
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/files/')) return;
  e.respondWith(fetch(e.request).then((r) => {
    if (r.ok && SHELL.includes(url.pathname)) { const copy = r.clone(); caches.open('shell-' + VERSION).then((c) => c.put(e.request, copy)); }
    return r;
  }).catch(() => caches.match(e.request).then((r) => r || caches.match('/'))));
});
