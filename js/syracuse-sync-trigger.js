/**
 * Déclenche une tranche de synchronisation Syracuse en tâche de fond (voir
 * api/syracuse-tick.mjs et CLAUDE.md, section « Synchronisation
 * incrémentale Syracuse »). Fichier volontairement séparé et minimal :
 * recolement.html a déjà eu deux pannes de production par temporal dead
 * zone dans son script principal (voir CLAUDE.md), donc ce déclenchement
 * ne doit avoir strictement aucune chance d'interagir avec l'ordre
 * d'initialisation des pages qui l'incluent. Résultat ignoré : c'est de la
 * maintenance silencieuse, sans état ni retour côté page.
 */
(function () {
  try {
    fetch('/api/syracuse-tick', { method: 'POST', keepalive: true }).catch(function () {});
  } catch (e) {
    /* ignoré : ce déclenchement ne doit jamais faire échouer la page */
  }
})();
