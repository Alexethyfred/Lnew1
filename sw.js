/**
 * sw.js — Service Worker
 * ────────────────────────────────────────────────────────────
 * Rôle : permettre à l'app de fonctionner hors-ligne ET détecter
 * automatiquement quand une nouvelle version a été publiée sur
 * GitHub, pour afficher la bannière "🔄 Nouvelle version disponible"
 * déjà présente dans index.html.
 *
 * ⚠️ IMPORTANT — À FAIRE À CHAQUE MISE À JOUR DE L'APP :
 * Change le numéro de version ci-dessous (CACHE_NAME). C'est CE
 * changement, et lui seul, qui déclenche la détection de mise à
 * jour côté client. Si tu oublies, la bannière n'apparaîtra jamais
 * même si index.html a changé.
 *
 * Exemple : 'eeam-cache-v1' -> 'eeam-cache-v2' -> 'eeam-cache-v3' ...
 */
const CACHE_NAME = 'eeam-cache-v3';

// Fichiers essentiels mis en cache pour le fonctionnement hors-ligne.
// (Les données Firestore, elles, sont gérées séparément par l'app.)
const CORE_ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './apple-touch-icon.png',
];

/* ── INSTALL ────────────────────────────────────────────────
   Télécharge et met en cache les fichiers essentiels dès qu'une
   nouvelle version du service worker est détectée. */
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(CORE_ASSETS)).catch(() => {})
  );
  // Ne PAS appeler skipWaiting() ici : on laisse index.html décider
  // du bon moment (clic sur "Mettre à jour"), pour ne jamais recharger
  // l'app en pleine saisie d'une fiche.
});

/* ── ACTIVATE ───────────────────────────────────────────────
   Supprime les anciens caches (anciennes versions) une fois que
   la nouvelle version prend le contrôle. */
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

/* ── MESSAGE ────────────────────────────────────────────────
   Reçoit l'ordre "SKIP_WAITING" envoyé par index.html quand la
   personne clique sur le bouton "Mettre à jour" de la bannière. */
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

/* ── FETCH ──────────────────────────────────────────────────
   Stratégie "réseau d'abord, cache en secours" pour index.html
   (garantit qu'on détecte vite une nouvelle version en ligne),
   et "cache d'abord" pour le reste (rapide, fonctionne hors-ligne). */
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const isHtml = req.mode === 'navigate' || req.headers.get('accept')?.includes('text/html');

  if (isHtml) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, copy)).catch(() => {});
          return res;
        })
        .catch(() => caches.match(req).then((r) => r || caches.match('./index.html')))
    );
    return;
  }

  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, copy)).catch(() => {});
          return res;
        })
        .catch(() => cached);
    })
  );
});
