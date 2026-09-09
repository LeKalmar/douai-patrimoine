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

import { createReadStream } from 'node:fs';
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

export function parseGesmarcItem(itemXml) {
  const props = {};
  const re = /<property\s+name="([^"]*)"[^>]*\svalue="([^"]*)"/g;
  let m;
  while ((m = re.exec(itemXml))) {
    props[decodeXml(m[1])] = decodeXml(m[2]);
  }
  return props;
}
