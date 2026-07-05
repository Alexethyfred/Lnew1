/* ══════════════════════════════════════════════════════════
   SERVICE WORKER — Commission Témoignage EEAM Fès
   Rôle : rendre l'app installable (PC, Android, iOS) et
   permettre l'ouverture même avec une connexion faible.
   L'app reste "live" via Firebase (temps réel) dès que le
   réseau revient — ce SW ne met en cache que la coquille
   statique (HTML/icônes), jamais les données des fiches.
══════════════════════════════════════════════════════════ */
const CACHE_NAME = 'eeam-temoignage-shell-v1';
const SHELL_FILES = [
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Stratégie : réseau d'abord (données à jour), cache en secours (hors-ligne)
/* ══════════════════════════════════════════════════════════
   NOTIFICATIONS PUSH (Web Push — VERSION TEST)
   Reçoit les notifications envoyées par le script d'automation
   même si l'app est fermée.
══════════════════════════════════════════════════════════ */
self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch(e) { data = { title: 'Commission Témoignage', body: event.data ? event.data.text() : '' }; }

  const title = data.title || 'Commission Témoignage — EEAM Fès';
  const options = {
    body: data.body || '',
    icon: './icon-192.png',
    badge: './icon-192.png',
    vibrate: [100, 50, 100],
    data: { url: data.url || './' }
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || './';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ('focus' in client) return client.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow(url);
    })
  );
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  // On ne touche jamais aux appels Firebase / EmailJS / API externes
  if (!event.request.url.includes(self.location.origin)) return;

  event.respondWith(
    fetch(event.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        return res;
      })
      .catch(() => caches.match(event.request))
  );
});
