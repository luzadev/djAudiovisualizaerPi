// Minimal app-shell cache so the remote installs as a PWA and the UI loads fast.
// API, media and websockets are always fetched from the network (never cached).
const CACHE = 'djv-shell-v1';
const SHELL = [
  './', 'index.html', 'css/mobile.css',
  'js/net.js', 'js/control.js', 'js/engine/shaders.js', 'js/engine/effects.js',
  'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png'
];
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.pathname.startsWith('/api') || url.pathname.startsWith('/media')) return;
  e.respondWith(caches.match(e.request).then((hit) => hit || fetch(e.request)));
});
