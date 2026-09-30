#!/usr/bin/env node
/**
 * npm run build:manifest-presse
 *
 * Indexe les scans de presse déposés sur R2 sous le préfixe `presse/`
 * (titres D19/D23/D24 — Douai républicain, Le Triboulet, Le Douaisien) dans
 * js/manifest.json (une entrée "book" par NUMÉRO) et dans
 * js/presse-index.json, consommé par js/inventaire-page.js :
 *   { "D24": {
 *       "cover": "<url de la 1re page de la parution la plus ancienne>",
 *       "years": { "1878": { "01": { "6": "D24_1878_01_06", … }, … }, … }
 *     }, … }
 * `years[année][mois][jour]` est le NOM du "book" du numéro paru ce jour-là —
 * le calendrier année → mois → jour de la fiche (buildPresseCalendar() dans
 * js/inventaire.js) ouvre la visionneuse dessus. Un "book" ne contient QUE
 * les pages de son numéro : les flèches de la visionneuse n'y feuillettent
 * que ce numéro. `cover` devient la vignette (`lien_num`) de la notice
 * périodique, qui n'en a sinon aucune (js/inventaire-page.js).
 *
 * Dans js/manifest.json : "Périodiques" → titre (D23/D24…) → année → un
 * "book" par numéro, nommé "<code>_<année>_<MM>_<jour brut du dossier>"
 * (ex. "D24_1878_01_06"). Chemins "presse/…", résolus contre IMAGES_ROOT dans
 * visionneuse.html comme le reste du manifeste.
 *
 * ── Différence avec la branche local-server ─────────────────────────────
 * Là-bas, ce script parcourt le dossier local des scans (OneDrive), et son
 * mode `--r2` suppose que TOUT ce dossier a été versé sur R2. Ici la source
 * est la liste réelle des objets R2 (r2ListAll(), lib/r2.mjs) : seuls les
 * titres/numéros/pages effectivement envoyés apparaissent dans le calendrier
 * — l'équipe n'envoie qu'une partie de la collecte (115 Go au total, au-delà
 * du quota mensuel du compte), un titre non versé (D19 au 2026-09-30) est
 * donc simplement absent, sans jamais produire de lien mort. Même forme de
 * sortie qu'en local-server : aucune différence côté page ou visionneuse.
 *
 * Arborescence attendue sous `presse/` (identique au rangement local) :
 *   presse/<TitreFolder>/<TitreFolder>_<année>/<TitreFolder>_<année>_<MM>_<JJ>/*.jpg
 * Reconnue par SUFFIXE (`_D\d+`, `_\d{4}`, `_\d{2}_<jour>`) plutôt que par
 * préfixe : le dossier D23 n'a pas le préfixe "FRB" de D19/D24
 * ("591786101_D23_1872" vs "FRB591786101_D24_1878").
 *
 * À relancer après chaque envoi de scans (idempotent : remplace la branche
 * "Périodiques" du manifeste), puis committer js/manifest.json et
 * js/presse-index.json. Un envoi encore en cours donne un numéro aux pages
 * incomplètes : attendre la fin de l'envoi avant de lancer.
 *
 * Variables R2 requises (.env) : voir lib/r2.mjs. Aucune dépendance npm.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { loadDotEnv } from './lib/dotenv.mjs';
import { r2ListAll } from '../lib/r2.mjs';

loadDotEnv();

const PREFIX = 'presse/';
// Même URL publique que IMAGES_ROOT dans visionneuse.html (simple URL
// publique, dupliquée comme ailleurs dans le projet).
const R2_IMAGES_ROOT = 'https://pub-85062da5f8a7451b9c168f8b3cfd980b.r2.dev/';

const MOIS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet',
  'août', 'septembre', 'octobre', 'novembre', 'décembre'];

// "22(sic)" → jour 22, mention "(sic)" reprise telle quelle (date fautive sur
// l'original) ; "[sd]"/"[nd]" (sans jour numérique du tout) → pas de "j mois",
// juste "mois année ([sd])".
function formatDateLabel(year, month, dayToken) {
  const monthName = MOIS[parseInt(month, 10) - 1] || month;
  const dayDigits = dayToken.match(/^\d{2}/);
  if (!dayDigits) return `${monthName} ${year} (${dayToken})`;
  const day = parseInt(dayDigits[0], 10);
  const rest = dayToken.slice(2);
  return `${day} ${monthName} ${year}${rest ? ' ' + rest : ''}`;
}

// Arbre titre → année → numéro → [fichiers], construit depuis les clés R2.
// Les objets "dossier" (clé terminée par "/", taille 0, créés par l'outil
// d'envoi) et tout fichier hors de cette arborescence sont ignorés.
function buildTree(keys) {
  const tree = new Map();
  let ignored = 0;
  for (const key of keys) {
    const parts = key.slice(PREFIX.length).split('/');
    if (parts.length !== 4 || !/\.jpe?g$/i.test(parts[3])) {
      if (!key.endsWith('/')) ignored++;
      continue;
    }
    const [titleFolder, yearFolder, issueFolder, file] = parts;
    if (!/_D\d+$/i.test(titleFolder) || !/_\d{4}$/.test(yearFolder) || !/_\d{2}_[^_]+$/.test(issueFolder)) {
      ignored++;
      continue;
    }
    if (!tree.has(titleFolder)) tree.set(titleFolder, new Map());
    const years = tree.get(titleFolder);
    if (!years.has(yearFolder)) years.set(yearFolder, new Map());
    const issues = years.get(yearFolder);
    if (!issues.has(issueFolder)) issues.set(issueFolder, []);
    issues.get(issueFolder).push(file);
  }
  return { tree, ignored };
}

async function main() {
  console.log(`▶ build-manifest-presse : liste de ${PREFIX} sur R2…`);
  const objects = await r2ListAll(PREFIX);
  const { tree, ignored } = buildTree(objects.map(o => o.key));
  if (!tree.size) {
    console.error(`✖ Aucun dossier de titre ("*_D<n>") trouvé sous ${PREFIX} — rien à indexer.`);
    process.exit(1);
  }

  const titleNodes = [];
  const index = {};
  let totalPages = 0;

  const sortedKeys = m => [...m.keys()].sort();
  for (const titleFolder of sortedKeys(tree)) {
    const code = 'D' + titleFolder.match(/_D(\d+)$/i)[1];
    const years = tree.get(titleFolder);
    const yearNodes = [];
    const calendar = {};
    let coverUrl = null; // 1re page de la parution la plus ancienne

    for (const yearFolder of sortedKeys(years)) {
      const year = yearFolder.match(/_(\d{4})$/)[1];
      // Le jour n'est pas toujours "MM_JJ" strict (ex. "…_22(sic)",
      // "…_[sd]") : c'est tout ce qui suit le dernier "_".
      const issues = [...years.get(yearFolder).keys()]
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
        // Suffixe de page "_01"/"_02"… zéro-paddé : tri lexicographique = tri numérique.
        const files = years.get(yearFolder).get(issue.name).sort();
        const dateLabel = formatDateLabel(year, issue.month, issue.dayToken);
        const pages = files.map((file, i) => ({
          name: `${dateLabel} — p. ${i + 1}`,
          path: PREFIX + [titleFolder, yearFolder, issue.name, file].join('/'),
        }));
        if (!coverUrl) coverUrl = R2_IMAGES_ROOT + pages[0].path;

        const bookName = `${code}_${year}_${issue.month}_${issue.dayToken}`;
        issueBooks.push({ type: 'book', name: bookName, pages });
        totalPages += pages.length;

        // Case du calendrier seulement pour un vrai numéro de jour ;
        // "[sd]"/"[nd]" restent ouvrables depuis l'arborescence de
        // visionneuse.html mais n'ont pas de case (pas de jour où les placer).
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

    titleNodes.push({ type: 'folder', name: code, children: yearNodes });
    index[code] = { cover: coverUrl, years: calendar };
  }

  // ── Fusion dans js/manifest.json (remplace toute branche "Périodiques"
  //    existante — idempotent, sûr à relancer après un nouvel envoi) ──
  const manifestPath = path.join(process.cwd(), 'js', 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  manifest.children = (manifest.children || []).filter(c => c.name !== 'Périodiques');
  manifest.children.push({ type: 'folder', name: 'Périodiques', children: titleNodes });
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');

  const indexPath = path.join(process.cwd(), 'js', 'presse-index.json');
  writeFileSync(indexPath, JSON.stringify(index, null, 2) + '\n', 'utf8');

  console.log(`  · ${objects.length} objet(s) R2 lus${ignored ? `, ${ignored} fichier(s) hors arborescence ignoré(s)` : ''}`);
  for (const code of Object.keys(index)) {
    const years = Object.keys(index[code].years).sort();
    const numeros = Object.values(index[code].years)
      .reduce((n, months) => n + Object.values(months).reduce((m, days) => m + Object.keys(days).length, 0), 0);
    console.log(`  · ${code} : ${numeros} numéro(s) sur ${years.length} année(s) — ${years.join(', ')}`);
  }
  console.log(`  · total : ${totalPages} page(s) indexée(s)`);
  console.log('✓ écrit js/manifest.json, js/presse-index.json');
}

main().catch(err => {
  console.error('✖', err.message);
  process.exit(1);
});
