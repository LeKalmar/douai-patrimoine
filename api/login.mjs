/**
 * Vérifie le formulaire de connexion de l'espace professionnel côté
 * serveur, contre process.env.ADMIN_USER / ADMIN_PASS — pour que ces
 * identifiants ne soient plus en clair dans le JavaScript de index.html
 * (contrairement à l'ancienne version, visible via "voir le code source").
 *
 * Ne pose pas de cookie de session : en cas de succès, le client (index.html)
 * construit lui-même le jeton Basic à partir de ce qu'il vient de saisir
 * (déjà en sa possession) et le garde en sessionStorage, comme avant — cet
 * endpoint ne fait que dire si les identifiants saisis sont corrects.
 *
 * Le gate des pages protégées (`sessionStorage.rp_admin_auth`) reste un
 * simple indicateur côté client, contournable sans mot de passe — voir
 * CLAUDE.md. Ce que cet endpoint empêche, c'est de pouvoir lire le mot de
 * passe dans le code source ; il ne rend pas les pages elles-mêmes plus
 * protégées.
 */
import { credentialsMatch, isServerConfigured } from '../lib/auth.mjs';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    res.status(405).json({ ok: false, error: 'Méthode non supportée.' });
    return;
  }
  if (!isServerConfigured()) {
    res.status(503).json({ ok: false, error: 'ADMIN_USER / ADMIN_PASS non configurés côté serveur (variables Vercel).' });
    return;
  }

  const { user, pass } = req.body || {};
  if (typeof user !== 'string' || typeof pass !== 'string') {
    res.status(400).json({ ok: false, error: 'Identifiant et mot de passe requis.' });
    return;
  }

  if (credentialsMatch(user, pass)) {
    res.status(200).json({ ok: true });
  } else {
    res.status(401).json({ ok: false, error: 'Identifiants invalides.' });
  }
}
