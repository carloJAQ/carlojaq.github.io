// AgroClima LP — service worker: guarda la app para abrirla sin señal
const CACHE = 'agroclima-v14';
const ARCHIVOS = ['./', './index.html', './manifest.json', './icon-192.png', './icon-512.png'];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(ARCHIVOS))); self.skipWaiting(); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))); self.clients.claim(); });
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin) return; // clima y nube siempre por red
  // Primero red (para tomar cambios del repo), si no hay señal usa lo guardado
  e.respondWith(fetch(e.request).then(r => { const copia = r.clone(); caches.open(CACHE).then(c => c.put(e.request, copia)); return r; }).catch(() => caches.match(e.request).then(r => r || caches.match('./index.html'))));
});
// Notificaciones (las manda la tarea programada de GitHub)
self.addEventListener('push', e => {
  let d = {}; try { d = e.data ? e.data.json() : {}; } catch (er) { d = { body: e.data ? e.data.text() : '' }; }
  e.waitUntil(self.registration.showNotification(d.title || 'AgroClima', { body: d.body || 'Revisa lo de hoy.', icon: 'icon-192.png', badge: 'icon-192.png', tag: d.tag || 'agroclima-hoy', renotify: true, data: { url: d.url || './#hoy' } }));
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then(cs => {
    const c = cs.find(x => x.url.includes('/agroclima/'));
    const u = (e.notification.data && e.notification.data.url) || './#hoy'; if (c) { c.postMessage({ abrir: (u.split('#')[1] || 'hoy') }); return c.focus(); }
    return clients.openWindow((e.notification.data && e.notification.data.url) || './#hoy');
  }));
});
