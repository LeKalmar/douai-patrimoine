/**
 * Vérification des appels vers /api/* : Authorization: Basic <user:pass>,
 * comparé à process.env.ADMIN_USER / ADMIN_PASS (jamais commités — distincts
 * des constantes en clair dans index.html, qui ne sont qu'un gate côté
 * client, décision produit déjà actée dans CLAUDE.md). C'est ce contrôle
 * serveur, et non le gate client trivialement contournable, qui protège
 * réellement l'écriture dans R2.
 */
import { timingSafeEqual } from 'node:crypto';

export class AuthError extends Error {
  constructor(message) {
    super(message);
    this.status = 401;
  }
}

function safeEqual(a, b) {
  const bufA = Buffer.from(a || '', 'utf8');
  const bufB = Buffer.from(b || '', 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/** Lève une AuthError si l'en-tête Authorization est absent ou invalide. */
export function requireAuth(req) {
  const header = req.headers && (req.headers.authorization || req.headers.Authorization);
  if (!header || !header.startsWith('Basic ')) {
    throw new AuthError('Authentification requise (en-tête Authorization manquant).');
  }

  const expectedUser = process.env.ADMIN_USER;
  const expectedPass = process.env.ADMIN_PASS;
  if (!expectedUser || !expectedPass) {
    throw new AuthError('ADMIN_USER / ADMIN_PASS non configurés côté serveur (variables Vercel).');
  }

  let decoded;
  try {
    decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
  } catch {
    throw new AuthError('En-tête Authorization invalide.');
  }
  const sep = decoded.indexOf(':');
  const user = sep === -1 ? decoded : decoded.slice(0, sep);
  const pass = sep === -1 ? '' : decoded.slice(sep + 1);

  if (!safeEqual(user, expectedUser) || !safeEqual(pass, expectedPass)) {
    throw new AuthError('Identifiants invalides.');
  }
}
