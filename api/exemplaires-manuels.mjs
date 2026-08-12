/**
 * État partagé des exemplaires créés via exemplarisation.html, stocké dans
 * R2 sous la clé "exemplaires-manuels.json" — forme { [barcode]: record },
 * avec record = { barcode, titre, auteur, date, cote, ts }.
 *
 * Sert à enregistrer un exemplaire (code-barre + métadonnées minimales)
 * sans passer par une notice bibliographique complète dans Syracuse — voir
 * CLAUDE.md, section « Exemplarisation rapide ». Ces enregistrements sont
 * ensuite fusionnés côté client (js/exemplaires-manuels-shared.js) avec
 * data/inventaire.json pour apparaître dans le catalogue et dans le
 * récolement au même titre qu'une notice Syracuse.
 *
 * GET  → l'état courant (lecture non authentifiée, même niveau d'exposition
 *        que le reste des données du projet).
 * POST → un patch {type:'upsert', record} ou {type:'delete', barcode},
 *        fusionné via compare-and-swap (r2CasUpdate). Authentification
 *        requise (voir lib/auth.mjs).
 */
import { r2Get, r2CasUpdate, r2Configured } from '../lib/r2.mjs';
import { requireAuth } from '../lib/auth.mjs';

const KEY = 'exemplaires-manuels.json';

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
    if (!record || !record.barcode) throw new BadRequest('upsert : record.barcode requis.');
    return { ...state, [record.barcode]: record };
  }
  if (patch.type === 'delete') {
    if (!patch.barcode) throw new BadRequest('delete : barcode requis.');
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
