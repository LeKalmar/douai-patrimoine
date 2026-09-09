/**
 * État partagé de la liste de transfert 2e étage → réserve patrimoniale
 * (transfert-magasins.html), stocké dans R2 sous la clé
 * "transferts-magasins.json" — forme { [id]: record }, id généré côté
 * client (crypto.randomUUID(), pas de code-barre disponible à la création
 * puisque ces documents ne sont pas catalogués).
 *
 * record = { id, '200$a','700$a','210$a','210$c','210$d','215$a','215$d',
 *            '930$g','915$a','920$d', status:'pending'|'done',
 *            newCote, newBarcode, ts, doneTs } — voir CLAUDE.md, section
 * « Transfert 2e étage → réserve patrimoniale ».
 *
 * GET  → l'état courant (lecture non authentifiée, même niveau d'exposition
 *        que le reste des données du projet).
 * POST → un patch {type:'upsert', record} ou {type:'delete', id}, fusionné
 *        via compare-and-swap (r2CasUpdate). Authentification requise
 *        (voir lib/auth.mjs). Même patron que api/exemplaires-manuels.mjs.
 */
import { createPatchEndpoint } from '../lib/patch-endpoint.mjs';

const KEY = 'transferts-magasins.json';

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
  if (patch.type === 'upsert') {
    const record = patch.record;
    if (!record || !record.id) throw new BadRequest('upsert : record.id requis.');
    return { ...state, [record.id]: record };
  }
  if (patch.type === 'delete') {
    if (!patch.id) throw new BadRequest('delete : id requis.');
    const next = { ...state };
    delete next[patch.id];
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
