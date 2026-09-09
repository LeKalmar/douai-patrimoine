/**
 * Upload d'une vignette (photo rognée d'un exemplaire, voir la section
 * "Photo" du formulaire d'exemplarisation.html) vers R2, sous la clé
 * "vignette/<code-barre>.jpg". Écrase silencieusement
 * une vignette existante pour le même code-barre (permet de reprendre une
 * photo ratée sans étape de suppression).
 *
 * POST uniquement, authentifié (voir lib/auth.mjs) — au même niveau de
 * protection que l'écriture des autres données partagées (recolement,
 * exemplaires-manuels…). Corps JSON { barcode, imageBase64 } plutôt qu'un
 * upload multipart : cohérent avec le reste de l'API du projet (aucune
 * dépendance npm de parsing multipart), et largement suffisant pour des
 * vignettes déjà redimensionnées/compressées côté client avant l'envoi.
 */
import { r2Put, r2Configured } from '../lib/r2.mjs';
import { requireAuth } from '../lib/auth.mjs';

const MAX_BYTES = 8 * 1024 * 1024; // 8 Mo décodés — large marge au-delà d'une vignette compressée côté client

class BadRequest extends Error {
  constructor(message) {
    super(message);
    this.status = 400;
  }
}

// N'autorise que les caractères déjà utilisés par les codes-barres de la
// réserve, pour qu'aucune valeur ne puisse s'échapper du préfixe "vignette/"
// une fois insérée dans la clé R2.
function sanitizeBarcode(raw) {
  const bc = String(raw || '').trim();
  return /^[A-Za-z0-9_-]{1,64}$/.test(bc) ? bc : null;
}

export default async function handler(req, res) {
  if (!r2Configured()) {
    res.status(503).json({ error: 'R2 non configuré côté serveur (variables R2_* manquantes sur Vercel).' });
    return;
  }
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    res.status(405).json({ error: 'Méthode non supportée.' });
    return;
  }
  try {
    requireAuth(req);
    const body = req.body || {};
    const barcode = sanitizeBarcode(body.barcode);
    if (!barcode) throw new BadRequest('barcode invalide ou manquant (lettres, chiffres, "-", "_" uniquement).');
    if (!body.imageBase64 || typeof body.imageBase64 !== 'string') throw new BadRequest('imageBase64 requis.');

    const base64 = body.imageBase64.replace(/^data:image\/\w+;base64,/, '');
    const buffer = Buffer.from(base64, 'base64');
    if (!buffer.length) throw new BadRequest('Image vide.');
    if (buffer.length > MAX_BYTES) throw new BadRequest(`Image trop volumineuse (${Math.round(buffer.length / 1024 / 1024)} Mo, max ${MAX_BYTES / 1024 / 1024} Mo).`);

    const key = `vignette/${barcode}.jpg`;
    await r2Put(key, buffer, { contentType: 'image/jpeg' });
    res.status(200).json({ ok: true, key });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || 'Erreur serveur.' });
  }
}
