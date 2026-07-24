/**
 * Vérification des appels vers /api/* : Authorization: Basic <user:pass>,
 * comparé à process.env.ADMIN_USER / ADMIN_PASS (jamais commités). Utilisé
 * pour authentifier les POST vers /api/recolement et /api/spolies, et par
 * /api/login (voir api/login.mjs) qui vérifie le formulaire de connexion de
 * index.html côté serveur — les identifiants ne sont donc plus en clair
 * dans le JavaScript client (contrairement à l'ancienne version). Le gate
 * des pages protégées (`sessionStorage.getItem('rp_admin_auth') === '1'`)
 * reste, lui, un simple indicateur côté client, trivialement contournable
 * sans connaître le mot de passe — voir CLAUDE.md, section Sécurité. C'est
 * ce contrôle serveur, pas le gate client, qui protège réellement
 * l'écriture dans R2.
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

/** true si ADMIN_USER / ADMIN_PASS sont bien définis côté serveur. */
export function isServerConfigured() {
  return !!(process.env.ADMIN_USER && process.env.ADMIN_PASS);
}

/** Compare (user, pass) à ADMIN_USER / ADMIN_PASS. false si non configuré. */
export function credentialsMatch(user, pass) {
  if (!isServerConfigured()) return false;
  return safeEqual(user, process.env.ADMIN_USER) && safeEqual(pass, process.env.ADMIN_PASS);
}

function decodeBasicHeader(header) {
  let decoded;
  try {
    decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
  } catch {
    return null;
  }
  const sep = decoded.indexOf(':');
  return { user: sep === -1 ? decoded : decoded.slice(0, sep), pass: sep === -1 ? '' : decoded.slice(sep + 1) };
}

/** Lève une AuthError si l'en-tête Authorization est absent ou invalide. */
export function requireAuth(req) {
  const header = req.headers && (req.headers.authorization || req.headers.Authorization);
  if (!header || !header.startsWith('Basic ')) {
    throw new AuthError('Authentification requise (en-tête Authorization manquant).');
  }
  if (!isServerConfigured()) {
    throw new AuthError('ADMIN_USER / ADMIN_PASS non configurés côté serveur (variables Vercel).');
  }

  const creds = decodeBasicHeader(header);
  if (!creds) throw new AuthError('En-tête Authorization invalide.');

  if (!credentialsMatch(creds.user, creds.pass)) {
    throw new AuthError('Identifiants invalides.');
  }
}
