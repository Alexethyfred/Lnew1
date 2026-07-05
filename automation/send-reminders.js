/**
 * send-reminders.js
 * ────────────────────────────────────────────────────────────
 * Exécute EXACTEMENT la même logique que le rattrapage client
 * (checkRappelHebdoContact / checkRappelVisiteMensuelle dans
 * index.html), mais côté serveur, via une tâche planifiée
 * gratuite (GitHub Actions). Fonctionne même si personne n'ouvre
 * l'application — c'est ce qui rend les rappels "fiables".
 *
 * Coûts : 0€.
 *  - GitHub Actions : gratuit pour ce volume (quelques secondes/jour).
 *  - Firestore       : quelques lectures/écritures par jour, largement
 *                      dans le quota gratuit "Spark".
 *  - EmailJS         : réutilise le même compte/template que l'app
 *                      (plan gratuit 200 emails/mois).
 *
 * Prérequis (secrets GitHub à créer, voir README.md) :
 *   FIREBASE_SERVICE_ACCOUNT_JSON  → clé de compte de service Firebase (JSON, en une ligne / base64)
 *   EMAILJS_PRIVATE_KEY            → clé privée EmailJS (onglet "Account" du dashboard EmailJS,
 *                                      à activer une fois : "Allow API calls from non-browser apps")
 */

const admin = require('firebase-admin');
const webpush = require('web-push');

/* ── 1. Initialisation Firebase Admin ─────────────────────── */
const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
if (!raw) {
  console.error('❌ Variable FIREBASE_SERVICE_ACCOUNT_JSON manquante.');
  process.exit(1);
}
const serviceAccount = JSON.parse(
  raw.trim().startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8')
);
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

/* ── 1bis. Config Web Push (VAPID — gratuit, aucun service tiers payant) ── */
// Clé publique = doit correspondre EXACTEMENT à VAPID_PUBLIC_KEY dans index.html
const VAPID_PUBLIC_KEY  = process.env.VAPID_PUBLIC_KEY  || 'BLfoZSEyZ4pplPuud3s9AW01NJBVCxIWVCquVqykyGVSZ5yzbrN_ylQaqDxmwSHGx324d6nWcJrm9p2zQ5SSyZA';
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || null;
if (VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails('mailto:commission.temoignage.fes@example.org', VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
} else {
  console.warn('⚠️ VAPID_PRIVATE_KEY absente — notifications push (téléphone) ignorées, seuls la notif interne et l\'email partiront.');
}

/* Envoie une vraie notification push (bannière téléphone/PC) à un évangéliste,
   s'il a activé les notifications sur au moins un appareil. */
async function sendPush(evId, title, body) {
  if (!VAPID_PRIVATE_KEY) return;
  const doc = await db.collection('push_subscriptions').doc(evId).get();
  if (!doc.exists) return; // n'a pas activé les notifications
  const sub = doc.data().subscription;
  if (!sub) return;
  try {
    await webpush.sendNotification(sub, JSON.stringify({ title, body }));
  } catch (e) {
    if (e.statusCode === 404 || e.statusCode === 410) {
      // Abonnement expiré/révoqué (désinstallation, changement navigateur…) → on nettoie
      await db.collection('push_subscriptions').doc(evId).delete().catch(() => {});
    } else {
      console.warn(`⚠️ Push non délivré pour ${evId} :`, e.statusCode || e.message);
    }
  }
}

/* ── 2. Config EmailJS (mêmes identifiants que l'app) ─────── */
const EJS = {
  serviceId:  'service_9jsx2eb',
  templateId: 'template_vkamgqr',
  publicKey:  '3j_KrepA-xxE88OcP',
  privateKey: process.env.EMAILJS_PRIVATE_KEY || null,
};

const versets = [
  { txt: '« Allez, faites de toutes les nations des disciples... »', ref: 'Matthieu 28 : 19' },
  { txt: '« Vous serez mes témoins jusqu\'aux extrémités de la terre. »', ref: 'Actes 1 : 8' },
];

async function sendEmail(params) {
  if (!EJS.privateKey) {
    console.warn('⚠️ EMAILJS_PRIVATE_KEY absente — email ignoré (notification interne quand même créée).');
    return;
  }
  const res = await fetch('https://api.emailjs.com/api/v1.0/email/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      service_id: EJS.serviceId,
      template_id: EJS.templateId,
      user_id: EJS.publicKey,
      accessToken: EJS.privateKey,
      template_params: params,
    }),
  });
  if (!res.ok) {
    console.error('❌ Erreur EmailJS', res.status, await res.text().catch(() => ''));
  }
}

async function pushNotif(userId, message, type) {
  await db.collection('notifications').add({
    userId, message, type,
    read: false,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });
}

/* ── 3. Helpers de date (identiques au client) ────────────── */
function isSemaine1(d) { return d.getDate() <= 7; }
function isDerniereSemaine(d) {
  const dernierJour = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  return d.getDate() > dernierJour - 7;
}
function cleHebdo(d) {
  const tag = isSemaine1(d) ? 'S1' : (isDerniereSemaine(d) ? 'SF' : null);
  return tag ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${tag}` : null;
}
function cleMois(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/* ── 4. Rappel hebdo : contacter ses fiches d'ici lundi ───── */
async function runRappelHebdo(now) {
  const jour = now.getDay(); // 0 = dimanche
  if (jour !== 0) return; // le serveur, contrairement au client, n'a pas besoin du rattrapage "lundi" : il tourne chaque jour
  const cle = cleHebdo(now);
  if (!cle) return;

  const [evsSnap, fichesSnap] = await Promise.all([
    db.collection('evangelistes').where('actif', '!=', false).get(),
    db.collection('fiches').get(),
  ]);
  const fiches = fichesSnap.docs.map(d => ({ id: d.id, ...d.data() })).filter(f => !f.deleted);

  for (const evDoc of evsSnap.docs) {
    const ev = { id: evDoc.id, ...evDoc.data() };
    const docId = `${ev.id}_${cle}`;
    const ref = db.collection('rappels_hebdo').doc(docId);
    const snap = await ref.get();
    if (snap.exists) continue; // déjà envoyé (par le client ou un run précédent) — pas de doublon
    await ref.set({ evId: ev.id, cle, createdAt: admin.firestore.FieldValue.serverTimestamp(), source: 'server' });

    const mesFiches = fiches.filter(f => f.evangelisteId === ev.id);
    const msgHebdo = mesFiches.length
      ? `📞 Rappel : contactez vos ${mesFiches.length} fiche(s) d'ici lundi.`
      : `📞 Rappel bi-mensuel : pensez à prendre des nouvelles de vos personnes suivies d'ici lundi.`;
    await pushNotif(ev.id, msgHebdo, 'rappel-hebdo');
    await sendPush(ev.id, 'Commission Témoignage', msgHebdo);

    if (ev.email && mesFiches.length) {
      const v = versets[0];
      await sendEmail({
        to_email: ev.email, ev_nom: ev.nom,
        fiche_nom: mesFiches.map(f => `${f.nom} ${f.prenom}`).join(', '),
        action: `Contacter vos ${mesFiches.length} fiche(s) d'ici lundi`,
        action_date: now.toISOString().slice(0, 10),
        verset: v.txt, verset_ref: v.ref,
      });
    }
    console.log(`✔ Rappel hebdo envoyé à ${ev.nom}`);
  }
}

/* ── 5. Rappel mensuel : visite accompagnée ───────────────── */
async function runRappelVisiteMensuelle(now) {
  if (now.getDate() !== 1) return; // le serveur envoie précisément le 1er (pas besoin de fenêtre de rattrapage)
  const cle = cleMois(now);

  const [evsSnap, fichesSnap] = await Promise.all([
    db.collection('evangelistes').where('actif', '!=', false).get(),
    db.collection('fiches').get(),
  ]);
  const evs = evsSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  const fiches = fichesSnap.docs.map(d => ({ id: d.id, ...d.data() })).filter(f => !f.deleted);

  for (const ev of evs) {
    const docId = `${ev.id}_${cle}`;
    const ref = db.collection('rappels_visite_mois').doc(docId);
    const snap = await ref.get();
    if (snap.exists) continue;
    await ref.set({ evId: ev.id, cle, createdAt: admin.firestore.FieldValue.serverTimestamp(), source: 'server' });

    const mesFiches = fiches.filter(f => f.evangelisteId === ev.id);
    if (!mesFiches.length) continue;

    const collegues = evs.filter(e => e.disponible && e.id !== ev.id && e.equipe === ev.equipe);
    const nomsCollegues = collegues.length
      ? collegues.map(e => e.nom).join(', ')
      : 'aucun signalé pour l\'instant — voir avec la responsable de zone';

    const msgVisite = `🚶 Ce mois-ci : programmez une visite pour vos ${mesFiches.length} fiche(s), accompagné(e) de : ${nomsCollegues}.`;
    await pushNotif(ev.id, msgVisite, 'rappel-visite-mois');
    await sendPush(ev.id, 'Commission Témoignage', msgVisite);

    if (ev.email) {
      const v = versets[1];
      await sendEmail({
        to_email: ev.email, ev_nom: ev.nom,
        fiche_nom: mesFiches.map(f => `${f.nom} ${f.prenom}`).join(', '),
        action: `Programmer une visite ce mois-ci (accompagnateur suggéré : ${nomsCollegues})`,
        action_date: now.toISOString().slice(0, 10),
        verset: v.txt, verset_ref: v.ref,
      });
    }
    console.log(`✔ Rappel visite mensuelle envoyé à ${ev.nom}`);
  }
}

/* ── 6. Sorties collectives de la commission ──────────────
   Contrairement aux rappels planifiés, ceci se déclenche dès
   qu'une nouvelle sortie est publiée par le/la responsable
   (champ notifie:false). Comme il n'y a pas de serveur en
   permanence (juste ce cron), la notification part au run
   suivant — d'où l'intérêt, en phase de test, d'un cron
   fréquent (voir reminders.yml).                            */
async function runSortiesCollectives() {
  const snap = await db.collection('sorties_collectives').where('notifie', '==', false).get();
  if (snap.empty) return;

  const evsSnap = await db.collection('evangelistes').where('actif', '!=', false).get();
  const evs = evsSnap.docs.map(d => ({ id: d.id, ...d.data() }));

  for (const doc of snap.docs) {
    const s = doc.data();
    const dateLabel = new Date(s.date).toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
    const msg = `🚌 Sortie collective de la commission : ${s.lieu} — ${dateLabel}${s.description ? ' (' + s.description + ')' : ''}. Merci d'indiquer votre présence dans l'app.`;

    for (const ev of evs) {
      await pushNotif(ev.id, msg, 'sortie-collective');
      await sendPush(ev.id, 'Sortie collective — Commission Témoignage', msg);
      if (ev.email) {
        await sendEmail({
          to_email: ev.email, ev_nom: ev.nom,
          fiche_nom: '—',
          action: `Sortie collective le ${dateLabel} à ${s.lieu}${s.description ? ' — ' + s.description : ''}. Merci de répondre dans l'app (Je viens / Je ne peux pas).`,
          action_date: s.date,
          verset: versets[1].txt, verset_ref: versets[1].ref,
        });
      }
    }
    await doc.ref.update({ notifie: true, notifieAt: admin.firestore.FieldValue.serverTimestamp() });
    console.log(`✔ Sortie collective "${s.lieu}" notifiée à ${evs.length} évangéliste(s)`);
  }
}

(async () => {
  const now = new Date();
  console.log('▶ Vérification des rappels —', now.toISOString());
  await runRappelHebdo(now);
  await runRappelVisiteMensuelle(now);
  await runSortiesCollectives();
  console.log('✔ Terminé.');
  process.exit(0);
})().catch(err => {
  console.error('❌ Erreur script rappels :', err);
  process.exit(1);
});
