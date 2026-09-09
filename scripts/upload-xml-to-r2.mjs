#!/usr/bin/env node
/**
 * npm run upload:xml
 *
 * Pousse data/xml/notices.xml et data/xml/exemplaires.xml vers R2
 * (xml/notices.xml, xml/exemplaires.xml). But : ne plus committer ces
 * fichiers (61 Mo + 14 Mo) dans git à chaque export Syracuse — le prochain
 * `npm run build` (local ou sur Vercel) les récupère automatiquement depuis
 * R2 (voir build-inventory.mjs).
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

const FILES = [
  { local: 'data/xml/notices.xml', key: 'xml/notices.xml' },
  { local: 'data/xml/exemplaires.xml', key: 'xml/exemplaires.xml' },
];

for (const f of FILES) {
  if (!existsSync(f.local)) {
    console.error(`Fichier introuvable : ${f.local}`);
    process.exit(1);
  }
}

for (const f of FILES) {
  const body = readFileSync(f.local);
  console.log(`Envoi de ${f.local} (${(body.length / 1e6).toFixed(1)} Mo) vers R2 : ${f.key}…`);
  await r2Put(f.key, body, { contentType: 'application/xml' });
  console.log('  → OK');
}
console.log('Upload terminé — le prochain `npm run build` récupérera cette version depuis R2.');
