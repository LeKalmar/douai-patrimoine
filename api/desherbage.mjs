/**
 * État partagé des décisions de désherbage prises via rotobib.html, stocké
 * dans R2 sous la clé "desherbage-traitements.json" — forme
 * { [barcode]: {barcode, statut, ts, validation?} }, avec statut ∈
 * 'conserver' | 'pilon' | 'braderie' | 'relocalisation'. Voir CLAUDE.md,
 * section Rotobib.
 *
 * `validation` (facultatif) = l'avis du collègue chargé de valider la
 * campagne, saisi dans validation-desherbage.html :
 *   { avis, commentaire, statutVu, par, ts }
 *   - avis : 'valide' (d'accord avec la décision), un autre statut
 *     (contre-proposition), ou null (commentaire seul) ;
 *   - statutVu : la décision de l'équipe au moment de l'avis — si elle a
 *     changé depuis, l'avis est à revoir (comparé côté pages, pas ici).
 * Rangé sur l'enregistrement de la décision plutôt que dans une clé R2 à
 * part : api/ compte déjà 12 fonctions, le plafond du plan Vercel Hobby.
 *
 * GET  → l'état courant (lecture non authentifiée, même niveau d'exposition
 *        que le reste des données partagées du projet).
 * POST → un patch, fusionné via compare-and-swap (r2CasUpdate),
 *        authentification requise (voir lib/auth.mjs) :
 *   {type:'set', record:{barcode,statut,ts}} — choix ou changement de
 *        traitement ; une `validation` déjà posée est CONSERVÉE (rotobib.html
 *        n'envoie que barcode/statut/ts : sans ça, changer d'avis côté équipe
 *        effacerait le commentaire du validateur) ;
 *   {type:'clear', barcode} — annule le traitement (redevient "non traité",
 *        avis compris) ;
 *   {type:'review', barcode, validation|null} — pose, remplace ou retire
 *        l'avis du validateur ;
 *   {type:'reviewMany', items:[{barcode, validation}]} — idem par lot
 *        (« Valider tous les livres affichés »).
 *   Un avis sur un livre dont la décision a été annulée entre-temps est
 *   ignoré sans erreur : une erreur 4xx bloquerait la file de synchronisation
 *   du poste (js/sync-queue.js s'arrête au premier échec et rejoue en boucle).
 */
import { createPatchEndpoint } from '../lib/patch-endpoint.mjs';

const KEY = 'desherbage-traitements.json';
const STATUTS = ['conserver', 'pilon', 'braderie', 'relocalisation'];
const COMMENT_MAX = 2000;

class BadRequest extends Error {
  constructor(message) {
    super(message);
    this.status = 400;
  }
}

function emptyState() {
  return {};
}

function cleanValidation(v) {
  if (v === null) return null;
  if (!v || typeof v !== 'object') throw new BadRequest('review : validation invalide.');
  const avis = v.avis == null ? null : v.avis;
  if (avis !== null && avis !== 'valide' && !STATUTS.includes(avis)) {
    throw new BadRequest(`avis invalide : ${avis}`);
  }
  const commentaire = String(v.commentaire || '').slice(0, COMMENT_MAX);
  return {
    avis,
    commentaire,
    statutVu: STATUTS.includes(v.statutVu) ? v.statutVu : null,
    par: String(v.par || '').slice(0, 80),
    ts: String(v.ts || new Date().toISOString()),
  };
}

function applyReview(state, barcode, validation) {
  if (!barcode) throw new BadRequest('review : barcode requis.');
  const v = cleanValidation(validation);
  const current = state[barcode];
  if (!current) return state; // décision annulée entre-temps : rien à valider
  const next = { ...current };
  if (v && (v.avis || v.commentaire)) next.validation = v;
  else delete next.validation;
  return { ...state, [barcode]: next };
}

function applyPatch(state, patch) {
  if (patch.type === 'set') {
    const record = patch.record;
    if (!record || !record.barcode) throw new BadRequest('set : record.barcode requis.');
    if (!STATUTS.includes(record.statut)) throw new BadRequest(`statut invalide : ${record.statut}`);
    const prev = state[record.barcode];
    const next = { barcode: record.barcode, statut: record.statut, ts: record.ts };
    if (prev && prev.validation) next.validation = prev.validation;
    return { ...state, [record.barcode]: next };
  }
  if (patch.type === 'clear') {
    if (!patch.barcode) throw new BadRequest('clear : barcode requis.');
    const next = { ...state };
    delete next[patch.barcode];
    return next;
  }
  if (patch.type === 'review') {
    return applyReview(state, patch.barcode, patch.validation);
  }
  if (patch.type === 'reviewMany') {
    if (!Array.isArray(patch.items)) throw new BadRequest('reviewMany : items requis.');
    return patch.items.reduce((s, it) => applyReview(s, it && it.barcode, it && it.validation), state);
  }
  throw new BadRequest(`Type de patch inconnu : ${patch.type}`);
}

/* Handler = la fabrique partagée : GET (public, avec ETag/304), POST
   authentifié fusionné en compare-and-swap. Voir lib/patch-endpoint.mjs. */
export default createPatchEndpoint({
  key: KEY,
  emptyState,
  applyPatch,
});

export { applyPatch };
