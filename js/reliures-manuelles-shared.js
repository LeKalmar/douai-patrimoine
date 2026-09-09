/**
 * Groupes de reliures créés manuellement depuis reliures.html (état partagé
 * R2, voir api/reliures-manuelles.mjs) — complètent les groupes détectés
 * automatiquement dans Syracuse via $481/$482 (champ `_relies` dans
 * data/inventaire.json, voir scripts/build-inventory.mjs).
 *
 * Forme du state : { groups: { [principalBarcode]: {principal, members:[barcode,...], ts} },
 *                     ignoredSuggestions: { [signature]: {signature, base, barcodes, ts} } }
 */
function fetchReliuresManuelles() {
  return fetch('/api/reliures-manuelles')
    .then(r => (r.ok ? r.json() : {}))
    .then(state => ({ groups: (state && state.groups) || {}, ignoredSuggestions: (state && state.ignoredSuggestions) || {} }))
    .catch(() => ({ groups: {}, ignoredSuggestions: {} }));
}

// Fusionne les groupes manuels dans catalog[bc].relies (déjà rempli à partir
// de _relies pour les groupes Syracuse) — même usage ensuite, sans
// distinction entre les deux sources : handleScan()/applyReliureCascade()
// dans recolement.html récole tout le groupe dès qu'un seul membre est
// scanné, peu importe d'où vient le lien.
function applyManualReliureGroups(catalog, manualState) {
  Object.values((manualState && manualState.groups) || {}).forEach(g => {
    const all = [g.principal, ...(g.members || [])];
    all.forEach(bc => {
      if (!catalog[bc]) return;
      const others = all.filter(b => b !== bc);
      const existing = new Set(catalog[bc].relies || []);
      others.forEach(o => existing.add(o));
      catalog[bc].relies = [...existing];
    });
  });
}
