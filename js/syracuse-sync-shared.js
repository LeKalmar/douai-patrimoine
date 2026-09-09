/**
 * Surcouche de fraîcheur Syracuse (voir api/syracuse-tick.mjs/
 * api/syracuse-sync.mjs et CLAUDE.md, section « Synchronisation
 * incrémentale Syracuse ») : un enregistrement par code-barre modifié dans
 * Syracuse depuis le dernier rebuild XML — { cote, titre, auteur, dt,
 * section, site, statut, rscId, ts }. Renvoie `{}` (jamais d'exception) si
 * l'API est indisponible ou si rien n'a encore été synchronisé — même
 * philosophie de dégradation que js/exemplaires-manuels-shared.js : mieux
 * vaut un catalogue affiché sans la surcouche qu'une page qui casse.
 */
function fetchSyracuseSyncOverlay() {
  return fetch('/api/syracuse-sync')
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (data) {
      var records = (data && data.records) || {};
      console.log('[syracuse-sync] surcouche chargée :', Object.keys(records).length, 'code(s)-barres, lastSync =', data && data.lastSync);
      return records;
    })
    .catch(function () { return {}; });
}
