/**
 * export-non-catalogues.mjs
 * ────────────────────────────────────────────────────────────────────────────
 * Reconstruit `data/non-catalogues.json` depuis Postgres (pièces non
 * cataloguées des fonds Manuscrits/Robaut/Objets, voir CLAUDE.md « Pièces non
 * cataloguées »). Contrairement aux autres exports, aucune transformation
 * n'est nécessaire à la lecture : `db-migrate-non-catalogues.mjs` a déjà
 * stocké la ligne dans sa forme finale exacte (`raw`), buildRecord() ayant
 * fait tout le travail au moment de la migration plutôt qu'à chaque requête.
 *
 * Corrigé le 2026-09-23 : ce fichier lisait encore `exemplaires` avec
 * `source = 'excel_import'`, alors que db/migrations/0008_reserve_non_catalogues.sql
 * a déplacé ces 10 090 lignes vers la table dédiée `exemplaires_reserve`.
 * La requête ne renvoyait donc plus AUCUNE ligne, silencieusement — un
 * tableau vide se sert aussi bien qu'un tableau plein, rien ne remontait.
 * Conséquence visible : thematiques/vues-de-douai.html, qui fusionne cette
 * source avec /api/inventaire, avait perdu ses 82 pièces `610$a =
 * "Cartographie"` du fonds Robaut.
 *
 * Distinction réserve / pièce non cataloguée à l'intérieur de
 * `exemplaires_reserve`, sans colonne dédiée (voir scripts/lib/export-inventaire.mjs) :
 * `barcode` est TOUJOURS renseigné pour la réserve et TOUJOURS NULL ici ;
 * `source_ref` c'est l'inverse (NULL pour la réserve, "csv-row-N" ici).
 *
 * Les fonds Cartes géographiques (`fonds-car-%`) et Périodiques
 * (`fonds-periodiques%`) ne sont PAS concernés : ils sont restés dans
 * `exemplaires`/`source='excel_import'`, leur `raw` est la ligne CSV BRUTE
 * (colonnes françaises, pas de "930$g"/"200$a") et ils sont transformés puis
 * fusionnés directement par scripts/lib/export-inventaire.mjs
 * (buildFondsCarRecord()/buildFondsPeriodiqueRecord()/
 * buildFondsPeriodique2Record()). La requête ci-dessous, lisant une autre
 * table, ne peut plus les ramener par accident — les filtres `NOT LIKE` qui
 * servaient à ça n'ont plus lieu d'être.
 */
import { getPool } from './pg.mjs';

export async function exportNonCatalogues() {
  const pool = getPool({ unpooled: true });
  const { rows } = await pool.query(
    `SELECT raw FROM exemplaires_reserve
     WHERE source_ref IS NOT NULL
     ORDER BY source_ref`
  );
  return rows.map(r => r.raw);
}
