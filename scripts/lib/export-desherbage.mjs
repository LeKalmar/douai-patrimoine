/**
 * export-desherbage.mjs
 * ────────────────────────────────────────────────────────────────────────────
 * Reconstruit, depuis Postgres, la même forme colonnaire que
 * `data/desherbage.json` (voir scripts/build-desherbage.mjs) — depuis
 * `exemplaires.raw` (source='bib_xml'), exactement comme export-magasins.mjs
 * et export-cotes-numeriques.mjs : depuis le 2026-09-09, `build-desherbage.mjs`
 * ne lit plus un export Syracuse séparé (xml/desherbage/desherbage.xml,
 * obsolète) mais `bib.xml`, la même source que les deux autres — donc aucun
 * script de migration dédié n'est nécessaire, ni de colonnes typées
 * supplémentaires : `raw` porte déjà les compteurs de prêt/réservation par
 * année, comme tout le reste de ce que ce script extrait.
 *
 * Même écart connu que magasins/cotes-numeriques (voir export-magasins.mjs) :
 * les ~15 500 codes-barres déjà `source='reserve_marc'` sont absents des
 * lignes `bib_xml`, donc absents de cet export.
 */
import { getPool } from './pg.mjs';
import { loadColumnar } from './load-columnar.mjs';
import { magasinDigitRun, isMagasin, fondsLabel } from './magasin-classify.mjs';

const VIGNETTE_BASE_URL = 'https://pub-85062da5f8a7451b9c168f8b3cfd980b.r2.dev/vignette/';

function parseCount(v) {
  if (v === undefined || v === null || v === '') return 0;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : 0;
}

export async function exportDesherbage() {
  const pool = getPool({ unpooled: true });
  const { rows } = await pool.query(`SELECT raw FROM exemplaires WHERE source = 'bib_xml' AND bibliotheque_libelle LIKE 'Douai%'`);

  const items = rows.map(({ raw: props }) => {
    const barcode = (props['Code-barres (valeur)'] || '').trim();
    const bibliotheque = props['Bibliothèque (Libellé)'] || '';
    const section = props['Section (Libellé)'] || '';
    const piege = (props['Pièges'] || '').trim() || null;
    const magasin = isMagasin(section, piege);

    const cote1 = props['Cote n° 1'] || '';
    const cote2 = props['Cote n° 2'] || '';
    const cote3 = props['Cote n° 3'] || '';
    const coteJointe = [cote1, cote2, cote3].filter(Boolean).join(' ');
    const digitRun = magasinDigitRun(coteJointe);

    return {
      _barcode: barcode,
      '915$b': barcode,
      '930$g': cote1 || null,
      '930$h': cote2 || null,
      '930$i': cote3 || null,
      '200$a': props['Titre'] || null,
      '700$a': props['Auteur'] || null,
      '210$c': props['Editeur'] || null,
      '210$d': props['Publié le'] || null,
      lien_num: `${VIGNETTE_BASE_URL}${barcode}.jpg`,
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
      _piege: piege,
      coteAffichee: coteJointe || props['Cotes'] || null,
      _coteDigitRun: digitRun,
      _isMagasin: magasin,
      _fondsLabel: magasin ? fondsLabel(digitRun, section) : (section || 'Section inconnue'),
      prets: {
        an: parseCount(props['Nombre de prêts AN']),
        an1: parseCount(props['Nombre de prêts AN-1']),
        an2: parseCount(props['Nombre de prêts AN-2']),
        an3: parseCount(props['Nombre de prêts AN-3']),
        cumules: parseCount(props['Nombre de prêts cumulés']),
      },
      reservations: {
        an: parseCount(props['Nombre de réservations AN']),
        an1: parseCount(props['Nombre de réservations AN-1']),
        an2: parseCount(props['Nombre de réservations AN-2']),
        an3: parseCount(props['Nombre de réservations AN-3']),
        cumulees: parseCount(props['Nombre de réservations cumulées']),
      },
    };
  });

  const columnar = loadColumnar();
  return columnar.encode(items, {
    templates: [{ col: 'lien_num', from: '915$b', prefix: VIGNETTE_BASE_URL, suffix: '.jpg' }],
  });
}
