// Permite abrir la app sin señal. Siempre busca la versión más nueva cuando hay internet.
const CACHE = 'registro-lp-v5';
const ARCHIVOS = ['./', './index.html', './manifest.json', './icono-192.png', './icono-512.png'];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(ARCHIVOS.map(u => new Request(u, { cache: 'reload' }))))); self.skipWaiting(); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))); self.clients.claim(); });
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  // Primero internet sin usar copias viejas; si no hay señal, usa la copia guardada
  e.respondWith(fetch(url.href, { cache: 'no-cache', credentials: 'same-origin' })
    .then(r => { if (r.ok) { const copia = r.clone(); caches.open(CACHE).then(c => c.put(e.request, copia)); } return r; })
    .catch(() => caches.match(e.request).then(r => r || caches.match('./index.html'))));
});
