/**
 * data-json-cache.mjs
 * ────────────────────────────────────────────────────────────────────────────
 * Petit cache en mémoire pour les réponses `/data/*.json` générées à la volée
 * depuis Postgres (voir scripts/dev-server.mjs) — évite de refaire la requête
 * SQL + sérialisation à chaque requête HTTP identique, sans pour autant servir
 * une donnée périmée plus de quelques dizaines de secondes.
 *
 * Également utilisé par `api/inventaire.mjs` (2026-09-23) : mesuré en
 * conditions réelles, la requête SQL + le filtrage par liste blanche +
 * `JSON.stringify` de `exportInventaire()` coûtent à eux seuls ~2 s à froid,
 * intégralement repayés à chaque requête faute de cache à cet étage (l'ETag
 * ne fait qu'éviter le transfert du corps, pas son recalcul).
 *
 * L'entrée mise en cache n'est pas la string brute mais l'objet de
 * `compressibleBody()` (lib/http-compress.mjs) : il retient à côté du corps
 * brut ses variantes gzip/brotli, si bien que la compression d'un corps de
 * 21 Mo (~760 ms en brotli) est elle aussi payée une seule fois par TTL au
 * lieu d'une fois par chargement de page. C'était le point qui rendait la
 * compression inintéressante à brancher naïvement.
 *
 * `invalidate(path)` est prévu pour être appelé après un POST qui change la
 * donnée sous-jacente (phases suivantes du chantier postgres-local), pour ne
 * pas attendre l'expiration du TTL.
 */
import { compressibleBody } from './http-compress.mjs';

const TTL_MS = 60_000;
const store = new Map(); // path -> { payload, expiresAt }

/**
 * `compute()` renvoie le corps (string/Buffer) ; la valeur retournée est
 * l'objet compressible correspondant (`.raw` pour le Buffer brut).
 */
export async function getCached(path, compute) {
  const hit = store.get(path);
  if (hit && hit.expiresAt > Date.now()) return hit.payload;
  const payload = compressibleBody(await compute());
  store.set(path, { payload, expiresAt: Date.now() + TTL_MS });
  return payload;
}

export function invalidate(path) {
  store.delete(path);
}
