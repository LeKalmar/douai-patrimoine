/**
 * Fabrique commune aux endpoints « état partagé R2 » : /api/recolement,
 * /api/spolies, /api/exemplaires-manuels, /api/reliures-manuelles,
 * /api/transferts, /api/desherbage.
 *
 * Ces six fonctions étaient jusqu'ici copiées ligne pour ligne, ne différant
 * que par leur clé R2, leur état vide et leur applyPatch(). Elles partagent
 * désormais ce module — un correctif (comme l'ETag ci-dessous) profite donc
 * à toutes d'un coup, au lieu d'être à réappliquer six fois.
 *
 * Contrat, inchangé côté client :
 *   GET  → l'état courant, en lecture publique (même niveau d'exposition que
 *          les fichiers data/*.json committés).
 *   POST → un patch unitaire fusionné côté serveur via compare-and-swap
 *          (r2CasUpdate), authentification requise (voir lib/auth.mjs).
 *
 * ─── ETag / 304 ───
 * recolement.html, reserve.html, exemplarisation.html et rotobib.html
 * interrogent ces routes toutes les 45 s, par onglet ouvert. Sans validateur,
 * chaque appel retéléchargeait l'état complet — pour recolement.json, ~330
 * octets par scan, soit plusieurs Mo sur un récolement avancé, alors que
 * l'état n'a le plus souvent pas bougé. On propage donc l'ETag que R2 renvoie
 * déjà sur chaque objet (voir r2Get dans lib/r2.mjs) et on répond 304 sans
 * corps quand le client le représente dans If-None-Match.
 *
 * L'ETag porte sur l'objet R2, alors que le corps renvoyé en est une
 * re-sérialisation (JSON.parse puis res.json, plus une éventuelle
 * normalisation via `normalizeState`). C'est valide parce que cette
 * transformation est déterministe : à octets R2 identiques, corps identique.
 */
import { r2Get, r2CasUpdate, r2Configured } from './r2.mjs';
import { requireAuth } from './auth.mjs';

/* `s-maxage=20` : mise en cache CDN courte — plusieurs collègues qui
   interrogent la même route au même moment partagent une seule réponse
   d'origine, au lieu de relire R2 chacun de leur côté (« Fast Origin
   Transfer », voir CLAUDE.md).

   `max-age=0, must-revalidate` : côté navigateur, revalider systématiquement.
   Sans directive de fraîcheur explicite pour le cache privé, le navigateur
   applique une heuristique — il pourrait servir un état périmé, ou au
   contraire retélécharger le corps entier. Ici on veut précisément l'autre
   comportement : une requête conditionnelle à chaque sondage, à laquelle
   l'ETag ci-dessous répond 304 sans corps tant que rien n'a changé. Le coût
   d'un sondage à vide tombe alors à quelques centaines d'octets d'en-têtes,
   et fetch() côté client continue de voir un 200 servi depuis le cache — le
   304 lui est transparent, aucun changement nécessaire dans les pages. */
const CACHE_CONTROL = 'public, max-age=0, must-revalidate, s-maxage=20, stale-while-revalidate=60';

/* Le client représente-t-il déjà cette version ? If-None-Match peut valoir
   « * », ou une liste d'ETags séparés par des virgules. On tolère le préfixe
   faible W/ des deux côtés : un intermédiaire (CDN, proxy) peut affaiblir un
   validateur en transit, et pour ces routes une correspondance faible suffit
   — le corps est de toute façon régénéré à l'identique. */
export function etagMatches(ifNoneMatch, etag) {
  if (!ifNoneMatch || !etag) return false;
  const strip = t => t.trim().replace(/^W\//, '');
  const target = strip(etag);
  return ifNoneMatch
    .split(',')
    .some(part => { const t = strip(part); return t === '*' || t === target; });
}

export function createPatchEndpoint({ key, emptyState, applyPatch, normalizeState }) {
  return async function handler(req, res) {
    if (!r2Configured()) {
      res.status(503).json({ error: 'R2 non configuré côté serveur (variables R2_* manquantes sur Vercel).' });
      return;
    }
    try {
      if (req.method === 'GET') {
        const current = await r2Get(key);
        res.setHeader('Cache-Control', CACHE_CONTROL);
        if (current && current.etag) {
          res.setHeader('ETag', current.etag);
          if (etagMatches(req.headers['if-none-match'], current.etag)) {
            // 304 : pas de corps. L'onglet garde l'état qu'il a déjà, et on
            // économise la totalité du transfert sur un sondage à vide.
            res.status(304).end();
            return;
          }
        }
        const state = current ? JSON.parse(current.body) : emptyState();
        res.status(200).json(normalizeState ? normalizeState(state) : state);
        return;
      }
      if (req.method === 'POST') {
        requireAuth(req);
        const patch = req.body;
        if (!patch || typeof patch !== 'object') {
          const err = new Error('Corps JSON attendu.');
          err.status = 400;
          throw err;
        }
        const updated = await r2CasUpdate(key, state => applyPatch(state, patch), emptyState);
        res.status(200).json(updated);
        return;
      }
      res.setHeader('Allow', 'GET, POST');
      res.status(405).json({ error: 'Méthode non supportée.' });
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message || 'Erreur serveur.' });
    }
  };
}
