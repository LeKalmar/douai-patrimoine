/**
 * magasin-classify.mjs
 * ────────────────────────────────────────────────────────────────────────────
 * Classification d'un exemplaire GESMARC (xml/bib.xml) comme relevant d'un
 * magasin d'étage (2e/5e/6e) ou non — logique partagée entre
 * scripts/build-magasins.mjs et scripts/build-desherbage.mjs, pour que les
 * deux scripts, qui lisent le même bib.xml, ne puissent jamais diverger sur
 * ce qui compte comme « magasin ». Extrait de build-magasins.mjs (seule
 * source jusqu'ici) le 2026-09-10, à l'introduction de build-desherbage.mjs
 * v2 — voir CLAUDE.md « Magasins 2e/5e/6e étage » pour le détail des règles.
 *
 * Aucune dépendance npm. Node ≥ 18.
 * ────────────────────────────────────────────────────────────────────────────
 */

// Sections de bib.xml qui correspondent aux magasins d'étage (2e/5e/6e).
export const MAGASIN_SECTIONS = ['Magasin', 'Magasin Jeunesse'];

// Le piège "en réserve" (Syracuse 921$b) compte aussi comme "en magasin", en
// plus des deux sections normales : demande explicite de l'équipe, un
// exemplaire marqué ainsi est physiquement traité comme du magasin même si
// sa Section (Libellé) Syracuse n'est pas "Magasin"/"Magasin Jeunesse".
// Champ "Pièges" en texte libre (peut combiner plusieurs pièges, ex. "Exclu
// DEFINITIVEMENT du prêt en réserve") — d'où un test par sous-chaîne
// insensible à la casse plutôt qu'une égalité stricte. Ne matche pas "Réserve
// Patrimoniale"/"Réserve Saint Exupery" (pas de "en" devant "réserve" dans
// ces libellés-là).
const PIEGE_EN_RESERVE_RE = /en réserve/i;

export function isPiegeEnReserve(piege) {
  return !!piege && PIEGE_EN_RESERVE_RE.test(piege);
}

export function isMagasin(section, piege) {
  return MAGASIN_SECTIONS.includes(section) || isPiegeEnReserve(piege);
}

// ── Filtre étage : la cote (jointe) désigne-t-elle un ouvrage 2e/5e étage ? ─
// Retourne le groupe de chiffres identifié (2e/5e étage) ou null (6e étage).
export function magasinDigitRun(cote) {
  if (!cote) return null;
  // Fusionne "1-2 chiffres.3 chiffres" (séparateur de milliers) en un seul
  // nombre. N'affecte pas un préfixe Dewey à 3 chiffres ("940.21" reste
  // "940" + "." + "21").
  const merged = cote.replace(/(?<!\d)(\d{1,2})\.(\d{3})(?!\d)/g, '$1$2');
  const runs = merged.match(/\d+/g) || [];
  for (let run of runs) {
    if (run.length === 7 && run[0] === '0') run = run.slice(1);
    if (run.length === 5 || run.length === 6) return run;
  }
  return null;
}

export function secteurLabel(section) {
  return section === 'Magasin Jeunesse' ? 'Jeunesse' : 'Adulte';
}

export function fondsLabel(digitRun, section) {
  const etage = digitRun ? '2e/5e étage' : '6e étage';
  return `Magasin — ${etage} (${secteurLabel(section)})`;
}
