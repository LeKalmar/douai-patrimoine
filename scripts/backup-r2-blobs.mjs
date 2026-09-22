#!/usr/bin/env node
/**
 * backup-r2-blobs.mjs
 * ────────────────────────────────────────────────────────────────────────────
 * Sauvegarde en LECTURE SEULE des 8 clés R2 d'état partagé (jamais d'écriture
 * côté R2 — sans risque pour la prod actuelle) vers un dossier local
 * gitignored. Sert à charger un vrai jeu de données de référence dans le
 * Postgres local du chantier postgres-local (voir le plan), sans dépendre de
 * données inventées.
 *
 * Usage : node scripts/backup-r2-blobs.mjs
 * Sortie : backups/<horodatage>/<clé-aplatie>.json
 */
import { loadDotEnv } from './lib/dotenv.mjs';
import { r2Get, r2List, r2Configured } from '../lib/r2.mjs';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

loadDotEnv();

const KEYS = [
  'recolement.json',
  'livres-spolies-overrides.json',
  'exemplaires-manuels.json',
  'reliures-manuelles.json',
  'transferts-magasins.json',
  'desherbage-traitements.json',
  'syracuse-sync.json',
];

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
}

function countRows(key, parsed) {
  if (Array.isArray(parsed)) return parsed.length;
  if (parsed && typeof parsed === 'object') {
    if (key === 'recolement.json') {
      return Object.entries(parsed)
        .map(([k, v]) => `${k}=${Array.isArray(v) ? v.length : '?'}`)
        .join(', ');
    }
    return Object.keys(parsed).length;
  }
  return 'n/a';
}

async function main() {
  if (!r2Configured()) {
    console.error('✖ R2 non configuré (variables R2_* manquantes dans .env) — rien à sauvegarder.');
    process.exit(1);
  }

  const dir = resolve('backups', timestamp());
  mkdirSync(dir, { recursive: true });
  console.log(`▶ backup-r2-blobs : écriture dans ${dir}\n`);

  for (const key of KEYS) {
    try {
      const obj = await r2Get(key);
      if (!obj) {
        console.log(`  · ${key.padEnd(32)} absent sur R2 (jamais écrit)`);
        continue;
      }
      const parsed = JSON.parse(obj.body);
      writeFileSync(resolve(dir, key.replace(/\.json$/, '') + '.json'), obj.body, 'utf8');
      console.log(`  ✓ ${key.padEnd(32)} ${countRows(key, parsed)}`);
    } catch (err) {
      console.error(`  ✖ ${key.padEnd(32)} ${err.message}`);
    }
  }

  console.log(`\n▶ liste des sauvegardes recolement-backups/ (métadonnées seulement, pas le contenu)`);
  try {
    const items = await r2List('recolement-backups/', 1000);
    writeFileSync(
      resolve(dir, 'recolement-backups-list.json'),
      JSON.stringify(items, null, 2),
      'utf8'
    );
    console.log(`  ✓ ${items.length} sauvegarde(s) listée(s)`);
  } catch (err) {
    console.error(`  ✖ recolement-backups/ : ${err.message}`);
  }

  console.log(`\n✓ backup-r2-blobs : terminé (${dir})`);
}

main().catch(err => {
  console.error('✖ backup-r2-blobs:', err.message);
  process.exit(1);
});
