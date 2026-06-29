// App-shell caching for installability/offline. The server is local and fast,
// so we use NETWORK-FIRST for the shell (always get the latest UI after a
// redeploy) and fall back to cache only when offline. API/media never cached.
const CACHE = 'djv-shell-v2';
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
  e.respondWith(
    fetch(e.request).then((res) => {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
      return res;
    }).catch(() => caches.match(e.request))
  );
});
