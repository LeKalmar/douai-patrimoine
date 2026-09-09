#!/usr/bin/env node
/**
 * node scripts/run-syracuse-sync.mjs [url]
 *
 * Appelle POST /api/syracuse-tick en boucle, indéfiniment, jusqu'à Ctrl+C.
 * Sert à rattraper le retard de la synchro incrémentale Syracuse (voir
 * CLAUDE.md, section « Synchronisation incrémentale Syracuse ») sans avoir
 * besoin de garder un onglet du site au premier plan : js/syracuse-sync-
 * trigger.js n'avance plus dès que l'onglet passe en arrière-plan
 * (`if (!document.hidden) tick()`), ce qui limite en pratique le débit
 * bien en dessous du plafond serveur (FLOOR_MS/MAX_HOLDINGS_PER_TICK dans
 * api/syracuse-tick.mjs) dès que l'écran se met en veille ou qu'on change
 * de fenêtre. Ce script ne fait qu'appeler le même endpoint public, non
 * authentifié — aucune donnée fournie par ce script, il ne fait qu'avancer
 * le job déjà entièrement défini côté serveur (voir le commentaire en tête
 * de api/syracuse-tick.mjs).
 *
 * Respecte le plancher serveur en lisant `nextEligibleAt` renvoyé par un
 * tick "too-soon" plutôt que de deviner un intervalle fixe — reste correct
 * même si FLOOR_MS change côté serveur sans qu'il faille toucher ce script.
 *
 * URL cible : premier argument, sinon variable d'environnement
 * SYRACUSE_TICK_URL, sinon le déploiement de production par défaut.
 */
const DEFAULT_URL = 'https://douai-patrimoine.vercel.app/api/syracuse-tick';
const url = process.argv[2] || process.env.SYRACUSE_TICK_URL || DEFAULT_URL;

const DEFAULT_NEXT_MS = 65_000; // repli si le serveur ne précise pas nextEligibleAt
const RETRY_AFTER_ERROR_MS = 15_000;
const RETRY_AFTER_IN_PROGRESS_MS = 10_000;

function log(...args) {
  console.log(new Date().toISOString(), '—', ...args);
}

async function tick() {
  try {
    const res = await fetch(url, { method: 'POST' });
    const data = await res.json().catch(() => ({}));

    if (!res.ok) {
      log('erreur HTTP', res.status, JSON.stringify(data));
      return RETRY_AFTER_ERROR_MS;
    }
    if (data.skipped === 'disabled') {
      log(
        'synchro désactivée côté serveur (3 échecs consécutifs, voir MAX_CONSECUTIVE_ERRORS) —',
        'à relever manuellement via un POST authentifié vers /api/syracuse-sync',
        '({type:"setEnabled", enabled:true}). Arrêt du script.'
      );
      process.exit(1);
    }
    if (data.skipped === 'too-soon') {
      const wait = data.nextEligibleAt
        ? Math.max(1000, Date.parse(data.nextEligibleAt) - Date.now() + 1000)
        : DEFAULT_NEXT_MS;
      log('trop tôt — prochain tick dans', Math.round(wait / 1000), 's');
      return wait;
    }
    if (data.skipped === 'in-progress') {
      log('une tranche tourne déjà ailleurs — nouvel essai dans', RETRY_AFTER_IN_PROGRESS_MS / 1000, 's');
      return RETRY_AFTER_IN_PROGRESS_MS;
    }
    log('ok — traité:', data.processed, '· restant sur la fenêtre en cours:', data.remaining);
    return DEFAULT_NEXT_MS;
  } catch (err) {
    log('échec réseau:', err.message || String(err));
    return RETRY_AFTER_ERROR_MS;
  }
}

log('démarrage — cible:', url, '(Ctrl+C pour arrêter)');
for (;;) {
  const wait = await tick();
  await new Promise(resolve => setTimeout(resolve, wait));
}
