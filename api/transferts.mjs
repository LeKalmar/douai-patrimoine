/**
 * État partagé de la liste de transfert 2e étage → réserve patrimoniale
 * (transfert-magasins.html), stocké dans R2 sous la clé
 * "transferts-magasins.json" — forme { [id]: record }, id généré côté
 * client (crypto.randomUUID(), pas de code-barre disponible à la création
 * puisque ces documents ne sont pas catalogués).
 *
 * record = { id, '200$a','700$a','210$a','210$c','210$d','215$a','215$d',
 *            '930$g','915$a','920$d', status:'pending'|'done',
 *            newCote, newBarcode, ts, doneTs } — voir CLAUDE.md, section
 * « Transfert 2e étage → réserve patrimoniale ».
 *
 * GET  → l'état courant (lecture non authentifiée, même niveau d'exposition
 *        que le reste des données du projet).
 * POST → un patch {type:'upsert', record} ou {type:'delete', id}, fusionné
 *        via compare-and-swap (r2CasUpdate). Authentification requise
 *        (voir lib/auth.mjs). Même patron que api/exemplaires-manuels.mjs.
 */
import { r2Get, r2CasUpdate, r2Configured } from '../lib/r2.mjs';
import { requireAuth } from '../lib/auth.mjs';

const KEY = 'transferts-magasins.json';

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
  if (patch.type === 'upsert') {
    const record = patch.record;
    if (!record || !record.id) throw new BadRequest('upsert : record.id requis.');
    return { ...state, [record.id]: record };
  }
  if (patch.type === 'delete') {
    if (!patch.id) throw new BadRequest('delete : id requis.');
    const next = { ...state };
    delete next[patch.id];
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
