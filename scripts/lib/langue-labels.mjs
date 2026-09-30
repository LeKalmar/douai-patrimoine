/**
 * langue-labels.mjs
 * ────────────────────────────────────────────────────────────────────────────
 * Table des codes de langue UNIMARC (champ 101$a, ISO 639-2/B — la variante
 * "bibliographique" de la norme, celle utilisée par Syracuse/UNIMARC), pour
 * traduire un code brut ("fre", "lat"…) en libellé français lisible dans la
 * modale de détail de `inventaire.html` — même patron que
 * scripts/lib/piege-labels.mjs (PIEGE_A_LABELS/PIEGE_B_LABELS) : table JS =
 * source unique, mirée par la table de référence `langues` en base (voir
 * db/migrations/0004_langues.sql) pour qui veut l'interroger en SQL.
 *
 * Recensée exhaustivement sur les valeurs distinctes de "101$a" dans
 * data/inventaire.json au 2026-09-22 (102 valeurs distinctes, dont beaucoup
 * de combinaisons multi-langues jointes par '§' — polyglottes, traductions
 * avec texte en regard…). Un code non couvert ici (variante non standard ou
 * probable erreur de saisie, ex. "esp"/"ner" rencontrés une seule fois
 * chacun — vraisemblablement une confusion avec "spa"/"dut", jamais confirmée)
 * reste affiché tel quel plutôt que traduit au hasard — voir langueLabelOf().
 *
 * Aucune dépendance npm. Node ≥ 18.
 * ────────────────────────────────────────────────────────────────────────────
 */

export const LANGUE_LABELS = {
  fre: 'Français',
  fro: 'Ancien français (842-ca. 1400)',
  frm: 'Moyen français (ca. 1400-1600)',
  lat: 'Latin',
  grc: 'Grec ancien (jusqu’à 1453)',
  gre: 'Grec moderne (après 1453)',
  eng: 'Anglais',
  ang: 'Vieil anglais (ca. 450-1100)',
  enm: 'Moyen anglais (1100-1500)',
  ger: 'Allemand',
  gmh: 'Moyen haut-allemand (ca. 1050-1500)',
  dut: 'Néerlandais',
  dum: 'Moyen néerlandais (ca. 1050-1350)',
  ita: 'Italien',
  spa: 'Espagnol',
  por: 'Portugais',
  cze: 'Tchèque',
  pol: 'Polonais',
  slo: 'Slovaque',
  hun: 'Hongrois',
  hrv: 'Croate',
  nor: 'Norvégien',
  dan: 'Danois',
  rus: 'Russe',
  kor: 'Coréen',
  chi: 'Chinois',
  jpn: 'Japonais',
  ara: 'Arabe',
  arc: 'Araméen',
  sam: 'Araméen samaritain',
  syr: 'Syriaque',
  heb: 'Hébreu',
  per: 'Persan',
  arm: 'Arménien',
  ben: 'Bengali',
  wln: 'Wallon',
  kab: 'Kabyle',
  oci: 'Occitan (après 1500)',
  roa: 'Langues romanes (autres)',
  // Codes techniques ISO 639-2, pas des langues à proprement parler.
  mul: 'Plusieurs langues',
  mis: 'Langue non codée',
  und: 'Indéterminée',
  // Variantes rencontrées dans l'export mais non standard — un catalogueur a
  // tapé le mot français ou un code non ISO au lieu du code UNIMARC attendu ;
  // traitées comme synonymes d'"indéterminée" plutôt que laissées brutes.
  xxx: 'Indéterminée',
  inconnu: 'Indéterminée',
};

/**
 * Traduit une valeur brute de "101$a" (un ou plusieurs codes 3 lettres
 * joints par '§', ex. "fre§lat" pour un texte bilingue) en libellé(s)
 * français lisibles, joints par ", " — même convention d'affichage que les
 * auteurs multiples (700$a/700$b) dans js/inventaire.js. Insensible à la
 * casse (l'export contient quelques valeurs "Fre"/"ANG"/"XXX"). Un code
 * inconnu de LANGUE_LABELS est affiché tel quel (jamais masqué), et les
 * doublons (ex. "fre§fre") ne sont comptés qu'une fois.
 *
 * @param {string|null|undefined} raw
 * @returns {string|null}
 */
export function langueLabelOf(raw) {
  if (!raw) return null;
  const codes = String(raw).split('§').map(s => s.trim()).filter(Boolean);
  const labels = [];
  const seen = new Set();
  for (const code of codes) {
    const label = LANGUE_LABELS[code.toLowerCase()] || code;
    if (!seen.has(label)) {
      seen.add(label);
      labels.push(label);
    }
  }
  return labels.length ? labels.join(', ') : null;
}
