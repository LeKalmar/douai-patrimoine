/* Charge js/columnar.js (script navigateur) dans un contexte Node, pour que
   les scripts de build encodent avec exactement le même code que celui qui
   décode dans les pages. Une seconde implémentation en ESM finirait par
   diverger de la première — et une divergence entre encodeur et décodeur se
   traduirait par des données illisibles. */
import { readFileSync } from 'node:fs';

export function loadColumnar() {
  const src = readFileSync(new URL('../../js/columnar.js', import.meta.url), 'utf-8');
  const scope = {};
  new Function('window', src)(scope);
  return scope.columnar;
}
