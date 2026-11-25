// 🦊 Le robot de Goupil
// Toutes les 5 minutes environ, GitHub lance ce script. Il lit les notes de You&Me
// dans Firebase et envoie les notifications web qui doivent partir.
import admin from "firebase-admin";
import webpush from "web-push";
import { importerBillets } from "./billets.mjs";

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
const [notesSnap, coursesSnap, abosSnap, profilsSnap, etatSnap] = await Promise.all([
  db.collection("notes").get(),
  db.collection("courses").get(),
  db.collection("abonnements").get(),
  db.collection("profils").get(),
  db.doc("robot/etat").get(),
]);

const notes = notesSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
const courses = coursesSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
const abonnements = abosSnap.docs.map((d) => ({ id: d.id, ref: d.ref, ...d.data() }));
const prenoms = {};
profilsSnap.forEach((d) => { prenoms[d.id] = d.data().prenom; });
const etat = etatSnap.exists ? etatSnap.data() : {};
const dernierPassage = etat.dernierPassage || maintenant - 10 * 60000;
const envoyes = etat.envoyes || {};
let compteur = 0;

// Envoie un message à une liste d'appareils (iPhone/navigateur ou Android)
async function envoyerA(liste, message) {
  for (const abo of liste.filter((a) => a.type !== "expo")) await envoyer(abo, message);
  await envoyerExpo(liste.filter((a) => a.type === "expo" && !a.mort), message);
}

// Android : on passe par le service de notifications d'Expo
async function envoyerExpo(liste, message) {
  if (!liste.length) return;
  try {
    const rep = await fetch("https://exp.host/--/api/v2/push/send", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(liste.map((a) => ({
        to: a.token, title: message.title, body: message.body,
        sound: "default", channelId: "rappels", priority: "high",
      }))),
    });
    const json = await rep.json();
    (json.data || []).forEach((r, i) => {
      if (r.status === "ok") compteur++;
      else {
        console.log("Échec d’envoi Android", r.message, JSON.stringify(r.details || {}));
        if (r.details?.error === "DeviceNotRegistered") {
          liste[i].mort = true;
          liste[i].ref.delete().catch(() => {});
        }
      }
    });
    if (json.errors) console.log("Erreur Expo", JSON.stringify(json.errors));
  } catch (e) {
    console.log("Échec d’envoi Android", e.message);
  }
}

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

// 0. Le facteur : les billets reçus par e-mail
try {
  const ranges = await importerBillets({ db, prenoms, notes, envoyes, maintenant });
  if (ranges.length) {
    const titres = [...new Set(ranges.map((b) => b.titre))];
    const aTrier = ranges.filter((b) => b.aVerifier).length;
    await envoyerA(abonnements, {
      title: `🎟 Goupil a rangé ${ranges.length} billet${ranges.length > 1 ? "s" : ""}`,
      body: titres.slice(0, 3).join(", ") + (aTrier ? ` · ${aTrier} à compléter dans l’app` : ""),
      tag: "billets",
    });
  }
  console.log(`🎟 ${ranges.length} billet(s) rangé(s) depuis la boîte mail.`);
} catch (e) {
  console.log("Boîte mail inaccessible :", e.message);
}

// Les appareils web (iPhone) reçoivent les rappels. Les téléphones Android
// programment déjà leurs rappels eux-mêmes : on ne les prévient que des nouveautés.
const abonnementsWeb = abonnements.filter((a) => a.type !== "expo");

// 1. Les rappels dont l'heure est arrivée (jusqu'à 2 h de retard maximum)
for (const n of notes) {
  if (n.fait) continue;
  const r = momentRappel(n);
  if (!r) continue;
  const cle = n.id + "@" + r.getTime();
  if (envoyes[cle]) continue;
  if (r.getTime() <= maintenant && r.getTime() > maintenant - 2 * 3600000) {
    const message = { title: `🦊 Goupil · ${CATS[n.type]?.label ?? "Rappel"}`, body: phraseGoupil(n), tag: cle };
    for (const abo of abonnementsWeb) await envoyer(abo, message);
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
  await envoyerA(abonnements.filter((a) => a.uid !== n.par), message);
  envoyes[cle] = maintenant;
}

// 2 bis. Les nouveaux articles de courses : un seul message par personne
const nouveauxArticles = courses.filter((c) =>
  c.creeLe && !c.coche && !envoyes["course-" + c.id] && c.creeLe > dernierPassage - 5 * 60000);
const parAuteur = {};
for (const c of nouveauxArticles) (parAuteur[c.par] ||= []).push(c);
for (const [uid, liste] of Object.entries(parAuteur)) {
  const auteur = prenoms[uid] || "Ta moitié";
  const noms = liste.sort((a, b) => a.creeLe - b.creeLe).map((c) => c.nom);
  const corps = noms.length === 1
    ? `${auteur} a ajouté « ${noms[0]} » à la liste`
    : `${auteur} a ajouté ${noms.length} articles : ${noms.slice(0, 4).join(", ")}${noms.length > 4 ? "…" : ""}`;
  await envoyerA(abonnements.filter((a) => a.uid !== uid), { title: "🛒 Les courses", body: corps, tag: "courses" });
  for (const c of liste) envoyes["course-" + c.id] = maintenant;
}

// 3. Les tests demandés depuis l'app
for (const abo of abonnements.filter((a) => a.testDemande)) {
  await envoyerA([abo], { title: "🦊 Goupil · Test", body: "Coucou ! Si tu me vois, les notifications marchent 💕", tag: "test" });
  if (!abo.mort) await abo.ref.update({ testDemande: false }).catch(() => {});
}

// On oublie ce qui a été envoyé il y a plus de 3 jours
for (const k of Object.keys(envoyes)) if (maintenant - envoyes[k] > 3 * 86400000) delete envoyes[k];
await db.doc("robot/etat").set({ dernierPassage: maintenant, envoyes });

console.log(`🦊 Passage terminé : ${notes.length} notes, ${abonnements.length} appareil(s), ${compteur} notification(s) envoyée(s).`);
process.exit(0);
