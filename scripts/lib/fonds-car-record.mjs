/**
 * fonds-car-record.mjs
 * ────────────────────────────────────────────────────────────────────────────
 * Transforme une ligne brute de csv/Fonds CAR.csv (registre du fonds Cartes,
 * voir scripts/db-migrate-fonds-car.mjs — colonnes françaises : Nom, Auteur,
 * Éditeur/imprimeur, Lieu édition, Lieu représenté, Formats, échelle,
 * importance matérielle, type de carte, Année, Boîte, N°, ancienne cote1,
 * ancienne cote2, date d'entrée, intérêt BM DOUAI, justification) en un
 * enregistrement dans les mêmes clés UNIMARC que data/inventaire.json/
 * data/non-catalogues.json (200$a, 700$a, 930$g…) — voir
 * scripts/build-non-catalogues.mjs pour le patron d'origine.
 *
 * Fonction pure, appelée par scripts/lib/export-inventaire.mjs
 * (`exportInventaire()`, servie en direct par api/inventaire.mjs) —
 * `exemplaires.raw`, pour une ligne `source_ref LIKE 'fonds-car-%'`, EST
 * exactement la ligne CSV brute (db-migrate-fonds-car.mjs stocke
 * `JSON.stringify(row)` sans transformation), donc directement passable à
 * cette fonction sans étape intermédiaire.
 *
 * « ancienne cote2 » est de facto la cote actuellement en usage pour ces
 * documents (confirmé par l'équipe, 2026-09-23 — le nom de la colonne est
 * trompeur). « ancienne cote1 » (identifiant historique, ex. "M4217"),
 * « échelle », « Boîte »/« N° », « date d'entrée », « intérêt BM DOUAI » et
 * « justification » n'ont pas d'équivalent dans le format data/non-
 * catalogues.json — ils restent capturés sans perte dans Postgres
 * (exemplaires.raw, exemplaires.piege_c_texte pour les deux derniers) mais
 * ne sont pas repris ici, même narrowing que buildRecord() dans
 * scripts/build-non-catalogues.mjs pour le fonds Manuscrits/Robaut/Objets.
 *
 * Aucune dépendance npm. Node ≥ 18.
 * ────────────────────────────────────────────────────────────────────────────
 */
import { typeDocumentLabelOf } from './type-document-labels.mjs';

export const FONDS_CAR_LABEL = 'Cartes géographiques';

function clean(v) {
  return (v || '').replace(/\s+/g, ' ').trim();
}

/**
 * @param {Record<string,string>} row - une ligne de csv/Fonds CAR.csv (ou son
 *   équivalent stocké tel quel dans exemplaires.raw)
 * @returns {object|null} null si la ligne n'a pas de cote (930$g obligatoire
 *   — sans cote, de toute façon masquée côté page publique, voir
 *   js/inventaire-page.js)
 */
export function buildFondsCarRecord(row) {
  const cote = clean(row['ancienne cote2']);
  if (!cote) return null;

  const titreBrut = clean(row['Nom']);
  const titre = titreBrut || cote;

  // Lieu représenté + type de carte : les deux descriptifs les plus proches
  // d'un "sujet" pour une carte (ce qu'elle montre, sa nature) — 610$a est
  // déjà un DETAIL_COLS existant côté js/inventaire.js, rien à ajouter côté
  // affichage.
  const sujets = [clean(row['Lieu représenté']), clean(row['type de carte'])]
    .filter(Boolean).join(' ; ') || null;

  return {
    '930$g': cote,
    '200$a': titre,
    '700$a': clean(row['Auteur']) || null,
    '210$d': clean(row['Année']) || null,
    '215$a': clean(row['importance matérielle']) || null, // ex. "1 carte", "4 cartes"
    '215$d': clean(row['Formats']) || null,                // ex. "115x61,5cm"
    '610$a': sujets,
    _fondsLabel: FONDS_CAR_LABEL,
    // Code Syracuse fermé (920$t = "CAR"), pas de texte libre à traduire ici
    // contrairement au fonds Manuscrits/Robaut/Objets (200$b) — voir
    // scripts/lib/type-document-labels.mjs. Pris en priorité par
    // js/inventaire-page.js (r._typeDocument || normType(r['200$b'])).
    _typeDocument: typeDocumentLabelOf('CAR'),
    _nonCatalogue: true,
  };
}
