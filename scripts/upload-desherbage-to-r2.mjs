#!/usr/bin/env node
/**
 * npm run upload:desherbage
 *
 * Pousse data/xml/desherbage/desherbage.xml vers R2 (xml/desherbage/desherbage.xml).
 * À relancer après chaque nouvelle extraction Syracuse des statistiques de
 * prêt utilisées par Rotobib (rotobib.html) — voir CLAUDE.md, section
 * « Rotobib (désherbage assisté par les statistiques de prêt) ». Le prochain
 * `npm run build:desherbage` (local ou sur Vercel) récupère automatiquement
 * cette version depuis R2, comme pour xml/magasin/… (voir
 * scripts/build-magasins.mjs).
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

const LOCAL = 'data/xml/desherbage/desherbage.xml';
const KEY = 'xml/desherbage/desherbage.xml';

if (!existsSync(LOCAL)) {
  console.error(`Fichier introuvable : ${LOCAL}`);
  process.exit(1);
}

const body = readFileSync(LOCAL);
console.log(`Envoi de ${LOCAL} (${(body.length / 1e6).toFixed(1)} Mo) vers R2 : ${KEY}…`);
await r2Put(KEY, body, { contentType: 'application/xml' });
console.log('  → OK');
console.log('Upload terminé — le prochain `npm run build:desherbage` récupérera cette version depuis R2.');
