/**
 * État partagé des décisions de désherbage prises via rotobib.html, stocké
 * dans R2 sous la clé "desherbage-traitements.json" — forme
 * { [barcode]: {barcode, statut, ts, validation?, final?} }, avec statut ∈
 * 'conserver' | 'pilon' | 'braderie' | 'relocalisation'. Voir CLAUDE.md,
 * section Rotobib.
 *
 * `validation` (facultatif) = l'avis du responsable qui valide la campagne,
 * saisi dans validation-desherbage.html :
 *   { avis, commentaire, statutVu, par, ts }
 *   - avis : 'valide' (d'accord avec la décision), un autre statut
 *     (contre-proposition), ou null (commentaire seul) ;
 *   - statutVu : la décision de l'équipe au moment de l'avis.
 * LE RESPONSABLE A LE DERNIER MOT (2026-10-10) : dès qu'un avis tranché est
 * posé, la décision de l'équipe est figée — `set`/`clear` sont ignorés sur
 * ce livre — et la décision finale est celle du responsable (finalStatut()).
 *
 * `final` (facultatif) = le livre a été rescanné dans l'onglet « Tri final »
 * de Rotobib et rangé avec sa destination : { statut, ts, par }. Plus rien
 * à faire sur ce livre ; l'avis du responsable ne peut plus changer non plus
 * (un `review` est ignoré tant que `final` est posé — annuler le tri d'abord).
 *
 * Rangé sur l'enregistrement de la décision plutôt que dans une clé R2 à
 * part : api/ compte déjà 12 fonctions, le plafond du plan Vercel Hobby.
 *
 * GET  → l'état courant (lecture non authentifiée, même niveau d'exposition
 *        que le reste des données partagées du projet).
 * POST → un patch, fusionné via compare-and-swap (r2CasUpdate),
 *        authentification requise (voir lib/auth.mjs) :
 *   {type:'set', record:{barcode,statut,ts}} — choix ou changement de
 *        traitement ; une `validation` déjà posée est conservée. Ignoré si
 *        le responsable a déjà tranché ;
 *   {type:'clear', barcode} — annule le traitement (idem, ignoré si tranché) ;
 *   {type:'review', barcode, validation|null} — pose, remplace ou retire
 *        l'avis du responsable (ignoré si le livre est déjà trié) ;
 *   {type:'reviewMany', items:[{barcode, validation}]} — idem par lot
 *        (« Valider tous les livres affichés ») ;
 *   {type:'finalize', barcode, par?, ts?} — tri final : pose `final` avec la
 *        décision finale du responsable, calculée ici (jamais fournie par le
 *        client) ; ignoré si le responsable n'a pas tranché ;
 *   {type:'unfinalize', barcode} — annule le tri final.
 *   Un patch qui ne s'applique plus (décision annulée, verrou) est ignoré
 *   sans erreur : une erreur 4xx bloquerait la file de synchronisation du
 *   poste (js/sync-queue.js s'arrête au premier échec et rejoue en boucle).
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

/* Décision finale d'un livre : celle du responsable dès qu'il a tranché,
   sinon null. Un « valide » porte sur la décision qu'il a vue (statutVu) :
   pour un avis antérieur au verrou, l'équipe a pu changer d'avis depuis, et
   c'est le responsable qui a le dernier mot. Même calcul dans rotobib.html et
   validation-desherbage.html (finalStatut()). */
function finalStatut(t) {
  const v = t && t.validation;
  if (!v || !v.avis) return null;
  if (v.avis === 'valide') return STATUTS.includes(v.statutVu) ? v.statutVu : t.statut;
  return STATUTS.includes(v.avis) ? v.avis : null;
}
const isLocked = t => !!finalStatut(t);

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
  if (current.final) return state; // livre déjà trié : annuler le tri d'abord
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
    if (isLocked(prev)) return state; // le responsable a tranché
    const next = { barcode: record.barcode, statut: record.statut, ts: record.ts };
    if (prev && prev.validation) next.validation = prev.validation;
    return { ...state, [record.barcode]: next };
  }
  if (patch.type === 'clear') {
    if (!patch.barcode) throw new BadRequest('clear : barcode requis.');
    if (isLocked(state[patch.barcode])) return state;
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
  if (patch.type === 'finalize') {
    if (!patch.barcode) throw new BadRequest('finalize : barcode requis.');
    const current = state[patch.barcode];
    const statut = finalStatut(current);
    if (!statut || current.final) return state; // pas encore tranché, ou déjà trié
    const final = {
      statut,
      ts: String(patch.ts || new Date().toISOString()),
      par: String(patch.par || '').slice(0, 80),
    };
    return { ...state, [patch.barcode]: { ...current, final } };
  }
  if (patch.type === 'unfinalize') {
    if (!patch.barcode) throw new BadRequest('unfinalize : barcode requis.');
    const current = state[patch.barcode];
    if (!current || !current.final) return state;
    const next = { ...current };
    delete next.final;
    return { ...state, [patch.barcode]: next };
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

export { applyPatch, finalStatut };
