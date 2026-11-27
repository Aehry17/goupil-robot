// 🎟 Le facteur de Goupil : lit la boîte Gmail dédiée et range les billets
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { PDFDocument } from "pdf-lib";

const MORCEAU = 700000;
const TAILLE_MAX = 10 * 1024 * 1024;

export const norm = (s) => (s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase();
const pad = (n) => String(n).padStart(2, "0");
const versCle = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

// ───────────── Lecture du texte des PDF ─────────────
export async function pagesTexte(buffer) {
  try {
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const chargement = pdfjs.getDocument({
      data: new Uint8Array(buffer), useSystemFonts: true, disableFontFace: true, isEvalSupported: false, verbosity: 0,
    });
    const document = await chargement.promise;
    const pages = [];
    for (let i = 1; i <= document.numPages; i++) {
      const page = await document.getPage(i);
      const contenu = await page.getTextContent();
      pages.push(contenu.items.map((it) => it.str).join(" "));
    }
    try { await chargement.destroy(); } catch {}
    return pages;
  } catch (e) {
    console.log("Texte du PDF illisible :", e.message);
    return [];
  }
}

// ───────────── À qui est ce billet ? ─────────────
export function quiEst(texte, personnes) {
  const t = norm(texte);
  const trouves = personnes.filter((p) => p.motif.test(t)).map((p) => p.uid);
  if (trouves.length === 1) return trouves[0];
  if (trouves.length > 1) return "tous";
  return null;
}

// Regroupe les pages consécutives d'une même personne.
// Une page sans prénom reconnu (conditions de vente…) suit la page d'avant.
// Mais des pages sans prénom en tête de fichier restent « à trier » :
// on ne les donne jamais d'office à quelqu'un d'autre.
export function groupesDePages(proprietaires) {
  const groupes = [];
  proprietaires.forEach((p, i) => {
    const g = groupes[groupes.length - 1];
    if (g && (g.proprietaire === p || !p)) g.pages.push(i);
    else groupes.push({ proprietaire: p || null, pages: [i] });
  });
  return groupes;
}

// ───────────── Deviner la date, l'heure, le type ─────────────
const MOIS = {
  JANVIER: 1, JANV: 1, FEVRIER: 2, FEVR: 2, FEV: 2, MARS: 3, AVRIL: 4, AVR: 4, MAI: 5, JUIN: 6,
  JUILLET: 7, JUIL: 7, AOUT: 8, SEPTEMBRE: 9, SEPT: 9, OCTOBRE: 10, OCT: 10, NOVEMBRE: 11, NOV: 11, DECEMBRE: 12, DEC: 12,
  JANUARY: 1, JAN: 1, FEBRUARY: 2, FEB: 2, MARCH: 3, MAR: 3, APRIL: 4, APR: 4, MAY: 5, JUNE: 6, JUN: 6,
  JULY: 7, JUL: 7, AUGUST: 8, AUG: 8, SEPTEMBER: 9, SEP: 9, OCTOBER: 10, NOVEMBER: 11, DECEMBER: 12,
};

// Mots qui annoncent la date de l'achat (à éviter) ou celle de l'événement (à préférer)
const AVANT_ACHAT = /(ACHAT|ACHETE|COMMANDE|COMMANDEE|EMIS|EMISSION|EDITE|IMPRIME|GENERE|PAIEMENT|PAYE|FACTURE|TRANSACTION|RESERVE LE|EFFECTUEE?|PURCHASE|ORDER|ISSUED)\W*(LE|DU|ON|:)?\W*$/;
const AVANT_EVENEMENT = /(VISITE|VALABLE|ENTREE|CRENEAU|HORAIRE|SEANCE|DEPART|ALLER|RETOUR|REPRESENTATION|EVENEMENT|DATE DE LA|DATE DU|ARRIVEE|CONCERT|SPECTACLE|VISIT|VALID|EVENT|ADMISSION)\W*(DU|DE|LE|ON|:)?\W*(\w+\W+)?$/;
const MOTIF_HEURE = /\b([01]?\d|2[0-3])\s?(?:H|:)\s?([0-5]\d)?\b/;

export function devinerDate(texte, maintenant = new Date(), dateMail = null) {
  const t = norm(texte);
  const hier = new Date(maintenant); hier.setHours(0, 0, 0, 0); hier.setDate(hier.getDate() - 1);
  const candidats = [];
  const ajouter = (j, m, a, index, longueur) => {
    if (a > 0 && a < 100) a += 2000;
    if (!a) {
      a = maintenant.getFullYear();
      if (new Date(a, m - 1, j) < hier) a++;
    }
    const d = new Date(a, m - 1, j);
    if (d.getMonth() !== m - 1 || d < hier || a > maintenant.getFullYear() + 2) return;
    candidats.push({ d, index, fin: index + longueur });
  };
  for (const r of t.matchAll(/\b(\d{1,2})[\/.](\d{1,2})[\/.](\d{2,4})\b/g)) ajouter(+r[1], +r[2], +r[3], r.index, r[0].length);
  for (const r of t.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)) ajouter(+r[3], +r[2], +r[1], r.index, r[0].length);
  const noms = Object.keys(MOIS).sort((x, y) => y.length - x.length).join("|");
  for (const r of t.matchAll(new RegExp(`\\b(\\d{1,2})(?:ER|ST|ND|RD|TH)?\\s+(${noms})\\.?(?:\\s+(\\d{4}))?`, "g"))) {
    ajouter(+r[1], MOIS[r[2]], r[3] ? +r[3] : 0, r.index, r[0].length);
  }
  if (!candidats.length) return null;

  // On donne une note à chaque date trouvée
  const jourMail = dateMail ? versCle(new Date(dateMail)) : "";
  const repetitions = {};
  for (const c of candidats) repetitions[versCle(c.d)] = (repetitions[versCle(c.d)] || 0) + 1;
  for (const c of candidats) {
    const avant = t.slice(Math.max(0, c.index - 50), c.index);
    const apres = t.slice(c.fin, c.fin + 40);
    c.note = 0;
    if (AVANT_ACHAT.test(avant)) c.note -= 10;
    if (AVANT_EVENEMENT.test(avant)) c.note += 5;
    if (jourMail && versCle(c.d) === jourMail) c.note -= 4;
    if (MOTIF_HEURE.test(apres)) c.note += 2;
    c.note += Math.min(3, repetitions[versCle(c.d)] - 1);
  }
  candidats.sort((a, b) => b.note - a.note || a.d - b.d);
  const choisi = candidats[0];

  // L'heure : juste après la date choisie, sinon après un mot comme « créneau » ou « horaire »
  // (on s'arrête avant une autre date ou une mention d'achat, pour ne pas prendre l'heure de la commande)
  let apres = t.slice(choisi.fin, choisi.fin + 120);
  const coupure = apres.search(/ACHAT|COMMANDE|EMIS|PAIEMENT|FACTURE|PURCHASE|ORDER|\b\d{1,2}[\/.]\d{1,2}[\/.]\d{2,4}\b/);
  if (coupure >= 0) apres = apres.slice(0, coupure);
  let h = apres.match(MOTIF_HEURE);
  if (!h) {
    const m = t.match(/(CRENEAU|HORAIRE|HEURE D.ENTREE|ENTREE|SEANCE|DEBUT|OUVERTURE|A PARTIR DE|TIME)\W{0,12}([01]?\d|2[0-3])\s?(?:H|:)\s?([0-5]\d)?\b/);
    if (m) h = [m[0], m[2], m[3]];
  }
  const heure = h ? `${pad(+h[1])}:${h[2] || "00"}` : "";
  return { date: versCle(choisi.d), heure };
}

const TYPES = [
  ["train", /SNCF|OUIGO|TGV|INOUI|\bTER\b|TRENITALIA|EUROSTAR|LYRIA|BILLET DE TRAIN|\bVOITURE\s*\d/],
  ["avion", /AIR ?FRANCE|EASYJET|RYANAIR|TRANSAVIA|VUELING|CARTE D.EMBARQUEMENT|BOARDING/],
  ["musee", /MUSEE|MUSEUM|EXPOSITION|\bEXPO\b|ORSAY|LOUVRE|POMPIDOU|ORANGERIE|QUAI BRANLY|FONDATION|GALERIE|CHATEAU DE VERSAILLES|GRAND PALAIS/],
  ["cine", /CINEMA|\bUGC\b|PATHE|GAUMONT|\bMK2\b|SEANCE DE CINE/],
  ["concert", /CONCERT|TICKETMASTER|ZENITH|OLYMPIA|FESTIVAL|LIVE NATION|ARENA|SEE TICKETS|DICE/],
  ["spectacle", /THEATRE|SPECTACLE|OPERA|BALLET|COMEDIE|HUMOUR|STAND.?UP|CIRQUE/],
];
export function devinerType(texte, expediteur = {}) {
  // L'expéditeur d'abord (le plus fiable), puis le contenu
  const depuisExpediteur = TYPES.find(([, motif]) => motif.test(norm(`${expediteur.nom || ""} ${expediteur.adresse || ""}`.replace(/[.-]/g, " "))));
  if (depuisExpediteur) return depuisExpediteur[0];
  return (TYPES.find(([, motif]) => motif.test(norm(texte))) || ["autre"])[0];
}

// Lieux connus, reconnus à l'adresse de l'expéditeur
const LIEUX = {
  "musee-orsay.fr": "Musée d’Orsay", "louvre.fr": "Musée du Louvre", "centrepompidou.fr": "Centre Pompidou",
  "musee-orangerie.fr": "Musée de l’Orangerie", "quaibranly.fr": "Musée du quai Branly",
  "chateauversailles.fr": "Château de Versailles", "fondationlouisvuitton.fr": "Fondation Louis Vuitton",
  "grandpalais.fr": "Grand Palais", "petitpalais.paris.fr": "Petit Palais", "museeprotestant.org": "Musée protestant",
};

// L'expéditeur d'origine, même quand l'e-mail a été transféré
export function expediteurOriginal(mail) {
  const t = mail.text || "";
  const m = t.match(/^[\s>*]*(?:De|From|Exp[ée]diteur)\s*:\s*\**\s*"?([^"<\n]*?)"?\s*<([^>\s]+@[^>\s]+)>/mi);
  if (m) return { nom: m[1].trim(), adresse: m[2].trim().toLowerCase() };
  const v = mail.from?.value?.[0] || {};
  return { nom: (v.name || "").trim(), adresse: (v.address || "").toLowerCase() };
}

function nomDuLieu(exp) {
  const domaineExp = (exp.adresse || "").split("@")[1] || "";
  const connu = Object.entries(LIEUX).find(([d]) => domaineExp === d || domaineExp.endsWith("." + d));
  if (connu) return connu[1];
  const nom = (exp.nom || "")
    .replace(/\b(billetterie|ticketing|tickets?|no-?reply|ne pas r[ée]pondre|service clients?|[ée]quipe|team|infos?|contact|newsletter|boutique|shop)\b/gi, "")
    .replace(/[|:\-–]+/g, " ").replace(/\s{2,}/g, " ").trim();
  return nom.length >= 3 && !nom.includes("@") ? nom : "";
}

const GENERIQUE = /^(de\s+)?(l['’]\s*|la\s+|le\s+|votre\s+|vos\s+|ta\s+|ton\s+)?(achat|commande|r[ée]servation|paiement|billets?|e-?billets?|confirmation|re[çc]u|facture|order|purchase|tickets?)\b/i;

export function devinerTitre(sujet, type, exp = {}) {
  const lieu = nomDuLieu(exp);
  if (type === "musee" && lieu) return lieu; // pour un musée, son nom suffit
  let t = (sujet || "").replace(/^\s*((TR|FWD?|RE|TRANSF)\s*:\s*)+/i, "");
  t = t.replace(/\b(confirmation|r[ée]capitulatif)\s+(de\s+|du\s+)?(l['’]\s*|la\s+|le\s+|votre\s+)?(commande|r[ée]servation|achat|paiement|voyage)\s*(n[°o]?\s*\S+)?\s*(:|-)?\s*/i, "");
  t = t.replace(/\b(vos|votre|tes|ton)\s+(e-?)?billets?\s*(electroniques?|électroniques?)?\s*(pour|:|-)?\s*/i, "");
  t = t.replace(/\be-?billets?\s*(:|-)?\s*/i, "").replace(/\s{2,}/g, " ").trim().replace(/^[:\-–\s]+/, "");
  if (!t || GENERIQUE.test(t)) t = lieu;
  if (t.length > 80) t = t.slice(0, 77) + "…";
  return t || { train: "Voyage en train", concert: "Concert", spectacle: "Spectacle", cine: "Séance de ciné", avion: "Vol", musee: "Musée" }[type] || "Billet";
}

// Billet, facture ou simple document (plan, règlement…) ?
const MARQUES_BILLET = /E-?BILLET|E-?TICKET|BILLET D.?ENTREE|TICKET D.?ENTREE|A PRESENTER|PRESENTEZ|SCANN|CODE.?BARRES?|BARCODE|\bQR\b|ADMISSION|VALABLE|CONTROLE|CRENEAU|PASSAGER|VOITURE|PLACE\s*:?\s*\d|SEAT|GATE/;
export function natureDocument(texte, personnes) {
  const t = norm(texte);
  if (/FACTURE|INVOICE|RECU DE PAIEMENT|RECEIPT|AVOIR\b/.test(t.slice(0, 500))) return "facture";
  const indicesFacture = (t.match(/FACTURE|INVOICE|\bTVA\b|\bTTC\b|\bHT\b|SIRET|MONTANT|TOTAL|MOYEN DE PAIEMENT/g) || []).length;
  const billet = MARQUES_BILLET.test(t) || personnes.some((p) => p.motif.test(t));
  if (indicesFacture >= 4 && !/E-?BILLET|E-?TICKET|A PRESENTER|SCANN/.test(t)) return "facture";
  return billet ? "billet" : "document";
}

export function devinerDetails(texte) {
  const t = norm(texte);
  const voiture = (t.match(/\bVOITURE\s*:?\s*(\d{1,3})\b/) || [])[1] || "";
  const place = (t.match(/\bPLACES?\s*:?\s*(\d{1,4}[A-Z]?)\b/) || [])[1] || "";
  const dossier = (t.match(/\b(?:DOSSIER|REFERENCE(?:\s+DE\s+(?:DOSSIER|RESERVATION))?|PNR)\s*:?\s*([A-Z0-9]{6})\b/) || [])[1] || "";
  return { voiture, place, dossier };
}

// ───────────── Billets à télécharger depuis un lien de l'e-mail ─────────────
const domaine = (url) => { try { return new URL(url).hostname; } catch { return "?"; } };

export function liensBillets(html) {
  const liens = [];
  for (const r of (html || "").matchAll(/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const url = r[1].replace(/&amp;/g, "&");
    const texte = r[2].replace(/<[^>]+>/g, " ");
    const tout = url + " " + texte;
    if (!/^https:\/\//i.test(url)) continue;
    if (/unsubscribe|desinscri|d[ée]sabonn|facebook|instagram|twitter|youtube|linkedin|tiktok|privacy|confidentialit|cgv|conditions/i.test(tout)) continue;
    if (/billet|ticket|t[ée]l[ée]charg|download|\.pdf|imprimer|print/i.test(tout)) liens.push(url);
  }
  return [...new Set(liens)].slice(0, 6);
}

async function telechargerLien(url) {
  try {
    const arret = new AbortController();
    const minuteur = setTimeout(() => arret.abort(), 15000);
    const rep = await fetch(url, { redirect: "follow", signal: arret.signal, headers: { "User-Agent": "Mozilla/5.0 (Goupil)" } });
    clearTimeout(minuteur);
    const type = rep.headers.get("content-type") || "";
    if (!rep.ok || +(rep.headers.get("content-length") || 0) > TAILLE_MAX) {
      console.log(`      Lien ignoré (erreur ${rep.status}) sur ${domaine(url)}`);
      return null;
    }
    const buffer = Buffer.from(await rep.arrayBuffer());
    if (buffer.length > TAILLE_MAX || buffer.subarray(0, 4).toString() !== "%PDF") {
      console.log(`      Lien ignoré sur ${domaine(url)} : ce n’est pas un PDF${/html/.test(type) ? " (sans doute une page qui demande de se connecter)" : ""}`);
      return null;
    }
    const entete = (rep.headers.get("content-disposition") || "").match(/filename\*?=(?:UTF-8'')?"?([^";]+)/i);
    let filename = "billet.pdf";
    try { filename = decodeURIComponent(entete?.[1] || new URL(rep.url).pathname.split("/").pop() || "billet.pdf"); } catch {}
    if (!/\.pdf$/i.test(filename)) filename += ".pdf";
    console.log(`      📥 PDF téléchargé depuis un lien sur ${domaine(url)}`);
    return { filename, contentType: "application/pdf", size: buffer.length, content: buffer };
  } catch (e) {
    console.log(`      Lien inaccessible sur ${domaine(url)} (${e.message})`);
    return null;
  }
}

// ───────────── Rangement dans Firebase ─────────────
async function enregistrerFichier(db, buffer, nom, mime) {
  const b64 = Buffer.from(buffer).toString("base64");
  const ref = db.collection("fichiers").doc();
  const nbMorceaux = Math.ceil(b64.length / MORCEAU);
  for (let i = 0; i < nbMorceaux; i++) {
    await db.collection("morceaux").doc(`${ref.id}_${i}`).set({ data: b64.slice(i * MORCEAU, (i + 1) * MORCEAU) });
  }
  await ref.set({ nom, mime, taille: buffer.length, nbMorceaux, par: "goupil", creeLe: Date.now() });
  return { id: ref.id, nom, mime };
}

async function decouperPdf(buffer, pages) {
  const source = await PDFDocument.load(buffer, { ignoreEncryption: true });
  const nouveau = await PDFDocument.create();
  const copies = await nouveau.copyPages(source, pages);
  copies.forEach((p) => nouveau.addPage(p));
  return Buffer.from(await nouveau.save());
}

// Trouve la note du même jour sur le frigo, ou en crée une
async function noteDuJour(db, notes, infos, envoyes, maintenant) {
  if (!infos.date) return null;
  const memeJour = notes.filter((n) => !n.fait && n.date === infos.date);
  const trouvee = memeJour.find((n) => infos.heure && n.heure === infos.heure) || memeJour.find((n) => n.type !== "tache");
  if (trouvee) return trouvee.id;
  const note = {
    type: "sortie", titre: infos.titre, date: infos.date, heure: infos.heure, rappel: "60",
    memo: "", photos: [], fait: false, par: "goupil", creeLe: maintenant,
  };
  const ref = await db.collection("notes").add(note);
  notes.push({ id: ref.id, ...note });
  envoyes["nouvelle-" + ref.id] = maintenant;
  return ref.id;
}

// ───────────── Le tri d'un e-mail ─────────────
export async function traiterMail(mail, { db, personnes, notes, envoyes, maintenant }) {
  const exp = expediteurOriginal(mail);
  let pieces = (mail.attachments || []).filter((a) =>
    (a.contentType === "application/pdf" || /^image\/(png|jpe?g)$/.test(a.contentType) || /\.pdf$/i.test(a.filename || ""))
    && a.size <= TAILLE_MAX);
  console.log(`   ✉️  E-mail venant de …@${(exp.adresse || "").split("@")[1] || "?"}`);
  console.log(`      Pièces jointes : ${(mail.attachments || []).map((a) => `${a.contentType} (${Math.round(a.size / 1024)} Ko)`).join(", ") || "aucune"}`);
  if (!pieces.length) {
    const liens = liensBillets(mail.html);
    if (liens.length) console.log(`      Pas de billet en pièce jointe : j’essaie ${liens.length} lien(s) de téléchargement…`);
    for (const url of liens) {
      const piece = await telechargerLien(url);
      if (piece) pieces.push(piece);
    }
  }

  // On lit chaque document et on ne garde que les billets (pas les factures ni les plans)
  let lus = [];
  for (const p of pieces) {
    const estPdf = p.contentType === "application/pdf" || /\.pdf$/i.test(p.filename || "");
    const pages = estPdf ? await pagesTexte(p.content) : [];
    const nature = estPdf ? natureDocument(pages.join(" "), personnes) : "billet";
    console.log(`      ${estPdf ? `PDF (${pages.length} page${pages.length > 1 ? "s" : ""})` : "Image"} : ${nature}`);
    lus.push({ piece: p, estPdf, pages, nature });
  }
  lus = lus.filter((l) => l.nature !== "facture");
  if (lus.some((l) => l.nature === "billet")) lus = lus.filter((l) => l.nature === "billet");
  if (!lus.length) {
    console.log("      → Ignoré : aucun billet trouvé (seulement des factures ou rien du tout).");
    return [];
  }

  const textes = lus.map((l) => l.pages.join("\n"));
  const toutLeTexte = [mail.subject || "", mail.text || "", ...textes].join("\n");
  const type = devinerType(toutLeTexte, exp);
  const quandC = devinerDate(textes.join("\n") + "\n" + (mail.text || "") + "\n" + (mail.subject || ""), new Date(), mail.date);
  const infos = { type, titre: devinerTitre(mail.subject, type, exp), date: quandC?.date || "", heure: quandC?.heure || "" };
  console.log(`      Devinés : type ${infos.type}, date ${infos.date || "?"} ${infos.heure || "(heure ?)"}`);
  const noteId = await noteDuJour(db, notes, infos, envoyes, maintenant);

  const ranges = [];
  for (const { piece, estPdf, pages } of lus) {
    const nom = piece.filename || (estPdf ? "billet.pdf" : "billet.jpg");
    const mime = estPdf ? "application/pdf" : piece.contentType;
    let parts = [{ proprietaire: estPdf ? quiEst(pages.join(" "), personnes) : null, buffer: piece.content, texte: pages.join(" ") }];
    if (estPdf && pages.length > 1) {
      const groupes = groupesDePages(pages.map((t) => quiEst(t, personnes)));
      if (groupes.length > 1) {
        parts = [];
        for (const g of groupes) {
          try {
            parts.push({
              proprietaire: g.proprietaire,
              buffer: await decouperPdf(piece.content, g.pages),
              texte: g.pages.map((i) => pages[i]).join(" "),
            });
          } catch (e) {
            console.log("      Découpage impossible, PDF gardé entier :", e.message);
            parts = [{ proprietaire: null, buffer: piece.content, texte: pages.join(" ") }];
            break;
          }
        }
      }
    }
    console.log(`      → ${parts.length} billet(s) : ${parts.map((x) => x.proprietaire ? (x.proprietaire === "tous" ? "nous deux" : "attribué") : "à trier").join(", ")}`);
    for (const part of parts) {
      const fichier = await enregistrerFichier(db, part.buffer, nom, mime);
      const billet = {
        type: infos.type, titre: infos.titre, date: infos.date, heure: infos.heure, lieu: "",
        details: devinerDetails(part.texte), proprietaire: part.proprietaire, fichiers: [fichier],
        noteId, source: "mail", expediteur: exp.adresse || "",
        aVerifier: !infos.date || !part.proprietaire, par: "goupil", creeLe: maintenant,
      };
      await db.collection("billets").add(billet);
      ranges.push(billet);
    }
  }
  return ranges;
}

// ───────────── Le passage du facteur ─────────────
export async function importerBillets({ db, prenoms, notes, envoyes, maintenant }) {
  const adresse = (process.env.GMAIL_ADRESSE || "").trim();
  const motDePasse = (process.env.GMAIL_MOT_DE_PASSE_APPLI || "").replace(/\s/g, "");
  if (!adresse || !motDePasse) {
    console.log(`🎟 Facteur en pause : secret GMAIL_ADRESSE ${adresse ? "présent" : "ABSENT"}, secret GMAIL_MOT_DE_PASSE_APPLI ${motDePasse ? "présent" : "ABSENT"}.`);
    return [];
  }
  if (motDePasse.length !== 16) console.log(`⚠️ Le mot de passe d’application fait ${motDePasse.length} caractères au lieu de 16.`);

  const personnes = Object.entries(prenoms)
    .filter(([, prenom]) => prenom && prenom.length >= 2)
    .map(([uid, prenom]) => ({ uid, prenom, motif: new RegExp(`\\b${norm(prenom).replace(/[^A-Z0-9 -]/g, "")}\\b`) }));
  console.log(`🎟 Prénoms recherchés dans les billets : ${personnes.map((p) => p.prenom.charAt(0) + "…").join(", ") || "aucun"}`);

  // Les e-mails déjà traités (on regarde les 3 derniers jours, lus ou non)
  const etatRef = db.doc("robot/courrier");
  const etatSnap = await etatRef.get();
  const deja = (etatSnap.exists && etatSnap.data().ids) || {};

  const client = new ImapFlow({
    host: "imap.gmail.com", port: 993, secure: true, logger: false,
    auth: { user: adresse, pass: motDePasse },
  });
  const ranges = [];
  await client.connect();
  console.log("📬 Connecté à la boîte de Goupil.");
  try {
    const dossiers = await client.list();
    const spams = dossiers.find((d) => d.specialUse === "\\Junk");
    if (spams) {
      const st = await client.status(spams.path, { messages: true });
      if (st.messages) console.log(`⚠️ ${st.messages} e-mail(s) dans les spams de Goupil : un billet s’y cache peut-être.`);
    }
  } catch {}

  const verrou = await client.getMailboxLock("INBOX");
  try {
    const depuis = new Date(maintenant - 3 * 86400000);
    const recents = (await client.search({ since: depuis }, { uid: true })) || [];
    console.log(`📬 Boîte de réception : ${client.mailbox?.exists ?? "?"} e-mail(s) en tout, ${recents.length} reçu(s) ces 3 derniers jours.`);
    for (const uid of recents.slice(-15)) {
      try {
        const message = await client.fetchOne(uid, { envelope: true, source: true }, { uid: true });
        const id = message.envelope?.messageId || `uid-${uid}`;
        if (deja[id]) continue;
        const mail = await simpleParser(message.source);
        ranges.push(...(await traiterMail(mail, { db, personnes, notes, envoyes, maintenant })));
        deja[id] = maintenant;
        await client.messageFlagsAdd(uid, ["\\Seen"], { uid: true });
      } catch (e) {
        console.log("   E-mail non traité :", e.message);
      }
    }
  } finally {
    verrou.release();
    await client.logout();
  }
  for (const k of Object.keys(deja)) if (maintenant - deja[k] > 10 * 86400000) delete deja[k];
  await etatRef.set({ ids: deja });
  return ranges;
}
