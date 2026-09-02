/**
 * Surcharges partagées de livres-spolies.html, stockées dans R2 sous la clé
 * "livres-spolies-overrides.json" (même forme que OVERRIDES côté client :
 * { [id]: { trouve, exLibris, possesseur, coteBM, origine, dateEntree,
 * dateSortie } }).
 *
 * GET  → l'état courant (lecture non authentifiée, même niveau d'exposition
 *        que le reste des données du projet).
 * POST → un patch {id, field, value} fusionné via compare-and-swap
 *        (r2CasUpdate). Authentification requise (voir lib/auth.mjs).
 */
import { createPatchEndpoint } from '../lib/patch-endpoint.mjs';

const KEY = 'livres-spolies-overrides.json';
const ALLOWED_FIELDS = new Set([
  'trouve', 'exLibris', 'possesseur', 'coteBM',
  'origine', 'dateEntree', 'dateSortie',
]);

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
  if (patch.id === undefined || patch.id === null) throw new BadRequest('id requis.');
  if (!ALLOWED_FIELDS.has(patch.field)) throw new BadRequest(`field invalide : ${patch.field}`);
  const id = String(patch.id);
  const next = { ...state, [id]: { ...(state[id] || {}), [patch.field]: patch.value } };
  return next;
}

/* Handler = la fabrique partagée : GET (public, avec ETag/304), POST
   authentifié fusionné en compare-and-swap. Voir lib/patch-endpoint.mjs. */
export default createPatchEndpoint({
  key: KEY,
  emptyState,
  applyPatch,
});
