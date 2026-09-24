#!/usr/bin/env node
/**
 * db-migrate-non-catalogues.mjs
 * ────────────────────────────────────────────────────────────────────────────
 * Peuple la base depuis csv/inventaire.csv (registre des pièces sans
 * code-barre — Manuscrits/Robaut/Objets, voir scripts/build-non-catalogues.mjs
 * dont ce script réutilise `buildRecord()` telle quelle, pas de réécriture
 * des règles de nettoyage/traduction de type/sujets).
 *
 * Écrit dans `notices_reserve`/`exemplaires_reserve` (tables dédiées depuis
 * db/migrations/0007_split_reserve_tables.sql / 0008_reserve_non_catalogues.sql
 * — demande explicite de l'équipe, 2026-09-23 : ces pièces, bien que
 * "créées artificiellement" en forme UNIMARC depuis un CSV plutôt qu'issues
 * d'un vrai export Syracuse, doivent vivre dans les mêmes tables compactes
 * que la réserve reserve_marc plutôt que dans les tables partagées de
 * 300 000 lignes). Plus de colonne `source` sur ces deux tables (une seule
 * catégorie possible désormais par table dédiée) — `exemplaires_reserve`
 * distingue une pièce non cataloguée d'un exemplaire reserve_marc par
 * construction : `barcode` toujours NULL ici (jamais eu de code-barre) et
 * `source_ref` toujours renseigné (l'inverse pour reserve_marc). `rec` (la
 * sortie de buildRecord()) EST déjà la forme exacte de ligne attendue par
 * l'export (scripts/lib/export-inventaire.mjs) : stocké tel quel dans
 * exemplaires_reserve.raw, relu sans aucune transformation supplémentaire.
 *
 * `source_ref` : ni `001 (controlfield)` (absent sur 40% des lignes) ni la
 * cote (930$g, ~14% de doublons sur l'ensemble du CSV) ne sont des clés
 * fiables à eux seuls — la position de la ligne dans le CSV (stable tant que
 * le fichier committé n'est pas réordonné, ce qui n'arrive pas en pratique)
 * sert de clé d'idempotence.
 *
 * Encodage : csv/inventaire.csv est UTF-8 (avec BOM, retiré par
 * parseCsv()) — vérifié indépendamment de Lieux.csv (phase 8), dont le
 * mojibake connu est propre à ce fichier-là.
 *
 * Aucune dépendance npm au-delà de `pg`. Node ≥ 18.
 * ────────────────────────────────────────────────────────────────────────────
 */
import { readFileSync, existsSync } from 'node:fs';
import { parseCsvObjects } from './lib/csv.mjs';
import { getPool, buildBatchInsert, closeAllPools } from './lib/pg.mjs';

const CONFIG = {
  input: 'csv/inventaire.csv',
  batchSize: 500,
};

const IMAGES_ROOT = 'https://pub-85062da5f8a7451b9c168f8b3cfd980b.r2.dev/';
const TYPE_LABELS = { MANU: 'Texte manuscrit', IMP: 'Texte imprimé', ICO: 'Image fixe', NUMI: 'Numismatique', LIVA: "Livre d'artiste" };
const SPREADSHEET_ERRORS = new Set(['#CHAMP!', '#REF!', '#N/A', '#VALEUR!', '#NOM?', '#NUL!', '#DIV/0!']);

function clean(v) {
  const s = (v || '').replace(/\s+/g, ' ').trim();
  if (!s || SPREADSHEET_ERRORS.has(s)) return '';
  return s;
}

// Copie verbatim de buildRecord() dans scripts/build-non-catalogues.mjs — à
// maintenir manuellement en phase (même raison que les autres duplications
// documentées de ce chantier : ce fichier-ci ne peut pas être importé sans
// déclencher son écriture de data/non-catalogues.json/du rapport).
function buildRecord(row, stats) {
  const cote = clean(row['930$g']);
  if (!cote) return null;

  const titreBrut = clean(row['200$a']);
  const titre = titreBrut || cote;
  if (!titreBrut) stats.titreDeReplis++;

  const auteurNom = clean(row['700$a']) || null;
  const auteurPrenom = clean(row['700$b']) || null;
  const typeCode = clean(row['200$b']);
  const type = typeCode ? (TYPE_LABELS[typeCode.toUpperCase()] || typeCode) : null;
  const sujets = [clean(row['930$e_11']), clean(row['930$e_12'])].filter(Boolean).join(' ; ') || null;
  const fondsLabel = clean(row['930$e']) || null;

  const rec = {
    '930$g': cote,
    '200$a': titre,
    '200$b': type,
    '700$a': auteurNom,
    '700$b': auteurPrenom,
    '210$d': clean(row['210$d']) || null,
    '215$a': clean(row['215$a']) || null,
    '215$b': clean(row['215$b']) || null,
    '215$d': clean(row['215$d']) || null,
    '101$a': clean(row['101$a']) || null,
    '610$a': sujets,
    _fondsLabel: fondsLabel,
    _nonCatalogue: true,
  };

  const lienNum = clean(row['lien_num']);
  if (lienNum.startsWith(IMAGES_ROOT)) {
    rec.lien_num = lienNum;
    try {
      rec._lienNumerise = decodeURIComponent(lienNum.slice(IMAGES_ROOT.length));
      stats.numerises++;
    } catch { /* chemin mal encodé : vignette gardée, pas de lien visionneuse */ }
  }

  return rec;
}

function batches(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function main() {
  const startedAt = Date.now();
  console.log('▶ db-migrate-non-catalogues: démarrage');

  if (!existsSync(CONFIG.input)) throw new Error(`${CONFIG.input} introuvable.`);
  const text = readFileSync(CONFIG.input, 'utf-8');
  const rows = parseCsvObjects(text, { delimiter: ';' });
  console.log(`  · ${rows.length} lignes lues`);

  const stats = { titreDeReplis: 0, numerises: 0, kept: 0, dejaCatalogues: 0, sansCote: 0 };
  const records = []; // { sourceRef, rec }
  rows.forEach((row, i) => {
    if (clean(row['995$f'])) { stats.dejaCatalogues++; return; }
    const rec = buildRecord(row, stats);
    if (!rec) { stats.sansCote++; return; }
    records.push({ sourceRef: `csv-row-${i}`, rec });
    stats.kept++;
  });
  console.log(`  · ${stats.kept} pièces retenues (${stats.dejaCatalogues} déjà cataloguées ignorées, ${stats.sansCote} sans cote ignorées)`);

  const pool = getPool({ unpooled: true });

  console.log(`  · upsert notices_reserve (${records.length} lignes)`);
  // Pas de colonne `auteur_principal` sur notices_reserve (retirée par
  // 0007_split_reserve_tables.sql, toujours NULL pour la réserve) — sans
  // conséquence ici : cette notice n'est de toute façon jamais relue (voir
  // le commentaire en tête de fichier, `rec` porte déjà tout dans son `raw`
  // côté exemplaires_reserve).
  const noticeCols = ['source_notice_id', 'titre', 'raw'];
  const noticeIdByRef = new Map();
  for (const batch of batches(records, CONFIG.batchSize)) {
    const rows2 = batch.map(({ sourceRef, rec }) => ({
      source_notice_id: sourceRef,
      titre: rec['200$a'],
      raw: JSON.stringify(rec),
    }));
    const { sql, values } = buildBatchInsert('notices_reserve', noticeCols, rows2, {
      onConflict: `ON CONFLICT (source_notice_id) DO UPDATE SET
        titre=EXCLUDED.titre, raw=EXCLUDED.raw,
        updated_at=now(), synced_at=now()`,
      returning: 'id, source_notice_id',
    });
    const { rows: returned } = await pool.query(sql, values);
    for (const r of returned) noticeIdByRef.set(r.source_notice_id, r.id);
  }

  console.log(`  · upsert exemplaires_reserve (${records.length} lignes, barcode NULL)`);
  const exemplaireCols = ['source_ref', 'type_document', 'notice_id', 'cote_1', 'cote_complete', 'raw'];
  let upserted = 0;
  for (const batch of batches(records, CONFIG.batchSize)) {
    const rows2 = batch
      .map(({ sourceRef, rec }) => ({
        source_ref: sourceRef,
        type_document: 'manuscrit',
        notice_id: noticeIdByRef.get(sourceRef),
        cote_1: rec['930$g'],
        cote_complete: rec['930$g'],
        raw: JSON.stringify(rec),
      }))
      .filter(r => r.notice_id);
    const { sql, values } = buildBatchInsert('exemplaires_reserve', exemplaireCols, rows2, {
      // exemplaires_reserve_source_ref_key est un index unique simple
      // (source_ref seul, plus besoin de le coupler à `source` — cette
      // table dédiée n'en a plus, voir 0008_reserve_non_catalogues.sql).
      onConflict: `ON CONFLICT (source_ref) DO UPDATE SET
        notice_id=EXCLUDED.notice_id, cote_1=EXCLUDED.cote_1, cote_complete=EXCLUDED.cote_complete,
        raw=EXCLUDED.raw, updated_at=now(), synced_at=now()`,
    });
    if (sql) await pool.query(sql, values);
    upserted += rows2.length;
  }
  console.log(`    → ${upserted} exemplaire(s) upsertés`);

  const dur = ((Date.now() - startedAt) / 1000).toFixed(2);
  console.log(`✓ db-migrate-non-catalogues: terminé en ${dur}s`);
}

main()
  .then(() => closeAllPools())
  .catch(async (err) => {
    console.error('✖ db-migrate-non-catalogues:', err.stack || err.message);
    await closeAllPools();
    process.exit(1);
  });
