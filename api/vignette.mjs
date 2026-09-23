/**
 * Vignettes photo d'un exemplaire (voir la section "Photo" du formulaire
 * d'exemplarisation.html), stockées en deux tailles dans R2 :
 *   - "vignette/<code-barre>.jpg"       — pleine taille (1600px max)
 *   - "vignette-thumb/<code-barre>.jpg" — basse résolution (400px max),
 *     pour tout affichage en liste sans télécharger la version pleine taille
 *
 * POST : upload, authentifié (voir lib/auth.mjs) — au même niveau de
 * protection que l'écriture des autres données partagées (recolement,
 * exemplaires-manuels…). Corps JSON { barcode, imageBase64, thumbBase64 }
 * plutôt qu'un upload multipart : cohérent avec le reste de l'API du projet
 * (aucune dépendance npm de parsing multipart), et largement suffisant pour
 * des vignettes déjà redimensionnées/compressées côté client avant l'envoi.
 * `thumbBase64` est optionnel (accepté absent, pour ne jamais faire échouer
 * un upload existant qui ne l'enverrait pas).
 *
 * GET : lecture publique (même niveau d'exposition que les autres endpoints
 * d'état partagé) — /api/vignette?barcode=<code-barre>[&size=full|thumb],
 * répond directement l'image binaire (pas de JSON) avec ETag/304, `size`
 * valant `thumb` par défaut. Le bucket R2 n'est pas rendu public pour
 * autant : cet endpoint reste le seul chemin de lecture, signé côté serveur
 * comme le reste de lib/r2.mjs.
 */
import { r2Put, r2Get, r2Configured } from '../lib/r2.mjs';
import { requireAuth } from '../lib/auth.mjs';

const MAX_BYTES = 8 * 1024 * 1024; // 8 Mo décodés — large marge au-delà d'une vignette compressée côté client

class BadRequest extends Error {
  constructor(message) {
    super(message);
    this.status = 400;
  }
}

// N'autorise que les caractères déjà utilisés par les codes-barres de la
// réserve, pour qu'aucune valeur ne puisse s'échapper des préfixes
// "vignette/"/"vignette-thumb/" une fois insérée dans la clé R2.
function sanitizeBarcode(raw) {
  const bc = String(raw || '').trim();
  return /^[A-Za-z0-9_-]{1,64}$/.test(bc) ? bc : null;
}

function decodeImageBase64(value, fieldName) {
  const base64 = String(value).replace(/^data:image\/\w+;base64,/, '');
  const buffer = Buffer.from(base64, 'base64');
  if (!buffer.length) throw new BadRequest(`${fieldName} vide.`);
  if (buffer.length > MAX_BYTES) throw new BadRequest(`${fieldName} trop volumineux (${Math.round(buffer.length / 1024 / 1024)} Mo, max ${MAX_BYTES / 1024 / 1024} Mo).`);
  return buffer;
}

async function handlePost(req, res) {
  requireAuth(req);
  const body = req.body || {};
  const barcode = sanitizeBarcode(body.barcode);
  if (!barcode) throw new BadRequest('barcode invalide ou manquant (lettres, chiffres, "-", "_" uniquement).');
  if (!body.imageBase64 || typeof body.imageBase64 !== 'string') throw new BadRequest('imageBase64 requis.');

  const buffer = decodeImageBase64(body.imageBase64, 'imageBase64');
  const key = `vignette/${barcode}.jpg`;
  await r2Put(key, buffer, { contentType: 'image/jpeg' });

  let thumbKey = null;
  if (body.thumbBase64 && typeof body.thumbBase64 === 'string') {
    const thumbBuffer = decodeImageBase64(body.thumbBase64, 'thumbBase64');
    thumbKey = `vignette-thumb/${barcode}.jpg`;
    await r2Put(thumbKey, thumbBuffer, { contentType: 'image/jpeg' });
  }

  res.status(200).json({ ok: true, key, thumbKey });
}

async function handleGet(req, res) {
  const barcode = sanitizeBarcode(req.query.barcode);
  if (!barcode) throw new BadRequest('barcode invalide ou manquant (lettres, chiffres, "-", "_" uniquement).');
  const size = req.query.size === 'full' ? 'full' : 'thumb';
  const key = size === 'full' ? `vignette/${barcode}.jpg` : `vignette-thumb/${barcode}.jpg`;

  const obj = await r2Get(key, { raw: true });
  if (!obj) {
    res.status(404).json({ error: 'Vignette introuvable.' });
    return;
  }

  const ifNoneMatch = req.headers['if-none-match'];
  if (obj.etag && ifNoneMatch === obj.etag) {
    res.setHeader('ETag', obj.etag);
    res.status(304).end();
    return;
  }

  res.setHeader('Content-Type', 'image/jpeg');
  if (obj.etag) res.setHeader('ETag', obj.etag);
  // Même convention que les six endpoints d'état partagé (voir CLAUDE.md,
  // "Stockage partagé") : revalidation systématique côté navigateur, CDN
  // mutualisé 20s — une vignette peut être réécrasée (photo reprise) et ne
  // doit pas rester servie périmée depuis un cache long.
  res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate, s-maxage=20, stale-while-revalidate=60');
  res.status(200).send(obj.body);
}

export default async function handler(req, res) {
  if (!r2Configured()) {
    res.status(503).json({ error: 'R2 non configuré côté serveur (variables R2_* manquantes sur Vercel).' });
    return;
  }
  try {
    if (req.method === 'GET') {
      await handleGet(req, res);
    } else if (req.method === 'POST') {
      await handlePost(req, res);
    } else {
      res.setHeader('Allow', 'GET, POST');
      res.status(405).json({ error: 'Méthode non supportée.' });
    }
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || 'Erreur serveur.' });
  }
}
