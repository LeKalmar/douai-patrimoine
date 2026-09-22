/**
 * Serveur de développement local — remplace `vercel dev` pour ce projet.
 *
 * Sert les fichiers statiques à la racine (comme le ferait Vercel/Live
 * Server) ET exécute les fonctions serverless `api/*.mjs`/`api/*.js`
 * directement dans ce process Node, avec une couche de compatibilité
 * minimale (`req.query`, `req.body`, `res.status().json()`) qui reproduit
 * ce que fournit `@vercel/node` en production — aucune de ces fonctions
 * n'a besoin d'être modifiée.
 *
 * Pourquoi ce fichier plutôt que `vercel dev` : la CLI Vercel exige une
 * session connectée (`vercel login`) même pour servir en local, ce qui
 * bloque en environnement non interactif et va à l'encontre de l'objectif
 * de pouvoir tester sans dépendre d'un compte hébergé. Ce serveur n'a besoin
 * que de Node et du `.env` déjà présent — zéro dépendance npm, comme le
 * reste du projet.
 *
 * Usage : node scripts/dev-server.mjs [port]   (port par défaut : 3000)
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { createReadStream, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadDotEnv } from './lib/dotenv.mjs';
import { getCached } from '../lib/data-json-cache.mjs';
import { exportInventaire } from './lib/export-inventaire.mjs';
import { exportMagasins } from './lib/export-magasins.mjs';
import { exportCotesNumeriques } from './lib/export-cotes-numeriques.mjs';
import { exportDesherbage } from './lib/export-desherbage.mjs';
import { exportNonCatalogues } from './lib/export-non-catalogues.mjs';
import { exportLivresSpolies } from './lib/export-livres-spolies.mjs';
import { exportDbStatus } from './lib/export-db-status.mjs';

loadDotEnv();

/* Chantier postgres-local (voir le plan) : ces chemins /data/*.json ne sont
   plus lus depuis le fichier committé mais générés à la volée depuis
   Postgres, avec le même contrat HTTP (même URL, même forme de réponse) —
   aucune page HTML n'a besoin de changer. Le fichier committé reste sur
   disque en repli/référence tant que la parité n'est pas validée pour
   chaque phase (voir scripts/verify-json-parity.mjs). Registre volontairement
   un objet plutôt qu'un switch : les phases suivantes du chantier n'auront
   qu'à ajouter une entrée ici. */
const DATA_EXPORTERS = {
  '/data/inventaire.json': exportInventaire,
  '/data/magasins.json': exportMagasins,
  '/data/cotes-numeriques.json': exportCotesNumeriques,
  '/data/desherbage.json': exportDesherbage,
  '/data/non-catalogues.json': exportNonCatalogues,
  '/data/livres-spolies.json': exportLivresSpolies,
  '/data/db-status.json': exportDbStatus,
};

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const API_DIR = path.join(ROOT, 'api');
const PORT = Number(process.argv[2] || process.env.PORT || 3000);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.xml': 'application/xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.pdf': 'application/pdf',
  '.csv': 'text/csv; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

// ─── Couche de compatibilité "fonction Vercel" ─────────────────────────────

async function readJsonBody(req) {
  if (req.method === 'GET' || req.method === 'HEAD') return undefined;
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return undefined;
  const raw = Buffer.concat(chunks).toString('utf8');
  const type = req.headers['content-type'] || '';
  if (!raw) return undefined;
  if (type.includes('application/json') || !type) {
    try { return JSON.parse(raw); } catch { return raw; }
  }
  return raw;
}

function augmentResponse(res) {
  res.status = code => { res.statusCode = code; return res; };
  res.json = obj => {
    if (!res.getHeader('Content-Type')) res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(obj));
    return res;
  };
  res.send = body => {
    res.end(typeof body === 'string' ? body : JSON.stringify(body));
    return res;
  };
  return res;
}

async function resolveApiFile(name) {
  for (const ext of ['.mjs', '.js']) {
    const p = path.join(API_DIR, name + ext);
    if (existsSync(p)) return p;
  }
  return null;
}

async function handleApi(req, res, url) {
  const name = url.pathname.replace(/^\/api\//, '').replace(/\/$/, '');
  const file = await resolveApiFile(name);
  if (!file) {
    res.statusCode = 404;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ error: `Fonction inconnue : /api/${name}` }));
    return;
  }
  augmentResponse(res);
  req.query = Object.fromEntries(url.searchParams);
  try {
    req.body = await readJsonBody(req);
    // Cache-bust sur la date de modification (pas Date.now()) : un fichier
    // api/*.mjs édité pendant que le serveur tourne est repris à la requête
    // suivante, sans réimporter (et retenir en mémoire) un nouveau module à
    // chaque appel quand rien n'a changé.
    const mtime = (await stat(file)).mtimeMs;
    const mod = await import(pathToFileURL(file).href + `?v=${mtime}`);
    await mod.default(req, res);
  } catch (err) {
    console.error(`[api/${name}]`, err);
    if (!res.headersSent) {
      res.status(err.status || 500).json({ error: err.message || 'Erreur serveur.' });
    }
  }
}

// ─── Fichiers statiques ─────────────────────────────────────────────────────

async function handleStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/') rel = '/index.html';
  const filePath = path.normalize(path.join(ROOT, rel));
  if (!filePath.startsWith(ROOT)) {
    res.statusCode = 403;
    res.end('Forbidden');
    return;
  }
  try {
    const st = await stat(filePath);
    const finalPath = st.isDirectory() ? path.join(filePath, 'index.html') : filePath;
    const finalStat = st.isDirectory() ? await stat(finalPath) : st;
    if (!finalStat.isFile()) throw new Error('not a file');
    const ext = path.extname(finalPath).toLowerCase();
    res.setHeader('Content-Type', MIME[ext] || 'application/octet-stream');
    // Pas de mise en cache en dev local : on veut toujours voir la dernière
    // version d'un fichier édité, contrairement aux règles de vercel.json
    // pensées pour la prod.
    res.setHeader('Cache-Control', 'no-cache');
    createReadStream(finalPath).pipe(res);
  } catch {
    res.statusCode = 404;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end('<h1>404</h1><p>Fichier introuvable : ' + rel + '</p>');
  }
}

async function handleDataExport(req, res, exporter) {
  try {
    const body = await getCached(req.url, async () => JSON.stringify(await exporter()));
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.end(body);
  } catch (err) {
    console.error('[data-export]', err);
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ error: err.message || 'Erreur serveur.' }));
  }
}

// ─── Serveur ─────────────────────────────────────────────────────────────

const server = createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const exporter = req.method === 'GET' ? DATA_EXPORTERS[url.pathname] : null;
  if (exporter) {
    handleDataExport(req, res, exporter);
  } else if (url.pathname.startsWith('/api/')) {
    handleApi(req, res, url);
  } else {
    handleStatic(req, res, url);
  }
});

// Écoute sur toutes les interfaces par défaut (pas seulement 127.0.0.1) :
// nécessaire au test d'écriture concurrente multi-postes du chantier
// postgres-local (voir plan) — d'autres postes du réseau local doivent
// pouvoir ouvrir ce serveur. HOST=127.0.0.1 pour revenir au comportement
// précédent (dev solo, pas d'exposition réseau).
const HOST = process.env.HOST || '0.0.0.0';

server.listen(PORT, HOST, () => {
  const r2 = !!(process.env.R2_ACCOUNT_ID && process.env.R2_BUCKET && process.env.R2_ACCESS_KEY_ID && process.env.R2_SECRET_ACCESS_KEY);
  const admin = !!(process.env.ADMIN_USER && process.env.ADMIN_PASS);
  console.log(`\n  Réserve patrimoniale — serveur de dev local`);
  console.log(`  ────────────────────────────────────────────`);
  console.log(`  http://localhost:${PORT}`);
  if (HOST === '0.0.0.0') {
    console.log(`  Accessible aussi depuis le réseau local sur le port ${PORT}`);
    console.log(`  (voir l'IP de ce poste : ipconfig / Get-NetIPAddress) — nécessite`);
    console.log(`  une règle de pare-feu entrante sur ce port (privée, pas publique).`);
  }
  console.log(`  R2 (stockage partagé) : ${r2 ? 'configuré (.env)' : 'absent — GET renverra un état vide, POST échouera'}`);
  console.log(`  ADMIN_USER/ADMIN_PASS : ${admin ? 'configurés (.env)' : 'absents — /api/login refusera toute connexion'}`);
  console.log(`  Espace pro : ouvrez index.html, connectez-vous, puis les pages protégées.`);
  console.log(`  Ctrl+C pour arrêter.\n`);
});
