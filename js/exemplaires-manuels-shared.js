/**
 * Exemplaires créés via exemplarisation.html (état partagé R2, voir
 * api/exemplaires-manuels.mjs) — chargé côté client par js/inventaire.js
 * (catalogue affiché sur index.html) et analyse-cotes.html, pour qu'un
 * exemplaire ainsi créé apparaisse au même titre qu'une notice Syracuse
 * sans dupliquer leur logique d'affichage/analyse. Regroupés sous un
 * sous-fonds dédié pour rester visuellement distincts tant qu'ils n'ont pas
 * été réellement catalogués dans Syracuse (voir SOUS_FONDS_KEY dans
 * js/inventaire.js, qui groupe déjà génériquement par ce champ).
 *
 * Convention de champs (mêmes clés que data/inventaire.json) :
 *   200$a → titre, 700$a → auteur, 210$d → date, 930$g → cote,
 *   995$f → code-barre (même champ que celui lu par recolement.html pour
 *   construire son "catalog", voir la ligne `it['915$b'] || it['995$f']`).
 */
const EXEMPLAIRES_MANUELS_SOUS_FONDS = '⚡ Exemplarisation rapide (à cataloguer)';

function exemplaireManuelToCatalogRecord(rec) {
  return {
    '200$a': rec.titre || '',
    '700$a': rec.auteur || '',
    '210$d': rec.date || '',
    '930$g': rec.cote || '',
    '995$f': rec.barcode || '',
    'Sous-fonds': EXEMPLAIRES_MANUELS_SOUS_FONDS,
    '_manuel': true,
  };
}

function fetchExemplairesManuelsAsCatalogRows() {
  return fetch('/api/exemplaires-manuels')
    .then(r => (r.ok ? r.json() : {}))
    .then(data => Object.values(data || {}).map(exemplaireManuelToCatalogRecord))
    .catch(() => []);
}
