/**
 * État de l'exposition « Voyageurs douaisiens » (voyageurs.html et son
 * éditeur voyageurs-admin.html), stocké dans R2 sous la clé `voyageurs.json`.
 *
 * Sur la branche `local-server`, ces données vivent dans le schéma Postgres
 * `expo_voyageurs` (cinq tables). Ici, un seul objet JSON, dans la forme que
 * l'éditeur manipule déjà :
 *   { voyageurs: [{ id, nom, vie, lienDouai, portrait, couleur, resume,
 *                   publie, version, ecrits:[{titre, annee, cote}],
 *                   voyages:[{ id, voyageurId, titre, sousTitre, publie,
 *                              version, sources:[…],
 *                              points:[{ lieu, coord:[lng,lat], date, depart,
 *                                        approx, mode, zoom, arret }] }] }] }
 * L'ordre des tableaux EST l'ordre d'affichage (les colonnes `ordre` de
 * Postgres n'ont plus d'équivalent). `version` est l'horodatage du dernier
 * enregistrement de la fiche : il joue le rôle d'`updated_at` pour détecter
 * qu'un·e collègue a enregistré entre-temps.
 *
 * Ce module ne fait aucune entrée/sortie : il ne contient que les règles
 * (celles des CHECK et contraintes SQL de local-server, reprises à la main),
 * pour être partagé entre api/voyageurs-admin.mjs et
 * scripts/seed-voyageurs.mjs.
 */

export const VOYAGEURS_KEY = 'voyageurs.json';
export const emptyVoyageursState = () => ({ voyageurs: [] });

const ID_RE = /^[a-z0-9-]+$/;
const DATE_RE = /^\d{4}(-\d{2}(-\d{2})?)?$/;
const COULEUR_RE = /^#[0-9A-Fa-f]{6}$/;
const MODES = new Set(['bateau', 'jonque', 'pied', 'attelage', 'cheval', 'civiere', 'inconnu']);
// Bornes du zoom forcé d'une étape — mêmes que MAX_ZOOM dans js/voyageurs.js.
const ZOOM_MIN = 1, ZOOM_MAX = 13;

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const bad = (msg) => new HttpError(400, msg);

/** Chaîne nettoyée, ou '' si vide. */
function txt(v) {
  return v == null ? '' : String(v).trim();
}

function checkDate(value, label) {
  const s = txt(value);
  if (!s) return '';
  if (!DATE_RE.test(s)) throw bad(`${label} : « ${s} » n'est pas au format AAAA, AAAA-MM ou AAAA-MM-JJ.`);
  const [, mo, d] = s.split('-').map(Number);
  if (mo != null && (mo < 1 || mo > 12)) throw bad(`${label} : mois invalide (« ${s} »).`);
  if (d != null && (d < 1 || d > 31)) throw bad(`${label} : jour invalide (« ${s} »).`);
  return s;
}

function findVoyageur(state, id) {
  return state.voyageurs.find(v => v.id === id) || null;
}
function findVoyage(state, id) {
  for (const voyageur of state.voyageurs) {
    const index = voyageur.voyages.findIndex(y => y.id === id);
    if (index !== -1) return { voyageur, index, voyage: voyageur.voyages[index] };
  }
  return null;
}

function checkVersion(record, id, version) {
  if (!record) throw new HttpError(404, `« ${id} » n'existe plus (supprimé par un·e collègue ?).`);
  if (version && record.version !== version) {
    throw new HttpError(409, 'Cette fiche a été modifiée entre-temps par un·e collègue. ' +
      'Rechargez la page pour récupérer sa version (vos modifications non enregistrées seront perdues).');
  }
}

function normalizePoint(p, i) {
  const n = i + 1;
  const lng = Number(p?.coord?.[0]), lat = Number(p?.coord?.[1]);
  if (!Number.isFinite(lng) || lng < -180 || lng > 180) throw bad(`Étape ${n} : longitude invalide.`);
  if (!Number.isFinite(lat) || lat < -90 || lat > 90) throw bad(`Étape ${n} : latitude invalide.`);
  const date = checkDate(p.date, `Étape ${n}, date d'arrivée`);
  const depart = checkDate(p.depart, `Étape ${n}, date de départ`);
  if (depart && !date) throw bad(`Étape ${n} : une date de départ demande aussi une date d'arrivée.`);
  const mode = txt(p.mode);
  if (mode && !MODES.has(mode)) throw bad(`Étape ${n} : moyen de transport inconnu (« ${mode} »).`);
  // Zoom forcé : vide = automatique (d'après le moyen de transport).
  let zoom = '';
  if (p.zoom != null && String(p.zoom).trim() !== '') {
    zoom = Number(String(p.zoom).replace(',', '.'));
    if (!Number.isFinite(zoom) || zoom < ZOOM_MIN || zoom > ZOOM_MAX) {
      throw bad(`Étape ${n} : zoom invalide (entre ${ZOOM_MIN} et ${ZOOM_MAX}, ou vide pour automatique).`);
    }
    zoom = Math.round(zoom * 10) / 10;
  }
  const a = p.arret || null;
  const arret = a ? {
    titre: txt(a.titre), texte: txt(a.texte), citation: txt(a.citation), source: txt(a.source),
  } : null;
  if (arret && !arret.titre && (arret.texte || arret.citation || arret.source)) {
    throw bad(`Étape ${n} : un arrêt raconté doit avoir un titre.`);
  }
  return {
    lieu: txt(p.lieu), coord: [Math.round(lng * 1e5) / 1e5, Math.round(lat * 1e5) / 1e5],
    date, depart, approx: !!p.approx, mode, zoom,
    // Sans titre, l'étape n'est qu'un point de passage.
    arret: arret && arret.titre ? arret : null,
  };
}

function saveVoyageur(state, body, now) {
  const v = body.voyageur || {};
  const id = txt(v.id);
  const nom = txt(v.nom);
  if (!nom) throw bad('Le nom du voyageur est obligatoire.');
  if (!id || !ID_RE.test(id)) throw bad('Identifiant : minuscules, chiffres et tirets uniquement (ex. trigault).');
  const couleur = txt(v.couleur) || '#B4213C';
  if (!COULEUR_RE.test(couleur)) throw bad('Couleur : format #RRGGBB attendu.');
  const ecrits = (Array.isArray(v.ecrits) ? v.ecrits : [])
    .map(e => ({ titre: txt(e.titre), annee: txt(e.annee), cote: txt(e.cote) }))
    .filter(e => e.titre || e.annee || e.cote);
  if (ecrits.some(e => !e.titre)) throw bad('Chaque écrit doit avoir un titre.');

  const originalId = txt(body.originalId);
  const existing = originalId ? findVoyageur(state, originalId) : null;
  if (originalId) checkVersion(existing, originalId, body.version);
  if (id !== originalId && findVoyageur(state, id)) {
    throw bad('Cet identifiant est déjà utilisé : choisissez-en un autre.');
  }

  const fields = {
    id, nom, vie: txt(v.vie), lienDouai: txt(v.lienDouai), portrait: txt(v.portrait),
    couleur, resume: txt(v.resume), publie: !!v.publie, version: now, ecrits,
  };
  if (existing) {
    // Les voyages ne sont pas touchés ; ils suivent seulement un changement
    // d'identifiant (l'équivalent du ON UPDATE CASCADE de local-server).
    Object.assign(existing, fields);
    for (const y of existing.voyages) y.voyageurId = id;
  } else {
    state.voyageurs.push({ ...fields, voyages: [] });
  }
  return id;
}

function saveVoyage(state, body, now) {
  const y = body.voyage || {};
  const id = txt(y.id);
  const titre = txt(y.titre);
  const voyageurId = txt(y.voyageurId);
  if (!titre) throw bad('Le titre du voyage est obligatoire.');
  if (!id || !ID_RE.test(id)) throw bad('Identifiant du voyage : minuscules, chiffres et tirets uniquement (ex. trigault-1618).');
  if (!voyageurId) throw bad('Voyageur manquant.');
  const points = (Array.isArray(y.points) ? y.points : []).map(normalizePoint);
  const sources = (Array.isArray(y.sources) ? y.sources : []).map(txt).filter(Boolean);
  const publie = !!y.publie;
  if (publie) {
    if (points.length < 2) throw bad('Un voyage publié doit avoir au moins deux étapes.');
    if (!points.some(p => p.date)) throw bad('Un voyage publié doit avoir au moins une étape datée.');
  }

  const originalId = txt(body.originalId);
  const found = originalId ? findVoyage(state, originalId) : null;
  if (originalId) checkVersion(found && found.voyage, originalId, body.version);
  if (id !== originalId && findVoyage(state, id)) {
    throw bad('Cet identifiant est déjà utilisé : choisissez-en un autre.');
  }
  const owner = findVoyageur(state, voyageurId);
  if (!owner) throw bad('Le voyageur rattaché n\'existe pas (supprimé entre-temps ?).');

  // Le voyage est réécrit en bloc : l'éditeur envoie toujours le voyage
  // complet, jamais un patch d'étape isolée.
  const voyage = { id, voyageurId, titre, sousTitre: txt(y.sousTitre), publie, version: now, sources, points };
  if (found && found.voyageur === owner) {
    owner.voyages[found.index] = voyage;
  } else {
    if (found) found.voyageur.voyages.splice(found.index, 1);
    owner.voyages.push(voyage);
  }
  return id;
}

/* Les fiches nommées dans `ids` se redistribuent, dans l'ordre demandé, sur
   les places qu'elles occupaient ; celles qui n'y figurent pas (créées par
   un·e collègue depuis le chargement de la page) ne bougent pas. */
function reorderList(list, ids) {
  const rank = new Map(ids.map((id, i) => [String(id), i]));
  const moved = list.filter(x => rank.has(x.id)).sort((a, b) => rank.get(a.id) - rank.get(b.id));
  let next = 0;
  return list.map(x => (rank.has(x.id) ? moved[next++] : x));
}

function reorder(state, body) {
  if (!Array.isArray(body.ids)) throw bad('Réordonnancement : paramètres invalides.');
  if (body.kind === 'voyageurs') {
    state.voyageurs = reorderList(state.voyageurs, body.ids);
  } else if (body.kind === 'voyages') {
    for (const v of state.voyageurs) v.voyages = reorderList(v.voyages, body.ids);
  } else {
    throw bad('Réordonnancement : paramètres invalides.');
  }
  return null;
}

function deleteVoyageur(state, body) {
  if (!txt(body.id)) throw bad('Identifiant manquant.');
  // Ses voyages partent avec lui (ils sont rangés dans sa fiche).
  state.voyageurs = state.voyageurs.filter(v => v.id !== body.id);
  return null;
}

function deleteVoyage(state, body) {
  if (!txt(body.id)) throw bad('Identifiant manquant.');
  const found = findVoyage(state, body.id);
  if (found) found.voyageur.voyages.splice(found.index, 1);
  return null;
}

const ACTIONS = { saveVoyageur, saveVoyage, reorder, deleteVoyageur, deleteVoyage };

/** Tolère un objet R2 absent, vide ou sans tableau `voyages`. */
export function normalizeVoyageursState(state) {
  const voyageurs = Array.isArray(state && state.voyageurs) ? state.voyageurs : [];
  for (const v of voyageurs) if (!Array.isArray(v.voyages)) v.voyages = [];
  return { voyageurs };
}

/**
 * Applique une action de l'éditeur à l'état (modifié en place) et renvoie
 * l'identifiant de la fiche enregistrée, ou null. Lève une HttpError — rien
 * n'est alors écrit, l'appelant n'ayant pas encore renvoyé l'état à R2.
 */
export function applyVoyageursAction(state, body, now = new Date().toISOString()) {
  const action = ACTIONS[body && body.action];
  if (!action) throw bad(`Action inconnue : ${body && body.action}`);
  return action(state, body, now);
}

function compact(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v == null || v === false || v === '') continue;
    if (Array.isArray(v) && !v.length) continue;
    out[k] = v;
  }
  return out;
}

/**
 * Ce que lit js/voyageurs.js : les voyageurs et voyages `publie` seulement
 * (les brouillons sont des notes de recherche), clés vides omises.
 */
export function publicVoyageurs(state) {
  return state.voyageurs.filter(v => v.publie).map(v => compact({
    id: v.id, nom: v.nom, vie: v.vie, lienDouai: v.lienDouai, portrait: v.portrait,
    couleur: v.couleur, resume: v.resume,
    ecrits: (v.ecrits || []).map(compact),
    voyages: v.voyages
      // Un voyage sans étape ne peut pas être tracé : on ne l'expose pas.
      .filter(y => y.publie && (y.points || []).length >= 2)
      .map(y => compact({
        id: y.id, titre: y.titre, sousTitre: y.sousTitre, sources: y.sources,
        points: y.points.map(p => compact({
          lieu: p.lieu, coord: p.coord, date: p.date, depart: p.depart,
          approx: p.approx, mode: p.mode, zoom: p.zoom,
          arret: p.arret ? compact(p.arret) : null,
        })),
      })),
  }));
}

/**
 * Convertit vers l'état R2 soit la réponse de GET /api/voyageurs-admin
 * (`{voyageurs:[…]}`, brouillons compris), soit le tableau de
 * data/voyageurs.json (publiés seulement — tout y est donc marqué publié).
 * Chaque fiche repasse par les contrôles d'enregistrement.
 */
export function importVoyageurs(input, now = new Date().toISOString()) {
  const complet = !Array.isArray(input);
  const list = complet ? input && input.voyageurs : input;
  if (!Array.isArray(list)) throw new Error('Format non reconnu : tableau de voyageurs attendu.');
  const state = emptyVoyageursState();
  for (const v of list) {
    saveVoyageur(state, { voyageur: { ...v, publie: complet ? v.publie : true } }, now);
    for (const y of v.voyages || []) {
      saveVoyage(state, { voyage: { ...y, voyageurId: v.id, publie: complet ? y.publie : true } }, now);
    }
  }
  return state;
}
