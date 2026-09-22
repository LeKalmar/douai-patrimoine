#!/usr/bin/env node
/**
 * db-migrate-spolies.mjs
 * ────────────────────────────────────────────────────────────────────────────
 * Charge la table livres_spolies (db/migrations/0002_livres_spolies.sql)
 * depuis data/livres-spolies.json (données de base, 506 lignes), puis
 * fusionne par-dessus les overrides déjà présents sur R2
 * (livres-spolies-overrides.json — mêmes 7 champs éditables que
 * api/spolies.mjs) pour ne perdre aucune correction déjà saisie par
 * l'équipe. Idempotent (INSERT ... ON CONFLICT DO UPDATE).
 *
 * Aucune dépendance npm au-delà de `pg`. Node ≥ 18.
 * ────────────────────────────────────────────────────────────────────────────
 */
import { readFileSync } from 'node:fs';
import { r2Get, r2Configured } from '../lib/r2.mjs';
import { getPool, buildBatchInsert, closeAllPools } from './lib/pg.mjs';

const CONFIG = { input: 'data/livres-spolies.json', batchSize: 500 };

function batches(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function main() {
  const startedAt = Date.now();
  console.log('▶ db-migrate-spolies: démarrage');

  const base = JSON.parse(readFileSync(CONFIG.input, 'utf-8'));
  console.log(`  · ${base.length} lignes de base (${CONFIG.input})`);

  let overrides = {};
  if (r2Configured()) {
    const obj = await r2Get('livres-spolies-overrides.json');
    if (obj) {
      overrides = JSON.parse(obj.body);
      console.log(`  · ${Object.keys(overrides).length} override(s) trouvé(s) sur R2, fusionnés par-dessus la base`);
    } else {
      console.log('  · aucun override sur R2 (jamais écrit)');
    }
  } else {
    console.log('  · R2 non configuré — migration de la seule base, sans overrides');
  }

  const rows = base.map(r => {
    const o = overrides[String(r.id)] || {};
    return {
      id: r.id,
      caisse: r.caisse || null,
      cote_bm: o.coteBM ?? r.coteBM ?? null,
      type: r.type || null,
      volumes: r.volumes || null,
      auteur: r.auteur || null,
      titre: r.titre || null,
      lieu: r.lieu || null,
      editeur: r.editeur || null,
      date: r.date || null,
      trouve: o.trouve ?? r.trouve ?? false,
      ex_libris: o.exLibris ?? r.exLibris ?? false,
      possesseur: o.possesseur ?? r.possesseur ?? null,
      origine: o.origine ?? null,
      date_entree: o.dateEntree ?? null,
      date_sortie: o.dateSortie ?? null,
    };
  });

  const pool = getPool({ unpooled: true });
  const cols = ['id', 'caisse', 'cote_bm', 'type', 'volumes', 'auteur', 'titre', 'lieu', 'editeur', 'date', 'trouve', 'ex_libris', 'possesseur', 'origine', 'date_entree', 'date_sortie'];
  let upserted = 0;
  for (const batch of batches(rows, CONFIG.batchSize)) {
    const { sql, values } = buildBatchInsert('livres_spolies', cols, batch, {
      onConflict: `ON CONFLICT (id) DO UPDATE SET
        caisse=EXCLUDED.caisse, cote_bm=EXCLUDED.cote_bm, type=EXCLUDED.type, volumes=EXCLUDED.volumes,
        auteur=EXCLUDED.auteur, titre=EXCLUDED.titre, lieu=EXCLUDED.lieu, editeur=EXCLUDED.editeur,
        date=EXCLUDED.date, trouve=EXCLUDED.trouve, ex_libris=EXCLUDED.ex_libris, possesseur=EXCLUDED.possesseur,
        origine=EXCLUDED.origine, date_entree=EXCLUDED.date_entree, date_sortie=EXCLUDED.date_sortie,
        updated_at=now()`,
    });
    await pool.query(sql, values);
    upserted += batch.length;
  }
  console.log(`  · ${upserted} ligne(s) upsertée(s) dans livres_spolies`);

  const dur = ((Date.now() - startedAt) / 1000).toFixed(2);
  console.log(`✓ db-migrate-spolies: terminé en ${dur}s`);
}

main()
  .then(() => closeAllPools())
  .catch(async (err) => {
    console.error('✖ db-migrate-spolies:', err.stack || err.message);
    await closeAllPools();
    process.exit(1);
  });
