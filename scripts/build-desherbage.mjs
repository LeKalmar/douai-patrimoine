#!/usr/bin/env node
/**
 * build-desherbage.mjs
 * ────────────────────────────────────────────────────────────────────────────
 * Construit `data/desherbage.json` (et `data/desherbage-build-report.json`) à
 * partir de l'export Syracuse "statistiques de prêt" utilisé par l'outil
 * Rotobib (rotobib.html) :
 *
 *   - xml/desherbage/desherbage.xml  (R2) → data/xml/desherbage/desherbage.xml
 *
 * Ce fichier n'est PAS du MARC-XML comme les autres exports du projet — c'est
 * un export "GESMARC" à plat : <items><item type="GESMARC"><property
 * name="…" value="…" /></item></items>, un <item> par exemplaire, avec les
 * statistiques de prêt/réservation par année (AN = année en cours, AN-1,
 * AN-2, AN-3) plus un total cumulé depuis l'acquisition. Aucune info notice
 * (titre/auteur/date de parution) dans ce fichier : uniquement l'exemplaire.
 *
 * Vérifié sur l'export du 2026-08-26 (6140 exemplaires) : 100% des
 * codes-barres de cet export se retrouvent dans xml/magasin/notices.xml.xml
 * (même notice-export que build-magasins.mjs, voir CLAUDE.md section
 * « Magasins 2e/5e étage ») — le désherbage porte sur des collections des
 * magasins d'étage. On réutilise donc `indexNotices()` de build-magasins.mjs
 * pour la jointure code-barre → notice (titre, auteur, éditeur, date de
 * parution 210$d…), sans reparser data/xml/notices.xml (réserve patrimoniale,
 * périmètre différent) ni retélécharger xml/magasin/exemplaires.xml.xml (les
 * champs exemplaire dont on a besoin — cote, section, état, statistiques —
 * sont déjà dans desherbage.xml lui-même).
 *
 * Champs de prêt vides dans l'export : Syracuse omet la valeur plutôt que
 * d'écrire "0" pour "Nombre de prêts AN/AN-1/AN-2/AN-3" (vérifié : la somme
 * des 4 années, vide traitée comme 0, ne dépasse jamais "Nombre de prêts
 * cumulés" — qui lui est toujours écrit explicitement, y compris "0"). Une
 * case vide sur ces 4 champs signifie donc bien "0 prêt cette année-là", pas
 * "donnée absente" — traité comme tel ci-dessous (parseCount).
 *
 * Année de référence de "AN" : ce champ n'existe dans aucune propriété de
 * l'export (pas de date d'extraction fournie par Syracuse ici). On prend par
 * défaut l'année en cours au moment du build (`new Date().getFullYear()`),
 * réglable via la variable d'environnement DESHERBAGE_REFERENCE_YEAR si le
 * build est lancé longtemps après l'export réel. Stockée dans le rapport de
 * build (stats.referenceYear), lue par rotobib.html pour étiqueter les
 * barres de l'histogramme avec de vraies années plutôt que "AN"/"AN-1"/etc.
 *
 * Aucune dépendance npm. Node ≥ 18. Nécessite R2 configuré (.env local ou
 * variables Vercel) — comme les magasins/cotes-numériques, ce jeu de données
 * n'a pas de repli local committé (voir CLAUDE.md).
 * ────────────────────────────────────────────────────────────────────────────
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { loadDotEnv } from './lib/dotenv.mjs';
import { loadColumnar } from './lib/load-columnar.mjs';
import { r2Get, r2Configured } from '../lib/r2.mjs';
import { indexNotices } from './lib/marc-xml.mjs';
import { iterateGesmarcItems, parseGesmarcItem } from './lib/gesmarc.mjs';

loadDotEnv();

const CONFIG = {
  r2Keys: {
    notices:    'xml/magasin/notices.xml.xml',
    desherbage: 'xml/desherbage/desherbage.xml',
  },
  input: {
    notices:    'data/xml/magasin/notices.xml',
    desherbage: 'data/xml/desherbage/desherbage.xml',
  },
  output: {
    desherbage: 'data/desherbage.json',
    report:     'data/desherbage-build-report.json',
  },
  vignetteBaseUrl: 'https://pub-85062da5f8a7451b9c168f8b3cfd980b.r2.dev/vignette/',
  multiSep: '§',
  noticeFieldsWhitelist: [
    '100', '101', '102', '105', '106', '140', '200', '210', '214', '215',
    '300', '303', '307', '316', '517', '610', '686', '700', '701', '702',
    '801', '902',
  ],
  // Seuil minimal de jointure notice — cf. build-inventory.mjs. Sur l'export
  // de référence, la jointure est de 100% ; un taux très inférieur signale
  // un mauvais export magasin ou un désherbage portant sur un autre périmètre.
  minJoinRate: 0.5,
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

function buildRecord(props, index, stats) {
  const barcode = (props['Code-barres (valeur)'] || '').trim();
  if (!barcode) return null;

  const noticeId = index.primaryItemToNotice.get(barcode);
  const noticeData = noticeId ? index.notices.get(noticeId) : null;
  if (noticeData) stats.joined++;
  else {
    stats.orphans++;
    if (stats.orphansSample.length < 20) stats.orphansSample.push(barcode);
  }

  const cotes = [props['Cote n° 1'], props['Cote n° 2'], props['Cote n° 3']].filter(Boolean);

  return {
    ...(noticeData || {}),
    _barcode: barcode,
    '995$f': barcode,
    lien_num: `${CONFIG.vignetteBaseUrl}${barcode}.jpg`,
    '930$g': props['Cote n° 1'] || null,
    '930$h': props['Cote n° 2'] || null,
    '930$i': props['Cote n° 3'] || null,
    coteAffichee: cotes.join(' ') || props['Cotes'] || null,
    // Titre/auteur/éditeur de repli si la jointure notice échoue — l'export
    // désherbage en porte une version minimale lui-même.
    titreDesherbage: props['Titre'] || null,
    titrePartie: props['Titre de partie et N° de partie'] || null,
    titreSerie: props['Titre de série'] || null,
    tome: props['Tome'] || null,
    auteurDesherbage: props['Auteur'] || null,
    editeurDesherbage: props['Editeur'] || null,
    isbn: props['ISBN'] || null,
    issn: props['ISSN'] || null,
    imagette: props['Imagette'] || null,
    bibliotheque: props['Bibliothèque (Libellé)'] || null,
    section: props['Section (Libellé)'] || null,
    etat: props['Etat  (Libellé)'] || null,
    typeDocument: props['Type de document (Libellé)'] || null,
    exclusionPret: props['Piège 921$a (Libellé)'] || null,
    prets: {
      an:  parseCount(props['Nombre de prêts AN']),
      an1: parseCount(props['Nombre de prêts AN-1']),
      an2: parseCount(props['Nombre de prêts AN-2']),
      an3: parseCount(props['Nombre de prêts AN-3']),
      cumules: parseCount(props['Nombre de prêts cumulés']),
    },
    reservations: {
      an:  parseCount(props['Nombre de réservations AN']),
      an1: parseCount(props['Nombre de réservations AN-1']),
      an2: parseCount(props['Nombre de réservations AN-2']),
      an3: parseCount(props['Nombre de réservations AN-3']),
      cumulees: parseCount(props['Nombre de réservations cumulées']),
    },
  };
}

// ── Récupération des XML depuis R2 ──────────────────────────────────────────
async function syncXmlFromR2() {
  if (!r2Configured()) {
    console.error(
      '✖ R2 non configuré : ce jeu de données (xml/desherbage/…) n\'a pas de ' +
      'repli local committé. Renseignez R2_ACCOUNT_ID, R2_BUCKET, ' +
      'R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY dans .env.'
    );
    process.exit(1);
  }
  console.log('  · récupération de xml/magasin/notices.xml.xml et xml/desherbage/desherbage.xml…');
  const targets = [
    { key: CONFIG.r2Keys.notices, local: CONFIG.input.notices },
    { key: CONFIG.r2Keys.desherbage, local: CONFIG.input.desherbage },
  ];
  for (const t of targets) {
    const obj = await r2Get(t.key);
    if (!obj) {
      console.error(`✖ ${t.key} absent de R2.`);
      process.exit(1);
    }
    mkdirSync(dirname(resolve(t.local)), { recursive: true });
    writeFileSync(t.local, obj.body, 'utf-8');
    console.log(`    → ${t.local} mis à jour depuis R2 (${(obj.body.length / 1e6).toFixed(1)} Mo)`);
  }
}

// ── Main ───────────────────────────────────────────────────────────────────
async function main() {
  const startedAt = Date.now();
  console.log('▶ build-desherbage: démarrage');

  const filesExist = existsSync(CONFIG.input.notices) && existsSync(CONFIG.input.desherbage);
  if (!filesExist || CONFIG.force) {
    await syncXmlFromR2();
  } else {
    console.log('  · fichiers locaux déjà présents (SYRACUSE_FORCE=1 pour forcer le re-téléchargement)');
  }

  console.log(`  · lecture ${CONFIG.input.notices}`);
  const noticesXml = readFileSync(CONFIG.input.notices, 'utf-8');
  console.log(`  · lecture ${CONFIG.input.desherbage}`);
  const desherbageXml = readFileSync(CONFIG.input.desherbage, 'utf-8');

  console.log('  · indexation des notices (xml/magasin/notices.xml.xml)');
  const index = indexNotices(noticesXml, { whitelist: CONFIG.noticeFieldsWhitelist, multiSep: CONFIG.multiSep });
  console.log(`     ${index.count} notices, ${index.primaryItemToNotice.size} liens $995$f`);

  console.log('  · lecture des exemplaires de désherbage et jointure');
  const stats = { total: 0, joined: 0, orphans: 0, orphansSample: [] };
  const items = [];
  for (const itemXml of iterateGesmarcItems(desherbageXml)) {
    stats.total++;
    const props = parseGesmarcItem(itemXml);
    const rec = buildRecord(props, index, stats);
    if (rec) items.push(rec);
  }
  console.log(`     ${stats.total} exemplaires ・ ${stats.joined} joints à une notice, ${stats.orphans} orphelins`);

  const joinRate = stats.total ? stats.joined / stats.total : 0;
  if (joinRate < CONFIG.minJoinRate && !CONFIG.force) {
    console.error(
      `✖ Taux de jointure catastrophique (${(joinRate * 100).toFixed(1)}% < ` +
      `${(CONFIG.minJoinRate * 100).toFixed(0)}%). SYRACUSE_FORCE=1 pour forcer quand même.`
    );
    process.exit(1);
  }

  mkdirSync(dirname(resolve(CONFIG.output.desherbage)), { recursive: true });
  /* Conteneur colonnaire plutôt qu'un tableau d'objets plats : les noms de
     champs cessent d'être répétés à chaque ligne et les colonnes à faible
     cardinalité passent en dictionnaire. Aucun champ ne disparaît — voir
     js/columnar.js et scripts/verify-columnar.mjs. Lu par rotobib.html / desherbage-stats.html. */
  const columnar = loadColumnar();
  writeFileSync(CONFIG.output.desherbage, JSON.stringify(columnar.encode(items)), 'utf-8');
  console.log(`  · écrit ${CONFIG.output.desherbage} (${items.length} entrées)`);

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
      notices: index.count,
      items: stats.total,
      joined: stats.joined,
      orphans: stats.orphans,
      referenceYear: CONFIG.referenceYear,
    },
    orphansSample: stats.orphansSample,
  };
  writeFileSync(CONFIG.output.report, JSON.stringify(report, null, 2), 'utf-8');
  console.log(`  · écrit ${CONFIG.output.report}`);

  const dur = ((Date.now() - startedAt) / 1000).toFixed(2);
  console.log(`✓ build-desherbage: terminé en ${dur}s`);
}

await main();
