/**
 * Surcharges partagées de livres-spolies.html, stockées dans R2 sous la clé
 * "livres-spolies-overrides.json" (même forme que OVERRIDES côté client :
 * { [id]: { trouve, exLibris, possesseur, coteBM } }).
 *
 * GET  → l'état courant (lecture non authentifiée, même niveau d'exposition
 *        que le reste des données du projet).
 * POST → un patch {id, field, value} fusionné via compare-and-swap
 *        (r2CasUpdate). Authentification requise (voir lib/auth.mjs).
 */
import { r2Get, r2CasUpdate, r2Configured } from '../lib/r2.mjs';
import { requireAuth } from '../lib/auth.mjs';

const KEY = 'livres-spolies-overrides.json';
const ALLOWED_FIELDS = new Set(['trouve', 'exLibris', 'possesseur', 'coteBM']);

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
  if (patch.id === undefined || patch.id === null) throw new BadRequest('id requis.');
  if (!ALLOWED_FIELDS.has(patch.field)) throw new BadRequest(`field invalide : ${patch.field}`);
  const id = String(patch.id);
  const next = { ...state, [id]: { ...(state[id] || {}), [patch.field]: patch.value } };
  return next;
}

export default async function handler(req, res) {
  if (!r2Configured()) {
    res.status(503).json({ error: 'R2 non configuré côté serveur (variables R2_* manquantes sur Vercel).' });
    return;
  }
  try {
    if (req.method === 'GET') {
      const current = await r2Get(KEY);
      // Voir api/recolement.mjs : mise en cache CDN courte pour réduire le
      // "Fast Origin Transfer" du polling répété côté client.
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
