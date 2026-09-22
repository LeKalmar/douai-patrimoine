/**
 * Parseur CSV RFC4180 minimal (champs entre guillemets, guillemet doublé "" =
 * un seul guillemet littéral, retours à la ligne et délimiteur autorisés dans
 * un champ cité). Aucune dépendance npm, cohérent avec le reste du projet
 * (scripts/lib/gesmarc.mjs, scripts/lib/marc-xml.mjs sont aussi écrits à la
 * main plutôt que d'ajouter une lib CSV).
 *
 * `csv/inventaire.csv` (24,5 Mo, ~25 000 lignes) est encore loin de la limite
 * de longueur d'une string V8 (contrairement à xml/bib.xml, plusieurs Go) —
 * lu entièrement en mémoire, pas en flux.
 */

export function parseCsv(text, { delimiter = ',' } = {}) {
  // Retire le BOM UTF-8 éventuel en tête de fichier.
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);

  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let sawAnyField = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];

    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else {
        field += c;
      }
      continue;
    }

    if (c === '"') { inQuotes = true; sawAnyField = true; continue; }
    if (c === delimiter) { row.push(field); field = ''; sawAnyField = true; continue; }
    if (c === '\r') continue; // normalise CRLF → LF
    if (c === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      sawAnyField = false;
      continue;
    }
    field += c;
    sawAnyField = true;
  }
  if (sawAnyField || field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** Parse en tableau d'objets, clés = ligne d'en-tête. */
export function parseCsvObjects(text, opts) {
  const rows = parseCsv(text, opts);
  if (!rows.length) return [];
  const header = rows[0];
  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (r.length === 1 && r[0] === '') continue; // ligne vide en fin de fichier
    const obj = {};
    for (let j = 0; j < header.length; j++) obj[header[j]] = r[j] ?? '';
    out.push(obj);
  }
  return out;
}
