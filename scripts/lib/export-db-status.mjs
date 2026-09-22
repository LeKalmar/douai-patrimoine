/**
 * export-db-status.mjs
 * ────────────────────────────────────────────────────────────────────────────
 * Expose, pour admin.html, la dernière exécution de chaque script
 * db-migrate-*.mjs (table `sync_runs`, voir db-migrate-reserve.mjs) — sert à
 * afficher une date de dernière actualisation de la base et à indiquer
 * jusqu'à quand un prochain export Syracuse "notices modifiées depuis" doit
 * remonter (cette date = `started_at`, capturé avant toute lecture du XML).
 *
 * Enregistré sous `/data/db-status.json` dans scripts/dev-server.mjs — outil
 * réseau local (chantier "postgres-local"), pas encore déployé sur Vercel :
 * admin.html dégrade silencieusement (fetchJsonOrNull) si ce chemin renvoie
 * un 404 en production, où seul le fichier statique committé existe.
 */
import { getPool } from './pg.mjs';

export async function exportDbStatus() {
  const pool = getPool({ unpooled: true });
  const { rows } = await pool.query(`
    SELECT DISTINCT ON (source) source, started_at, finished_at,
           notices_upserted, exemplaires_upserted, status, error_message
    FROM sync_runs
    ORDER BY source, id DESC
  `);

  const sources = {};
  for (const r of rows) {
    sources[r.source] = {
      startedAt: r.started_at,
      finishedAt: r.finished_at,
      noticesUpserted: r.notices_upserted,
      exemplairesUpserted: r.exemplaires_upserted,
      status: r.status,
      errorMessage: r.error_message,
    };
  }
  return { sources };
}
