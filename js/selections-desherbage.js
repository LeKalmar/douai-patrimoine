/* ════════════════════════════════════════════════════════════════════════
   RAYONS FICTIFS DES MAGASINS (désherbage)

   Dans les magasins d'étage, un « rayon » au sens du désherbage (ex. les
   Que sais-je ? du 5e) n'est pas une travée entière : quelques colonnes,
   parfois quelques étagères seulement, éventuellement sur plusieurs travées.
   Un rayon fictif = un nom + une liste de zones, chaque zone désignant une
   travée de magasin, ses colonnes (toutes si `cols` est vide) et une plage
   d'étagères (toutes si `etFrom`/`etTo` sont vides) :

     { id:"SEL-…", label, parts:[{travee, cols:["I","J"]|null, etFrom, etTo}],
       ts, deleted? }

   Stocké dans l'état partagé du récolement (catégorie `selections` de
   recolement.json, patch `selection` — voir api/recolement.mjs) : c'est un
   filtre nommé sur les scans existants, rien n'est déplacé ni rescanné.
   Créé et modifié depuis rotobib.html ; lu aussi par
   validation-desherbage.html pour grouper les décisions par rayon.
   Dépend de js/reserve-shared.js (TRAVEES_MAGASIN2/5/6).
   ════════════════════════════════════════════════════════════════════════ */
(function (global) {
  'use strict';

  const SELECTION_PREFIX = 'SEL-';
  /* Noms nus et non global.TRAVEES_… : les `const` de premier niveau d'un
     script classique (reserve-shared.js) sont partagés entre scripts mais ne
     deviennent pas des propriétés de window. */
  const MAGASINS = [
    { prefix: 'M2-', label: '2e étage', travees: typeof TRAVEES_MAGASIN2 !== 'undefined' ? TRAVEES_MAGASIN2 : [] },
    { prefix: 'M5-', label: '5e étage', travees: typeof TRAVEES_MAGASIN5 !== 'undefined' ? TRAVEES_MAGASIN5 : [] },
    { prefix: 'M6-', label: '6e étage', travees: typeof TRAVEES_MAGASIN6 !== 'undefined' ? TRAVEES_MAGASIN6 : [] },
  ];

  function isSelectionId(id) { return typeof id === 'string' && id.startsWith(SELECTION_PREFIX); }
  function isMagasinTraveeId(id) { return typeof id === 'string' && /^M[256]-/.test(id); }
  function magasinOf(travee) { return MAGASINS.find(m => String(travee || '').startsWith(m.prefix)) || null; }
  function traveeDef(travee) {
    const m = magasinOf(travee);
    return m ? m.travees.find(t => t.id === travee) || null : null;
  }
  function colLetters(travee) {
    const def = traveeDef(travee);
    const n = def ? def.nbCols : 0;
    return Array.from({ length: n }, (_, i) => String.fromCharCode(65 + i));
  }
  // « M5-XVII » → « Travée XVII » ; « M5-ALPHA » → « Travée Alpha ».
  function traveeName(travee) {
    const raw = String(travee || '').replace(/^M[256]-/, '');
    return 'Travée ' + (/^[IVXLC]+$/.test(raw) ? raw : raw.charAt(0) + raw.slice(1).toLowerCase());
  }

  function normalizePart(p) {
    if (!p || !isMagasinTraveeId(p.travee)) return null;
    const cols = Array.isArray(p.cols) ? [...new Set(p.cols.map(c => String(c).toUpperCase()))].sort() : [];
    let etFrom = parseInt(p.etFrom, 10), etTo = parseInt(p.etTo, 10);
    etFrom = Number.isFinite(etFrom) && etFrom > 0 ? etFrom : null;
    etTo = Number.isFinite(etTo) && etTo > 0 ? etTo : null;
    if (etFrom && etTo && etFrom > etTo) [etFrom, etTo] = [etTo, etFrom];
    return { travee: p.travee, cols: cols.length ? cols : null, etFrom, etTo };
  }

  /* Enregistrements bruts (tableau) → définitions utilisables, sans les
     supprimées ni les invalides, triées par nom. */
  function applySelectionRecords(records) {
    return (Array.isArray(records) ? records : Object.values(records || {}))
      .filter(r => r && isSelectionId(r.id) && !r.deleted)
      .map(r => ({ id: r.id, label: String(r.label || '').trim() || 'Rayon sans nom',
                   parts: (r.parts || []).map(normalizePart).filter(Boolean), ts: r.ts }))
      .filter(r => r.parts.length)
      .sort((a, b) => a.label.localeCompare(b.label, 'fr', { numeric: true, sensitivity: 'base' }));
  }

  function partMatches(p, scan) {
    if (!scan || scan.travee !== p.travee) return false;
    if (p.cols && !p.cols.includes(String(scan.colonne || '').toUpperCase())) return false;
    const et = parseInt(scan.etage, 10);
    if (p.etFrom && !(et >= p.etFrom)) return false;
    if (p.etTo && !(et <= p.etTo)) return false;
    return true;
  }
  function selectionMatches(sel, scan) { return sel.parts.some(p => partMatches(p, scan)); }

  // Libellé lisible d'une zone : « 5e étage · Travée XVII · col. I, J · étagères 2 à 5 ».
  function partLabel(p) {
    const m = magasinOf(p.travee);
    const bits = [(m ? m.label + ' · ' : '') + traveeName(p.travee)];
    bits.push(p.cols ? (p.cols.length > 1 ? 'colonnes ' : 'colonne ') + p.cols.join(', ') : 'toutes les colonnes');
    if (p.etFrom && p.etTo) bits.push(p.etFrom === p.etTo ? `étagère ${p.etFrom}` : `étagères ${p.etFrom} à ${p.etTo}`);
    else if (p.etFrom) bits.push(`étagères ${p.etFrom} et au-delà`);
    else if (p.etTo) bits.push(`étagères 1 à ${p.etTo}`);
    else bits.push('toutes les étagères');
    return bits.join(' · ');
  }

  function newSelectionId() {
    const rnd = (global.crypto && global.crypto.randomUUID) ? global.crypto.randomUUID().slice(0, 8) : Math.random().toString(36).slice(2, 10);
    return SELECTION_PREFIX + Date.now().toString(36) + '-' + rnd;
  }

  global.selectionsDesherbage = {
    SELECTION_PREFIX, MAGASINS,
    isSelectionId, isMagasinTraveeId, magasinOf, traveeDef, colLetters, traveeName,
    normalizePart, applySelectionRecords, selectionMatches, partLabel, newSelectionId,
  };
})(typeof window !== 'undefined' ? window : globalThis);
