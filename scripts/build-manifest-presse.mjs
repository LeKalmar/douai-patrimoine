#!/usr/bin/env node
/**
 * npm run build:manifest-presse
 *
 * Indexe les scans de presse (titres D19/D23/D24 — Douai républicain,
 * Triboulet, Le Douaisien) dans js/manifest.json (une entrée "book" par
 * NUMÉRO — pas par année : demande explicite du 2026-09-23, cliquer un jour
 * dans le calendrier de js/inventaire.js ne doit montrer QUE les pages de
 * ce numéro-là, pas celles de toute l'année) et dans js/presse-index.json,
 * consommé par js/inventaire-page.js :
 *   { "D19": {
 *       "cover": "<url de la 1re page de la parution la plus ancienne>",
 *       "years": { "1895": { "10": { "13": "D19_1895_10_13", … }, "11": {…} }, … }
 *     }, … }
 * `years[année][mois][jour]` est le NOM du "book" (voir juste en dessous)
 * du numéro paru ce jour-là — sert à ouvrir la visionneuse dessus depuis le
 * calendrier de js/inventaire.js (bouton année → mois → jour), un "book"
 * par numéro ne contenant QUE ses propres pages, donc les flèches gauche/
 * droite de la visionneuse n'y feuillettent plus que ce numéro. `cover`
 * sert de vignette de la notice périodique dans l'inventaire (`lien_num`,
 * posé dans js/inventaire-page.js — ces notices n'en ont sinon aucune,
 * faute d'exemplaire physique associé). Voir scripts/lib/fonds-
 * periodiques-record.mjs, qui pose déjà `930$g` = "D19"/"D23"/"D24" pour
 * ces trois titres.
 *
 * Dans js/manifest.json, l'arborescence reste "Périodiques" → titre (D19/
 * D23/D24) → année → un "book" par numéro (nommé
 * "<code>_<année>_<MM>_<jour brut du dossier>", ex. "D19_1895_10_13" —
 * garde le dossier "année" pour la navigation manuelle dans
 * visionneuse.html hors calendrier, même si le calendrier ne s'en sert pas
 * (openDossierCible() cherche un "book" par son nom n'importe où dans
 * l'arbre, peu importe la profondeur).
 *
 * Arborescence sur disque (constatée le 2026-09-23, cf. dossier source) :
 *   <racine>/<TitreFolder>/<TitreFolder>_<année>/<TitreFolder>_<année>_<MM>_<JJ>/*.jpg
 * Reconnue par SUFFIXE de nom de dossier (`_D\d+`, `_\d{4}`, `_\d{2}_\d{2}`)
 * plutôt que par préfixe : le dossier D23 n'a pas le préfixe "FRB" que
 * portent D19/D24 ("591786101_D23_1872" vs "FRB591786101_D19_1895"), un
 * suffixe reste donc la seule reconnaissance fiable commune aux trois.
 *
 * Deux modes :
 *   --local (défaut)  chemins relatifs à /presse-local/ (voir scripts/
 *                      dev-server.mjs), qui sert PRESSE_SOURCE_DIR tel
 *                      quel en local — les scans ne sont PAS encore sur R2
 *                      (dépasserait le quota mensuel du compte, 115 Go/
 *                      14 263 images sur cette collecte), décision de
 *                      l'équipe le 2026-09-23. `root:"presse-local"` posé
 *                      sur chaque "book" pour que visionneuse.html résolve
 *                      ces pages contre PRESSE_LOCAL_ROOT plutôt que contre
 *                      IMAGES_ROOT (R2).
 *   --r2               chemins préfixés "presse/" (même convention que les
 *                      préfixes déjà utilisés dans le bucket R2 du reste du
 *                      manifeste, "num-ms/"/"num-robaut/"), sans `root` —
 *                      résolus contre IMAGES_ROOT comme le reste. À lancer
 *                      une fois les scans effectivement versés sur R2 sous
 *                      ce même préfixe "presse/" (même arborescence
 *                      relative qu'en local) : voir le commentaire au-dessus
 *                      de PRESSE_LOCAL_ROOT dans visionneuse.html.
 *
 * PRESSE_SOURCE_DIR (variable d'env, .env ou ligne de commande) permet de
 * pointer vers un autre chemin que celui constaté le 2026-09-23 — utile si
 * ce dossier OneDrive est déplacé/renommé.
 *
 * Aucune dépendance npm.
 */
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { loadDotEnv } from './lib/dotenv.mjs';

loadDotEnv();

const MODE = process.argv.includes('--r2') ? 'r2' : 'local';

const DEFAULT_SOURCE_DIR = 'C:\\Users\\mjeanjean\\OneDrive - VILLE DE DOUAI\\' +
  'Bibliothèque - Principal\\P  A  T  R  I  M  O  I  N  E\\3-Travail Interne\\' +
  'bib. num\\numerisation\\presse';
const SOURCE_DIR = process.env.PRESSE_SOURCE_DIR || DEFAULT_SOURCE_DIR;

const MOIS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet',
  'août', 'septembre', 'octobre', 'novembre', 'décembre'];

if (!existsSync(SOURCE_DIR)) {
  console.error(`Dossier source introuvable : ${SOURCE_DIR}`);
  console.error('Réglez PRESSE_SOURCE_DIR (.env) si ce dossier a été déplacé.');
  process.exit(1);
}

// "22(sic)" → jour 22, mention "(sic)" reprise telle quelle (date fautive sur
// l'original) ; "[sd]"/"[nd]" (sans jour numérique du tout) → pas de "j mois",
// juste "mois année ([sd])" — voir le commentaire sur `issues` plus bas.
function formatDateLabel(year, month, dayToken) {
  const monthName = MOIS[parseInt(month, 10) - 1] || month;
  const dayDigits = dayToken.match(/^\d{2}/);
  if (!dayDigits) return `${monthName} ${year} (${dayToken})`;
  const day = parseInt(dayDigits[0], 10);
  const rest = dayToken.slice(2);
  return `${day} ${monthName} ${year}${rest ? ' ' + rest : ''}`;
}

function listDirs(dir) {
  return readdirSync(dir, { withFileTypes: true })
    .filter(e => e.isDirectory())
    .map(e => e.name)
    .sort();
}

function listJpgs(dir) {
  return readdirSync(dir, { withFileTypes: true })
    .filter(e => e.isFile() && /\.jpe?g$/i.test(e.name))
    .map(e => e.name)
    .sort(); // suffixe page "_01"/"_02"… zero-paddé : tri lexicographique = tri numérique
}

const titleFolders = listDirs(SOURCE_DIR).filter(n => /_D\d+$/i.test(n));
if (!titleFolders.length) {
  console.error(`Aucun dossier de titre ("*_D<n>") trouvé sous ${SOURCE_DIR}`);
  process.exit(1);
}

// Même URL publique que IMAGES_ROOT dans visionneuse.html — dupliquée ici en
// constante plutôt que partagée : ce script Node et cette page navigateur ne
// partagent pas de module commun, et c'est une simple URL publique, pas un
// secret (voir CLAUDE.md, section "Stockage partagé").
const R2_IMAGES_ROOT = 'https://pub-85062da5f8a7451b9c168f8b3cfd980b.r2.dev/';
const COVER_ROOT = MODE === 'r2' ? R2_IMAGES_ROOT : '/presse-local/';

const titleNodes = [];
const index = {};
let totalPages = 0;

for (const titleFolder of titleFolders) {
  const code = 'D' + titleFolder.match(/_D(\d+)$/i)[1].toUpperCase();
  const titleDir = path.join(SOURCE_DIR, titleFolder);
  const yearFolders = listDirs(titleDir).filter(n => /_\d{4}$/.test(n));
  const yearNodes = []; // un dossier par année, contenant un "book" par numéro
  const calendar = {}; // { "1895": { "10": { "13": "D19_1895_10_13", … } }, … }
  let coverUrl = null; // 1re page de la parution la plus ancienne (yearFolders est déjà trié chronologiquement, voir listDirs())

  for (const yearFolder of yearFolders) {
    const year = yearFolder.match(/_(\d{4})$/)[1];
    const yearDir = path.join(titleDir, yearFolder);
    // Le jour n'est pas toujours "MM_JJ" strict : quelques dossiers portent une
    // annotation d'origine (constatée le 2026-09-23, ex. "…_1899_01_22(sic)" —
    // date fautive mais reproduite telle quelle sur le fac-similé — ou
    // "…_1910_04_[sd]"/"…_1923_10_[nd]", sans date lisible du tout). Le jour
    // reste donc "tout ce qui suit le dernier '_'", pas forcément 2 chiffres.
    const issues = listDirs(yearDir)
      .filter(n => /_\d{2}_[^_]+$/.test(n))
      .map(name => {
        const [, month, dayToken] = name.match(/_(\d{2})_([^_]+)$/);
        return { name, month, dayToken };
      })
      .sort((a, b) => {
        const dayNumA = (a.dayToken.match(/^\d{2}/) || ['99'])[0];
        const dayNumB = (b.dayToken.match(/^\d{2}/) || ['99'])[0];
        return (a.month + dayNumA).localeCompare(b.month + dayNumB);
      });

    const issueBooks = [];
    const yearCalendar = {};
    for (const issue of issues) {
      const issueDir = path.join(yearDir, issue.name);
      const files = listJpgs(issueDir);
      if (!files.length) continue;
      const dateLabel = formatDateLabel(year, issue.month, issue.dayToken);
      const pages = files.map((file, i) => {
        const relParts = [titleFolder, yearFolder, issue.name, file];
        const rel = (MODE === 'r2' ? 'presse/' : '') + relParts.join('/');
        return { name: `${dateLabel} — p. ${i + 1}`, path: rel };
      });
      if (!coverUrl) coverUrl = COVER_ROOT + pages[0].path;

      const bookName = `${code}_${year}_${issue.month}_${issue.dayToken}`;
      const book = { type: 'book', name: bookName };
      if (MODE === 'local') book.root = 'presse-local';
      book.pages = pages;
      issueBooks.push(book);

      // Case calendrier mois/jour (js/inventaire.js) — seulement si le
      // dossier porte un vrai numéro de jour ; "[sd]"/"[nd]" restent
      // ouvrables depuis l'arborescence de visionneuse.html mais n'ont pas
      // de case dans le calendrier (pas de jour à y placer).
      const dayDigits = issue.dayToken.match(/^\d{2}/);
      if (dayDigits) {
        const day = String(parseInt(dayDigits[0], 10));
        yearCalendar[issue.month] = yearCalendar[issue.month] || {};
        yearCalendar[issue.month][day] = bookName;
      }
    }

    if (!issueBooks.length) continue;
    yearNodes.push({ type: 'folder', name: year, children: issueBooks });
    calendar[year] = yearCalendar;
  }

  totalPages += yearNodes.reduce((sum, y) => sum + y.children.reduce((s, b) => s + b.pages.length, 0), 0);
  titleNodes.push({ type: 'folder', name: code, children: yearNodes });
  index[code] = { cover: coverUrl, years: calendar };
}

// ── Fusion dans js/manifest.json (remplace toute "Périodiques" existante —
//    idempotent, sûr à relancer après un nouveau lot de scans) ──
const manifestPath = path.join(process.cwd(), 'js', 'manifest.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
manifest.children = (manifest.children || []).filter(c => c.name !== 'Périodiques');
manifest.children.push({ type: 'folder', name: 'Périodiques', children: titleNodes });
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');

// ── js/presse-index.json — voir le commentaire d'en-tête pour la forme ──
const indexPath = path.join(process.cwd(), 'js', 'presse-index.json');
writeFileSync(indexPath, JSON.stringify(index, null, 2) + '\n', 'utf8');

console.log(`Mode : ${MODE}`);
console.log(`Source : ${SOURCE_DIR}`);
for (const code of Object.keys(index)) {
  const years = Object.keys(index[code].years).sort();
  console.log(`  ${code} : ${years.length} année(s) — ${years.join(', ')}`);
  console.log(`    couverture : ${index[code].cover}`);
}
console.log(`Total : ${totalPages} page(s) indexée(s) dans js/manifest.json`);
console.log(`Écrit : js/manifest.json, js/presse-index.json`);
if (MODE === 'local') {
  console.log(`\nPensez à lancer aussi le serveur de dev (npm run dev) : il sert`);
  console.log(`désormais /presse-local/ depuis PRESSE_SOURCE_DIR — voir scripts/dev-server.mjs.`);
}
