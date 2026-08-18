#!/usr/bin/env node
/**
 * build-cotes-numeriques.mjs
 * ────────────────────────────────────────────────────────────────────────────
 * Construit `data/cotes-numeriques.json` (et son rapport de build) à partir
 * d'un export Syracuse "exemplaires seuls" de la bibliothèque entière :
 *
 *   xml/all/catalogue.xml (R2) → data/xml/all/catalogue.xml
 *
 * Cet export ne contient QUE des <record> d'exemplaires (les notices
 * plantent à l'export tellement l'ensemble est volumineux) — pas de
 * jointure notice/exemplaire ici, contrairement à build-inventory.mjs et
 * build-magasins.mjs. On lit directement la cote ($930$g/$h) et le
 * code-barre ($915$b) sur chaque record.
 *
 * But de l'outil (cotes-numeriques.html) : le SIGB ne permet pas de trier
 * les exemplaires aussi finement que voulu. On isole ici les cotes qui
 * ressemblent à un numéro d'enregistrement séquentiel à 5 ou 6 chiffres
 * (ex : "138678", "11268", parfois écrites avec un point séparateur de
 * milliers : "138.678", "11.268") pour pouvoir les repérer, les trier et
 * exporter leurs codes-barres (ajout panier rapide dans le SIGB).
 *
 * Règle de détection (volontairement plus stricte que celle de
 * build-magasins.mjs — choix explicite pour ce jeu de données) : le
 * candidat doit faire EXACTEMENT 5 ou 6 chiffres ET commencer par le
 * chiffre "1". Ça écarte les cotes Dewey à 3 chiffres avant le point
 * ("168.66", "325.5" — jamais fusionnées de toute façon, voir merge
 * ci-dessous) mais aussi, volontairement, tout numéro d'enregistrement à 5
 * ou 6 chiffres qui ne commencerait pas par "1" : cf. CLAUDE.md pour le
 * contexte de ce choix.
 *
 * Aucune dépendance npm. Node ≥ 18. Nécessite R2 configuré (.env local ou
 * variables Vercel) — comme pour les magasins, ce jeu de données n'a pas de
 * repli local committé (fichier trop volumineux).
 * ────────────────────────────────────────────────────────────────────────────
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { loadDotEnv } from './lib/dotenv.mjs';
import { r2Get, r2Configured } from '../lib/r2.mjs';
import { iterateRecords, parseRecord, getSubfield, flatten } from './lib/marc-xml.mjs';

loadDotEnv();

const CONFIG = {
  r2Key: 'xml/all/catalogue.xml',
  input: 'data/xml/all/catalogue.xml',
  output: {
    data:   'data/cotes-numeriques.json',
    report: 'data/cotes-numeriques-build-report.json',
  },
  multiSep: '§',
  // Mêmes champs exemplaire que build-inventory.mjs — cet export vient du
  // même type d'export Syracuse ("exemplaires"), juste sans filtre de fonds.
  itemFieldsWhitelist: ['915', '920', '921', '922', '925', '926', '930', '201', '202', '316'],
  force: process.env.SYRACUSE_FORCE === '1',
};

// ── Détection cote numérique 5/6 chiffres, premier chiffre "1" ────────────
// Retourne le numéro détecté (string) ou null.
function numericLocDigitRun(coteG) {
  if (!coteG) return null;
  // Cotes de la Réserve Douaisienne : préfixe "D" (± espace) juste avant le
  // numéro ("D138678", "D 138678", "d100784"...). Ce ne sont pas des cotes
  // 2e/5e étage malgré leur numéro à 5/6 chiffres commençant par "1" —
  // exclues avant toute autre analyse.
  if (/^d\s?\d/i.test(coteG)) return null;
  // Fusionne "1-2 chiffres.3 chiffres" (séparateur de milliers) en un seul
  // nombre — n'affecte pas un préfixe Dewey à 3 chiffres ("168.66",
  // "325.5" restent en morceaux de 3/2 ou 3/1 chiffres, jamais fusionnés).
  const merged = coteG.replace(/(?<!\d)(\d{1,2})\.(\d{3})(?!\d)/g, '$1$2');
  const runs = merged.match(/\d+/g) || [];
  for (let run of runs) {
    if (run.length === 7 && run[0] === '0') run = run.slice(1);
    if ((run.length === 5 || run.length === 6) && run[0] === '1') return run;
  }
  return null;
}

// ── Itère les exemplaires, filtre par cote ─────────────────────────────────
function buildItems(xml) {
  const items = [];
  const stats = {
    totalItems: 0,
    kept: 0,
    excluded: 0,
    douaisienneExcluded: 0, // sous-ensemble de excluded : préfixe "D" (Réserve Douaisienne)
    excludedSample: [],   // cotes sans aucun run 5/6 chiffres exploitable
    nearMissSample: [],   // cotes avec un run 5/6 chiffres mais qui ne commence pas par "1"
    douaisienneSample: [], // échantillon des cotes "D..." écartées
    keptEdgeSample: [],   // cotes gardées avec tiret/point/zéro de tête, à relire
  };

  for (const recXml of iterateRecords(xml)) {
    const rec = parseRecord(recXml);
    stats.totalItems++;

    const itemFlat = flatten(rec, CONFIG.itemFieldsWhitelist, CONFIG.multiSep);
    const itemId = rec.controlfields['001'] ?? null;

    const coteG = getSubfield(rec, '930', 'g');
    const coteH = getSubfield(rec, '930', 'h');
    const coteDisplay = [coteG, coteH].filter(Boolean).join(' ');
    const digitRun = numericLocDigitRun(coteG);

    if (!digitRun) {
      stats.excluded++;
      if (stats.excludedSample.length < 30) stats.excludedSample.push(coteDisplay);
      if (/^d\s?\d/i.test(coteG || '')) {
        stats.douaisienneExcluded++;
        if (stats.douaisienneSample.length < 30) stats.douaisienneSample.push(coteDisplay);
      } else {
        const nearMissRuns = (coteG || '').match(/\d{5,6}/g) || [];
        if (nearMissRuns.some(r => r[0] !== '1') && stats.nearMissSample.length < 30) {
          stats.nearMissSample.push(coteDisplay);
        }
      }
      continue;
    }
    stats.kept++;
    if (/[-.]/.test(coteG || '') || /^0/.test(coteG || '')) {
      if (stats.keptEdgeSample.length < 30) stats.keptEdgeSample.push(coteDisplay);
    }

    const barcode = getSubfield(rec, '915', 'b');
    const merged = { ...itemFlat };
    merged._itemId = itemId;
    merged._coteDigitRun = digitRun;
    if (barcode) merged['915$b'] = barcode.trim();

    items.push(merged);
  }

  return { items, stats };
}

// ── Récupération du XML depuis R2 ──────────────────────────────────────────
async function syncXmlFromR2() {
  if (!r2Configured()) {
    console.error(
      '✖ R2 non configuré : ce jeu de données (xml/all/catalogue.xml) n\'a ' +
      'pas de repli local committé. Renseignez R2_ACCOUNT_ID, R2_BUCKET, ' +
      'R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY dans .env.'
    );
    process.exit(1);
  }
  console.log(`  · récupération de ${CONFIG.r2Key}…`);
  const obj = await r2Get(CONFIG.r2Key);
  if (!obj) {
    console.error(`✖ ${CONFIG.r2Key} absent de R2.`);
    process.exit(1);
  }
  mkdirSync(dirname(resolve(CONFIG.input)), { recursive: true });
  writeFileSync(CONFIG.input, obj.body, 'utf-8');
  console.log(`    → ${CONFIG.input} mis à jour depuis R2 (${(obj.body.length / 1e6).toFixed(1)} Mo)`);
}

// ── Main ───────────────────────────────────────────────────────────────────
async function main() {
  const startedAt = Date.now();
  console.log('▶ build-cotes-numeriques: démarrage');

  if (!existsSync(CONFIG.input) || CONFIG.force) {
    await syncXmlFromR2();
  } else {
    console.log('  · fichier local déjà présent (SYRACUSE_FORCE=1 pour forcer le re-téléchargement)');
  }

  console.log(`  · lecture ${CONFIG.input}`);
  const xml = readFileSync(CONFIG.input, 'utf-8');

  console.log('  · construction et filtrage (cotes numériques 5/6 chiffres, premier chiffre "1")');
  const { items, stats } = buildItems(xml);
  console.log(
    `     ${stats.totalItems} exemplaires ・ ${stats.kept} gardés, ${stats.excluded} exclus ` +
    `(dont ${stats.douaisienneExcluded} Réserve Douaisienne)`
  );

  mkdirSync(dirname(resolve(CONFIG.output.data)), { recursive: true });
  writeFileSync(CONFIG.output.data, JSON.stringify(items), 'utf-8');
  console.log(`  · écrit ${CONFIG.output.data} (${items.length} entrées)`);

  // Archive le rapport précédent avant de l'écraser (même mécanique que
  // build-inventory.mjs / build-magasins.mjs).
  if (existsSync(CONFIG.output.report)) {
    const previousPath = CONFIG.output.report.replace(/\.json$/, '-previous.json');
    writeFileSync(previousPath, readFileSync(CONFIG.output.report, 'utf-8'), 'utf-8');
    console.log(`  · archivé ${CONFIG.output.report} → ${previousPath}`);
  }

  const report = {
    generatedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    stats: {
      totalItems: stats.totalItems,
      kept: stats.kept,
      excluded: stats.excluded,
      douaisienneExcluded: stats.douaisienneExcluded,
    },
    excludedSample: stats.excludedSample,
    nearMissSample: stats.nearMissSample,
    douaisienneSample: stats.douaisienneSample,
    keptEdgeSample: stats.keptEdgeSample,
  };
  writeFileSync(CONFIG.output.report, JSON.stringify(report, null, 2), 'utf-8');
  console.log(`  · écrit ${CONFIG.output.report}`);

  const dur = ((Date.now() - startedAt) / 1000).toFixed(2);
  console.log(`✓ build-cotes-numeriques: terminé en ${dur}s`);
}

await main();
