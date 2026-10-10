/**
 * gesmarc.mjs
 * ────────────────────────────────────────────────────────────────────────────
 * Parseur minimaliste du format "GESMARC" à plat utilisé par certains exports
 * Syracuse (statistiques de prêt pour Rotobib, export complet de la
 * bibliothèque `bib.xml`) : `<items><item type="GESMARC"><property
 * name="…" value="…" /></item></items>`, un `<item>` par exemplaire — pas du
 * MARC-XML (voir marc-xml.mjs pour ce format-là).
 *
 * Partagé entre scripts/build-desherbage.mjs, scripts/build-magasins.mjs et
 * scripts/build-cotes-numeriques.mjs.
 *
 * Aucune dépendance npm. Node ≥ 18.
 * ────────────────────────────────────────────────────────────────────────────
 */

import { createReadStream, existsSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { decodeXml } from './marc-xml.mjs';

const ITEM_OPEN = '<item type="GESMARC">';
const ITEM_CLOSE = '</item>';

export function* iterateGesmarcItems(xml) {
  const re = /<item\s+type="GESMARC">([\s\S]*?)<\/item>/g;
  let m;
  while ((m = re.exec(xml))) yield m[1];
}

/**
 * Variante en flux de iterateGesmarcItems(), pour un fichier trop volumineux
 * pour tenir dans une seule string JS (xml/bib.xml, 700+ Mo — au-delà de la
 * limite ~512 Mo d'une string V8, un readFileSync()/toString('utf8')
 * classique lève ERR_STRING_TOO_LONG). Lit le fichier par blocs, accumule
 * dans un tampon dont on retire au fur et à mesure les `<item>…</item>`
 * complets trouvés — la mémoire utilisée reste bornée à quelques blocs, pas
 * à la taille totale du fichier. `createReadStream` avec un `encoding`
 * décode chaque bloc via un StringDecoder interne (aucun risque de couper
 * un caractère UTF-8 multioctet en deux entre deux blocs).
 */
export async function* iterateGesmarcItemsFromFile(path, { highWaterMark = 16 * 1024 * 1024 } = {}) {
  const stream = createReadStream(path, { encoding: 'utf-8', highWaterMark });
  let buf = '';
  for await (const chunk of stream) {
    buf += chunk;
    let from = 0;
    while (true) {
      const start = buf.indexOf(ITEM_OPEN, from);
      if (start === -1) { from = Math.max(0, buf.length - ITEM_OPEN.length); break; }
      const end = buf.indexOf(ITEM_CLOSE, start);
      if (end === -1) { from = start; break; }
      yield buf.slice(start + ITEM_OPEN.length, end);
      from = end + ITEM_CLOSE.length;
    }
    buf = buf.slice(from);
  }
}

// Force une copie « à plat » d'une chaîne, indépendante de son support
// d'origine. Sans ça, une valeur de 3 caractères extraite par regex d'un
// `<item>` de ~9 Ko (bib.xml, export 2026-09-09) reste une V8 SlicedString :
// elle retient tout le bloc XML source tant qu'elle existe, même minuscule.
// Sur ~291 000 exemplaires accumulés dans un tableau (build-desherbage.mjs),
// ça a fait grimper le tas à plusieurs Go pour un résultat qui ne pèse
// réellement que quelques centaines de Mo — jusqu'à l'OOM. La concaténation
// force V8 à matérialiser une chaîne plate ; `.slice(1)` retire le caractère
// ajouté (idiome connu, pas de méthode dédiée en JS pour « détacher » une
// chaîne).
function flat(s) {
  return (' ' + s).slice(1);
}

export function parseGesmarcItem(itemXml) {
  const props = {};
  const re = /<property\s+name="([^"]*)"[^>]*\svalue="([^"]*)"/g;
  let m;
  while ((m = re.exec(itemXml))) {
    props[flat(decodeXml(m[1]))] = flat(decodeXml(m[2]));
  }
  return props;
}

// ── Exports partiels « exemplaires modifiés depuis » (data/xml/update/) ──────
//
// Entre deux bib.xml complets, l'équipe dépose dans data/xml/update/ un export
// Syracuse partiel, au même format GESMARC et avec les mêmes champs que
// bib.xml. iterateGesmarcItemsWithUpdates() le superpose à bib.xml pendant la
// lecture : un code-barre présent dans une mise à jour remplace l'exemplaire
// de bib.xml (cote, section, piège, prêts… — l'item entier), un code-barre
// inconnu de bib.xml est ajouté en fin de lecture. Rien n'est jamais
// supprimé : les exemplaires morts restent dans Syracuse, piégés (Pilon,
// Perdu…), et arrivent avec leur nouveau piège comme toute autre
// modification. Les fichiers sont appliqués par ordre de nom (le nom Syracuse
// porte l'horodatage, ExportSyracuse_Exemplaire_AAAAMMJJ_HHMMSS.xml) : le plus
// récent l'emporte. Ils deviennent obsolètes dès qu'un nouveau bib.xml
// complet est chargé — vider alors le dossier, sinon une ancienne mise à jour
// réécraserait des données plus fraîches.

export const UPDATE_DIR = 'data/xml/update';

const BARCODE_RE = /<property\s+name="Code-barres \(valeur\)"[^>]*\svalue="([^"]*)"/;

function barcodeOfItem(itemXml) {
  const m = BARCODE_RE.exec(itemXml);
  return m ? decodeXml(m[1]).trim() : '';
}

export function listUpdateFiles(dir = UPDATE_DIR) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter(f => f.toLowerCase().endsWith('.xml'))
    .sort()
    .map(f => join(dir, f));
}

/**
 * Comme iterateGesmarcItemsFromFile(basePath), avec les mises à jour de
 * `updatePaths` superposées (voir ci-dessus). `summary` (facultatif) est
 * rempli au fil de la lecture : fichiers appliqués, exemplaires remplacés,
 * ajoutés — à recopier dans le rapport de build.
 */
export async function* iterateGesmarcItemsWithUpdates(basePath, updatePaths = listUpdateFiles(), summary = {}) {
  const updates = new Map();
  summary.files = [];
  for (const path of updatePaths) {
    let items = 0;
    for await (const itemXml of iterateGesmarcItemsFromFile(path)) {
      const bc = barcodeOfItem(itemXml);
      if (!bc) continue;
      updates.set(bc, flat(itemXml));
      items++;
    }
    summary.files.push({ file: basename(path), items });
  }
  summary.replaced = 0;
  summary.added = 0;

  for await (const itemXml of iterateGesmarcItemsFromFile(basePath)) {
    if (updates.size) {
      const bc = barcodeOfItem(itemXml);
      const fresh = bc && updates.get(bc);
      if (fresh) {
        updates.delete(bc);
        summary.replaced++;
        yield fresh;
        continue;
      }
    }
    yield itemXml;
  }
  for (const itemXml of updates.values()) {
    summary.added++;
    yield itemXml;
  }
}

export function logUpdateSummary(summary) {
  if (!summary.files?.length) return;
  console.log(`  · mises à jour partielles appliquées (${UPDATE_DIR}) :`);
  for (const f of summary.files) console.log(`      - ${f.file} (${f.items} exemplaires)`);
  console.log(`    → ${summary.replaced} exemplaires de bib.xml remplacés, ${summary.added} ajoutés`);
}
