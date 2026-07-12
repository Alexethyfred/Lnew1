/* ══════════════════════════════════════════════════════════
   SERVICE WORKER — Commission Témoignage EEAM Fès
   Rôle : rendre l'app installable (PC, Android, iOS) et
   permettre l'ouverture même avec une connexion faible.
   L'app reste "live" via Firebase (temps réel) dès que le
   réseau revient — ce SW ne met en cache que la coquille
   statique (HTML/icônes), jamais les données des fiches.

   MISE À JOUR (façon applis modernes) : la nouvelle version
   est téléchargée en arrière-plan mais n'ACTIVE PAS toute
   seule — elle attend que la personne clique "Mettre à jour"
   dans la bannière affichée par index.html. Ça évite un
   rechargement surprise en pleine saisie d'un compte-rendu.
══════════════════════════════════════════════════════════ */
const CACHE_NAME = 'eeam-temoignage-shell-v2';
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
  // Pas de self.skipWaiting() ici — la nouvelle version reste "en attente"
  // tant que la personne n'a pas cliqué "Mettre à jour" dans l'app.
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Reçoit l'ordre d'activation quand la personne clique "Mettre à jour"
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

/* ══════════════════════════════════════════════════════════
   NOTIFICATIONS PUSH (Web Push)
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

// Stratégie : réseau d'abord (données à jour), cache en secours (hors-ligne)
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
