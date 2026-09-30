#!/usr/bin/env node
/**
 * build-fonds-complementaires.mjs
 * ────────────────────────────────────────────────────────────────────────────
 * Construit `data/fonds-complementaires.json` (et son rapport de build) : les
 * fonds absents de Syracuse, tenus dans des registres tableur committés —
 *
 *   - Cartes géographiques : csv/Fonds CAR.csv (ISO-8859-1), une ligne par
 *     document, transformée par buildFondsCarRecord() ;
 *   - Périodiques : csv/periodiques.csv (registre au niveau TITRE) complété
 *     par csv/periodiques2.csv (cotes réellement détenues), transformés par
 *     buildFondsPeriodiqueRecord()/buildFondsPeriodique2Record().
 *
 * Pendant, sur main (site servi par Vercel), de ce que la branche
 * local-server fait via Postgres (scripts/db-migrate-fonds-car.mjs,
 * scripts/db-migrate-fonds-periodiques.mjs, puis export à la volée par
 * /api/inventaire). Ici pas d'endpoint : l'inventaire complet pèse ~20 Mo,
 * au-delà de la limite de réponse d'une fonction Vercel (4,5 Mo) — il reste
 * donc découpé en fichiers statiques, compressés et mis en cache par le CDN,
 * que js/inventaire-page.js recompose côté client (data/inventaire.json +
 * data/non-catalogues.json + ce fichier). Les modules de transformation
 * (scripts/lib/fonds-*-record.mjs) sont les MÊMES que sur local-server :
 * les deux branches produisent des enregistrements identiques.
 *
 * Mêmes règles de sélection que les scripts de migration de local-server,
 * reproduites à l'identique :
 *   - Cartes : ligne ignorée sans « Nom » ou sans « ancienne cote2 » (la cote
 *     en usage, voir scripts/lib/fonds-car-record.mjs) ;
 *   - Périodiques : ligne periodiques.csv ignorée sans period-id ou sans nom ;
 *     rapprochement periodiques2.csv → periodiques.csv d'abord par titre
 *     normalisé (la cote periodiques2 est alors posée sur la ligne existante,
 *     `_coteFromPeriodiques2`), puis par numéro de cote (ligne déjà couverte,
 *     ignorée) ; les lignes restantes deviennent des entrées à part entière.
 *     Une ligne sans cote après tout ça est écartée par le builder lui-même
 *     (masquée de toute façon côté page publique, voir js/inventaire-page.js).
 *
 * Indépendant de `npm run build` (Syracuse) : ne lit ni R2 ni Neon, seulement
 * les CSV du dépôt. À relancer après toute modification de ces CSV, puis
 * committer le JSON produit (même usage que data/non-catalogues.json).
 *
 * Aucune dépendance npm. Node ≥ 18.
 * ────────────────────────────────────────────────────────────────────────────
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parseCsvObjects } from './lib/csv.mjs';
import { buildFondsCarRecord } from './lib/fonds-car-record.mjs';
import {
  buildFondsPeriodiqueRecord, buildFondsPeriodique2Record, normalizeTitreForMatch,
} from './lib/fonds-periodiques-record.mjs';

const CONFIG = {
  car: { input: 'csv/Fonds CAR.csv', encoding: 'latin1' }, // ISO-8859-1, vérifié
  periodiques1: { input: 'csv/periodiques.csv', encoding: 'utf-8' },
  periodiques2: { input: 'csv/periodiques2.csv', encoding: 'utf-8' },
  delimiter: ';',
  output: {
    data: 'data/fonds-complementaires.json',
    report: 'data/fonds-complementaires-build-report.json',
  },
};

function clean(v) {
  return (v || '').replace(/\s+/g, ' ').trim();
}

// "D000003" -> "3", "D3" -> "3" — pour comparer deux écritures différentes
// du même numéro de cote (voir le rapprochement plus bas).
function coteNumber(cote) {
  const m = String(cote || '').match(/(\d+)/);
  return m ? String(parseInt(m[1], 10)) : null;
}

// Cote CSV corrompue sur "Le Vrai Gayant" (même jeton répété) — même
// correction que buildFondsPeriodiqueRecord(), appliquée ici pour que le
// rapprochement par numéro de cote travaille sur la valeur corrigée.
function dedupeCote(raw) {
  const c = clean(raw);
  if (!c) return '';
  const parts = c.split(/\s+/);
  return (parts.length > 1 && parts.every(p => p === parts[0])) ? parts[0] : c;
}

function readCsv({ input, encoding }) {
  if (!existsSync(input)) {
    console.error(`✖ ${input} introuvable.`);
    process.exit(1);
  }
  return parseCsvObjects(readFileSync(input, encoding), { delimiter: CONFIG.delimiter });
}

function buildCartes(stats) {
  const rows = readCsv(CONFIG.car);
  const items = [];
  for (const row of rows) {
    if (!clean(row['Nom'])) { stats.cartes.sansNom++; continue; }
    const rec = buildFondsCarRecord(row);
    if (!rec) { stats.cartes.sansCote++; continue; }
    items.push(rec);
  }
  stats.cartes.lues = rows.length;
  stats.cartes.retenues = items.length;
  return items;
}

function buildPeriodiques(stats) {
  const rows1 = readCsv(CONFIG.periodiques1);
  const rows2 = readCsv(CONFIG.periodiques2);
  const s = stats.periodiques;
  s.lues1 = rows1.length;
  s.lues2 = rows2.length;

  // periodiques.csv : un enregistrement par period-id.
  const records = []; // { row, cote }
  const byNormTitre = new Map();
  const coveredCoteNumbers = new Set();
  for (const row of rows1) {
    if (!clean(row['period-id'])) { s.sansId++; continue; }
    const nom = clean(row['nom']);
    if (!nom) { s.sansNom++; continue; }
    const rec = { row, cote: dedupeCote(row['cote']) };
    records.push(rec);
    const norm = normalizeTitreForMatch(nom);
    if (norm && !byNormTitre.has(norm)) byNormTitre.set(norm, rec);
    const n = coteNumber(rec.cote);
    if (n) coveredCoteNumbers.add(n);
  }

  // Passe 1 : rapprochement par titre — la cote periodiques2 est posée sur
  // la ligne periodiques.csv correspondante (lue en priorité par
  // buildFondsPeriodiqueRecord()) plutôt que de créer un doublon. La ligne
  // CSV est copiée avant d'être annotée : rows1 reste tel que lu.
  const unmatched = [];
  for (const row of rows2) {
    const cote = clean(row['Cote']);
    if (!cote) { s.sansCote2++; continue; }
    const norm = normalizeTitreForMatch(row['Titre']);
    const hit = norm ? byNormTitre.get(norm) : null;
    if (hit) {
      hit.row = { ...hit.row, _coteFromPeriodiques2: cote };
      hit.cote = dedupeCote(cote);
      const n = coteNumber(cote);
      if (n) coveredCoteNumbers.add(n);
      s.rapprochesParTitre++;
      continue;
    }
    unmatched.push(row);
  }

  // Passe 2 : rapprochement par numéro de cote (titres trop différents pour
  // la passe 1) — une ligne déjà couverte est ignorée, pas dupliquée.
  const rows2New = [];
  for (const row of unmatched) {
    const n = coteNumber(clean(row['Cote']));
    if (n && coveredCoteNumbers.has(n)) { s.rapprochesParCote++; continue; }
    rows2New.push(row);
  }

  const items = [];
  for (const { row } of records) {
    const rec = buildFondsPeriodiqueRecord(row);
    if (rec) items.push(rec); else s.sansCoteFinale++;
  }
  for (const row of rows2New) {
    const rec = buildFondsPeriodique2Record(row);
    if (rec) { items.push(rec); s.nouvellesEntrees2++; } else s.sansCoteFinale++;
  }
  s.retenus = items.length;
  return items;
}

function main() {
  const startedAt = Date.now();
  console.log('▶ build-fonds-complementaires: démarrage');

  const stats = {
    cartes: { lues: 0, retenues: 0, sansNom: 0, sansCote: 0 },
    periodiques: {
      lues1: 0, lues2: 0, sansId: 0, sansNom: 0, sansCote2: 0,
      rapprochesParTitre: 0, rapprochesParCote: 0, nouvellesEntrees2: 0,
      sansCoteFinale: 0, retenus: 0,
    },
  };

  const cartes = buildCartes(stats);
  console.log(
    `  · Cartes : ${stats.cartes.retenues}/${stats.cartes.lues} retenues ` +
    `(${stats.cartes.sansNom} sans titre, ${stats.cartes.sansCote} sans cote ignorées)`
  );
  const periodiques = buildPeriodiques(stats);
  const p = stats.periodiques;
  console.log(
    `  · Périodiques : ${p.retenus} retenus — rapprochement periodiques2.csv : ` +
    `${p.rapprochesParTitre} par titre, ${p.rapprochesParCote} par numéro de cote, ` +
    `${p.nouvellesEntrees2} nouvelles entrées ; ${p.sansCoteFinale} sans cote écartés`
  );

  const items = cartes.concat(periodiques);
  if (!cartes.length || !periodiques.length) {
    console.error('✖ Un des deux fonds est vide — vérifier le format des CSV.');
    process.exit(1);
  }

  mkdirSync(dirname(resolve(CONFIG.output.data)), { recursive: true });
  writeFileSync(CONFIG.output.data, JSON.stringify(items), 'utf-8');
  console.log(`  · écrit ${CONFIG.output.data} (${items.length} entrées)`);

  if (existsSync(CONFIG.output.report)) {
    const previousPath = CONFIG.output.report.replace(/\.json$/, '-previous.json');
    writeFileSync(previousPath, readFileSync(CONFIG.output.report, 'utf-8'), 'utf-8');
    console.log(`  · archivé ${CONFIG.output.report} → ${previousPath}`);
  }

  const report = {
    generatedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    stats,
  };
  writeFileSync(CONFIG.output.report, JSON.stringify(report, null, 2), 'utf-8');
  console.log(`  · écrit ${CONFIG.output.report}`);

  const dur = ((Date.now() - startedAt) / 1000).toFixed(2);
  console.log(`✓ build-fonds-complementaires: terminé en ${dur}s`);
}

main();
