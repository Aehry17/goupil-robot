// 🦊 Le robot de Goupil
// Toutes les 5 minutes environ, GitHub lance ce script. Il lit les notes de You&Me
// dans Firebase et envoie les notifications web qui doivent partir.
import admin from "firebase-admin";
import webpush from "web-push";

const compte = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({ credential: admin.credential.cert(compte) });
const db = admin.firestore();

webpush.setVapidDetails(
  process.env.VAPID_CONTACT || "mailto:goupil@example.com",
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY,
);

const CATS = {
  tache: { label: "Tâche", emo: "🧺" },
  amour: { label: "Rdv à deux", emo: "💕" },
  serieux: { label: "Rdv important", emo: "📋" },
  sortie: { label: "Sortie", emo: "🎈" },
};
const pick = (l) => l[Math.floor(Math.random() * l.length)];

// Les heures des notes sont celles de Paris (le fuseau est réglé dans le fichier du robot)
function moment(n) {
  if (!n.date) return null;
  const [y, m, d] = n.date.split("-").map(Number);
  const [h, mi] = (n.heure || "09:00").split(":").map(Number);
  return new Date(y, m - 1, d, h, mi);
}
function momentRappel(n) {
  const b = moment(n);
  if (!b || n.rappel == null || n.rappel === "aucun") return null;
  return new Date(b.getTime() - Number(n.rappel) * 60000);
}
function quand(n) {
  if (!n.date) return "Quand on peut";
  const b = moment(n);
  const ici = new Date();
  const t0 = new Date(ici.getFullYear(), ici.getMonth(), ici.getDate());
  const ecart = Math.round((new Date(b.getFullYear(), b.getMonth(), b.getDate()) - t0) / 86400000);
  let jour;
  if (ecart === 0) jour = "Aujourd’hui";
  else if (ecart === 1) jour = "Demain";
  else if (ecart === -1) jour = "Hier";
  else if (ecart > 1 && ecart < 7) jour = b.toLocaleDateString("fr-FR", { weekday: "long" });
  else jour = b.toLocaleDateString("fr-FR", { weekday: "short", day: "numeric", month: "long" });
  jour = jour.charAt(0).toUpperCase() + jour.slice(1);
  return n.heure ? `${jour} à ${n.heure.replace(":", "h")}` : jour;
}
function quandPhrase(n) {
  if (!n.date) return "";
  const q = quand(n);
  return /^(Aujourd|Demain|Hier)/.test(q) ? q.charAt(0).toLowerCase() + q.slice(1) : "le " + q.toLowerCase();
}
function phraseGoupil(n) {
  const q = quandPhrase(n);
  switch (n.type) {
    case "sortie": return pick([`Youpi ! « ${n.titre} » ${q} 🎈`, `Préparez-vous : ${n.titre}, ${q} ✨`]);
    case "amour": return pick([`Psst… « ${n.titre} » ${q}… 💕`, `Rendez-vous à deux ${q} : ${n.titre} 🥰`]);
    case "serieux": return pick([`N’oublie pas : ${n.titre}, ${q} 📋`, `Rendez-vous important ${q} : ${n.titre}`]);
    default: return pick([`Allez, on s’y met : ${n.titre} 💪`, `Petit rappel tout doux : ${n.titre} 🧺`]);
  }
}

const maintenant = Date.now();
const [notesSnap, abosSnap, profilsSnap, etatSnap] = await Promise.all([
  db.collection("notes").get(),
  db.collection("abonnements").get(),
  db.collection("profils").get(),
  db.doc("robot/etat").get(),
]);

const notes = notesSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
const abonnements = abosSnap.docs.map((d) => ({ id: d.id, ref: d.ref, ...d.data() }));
const prenoms = {};
profilsSnap.forEach((d) => { prenoms[d.id] = d.data().prenom; });
const etat = etatSnap.exists ? etatSnap.data() : {};
const dernierPassage = etat.dernierPassage || maintenant - 10 * 60000;
const envoyes = etat.envoyes || {};
let compteur = 0;

async function envoyer(abo, message) {
  if (abo.mort) return;
  try {
    await webpush.sendNotification({ endpoint: abo.endpoint, keys: abo.keys }, JSON.stringify(message), { TTL: 3600 });
    compteur++;
  } catch (e) {
    if (e.statusCode === 404 || e.statusCode === 410) {
      abo.mort = true;
      await abo.ref.delete().catch(() => {});
      console.log("Abonnement expiré, supprimé :", abo.id);
    } else {
      console.log("Échec d’envoi", e.statusCode, e.body || e.message);
    }
  }
}

// 1. Les rappels dont l'heure est arrivée (jusqu'à 2 h de retard maximum)
for (const n of notes) {
  if (n.fait) continue;
  const r = momentRappel(n);
  if (!r) continue;
  const cle = n.id + "@" + r.getTime();
  if (envoyes[cle]) continue;
  if (r.getTime() <= maintenant && r.getTime() > maintenant - 2 * 3600000) {
    const message = { title: `🦊 Goupil · ${CATS[n.type]?.label ?? "Rappel"}`, body: phraseGoupil(n), tag: cle };
    for (const abo of abonnements) await envoyer(abo, message);
    envoyes[cle] = maintenant;
  }
}

// 2. Les nouvelles notes : on prévient l'autre personne
for (const n of notes) {
  const cle = "nouvelle-" + n.id;
  if (!n.creeLe || envoyes[cle] || n.creeLe <= dernierPassage - 5 * 60000) continue;
  const auteur = prenoms[n.par] || "Ta moitié";
  const message = {
    title: `${CATS[n.type]?.emo ?? "🦊"} Nouvelle note de ${auteur}`,
    body: n.titre + (n.date ? ` · ${quand(n)}` : ""),
    tag: cle,
  };
  for (const abo of abonnements.filter((a) => a.uid !== n.par)) await envoyer(abo, message);
  envoyes[cle] = maintenant;
}

// 3. Les tests demandés depuis l'app
for (const abo of abonnements.filter((a) => a.testDemande)) {
  await envoyer(abo, { title: "🦊 Goupil · Test", body: "Coucou ! Si tu me vois, les notifications marchent 💕", tag: "test" });
  if (!abo.mort) await abo.ref.update({ testDemande: false }).catch(() => {});
}

// On oublie ce qui a été envoyé il y a plus de 3 jours
for (const k of Object.keys(envoyes)) if (maintenant - envoyes[k] > 3 * 86400000) delete envoyes[k];
await db.doc("robot/etat").set({ dernierPassage: maintenant, envoyes });

console.log(`🦊 Passage terminé : ${notes.length} notes, ${abonnements.length} appareil(s), ${compteur} notification(s) envoyée(s).`);
process.exit(0);
