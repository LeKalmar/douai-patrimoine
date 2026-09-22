/**
 * Exemplaires créés via exemplarisation.html (état partagé R2, voir
 * api/exemplaires-manuels.mjs) — chargé côté client par js/inventaire.js
 * (catalogue affiché sur inventaire.html, la page publique) et
 * analyse-cotes.html, pour qu'un exemplaire ainsi créé apparaisse au même
 * titre qu'une notice Syracuse sans dupliquer leur logique
 * d'affichage/analyse. Le champ Sous-fonds les marque toujours comme non
 * catalogués, mais depuis 2026-09-11 (demande explicite) l'inventaire
 * public ne l'affiche plus (ni badge de regroupement, ni pastille dans la
 * fiche détaillée) : SOUS_FONDS_KEY vaut null dans js/inventaire.js, et
 * js/inventaire-page.js ne rend plus de pastille pour ce champ — ces
 * exemplaires restent cherchables/affichés, juste sans étiquette
 * « à cataloguer » visible du public.
 *
 * Convention de champs (mêmes clés que data/inventaire.json) :
 *   200$a → titre, 700$a → auteur, 210$d → date, 930$g → cote,
 *   995$f → code-barre (même champ que celui lu par recolement.html pour
 *   construire son "catalog", voir la ligne `it['915$b'] || it['995$f']`).
 *   Champs optionnels supplémentaires (posés par transfert-magasins.html
 *   sur les exemplaires issus du transfert 2e étage → réserve patrimoniale,
 *   absents des exemplaires créés directement par exemplarisation.html) :
 *   210$a → lieu d'édition, 210$c → maison d'édition, 215$a → importance
 *   matérielle, 215$d → dimensions.
 *
 * Numérisation (2026-09-11) : exemplarisation.html peut aussi poser
 * `rec.numerise` (bool) et `rec.lienNumerise` (chemin R2 relatif, ex.
 * `num-robaut/Boîte 1/B591786101_RI_01_020r_033.jpg` — même convention que
 * les `path` de js/manifest.json, la visionneuse patrimoniale). Quand les
 * deux sont posés, on en dérive `lien_num` (URL complète, réutilise tel
 * quel le mécanisme de vignette existant — js/inventaire.js n'a besoin
 * d'aucun changement pour l'afficher) et `_lienNumerise` (le chemin brut,
 * pour que js/inventaire.js sache proposer un bouton « Accéder au document
 * numérisé » vers visionneuse.html?image=… — voir buildExpandedContent()
 * et buildThumbFrame()). IMAGES_ROOT est dupliqué depuis visionneuse.html /
 * js/bibliotheque-virtuelle.js plutôt que partagé : c'est déjà la
 * convention de ce projet pour cette constante (même valeur déclarée trois
 * fois avant ce fichier), pas une régression.
 */
const EXEMPLAIRES_MANUELS_SOUS_FONDS = '⚡ Exemplarisation rapide (à cataloguer)';
const EXEMPLAIRES_MANUELS_IMAGES_ROOT = 'https://pub-85062da5f8a7451b9c168f8b3cfd980b.r2.dev/';

function exemplaireManuelToCatalogRecord(rec) {
  const out = {
    '200$a': rec.titre || '',
    '700$a': rec.auteur || '',
    '210$a': rec['210$a'] || '',
    '210$c': rec['210$c'] || '',
    '210$d': rec.date || '',
    '215$a': rec['215$a'] || '',
    '215$d': rec['215$d'] || '',
    '930$g': rec.cote || '',
    '995$f': rec.barcode || '',
    'Sous-fonds': EXEMPLAIRES_MANUELS_SOUS_FONDS,
    '_manuel': true,
  };
  if (rec.numerise && rec.lienNumerise) {
    out['lien_num'] = EXEMPLAIRES_MANUELS_IMAGES_ROOT + rec.lienNumerise;
    out['_lienNumerise'] = rec.lienNumerise;
  }
  return out;
}

function fetchExemplairesManuelsAsCatalogRows() {
  return fetch('/api/exemplaires-manuels')
    .then(r => (r.ok ? r.json() : {}))
    .then(data => Object.values(data || {}).map(exemplaireManuelToCatalogRecord))
    .catch(() => []);
}
