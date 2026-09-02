/**
 * État partagé des décisions de désherbage prises via rotobib.html, stocké
 * dans R2 sous la clé "desherbage-traitements.json" — forme
 * { [barcode]: {barcode, statut, ts} }, avec statut ∈ 'conserver' | 'pilon'
 * | 'braderie' | 'relocalisation'. Voir CLAUDE.md, section Rotobib.
 *
 * GET  → l'état courant (lecture non authentifiée, même niveau d'exposition
 *        que le reste des données partagées du projet).
 * POST → un patch {type:'set', record:{barcode,statut,ts}} (choix ou
 *        changement de traitement) ou {type:'clear', barcode} (annule le
 *        traitement, redevient "non traité"), fusionné via compare-and-swap
 *        (r2CasUpdate). Authentification requise (voir lib/auth.mjs).
 */
import { createPatchEndpoint } from '../lib/patch-endpoint.mjs';

const KEY = 'desherbage-traitements.json';
const STATUTS = ['conserver', 'pilon', 'braderie', 'relocalisation'];

class BadRequest extends Error {
  constructor(message) {
    super(message);
    this.status = 400;
  }
}

function emptyState() {
  return {};
}

function applyPatch(state, patch) {
  if (patch.type === 'set') {
    const record = patch.record;
    if (!record || !record.barcode) throw new BadRequest('set : record.barcode requis.');
    if (!STATUTS.includes(record.statut)) throw new BadRequest(`statut invalide : ${record.statut}`);
    return { ...state, [record.barcode]: record };
  }
  if (patch.type === 'clear') {
    if (!patch.barcode) throw new BadRequest('clear : barcode requis.');
    const next = { ...state };
    delete next[patch.barcode];
    return next;
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
