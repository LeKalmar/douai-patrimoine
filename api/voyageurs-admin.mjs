/**
 * /api/voyageurs-admin — lecture/écriture de l'exposition « Voyageurs
 * douaisiens » (clé R2 `voyageurs.json`, forme et règles dans
 * lib/voyageurs-state.mjs), pour voyageurs-admin.html et voyageurs.html.
 *
 * GET                : tout le contenu, brouillons (`publie:false`) compris,
 *                      avec pour chaque voyageur/voyage une `version` servant
 *                      au contrôle de concurrence. Toujours authentifié : les
 *                      brouillons sont des notes de recherche non publiées.
 * GET ?vue=publique  : ce que lit js/voyageurs.js — voyageurs et voyages
 *                      publiés seulement. Authentifié tant que
 *                      LECTURE_PUBLIQUE est faux (voir ci-dessous).
 * POST               : une action par appel, authentifiée :
 *   { action:'saveVoyageur', voyageur:{…, ecrits:[…]}, originalId?, version? }
 *   { action:'saveVoyage',   voyage:{…, voyageurId, sources:[…], points:[…]}, originalId?, version? }
 *   { action:'deleteVoyageur', id }      { action:'deleteVoyage', id }
 *   { action:'reorder', kind:'voyageurs'|'voyages', ids:[…] }
 *   `originalId` absent = création ; présent = mise à jour (l'identifiant
 *   peut changer). `version` différente de celle stockée = un·e collègue a
 *   enregistré cette fiche entre-temps → 409, rien n'est écrit.
 *   L'écriture passe par r2CasUpdate : deux enregistrements simultanés sur
 *   deux fiches différentes sont rejoués l'un après l'autre, aucun n'est
 *   perdu.
 *
 * Une seule fonction pour les deux lectures plutôt qu'un /api/voyageurs à
 * part : avec celle-ci le projet compte 12 fonctions, le plafond d'un
 * déploiement Vercel Hobby.
 */
import { r2Get, r2CasUpdate, r2Configured } from '../lib/r2.mjs';
import { requireAuth } from '../lib/auth.mjs';
import { etagMatches } from '../lib/patch-endpoint.mjs';
import {
  VOYAGEURS_KEY, emptyVoyageursState, normalizeVoyageursState,
  applyVoyageursAction, publicVoyageurs, HttpError,
} from '../lib/voyageurs-state.mjs';

/* Exposition en préparation : `false` réserve aussi la vue publique aux
   personnes connectées à l'espace pro. Pour la mise en ligne, passer à
   `true` — et retirer le contrôle d'accès en tête de voyageurs.html (voir
   CLAUDE.md, « Exposition Voyageurs douaisiens »). */
const LECTURE_PUBLIQUE = false;

// Même réglage que les autres états partagés (lib/patch-endpoint.mjs).
const CACHE_PUBLIC = 'public, max-age=0, must-revalidate, s-maxage=20, stale-while-revalidate=60';

async function readState() {
  const current = await r2Get(VOYAGEURS_KEY);
  return {
    etag: current && current.etag,
    state: normalizeVoyageursState(current ? JSON.parse(current.body) : null),
  };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!r2Configured()) {
    res.status(503).json({ error: 'R2 non configuré côté serveur (variables R2_* manquantes sur Vercel).' });
    return;
  }
  try {
    if (req.method === 'GET') {
      if (req.query && req.query.vue === 'publique') {
        if (!LECTURE_PUBLIQUE) requireAuth(req);
        const { etag, state } = await readState();
        if (LECTURE_PUBLIQUE) {
          res.setHeader('Cache-Control', CACHE_PUBLIC);
          if (etag) {
            res.setHeader('ETag', etag);
            if (etagMatches(req.headers['if-none-match'], etag)) {
              res.status(304).end();
              return;
            }
          }
        }
        res.status(200).json(publicVoyageurs(state));
        return;
      }
      requireAuth(req);
      res.status(200).json((await readState()).state);
      return;
    }
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'GET, POST');
      res.status(405).json({ error: 'Méthode non supportée.' });
      return;
    }
    requireAuth(req);
    const body = req.body;
    if (!body || typeof body !== 'object') throw new HttpError(400, 'Corps JSON attendu.');

    let id = null;
    const updated = await r2CasUpdate(VOYAGEURS_KEY, raw => {
      const state = normalizeVoyageursState(raw);
      id = applyVoyageursAction(state, body);
      return state;
    }, emptyVoyageursState);
    res.status(200).json({ ok: true, id, voyageurs: updated.voyageurs });
  } catch (err) {
    const status = err.status || 500;
    if (status >= 500) console.error('[api/voyageurs-admin]', err);
    res.status(status).json({ error: err.message || 'Erreur serveur.' });
  }
}
