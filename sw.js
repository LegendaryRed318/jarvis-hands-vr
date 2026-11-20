// JARVIS Hands VR: the offline copy (21 Nov 2026). It lets the page install as an app, open
// without internet once it has been opened once, and start faster (the hand tracker is about
// 17 MB). The app's own files are fetched fresh when there is internet, so updates arrive; the
// tracker and three.js come from fixed version numbers, so their saved copies are used.
const CACHE = 'jhvr-v2';
const APP = ['./', './index.html', './js/app.js', './js/logic.js', './js/tracker.js', './models.json',
  './manifest.webmanifest', './icons/icon-192.png', './icons/icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(APP)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k.startsWith('jhvr-') && k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

const FIXED = ['https://cdn.jsdelivr.net/npm/three@', 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@',
  'https://storage.googleapis.com/mediapipe-models/'];

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = req.url;
  if (FIXED.some((p) => url.startsWith(p))) {
    // A fixed version never changes: the saved copy first.
    e.respondWith(caches.open(CACHE).then(async (c) => {
      const hit = await c.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok) c.put(req, res.clone());
      return res;
    }));
  } else if (new URL(url).origin === self.location.origin) {
    // The app itself: fresh from the internet when there is some, the saved copy when not.
    e.respondWith(fetch(req).then((res) => {
      if (res.ok) caches.open(CACHE).then((c) => c.put(req, res.clone()));
      return res;
    }).catch(() => caches.match(req, { ignoreSearch: true })));
  }
});
