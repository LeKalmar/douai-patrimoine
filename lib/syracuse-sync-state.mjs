/**
 * Forme partagée de l'état de synchronisation Syracuse (R2, clé
 * "syracuse-sync.json") entre api/syracuse-sync.mjs (lecture publique +
 * patchs admin) et api/syracuse-tick.mjs (moteur de delta qui l'alimente,
 * voir ce fichier pour le détail) — un seul point de vérité pour que les
 * deux fichiers ne divergent jamais sur le schéma. Voir API-SYRACUSE.MD,
 * §21-22, pour le contexte de cette synchronisation.
 */
export const SYRACUSE_SYNC_KEY = 'syracuse-sync.json';

export function emptySyracuseSyncState() {
  return {
    lastSync: null,
    cursor: null,
    records: {},
    notices: {},
    enabled: true,
    syncInProgress: false,
    lastSyncAttempt: null,
    consecutiveErrors: 0,
    lastError: null,
  };
}
