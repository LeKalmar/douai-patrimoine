#!/usr/bin/env node
/**
 * build-desherbage.mjs
 * ────────────────────────────────────────────────────────────────────────────
 * Construit `data/desherbage.json` (et `data/desherbage-build-report.json`) —
 * les statistiques de prêt/réservation utilisées par Rotobib (rotobib.html)
 * et par la vue d'ensemble statistique (desherbage-stats.html).
 *
 *   xml/bib.xml (R2) → data/xml/bib.xml
 *
 * Jusqu'au 2026-09-09, ces statistiques venaient d'un export Syracuse
 * ponctuel et distinct (xml/desherbage/desherbage.xml, ~6 140 exemplaires des
 * seuls magasins d'étage — voir historique git). Ce jour-là, le profil
 * d'export de `bib.xml` a changé côté Syracuse : chaque `<item>` porte
 * désormais directement ses statistiques de prêt/réservation par année
 * (`Nombre de prêts AN/AN-1/AN-2/AN-3/cumulés`, `Nombre de réservations
 * AN/…/cumulées`), en plus des champs déjà lus par build-magasins.mjs
 * (titre, auteur, éditeur, cote, section…) — pour les ~291 000 exemplaires
 * de toute la bibliothèque de Douai, plus « Publié le » qui manquait
 * jusque-là. L'ancien export dédié devient donc inutile : ce script lit
 * `bib.xml` exactement comme build-magasins.mjs (même fichier local partagé,
 * même filtre `Bibliothèque (Libellé)` commençant par "Douai"), sans plus
 * jamais avoir besoin d'un export séparé ni d'une jointure notice/exemplaire.
 *
 * `data/desherbage.json` couvre donc désormais TOUTE la bibliothèque Douai,
 * pas seulement les magasins — chaque exemplaire porte un flag `_isMagasin`
 * (même sémantique que magasins.json, voir ./lib/magasin-classify.mjs). Deux
 * usages distincts en aval, sur demande explicite de l'équipe (2026-09-10) :
 *
 *   - rotobib.html filtre côté client sur `_isMagasin` (même patron que
 *     magasins.html) : l'outil de décision pilon/braderie reste scopé aux
 *     seuls magasins d'étage, pour ne pas exposer ces boutons sur des
 *     documents patrimoniaux ou en circulation active dans les rayons.
 *   - desherbage-stats.html, purement statistique (aucune décision prise ni
 *     stockée), affiche le jeu de données SANS filtre — sert de base à de
 *     futurs outils visuels sur l'ensemble du catalogue.
 *
 * Champs perdus dans ce nouveau format par rapport à l'ancien export dédié :
 * `686$a` (Dewey), `215$a`/`215$d` (description/dimensions) — bib.xml/GESMARC
 * ne porte pas ces informations (même perte déjà acceptée lors du passage de
 * magasins.html/cotes-numeriques.html à bib.xml le 2026-08-26, voir
 * CLAUDE.md).
 *
 * Champs de prêt/réservation vides dans l'export : Syracuse omet la valeur
 * plutôt que d'écrire "0" pour "Nombre de prêts AN/AN-1/AN-2/AN-3" (vérifié :
 * la somme des 4 années, vide traitée comme 0, ne dépasse jamais "Nombre de
 * prêts cumulés" — qui lui est toujours écrit explicitement, y compris "0").
 * Une case vide sur ces 4 champs signifie donc bien "0 prêt cette année-là",
 * pas "donnée absente" — traité comme tel ci-dessous (parseCount).
 *
 * Année de référence de "AN" : absente de l'export (pas de date d'extraction
 * fournie par Syracuse). Prise par défaut comme l'année en cours au moment du
 * build (`new Date().getFullYear()`), réglable via la variable
 * d'environnement DESHERBAGE_REFERENCE_YEAR si le build est lancé longtemps
 * après l'export réel. Stockée dans le rapport de build
 * (stats.referenceYear), lue par rotobib.html/desherbage-stats.html pour
 * étiqueter les barres des histogrammes avec de vraies années.
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
import { loadColumnar } from './lib/load-columnar.mjs';
import { magasinDigitRun, isPiegeEnReserve, isMagasin, fondsLabel } from './lib/magasin-classify.mjs';

loadDotEnv();

const CONFIG = {
  r2Key: 'xml/bib.xml',
  input: 'data/xml/bib.xml',
  output: {
    desherbage: 'data/desherbage.json',
    report:     'data/desherbage-build-report.json',
  },
  vignetteBaseUrl: 'https://pub-85062da5f8a7451b9c168f8b3cfd980b.r2.dev/vignette/',
  force: process.env.SYRACUSE_FORCE === '1',
  referenceYear: process.env.DESHERBAGE_REFERENCE_YEAR
    ? parseInt(process.env.DESHERBAGE_REFERENCE_YEAR, 10)
    : new Date().getFullYear(),
};

// Champ de comptage annuel : vide = 0 prêt/réservation cette année-là (voir
// en-tête du fichier), pas une donnée manquante.
function parseCount(v) {
  if (v === undefined || v === null || v === '') return 0;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : 0;
}

// ── Itère bib.xml, filtre bibliothèque seulement (même filtre que
//    build-magasins.mjs) ──────────────────────────────────────────────────
async function buildItems(path) {
  const items = [];
  const stats = {
    totalItems: 0,
    kept: 0,          // toute la bibliothèque Douai
    keptMagasin: 0,   // dont magasins d'étage (_isMagasin)
    withLoanData: 0,  // exemplaires ayant au moins un compteur de prêt non nul
    bySection: {},
  };

  for await (const itemXml of iterateGesmarcItemsFromFile(path)) {
    stats.totalItems++;
    if (stats.totalItems % 20000 === 0) {
      const mem = process.memoryUsage();
      console.log(`    · ${stats.totalItems} items lus — rss ${(mem.rss/1e6).toFixed(0)} Mo, heap ${(mem.heapUsed/1e6).toFixed(0)}/${(mem.heapTotal/1e6).toFixed(0)} Mo`);
    }
    const props = parseGesmarcItem(itemXml);

    const bibliotheque = props['Bibliothèque (Libellé)'] || '';
    const section = props['Section (Libellé)'] || '';
    if (!bibliotheque.startsWith('Douai')) continue;

    const barcode = (props['Code-barres (valeur)'] || '').trim();
    if (!barcode) continue;

    const piege = (props['Pièges'] || '').trim() || null;
    const magasin = isMagasin(section, piege);

    const cote1 = props['Cote n° 1'] || '';
    const cote2 = props['Cote n° 2'] || '';
    const cote3 = props['Cote n° 3'] || '';
    const coteJointe = [cote1, cote2, cote3].filter(Boolean).join(' ');
    const digitRun = magasinDigitRun(coteJointe);

    stats.kept++;
    stats.bySection[section] = (stats.bySection[section] || 0) + 1;
    if (magasin) stats.keptMagasin++;

    const prets = {
      an:  parseCount(props['Nombre de prêts AN']),
      an1: parseCount(props['Nombre de prêts AN-1']),
      an2: parseCount(props['Nombre de prêts AN-2']),
      an3: parseCount(props['Nombre de prêts AN-3']),
      cumules: parseCount(props['Nombre de prêts cumulés']),
    };
    const reservations = {
      an:  parseCount(props['Nombre de réservations AN']),
      an1: parseCount(props['Nombre de réservations AN-1']),
      an2: parseCount(props['Nombre de réservations AN-2']),
      an3: parseCount(props['Nombre de réservations AN-3']),
      cumulees: parseCount(props['Nombre de réservations cumulées']),
    };
    if (prets.an || prets.an1 || prets.an2 || prets.an3 || prets.cumules) stats.withLoanData++;

    items.push({
      _barcode: barcode,
      '915$b': barcode,
      '930$g': cote1 || null,
      '930$h': cote2 || null,
      '930$i': cote3 || null,
      '200$a': props['Titre'] || null,
      '700$a': props['Auteur'] || null,
      '210$c': props['Editeur'] || null,
      '210$d': props['Publié le'] || null,
      lien_num: `${CONFIG.vignetteBaseUrl}${barcode}.jpg`,
      titrePartie: props['Titre de partie et N° de partie'] || null,
      titreSerie: props['Titre de série'] || null,
      tome: props['Tome'] || null,
      isbn: props['ISBN'] || null,
      issn: props['ISSN'] || null,
      imagette: props['Imagette'] || null,
      bibliotheque,
      section: section || null,
      etat: props['Etat  (Libellé)'] || null,
      exclusionPret: props['Piège 921$a (Libellé)'] || null,
      // Champ "Pièges" complet (texte libre, peut combiner plusieurs pièges,
      // ex. "Exclu DEFINITIVEMENT du prêt Consultation sur place") — même
      // champ que _piege dans build-magasins.mjs, plus informatif que
      // exclusionPret (921$a seul) pour la colonne "Piège" des dormants de
      // desherbage-stats.html. `piege` déjà extrait plus haut pour isMagasin().
      _piege: piege,
      coteAffichee: coteJointe || props['Cotes'] || null,
      _coteDigitRun: digitRun,
      _isMagasin: magasin,
      _fondsLabel: magasin ? fondsLabel(digitRun, section) : (section || 'Section inconnue'),
      prets,
      reservations,
    });
  }

  return { items, stats };
}

// ── Récupération du XML depuis R2 (même fichier local que build-magasins.mjs
//    / build-cotes-numeriques.mjs — un seul téléchargement suffit aux trois
//    scripts si lancés à la suite). ─────────────────────────────────────────
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
  console.log('▶ build-desherbage: démarrage');

  if (!existsSync(CONFIG.input) || CONFIG.force) {
    await syncXmlFromR2();
  } else {
    console.log('  · fichier local déjà présent (SYRACUSE_FORCE=1 pour forcer le re-téléchargement)');
  }

  console.log(`  · lecture (en flux) ${CONFIG.input}`);
  const { items, stats } = await buildItems(CONFIG.input);
  console.log(
    `     ${stats.totalItems} exemplaires scannés ・ ${stats.kept} gardés (bibliothèque Douai) ・ ` +
    `dont ${stats.keptMagasin} en magasin ・ ${stats.withLoanData} avec au moins un prêt annuel non nul`
  );

  if (stats.kept === 0 && !CONFIG.force) {
    console.error('✖ Aucun exemplaire retenu — export bib.xml inattendu. SYRACUSE_FORCE=1 pour forcer quand même.');
    process.exit(1);
  }

  mkdirSync(dirname(resolve(CONFIG.output.desherbage)), { recursive: true });
  /* Conteneur colonnaire (voir js/columnar.js) : `prets`/`reservations` sont
     des objets mais restent internés comme n'importe quelle autre valeur
     (dictKey sur leur forme JSON) — la quasi-totalité des lignes partagent le
     même objet tout-à-zéro, donc ces deux colonnes restent compactes malgré
     leur nature composite. */
  const columnar = loadColumnar();
  const encoded = columnar.encode(items, {
    templates: [{ col: 'lien_num', from: '915$b', prefix: CONFIG.vignetteBaseUrl, suffix: '.jpg' }],
  });
  writeFileSync(CONFIG.output.desherbage, JSON.stringify(encoded), 'utf-8');
  console.log(`  · écrit ${CONFIG.output.desherbage} (${items.length} entrées, format ${columnar.FORMAT})`);

  // Archive le rapport précédent avant de l'écraser (même mécanique que les
  // autres scripts de build).
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
      keptMagasin: stats.keptMagasin,
      withLoanData: stats.withLoanData,
      bySection: stats.bySection,
      referenceYear: CONFIG.referenceYear,
    },
  };
  writeFileSync(CONFIG.output.report, JSON.stringify(report, null, 2), 'utf-8');
  console.log(`  · écrit ${CONFIG.output.report}`);

  const dur = ((Date.now() - startedAt) / 1000).toFixed(2);
  console.log(`✓ build-desherbage: terminé en ${dur}s`);
}

await main();
