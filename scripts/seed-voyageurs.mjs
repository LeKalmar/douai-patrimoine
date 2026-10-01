#!/usr/bin/env node
/**
 * seed-voyageurs.mjs — premier remplissage de la clé R2 `voyageurs.json`
 * (exposition « Voyageurs douaisiens ») depuis un fichier JSON.
 *
 * Usage : node scripts/seed-voyageurs.mjs <fichier.json> [--apply] [--force]
 *
 * Deux formes de fichier acceptées (voir importVoyageurs() dans
 * lib/voyageurs-state.mjs) :
 *   - la réponse de GET /api/voyageurs-admin — `{voyageurs:[…]}`, brouillons
 *     compris. C'est la forme à préférer pour reprendre les saisies faites
 *     sur la branche local-server (base Postgres) ;
 *   - le tableau de data/voyageurs.json de local-server — voyageurs et
 *     voyages publiés seulement, tous marqués publiés à l'arrivée.
 *
 * Sans --apply : contrôle le fichier et affiche ce qui serait écrit.
 * Refuse d'écrire si la clé existe déjà (R2 fait foi une fois rempli, les
 * saisies passent ensuite par l'éditeur) ; --force remplace tout.
 */
import { readFileSync } from 'node:fs';
import { loadDotEnv } from './lib/dotenv.mjs';
import { r2Configured, r2Get, r2Put } from '../lib/r2.mjs';
import { VOYAGEURS_KEY, importVoyageurs } from '../lib/voyageurs-state.mjs';

loadDotEnv();

const args = process.argv.slice(2);
const file = args.find(a => !a.startsWith('--'));
const apply = args.includes('--apply');
const force = args.includes('--force');

if (!file) {
  console.error('Usage : node scripts/seed-voyageurs.mjs <fichier.json> [--apply] [--force]');
  process.exit(1);
}

const state = importVoyageurs(JSON.parse(readFileSync(file, 'utf-8')));
for (const v of state.voyageurs) {
  console.log(`  ${v.publie ? '●' : '○'} ${v.nom} (${v.id})`);
  for (const y of v.voyages) {
    console.log(`      ${y.publie ? '●' : '○'} ${y.titre} — ${y.points.length} étape(s)`);
  }
}
const nbVoyages = state.voyageurs.reduce((n, v) => n + v.voyages.length, 0);
console.log(`\n${state.voyageurs.length} voyageur(s), ${nbVoyages} voyage(s) — ● publié, ○ brouillon.`);

if (!apply) {
  console.log('Simulation : rien n\'a été écrit. Relancer avec --apply pour écrire dans R2.');
  process.exit(0);
}
if (!r2Configured()) {
  console.error('Variables R2_* absentes (.env) : écriture impossible.');
  process.exit(1);
}
const existing = await r2Get(VOYAGEURS_KEY);
if (existing && !force) {
  console.error(`La clé R2 « ${VOYAGEURS_KEY} » existe déjà : rien n'a été écrit (--force pour la remplacer).`);
  process.exit(1);
}
await r2Put(VOYAGEURS_KEY, JSON.stringify(state), existing ? {} : { ifNoneMatch: '*' });
console.log(`Clé R2 « ${VOYAGEURS_KEY} » écrite.`);
