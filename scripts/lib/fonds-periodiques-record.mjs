/**
 * fonds-periodiques-record.mjs
 * ────────────────────────────────────────────────────────────────────────────
 * Transforme une ligne brute de csv/periodiques.csv (registre au niveau
 * TITRE — une ligne par périodique, pas par exemplaire physique : period-id,
 * nom, ville, fréquence, date de première/dernière parution, imprimeur/
 * imprimeur2/imprimeur3, date changement d'imprimeur, cote, notes, source1)
 * en un enregistrement dans les mêmes clés UNIMARC que data/inventaire.json
 * (200$a, 930$g…) — même patron que scripts/lib/fonds-car-record.mjs.
 *
 * Fonction pure, appelée par scripts/lib/export-inventaire.mjs
 * (`exportInventaire()`, servie en direct par api/inventaire.mjs).
 * `exemplaires.raw`, pour une ligne `source_ref LIKE 'fonds-periodiques-%'`,
 * EST exactement la ligne CSV brute (scripts/db-migrate-fonds-periodiques.mjs
 * stocke `JSON.stringify(row)` sans transformation), donc directement
 * passable à cette fonction sans étape intermédiaire.
 *
 * Sans cote (930$g), un document reste — comme pour les autres fonds — non
 * localisable en réserve et masqué de l'inventaire public (voir le filtre
 * `930$g` dans js/inventaire-page.js) : décision explicite de l'équipe
 * (2026-09-23) de garder cette règle pour ce fonds malgré le faible taux de
 * remplissage (8/100 lignes sur l'export du 2026-09-09) — les 92 lignes
 * restantes restent pleinement conservées en base (exemplaires.raw), juste
 * non affichées tant qu'aucune cote ne leur est attribuée.
 *
 * `ville` et `imprimeur`/`imprimeur2`/`imprimeur3` sont des CODES numériques
 * dans ce registre, pas des noms — résolus ici via csv/Lieux.csv (com-id →
 * Nom/Département/Pays) et csv/Imprimeries.csv (N° → Nom), exactement le
 * même mécanisme que js/main.js (formatLieu()/imprimeriesMap, page
 * histoire-du-livre.html) plutôt qu'une redite indépendante — un code
 * d'imprimerie absent de la table (ex. 38, 44 sur cet export) est affiché
 * "Imprimerie n°<code>" en repli, comme sur cette même page. Le code brut
 * n'est jamais perdu : il reste dans exemplaires.raw via db-migrate-fonds-
 * periodiques.mjs, cette résolution n'a lieu qu'à l'export/affichage.
 *
 * Depuis 2026-09-23, ce module couvre aussi csv/periodiques2.csv — un
 * second registre, distinct, qui donne les COTES réellement détenues par la
 * bibliothèque (Titre, Périodicité, Nombre de volumes, Cote, Date de
 * parution — les deux premières colonnes vides sur tout l'export du
 * 2026-09-23). `normalizeTitreForMatch()` sert à rapprocher ses titres de
 * ceux de periodiques.csv (voir scripts/db-migrate-fonds-periodiques.mjs,
 * qui fait ce rapprochement et fusionne la cote sur la ligne periodiques.csv
 * correspondante plutôt que de dupliquer l'entrée) ; `buildFondsPeriodique2Record()`
 * transforme les lignes qui n'ont PAS de correspondance en nouvelles entrées
 * à part entière — periodiques2.csv est alors leur seule source.
 *
 * Aucune dépendance npm. Node ≥ 18.
 * ────────────────────────────────────────────────────────────────────────────
 */
import { readFileSync } from 'node:fs';
import { parseCsvObjects } from './csv.mjs';
import { typeDocumentLabelOf } from './type-document-labels.mjs';

export const FONDS_PERIODIQUES_LABEL = 'Périodiques';

// ── Référentiels (chargés une fois, fichiers minuscules — voir js/main.js
//    pour le même mécanisme côté navigateur) ─────────────────────────────
function loadLieuxMap() {
  const text = readFileSync('csv/Lieux.csv', 'latin1'); // ISO-8859-1, vérifié (Lieux.csv n'est pas UTF-8, contrairement à periodiques.csv/Imprimeries.csv)
  const map = new Map();
  for (const row of parseCsvObjects(text, { delimiter: ';' })) {
    if (row['com-id']) map.set(row['com-id'].trim(), row);
  }
  return map;
}

function loadImprimeriesMap() {
  const text = readFileSync('csv/Imprimeries.csv', 'utf-8');
  const map = new Map();
  for (const row of parseCsvObjects(text, { delimiter: ';' })) {
    if (row['N°']) map.set(row['N°'].trim(), row['Nom']);
  }
  return map;
}

const LIEUX = loadLieuxMap();
const IMPRIMERIES = loadImprimeriesMap();

// Même format que formatLieu() dans js/main.js : "Nom (Département, Pays)".
export function resolveVille(code) {
  const c = (code || '').trim();
  if (!c) return null;
  const lieu = LIEUX.get(c);
  if (!lieu) return c; // code inconnu : affiché tel quel plutôt que masqué
  const extras = [lieu['Département'], lieu['Pays']].filter(v => v && v.trim());
  return extras.length ? `${lieu['Nom']} (${extras.join(', ')})` : lieu['Nom'];
}

export function resolveImprimeur(code) {
  const c = (code || '').trim();
  if (!c) return null;
  return IMPRIMERIES.get(c) || `Imprimerie n°${c}`;
}

function clean(v) {
  return (v || '').replace(/\s+/g, ' ').trim();
}

// csv/periodiques.csv donne des dates complètes JJ/MM/AAAA (ou MM/AAAA),
// parfois une notation libre sans slash ("ap1896" = après 1896, ou déjà une
// simple année) — trop précis pour l'inventaire public, qui n'affiche que
// l'année (demande explicite, 2026-09-23). On ne garde que ce qui suit le
// dernier "/" (JJ/MM/AAAA → AAAA, MM/AAAA → AAAA) ; une notation sans slash
// est déjà réduite à l'année ou à un texte libre, donc laissée telle quelle.
function yearOnly(raw) {
  const s = clean(raw);
  if (!s) return s;
  const idx = s.lastIndexOf('/');
  return idx === -1 ? s : s.slice(idx + 1);
}

// "Le Vrai Gayant" porte une cote CSV corrompue sur l'export du 2026-09-09 :
// le même jeton répété 7 fois, séparé par des retours à la ligne littéraux
// dans le champ cité (copier-coller malheureux dans le tableur d'origine).
// Réduit à un seul exemplaire plutôt que reproduit tel quel ; un futur export
// sans ce défaut passe ici sans effet.
function dedupeCote(raw) {
  const c = clean(raw);
  if (!c) return '';
  const parts = c.split(/\s+/);
  return (parts.length > 1 && parts.every(p => p === parts[0])) ? parts[0] : c;
}

/**
 * @param {Record<string,string>} row - une ligne de csv/periodiques.csv (ou
 *   son équivalent stocké tel quel dans exemplaires.raw)
 * @returns {object|null} null si la ligne n'a pas de cote
 */
export function buildFondsPeriodiqueRecord(row) {
  // _coteFromPeriodiques2 (voir scripts/db-migrate-fonds-periodiques.mjs) :
  // cote rapprochée de csv/periodiques2.csv par titre, prioritaire sur la
  // cote propre de periodiques.csv quand les deux existent (periodiques2
  // donne les cotes réellement détenues, potentiellement plus à jour) — la
  // cote d'origine, elle, reste visible telle quelle dans row['cote'].
  const cote = dedupeCote(row['_coteFromPeriodiques2'] || row['cote']);
  if (!cote) return null;

  const titre = clean(row['nom']) || cote;

  const debut = yearOnly(row['date de première parution']);
  const fin = yearOnly(row['date de dernière parution']);
  // Même année aux deux bouts (ex. "01/10/1865" → "01/10/1865") : un seul
  // millésime suffit, "1865 – 1865" n'apporterait rien.
  const parution = debut && fin
    ? (debut === fin ? debut : `${debut} – ${fin}`)
    : (debut || fin || null);

  const frequence = clean(row['fréquence']) || null;
  const villeLabel = resolveVille(row['ville']);
  const notes = clean(row['notes']) || null;

  const imprimeurNames = ['imprimeur', 'imprimeur2', 'imprimeur3']
    .map(k => clean(row[k]))
    .filter(Boolean)
    .map(resolveImprimeur);
  const dateChangement = clean(row["date changement d'imprimeur"]);
  let imprimeurLabel = imprimeurNames.length ? imprimeurNames.join(', ') : null;
  if (imprimeurLabel && dateChangement) imprimeurLabel += ` (jusqu'au ${dateChangement})`;

  return {
    '930$g': cote,
    '200$a': titre,
    // Affiché tel quel dans la colonne "Année" de l'inventaire public — la
    // même valeur que _parution ci-dessous (demande explicite, 2026-09-23 :
    // afficher début ET fin, pas seulement la première parution).
    '210$d': parution,
    '300$a': notes,
    _fondsLabel: FONDS_PERIODIQUES_LABEL,
    _typeDocument: typeDocumentLabelOf('PER'),
    // Champs dérivés propres aux périodiques (pas d'équivalent UNIMARC
    // affiché ailleurs sur le site) — voir DETAIL_COLS dans js/inventaire.js.
    _frequence: frequence,
    _parution: parution,
    _villeLabel: villeLabel,
    _imprimeurLabel: imprimeurLabel,
    _nonCatalogue: true,
  };
}

// ── csv/periodiques2.csv ────────────────────────────────────────────────

function stripDiacritics(s) {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

/**
 * Normalise un titre pour comparaison entre periodiques.csv ("nom") et
 * periodiques2.csv ("Titre") — les deux registres n'écrivent pas l'article
 * de la même façon ("Le Vrai Gayant" vs "Vrai Gayant (Le)"). Insensible à la
 * casse et aux accents, article ("le"/"la"/"les"/"l'") retiré qu'il soit en
 * tête ou entre parenthèses en fin de titre plutôt que réordonné — comparer
 * deux chaînes sans article est plus simple et tout aussi discriminant que
 * de reconstituer un ordre canonique.
 */
export function normalizeTitreForMatch(raw) {
  let s = stripDiacritics(String(raw || '')).toLowerCase();
  s = s.replace(/[.,:;!?"«»…]/g, ' ');
  s = s.replace(/\((le|la|les|l['’])\)/g, ' ');
  s = s.replace(/^(?:le|la|les)\s+/, '');
  s = s.replace(/^l['’]/, '');
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

// Un "Date de parution" de periodiques2.csv est un texte libre ("1882-1884",
// "en cours", "juin 1980- juin 1982", voire "30103" — un nombre de série
// Excel manifestement fautif sur une ligne de l'export du 2026-09-23) : on
// n'en extrait une année que si elle tombe dans une plage plausible, plutôt
// que le premier groupe de 4 chiffres consécutifs (qui prendrait "3010" au
// sein de "30103") — même précaution que yearFromTitle() dans
// thematiques/vues-de-douai.html.
function plausibleYear(raw) {
  const m = String(raw || '').match(/(1[4-9]\d{2}|20[0-2]\d)/);
  return m ? m[1] : null;
}

/**
 * @param {Record<string,string>} row - une ligne de csv/periodiques2.csv
 * @returns {object|null} null si la ligne n'a pas de cote
 */
export function buildFondsPeriodique2Record(row) {
  const cote = clean(row['Cote']);
  if (!cote) return null;

  const titre = clean(row['Titre']) || cote;
  const parutionRaw = clean(row['Date de parution']) || null;

  return {
    '930$g': cote,
    '200$a': titre,
    '210$d': plausibleYear(parutionRaw),
    _fondsLabel: FONDS_PERIODIQUES_LABEL,
    _typeDocument: typeDocumentLabelOf('PER'),
    // Ni fréquence, ni ville, ni imprimeur sur ce registre (colonnes vides
    // sur tout l'export du 2026-09-23) — seule la date de parution existe.
    _parution: parutionRaw,
    _nonCatalogue: true,
  };
}
