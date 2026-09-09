#!/usr/bin/env node
/**
 * db-test.mjs
 * ────────────────────────────────────────────────────────────────────────────
 * Script de fumée pour la connexion Postgres (Neon) — même rôle que
 * `npm run test:r2` pour R2 : vérifie que DATABASE_URL et
 * DATABASE_URL_UNPOOLED fonctionnent, sans toucher aux données réelles.
 * ────────────────────────────────────────────────────────────────────────────
 */
import { getPool, closeAllPools } from './lib/pg.mjs';

async function check(label, { unpooled }) {
  const started = Date.now();
  const pool = getPool({ unpooled });
  const { rows } = await pool.query('SELECT version(), now() AS server_time');
  const ms = Date.now() - started;
  console.log(`✓ ${label} — ${ms} ms`);
  console.log(`  ${rows[0].version}`);
  console.log(`  heure serveur : ${rows[0].server_time.toISOString()}`);
}

async function main() {
  await check('DATABASE_URL (poolé)', { unpooled: false });
  await check('DATABASE_URL_UNPOOLED (direct)', { unpooled: true });

  const { rows } = await getPool({ unpooled: true }).query(`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public' ORDER BY table_name
  `);
  console.log(`\nTables présentes (${rows.length}) : ${rows.map(r => r.table_name).join(', ')}`);
}

main()
  .then(() => closeAllPools())
  .then(() => console.log('\n✓ db-test: terminé'))
  .catch(async (err) => {
    console.error('✖ db-test:', err.message);
    await closeAllPools();
    process.exit(1);
  });
