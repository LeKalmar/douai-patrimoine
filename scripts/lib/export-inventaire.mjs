/**
 * export-inventaire.mjs
 * ────────────────────────────────────────────────────────────────────────────
 * Reconstruit, depuis Postgres, exactement la même forme de ligne que
 * `data/inventaire.json` (voir scripts/lib/reserve-index.mjs `buildItems()`) —
 * un objet par exemplaire réserve, clés `<tag>$<code>` filtrées aux mêmes
 * listes blanches que `build-inventory.mjs`/`db-migrate-reserve.mjs`, plus
 * les champs dérivés `_noticeId`, `_piege`, `_langue`, `_typeDocument`,
 * `lien_num`, `995$f`, `_relies`.
 *
 * `db-migrate-reserve.mjs` a stocké, pour chaque notice/exemplaire, un
 * flatten COMPLET (sans liste blanche) dans la colonne `raw jsonb` — on
 * n'a donc pas besoin de reparser le XML : il suffit de refiltrer `raw` avec
 * les mêmes listes blanches qu'à l'origine, dans le même ordre de fusion
 * (`{...notice, ...exemplaire}`, l'exemplaire gagne en cas de collision —
 * seul le tag 316 est partagé par les deux listes).
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
 *
 * Depuis 2026-09-23, même traitement pour `_leader` (leader MARC brut, 0,55 Mo
 * sur l'export courant) et `_nonCatalogue` (drapeau posé par
 * build-non-catalogues.mjs, 0,21 Mo) : vérifié qu'aucune page ne les lit
 * (0 occurrence dans tout le projet hors scripts de build). Ils restent en
 * base — `notices_reserve.leader` d'un côté, `raw` de l'autre — donc rien
 * n'est perdu ; c'est uniquement le corps servi à chaque chargement de
 * `inventaire.html` qui cesse de les transporter (21,25 → 20,49 Mo avant
 * compression). Ajoutés à `ignoredKeys` de scripts/verify-json-parity.mjs,
 * exactement comme les deux clés ci-dessus.
 *
 * Depuis 2026-09-23, le tableau retourné inclut aussi le fonds Cartes
 * géographiques (425 documents `source='excel_import'`, absents de
 * Syracuse — voir scripts/db-migrate-fonds-car.mjs), transformés via
 * buildFondsCarRecord() (scripts/lib/fonds-car-record.mjs), et le fonds
 * Périodiques (registre au niveau titre, voir scripts/db-migrate-fonds-
 * periodiques.mjs), transformés via buildFondsPeriodiqueRecord()
 * (scripts/lib/fonds-periodiques-record.mjs — seules les lignes avec une
 * cote renseignée y survivent, comme pour les autres fonds non catalogués).
 * Ces deux fonds restent lus depuis `exemplaires`/`notices` (les tables
 * partagées bib_xml) — non concernés par la scission ci-dessous, volume
 * négligeable (607 lignes) au regard du problème qu'elle résout.
 *
 * Depuis 2026-09-23 également (voir db/migrations/0007_split_reserve_tables.sql
 * et 0008_reserve_non_catalogues.sql) : la réserve (source historique
 * `reserve_marc`) ET les pièces non cataloguées (Manuscrits/Robaut/Objets,
 * csv/inventaire.csv, ex-`source='excel_import'`, voir
 * scripts/db-migrate-non-catalogues.mjs) vivent désormais dans deux tables
 * dédiées, compactes, `notices_reserve`/`exemplaires_reserve` — séparées des
 * tables partagées `notices`/`exemplaires` (~285 000 lignes bib_xml/excel_import
 * Cartes/Périodiques), pour que cette requête ne touche plus jamais leurs
 * pages disque. Les deux catégories cohabitent dans `exemplaires_reserve`
 * mais restent distinguables sans colonne dédiée : `barcode` est TOUJOURS
 * renseigné pour la réserve (995$f) et TOUJOURS NULL pour les pièces non
 * cataloguées (jamais eu de code-barre) ; `source_ref` c'est l'inverse
 * (NULL pour la réserve, "csv-row-N" pour les pièces non cataloguées) — même
 * distinction que `barcode IS NOT NULL` employée plus bas.
 *
 * Contrairement à la réserve, une pièce non cataloguée n'a pas de vraie
 * notice MARC à rejoindre/filtrer : sa ligne `exemplaires_reserve.raw` EST
 * déjà la forme finale exacte du champ retourné (buildRecord() dans
 * scripts/db-migrate-non-catalogues.mjs a fait tout le travail à la
 * migration) — relue telle quelle, sans passer par filterByWhitelist().
 * `notices_reserve` gagne quand même une ligne minimale par pièce (FK
 * notice_id NOT NULL) mais son contenu n'est jamais relu ici. Remplace
 * l'ancien scripts/lib/export-non-catalogues.mjs (qui lisait encore
 * `exemplaires`/source='excel_import' avant cette migration) — devenu sans
 * consommateur depuis que js/inventaire-page.js ne fetch plus
 * data/non-catalogues.json séparément (fusionné ici).
 *
 * Seule fonction de la famille export-*.mjs branchée sur un endpoint HTTP
 * (api/inventaire.mjs) en plus du serveur local — d'où la connexion POOLÉE
 * plutôt qu'unpooled : plusieurs requêtes concurrentes (plusieurs postes du
 * réseau ouvrant inventaire.html en même temps) se partagent le pool au lieu
 * d'ouvrir chacune sa propre connexion. Les autres export-*.mjs restent en
 * unpooled tant qu'ils ne sont appelés que par un process Node local unique.
 */
import { getPool } from './pg.mjs';
import { langueLabelOf } from './langue-labels.mjs';
import { typeDocumentLabelOf } from './type-document-labels.mjs';
import { buildFondsCarRecord } from './fonds-car-record.mjs';
import { buildFondsPeriodiqueRecord, buildFondsPeriodique2Record } from './fonds-periodiques-record.mjs';

const VIGNETTE_BASE_URL = 'https://pub-85062da5f8a7451b9c168f8b3cfd980b.r2.dev/vignette/';

// Doit rester identique à CONFIG.itemFieldsWhitelist/noticeFieldsWhitelist de
// scripts/build-inventory.mjs et scripts/db-migrate-reserve.mjs. En Set (pas
// juste pour la forme) : filterByWhitelist() tourne 2× par ligne sur les
// ~15 600 exemplaires réserve, un `.includes()` sur un tableau aurait donc
// coûté une comparaison par entrée de liste blanche et par clé — mesuré comme
// une part significative des ~2 s de transformation JS de exportInventaire().
const ITEM_FIELDS_WHITELIST = new Set(['915', '920', '921', '922', '925', '926', '930', '201', '202', '316']);
const NOTICE_FIELDS_WHITELIST = new Set([
  '100', '101', '102', '105', '106', '140', '200', '210', '214', '215',
  '300', '303', '307', '316', '517', '610', '686', '700', '701', '702',
  '801', '902', '940',
]);

function filterByWhitelist(raw, whitelist) {
  const out = {};
  if (!raw) return out;
  for (const key of Object.keys(raw)) {
    const tag = key.split('$')[0];
    if (whitelist.has(tag)) out[key] = raw[key];
  }
  return out;
}

export async function exportInventaire() {
  const pool = getPool();

  // Les 5 requêtes ci-dessous sont indépendantes les unes des autres (aucune
  // ne lit le résultat d'une autre) — lancées en parallèle via Promise.all
  // plutôt qu'en série, un round-trip Postgres de moins à payer en cascade.
  // Seule la construction de `items` (plus bas) dépend à la fois de `rows` et
  // de `groupRows`.
  //
  // ORDER BY nécessaire sur la requête principale : sans lui, Postgres ne
  // garantit aucun ordre stable entre deux exécutions de la même requête —
  // api/inventaire.mjs calcule un ETag (hash du corps sérialisé) pour
  // permettre les 304, qui ne servirait jamais à rien si l'ordre des lignes
  // (et donc le hash) changeait à chaque appel alors que les données, elles,
  // n'ont pas bougé.
  const [
    { rows },
    { rows: groupRows },
    { rows: nonCatalogueRows },
    { rows: carRows },
    { rows: periodiqueRows },
    { rows: periodique2Rows },
  ] = await Promise.all([
    pool.query(`
      SELECT e.barcode, e.reliure_groupe_id, e.piege_label, e.raw AS item_raw,
             n.raw AS notice_raw, n.source_notice_id
      FROM exemplaires_reserve e
      JOIN notices_reserve n ON n.id = e.notice_id
      WHERE e.barcode IS NOT NULL
      ORDER BY e.id
    `),
    pool.query(`
      SELECT reliure_groupe_id, array_agg(barcode ORDER BY barcode) AS barcodes
      FROM exemplaires_reserve
      WHERE reliure_groupe_id IS NOT NULL AND barcode IS NOT NULL
      GROUP BY reliure_groupe_id
    `),
    // Pièces non cataloguées (Manuscrits/Robaut/Objets) — `raw` déjà dans sa
    // forme finale, voir le commentaire en tête de fichier.
    pool.query(
      `SELECT raw FROM exemplaires_reserve WHERE source_ref IS NOT NULL ORDER BY source_ref`
    ),
    pool.query(
      `SELECT raw FROM exemplaires WHERE source = 'excel_import' AND source_ref LIKE 'fonds-car-%' ORDER BY source_ref`
    ),
    pool.query(
      `SELECT raw FROM exemplaires WHERE source = 'excel_import' AND source_ref LIKE 'fonds-periodiques-%' ORDER BY source_ref`
    ),
    // "fonds-periodiques2-%" : nouvelles entrées de csv/periodiques2.csv sans
    // correspondance dans periodiques.csv (voir scripts/db-migrate-fonds-
    // periodiques.mjs) — forme brute différente (Titre/Cote/Date de
    // parution), transformée par buildFondsPeriodique2Record() plutôt que
    // buildFondsPeriodiqueRecord(). Le motif "fonds-periodiques-%" ci-dessus
    // ne les capture pas : "2" suit immédiatement "periodiques", jamais "-".
    pool.query(
      `SELECT raw FROM exemplaires WHERE source = 'excel_import' AND source_ref LIKE 'fonds-periodiques2-%' ORDER BY source_ref`
    ),
  ]);
  const siblingsByGroup = new Map(groupRows.map(r => [r.reliure_groupe_id, r.barcodes]));

  const items = rows.map(row => {
    const noticeFlat = filterByWhitelist(row.notice_raw, NOTICE_FIELDS_WHITELIST);
    const itemFlat = filterByWhitelist(row.item_raw, ITEM_FIELDS_WHITELIST);
    const merged = { ...noticeFlat, ...itemFlat };

    merged._noticeId = row.source_notice_id;
    // piegeLabelOf() (voir scripts/lib/piege-labels.mjs) renvoie null, jamais
    // undefined, quand il n'y a pas de piège — la clé _piege est donc
    // toujours présente dans data/inventaire.json (valeur null possible),
    // jamais absente. Reproduire cette présence, pas seulement la valeur.
    merged._piege = row.piege_label ?? null;
    merged._langue = langueLabelOf(merged['101$a']);
    merged._typeDocument = typeDocumentLabelOf(merged['920$t']);

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

  /* `_nonCatalogue` : drapeau de traçabilité posé à la migration, jamais lu
     par une page — retiré du corps servi (voir l'en-tête de ce fichier). Le
     `raw` stocké en base le garde. */
  const nonCatalogueItems = nonCatalogueRows.map(({ raw }) => {
    if (raw && raw._nonCatalogue !== undefined) {
      const { _nonCatalogue, ...rest } = raw;
      return rest;
    }
    return raw;
  });
  const carItems = carRows.map(r => buildFondsCarRecord(r.raw)).filter(Boolean);
  const periodiqueItems = periodiqueRows.map(r => buildFondsPeriodiqueRecord(r.raw)).filter(Boolean);
  const periodique2Items = periodique2Rows.map(r => buildFondsPeriodique2Record(r.raw)).filter(Boolean);

  return items.concat(nonCatalogueItems).concat(carItems).concat(periodiqueItems).concat(periodique2Items);
}
