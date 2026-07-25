/**
 * État partagé du récolement, stocké dans R2 sous la clé "recolement.json"
 * (même forme que l'export de recolement.html : {scans, nonCatalogues,
 * videShelves, nonRangeShelves}, chaque valeur un tableau).
 *
 * GET  → l'état courant (accessible sans authentification : mêmes données
 *        que celles déjà lisibles via data/recolement.json committé).
 * POST → un patch ({type, ...}) appliqué via compare-and-swap (r2CasUpdate),
 *        pour que deux collègues qui écrivent en même temps ne s'écrasent
 *        pas mutuellement. Authentification requise (voir lib/auth.mjs).
 */
import { r2Get, r2CasUpdate, r2Configured } from '../lib/r2.mjs';
import { requireAuth } from '../lib/auth.mjs';

const KEY = 'recolement.json';

class BadRequest extends Error {
  constructor(message) {
    super(message);
    this.status = 400;
  }
}

function emptyState() {
  return { scans: [], nonCatalogues: [], videShelves: [], nonRangeShelves: [] };
}

function locKey(row) {
  return `${row.travee}|${row.colonne}|${row.etage}`;
}

function toMap(arr, keyFn) {
  const m = {};
  (arr || []).forEach(r => {
    m[keyFn(r)] = r;
  });
  return m;
}
function fromMap(m) {
  return Object.values(m);
}

// Applique un patch unitaire sur les maps mutables (scans/nonCat/vide/nonrange
// tirées de l'état courant) — factorisé pour être rejoué plusieurs fois de
// suite par le cas 'batch' ci-dessous sans relire/réécrire R2 à chaque fois.
function applyOne(maps, patch) {
  const { scans, nonCat, vide, nonrange } = maps;
  switch (patch.type) {
    case 'scan':
      if (!patch.record || !patch.record.barcode) throw new BadRequest('scan : record.barcode requis.');
      scans[patch.record.barcode] = patch.record;
      break;
    case 'deleteScan':
      if (!patch.barcode) throw new BadRequest('deleteScan : barcode requis.');
      delete scans[patch.barcode];
      break;
    case 'nonCat':
      if (!patch.key) throw new BadRequest('nonCat : key requis.');
      if (patch.record) nonCat[patch.key] = patch.record;
      else delete nonCat[patch.key];
      break;
    case 'vide':
      if (!patch.key) throw new BadRequest('vide : key requis.');
      if (patch.record) {
        vide[patch.key] = patch.record;
        delete nonrange[patch.key];
      } else delete vide[patch.key];
      break;
    case 'nonrange':
      if (!patch.key) throw new BadRequest('nonrange : key requis.');
      if (patch.record) {
        nonrange[patch.key] = patch.record;
        delete vide[patch.key];
      } else delete nonrange[patch.key];
      break;
    case 'bulkMerge': {
      // Fusionne un lot entier (import d'une sauvegarde JSON) dans l'état
      // partagé — jamais un écrasement : chaque entrée est ajoutée ou mise à
      // jour (scans : la plus récente par `ts` l'emporte), rien n'est
      // supprimé. Sert à réamorcer/rattraper R2 avec un historique local qui
      // n'a jamais été poussé incrément par incrément.
      if (!patch.data || typeof patch.data !== 'object') throw new BadRequest('bulkMerge : data requis.');
      const incomingScans = Array.isArray(patch.data.scans) ? patch.data.scans : [];
      const incomingNonCat = Array.isArray(patch.data.nonCatalogues) ? patch.data.nonCatalogues : [];
      const incomingVide = Array.isArray(patch.data.videShelves) ? patch.data.videShelves : [];
      const incomingNonRange = Array.isArray(patch.data.nonRangeShelves) ? patch.data.nonRangeShelves : [];

      incomingScans.forEach(r => {
        if (!r.barcode) return;
        const existing = scans[r.barcode];
        if (!existing || !existing.ts || (r.ts || 0) > existing.ts) scans[r.barcode] = r;
      });
      incomingNonCat.forEach(r => { if (r.travee && r.etage !== undefined) nonCat[locKey(r)] = r; });
      incomingVide.forEach(r => {
        if (r.travee && r.etage !== undefined) { vide[locKey(r)] = r; delete nonrange[locKey(r)]; }
      });
      incomingNonRange.forEach(r => {
        if (r.travee && r.etage !== undefined) { nonrange[locKey(r)] = r; delete vide[locKey(r)]; }
      });
      break;
    }
    // 'batch' n'est volontairement pas accepté ici : il n'est traité qu'au
    // niveau de applyPatch (un seul niveau d'imbrication).
    default:
      throw new BadRequest(`Type de patch inconnu : ${patch.type}`);
  }
}

function applyPatch(state, patch) {
  const maps = {
    scans: toMap(state.scans, r => r.barcode),
    nonCat: toMap(state.nonCatalogues, locKey),
    vide: toMap(state.videShelves, locKey),
    nonrange: toMap(state.nonRangeShelves, locKey),
  };

  if (patch.type === 'batch') {
    // Rejoue une file de patches individuels (scans faits hors ligne, par
    // exemple) en une seule lecture/écriture R2 au lieu d'un aller-retour
    // par patch — voir flushPendingSync() dans recolement.html.
    if (!Array.isArray(patch.patches)) throw new BadRequest('batch : patches (tableau) requis.');
    patch.patches.forEach(p => applyOne(maps, p));
  } else {
    applyOne(maps, patch);
  }

  return {
    scans: fromMap(maps.scans),
    nonCatalogues: fromMap(maps.nonCat),
    videShelves: fromMap(maps.vide),
    nonRangeShelves: fromMap(maps.nonrange),
  };
}

export default async function handler(req, res) {
  if (!r2Configured()) {
    res.status(503).json({ error: 'R2 non configuré côté serveur (variables R2_* manquantes sur Vercel).' });
    return;
  }
  try {
    if (req.method === 'GET') {
      const current = await r2Get(KEY);
      res.status(200).json(current ? JSON.parse(current.body) : emptyState());
      return;
    }
    if (req.method === 'POST') {
      requireAuth(req);
      const patch = req.body;
      if (!patch || typeof patch !== 'object') throw new BadRequest('Corps JSON attendu.');
      const updated = await r2CasUpdate(KEY, state => applyPatch(state, patch), emptyState);
      res.status(200).json(updated);
      return;
    }
    res.setHeader('Allow', 'GET, POST');
    res.status(405).json({ error: 'Méthode non supportée.' });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || 'Erreur serveur.' });
  }
}
