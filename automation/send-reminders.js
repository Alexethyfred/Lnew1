/**
 * send-reminders.js
 * ────────────────────────────────────────────────────────────
 * Exécute EXACTEMENT la même logique que le rattrapage client
 * (checkRappelHebdoContact / checkRappelVisiteMensuelle dans
 * index.html), mais côté serveur, via une tâche planifiée
 * gratuite (GitHub Actions). Fonctionne même si personne n'ouvre
 * l'application — c'est ce qui rend les rappels "fiables".
 *
 * ⚠️ VALIDATION 100% MANUELLE, PAR ÉVANGÉLISTE, PAR CANAL :
 * Pour chaque évangéliste actif, ce script dépose UNE entrée dans
 * `communications_queue` (statut "attente") — que ce soit pour le
 * rappel hebdo, le rappel visite mensuelle, ou une sortie collective.
 * RIEN ne part automatiquement : le/la responsable doit cliquer,
 * séparément :
 *   - "Envoyer l'email"           -> emailEnvoye = true
 *   - "Envoyer la notification"   -> notifEnvoyee = true (in-app, instantané)
 *                                     + pushDemande = true (device, voir plus bas)
 * L'entrée ne passe à l'historique que lorsque les DEUX ont été faits.
 *
 * Note sur la notification "device" (bannière téléphone) :
 * Le navigateur ne peut pas signer/envoyer un vrai push tout seul (il faut
 * la clé privée VAPID, qui ne vit que côté serveur pour rester secrète).
 * Donc quand le/la responsable clique "Envoyer la notification" dans
 * l'app, ça écrit pushDemande:true sur le document. C'est CE script,
 * à son prochain passage (planifié toutes les X minutes/heures), qui va
 * réellement livrer la bannière et marquer pushEnvoye:true. Court délai,
 * normal et inévitable avec cette architecture 100% gratuite.
 *
 * Coûts : 0€.
 *  - GitHub Actions : gratuit pour ce volume (quelques secondes/jour).
 *  - Firestore       : quelques lectures/écritures par jour, largement
 *                      dans le quota gratuit "Spark".
 *  - EmailJS         : réutilise le même compte/template que l'app
 *                      (plan gratuit 200 emails/mois), déclenché
 *                      uniquement depuis le navigateur du/de la
 *                      responsable au moment du clic "Envoyer l'email".
 *
 * Prérequis (secrets GitHub à créer, voir README.md) :
 *   FIREBASE_SERVICE_ACCOUNT_JSON  -> clé de compte de service Firebase (JSON, en une ligne / base64)
 *   VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY -> pour les notifications push
 *
 * NB : EMAILJS_PRIVATE_KEY n'est plus utilisée par ce script — l'envoi
 * d'email se fait désormais depuis le navigateur du/de la responsable.
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
  console.warn('⚠️ VAPID_PRIVATE_KEY absente — notifications push (téléphone) ignorées.');
}

async function sendPush(evId, title, body) {
  if (!VAPID_PRIVATE_KEY) return false;
  const doc = await db.collection('push_subscriptions').doc(evId).get();
  if (!doc.exists) return false; // n'a pas activé les notifications sur cet appareil
  const sub = doc.data().subscription;
  if (!sub) return false;
  try {
    await webpush.sendNotification(sub, JSON.stringify({ title, body }));
    return true;
  } catch (e) {
    if (e.statusCode === 404 || e.statusCode === 410) {
      await db.collection('push_subscriptions').doc(evId).delete().catch(() => {});
    } else {
      console.warn(`⚠️ Push non délivré pour ${evId} :`, e.statusCode || e.message);
    }
    return false;
  }
}

/* ── Dépôt / mise à jour dans la file "Communications" ─────
   (jamais d'envoi direct d'email ou de notif ici — juste le dépôt) */
async function queueCommunication(docId, data) {
  await db.collection('communications_queue').doc(docId).set({
    ...data,
    statut:       'attente',
    emailEnvoye:  false,
    notifEnvoyee: false,
    pushDemande:  false,
    createdAt:    admin.firestore.FieldValue.serverTimestamp(),
    source:       'server',
  }, { merge: true });
}

const versets = [
  { txt: 'Allez, faites de toutes les nations des disciples...', ref: 'Matthieu 28 : 19' },
  { txt: 'Vous serez mes témoins jusqu\'aux extrémités de la terre.', ref: 'Actes 1 : 8' },
];

/* ── Helpers de date (identiques au client) ───────────────── */
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

/* ── 4. Rappel hebdo : contacter ses fiches d'ici lundi ─────
   Génère une entrée POUR CHAQUE évangéliste actif (même sans
   fiche assignée), le dimanche, pour envoi manuel le lundi.  */
async function runRappelHebdo(now) {
  const jour = now.getDay(); // 0 = dimanche
  if (jour !== 0) return;
  const cle = cleHebdo(now);
  if (!cle) return; // ni 1ère semaine ni dernière semaine du mois

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
    if (snap.exists) continue; // déjà généré (par le client ou un run précédent)
    await ref.set({ evId: ev.id, cle, createdAt: admin.firestore.FieldValue.serverTimestamp(), source: 'server' });

    const mesFiches = fiches.filter(f => f.evangelisteId === ev.id);
    const v = versets[0];
    const { nbVisites, nbAppelsMsg } = await getRecapSemaine(ev.id, now);

    const contenu = mesFiches.length
      ? `Bonjour ${ev.nom},\n\nBelle semaine à vous ! Voici votre point hebdomadaire de la Commission Témoignage :\n\nVos fiches à contacter d'ici lundi (${mesFiches.length}) :\n${mesFiches.map(f => `- ${f.nom} ${f.prenom}`).join('\n')}\n\nCette semaine : ${nbVisites} visite(s) effectuée(s), ${nbAppelsMsg} appel(s)/message(s) envoyé(s). Merci pour votre engagement fidèle !\n\n"${v.txt}" — ${v.ref}\n\nFraternellement,\nCommission Témoignage — EEAM Fès`
      : `Bonjour ${ev.nom},\n\nBelle semaine à vous ! Petit rappel bi-mensuel : pensez à prendre des nouvelles des personnes que vous suivez d'ici lundi.\n\n"${v.txt}" — ${v.ref}\n\nFraternellement,\nCommission Témoignage — EEAM Fès`;

    await queueCommunication(`${ev.id}_${cle}_hebdo`, {
      type: 'hebdo', evId: ev.id, evNom: ev.nom, evEmail: ev.email || null, cle, contenu,
      nbFiches: mesFiches.length,
    });
    console.log(`✔ Rappel hebdo déposé pour ${ev.nom} (à valider par la responsable)`);
  }
}

/* ── 5. Rappel mensuel : visite accompagnée ─────────────────
   Génère une entrée pour chaque évangéliste ayant des fiches,
   le 1er du mois, pour validation manuelle.                   */
async function runRappelVisiteMensuelle(now) {
  if (now.getDate() !== 1) return;
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
    if (!mesFiches.length) continue; // rien à programmer pour cet évangéliste ce mois-ci

    const collegues = evs.filter(e => e.disponible && e.id !== ev.id && e.equipe === ev.equipe);
    const nomsCollegues = collegues.length
      ? collegues.map(e => e.nom).join(', ')
      : 'aucun signalé pour l\'instant — voir avec la responsable de zone';

    const v = versets[1];
    const contenu = `Bonjour ${ev.nom},\n\nNouveau mois, nouvelle occasion de marcher aux côtés de ceux que vous suivez !\n\nPensez à programmer une visite accompagnée ce mois-ci pour vos ${mesFiches.length} fiche(s) :\n${mesFiches.map(f => `- ${f.nom} ${f.prenom}`).join('\n')}\n\nAccompagnateur(s) suggéré(s) : ${nomsCollegues}\n\n"${v.txt}" — ${v.ref}\n\nFraternellement,\nCommission Témoignage — EEAM Fès`;

    await queueCommunication(`${ev.id}_${cle}_visite`, {
      type: 'visite_mois', evId: ev.id, evNom: ev.nom, evEmail: ev.email || null, cle, contenu,
      nbFiches: mesFiches.length,
    });
    console.log(`✔ Rappel visite mensuelle déposé pour ${ev.nom} (à valider par la responsable)`);
  }
}

/* ── 6. Sorties collectives programmées par la responsable ──
   Dès qu'une sortie est publiée (notifie:false), une invitation
   est déposée pour CHAQUE évangéliste actif — email et notif
   restent entièrement manuels, comme les autres rappels.       */
async function runSortiesCollectives() {
  const snap = await db.collection('sorties_collectives').where('notifie', '==', false).get();
  if (snap.empty) return;

  const evsSnap = await db.collection('evangelistes').where('actif', '!=', false).get();
  const evs = evsSnap.docs.map(d => ({ id: d.id, ...d.data() }));

  for (const doc of snap.docs) {
    const s = doc.data();
    const dateLabel = new Date(s.date).toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

    for (const ev of evs) {
      const contenu = `Bonjour ${ev.nom},\n\nUne nouvelle sortie d'évangélisation vous attend ! Venez nombreux, votre présence compte pour l'équipe :\n\nLieu : ${s.lieu}\nDate : ${dateLabel}\n${s.description ? `Détail : ${s.description}\n` : ''}\nMerci d'indiquer votre présence dans l'app (Je viens / Je ne peux pas) dès que possible.\n\n"${versets[1].txt}" — ${versets[1].ref}\n\nFraternellement,\nCommission Témoignage — EEAM Fès`;

      await queueCommunication(`${doc.id}_${ev.id}_sortie`, {
        type: 'sortie', evId: ev.id, evNom: ev.nom, evEmail: ev.email || null,
        cle: doc.id, contenu,
      });
    }
    await doc.ref.update({ notifie: true, notifieAt: admin.firestore.FieldValue.serverTimestamp() });
    console.log(`✔ Sortie collective "${s.lieu}" — invitations déposées pour ${evs.length} évangéliste(s) (à valider)`);
  }
}

/* ── 7. Livraison effective des notifications "device" demandées ──
   Quand le/la responsable clique "Envoyer la notification" dans
   l'app, ça pose pushDemande:true. Ce script livre la vraie bannière
   téléphone à son prochain passage (la clé privée VAPID ne peut
   vivre que côté serveur). ── */
async function runPushDemandes() {
  const snap = await db.collection('communications_queue')
    .where('pushDemande', '==', true)
    .where('pushEnvoye', '!=', true)
    .get();
  if (snap.empty) return;

  const titres = {
    hebdo:       'Rappel hebdomadaire — Commission Témoignage',
    visite_mois: 'Rappel visite mensuelle — Commission Témoignage',
    sortie:      'Sortie collective — Commission Témoignage',
    manuel:      'Message — Commission Témoignage',
  };

  for (const doc of snap.docs) {
    const c = doc.data();
    const titre = titres[c.type] || 'Commission Témoignage';
    const corps = (c.contenu || '').split('\n').find(l => l.trim()) || 'Voir l\'application pour le détail.';
    const ok = await sendPush(c.evId, titre, corps);
    await doc.ref.update({
      pushEnvoye: true, // marqué "traité" même en cas d'échec (abonnement absent/expiré), pour ne pas boucler indéfiniment
      pushEnvoyeAt: admin.firestore.FieldValue.serverTimestamp(),
      pushLivre: ok,
    });
    console.log(`${ok ? '✔' : '·'} Push ${ok ? 'livré' : 'non livré (pas d\'abonnement actif)'} — ${c.evNom || c.evId}`);
  }
}

(async () => {
  const now = new Date();
  console.log('▶ Vérification des rappels —', now.toISOString());
  await runRappelHebdo(now);
  await runRappelVisiteMensuelle(now);
  await runSortiesCollectives();
  await runPushDemandes();
  console.log('✔ Terminé.');
  process.exit(0);
})().catch(err => {
  console.error('❌ Erreur script rappels :', err);
  process.exit(1);
});
