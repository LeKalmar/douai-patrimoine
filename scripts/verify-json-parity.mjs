#!/usr/bin/env node
/**
 * verify-json-parity.mjs
 * ────────────────────────────────────────────────────────────────────────────
 * Compare, ligne à ligne et clé à clé, un fichier `data/*.json` committé et
 * la réponse générée à la volée depuis Postgres par scripts/dev-server.mjs —
 * doit être à 0 écart (hors écarts connus et documentés, listés
 * explicitement par jeu de données) avant de faire confiance à l'endpoint.
 *
 * Usage : node scripts/dev-server.mjs &            (serveur déjà lancé)
 *         node scripts/verify-json-parity.mjs inventaire
 *         node scripts/verify-json-parity.mjs magasins
 *         node scripts/verify-json-parity.mjs cotes-numeriques
 */
import { readFileSync } from 'node:fs';
import { loadColumnar } from './lib/load-columnar.mjs';
import { getPool, closeAllPools } from './lib/pg.mjs';

const PORT = process.env.PORT || 3000;

// codes-barres déjà présents comme source='reserve_marc' : db-migrate-bib.mjs
// n'insère jamais de ligne bib_xml pour eux (la réserve reste seule
// autorité), donc leur forme GESMARC d'origine (Section/Bibliothèque/Pièges
// telles que vues depuis bib.xml) n'est conservée nulle part en base — voir
// scripts/lib/export-magasins.mjs et export-cotes-numeriques.mjs. Écart
// connu et documenté, exclu explicitement plutôt que compté à tort.
async function reserveBarcodes() {
  const { rows } = await getPool({ unpooled: true }).query(
    `SELECT barcode FROM exemplaires WHERE source = 'reserve_marc' AND barcode IS NOT NULL`
  );
  return new Set(rows.map(r => r.barcode));
}

const DATASETS = {
  inventaire: {
    path: 'data/inventaire.json',
    url: `http://localhost:${PORT}/data/inventaire.json`,
    keyField: '995$f',
    columnar: false,
    ignoredKeys: new Set(['_itemId', '_joinType']),
    setKeys: new Set(['_relies']),
    excludeKnownGap: null,
  },
  magasins: {
    path: 'data/magasins.json',
    url: `http://localhost:${PORT}/data/magasins.json`,
    keyField: '915$b',
    columnar: true,
    ignoredKeys: new Set(),
    setKeys: new Set(),
    excludeKnownGap: reserveBarcodes,
  },
  'cotes-numeriques': {
    path: 'data/cotes-numeriques.json',
    url: `http://localhost:${PORT}/data/cotes-numeriques.json`,
    keyField: '915$b',
    columnar: true,
    ignoredKeys: new Set(),
    setKeys: new Set(),
    excludeKnownGap: reserveBarcodes,
  },
  desherbage: {
    path: 'data/desherbage.json',
    url: `http://localhost:${PORT}/data/desherbage.json`,
    keyField: '_barcode',
    columnar: true,
    ignoredKeys: new Set(),
    setKeys: new Set(),
    excludeKnownGap: reserveBarcodes,
  },
  'non-catalogues': {
    path: 'data/non-catalogues.json',
    url: `http://localhost:${PORT}/data/non-catalogues.json`,
    // Pas de clé naturelle unique : la cote (930$g) se répète ~2000 fois sur
    // les 10 090 lignes retenues (plusieurs pièces d'un même carton/registre
    // partagent parfois la même cote). Comparé comme un multi-ensemble de
    // lignes complètes plutôt que ligne-à-ligne par clé — voir `multiset`.
    multiset: true,
    columnar: false,
  },
  // Écart ATTENDU sur ce jeu de données : data/livres-spolies.json (base
  // .ods) n'a jamais contenu les overrides (elles ne vivaient que sur R2,
  // livres-spolies-overrides.json, fusionnées côté client par
  // livres-spolies.html) — la version live les fusionne déjà (voir
  // db-migrate-spolies.mjs), donc "statique vide / live rempli" sur
  // coteBM/trouve/exLibris/possesseur est normal, pas un défaut de parité.
  // Vérifié manuellement (2026-09-22) : live == base+overrides fusionnées en
  // JS, 0 écart sur les 506 lignes.
  'livres-spolies': {
    path: 'data/livres-spolies.json',
    url: `http://localhost:${PORT}/data/livres-spolies.json`,
    keyField: 'id',
    columnar: false,
    ignoredKeys: new Set(),
    setKeys: new Set(),
    excludeKnownGap: null,
  },
};

function byKey(rows, keyField) {
  const m = new Map();
  for (const r of rows) {
    const k = r[keyField];
    if (k) m.set(k, r);
  }
  return m;
}

function normalize(key, value, setKeys) {
  if (setKeys.has(key) && Array.isArray(value)) return [...value].sort();
  return value;
}

function diffRow(a, b, ignoredKeys, setKeys) {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  const diffs = [];
  for (const k of keys) {
    if (ignoredKeys.has(k)) continue;
    const av = normalize(k, a[k], setKeys), bv = normalize(k, b[k], setKeys);
    if (JSON.stringify(av) !== JSON.stringify(bv)) {
      diffs.push(`${k}: statique=${JSON.stringify(av)} live=${JSON.stringify(bv)}`);
    }
  }
  return diffs;
}

async function loadRows(source, path, url, columnar) {
  const raw = source === 'static'
    ? JSON.parse(readFileSync(path, 'utf8'))
    : await (await fetch(url)).json();
  if (!columnar) return raw;
  return loadColumnar().decode(raw);
}

async function main() {
  const name = process.argv[2];
  const cfg = DATASETS[name];
  if (!cfg) {
    console.error(`Usage: node scripts/verify-json-parity.mjs <${Object.keys(DATASETS).join('|')}>`);
    process.exit(1);
  }

  console.log(`▶ verify-json-parity (${name}): démarrage`);
  console.log(`  · lecture ${cfg.path}`);
  const staticRows = await loadRows('static', cfg.path, cfg.url, cfg.columnar);
  console.log(`  · fetch ${cfg.url}`);
  const liveRows = await loadRows('live', cfg.path, cfg.url, cfg.columnar);
  console.log(`  · ${staticRows.length} lignes statiques, ${liveRows.length} lignes live`);

  if (cfg.multiset) {
    // Pas de clé naturelle : trie chaque ligne (clés triées) puis l'ensemble,
    // pour que seul le CONTENU compte, jamais l'ordre des lignes ni celui de
    // leurs clés.
    const sortRow = r => JSON.stringify(Object.fromEntries(Object.keys(r).sort().map(k => [k, r[k]])));
    const staticSorted = staticRows.map(sortRow).sort();
    const liveSorted = liveRows.map(sortRow).sort();
    const ok = staticRows.length === liveRows.length && staticSorted.every((v, i) => v === liveSorted[i]);
    if (!ok) {
      console.log(`\n  Comparaison en multi-ensemble : ${ok ? 'identique' : 'DIFFÉRENT'}`);
      for (let i = 0; i < Math.min(staticSorted.length, liveSorted.length); i++) {
        if (staticSorted[i] !== liveSorted[i]) {
          console.log(`   - première ligne différente (rang ${i}) :`);
          console.log(`     statique=${staticSorted[i]}`);
          console.log(`     live=${liveSorted[i]}`);
          break;
        }
      }
    }
    console.log(ok ? `\n✓ verify-json-parity (${name}): 0 écart` : `\n✖ verify-json-parity (${name}): écarts détectés`);
    await closeAllPools();
    process.exit(ok ? 0 : 1);
  }

  let excluded = new Set();
  if (cfg.excludeKnownGap) {
    excluded = await cfg.excludeKnownGap();
    console.log(`  · ${excluded.size} code(s)-barres exclus de la comparaison (écart connu, voir en-tête du fichier)`);
  }

  const staticByKey = byKey(staticRows.filter(r => !excluded.has(r[cfg.keyField])), cfg.keyField);
  const liveByKey = byKey(liveRows.filter(r => !excluded.has(r[cfg.keyField])), cfg.keyField);

  const onlyStatic = [...staticByKey.keys()].filter(k => !liveByKey.has(k));
  const onlyLive = [...liveByKey.keys()].filter(k => !staticByKey.has(k));

  let rowsWithDiffs = 0;
  let totalFieldDiffs = 0;
  const samples = [];
  for (const [k, staticRow] of staticByKey) {
    const liveRow = liveByKey.get(k);
    if (!liveRow) continue;
    const diffs = diffRow(staticRow, liveRow, cfg.ignoredKeys, cfg.setKeys);
    if (diffs.length) {
      rowsWithDiffs++;
      totalFieldDiffs += diffs.length;
      if (samples.length < 10) samples.push({ key: k, diffs });
    }
  }

  console.log(`\n  Clés seulement dans le fichier statique : ${onlyStatic.length}`);
  if (onlyStatic.length) console.log('    ' + onlyStatic.slice(0, 10).join(', '));
  console.log(`  Clés seulement dans la réponse live      : ${onlyLive.length}`);
  if (onlyLive.length) console.log('    ' + onlyLive.slice(0, 10).join(', '));
  console.log(`  Lignes avec au moins un écart de champ   : ${rowsWithDiffs}`);
  console.log(`  Écarts de champ au total                 : ${totalFieldDiffs}`);

  if (samples.length) {
    console.log('\n  Exemples :');
    for (const s of samples) console.log(`   - ${s.key}: ${s.diffs.join(' | ')}`);
  }

  const ok = onlyStatic.length === 0 && onlyLive.length === 0 && rowsWithDiffs === 0;
  console.log(ok ? `\n✓ verify-json-parity (${name}): 0 écart` : `\n✖ verify-json-parity (${name}): écarts détectés`);
  await closeAllPools();
  process.exit(ok ? 0 : 1);
}

main().catch(async err => {
  console.error('✖ verify-json-parity:', err.message);
  await closeAllPools();
  process.exit(1);
});
