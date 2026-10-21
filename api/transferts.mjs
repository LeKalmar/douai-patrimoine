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
import { createPatchEndpoint } from '../lib/patch-endpoint.mjs';
import { PRESENTOIRS_KEY, emptyPresentoirsState, applyPresentoirsPatch } from '../lib/presentoirs-state.mjs';
import { importFasciculesDuJour } from '../lib/presentoirs-syracuse.mjs';
import { r2Configured } from '../lib/r2.mjs';
import { requireAuth } from '../lib/auth.mjs';

/* L'import Syracuse des présentoirs (`&syracuse=jour`) enchaîne des appels
   espacés de 300 ms : jusqu'à ~25 s au pire. Littéral obligatoire (voir
   CLAUDE.md : une constante fait échouer le build Vercel). */
export const config = { maxDuration: 45 };

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

/* Handler = la fabrique partagée : GET (public, avec ETag/304), POST
   authentifié fusionné en compare-and-swap. Voir lib/patch-endpoint.mjs. */
const transferts = createPatchEndpoint({
  key: KEY,
  emptyState,
  applyPatch,
});

/* `?store=presentoirs` : état des présentoirs de presse (presentoirs.html),
   hébergé ici faute de place — le plan Hobby plafonne un déploiement à 12
   fonctions et api/ les a toutes. Clé R2 et patchs propres, voir
   lib/presentoirs-state.mjs ; rien n'est partagé avec les transferts. */
const presentoirs = createPatchEndpoint({
  key: PRESENTOIRS_KEY,
  emptyState: emptyPresentoirsState,
  applyPatch: applyPresentoirsPatch,
});

/* `?store=presentoirs&syracuse=jour` (POST authentifié) : met en façade les
   fascicules bulletinés aujourd'hui dans Syracuse — lib/presentoirs-syracuse.mjs. */
async function presentoirsSyracuse(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    res.status(405).json({ error: 'Méthode non supportée.' });
    return;
  }
  if (!r2Configured()) {
    res.status(503).json({ error: 'R2 non configuré côté serveur (variables R2_* manquantes sur Vercel).' });
    return;
  }
  try {
    requireAuth(req);
    res.status(200).json(await importFasciculesDuJour());
  } catch (err) {
    res.status(err.status || 502).json({ error: err.message || 'Erreur serveur.' });
  }
}

export default function handler(req, res) {
  const q = req.query || {};
  if (q.store === 'presentoirs') return q.syracuse === 'jour' ? presentoirsSyracuse(req, res) : presentoirs(req, res);
  return transferts(req, res);
}
