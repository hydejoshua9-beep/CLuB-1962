/* Club 1962 service worker: keeps the app shell available offline and
   keeps the last saved copy of the data so the tracker still opens without signal. */
'use strict';
const VERSION = 'v1';
const SHELL = 'c62-shell-' + VERSION;
const DATA = 'c62-data';
const FONTS = 'c62-fonts';
const SHELL_FILES = ['/', '/styles.css', '/app.js', '/manifest.webmanifest', '/icons/icon.svg', '/icons/icon-192.png', '/icons/apple-touch-icon.png'];
const CACHED_API = ['/api/me', '/api/state'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(SHELL).then(c => c.addAll(SHELL_FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k.startsWith('c62-shell-') && k !== SHELL).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

async function networkFirst(req, cacheName, fallbackUrl) {
  const cache = await caches.open(cacheName);
  try {
    const res = await fetch(req);
    if (res.ok) await cache.put(fallbackUrl || req, res.clone());
    return res;
  } catch (err) {
    const hit = await cache.match(fallbackUrl || req);
    if (hit) return hit;
    throw err;
  }
}

// API reads: always try the server; when offline, answer with the last copy and mark it.
async function apiRead(req) {
  const url = new URL(req.url);
  const cache = await caches.open(DATA);
  try {
    const res = await fetch(req);
    if (res.ok) {
      const body = await res.clone().arrayBuffer();
      const headers = new Headers(res.headers);
      headers.set('X-From-Cache', '1');
      headers.set('X-Cached-At', String(Date.now()));
      await cache.put(url.pathname, new Response(body, { status: 200, headers }));
    } else if (res.status === 401) {
      await caches.delete(DATA);
    }
    return res;
  } catch (err) {
    const hit = await cache.match(url.pathname);
    if (hit) return hit;
    throw err;
  }
}

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin === location.origin) {
    if (CACHED_API.includes(url.pathname)) return e.respondWith(apiRead(req));
    if (url.pathname.startsWith('/api/')) return; // events, exports, etc. go straight to the network
    if (req.mode === 'navigate') return e.respondWith(networkFirst(req, SHELL, '/'));
    return e.respondWith(networkFirst(req, SHELL));
  }
  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    e.respondWith(caches.open(FONTS).then(async c => {
      const hit = await c.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok || res.type === 'opaque') c.put(req, res.clone());
      return res;
    }));
  }
});
