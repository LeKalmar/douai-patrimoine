/**
 * export-inventaire.mjs
 * ────────────────────────────────────────────────────────────────────────────
 * Reconstruit, depuis Postgres, exactement la même forme de ligne que
 * `data/inventaire.json` (voir scripts/lib/reserve-index.mjs `buildItems()`) —
 * un objet par exemplaire réserve, clés `<tag>$<code>` filtrées aux mêmes
 * listes blanches que `build-inventory.mjs`/`db-migrate-reserve.mjs`, plus
 * les champs dérivés `_noticeId`, `_leader`, `_piege`, `_langue`, `lien_num`,
 * `995$f`, `_relies`.
 *
 * `db-migrate-reserve.mjs` a stocké, pour chaque notice/exemplaire, un
 * flatten COMPLET (sans liste blanche) dans la colonne `raw jsonb` — on
 * n'a donc pas besoin de reparser le XML : il suffit de refiltrer `raw` avec
 * les mêmes listes blanches qu'à l'origine, dans le même ordre de fusion
 * (`{...notice, ...exemplaire}`, l'exemplaire gagne en cas de collision —
 * seul le tag 316 est partagé par les deux listes). `_leader` n'est PAS dans
 * `raw` (flatten() ne traite que les datafields, pas le leader MARC) — repris
 * depuis la colonne dédiée `notices.leader`.
 *
 * `_relies` (autres codes-barres du même groupe de reliure) : le contenu est
 * identique à l'original mais PAS l'ordre — celui-ci vient ici d'un
 * `array_agg(... ORDER BY barcode)` SQL plutôt que de l'ordre d'itération
 * d'un Union-Find en mémoire ; sans signification fonctionnelle (voir
 * scripts/verify-json-parity.mjs, qui compare ce champ comme un ensemble).
 *
 * Champs volontairement NON reproduits : `_itemId` (control field MARC 001
 * de l'exemplaire) et `_joinType` — présents dans data/inventaire.json mais
 * jamais lus par aucune page (vérifié : aucune occurrence dans js/inventaire.js
 * ni js/inventaire-page.js), et non stockés en base pour les lignes
 * `reserve_marc` (seules les lignes `bib_xml` ont un `source_ref`). Un
 * scripts/verify-json-parity.mjs qui les comparerait échouerait donc à tort
 * sur ces deux clés précises — à exclure explicitement de la comparaison,
 * pas une divergence de données réelle.
 */
import { getPool } from './pg.mjs';
import { langueLabelOf } from './langue-labels.mjs';

const VIGNETTE_BASE_URL = 'https://pub-85062da5f8a7451b9c168f8b3cfd980b.r2.dev/vignette/';

// Doit rester identique à CONFIG.itemFieldsWhitelist/noticeFieldsWhitelist de
// scripts/build-inventory.mjs et scripts/db-migrate-reserve.mjs.
const ITEM_FIELDS_WHITELIST = ['915', '920', '921', '922', '925', '926', '930', '201', '202', '316'];
const NOTICE_FIELDS_WHITELIST = [
  '100', '101', '102', '105', '106', '140', '200', '210', '214', '215',
  '300', '303', '307', '316', '517', '610', '686', '700', '701', '702',
  '801', '902', '940',
];

function filterByWhitelist(raw, whitelist) {
  const out = {};
  if (!raw) return out;
  for (const key of Object.keys(raw)) {
    const tag = key.split('$')[0];
    if (whitelist.includes(tag)) out[key] = raw[key];
  }
  return out;
}

export async function exportInventaire() {
  const pool = getPool({ unpooled: true });

  const { rows } = await pool.query(`
    SELECT e.barcode, e.reliure_groupe_id, e.piege_label, e.raw AS item_raw,
           n.raw AS notice_raw, n.source_notice_id, n.leader
    FROM exemplaires e
    JOIN notices n ON n.id = e.notice_id
    WHERE e.source = 'reserve_marc'
  `);

  const { rows: groupRows } = await pool.query(`
    SELECT reliure_groupe_id, array_agg(barcode ORDER BY barcode) AS barcodes
    FROM exemplaires
    WHERE reliure_groupe_id IS NOT NULL AND source = 'reserve_marc' AND barcode IS NOT NULL
    GROUP BY reliure_groupe_id
  `);
  const siblingsByGroup = new Map(groupRows.map(r => [r.reliure_groupe_id, r.barcodes]));

  const items = rows.map(row => {
    const noticeFlat = filterByWhitelist(row.notice_raw, NOTICE_FIELDS_WHITELIST);
    const itemFlat = filterByWhitelist(row.item_raw, ITEM_FIELDS_WHITELIST);
    const merged = { ...noticeFlat, ...itemFlat };

    merged._noticeId = row.source_notice_id;
    if (row.leader) merged._leader = row.leader;
    // piegeLabelOf() (voir scripts/lib/piege-labels.mjs) renvoie null, jamais
    // undefined, quand il n'y a pas de piège — la clé _piege est donc
    // toujours présente dans data/inventaire.json (valeur null possible),
    // jamais absente. Reproduire cette présence, pas seulement la valeur.
    merged._piege = row.piege_label ?? null;
    merged._langue = langueLabelOf(merged['101$a']);

    if (row.barcode) {
      merged.lien_num = `${VIGNETTE_BASE_URL}${row.barcode}.jpg`;
      merged['995$f'] = row.barcode;
      if (row.reliure_groupe_id) {
        const siblings = (siblingsByGroup.get(row.reliure_groupe_id) || []).filter(bc => bc !== row.barcode);
        if (siblings.length) merged._relies = siblings;
      }
    }

    return merged;
  });

  return items;
}
