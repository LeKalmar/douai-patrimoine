/**
 * data-json-cache.mjs
 * ────────────────────────────────────────────────────────────────────────────
 * Petit cache en mémoire pour les réponses `/data/*.json` générées à la volée
 * depuis Postgres (voir scripts/dev-server.mjs) — évite de refaire la requête
 * SQL + sérialisation à chaque requête HTTP identique, sans pour autant servir
 * une donnée périmée plus de quelques dizaines de secondes.
 *
 * `invalidate(path)` est prévu pour être appelé après un POST qui change la
 * donnée sous-jacente (phases suivantes du chantier postgres-local), pour ne
 * pas attendre l'expiration du TTL.
 */
const TTL_MS = 60_000;
const store = new Map(); // path -> { body, expiresAt }

export async function getCached(path, compute) {
  const hit = store.get(path);
  if (hit && hit.expiresAt > Date.now()) return hit.body;
  const body = await compute();
  store.set(path, { body, expiresAt: Date.now() + TTL_MS });
  return body;
}

export function invalidate(path) {
  store.delete(path);
}
