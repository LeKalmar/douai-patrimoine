#!/usr/bin/env node
/**
 * node scripts/test-r2.mjs
 *
 * Vérifie que le token R2 (dans .env) fonctionne réellement : écrit, relit
 * puis supprime un objet de test "_healthcheck.json". Ne touche à aucune
 * donnée réelle du bucket. À exécuter après avoir créé le token R2 et
 * renseigné .env, avant de configurer les mêmes variables sur Vercel.
 */
import { loadDotEnv } from './lib/dotenv.mjs';
import { r2Put, r2Get, r2Delete, r2Configured } from '../lib/r2.mjs';

loadDotEnv();

if (!r2Configured()) {
  console.error(
    'R2 non configuré : renseignez R2_ACCOUNT_ID, R2_BUCKET, R2_ACCESS_KEY_ID, ' +
    'R2_SECRET_ACCESS_KEY dans un fichier .env à la racine du projet (voir CLAUDE.md).'
  );
  process.exit(1);
}

const KEY = '_healthcheck.json';

try {
  const payload = JSON.stringify({ ok: true, ts: Date.now() });
  console.log('PUT _healthcheck.json…');
  await r2Put(KEY, payload);
  console.log('GET _healthcheck.json…');
  const got = await r2Get(KEY);
  if (!got || got.body !== payload) throw new Error('Le contenu relu ne correspond pas à ce qui a été écrit.');
  console.log('DELETE _healthcheck.json…');
  await r2Delete(KEY);
  console.log('✓ Le token R2 fonctionne (PUT/GET/DELETE réussis).');
} catch (err) {
  console.error('✗ Échec :', err.message);
  process.exit(1);
}
