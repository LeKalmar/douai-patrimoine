#!/usr/bin/env node
/**
 * build-magasins.mjs
 * ────────────────────────────────────────────────────────────────────────────
 * Construit `data/magasins.json` (et `data/magasins-build-report.json`) à
 * partir de l'export complet de la bibliothèque :
 *
 *   xml/bib.xml (R2) → data/xml/bib.xml
 *
 * `bib.xml` est un export "GESMARC" à plat (voir scripts/lib/gesmarc.mjs),
 * pas du MARC-XML — un `<item>` par exemplaire, avec ses propres propriétés
 * (`Titre`, `Auteur`, `Editeur`, `Code-barres (valeur)`, `Cote n° 1/2/3`,
 * `Bibliothèque (Libellé)`, `Section (Libellé)`…). Il couvre tout le réseau
 * (plusieurs bibliothèques, toutes les sections) : ce script isole les
 * exemplaires des magasins d'étage de la bibliothèque de Douai —
 * `Bibliothèque (Libellé)` commençant par "Douai" et `Section (Libellé)`
 * valant exactement "Magasin" (adulte) ou "Magasin Jeunesse".
 *
 * Contrairement à l'ancien export dédié (xml/magasin/notices.xml.xml +
 * exemplaires.xml.xml), `bib.xml` ne nécessite aucune jointure notice/
 * exemplaire séparée : titre/auteur/éditeur sont déjà portés par chaque
 * exemplaire.
 *
 * Étage (2e/5e vs 6e) : au sein de la section "Magasin", les deux fonds
 * cohabitent dans le même export, distingués par la forme de la cote — la
 * cote complète est reconstruite en joignant "Cote n° 1", "Cote n° 2" et
 * "Cote n° 3" (chacune peut porter un fragment du numéro ou de la lettre,
 * cf. rapport de build) avant d'y chercher un numéro d'enregistrement :
 *
 *   - 2e/5e étage : numéro séquentiel de 5 ou 6 chiffres (ex : "166010"),
 *     parfois avec un zéro de tête, parfois un point séparateur de milliers
 *     pour un nombre à 5 chiffres ("12.352" = 12352).
 *   - 6e étage : cotes littérales ("R GRI", "BD TSI") ou indices Dewey
 *     classiques à 3 chiffres avant le point ("940.21", "330.122").
 *
 * Contrairement à l'ancien script, le 6e étage n'est plus exclu : toute la
 * section "Magasin"/"Magasin Jeunesse" est gardée, avec juste un marquage
 * (`_coteDigitRun` présent ou non) qui permet à magasins.html/récolement de
 * distinguer 2e/5e (numérique) du 6e (le reste) — voir CLAUDE.md.
 *
 * Aucune dépendance npm. Node ≥ 18. Nécessite R2 configuré (.env local ou
 * variables Vercel) — ce jeu de données n'a pas de repli local committé.
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
    magasins: 'data/magasins.json',
    report:   'data/magasins-build-report.json',
  },
  vignetteBaseUrl: 'https://pub-85062da5f8a7451b9c168f8b3cfd980b.r2.dev/vignette/',
  // Sections de bib.xml qui correspondent aux magasins d'étage (2e/5e/6e).
  magasinSections: ['Magasin', 'Magasin Jeunesse'],
  force: process.env.SYRACUSE_FORCE === '1',
};

// ── Filtre étage : la cote (jointe) désigne-t-elle un ouvrage 2e/5e étage ? ─
// Voir l'en-tête du fichier. Retourne le groupe de chiffres identifié (2e/5e
// étage) ou null (6e étage — désormais gardé, pas exclu).
function magasinDigitRun(cote) {
  if (!cote) return null;
  // Fusionne "1-2 chiffres.3 chiffres" (séparateur de milliers) en un seul
  // nombre. N'affecte pas un préfixe Dewey à 3 chiffres ("940.21" reste
  // "940" + "." + "21").
  const merged = cote.replace(/(?<!\d)(\d{1,2})\.(\d{3})(?!\d)/g, '$1$2');
  const runs = merged.match(/\d+/g) || [];
  for (let run of runs) {
    if (run.length === 7 && run[0] === '0') run = run.slice(1);
    if (run.length === 5 || run.length === 6) return run;
  }
  return null;
}

function secteurLabel(section) {
  return section === 'Magasin Jeunesse' ? 'Jeunesse' : 'Adulte';
}

function fondsLabel(digitRun, section) {
  const etage = digitRun ? '2e/5e étage' : '6e étage';
  return `Magasin — ${etage} (${secteurLabel(section)})`;
}

// ── Itère les exemplaires de bib.xml, filtre bibliothèque + section ────────
// bib.xml (700+ Mo) est lu en flux (iterateGesmarcItemsFromFile) plutôt que
// chargé entièrement en mémoire — voir scripts/lib/gesmarc.mjs.
async function buildItems(path) {
  const items = [];
  const stats = {
    totalItems: 0,
    kept: 0,
    bySection: {},   // 'Magasin' / 'Magasin Jeunesse' → compte
    byEtage: { '2e/5e': 0, '6e': 0 },
    keptEdgeSample: [], // cotes gardées avec tiret/point/zéro de tête, à relire
  };

  for await (const itemXml of iterateGesmarcItemsFromFile(path)) {
    stats.totalItems++;
    const props = parseGesmarcItem(itemXml);

    const bibliotheque = props['Bibliothèque (Libellé)'] || '';
    const section = props['Section (Libellé)'] || '';
    if (!bibliotheque.startsWith('Douai')) continue;
    if (!CONFIG.magasinSections.includes(section)) continue;

    const barcode = (props['Code-barres (valeur)'] || '').trim();
    if (!barcode) continue;

    const cote1 = props['Cote n° 1'] || '';
    const cote2 = props['Cote n° 2'] || '';
    const cote3 = props['Cote n° 3'] || '';
    const coteJointe = [cote1, cote2, cote3].filter(Boolean).join(' ');
    const digitRun = magasinDigitRun(coteJointe);

    stats.kept++;
    stats.bySection[section] = (stats.bySection[section] || 0) + 1;
    stats.byEtage[digitRun ? '2e/5e' : '6e']++;
    if (/[-.]/.test(coteJointe) || /^0/.test(cote1)) {
      if (stats.keptEdgeSample.length < 30) stats.keptEdgeSample.push(coteJointe);
    }

    items.push({
      '930$g': cote1 || null,
      '930$h': cote2 || null,
      '930$i': cote3 || null,
      '915$b': barcode,
      '200$a': props['Titre'] || null,
      '700$a': props['Auteur'] || null,
      '210$c': props['Editeur'] || null,
      '210$d': props['Publié le'] || null,
      lien_num: `${CONFIG.vignetteBaseUrl}${barcode}.jpg`,
      _coteDigitRun: digitRun,
      _secteur: section,
      _bibliotheque: bibliotheque,
      _fondsLabel: fondsLabel(digitRun, section),
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
  console.log('▶ build-magasins: démarrage');

  if (!existsSync(CONFIG.input) || CONFIG.force) {
    await syncXmlFromR2();
  } else {
    console.log('  · fichier local déjà présent (SYRACUSE_FORCE=1 pour forcer le re-téléchargement)');
  }

  console.log(`  · lecture (en flux) ${CONFIG.input}`);
  console.log('  · construction et filtrage (magasins d\'étage, bibliothèque Douai)');
  const { items, stats } = await buildItems(CONFIG.input);
  console.log(
    `     ${stats.totalItems} exemplaires scannés ・ ${stats.kept} gardés ` +
    `(${stats.byEtage['2e/5e']} 2e/5e étage, ${stats.byEtage['6e']} 6e étage) ・ ` +
    `sections : ${JSON.stringify(stats.bySection)}`
  );

  if (stats.kept === 0 && !CONFIG.force) {
    console.error('✖ Aucun exemplaire retenu — export bib.xml inattendu. SYRACUSE_FORCE=1 pour forcer quand même.');
    process.exit(1);
  }

  mkdirSync(dirname(resolve(CONFIG.output.magasins)), { recursive: true });
  writeFileSync(CONFIG.output.magasins, JSON.stringify(items), 'utf-8');
  console.log(`  · écrit ${CONFIG.output.magasins} (${items.length} entrées)`);

  // Archive le rapport précédent avant de l'écraser (même mécanique que
  // build-inventory.mjs).
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
      bySection: stats.bySection,
      byEtage: stats.byEtage,
    },
    keptEdgeSample: stats.keptEdgeSample,
  };
  writeFileSync(CONFIG.output.report, JSON.stringify(report, null, 2), 'utf-8');
  console.log(`  · écrit ${CONFIG.output.report}`);

  const dur = ((Date.now() - startedAt) / 1000).toFixed(2);
  console.log(`✓ build-magasins: terminé en ${dur}s`);
}

await main();
