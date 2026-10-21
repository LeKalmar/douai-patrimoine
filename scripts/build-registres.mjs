#!/usr/bin/env node
/**
 * build-registres.mjs
 * ────────────────────────────────────────────────────────────────────────────
 * Construit `data/registres-localisation.json` : les documents SANS code-barre
 * dont l'équipe a relevé l'emplacement sur des registres Excel (dossier
 * `excel/`, gitignoré — d'où ce JSON committé), pour les placer sur le plan
 * (reserve.html) et sur les panneaux imprimables (signaletique.html) :
 *
 *   excel/Récolement mss 0001-0930.xlsx   manuscrits de la réserve patrimoniale
 *       Cote | Travée | Colonne ("I-A") | Etagère | Absence | Titre | Auteur |
 *       Date | Provenances | Volumes | pp | Boîte | Format | Support | Etat
 *       Une ligne par unité textuelle : un même manuscrit (même cote) en a
 *       souvent plusieurs ("partie", f. 1, f. 133…) → un seul document par
 *       cote et par étagère. Étagère « 6 à 11 » / « 5 et 6 » : le manuscrit
 *       est posé sur chacune. Les lignes sans travée sont les manuscrits
 *       absents (détruits en 1944, perdus) : non placés, comptés à part.
 *   excel/Récolement Armoires en bois.xlsx  contenu des armoires en bois
 *       Localisation « Armoire en bois N » = colonne N (A, B…) de la
 *       pseudo-travée ARMOIRE du récolement ; Etagère = niveau.
 *   excel/Fonds CAR.xlsx                    cartes géographiques
 *       Seules les cartes rangées en armoire à tiroirs ont un emplacement :
 *       Boîte « A2T7 » = armoire à tiroirs 2 (colonne B de la pseudo-travée
 *       TIROIR), tiroir 7. Les boîtes numérotées (1 à 21) ne sont pas
 *       localisées dans le récolement.
 *
 * Un emplacement non reconnu (ex. étagère « PSBC-1 », « z ») n'est pas
 * deviné : la ligne part dans `unplaced`, listée dans le rapport.
 *
 * Usage : npm run build:registres   (puis committer le JSON)
 */
import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readXlsxObjects } from './lib/xlsx.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const EXCEL = path.join(ROOT, 'excel');
const OUT = path.join(ROOT, 'data', 'registres-localisation.json');

const FILES = {
  mss:      'Récolement mss 0001-0930.xlsx',
  armoires: 'Récolement Armoires en bois.xlsx',
  cartes:   'Fonds CAR.xlsx',
};
// Réserve patrimoniale : travées et nombre de colonnes (js/reserve-shared.js).
const TRAVEES = { I:4, II:5, III:5, IV:5, V:5, VI:8, VII:8, VIII:8, IX:8, X:8, XI:8, XII:8,
                  XIII:8, XIV:8, XV:8, XVI:8, XVII:8, XVIII:8, XIX:8 };

const clean = s => String(s || '').replace(/\s+/g, ' ').trim();
const letter = n => String.fromCharCode(64 + n);

/* « 3 » → [3] ; « 6 à 11 » → [6..11] ; « 5 et 6 » → [5, 6] ; sinon null. */
function shelves(raw){
  const s = clean(raw).toLowerCase();
  if(/^\d+$/.test(s)) return [+s];
  let m = s.match(/^(\d+)\s*(?:à|-)\s*(\d+)$/);
  if(m && +m[2] >= +m[1] && +m[2] - +m[1] < 20) return Array.from({length: +m[2] - +m[1] + 1}, (_, i) => +m[1] + i);
  m = s.match(/^(\d+)\s*(?:et|,)\s*(\d+)$/);
  if(m) return [+m[1], +m[2]];
  return null;
}

const items = [], unplaced = [], report = {};

/* ── Manuscrits ── */
function buildMss(file){
  const rows = readXlsxObjects(file);
  const groups = new Map();   // cote|travée|col|étagère → lignes
  let absent = 0;
  const absentCotes = new Set();
  for(const r of rows){
    const cote = clean(r['Cote']).replace(/^ms\s*/i, 'Ms ');
    if(!cote) continue;
    const t = clean(r['Travée']).toUpperCase();
    if(!t){ absentCotes.add(cote); continue; }
    const col = clean(r['Colonne']).toUpperCase().split('-').pop();
    const sh = shelves(r['Etagère']);
    const ok = TRAVEES[t] && /^[A-Z]$/.test(col) && col.charCodeAt(0) - 64 <= TRAVEES[t] && sh;
    if(!ok){
      unplaced.push({ s:'mss', cote, travee:t, colonne:clean(r['Colonne']), etagere:clean(r['Etagère']),
                      titre:clean(r['Titre']).slice(0, 120),
                      raison: !TRAVEES[t] ? 'travée inconnue' : !sh ? 'étagère non numérique' : 'colonne hors de la travée' });
      continue;
    }
    for(const e of sh){
      const k = [cote, t, col, e].join('|');
      if(!groups.has(k)) groups.set(k, { cote, t, col, e, span: sh.length > 1 ? clean(r['Etagère']) : '', rows: [] });
      groups.get(k).rows.push(r);
    }
  }
  absent = absentCotes.size;
  for(const g of groups.values()){
    // Titre : l'unité qui ouvre le volume (f. 1) si elle est repérable.
    const first = g.rows.find(r => /^f\.?\s*1\b/i.test(clean(r['pp']))) || g.rows[0];
    const parts = g.rows.length;
    const info = [clean(first['Provenances']), clean(first['Support']), clean(first['Etat'])].filter(Boolean).join(' · ');
    items.push({
      s: 'mss', t: g.t, c: g.col, e: String(g.e), cote: g.cote,
      titre: clean(first['Titre']) || g.cote,
      auteur: clean(first['Auteur']),
      date: clean(first['Date']),
      info: (parts > 1 ? `${parts} pièces · ` : '') + info + (g.span ? ` · sur les étagères ${g.span}` : ''),
    });
  }
  const placedCotes = new Set([...groups.values()].map(g => g.cote));
  report.mss = { fichier: FILES.mss, lignes: rows.length, manuscritsPlaces: placedCotes.size,
                 emplacements: groups.size, absents: absent,
                 nonPlaces: unplaced.filter(u => u.s === 'mss').length };
}

/* ── Armoires en bois ── */
function buildArmoires(file){
  const rows = readXlsxObjects(file);
  let n = 0;
  for(const r of rows){
    const m = clean(r['Localisation']).match(/armoire en bois\s*(\d+)/i);
    const type = clean(r['Type de document']), desc = clean(r['Description']);
    if(!m){
      if(type || desc) unplaced.push({ s:'armoire', localisation:clean(r['Localisation']), titre:(type || desc).slice(0, 120), raison:'armoire non précisée' });
      continue;
    }
    const sh = shelves(r['Etagère']);
    // Un objet sans niveau reste rattaché à son armoire (e = '') : il figure
    // sur la fiche imprimée de l'armoire, mais pas sur une case du plan.
    (sh || ['']).forEach(e => {
      items.push({ s:'armoire', t:'ARMOIRE', c:letter(+m[1]), e:String(e),
                   cote: clean(r["Numéro d'inventaire"]), titre: type || desc.slice(0, 80),
                   desc, note: clean(r['Notes']) });
      n++;
    });
  }
  report.armoires = { fichier: FILES.armoires, lignes: rows.length, places: n };
}

/* ── Cartes en armoire à tiroirs ── */
function buildCartes(file){
  const rows = readXlsxObjects(file);
  let n = 0, enBoite = 0;
  for(const r of rows){
    const m = clean(r['Boîte']).toUpperCase().match(/^A(\d+)\s*T(\d+)$/);
    if(!m){ enBoite++; continue; }
    items.push({ s:'carte', t:'TIROIR', c:letter(+m[1]), e:String(+m[2]),
                 cote: clean(r['ancienne cote2']) || clean(r['ancienne cote1']),
                 titre: clean(r['Nom']), auteur: clean(r['Auteur']), date: clean(r['Année']),
                 info: [clean(r['type de carte']), clean(r['échelle']), clean(r['Formats'])].filter(v => v && v !== 'Non applicable').join(' · ') });
    n++;
  }
  report.cartes = { fichier: FILES.cartes, lignes: rows.length, enTiroir: n, enBoiteNonLocalisees: enBoite };
}

for(const [k, f] of Object.entries(FILES)){
  const p = path.join(EXCEL, f);
  if(!existsSync(p)){ console.warn(`⚠ ${f} absent de excel/ — source ignorée`); continue; }
  ({ mss: buildMss, armoires: buildArmoires, cartes: buildCartes })[k](p);
}
if(!items.length){ console.error('Aucun document placé : rien n\'est écrit.'); process.exit(1); }

writeFileSync(OUT, JSON.stringify({ generatedAt: new Date().toISOString(), report, items, unplaced }));
console.log(`✓ ${items.length} documents placés → data/registres-localisation.json`);
console.log(JSON.stringify(report, null, 2));
if(unplaced.length){
  console.log(`\n${unplaced.length} ligne(s) non placée(s) :`);
  unplaced.forEach(u => console.log(`  [${u.s}] ${u.cote || ''} ${u.travee || u.localisation || ''} ${u.colonne || ''} ${u.etagere || ''} — ${u.raison} — ${u.titre}`));
}
