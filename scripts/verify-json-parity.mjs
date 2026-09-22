#!/usr/bin/env node
/**
 * verify-json-parity.mjs
 * ────────────────────────────────────────────────────────────────────────────
 * Compare, ligne à ligne et clé à clé, le fichier `data/inventaire.json`
 * committé et la réponse générée à la volée depuis Postgres par
 * scripts/dev-server.mjs (voir scripts/lib/export-inventaire.mjs) — doit être
 * à 0 écart avant de faire confiance à l'endpoint (voir phase 1 du plan
 * postgres-local).
 *
 * Les lignes sont appariées par code-barre (`995$f`), pas par position — le
 * fichier statique et la requête SQL n'ont aucune raison de produire le même
 * ordre. `_itemId`/`_joinType` sont explicitement exclus de la comparaison
 * (voir le commentaire en tête de scripts/lib/export-inventaire.mjs :
 * présents dans le fichier committé mais jamais lus par aucune page, et non
 * reconstructibles depuis les colonnes Postgres actuelles).
 *
 * Usage : node scripts/dev-server.mjs &            (serveur déjà lancé)
 *         node scripts/verify-json-parity.mjs
 */
import { readFileSync } from 'node:fs';

const IGNORED_KEYS = new Set(['_itemId', '_joinType']);
const PORT = process.env.PORT || 3000;
const URL_LIVE = `http://localhost:${PORT}/data/inventaire.json`;
const STATIC_PATH = 'data/inventaire.json';

function byBarcode(rows) {
  const m = new Map();
  for (const r of rows) {
    const bc = r['995$f'];
    if (bc) m.set(bc, r);
  }
  return m;
}

// _relies (autres codes-barres du même groupe de reliure) : l'ordre vient de
// l'itération d'un Union-Find côté build XML, sans signification (le seul
// usage, la cascade de recolement.html, boucle sur la liste sans se soucier
// de l'ordre) — comparé comme un ensemble, pas un tableau ordonné.
const SET_KEYS = new Set(['_relies']);

function normalize(key, value) {
  if (SET_KEYS.has(key) && Array.isArray(value)) return [...value].sort();
  return value;
}

function diffRow(a, b) {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  const diffs = [];
  for (const k of keys) {
    if (IGNORED_KEYS.has(k)) continue;
    const av = normalize(k, a[k]), bv = normalize(k, b[k]);
    if (JSON.stringify(av) !== JSON.stringify(bv)) {
      diffs.push(`${k}: statique=${JSON.stringify(av)} live=${JSON.stringify(bv)}`);
    }
  }
  return diffs;
}

async function main() {
  console.log('▶ verify-json-parity: démarrage');
  console.log(`  · lecture ${STATIC_PATH}`);
  const staticRows = JSON.parse(readFileSync(STATIC_PATH, 'utf8'));
  console.log(`  · fetch ${URL_LIVE}`);
  const liveRes = await fetch(URL_LIVE);
  if (!liveRes.ok) throw new Error(`Réponse live non-OK : ${liveRes.status}`);
  const liveRows = await liveRes.json();

  console.log(`  · ${staticRows.length} lignes statiques, ${liveRows.length} lignes live`);

  const staticByBc = byBarcode(staticRows);
  const liveByBc = byBarcode(liveRows);

  const onlyStatic = [...staticByBc.keys()].filter(bc => !liveByBc.has(bc));
  const onlyLive = [...liveByBc.keys()].filter(bc => !staticByBc.has(bc));

  let rowsWithDiffs = 0;
  let totalFieldDiffs = 0;
  const samples = [];
  for (const [bc, staticRow] of staticByBc) {
    const liveRow = liveByBc.get(bc);
    if (!liveRow) continue;
    const diffs = diffRow(staticRow, liveRow);
    if (diffs.length) {
      rowsWithDiffs++;
      totalFieldDiffs += diffs.length;
      if (samples.length < 10) samples.push({ barcode: bc, diffs });
    }
  }

  console.log(`\n  Codes-barres seulement dans le fichier statique : ${onlyStatic.length}`);
  if (onlyStatic.length) console.log('    ' + onlyStatic.slice(0, 10).join(', '));
  console.log(`  Codes-barres seulement dans la réponse live      : ${onlyLive.length}`);
  if (onlyLive.length) console.log('    ' + onlyLive.slice(0, 10).join(', '));
  console.log(`  Lignes avec au moins un écart de champ           : ${rowsWithDiffs}`);
  console.log(`  Écarts de champ au total                         : ${totalFieldDiffs}`);

  if (samples.length) {
    console.log('\n  Exemples :');
    for (const s of samples) {
      console.log(`   - ${s.barcode}: ${s.diffs.join(' | ')}`);
    }
  }

  const ok = onlyStatic.length === 0 && onlyLive.length === 0 && rowsWithDiffs === 0;
  console.log(ok ? '\n✓ verify-json-parity: 0 écart' : '\n✖ verify-json-parity: écarts détectés');
  process.exit(ok ? 0 : 1);
}

main().catch(err => {
  console.error('✖ verify-json-parity:', err.message);
  process.exit(1);
});
