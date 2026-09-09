/**
 * État de la synchronisation incrémentale avec le portail Syracuse
 * (voir API-SYRACUSE.MD, §21), stocké dans R2 sous la clé
 * "syracuse-sync.json" — surcouche par-dessus data/magasins.json,
 * alimentée en tâche de fond par api/syracuse-tick.mjs (voir ce fichier
 * pour le moteur de delta et les garde-fous).
 *
 * Forme de l'état : { lastSync, cursor, records: {barcode: {...}},
 * notices: {rscId: {barcodes, ts}}, enabled, syncInProgress,
 * lastSyncAttempt, consecutiveErrors, lastError }.
 *
 * GET  → l'état courant (lecture publique, même niveau d'exposition que
 *        le reste des données du projet). Aucune page ne le consomme
 *        encore pour l'affichage — c'est la prochaine étape (fusion
 *        côté client, sur le modèle de js/exemplaires-manuels-shared.js).
 * POST → deux patchs authentifiés seulement : {type:'setEnabled',
 *        enabled} pour couper/relever la synchro à la main (l'arrêt
 *        automatique après 3 échecs consécutifs pose enabled:false, voir
 *        api/syracuse-tick.mjs — seul un humain peut le relever), et
 *        {type:'reset'} pour repartir de zéro après un rebuild mensuel
 *        complet de data/magasins.json (les deltas accumulés deviennent
 *        obsolètes face au nouvel export).
 */
import { createPatchEndpoint } from '../lib/patch-endpoint.mjs';
import { SYRACUSE_SYNC_KEY, emptySyracuseSyncState } from '../lib/syracuse-sync-state.mjs';

const KEY = SYRACUSE_SYNC_KEY;
const emptyState = emptySyracuseSyncState;

class BadRequest extends Error {
  constructor(message) {
    super(message);
    this.status = 400;
  }
}

function applyPatch(state, patch) {
  if (patch.type === 'setEnabled') {
    return { ...state, enabled: !!patch.enabled, consecutiveErrors: 0, lastError: null };
  }
  if (patch.type === 'reset') {
    return emptyState();
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
