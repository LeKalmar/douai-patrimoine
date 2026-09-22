#!/usr/bin/env node
/**
 * db-local.mjs
 * ────────────────────────────────────────────────────────────────────────────
 * Démarre/arrête le PostgreSQL local (installation portable, sans service
 * Windows) qui a remplacé Neon — voir .env (DATABASE_URL/DATABASE_URL_UNPOOLED
 * pointent sur localhost:5432). Contrairement à un service Windows, ce
 * serveur ne démarre pas tout seul à l'ouverture de session : à relancer à
 * chaque fois avant d'utiliser db-test.mjs/db-apply-schema.mjs/
 * db-migrate-*.mjs, ou un futur endpoint qui lirait cette base.
 *
 * Usage : node scripts/db-local.mjs start|stop|status
 *
 * Chemin d'installation configurable via PG_LOCAL_HOME (défaut : l'endroit où
 * le zip de binaires officiel a été extrait sur cette machine).
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

/* `stdio: 'inherit'` plutôt que la capture par pipe par défaut : pg_ctl
   start lance postgres.exe en arrière-plan, qui hérite sinon du pipe créé
   par Node pour capturer stdout/stderr — un pipe Windows ne signale l'EOF
   que quand TOUS les processus qui en détiennent une poignée l'ont fermée,
   serveur de longue durée compris. Résultat observé : spawnSync reste
   bloqué indéfiniment après un `start`, alors que pg_ctl a déjà rendu la
   main et que le serveur tourne bel et bien. `inherit` écrit directement
   sur les vraies poignées de la console (pas un pipe géré par Node), donc
   spawnSync ne dépend plus que de la fin de pg_ctl.exe lui-même. */

const HOME = process.env.PG_LOCAL_HOME || 'C:\\Logiciels\\postgresql-17.11-x64';
const BIN = `${HOME}\\bin\\pg_ctl.exe`;
const DATA = `${HOME}\\data`;
const LOG = `${HOME}\\server.log`;
const cmd = process.argv[2];

if (!existsSync(BIN)) {
  console.error(`✖ pg_ctl introuvable : ${BIN} (PostgreSQL local installé ailleurs ? PG_LOCAL_HOME=... node scripts/db-local.mjs ${cmd || 'start'})`);
  process.exit(1);
}

function run(args) {
  const r = spawnSync(BIN, args, { stdio: 'inherit' });
  return r.status;
}

switch (cmd) {
  case 'start':
    process.exit(run(['-D', DATA, '-l', LOG, '-o', '-p 5432', 'start']));
    break;
  case 'stop':
    process.exit(run(['-D', DATA, 'stop', '-m', 'fast']));
    break;
  case 'status':
    process.exit(run(['-D', DATA, 'status']));
    break;
  default:
    console.error('Usage : node scripts/db-local.mjs start|stop|status');
    process.exit(1);
}
