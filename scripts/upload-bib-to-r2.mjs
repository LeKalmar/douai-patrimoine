#!/usr/bin/env node
/**
 * npm run upload:bib
 *
 * Pousse data/xml/bib.xml vers R2 (xml/bib.xml). À relancer après chaque
 * nouvel export complet de la bibliothèque — voir CLAUDE.md, sections
 * « Magasins 2e/5e/6e étage » et « Cotes numériques ». Les prochains
 * `npm run build:magasins` et `npm run build:cotes-numeriques` (local ou sur
 * Vercel) récupèrent automatiquement cette version depuis R2.
 *
 * Identifiants R2 lus dans un .env local (jamais commité, voir CLAUDE.md).
 */
import { readFileSync, existsSync } from 'node:fs';
import { loadDotEnv } from './lib/dotenv.mjs';
import { r2Put, r2Configured } from '../lib/r2.mjs';

loadDotEnv();

if (!r2Configured()) {
  console.error(
    'R2 non configuré : renseignez R2_ACCOUNT_ID, R2_BUCKET, R2_ACCESS_KEY_ID, ' +
    'R2_SECRET_ACCESS_KEY dans un fichier .env à la racine du projet (voir CLAUDE.md).'
  );
  process.exit(1);
}

const LOCAL = 'data/xml/bib.xml';
const KEY = 'xml/bib.xml';

if (!existsSync(LOCAL)) {
  console.error(`Fichier introuvable : ${LOCAL}`);
  process.exit(1);
}

const body = readFileSync(LOCAL);
console.log(`Envoi de ${LOCAL} (${(body.length / 1e6).toFixed(1)} Mo) vers R2 : ${KEY}… (peut prendre plusieurs minutes)`);
await r2Put(KEY, body, { contentType: 'application/xml' });
console.log('  → OK');
console.log('Upload terminé — les prochains `npm run build:magasins`/`build:cotes-numeriques` récupéreront cette version depuis R2.');
