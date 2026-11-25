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

// Regroupe les pages consécutives d'une même personne
export function groupesDePages(proprietaires) {
  const rempli = [...proprietaires];
  let dernier = rempli.find((p) => p) ?? null;
  for (let i = 0; i < rempli.length; i++) {
    if (rempli[i]) dernier = rempli[i];
    else rempli[i] = dernier;
  }
  const groupes = [];
  rempli.forEach((p, i) => {
    const g = groupes[groupes.length - 1];
    if (g && g.proprietaire === p) g.pages.push(i);
    else groupes.push({ proprietaire: p, pages: [i] });
  });
  return groupes;
}

// ───────────── Deviner la date, l'heure, le type ─────────────
const MOIS = {
  JANVIER: 1, JANV: 1, FEVRIER: 2, FEVR: 2, FEV: 2, MARS: 3, AVRIL: 4, AVR: 4, MAI: 5, JUIN: 6,
  JUILLET: 7, JUIL: 7, AOUT: 8, SEPTEMBRE: 9, SEPT: 9, OCTOBRE: 10, OCT: 10, NOVEMBRE: 11, NOV: 11, DECEMBRE: 12, DEC: 12,
};

export function devinerDate(texte, maintenant = new Date()) {
  const t = norm(texte);
  const hier = new Date(maintenant); hier.setHours(0, 0, 0, 0); hier.setDate(hier.getDate() - 1);
  const candidats = [];
  const ajouter = (j, m, a, index) => {
    if (a > 0 && a < 100) a += 2000;
    if (!a) {
      a = maintenant.getFullYear();
      if (new Date(a, m - 1, j) < hier) a++;
    }
    const d = new Date(a, m - 1, j);
    if (d.getMonth() !== m - 1 || d < hier || a > maintenant.getFullYear() + 2) return;
    candidats.push({ d, index });
  };
  for (const r of t.matchAll(/\b(\d{1,2})[\/.](\d{1,2})[\/.](\d{2,4})\b/g)) ajouter(+r[1], +r[2], +r[3], r.index);
  for (const r of t.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)) ajouter(+r[3], +r[2], +r[1], r.index);
  const noms = Object.keys(MOIS).join("|");
  for (const r of t.matchAll(new RegExp(`\\b(\\d{1,2})(?:ER)?\\s+(${noms})\\.?(?:\\s+(\\d{4}))?`, "g"))) {
    ajouter(+r[1], MOIS[r[2]], r[3] ? +r[3] : 0, r.index);
  }
  if (!candidats.length) return null;
  candidats.sort((a, b) => a.d - b.d);
  const choisi = candidats[0];
  // L'heure : on la cherche juste après la date, sinon n'importe où
  const apres = t.slice(choisi.index, choisi.index + 160);
  const motifHeure = /\b([01]?\d|2[0-3])\s?(?:H|:)\s?([0-5]\d)?\b/;
  const h = apres.match(motifHeure) || t.match(motifHeure);
  const heure = h ? `${pad(+h[1])}:${h[2] || "00"}` : "";
  return { date: versCle(choisi.d), heure };
}

const TYPES = [
  ["train", /SNCF|OUIGO|TGV|INOUI|\bTER\b|TRENITALIA|EUROSTAR|LYRIA|BILLET DE TRAIN|\bVOITURE\s*\d/],
  ["avion", /AIR ?FRANCE|EASYJET|RYANAIR|TRANSAVIA|VUELING|CARTE D.EMBARQUEMENT|BOARDING/],
  ["cine", /CINEMA|\bUGC\b|PATHE|GAUMONT|\bMK2\b|SEANCE/],
  ["concert", /CONCERT|TICKETMASTER|ZENITH|OLYMPIA|FESTIVAL|LIVE NATION|ARENA|SEE TICKETS|DICE/],
  ["spectacle", /THEATRE|SPECTACLE|OPERA|BALLET|COMEDIE|HUMOUR|STAND.?UP|CIRQUE/],
];
export const devinerType = (texte) => (TYPES.find(([, motif]) => motif.test(norm(texte))) || ["autre"])[0];

export function devinerTitre(sujet, type) {
  let t = (sujet || "").replace(/^\s*((TR|FWD?|RE|TRANSF)\s*:\s*)+/i, "");
  t = t.replace(/\b(confirmation|r[ée]capitulatif)\s+(de\s+)?(votre\s+)?(commande|r[ée]servation|achat|voyage)\s*(n[°o]?\s*\S+)?\s*(:|-)?\s*/i, "");
  t = t.replace(/\b(vos|votre|tes|ton)\s+(e-?)?billets?\s*(electroniques?|électroniques?)?\s*(pour|:|-)?\s*/i, "");
  t = t.replace(/\be-?billets?\s*(:|-)?\s*/i, "").replace(/\s{2,}/g, " ").trim().replace(/^[:\-–\s]+/, "");
  if (t.length > 80) t = t.slice(0, 77) + "…";
  return t || { train: "Voyage en train", concert: "Concert", spectacle: "Spectacle", cine: "Séance de ciné", avion: "Vol" }[type] || "Billet";
}

export function devinerDetails(texte) {
  const t = norm(texte);
  const voiture = (t.match(/\bVOITURE\s*:?\s*(\d{1,3})\b/) || [])[1] || "";
  const place = (t.match(/\bPLACES?\s*:?\s*(\d{1,4}[A-Z]?)\b/) || [])[1] || "";
  const dossier = (t.match(/\b(?:DOSSIER|REFERENCE(?:\s+DE\s+(?:DOSSIER|RESERVATION))?|PNR)\s*:?\s*([A-Z0-9]{6})\b/) || [])[1] || "";
  return { voiture, place, dossier };
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
  const pieces = (mail.attachments || []).filter((a) =>
    (a.contentType === "application/pdf" || /^image\/(png|jpe?g)$/.test(a.contentType) || /\.pdf$/i.test(a.filename || ""))
    && a.size <= TAILLE_MAX);
  if (!pieces.length) {
    console.log("E-mail sans billet en pièce jointe :", mail.subject);
    return [];
  }

  // On lit tout le texte disponible pour deviner les infos
  const textes = [];
  const lus = [];
  for (const p of pieces) {
    const estPdf = p.contentType === "application/pdf" || /\.pdf$/i.test(p.filename || "");
    const pages = estPdf ? await pagesTexte(p.content) : [];
    lus.push({ piece: p, estPdf, pages });
    textes.push(pages.join("\n"));
  }
  const toutLeTexte = [mail.subject || "", mail.text || "", ...textes].join("\n");
  const type = devinerType(toutLeTexte + " " + (mail.from?.text || ""));
  const quandC = devinerDate(textes.join("\n") + "\n" + (mail.text || "") + "\n" + (mail.subject || ""));
  const infos = { type, titre: devinerTitre(mail.subject, type), date: quandC?.date || "", heure: quandC?.heure || "" };
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
            console.log("Découpage impossible, PDF gardé entier :", e.message);
            parts = [{ proprietaire: null, buffer: piece.content, texte: pages.join(" ") }];
            break;
          }
        }
      }
    }
    for (const part of parts) {
      const fichier = await enregistrerFichier(db, part.buffer, nom, mime);
      const billet = {
        type: infos.type, titre: infos.titre, date: infos.date, heure: infos.heure, lieu: "",
        details: devinerDetails(part.texte), proprietaire: part.proprietaire, fichiers: [fichier],
        noteId, source: "mail", expediteur: mail.from?.text || "",
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
  const adresse = process.env.GMAIL_ADRESSE;
  const motDePasse = (process.env.GMAIL_MOT_DE_PASSE_APPLI || "").replace(/\s/g, "");
  if (!adresse || !motDePasse) return [];

  const personnes = Object.entries(prenoms)
    .filter(([, prenom]) => prenom && prenom.length >= 2)
    .map(([uid, prenom]) => ({ uid, motif: new RegExp(`\\b${norm(prenom).replace(/[^A-Z0-9 -]/g, "")}\\b`) }));

  const client = new ImapFlow({
    host: "imap.gmail.com", port: 993, secure: true, logger: false,
    auth: { user: adresse, pass: motDePasse },
  });
  const ranges = [];
  await client.connect();
  const verrou = await client.getMailboxLock("INBOX");
  try {
    const nouveaux = (await client.search({ seen: false }, { uid: true })) || [];
    for (const uid of nouveaux.slice(0, 10)) {
      try {
        const message = await client.fetchOne(uid, { source: true }, { uid: true });
        const mail = await simpleParser(message.source);
        ranges.push(...(await traiterMail(mail, { db, personnes, notes, envoyes, maintenant })));
      } catch (e) {
        console.log("E-mail non traité :", e.message);
      }
      await client.messageFlagsAdd(uid, ["\\Seen"], { uid: true });
    }
  } finally {
    verrou.release();
    await client.logout();
  }
  return ranges;
}
