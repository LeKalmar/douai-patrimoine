/**
 * État partagé des décisions de désherbage prises via rotobib.html, stocké
 * dans R2 sous la clé "desherbage-traitements.json" — forme
 * { [barcode]: {barcode, statut, ts} }, avec statut ∈ 'conserver' | 'pilon'
 * | 'braderie' | 'relocalisation'. Voir CLAUDE.md, section Rotobib.
 *
 * GET  → l'état courant (lecture non authentifiée, même niveau d'exposition
 *        que le reste des données partagées du projet).
 * POST → un patch {type:'set', record:{barcode,statut,ts}} (choix ou
 *        changement de traitement) ou {type:'clear', barcode} (annule le
 *        traitement, redevient "non traité"), fusionné via compare-and-swap
 *        (r2CasUpdate). Authentification requise (voir lib/auth.mjs).
 */
import { r2Get, r2CasUpdate, r2Configured } from '../lib/r2.mjs';
import { requireAuth } from '../lib/auth.mjs';

const KEY = 'desherbage-traitements.json';
const STATUTS = ['conserver', 'pilon', 'braderie', 'relocalisation'];

class BadRequest extends Error {
  constructor(message) {
    super(message);
    this.status = 400;
  }
}

function emptyState() {
  return {};
}

function applyPatch(state, patch) {
  if (patch.type === 'set') {
    const record = patch.record;
    if (!record || !record.barcode) throw new BadRequest('set : record.barcode requis.');
    if (!STATUTS.includes(record.statut)) throw new BadRequest(`statut invalide : ${record.statut}`);
    return { ...state, [record.barcode]: record };
  }
  if (patch.type === 'clear') {
    if (!patch.barcode) throw new BadRequest('clear : barcode requis.');
    const next = { ...state };
    delete next[patch.barcode];
    return next;
  }
  throw new BadRequest(`Type de patch inconnu : ${patch.type}`);
}

export default async function handler(req, res) {
  if (!r2Configured()) {
    res.status(503).json({ error: 'R2 non configuré côté serveur (variables R2_* manquantes sur Vercel).' });
    return;
  }
  try {
    if (req.method === 'GET') {
      const current = await r2Get(KEY);
      res.setHeader('Cache-Control', 'public, s-maxage=20, stale-while-revalidate=60');
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
