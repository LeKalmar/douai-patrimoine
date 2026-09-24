/**
 * /api/inventaire — équivalent live de data/inventaire.json, généré à la
 * volée depuis Postgres (scripts/lib/export-inventaire.mjs) au lieu d'un
 * fichier statique reconstruit par `npm run build`. Inclut la réserve
 * patrimoniale (source='reserve_marc') et le fonds Cartes
 * (source='excel_import', voir scripts/db-migrate-fonds-car.mjs) — tout
 * import Postgres apparaît donc ici sans étape de build intermédiaire.
 *
 * GET uniquement, public (même niveau d'exposition que le fichier
 * data/inventaire.json committé aujourd'hui — aucune donnée sensible,
 * lecture seule, rien n'est jamais écrit par cet endpoint).
 *
 * Pas d'ETag natif comme pour les endpoints R2 (voir lib/patch-endpoint.mjs,
 * qui reprend l'ETag déjà posé par R2 sur l'objet) : Postgres n'en fournit
 * pas, donc on en calcule un nous-même (sha256 du corps sérialisé) — même
 * contrat pour le client (If-None-Match → 304 sans corps si rien n'a changé).
 *
 * `s-maxage` nettement plus long que les six endpoints d'état partagé
 * (20s, sondés toutes les 45s par des pages internes) : l'inventaire ne
 * change qu'au rythme d'un import/rebuild, pas d'un scan — un cache CDN de
 * quelques minutes évite de solliciter la base à chaque visite du site public
 * sans rendre la page perceptiblement périmée pour autant.
 *
 * Cache mémoire (`lib/data-json-cache.mjs`, TTL 60 s) : mesuré en conditions
 * réelles, la requête SQL + le filtrage par liste blanche de
 * `exportInventaire()` + le `JSON.stringify` du résultat (21,2 Mo) coûtent
 * ensemble ~2,3 s à froid, et l'ETag ne fait qu'éviter le TRANSFERT du corps,
 * jamais son recalcul. Ce cache retient aussi les variantes compressées du
 * corps (voir lib/http-compress.mjs), pour que les ~760 ms de brotli ne
 * soient pas repayées non plus à chaque chargement de page.
 *
 * Compression (2026-09-23) : en hébergement local il n'y a plus de CDN pour
 * la poser, et ces 21,2 Mo partaient donc tels quels à chaque chargement de
 * inventaire.html. `sendCompressed()` les ramène à 2,4 Mo (brotli) ou 3,1 Mo
 * (gzip) — de loin le premier poste du temps de chargement de cette page.
 */
import { createHash } from 'node:crypto';
import { exportInventaire } from '../scripts/lib/export-inventaire.mjs';
import { getCached } from '../lib/data-json-cache.mjs';
import { sendCompressed } from '../lib/http-compress.mjs';

const CACHE_CONTROL = 'public, max-age=0, must-revalidate, s-maxage=120, stale-while-revalidate=600';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    res.status(405).json({ error: 'Méthode non supportée.' });
    return;
  }
  try {
    const body = await getCached('api/inventaire', async () => JSON.stringify(await exportInventaire()));
    const etag = `"${createHash('sha256').update(body.raw).digest('hex')}"`;

    res.setHeader('Cache-Control', CACHE_CONTROL);
    res.setHeader('ETag', etag);
    const ifNoneMatch = req.headers['if-none-match'];
    if (ifNoneMatch && ifNoneMatch.split(',').some(t => t.trim() === etag)) {
      res.status(304).end();
      return;
    }

    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    sendCompressed(req, res, body);
  } catch (err) {
    console.error('[api/inventaire]', err);
    res.status(500).json({ error: err.message || 'Erreur serveur.' });
  }
}
