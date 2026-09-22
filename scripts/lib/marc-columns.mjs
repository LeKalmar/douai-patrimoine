/**
 * marc-columns.mjs
 * ────────────────────────────────────────────────────────────────────────────
 * Liste des champs UNIMARC "significatifs" promus en colonnes SQL littérales
 * sur `notices`/`exemplaires`, nommées exactement comme le tag$sous-champ
 * MARC (ex. "200$a", "921$c") — pour transférer une valeur du XML Syracuse
 * directement dans sa cellule, sans renommage ni normalisation.
 *
 * "Significatif" = présent sur au moins 0,5% des lignes de l'export Syracuse
 * du 2026-09-22 (data/xml/ExportSyracuse_Notices_20260922_115155.xml,
 * 15 607 notices, seuil = 79 ; data/xml/ExportSyracuse_Exemplaire_20260922_115800.xml,
 * même volume) — calculé une fois par un script ponctuel (flatten() sans
 * liste blanche, comptage par clé), pas recalculé à chaque migration. Un
 * champ plus rare que ce seuil reste capturé SANS PERTE dans la colonne
 * `raw` (jsonb, flatten() complet — voir CLAUDE.md "Format des données et
 * performances") ; il n'a simplement pas sa propre colonne. Si un futur
 * export Syracuse fait apparaître un champ significatif absent d'ici, cette
 * liste et db/migrations/000x_*.sql doivent être mis à jour à la main —
 * aucun mécanisme de régénération automatique, cohérent avec le reste du
 * projet (migrations statiques, voir db-apply-schema.mjs).
 *
 * Deux exceptions volontaires au calcul par fréquence :
 * - `995$*` (notices) est EXCLU même si fréquent (995$f/995$k apparaissent
 *   sur la quasi-totalité des notices) : ce sont des champs d'EXEMPLAIRE
 *   (code-barre, cote) dupliqués dans l'export notices, moins précis que le
 *   vrai export exemplaires (915$b/930$g-i) — c'est d'ailleurs déjà le
 *   comportement de scripts/lib/reserve-index.mjs (buildItems() écrase
 *   `995$f` avec le code-barre de l'exemplaire, jamais celui de la notice).
 *   Ne jamais réintroduire de colonne "995$…" sur `notices`.
 * - `921$c` (exemplaires) est AJOUTÉ malgré une fréquence sous le seuil :
 *   sous-champ piège (note libre) déjà consommé ailleurs sous un autre nom
 *   (`exemplaires.piege_c_texte`) — porter aussi son nom littéral exact.
 *
 * Source unique partagée par la migration (db-migrate-reserve.mjs) et par le
 * schéma (db/migrations/0003_marc_literal_fields.sql, écrit à partir de
 * cette liste) : les deux ne peuvent pas diverger sur les noms de colonnes.
 * N'affecte QUE la source `reserve_marc` (export MARC-XML Syracuse) — les
 * exemplaires `bib_xml`/`excel_import` n'ont pas de structure tag$sous-champ
 * et continuent d'utiliser les colonnes renommées existantes
 * (titre, editeur_nom, cote_1…), inchangées.
 */

export const NOTICE_LITERAL_FIELDS = [
  '010$a', '010$b', '010$d', '010$z', '020$a', '020$b', '021$a', '021$b',
  '033$a', '035$5', '035$a', '035$z', '073$a', '100$a', '101$2', '101$a',
  '101$c', '102$a', '105$a', '106$a', '140$a', '141$a', '181$2', '181$6',
  '181$a', '181$b', '181$c', '182$2', '182$6', '182$a', '182$c', '183$2',
  '183$6', '183$a', '200$a', '200$b', '200$d', '200$e', '200$f', '200$g',
  '200$h', '200$i', '200$v', '205$a', '210$a', '210$b', '210$c', '210$d',
  '210$e', '210$f', '210$g', '210$h', '210$r', '210$s', '211$a', '214$a',
  '214$b', '214$c', '214$d', '214$r', '215$a', '215$c', '215$d', '215$e',
  '225$a', '225$e', '225$i', '225$v', '225$x', '300$a', '303$a', '305$a',
  '307$a', '310$a', '316$5', '316$a', '317$5', '317$a', '320$a', '321$a',
  '327$a', '330$2', '330$a', '345$a', '345$b', '410$3', '410$c', '410$d',
  '410$t', '410$v', '410$x', '454$t', '461$3', '461$t', '461$v', '464$a',
  '464$f', '464$t', '481$3', '481$t', '482$3', '482$5', '482$a', '482$b',
  '482$c', '482$t', '500$3', '500$a', '500$k', '500$m', '503$a', '503$j',
  '503$m', '503$n', '517$a', '600$2', '600$3', '600$a', '600$b', '600$c',
  '600$f', '600$x', '601$3', '601$a', '601$c', '601$x', '606$!', '606$2',
  '606$3', '606$a', '606$x', '606$y', '606$z', '607$2', '607$3', '607$a',
  '607$x', '607$z', '608$2', '608$3', '608$a', '620$3', '620$a', '620$d',
  '676$a', '676$v', '686$2', '686$a', '700$3', '700$4', '700$a', '700$b',
  '700$c', '700$f', '700$o', '701$3', '701$4', '701$a', '701$b', '701$c',
  '701$f', '701$o', '702$3', '702$4', '702$a', '702$b', '702$c', '702$d',
  '702$f', '702$o', '710$3', '710$4', '710$a', '710$c', '711$3', '711$4',
  '711$a', '712$3', '712$4', '712$a', '712$b', '712$c', '801$2', '801$a',
  '801$b', '801$c', '801$g', '801$h', '830$a', '856$u', '900$a', '901$a',
  '902$3', '902$a', '902$e', '917$a', '919$a', '940$a', '940$b', '940$s',
];

export const ITEM_LITERAL_FIELDS = [
  '202$a', '202$d', '316$a', '915$a', '915$b', '920$d', '920$e', '920$r',
  '920$s', '920$t', '920$u', '921$a', '921$b', '921$c', '930$b', '930$c',
  '930$d', '930$g', '930$h', '930$i',
];

// Nom de colonne SQL pour un champ "tag$code" (ex. "200$a" -> `"200$a"`) —
// le $ et l'amorce numérique rendent un identifiant non quoté invalide en
// SQL standard ; Postgres accepte n'importe quel caractère dans un
// identifiant entre guillemets doubles.
export function quoteCol(field) {
  return `"${field}"`;
}
