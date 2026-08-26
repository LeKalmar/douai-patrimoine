#!/usr/bin/env node
/**
 * build-cotes-numeriques.mjs
 * ────────────────────────────────────────────────────────────────────────────
 * Construit `data/cotes-numeriques.json` (et son rapport de build) à partir
 * de l'export complet de la bibliothèque :
 *
 *   xml/bib.xml (R2) → data/xml/bib.xml
 *
 * `bib.xml` est un export "GESMARC" à plat (voir scripts/lib/gesmarc.mjs),
 * pas du MARC-XML. Il couvre tout le réseau (plusieurs bibliothèques,
 * toutes les sections) — ce script ne garde que les bibliothèques de Douai
 * (`Bibliothèque (Libellé)` commençant par "Douai" ; exclut notamment
 * "Médiathèque départementale", hors périmètre), sans restriction de
 * section : le but est justement de chercher une cote numérique n'importe
 * où dans le catalogue, pas seulement dans les magasins, pour repérer une
 * éventuelle anomalie de classement.
 *
 * But de l'outil (cotes-numeriques.html) : le SIGB ne permet pas de trier
 * les exemplaires aussi finement que voulu. On isole ici les cotes qui
 * ressemblent à un numéro d'enregistrement séquentiel à 5 ou 6 chiffres
 * (ex : "138678", "11268", parfois écrites avec un point séparateur de
 * milliers : "138.678", "11.268") pour pouvoir les repérer, les trier et
 * exporter leurs codes-barres (ajout panier rapide dans le SIGB).
 *
 * La cote de bib.xml est éclatée sur 3 propriétés indépendantes ("Cote n° 1",
 * "Cote n° 2", "Cote n° 3" — chacune peut porter un fragment du numéro ou de
 * la lettre) : on les joint (espace comme séparateur) avant toute analyse,
 * contrairement à l'ancien export MARC-XML où tout était porté par $930$g.
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
 * variables Vercel) — ce jeu de données n'a pas de repli local committé
 * (fichier trop volumineux).
 * ────────────────────────────────────────────────────────────────────────────
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { loadDotEnv } from './lib/dotenv.mjs';
import { r2Get, r2Configured } from '../lib/r2.mjs';
import { iterateGesmarcItemsFromFile, parseGesmarcItem } from './lib/gesmarc.mjs';

loadDotEnv();

const CONFIG = {
  r2Key: 'xml/bib.xml',
  input: 'data/xml/bib.xml',
  output: {
    data:   'data/cotes-numeriques.json',
    report: 'data/cotes-numeriques-build-report.json',
  },
  force: process.env.SYRACUSE_FORCE === '1',
};

// ── Détection cote numérique 5/6 chiffres, premier chiffre "1" ────────────
// Retourne le numéro détecté (string) ou null. `cote` est déjà la jointure
// de "Cote n° 1/2/3" (voir buildItems).
function numericLocDigitRun(cote) {
  if (!cote) return null;
  // Cotes de la Réserve Douaisienne : préfixe "D" (± espace) juste avant le
  // numéro ("D138678", "D 138678", "d100784"...). Ce ne sont pas des cotes
  // 2e/5e étage malgré leur numéro à 5/6 chiffres commençant par "1" —
  // exclues avant toute autre analyse.
  if (/^d\s?\d/i.test(cote)) return null;
  // Fusionne "1-2 chiffres.3 chiffres" (séparateur de milliers) en un seul
  // nombre — n'affecte pas un préfixe Dewey à 3 chiffres ("168.66",
  // "325.5" restent en morceaux de 3/2 ou 3/1 chiffres, jamais fusionnés).
  const merged = cote.replace(/(?<!\d)(\d{1,2})\.(\d{3})(?!\d)/g, '$1$2');
  const runs = merged.match(/\d+/g) || [];
  for (let run of runs) {
    if (run.length === 7 && run[0] === '0') run = run.slice(1);
    if ((run.length === 5 || run.length === 6) && run[0] === '1') return run;
  }
  return null;
}

// ── Itère les exemplaires de bib.xml, filtre bibliothèque + cote ──────────
// bib.xml (700+ Mo) est lu en flux (iterateGesmarcItemsFromFile) plutôt que
// chargé entièrement en mémoire — voir scripts/lib/gesmarc.mjs.
async function buildItems(path) {
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

  for await (const itemXml of iterateGesmarcItemsFromFile(path)) {
    stats.totalItems++;
    const props = parseGesmarcItem(itemXml);

    const bibliotheque = props['Bibliothèque (Libellé)'] || '';
    if (!bibliotheque.startsWith('Douai')) continue;

    const cote1 = props['Cote n° 1'] || '';
    const cote2 = props['Cote n° 2'] || '';
    const cote3 = props['Cote n° 3'] || '';
    const coteJointe = [cote1, cote2, cote3].filter(Boolean).join(' ');
    const digitRun = numericLocDigitRun(coteJointe);

    if (!digitRun) {
      stats.excluded++;
      if (stats.excludedSample.length < 30) stats.excludedSample.push(coteJointe);
      if (/^d\s?\d/i.test(coteJointe)) {
        stats.douaisienneExcluded++;
        if (stats.douaisienneSample.length < 30) stats.douaisienneSample.push(coteJointe);
      } else {
        const nearMissRuns = coteJointe.match(/\d{5,6}/g) || [];
        if (nearMissRuns.some(r => r[0] !== '1') && stats.nearMissSample.length < 30) {
          stats.nearMissSample.push(coteJointe);
        }
      }
      continue;
    }
    stats.kept++;
    if (/[-.]/.test(coteJointe) || /^0/.test(cote1)) {
      if (stats.keptEdgeSample.length < 30) stats.keptEdgeSample.push(coteJointe);
    }

    const barcode = (props['Code-barres (valeur)'] || '').trim();

    items.push({
      '930$g': cote1 || null,
      '930$h': cote2 || null,
      '930$i': cote3 || null,
      '915$b': barcode || null,
      '200$a': props['Titre'] || null,
      '700$a': props['Auteur'] || null,
      '210$c': props['Editeur'] || null,
      '210$d': props['Publié le'] || null,
      _coteDigitRun: digitRun,
      _bibliotheque: bibliotheque,
      _section: props['Section (Libellé)'] || null,
    });
  }

  return { items, stats };
}

// ── Récupération du XML depuis R2 ──────────────────────────────────────────
async function syncXmlFromR2() {
  if (!r2Configured()) {
    console.error(
      '✖ R2 non configuré : ce jeu de données (xml/bib.xml) n\'a pas de repli ' +
      'local committé. Renseignez R2_ACCOUNT_ID, R2_BUCKET, R2_ACCESS_KEY_ID, ' +
      'R2_SECRET_ACCESS_KEY dans .env.'
    );
    process.exit(1);
  }
  console.log(`  · récupération de ${CONFIG.r2Key}… (fichier volumineux, patientez)`);
  // raw:true — bib.xml dépasse la limite de longueur d'une string V8, on
  // garde le corps en Buffer (voir r2Get() dans lib/r2.mjs).
  const obj = await r2Get(CONFIG.r2Key, { raw: true });
  if (!obj) {
    console.error(`✖ ${CONFIG.r2Key} absent de R2.`);
    process.exit(1);
  }
  mkdirSync(dirname(resolve(CONFIG.input)), { recursive: true });
  writeFileSync(CONFIG.input, obj.body);
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

  console.log(`  · lecture (en flux) ${CONFIG.input}`);
  console.log('  · construction et filtrage (cotes numériques 5/6 chiffres, premier chiffre "1", bibliothèques Douai)');
  const { items, stats } = await buildItems(CONFIG.input);
  console.log(
    `     ${stats.totalItems} exemplaires ・ ${stats.kept} gardés, ${stats.excluded} exclus ` +
    `(dont ${stats.douaisienneExcluded} Réserve Douaisienne)`
  );

  if (stats.totalItems === 0 && !CONFIG.force) {
    console.error('✖ 0 exemplaire lu — export bib.xml inattendu. SYRACUSE_FORCE=1 pour forcer quand même.');
    process.exit(1);
  }

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
