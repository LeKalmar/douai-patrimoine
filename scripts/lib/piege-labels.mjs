/**
 * piege-labels.mjs
 * ────────────────────────────────────────────────────────────────────────────
 * Table des codes « Piège » Syracuse (MARC 921$a/921$b), extraite de
 * scripts/build-inventory.mjs (2026-09-09) pour être réutilisable par la
 * migration SQL (scripts/db-migrate-reserve.mjs) sans dupliquer la table à un
 * troisième endroit — voir aussi les propriétés structurées "Piège 921$a
 * (Code)"/"Piège 921$b (Code)" de xml/bib.xml (scripts/lib/gesmarc.mjs), qui
 * partagent la même table de codes Syracuse.
 *
 * Champ Syracuse indiquant un statut particulier de l'exemplaire (pilon,
 * braderie, consultation sur place, perdu…). $a = nature de l'exclusion,
 * $b = motif détaillé. Un code absent de la table est affiché tel quel
 * plutôt que masqué (voir piegeLabelOf ci-dessous et le nommage par CODE,
 * pas par libellé, des colonnes générées de la table `exemplaires` en base).
 *
 * Aucune dépendance npm. Node ≥ 18.
 * ────────────────────────────────────────────────────────────────────────────
 */

export const PIEGE_A_LABELS = {
  1: 'Exclu du prêt temporairement',
  2: 'Exclu DEFINITIVEMENT du prêt',
  3: 'Magasin', // Sans libellé dans la table Syracuse (bib.xml) — confirmé par l'équipe.
  4: 'Non réservable',
};
export const PIEGE_B_LABELS = {
  2: 'en réserve',
  3: 'perdu',
  4: 'pilon',
  7: 'Equipement',
  8: 'Réserve Patrimoniale',
  9: 'Voir banque de prêt',
  10: 'Réserve Saint Exupery',
  BRAD: 'Braderie',
  CSP: 'Consultation sur place',
  EXC: 'Exclu de la recherche portail',
  MAG: 'En magasin',
  PAD: 'Prêt à Domicile',
  PER: 'Perdu',
  PIL: 'Pilon',
  QUAR: 'Quarantaine',
  RAP: '3 rappels envoyés',
  REP: 'En réparation',
  TRA: 'En traitement',
};

// Reproduit le format du champ "Pièges" déjà concaténé côté GESMARC (voir
// build-magasins.mjs), pour que recolement.html affiche la même chose quel
// que soit la source (réserve ou magasins).
export function piegeLabelOf(merged) {
  const a = (merged['921$a'] || '').trim();
  const b = (merged['921$b'] || '').trim();
  const c = (merged['921$c'] || '').trim();
  const parts = [];
  if (a) parts.push(PIEGE_A_LABELS[a] || a);
  if (b) parts.push(PIEGE_B_LABELS[b] || b);
  if (c) parts.push(c);
  return parts.length ? parts.join(' ') : null;
}
