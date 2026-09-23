/**
 * export-non-catalogues.mjs
 * ────────────────────────────────────────────────────────────────────────────
 * Reconstruit `data/non-catalogues.json` depuis Postgres. Contrairement aux
 * autres exports, aucune transformation n'est nécessaire à la lecture :
 * `db-migrate-non-catalogues.mjs` a déjà stocké la ligne dans sa forme finale
 * exacte (`raw`), buildRecord() ayant fait tout le travail au moment de la
 * migration plutôt qu'à chaque requête.
 *
 * `source_ref LIKE 'fonds-car-%'` (fonds Cartes géographiques) et
 * `source_ref LIKE 'fonds-periodiques%'` (fonds Périodiques — deux préfixes,
 * "fonds-periodiques-" pour csv/periodiques.csv et "fonds-periodiques2-"
 * pour les nouvelles entrées de csv/periodiques2.csv, tous deux couverts par
 * ce motif sans le tiret final) sont explicitement exclus : ces lignes
 * partagent le même `source='excel_import'` mais leur `raw` est la ligne CSV
 * BRUTE (colonnes françaises, pas de "930$g"/"200$a") — les inclure ici
 * produirait des entrées mal formées. Ces fonds sont transformés et
 * fusionnés directement dans scripts/lib/export-inventaire.mjs
 * (buildFondsCarRecord()/buildFondsPeriodiqueRecord()/
 * buildFondsPeriodique2Record()), pas via ce fichier-ci.
 */
import { getPool } from './pg.mjs';

export async function exportNonCatalogues() {
  const pool = getPool({ unpooled: true });
  const { rows } = await pool.query(
    `SELECT raw FROM exemplaires
     WHERE source = 'excel_import'
       AND source_ref NOT LIKE 'fonds-car-%'
       AND source_ref NOT LIKE 'fonds-periodiques%'
     ORDER BY source_ref`
  );
  return rows.map(r => r.raw);
}
