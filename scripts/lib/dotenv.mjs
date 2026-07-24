/**
 * Chargeur .env minimal (sans dépendance npm) pour les scripts locaux
 * (upload-xml-to-r2.mjs, test-r2.mjs, build-inventory.mjs). N'écrase jamais
 * une variable déjà présente dans l'environnement (permet de surcharger en
 * ligne de commande : `R2_BUCKET=autre node scripts/...`).
 */
import { readFileSync, existsSync } from 'node:fs';

export function loadDotEnv(path = '.env') {
  if (!existsSync(path)) return;
  const content = readFileSync(path, 'utf8');
  content.split('\n').forEach(line => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;
    const eq = trimmed.indexOf('=');
    if (eq === -1) return;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  });
}
