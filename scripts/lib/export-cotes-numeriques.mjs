/**
 * export-cotes-numeriques.mjs
 * ────────────────────────────────────────────────────────────────────────────
 * Reconstruit, depuis Postgres, la même forme colonnaire que
 * `data/cotes-numeriques.json` (voir scripts/build-cotes-numeriques.mjs),
 * depuis `exemplaires.raw` (source='bib_xml', flatten GESMARC complet posé
 * par db-migrate-bib.mjs — voir export-magasins.mjs pour le détail et le même
 * écart connu concernant les ~15 500 codes-barres déjà réserve, absents des
 * lignes `bib_xml`).
 *
 * `numericLocDigitRun()` ci-dessous est une copie VERBATIM de la fonction
 * privée du même nom dans scripts/build-cotes-numeriques.mjs — volontairement
 * dupliquée plutôt qu'importée : ce fichier exécute un `await main()` en
 * effet de bord au chargement du module (même raison que les listes blanches
 * dupliquées dans scripts/db-migrate-reserve.mjs). À maintenir manuellement
 * en phase si la règle change (elle est volontairement plus stricte que
 * `magasinDigitRun()` de magasin-classify.mjs — voir CLAUDE.md).
 */
import { getPool } from './pg.mjs';
import { loadColumnar } from './load-columnar.mjs';

function numericLocDigitRun(cote) {
  if (!cote) return null;
  if (/^d\s?\d/i.test(cote)) return null;
  const merged = cote.replace(/(?<!\d)(\d{1,2})\.(\d{3})(?!\d)/g, '$1$2');
  const runs = merged.match(/\d+/g) || [];
  for (let run of runs) {
    if (run.length === 7 && run[0] === '0') run = run.slice(1);
    if ((run.length === 5 || run.length === 6) && run[0] === '1') return run;
  }
  return null;
}

export async function exportCotesNumeriques() {
  const pool = getPool({ unpooled: true });
  const { rows } = await pool.query(`
    SELECT raw FROM exemplaires WHERE source = 'bib_xml' AND bibliotheque_libelle LIKE 'Douai%'
  `);

  const items = [];
  for (const { raw: props } of rows) {
    const cote1 = props['Cote n° 1'] || '';
    const cote2 = props['Cote n° 2'] || '';
    const cote3 = props['Cote n° 3'] || '';
    const coteJointe = [cote1, cote2, cote3].filter(Boolean).join(' ');
    const digitRun = numericLocDigitRun(coteJointe);
    if (!digitRun) continue;

    items.push({
      '930$g': cote1 || null,
      '930$h': cote2 || null,
      '930$i': cote3 || null,
      '915$b': (props['Code-barres (valeur)'] || '').trim() || null,
      '200$a': props['Titre'] || null,
      '700$a': props['Auteur'] || null,
      '210$c': props['Editeur'] || null,
      '210$d': props['Publié le'] || null,
      _coteDigitRun: digitRun,
      _bibliotheque: props['Bibliothèque (Libellé)'] || '',
      _section: props['Section (Libellé)'] || null,
    });
  }

  const columnar = loadColumnar();
  return columnar.encode(items);
}
