/**
 * send-reminders.js
 * ────────────────────────────────────────────────────────────
 * Exécute EXACTEMENT la même logique que le rattrapage client
 * (checkRappelHebdoContact / checkRappelVisiteMensuelle dans
 * index.html), mais côté serveur, via une tâche planifiée
 * gratuite (GitHub Actions). Fonctionne même si personne n'ouvre
 * l'application — c'est ce qui rend les rappels "fiables".
 *
 * ⚠️ MISE À JOUR — VALIDATION MANUELLE (Communications) :
 * Les 3 rappels (hebdo, visite mensuelle, sortie collective) ne
 * partent PLUS automatiquement par email. Ce script dépose le
 * contenu généré dans la collection Firestore `communications_queue`
 * (statut "attente"), exactement comme le fait le code client dans
 * index.html. Le/la responsable valide (et peut modifier) dans
 * l'onglet "Communications" de l'app avant l'envoi réel.
 *
 * Ce qui reste automatique et immédiat (inchangé) :
 *  - Notification interne (cloche dans l'app) → pushNotif()
 *  - Notification push téléphone/PC (si activée) → sendPush()
 * Seul l'EMAIL passe désormais par la validation manuelle.
 *
 * Coûts : 0€.
 *  - GitHub Actions : gratuit pour ce volume (quelques secondes/jour).
 *  - Firestore       : quelques lectures/écritures par jour, largement
 *                      dans le quota gratuit "Spark".
 *  - EmailJS         : réutilise le même compte/template que l'app
 *                      (plan gratuit 200 emails/mois), désormais
 *                      déclenché uniquement quand le/la responsable
 *                      clique "Envoyer" dans l'onglet Communications.
 *
 * Prérequis (secrets GitHub à créer, voir README.md) :
 *   FIREBASE_SERVICE_ACCOUNT_JSON  → clé de compte de service Firebase (JSON, en une ligne / base64)
 *   VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY → pour les notifications push (inchangé)
 *
 * NB : EMAILJS_PRIVATE_KEY n'est plus utilisée par ce script — l'envoi
 * d'email se fait désormais depuis le navigateur du/de la responsable
 * (EmailJS public key), au moment de la validation dans l'app. Le
 * secret peut être conservé (inoffensif) ou supprimé de GitHub.
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
const VAPID_PUBLIC_KEY  = process.env.VAPID_PUBLIC_KEY  || 'BLfoZSEyZ4pplPuud3s9AW01NJBVCxIWVCquVqykyGVSZ5yzbrN_ylQaqDxmwSHGx324d6nWcJrm9p2zQ5SSyZA';
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || null;
if (VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails('mailto:commission.temoignage.fes@example.org', VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
} else {
  console.warn('⚠️ VAPID_PRIVATE_KEY absente — notifications push (téléphone) ignorées, seule la notif interne partira.');
}

async function sendPush(evId, title, body) {
  if (!VAPID_PRIVATE_KEY) return;
  const doc = await db.collection('push_subscriptions').doc(evId).get();
  if (!doc.exists) return;
  const sub = doc.data().subscription;
  if (!sub) return;
  try {
    await webpush.sendNotification(sub, JSON.stringify({ title, body }));
  } catch (e) {
    if (e.statusCode === 404 || e.statusCode === 410) {
      await db.collection('push_subscriptions').doc(evId).delete().catch(() => {});
    } else {
      console.warn(`⚠️ Push non délivré pour ${evId} :`, e.statusCode || e.message);
    }
  }
}

async function pushNotif(userId, message, type) {
  await db.collection('notifications').add({
    userId, message, type,
    read: false,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });
}

/* ── Dépôt dans la file "Communications" (remplace l'envoi email direct) ── */
async function queueCommunication(docId, data) {
  await db.collection('communications_queue').doc(docId).set({
    ...data,
    statut: 'attente',
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    source: 'server',
  }, { merge: true });
}

const versets = [
  { txt: '« Allez, faites de toutes les nations des disciples... »', ref: 'Matthieu 28 : 19' },
  { txt: '« Vous serez mes témoins jusqu\'aux extrémités de la terre. »', ref: 'Actes 1 : 8' },
];

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

/* Récap d'activité de la semaine écoulée (visites + appels/messages) */
async function getRecapSemaine(evId, now) {
  const weekAgo = new Date(now.getTime() - 7 * 86400000);
  const weekAgoStr = weekAgo.toISOString().slice(0, 10);
  const snap = await db.collection('activites')
    .where('evangelisteId', '==', evId)
    .where('date', '>=', weekAgoStr)
    .get();
  const acts = snap.docs.map(d => d.data());
  return {
    nbVisites:   acts.filter(a => a.type === 'visite').length,
    nbAppelsMsg: acts.filter(a => a.type === 'appel' || a.type === 'message').length,
  };
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
    if (snap.exists) continue; // déjà traité (par le client ou un run précédent) — pas de doublon
    await ref.set({ evId: ev.id, cle, createdAt: admin.firestore.FieldValue.serverTimestamp(), source: 'server' });

    const mesFiches = fiches.filter(f => f.evangelisteId === ev.id);
    const msgHebdo = mesFiches.length
      ? `📞 Rappel : contactez vos ${mesFiches.length} fiche(s) d'ici lundi.`
      : `📞 Rappel bi-mensuel : pensez à prendre des nouvelles de vos personnes suivies d'ici lundi.`;
    await pushNotif(ev.id, msgHebdo, 'rappel-hebdo');
    await sendPush(ev.id, 'Commission Témoignage', msgHebdo);

    if (ev.email && mesFiches.length) {
      const v = versets[0];
      const { nbVisites, nbAppelsMsg } = await getRecapSemaine(ev.id, now);
      const contenu =
`Bonjour ${ev.nom},

Belle semaine à vous ! 🙏 Voici votre point hebdomadaire de la Commission Témoignage :

📋 Vos fiches à contacter d'ici lundi (${mesFiches.length}) :
${mesFiches.map(f => `• ${f.nom} ${f.prenom}`).join('\n')}

📊 Cette semaine : ${nbVisites} visite(s) effectuée(s), ${nbAppelsMsg} appel(s)/message(s) envoyé(s). Merci pour votre engagement fidèle !

« ${v.txt} » — ${v.ref}

Fraternellement,
Commission Témoignage — EEAM Fès`;

      await queueCommunication(`${ev.id}_${cle}_hebdo`, {
        type: 'hebdo', evId: ev.id, evNom: ev.nom, evEmail: ev.email, cle, contenu,
      });
    }
    console.log(`✔ Rappel hebdo déposé pour validation — ${ev.nom}`);
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
      const contenu =
`Bonjour ${ev.nom},

Nouveau mois, nouvelle occasion de marcher aux côtés de ceux que vous suivez ! 🚶

Pensez à programmer une visite accompagnée ce mois-ci pour vos ${mesFiches.length} fiche(s) :
${mesFiches.map(f => `• ${f.nom} ${f.prenom}`).join('\n')}

👥 Accompagnateur(s) suggéré(s) : ${nomsCollegues}

« ${v.txt} » — ${v.ref}

Fraternellement,
Commission Témoignage — EEAM Fès`;

      await queueCommunication(`${ev.id}_${cle}_visite`, {
        type: 'visite_mois', evId: ev.id, evNom: ev.nom, evEmail: ev.email, cle, contenu,
      });
    }
    console.log(`✔ Rappel visite mensuelle déposé pour validation — ${ev.nom}`);
  }
}

/* ── 6. Sorties collectives de la commission ──────────────
   La notification interne + push part immédiatement (c'est une
   simple annonce "une sortie a été publiée"). L'EMAIL d'invitation,
   lui, est désormais déposé en file d'attente pour que le/la
   responsable puisse le relire/adapter avant l'envoi groupé.      */
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
        const contenu =
`Bonjour ${ev.nom},

Une nouvelle sortie d'évangélisation vous attend ! 🚌✨ Venez nombreux, votre présence compte pour l'équipe :

📍 Lieu : ${s.lieu}
📅 Date : ${dateLabel}
${s.description ? `📝 ${s.description}\n` : ''}
Merci d'indiquer votre présence dans l'app (Je viens / Je ne peux pas) dès que possible.

« ${versets[1].txt} » — ${versets[1].ref}

Fraternellement,
Commission Témoignage — EEAM Fès`;

        await queueCommunication(`${doc.id}_${ev.id}_sortie`, {
          type: 'sortie', evId: ev.id, evNom: ev.nom, evEmail: ev.email,
          cle: doc.id, contenu,
        });
      }
    }
    await doc.ref.update({ notifie: true, notifieAt: admin.firestore.FieldValue.serverTimestamp() });
    console.log(`✔ Sortie collective "${s.lieu}" — invitations déposées pour ${evs.length} évangéliste(s)`);
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
