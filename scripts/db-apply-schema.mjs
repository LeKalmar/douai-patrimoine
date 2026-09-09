#!/usr/bin/env node
/**
 * db-apply-schema.mjs
 * ────────────────────────────────────────────────────────────────────────────
 * Applique db/migrations/*.sql (par ordre alphabétique) à la base Postgres
 * (DATABASE_URL_UNPOOLED, connexion directe — plus adaptée à un DDL en un
 * bloc que le pooler en mode transaction). Ne dépend pas du binaire `psql`
 * (absent de certains environnements de dev) : exécute chaque fichier via le
 * driver `pg` (mode "simple query", qui accepte plusieurs instructions
 * séparées par ';' dans un seul appel).
 *
 * Chaque fichier de migration est écrit pour être rejouable sans erreur
 * (CREATE TABLE IF NOT EXISTS, INSERT ... ON CONFLICT DO NOTHING) — ce script
 * ne tient donc pas de table de migrations déjà appliquées, il rejoue tout à
 * chaque exécution.
 *
 * Aucune dépendance npm au-delà de `pg` (déjà nécessaire pour tout le reste,
 * voir scripts/lib/pg.mjs). Node ≥ 18.
 * ────────────────────────────────────────────────────────────────────────────
 */
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { getPool, closeAllPools } from './lib/pg.mjs';

const MIGRATIONS_DIR = resolve('db/migrations');

async function main() {
  const files = readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.sql')).sort();
  if (!files.length) {
    console.log('Aucun fichier de migration dans db/migrations/.');
    return;
  }

  const pool = getPool({ unpooled: true });
  for (const file of files) {
    const path = resolve(MIGRATIONS_DIR, file);
    console.log(`▶ ${file}`);
    const sql = readFileSync(path, 'utf-8');
    await pool.query(sql);
    console.log(`  ✓ appliqué`);
  }
}

main()
  .then(() => closeAllPools())
  .then(() => console.log('✓ db-apply-schema: terminé'))
  .catch(async (err) => {
    console.error('✖ db-apply-schema:', err.message);
    await closeAllPools();
    process.exit(1);
  });
