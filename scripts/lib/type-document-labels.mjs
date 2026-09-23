/**
 * type-document-labels.mjs
 * ────────────────────────────────────────────────────────────────────────────
 * Table des codes « Type de document » Syracuse (MARC 920$t, exemplaire —
 * distinct de 200$b, un champ NOTICE libre où le type de document n'est
 * qu'une variante de saisie parmi d'autres). Même patron que
 * scripts/lib/langue-labels.mjs (LANGUE_LABELS/langueLabelOf) : table JS =
 * source unique, mirée par la table de référence `types_document` en base
 * (voir db/migrations/0005_types_document.sql).
 *
 * Recensée exhaustivement (2026-09-23) depuis les couples structurés "Type de
 * document (Code)"/"Type de document (Libellé)" de xml/bib.xml (export
 * GESMARC complet de la bibliothèque, scripts/lib/gesmarc.mjs) — même table
 * de codes Syracuse que le champ 920$t de l'export MARC-XML réserve (vérifié :
 * les 13 codes distincts rencontrés sur les 15 607 exemplaires de
 * data/xml/exemplaires.xml — LIV, LIVA, REV, LCD, LAN, PER, CD, DVD, CAR, VIN,
 * LIVa, LDV, plus le cas "_" ci-dessous — sont tous couverts par cette même
 * table). Contrairement à 200$b (champ notice en texte libre : casse
 * flottante, accents cassés à l'export, coquilles, et vide sur 43% des
 * exemplaires de la réserve au 2026-09-23), 920$t est un code fermé, posé sur
 * 100% des exemplaires — remplace 200$b comme source du type de document
 * affiché (facette « Type » et badge de la notice repliée, js/inventaire-page.js).
 *
 * "LIVa" (72 occurrences sur la réserve, variante de casse de "LIVA") est
 * plié dessus par la recherche insensible à la casse de typeDocumentLabelOf()
 * plutôt que traité comme un code séparé — Syracuse lui-même ne lui associe
 * aucun libellé propre côté bib.xml (couple "LIVa"/"LIVa", visiblement une
 * coquille de saisie, jamais "Livre Artiste" avec cette casse précise).
 *
 * Aucune dépendance npm. Node ≥ 18.
 * ────────────────────────────────────────────────────────────────────────────
 */

export const TYPE_DOCUMENT_LABELS = {
  LIV:   'Livre',
  REV:   'Revue',
  LAN:   'Livre ancien',
  DVF:   'DVD Fiction',
  LCD:   'Livre CD',
  LIVA:  'Livre Artiste',
  CD:    'Disque compact',
  VIN:   'Vinyles',
  EXP:   "Outil d'animation",
  LCA:   'Livre cassette',
  LDV:   'Livre DVD',
  DVD:   'DVD',
  CAR:   'Carte',
  PER:   'Périodique',
  LCR:   'Livre CDROM',
  VHS:   'Vidéo Fiction',
  OBJ:   'Objets',
  CDR:   'Cédérom',
  JEU:   'Jeu de société',
  DVD12: 'DVD - interdit au moins de 12 ans',
  LIS:   'Liseuse',
};

/**
 * Traduit une valeur brute de 920$t en libellé lisible. Insensible à la
 * casse (voir "LIVa" ci-dessus). "_" et les valeurs vides sont un indicateur
 * Syracuse de champ non renseigné (rencontré une fois sur l'export du
 * 2026-09-23, sur un exemplaire dont le type n'a jamais été codé) — traités
 * comme une absence de valeur (null), pas comme un code à afficher tel quel.
 * Un vrai code absent de TYPE_DOCUMENT_LABELS (futur code Syracuse non encore
 * recensé ici) reste affiché tel quel plutôt que masqué, comme
 * langueLabelOf()/piegeLabelOf().
 *
 * @param {string|null|undefined} raw
 * @returns {string|null}
 */
export function typeDocumentLabelOf(raw) {
  const code = String(raw || '').trim();
  if (!code || code === '_') return null;
  return TYPE_DOCUMENT_LABELS[code.toUpperCase()] || code;
}
