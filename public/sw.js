// Cache only public application assets. Authenticated API responses and private files are never cached here.
const VERSION = 'v18';
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
  if (SHELL.includes(url.pathname)) {
    // The install step precaches this exact version of the public app shell.
    // Cache-first makes the login screen available immediately; a new SW version refreshes it.
    e.respondWith(caches.match(e.request).then((cached) => cached || fetch(e.request).then((response) => {
      if (response.ok) caches.open('shell-' + VERSION).then((cache) => cache.put(e.request, response.clone()));
      return response;
    })));
    return;
  }
  e.respondWith(fetch(e.request).catch(() => caches.match(e.request).then((r) => r || caches.match('/'))));
});
