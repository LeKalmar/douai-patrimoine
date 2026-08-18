/**
 * Groupes de reliures créés manuellement depuis reliures.html, stockés dans
 * R2 sous la clé "reliures-manuelles.json" — forme
 * { groups: { [principalBarcode]: {principal, members:[barcode,...], ts} },
 *   ignoredSuggestions: { [signature]: {signature, base, barcodes:[...], ts} } }.
 *
 * `groups` complète (sans les remplacer) les groupes détectés automatiquement
 * dans Syracuse via $481/$482 (voir _relies dans scripts/build-inventory.mjs) :
 * utile pour relier deux documents catalogués séparément qu'on découvre
 * physiquement reliés ensemble en réserve, sans dépendre d'une prochaine mise
 * à jour du SIGB. Fusionnés côté client (js/reliures-manuelles-shared.js)
 * avec les groupes Syracuse pour former le graphe complet consommé par
 * handleScan()/applyReliureCascade() dans recolement.html.
 *
 * `ignoredSuggestions` mémorise les « groupes potentiels » détectés dans
 * reliures.html à partir des cotes (voir suggestCoteGroups() côté client) et
 * écartés par l'utilisateur·rice comme non pertinents — `signature` = liste
 * triée des barcodes du groupe suggéré, jointe par "|", pour rester stable
 * d'un build à l'autre (indépendante de tout recalcul de _relies) tout en
 * redevenant une suggestion "neuve" si sa composition change (un nouveau
 * document apparaît sous la même base de cote, par exemple).
 *
 * GET  → l'état courant (lecture non authentifiée, même niveau d'exposition
 *        que le reste des données du projet).
 * POST → un patch parmi :
 *   - {type:'ensureGroup', principal, ts}                  crée le groupe s'il n'existe pas encore (members:[])
 *   - {type:'addMember', principal, barcode, ts}            ajoute un membre (retiré au passage de tout autre groupe, appartenance exclusive)
 *   - {type:'removeMember', principal, barcode}             retire un membre
 *   - {type:'deleteGroup', principal}                       supprime le groupe entier
 *   - {type:'dismissSuggestion', signature, base, barcodes, ts}  écarte une suggestion de groupe potentiel
 *   - {type:'undismissSuggestion', signature}               réaffiche une suggestion écartée par erreur
 * fusionné via compare-and-swap (r2CasUpdate). Authentification requise
 * (voir lib/auth.mjs).
 */
import { r2Get, r2CasUpdate, r2Configured } from '../lib/r2.mjs';
import { requireAuth } from '../lib/auth.mjs';

const KEY = 'reliures-manuelles.json';

class BadRequest extends Error {
  constructor(message) {
    super(message);
    this.status = 400;
  }
}

function emptyState() {
  return { groups: {}, ignoredSuggestions: {} };
}

// Les états écrits avant l'introduction de ignoredSuggestions (2026-08-14)
// étaient directement { [principal]: group } — remis à plat au premier accès
// pour ne pas perdre les groupes déjà créés.
function normalize(state) {
  if (state && (state.groups || state.ignoredSuggestions)) {
    return { groups: state.groups || {}, ignoredSuggestions: state.ignoredSuggestions || {} };
  }
  return { groups: state || {}, ignoredSuggestions: {} };
}

function applyPatch(rawState, patch) {
  const state = normalize(rawState);
  const groups = { ...state.groups };
  const ignoredSuggestions = { ...state.ignoredSuggestions };

  switch (patch.type) {
    case 'ensureGroup': {
      if (!patch.principal) throw new BadRequest('ensureGroup : principal requis.');
      if (!groups[patch.principal]) {
        groups[patch.principal] = { principal: patch.principal, members: [], ts: patch.ts || Date.now() };
      }
      break;
    }
    case 'addMember': {
      if (!patch.principal || !patch.barcode) throw new BadRequest('addMember : principal et barcode requis.');
      if (patch.barcode === patch.principal) throw new BadRequest('addMember : un document ne peut pas être relié à lui-même.');
      // Appartenance exclusive : un même barcode ne doit être membre que
      // d'un seul groupe à la fois (sinon la cascade de handleScan() se
      // propagerait vers deux endroits différents).
      for (const key of Object.keys(groups)) {
        if (key !== patch.principal && groups[key].members.includes(patch.barcode)) {
          groups[key] = { ...groups[key], members: groups[key].members.filter(b => b !== patch.barcode) };
        }
      }
      const group = groups[patch.principal] || { principal: patch.principal, members: [], ts: patch.ts || Date.now() };
      const members = group.members.includes(patch.barcode) ? group.members : [...group.members, patch.barcode];
      groups[patch.principal] = { ...group, members, ts: patch.ts || Date.now() };
      break;
    }
    case 'removeMember': {
      if (!patch.principal || !patch.barcode) throw new BadRequest('removeMember : principal et barcode requis.');
      if (groups[patch.principal]) {
        groups[patch.principal] = { ...groups[patch.principal], members: groups[patch.principal].members.filter(b => b !== patch.barcode) };
      }
      break;
    }
    case 'deleteGroup': {
      if (!patch.principal) throw new BadRequest('deleteGroup : principal requis.');
      delete groups[patch.principal];
      break;
    }
    case 'dismissSuggestion': {
      if (!patch.signature) throw new BadRequest('dismissSuggestion : signature requise.');
      ignoredSuggestions[patch.signature] = {
        signature: patch.signature,
        base: patch.base || '',
        barcodes: Array.isArray(patch.barcodes) ? patch.barcodes : [],
        ts: patch.ts || Date.now(),
      };
      break;
    }
    case 'undismissSuggestion': {
      if (!patch.signature) throw new BadRequest('undismissSuggestion : signature requise.');
      delete ignoredSuggestions[patch.signature];
      break;
    }
    default:
      throw new BadRequest(`Type de patch inconnu : ${patch.type}`);
  }

  return { groups, ignoredSuggestions };
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
      res.status(200).json(current ? normalize(JSON.parse(current.body)) : emptyState());
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
