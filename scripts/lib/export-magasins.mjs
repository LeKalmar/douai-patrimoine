/**
 * export-magasins.mjs
 * ────────────────────────────────────────────────────────────────────────────
 * Reconstruit, depuis Postgres, la même forme colonnaire que
 * `data/magasins.json` (voir scripts/build-magasins.mjs) — réutilise
 * `scripts/lib/magasin-classify.mjs` telle quelle (mêmes règles de
 * classification magasin/étage, jamais réimplémentées ici) et encode avec
 * `js/columnar.js` (même code que les pages qui décodent, via
 * scripts/lib/load-columnar.mjs).
 *
 * Source : `exemplaires.raw` pour les lignes `source='bib_xml'` contient le
 * flatten GESMARC COMPLET (`JSON.stringify(props)`, posé par
 * db-migrate-bib.mjs) — les mêmes clés que `build-magasins.mjs` lit
 * directement sur `bib.xml` (`'Cote n° 1'`, `'Bibliothèque (Libellé)'`,
 * `'Section (Libellé)'`, `'Pièges'`, `'Publié le'`…), donc pas besoin de
 * reparser le XML.
 *
 * ÉCART CONNU ET DOCUMENTÉ (pas une divergence silencieuse) : `data/
 * magasins.json` (généré en lisant bib.xml directement) contient une entrée
 * pour CHAQUE exemplaire Douai de bib.xml, y compris ceux dont le code-barre
 * appartient aussi à la réserve (~15 500 sur l'export de référence) — utile
 * à `recolement.html` pour détecter une anomalie de classement même sur un
 * document par ailleurs déjà catalogué côté réserve. `db-migrate-bib.mjs`,
 * lui, n'insère JAMAIS ces lignes en `source='bib_xml'` (la réserve reste
 * seule autorité sur ce code-barre, voir son ON CONFLICT ... WHERE
 * exemplaires.source='bib_xml') — leur forme GESMARC d'origine (Section,
 * Bibliothèque, Pièges tels que vus depuis bib.xml) n'est donc conservée
 * nulle part en base. Cet export ne peut donc PAS reproduire ces ~15 500
 * lignes précises ; scripts/verify-json-parity.mjs les exclut explicitement
 * de la comparaison plutôt que de les compter à tort comme un écart.
 */
import { getPool } from './pg.mjs';
import { loadColumnar } from './load-columnar.mjs';
import { MAGASIN_SECTIONS, magasinDigitRun, isPiegeEnReserve, fondsLabel } from './magasin-classify.mjs';

const VIGNETTE_BASE_URL = 'https://pub-85062da5f8a7451b9c168f8b3cfd980b.r2.dev/vignette/';

export async function exportMagasins() {
  const pool = getPool({ unpooled: true });
  const { rows } = await pool.query(`
    SELECT raw FROM exemplaires WHERE source = 'bib_xml'
  `);

  const items = rows.map(({ raw: props }) => {
    const bibliotheque = props['Bibliothèque (Libellé)'] || '';
    const section = props['Section (Libellé)'] || '';
    const barcode = (props['Code-barres (valeur)'] || '').trim();
    const piege = (props['Pièges'] || '').trim() || null;
    const isMag = MAGASIN_SECTIONS.includes(section) || isPiegeEnReserve(piege);

    const cote1 = props['Cote n° 1'] || '';
    const cote2 = props['Cote n° 2'] || '';
    const cote3 = props['Cote n° 3'] || '';
    const coteJointe = [cote1, cote2, cote3].filter(Boolean).join(' ');
    const digitRun = magasinDigitRun(coteJointe);

    return {
      '930$g': cote1 || null,
      '930$h': cote2 || null,
      '930$i': cote3 || null,
      '915$b': barcode,
      '200$a': props['Titre'] || null,
      '700$a': props['Auteur'] || null,
      '210$c': props['Editeur'] || null,
      '210$d': props['Publié le'] || null,
      lien_num: `${VIGNETTE_BASE_URL}${barcode}.jpg`,
      _coteDigitRun: digitRun,
      _isMagasin: isMag,
      _secteur: section,
      _bibliotheque: bibliotheque,
      _piege: piege,
      _fondsLabel: isMag ? fondsLabel(digitRun, section) : (section || 'Section inconnue'),
    };
  });

  const columnar = loadColumnar();
  return columnar.encode(items, {
    templates: [{ col: 'lien_num', from: '915$b', prefix: VIGNETTE_BASE_URL, suffix: '.jpg' }],
  });
}
