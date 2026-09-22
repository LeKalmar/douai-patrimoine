#!/usr/bin/env node
/**
 * build-non-catalogues.mjs
 * ────────────────────────────────────────────────────────────────────────────
 * Construit `data/non-catalogues.json` (et son rapport de build) à partir de
 * `csv/inventaire.csv` — un registre au format UNIMARC (mêmes noms de champs
 * que `data/inventaire.json` : 200$a, 700$a, 210$d, 930$g…) mais qui couvre
 * des pièces qu'aucun export Syracuse ne connaît : `995$f` (code-barre) y est
 * vide pour ~10 000 lignes, faute de catalogage. Le plus gros contingent est
 * le fonds Manuscrits (9 160 pièces, 930$e = "Manuscrits") — totalement absent
 * de `data/inventaire.json` aujourd'hui (0 exemplaire 930$g commençant par
 * "MS", vérifié) puisque le pipeline `npm run build` ne lit que les exports
 * MARC-XML Syracuse. Viennent ensuite le fonds Robaut (822, 930$e = "Robaut",
 * cotes "RI-01-…" — des planches numérisées, voir plus bas) et un fonds
 * Objets/numismatique (62, 930$e = "Objets").
 *
 * Ce script ne touche PAS à `data/inventaire.json` ni au pipeline
 * `npm run build` (Syracuse MARC-XML) : `data/non-catalogues.json` est un
 * jeu de données séparé, fusionné côté client dans l'inventaire PUBLIC
 * uniquement (`js/inventaire-page.js`, même patron que
 * `fetchExemplairesManuelsAsCatalogRows()` pour les exemplaires créés via
 * exemplarisation.html) — ces pièces n'ont pas de code-barre, donc rien à
 * scanner : pas de fusion côté recolement.html/reserve.html.
 *
 * Champs retenus par ligne (ceux réellement renseignés sur ce sous-ensemble,
 * voir l'analyse ayant précédé ce script) :
 *   930$g  cote (obligatoire — sert de repli de titre si 200$a est vide, et
 *          toute ligne sans cote serait de toute façon masquée côté page
 *          publique, voir js/inventaire-page.js)
 *   200$a  titre (repli sur la cote si vide — ~46 % des Manuscrits n'ont
 *          jamais eu de titre individuel, seulement un numéro de registre)
 *   200$b  type de document — code court (MANU/IMP/ICO/NUMI/LIVA), traduit
 *          vers le même texte que Syracuse pour que normType()
 *          (js/inventaire-page.js) le regroupe avec les vrais exemplaires
 *          plutôt que d'ouvrir une valeur de facette dupliquée.
 *   700$a (nom) / 700$b (prénom) — retranscrits tels quels, séparément :
 *          vérifié que ce registre suit la même convention que Syracuse
 *          (ex. "Desbordes-Valmore" / "Marceline"), inutile de les combiner.
 *   210$d  date — le format "[11xx]"/"[12xx]" (siècle approximatif) déjà
 *          présent sur les manuscrits est nativement compris par
 *          parsePublicationDate()/dateMatchesFilter(), aucune conversion
 *          nécessaire.
 *   215$a/b/d, 101$a  description physique/langue — retranscrits tels quels.
 *   930$e_11 + 930$e_12 → 610$a (Sujets, déjà un DETAIL_COLS existant), en
 *          écartant les artefacts de tableur ("#CHAMP!", "#REF!").
 *   930$e  fonds déjà écrit en toutes lettres sur ce registre (fiable ici,
 *          contrairement aux exports Syracuse où le commentaire de
 *          getFondsFromCote() dans js/inventaire.js le dit "peu renseigné")
 *          → posé en `_fondsLabel`, même convention que `_fondsLabel` dans
 *          data/magasins.json (CLAUDE.md, "Reconnaissance de code-barre par
 *          un second catalogue") : js/inventaire-page.js doit le préférer à
 *          getFondsFromCote() quand il est présent.
 *   lien_num — pour le fonds Robaut, c'est déjà une URL R2 complète et
 *          valide (vérifié : les 822 lignes matchent le domaine R2 servant
 *          js/manifest.json, ex. "num-robaut/Boîte 1/B591786101_RI_01_020r_
 *          033.jpg" y figure tel quel) : on en dérive `_lienNumerise` (chemin
 *          décodé, sans le domaine) pour que la vignette ET le lien
 *          "Accéder au document numérisé" fonctionnent immédiatement, sans
 *          rien coder de plus côté page (mécanisme déjà générique depuis le
 *          2026-09-11). Les 3 lignes Manuscrits portant un `lien_num` du
 *          type "num_ms/Ms1721" sont volontairement IGNORÉES : ce chemin
 *          n'apparaît nulle part dans js/manifest.json et n'a pas
 *          d'extension de fichier — probablement un dossier à constituer
 *          plus tard, pas un fichier existant à lier maintenant.
 *
 * Pas de code-barre ⇒ pas de `995$f`/`915$b` posés : ces pièces ne doivent
 * jamais être prises pour un exemplaire scannable par le reste du site
 * (aucun code présent dans _hay ne dépend de ces champs de toute façon).
 *
 * Aucune dépendance npm (voir scripts/lib/csv.mjs). Source locale committée
 * (csv/inventaire.csv, 24,5 Mo) — pas de R2 impliqué ici.
 * ────────────────────────────────────────────────────────────────────────────
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parseCsvObjects } from './lib/csv.mjs';

const CONFIG = {
  input: 'csv/inventaire.csv',
  output: {
    data: 'data/non-catalogues.json',
    report: 'data/non-catalogues-build-report.json',
  },
};

// Même domaine que IMAGES_ROOT dans visionneuse.html / NUMERISE_IMAGES_ROOT
// dans exemplarisation.html — dupliqué ici comme partout ailleurs dans le
// projet (pas de module partagé pour cette constante à ce jour).
const IMAGES_ROOT = 'https://pub-85062da5f8a7451b9c168f8b3cfd980b.r2.dev/';

// 200$b arrive en code court sur ce registre — traduit vers le même texte
// que porterait un vrai export Syracuse, pour que normType()
// (js/inventaire-page.js) regroupe ces pièces avec les exemplaires catalogués
// plutôt que d'ouvrir une entrée de facette séparée ("Manu", "Ico"…).
const TYPE_LABELS = {
  MANU: 'Texte manuscrit',
  IMP: 'Texte imprimé',
  ICO: 'Image fixe',
  NUMI: 'Numismatique',
  LIVA: "Livre d'artiste",
};

// Artefacts de tableur rencontrés dans 930$e_11/930$e_12 — jamais une vraie
// valeur de sujet.
const SPREADSHEET_ERRORS = new Set(['#CHAMP!', '#REF!', '#N/A', '#VALEUR!', '#NOM?', '#NUL!', '#DIV/0!']);

function clean(v) {
  // Quelques champs (ex. certains titres Robaut) contiennent un saut de
  // ligne littéral — un champ CSV cité peut légalement en porter un.
  // Aplati en un simple espace pour un rendu de fiche cohérent.
  const s = (v || '').replace(/\s+/g, ' ').trim();
  if (!s || SPREADSHEET_ERRORS.has(s)) return '';
  return s;
}

function buildRecord(row, stats) {
  const cote = clean(row['930$g']);
  if (!cote) return null; // sans cote, de toute façon masqué côté page publique

  const titreBrut = clean(row['200$a']);
  const titre = titreBrut || cote;
  if (!titreBrut) stats.titreDeReplis++;

  // 700$a = nom, 700$b = prénom — vérifié sur ce registre (ex. "Desbordes-
  // Valmore" / "Marceline") : même convention que les exports Syracuse, donc
  // gardés séparés plutôt que combinés en une seule chaîne. buildRow()
  // n'affiche que 700$a (nom seul, cohérent avec un exemplaire catalogué
  // classique) ; buildExpandedContent() recompose "NOM Prénom" à partir des
  // deux pour le panneau de détail.
  const auteurNom = clean(row['700$a']) || null;
  const auteurPrenom = clean(row['700$b']) || null;

  const typeCode = clean(row['200$b']);
  const type = typeCode ? (TYPE_LABELS[typeCode.toUpperCase()] || typeCode) : null;

  const sujets = [clean(row['930$e_11']), clean(row['930$e_12'])].filter(Boolean).join(' ; ') || null;

  const fondsLabel = clean(row['930$e']) || null;

  const rec = {
    '930$g': cote,
    '200$a': titre,
    '200$b': type,
    '700$a': auteurNom,
    '700$b': auteurPrenom,
    '210$d': clean(row['210$d']) || null,
    '215$a': clean(row['215$a']) || null,
    '215$b': clean(row['215$b']) || null,
    '215$d': clean(row['215$d']) || null,
    '101$a': clean(row['101$a']) || null,
    '610$a': sujets,
    _fondsLabel: fondsLabel,
    _nonCatalogue: true,
  };

  const lienNum = clean(row['lien_num']);
  if (lienNum.startsWith(IMAGES_ROOT)) {
    rec.lien_num = lienNum;
    try {
      rec._lienNumerise = decodeURIComponent(lienNum.slice(IMAGES_ROOT.length));
      stats.numerises++;
    } catch {
      // chemin mal encodé : on garde la vignette (lien_num) sans lien visionneuse
    }
  }

  return rec;
}

function main() {
  const startedAt = Date.now();
  console.log('▶ build-non-catalogues: démarrage');

  if (!existsSync(CONFIG.input)) {
    console.error(`✖ ${CONFIG.input} introuvable.`);
    process.exit(1);
  }

  console.log(`  · lecture ${CONFIG.input}`);
  const text = readFileSync(CONFIG.input, 'utf-8');
  const rows = parseCsvObjects(text, { delimiter: ';' });
  console.log(`  · ${rows.length} lignes lues`);

  const stats = {
    totalRows: rows.length,
    dejaCatalogues: 0, // 995$f déjà renseigné : hors périmètre de ce script
    sansCote: 0,
    kept: 0,
    titreDeReplis: 0,
    numerises: 0,
    parFonds: {},
    parType: {},
  };

  const items = [];
  for (const row of rows) {
    if (clean(row['995$f'])) { stats.dejaCatalogues++; continue; }
    const rec = buildRecord(row, stats);
    if (!rec) { stats.sansCote++; continue; }
    items.push(rec);
    stats.kept++;
    const fondsKey = rec._fondsLabel || '(sans fonds)';
    stats.parFonds[fondsKey] = (stats.parFonds[fondsKey] || 0) + 1;
    const typeKey = rec['200$b'] || '(sans type)';
    stats.parType[typeKey] = (stats.parType[typeKey] || 0) + 1;
  }

  console.log(
    `  · ${stats.kept} pièces non cataloguées retenues ` +
    `(${stats.dejaCatalogues} déjà cataloguées ignorées, ${stats.sansCote} sans cote ignorées)`
  );
  console.log('  · par fonds :', stats.parFonds);

  if (stats.kept === 0) {
    console.error('✖ 0 pièce retenue — vérifier le format de csv/inventaire.csv.');
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
  console.log(`✓ build-non-catalogues: terminé en ${dur}s`);
}

main();
