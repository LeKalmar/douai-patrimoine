/**
 * export-non-catalogues.mjs
 * ────────────────────────────────────────────────────────────────────────────
 * Reconstruit `data/non-catalogues.json` depuis Postgres. Contrairement aux
 * autres exports, aucune transformation n'est nécessaire à la lecture :
 * `db-migrate-non-catalogues.mjs` a déjà stocké la ligne dans sa forme finale
 * exacte (`raw`), buildRecord() ayant fait tout le travail au moment de la
 * migration plutôt qu'à chaque requête.
 */
import { getPool } from './pg.mjs';

export async function exportNonCatalogues() {
  const pool = getPool({ unpooled: true });
  const { rows } = await pool.query(
    `SELECT raw FROM exemplaires WHERE source = 'excel_import' ORDER BY source_ref`
  );
  return rows.map(r => r.raw);
}
