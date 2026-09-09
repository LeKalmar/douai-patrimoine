/**
 * Déclenche une tranche de synchronisation Syracuse en tâche de fond (voir
 * api/syracuse-tick.mjs et CLAUDE.md, section « Synchronisation
 * incrémentale Syracuse »). Fichier volontairement séparé et minimal :
 * recolement.html a déjà eu deux pannes de production par temporal dead
 * zone dans son script principal (voir CLAUDE.md), donc ce déclenchement
 * ne doit avoir strictement aucune chance d'interagir avec l'ordre
 * d'initialisation des pages qui l'incluent. Résultat ignoré pour le
 * fonctionnement de la page (pas de UI, rien qui en dépend) — seulement
 * tracé dans la console (F12) pour pouvoir vérifier à l'œil qu'une tranche
 * tourne bien, sans avoir à interroger l'API à la main.
 */
(function () {
  try {
    fetch('/api/syracuse-tick', { method: 'POST', keepalive: true })
      .then(function (r) { return r.json(); })
      .then(function (data) { console.log('[syracuse-sync] tick :', data); })
      .catch(function () {});
  } catch (e) {
    /* ignoré : ce déclenchement ne doit jamais faire échouer la page */
  }
})();
