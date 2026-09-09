/**
 * Déclenche des tranches de synchronisation Syracuse en tâche de fond (voir
 * api/syracuse-tick.mjs et CLAUDE.md, section « Synchronisation
 * incrémentale Syracuse »). Fichier volontairement séparé et minimal :
 * recolement.html a déjà eu deux pannes de production par temporal dead
 * zone dans son script principal (voir CLAUDE.md), donc ce déclenchement
 * ne doit avoir strictement aucune chance d'interagir avec l'ordre
 * d'initialisation des pages qui l'incluent. Résultat ignoré pour le
 * fonctionnement de la page (pas de UI, rien qui en dépend) — seulement
 * tracé dans la console (F12) pour pouvoir vérifier à l'œil qu'une tranche
 * tourne bien, sans avoir à interroger l'API à la main.
 *
 * Rappelé toutes les 65 s tant que la page reste ouverte (un peu au-dessus
 * du plancher de 60 s côté serveur, FLOOR_MS dans api/syracuse-tick.mjs —
 * pas besoin de tomber pile dessus, le serveur refuse de toute façon tout
 * appel en trop via `{"skipped":"too-soon"}`) : un simple appel au
 * chargement ne suffisait plus une fois la cadence resserrée pour les
 * sessions de correction en masse (2026-09-09) — sans rappel, laisser la
 * page ouverte sans la recharger n'avançait plus le rattrapage passé la
 * toute première tranche.
 */
(function () {
  function tick() {
    try {
      fetch('/api/syracuse-tick', { method: 'POST', keepalive: true })
        .then(function (r) { return r.json(); })
        .then(function (data) { console.log('[syracuse-sync] tick :', data); })
        .catch(function () {});
    } catch (e) {
      /* ignoré : ce déclenchement ne doit jamais faire échouer la page */
    }
  }
  tick();
  setInterval(function () { if (!document.hidden) tick(); }, 65000);
  document.addEventListener('visibilitychange', function () { if (!document.hidden) tick(); });
})();
