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
 * quelques minutes évite de solliciter Neon à chaque visite du site public
 * sans rendre la page perceptiblement périmée pour autant.
 */
import { createHash } from 'node:crypto';
import { exportInventaire } from '../scripts/lib/export-inventaire.mjs';

const CACHE_CONTROL = 'public, max-age=0, must-revalidate, s-maxage=120, stale-while-revalidate=600';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    res.status(405).json({ error: 'Méthode non supportée.' });
    return;
  }
  try {
    const items = await exportInventaire();
    const body = JSON.stringify(items);
    const etag = `"${createHash('sha256').update(body).digest('hex')}"`;

    res.setHeader('Cache-Control', CACHE_CONTROL);
    res.setHeader('ETag', etag);
    const ifNoneMatch = req.headers['if-none-match'];
    if (ifNoneMatch && ifNoneMatch.split(',').some(t => t.trim() === etag)) {
      res.status(304).end();
      return;
    }

    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.status(200).send(body);
  } catch (err) {
    console.error('[api/inventaire]', err);
    res.status(500).json({ error: err.message || 'Erreur serveur.' });
  }
}
