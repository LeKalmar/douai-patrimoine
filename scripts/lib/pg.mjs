/**
 * pg.mjs
 * ────────────────────────────────────────────────────────────────────────────
 * Point d'entrée unique vers Postgres (Neon) pour les scripts locaux
 * (db-apply-schema.mjs, db-test.mjs, db-migrate-reserve.mjs,
 * db-migrate-bib.mjs) — même rôle que lib/r2.mjs pour R2 : centralise la
 * config, pour qu'un futur endpoint Vercel réutilise le même point d'entrée
 * sans le redéfinir.
 *
 * Lit DATABASE_URL (poolé, via le pooler pgbouncer Neon) et
 * DATABASE_URL_UNPOOLED (connexion directe) via loadDotEnv() — posées dans
 * .env par `neon link`/`neon connection-string` (voir README/plan de
 * migration), jamais commitées. La connexion directe (`unpooled: true`) est
 * préférée pour les scripts de migration en lot (transactions longues) ; la
 * connexion poolée est celle qu'utiliseront les futurs endpoints Vercel
 * (courtes requêtes, beaucoup d'invocations concurrentes).
 *
 * Seule dépendance npm runtime du projet (`pg`, voir package.json) — un
 * driver Postgres est incontournable, pas de raison de le réécrire à la main
 * comme lib/r2.mjs le fait pour SigV4 (protocole nettement plus complexe).
 */
import pg from 'pg';
import { loadDotEnv } from './dotenv.mjs';

loadDotEnv();

const { Pool } = pg;
const pools = new Map();

export function getPool({ unpooled = false } = {}) {
  const key = unpooled ? 'unpooled' : 'pooled';
  if (pools.has(key)) return pools.get(key);

  const envVar = unpooled ? 'DATABASE_URL_UNPOOLED' : 'DATABASE_URL';
  const connectionString = process.env[envVar];
  if (!connectionString) {
    throw new Error(`Variable d'environnement manquante : ${envVar} (voir .env, posée par "neon link"/"neon connection-string").`);
  }

  const pool = new Pool({ connectionString });
  pools.set(key, pool);
  return pool;
}

export function query(text, params, { unpooled = false } = {}) {
  return getPool({ unpooled }).query(text, params);
}

export async function closeAllPools() {
  await Promise.all([...pools.values()].map(p => p.end()));
  pools.clear();
}

/**
 * Assemble une requête `INSERT INTO table (cols...) VALUES (...),(...),...`
 * paramétrée pour un lot de lignes (jamais de valeur concaténée dans le SQL,
 * uniquement des placeholders $1,$2,…). `rows` : tableau d'objets dont les
 * clés couvrent `columns` (une valeur manquante devient NULL). `onConflict` :
 * fragment SQL optionnel ajouté tel quel après la clause VALUES (ex.
 * `ON CONFLICT (barcode) DO UPDATE SET ... WHERE ...`).
 * Retourne null si `rows` est vide (rien à insérer).
 */
export function buildBatchInsert(table, columns, rows, { onConflict, returning } = {}) {
  if (!rows.length) return null;
  const values = [];
  const tuples = rows.map((row, i) => {
    const placeholders = columns.map((col, j) => {
      values.push(row[col] === undefined ? null : row[col]);
      return `$${i * columns.length + j + 1}`;
    });
    return `(${placeholders.join(', ')})`;
  });
  const sql = [
    `INSERT INTO ${table} (${columns.join(', ')})`,
    `VALUES ${tuples.join(', ')}`,
    onConflict || '',
    returning ? `RETURNING ${returning}` : '',
  ].filter(Boolean).join('\n');
  return { sql, values };
}
