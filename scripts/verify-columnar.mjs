/* Vérifie qu'un fichier colonnaire redonne EXACTEMENT les lignes d'origine.
   Usage : node scripts/verify-columnar.mjs <original.json> <colonnaire.json>
   Compare ligne à ligne, clé à clé, dans les deux sens — une clé en trop ou
   manquante est une erreur au même titre qu'une valeur différente. */
import { readFileSync, statSync } from 'node:fs';
import { loadColumnar } from './lib/load-columnar.mjs';

const [origPath, colPath] = process.argv.slice(2);
if (!origPath || !colPath) {
  console.error('usage: node scripts/verify-columnar.mjs <original.json> <colonnaire.json>');
  process.exit(2);
}
const columnar = loadColumnar();
const orig = JSON.parse(readFileSync(origPath, 'utf-8'));
const col = JSON.parse(readFileSync(colPath, 'utf-8'));

if (columnar.rowCount(col) !== orig.length) {
  console.error(`✖ nombre de lignes : ${columnar.rowCount(col)} vs ${orig.length}`);
  process.exit(1);
}

/* Comparaison profonde : certaines colonnes portent des objets (ex. `prets`
   dans data/desherbage.json) — les comparer avec !== reviendrait à comparer
   des références, jamais égales entre deux JSON.parse distincts. */
function deepEqual(a, b) {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a), kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every(k => deepEqual(a[k], b[k]));
}

let diffs = 0;
const report = [];
columnar.forEachRow(col, (row, i) => {
  const a = orig[i];
  const keys = new Set([...Object.keys(a), ...Object.keys(row)]);
  // Présence stricte : une clé absente de la ligne d'origine doit rester
  // absente après décodage (et non ressortir à null) — les exports MARC ont
  // des lignes de largeurs différentes, voir js/columnar.js.
  for (const k of keys) {
    if ((k in a) !== (k in row)) {
      diffs++;
      if (report.length < 5) report.push(`ligne ${i}, clé ${k} : présence ${k in a} → ${k in row}`);
      continue;
    }
    const va = a[k], vb = row[k];
    if (!deepEqual(va, vb)) {
      diffs++;
      if (report.length < 5) report.push(`ligne ${i}, clé ${k} : ${JSON.stringify(va)} → ${JSON.stringify(vb)}`);
    }
  }
});

const sO = statSync(origPath).size, sC = statSync(colPath).size;
console.log(`lignes .......... ${orig.length.toLocaleString('fr-FR')}`);
console.log(`différences ..... ${diffs}`);
report.forEach(r => console.log('   ' + r));
console.log(`taille .......... ${(sO / 1048576).toFixed(1)} Mo → ${(sC / 1048576).toFixed(1)} Mo  (−${100 - Math.round(sC * 100 / sO)} %)`);
if (diffs) { console.error('✖ Le fichier colonnaire ne redonne pas les lignes d’origine.'); process.exit(1); }

/* Isolation : deux lignes portant la même valeur objet doivent recevoir deux
   instances distinctes, comme le faisait JSON.parse avant ce format — sinon
   une modification faite par une page se propagerait à d'autres lignes. */
const objectKeys = col.keys ? col.keys.filter(k => col.columns[k].o) : [];
if (objectKeys.length && columnar.rowCount(col) >= 2) {
  const r0 = columnar.readRow(col, 0), r1 = columnar.readRow(col, 1);
  const r0bis = columnar.readRow(col, 0);
  for (const k of objectKeys) {
    if (r0[k] !== null && typeof r0[k] === 'object') {
      if (r0[k] === r1[k] || r0[k] === r0bis[k]) {
        console.error(`✖ colonne ${k} : instance partagée entre deux lectures — une mutation fuirait d'une ligne à l'autre.`);
        process.exit(1);
      }
    }
  }
  console.log(`isolation ....... ${objectKeys.length} colonne(s) à objets, instances distinctes ✓`);
}
console.log('✓ Round-trip exact : aucune donnée perdue.');
