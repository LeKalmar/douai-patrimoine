/**
 * Sauvegardes datées du récolement, stockées dans R2 sous le préfixe
 * "recolement-backups/" — distinctes de l'état partagé courant (clé
 * "recolement.json" servie par api/recolement.mjs). Sert le bouton
 * « Sauvegarder ce récolement » de recolement.html (fige un instantané
 * daté) et la liste des dernières sauvegardes proposée pour charger un
 * « récolement de référence » sans avoir à exporter/réimporter un fichier
 * à la main.
 *
 * GET ?list=1[&count=5] → les sauvegardes les plus récentes (clé, date,
 *                          taille), public — même niveau d'exposition que
 *                          GET /api/recolement.
 * GET ?key=<clé>         → contenu JSON d'une sauvegarde précise.
 * POST                   → crée une nouvelle sauvegarde datée à partir du
 *                          corps JSON envoyé. Authentification requise.
 */
import { r2Get, r2Put, r2List, r2Configured } from '../lib/r2.mjs';
import { requireAuth } from '../lib/auth.mjs';

const PREFIX = 'recolement-backups/';

class BadRequest extends Error {
  constructor(message) {
    super(message);
    this.status = 400;
  }
}

function backupSlug(date) {
  const pad = n => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_${pad(date.getHours())}h${pad(date.getMinutes())}m${pad(date.getSeconds())}s`;
}

export default async function handler(req, res) {
  if (!r2Configured()) {
    res.status(503).json({ error: 'R2 non configuré côté serveur (variables R2_* manquantes sur Vercel).' });
    return;
  }
  try {
    if (req.method === 'GET') {
      const { key, list, count } = req.query || {};

      if (key) {
        if (typeof key !== 'string' || !key.startsWith(PREFIX)) throw new BadRequest('Clé invalide.');
        const obj = await r2Get(key);
        if (!obj) {
          res.status(404).json({ error: 'Sauvegarde introuvable.' });
          return;
        }
        res.status(200).json(JSON.parse(obj.body));
        return;
      }

      if (list) {
        const n = Math.min(parseInt(count, 10) || 5, 20);
        const items = await r2List(PREFIX, 200);
        items.sort((a, b) => (b.lastModified || '').localeCompare(a.lastModified || ''));
        res.status(200).json(items.slice(0, n).map(i => ({ key: i.key, lastModified: i.lastModified, size: i.size })));
        return;
      }

      throw new BadRequest('Paramètre "list" ou "key" requis.');
    }

    if (req.method === 'POST') {
      requireAuth(req);
      const data = req.body;
      if (!data || typeof data !== 'object') throw new BadRequest('Corps JSON attendu.');
      const key = `${PREFIX}${backupSlug(new Date())}.json`;
      await r2Put(key, JSON.stringify(data));
      res.status(200).json({ key });
      return;
    }

    res.setHeader('Allow', 'GET, POST');
    res.status(405).json({ error: 'Méthode non supportée.' });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || 'Erreur serveur.' });
  }
}
