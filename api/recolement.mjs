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

function applyPatch(state, patch) {
  const scans = toMap(state.scans, r => r.barcode);
  const nonCat = toMap(state.nonCatalogues, locKey);
  const vide = toMap(state.videShelves, locKey);
  const nonrange = toMap(state.nonRangeShelves, locKey);

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
    default:
      throw new BadRequest(`Type de patch inconnu : ${patch.type}`);
  }

  return {
    scans: fromMap(scans),
    nonCatalogues: fromMap(nonCat),
    videShelves: fromMap(vide),
    nonRangeShelves: fromMap(nonrange),
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
