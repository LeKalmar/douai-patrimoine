#!/usr/bin/env node
/**
 * db-migrate-fonds-periodiques.mjs
 * ────────────────────────────────────────────────────────────────────────────
 * Peuple la base depuis csv/periodiques.csv (registre au niveau TITRE — 100
 * périodiques, absents de Syracuse) ET csv/periodiques2.csv (106 lignes,
 * les cotes réellement détenues par la bibliothèque — Titre, Cote, Date de
 * parution ; Périodicité et Nombre de volumes vides sur tout l'export du
 * 2026-09-23). Même patron que scripts/db-migrate-fonds-car.mjs :
 * `source='excel_import'`, `type_document='periodique'` (voir
 * db/migrations/0006_type_document_periodique.sql), `"920$t"='PER'`.
 *
 * ── Rapprochement periodiques.csv ↔ periodiques2.csv ──────────────────────
 * Les deux registres n'écrivent ni les titres (article en tête vs entre
 * parenthèses : "Le Vrai Gayant" / "Vrai Gayant (Le)") ni les cotes (préfixe
 * zéro variable : "D000003" / "D3") de la même façon. Rapprochement en deux
 * passes (voir normalizeTitreForMatch(), scripts/lib/fonds-periodiques-
 * record.mjs) :
 *
 *   1. Par TITRE normalisé (accents/casse/article ignorés) : une
 *      correspondance attache la cote periodiques2 sur la ligne
 *      periodiques.csv correspondante (champ `_coteFromPeriodiques2`, lu en
 *      priorité par buildFondsPeriodiqueRecord()) plutôt que de créer une
 *      seconde entrée pour le même périodique. 21 correspondances sur
 *      l'export du 2026-09-23 (dont 16 donnent une cote à un périodique qui
 *      n'en avait aucune).
 *   2. Par NUMÉRO de cote (le nombre après le "D", zéros de tête ignorés)
 *      pour les lignes periodiques2 non rapprochées par titre : si ce
 *      numéro correspond déjà à une cote periodiques.csv (d'origine ou tout
 *      juste rapprochée à l'étape 1), la ligne periodiques2 est ignorée
 *      plutôt que réinsérée en double — ex. "Gayant : Echo Douaisien
 *      Journal du Dimanche" (D6) désigne le même exemplaire que "Gayant,
 *      écho douaisien" (periodiques.csv, D000006) malgré un titre trop
 *      différent pour matcher à l'étape 1.
 *
 * Les lignes periodiques2 qui ne rapprochent NI par titre NI par numéro de
 * cote sont insérées comme nouvelles entrées à part entière
 * (buildFondsPeriodique2Record(), source_ref préfixé "fonds-periodiques2-"
 * — jamais "fonds-periodiques-", pour ne pas entrer en collision avec les
 * period-id de periodiques.csv, tous deux `source='excel_import'` donc même
 * espace de noms (source, source_ref)).
 *
 * Aucune dépendance npm au-delà de `pg`. Node ≥ 18.
 * ────────────────────────────────────────────────────────────────────────────
 */
import { readFileSync, existsSync } from 'node:fs';
import { parseCsvObjects } from './lib/csv.mjs';
import { getPool, buildBatchInsert, closeAllPools } from './lib/pg.mjs';
import { quoteCol } from './lib/marc-columns.mjs';
import { normalizeTitreForMatch } from './lib/fonds-periodiques-record.mjs';

const CONFIG = {
  input1: 'csv/periodiques.csv',
  input2: 'csv/periodiques2.csv',
  encoding: 'utf-8',
  delimiter: ';',
  batchSize: 500,
};

const TYPE_DOCUMENT_CODE_PERIODIQUE = 'PER';

function clean(v) {
  return (v || '').replace(/\s+/g, ' ').trim();
}

// Même dédoublonnage que buildFondsPeriodiqueRecord() (cote CSV corrompue
// sur "Le Vrai Gayant", un jeton répété 7 fois) — appliqué ici sur la
// colonne typée cote_1/cote_complete pour qu'elle reste lisible en base ;
// la ligne brute (non corrigée) reste dans `raw`, comme reçue du CSV.
function dedupeCote(raw) {
  const c = clean(raw);
  if (!c) return '';
  const parts = c.split(/\s+/);
  return (parts.length > 1 && parts.every(p => p === parts[0])) ? parts[0] : c;
}

// "D000003" -> "3", "D3" -> "3", "D10028" -> "10028" — pour comparer deux
// écritures différentes du même numéro de cote.
function coteNumber(cote) {
  const m = String(cote || '').match(/(\d+)/);
  return m ? String(parseInt(m[1], 10)) : null;
}

function batches(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function main() {
  const startedAt = Date.now();
  console.log('▶ db-migrate-fonds-periodiques: démarrage');

  for (const input of [CONFIG.input1, CONFIG.input2]) {
    if (!existsSync(input)) throw new Error(`${input} introuvable.`);
  }
  const rows1 = parseCsvObjects(readFileSync(CONFIG.input1, CONFIG.encoding), { delimiter: CONFIG.delimiter });
  const rows2 = parseCsvObjects(readFileSync(CONFIG.input2, CONFIG.encoding), { delimiter: CONFIG.delimiter });
  console.log(`  · ${rows1.length} lignes lues (${CONFIG.input1}), ${rows2.length} lignes lues (${CONFIG.input2})`);

  // ── periodiques.csv : un enregistrement par period-id ────────────────────
  const records = []; // { sourceRef, row, cote } — row peut recevoir _coteFromPeriodiques2 avant upsert
  let sansId = 0, sansNom = 0;
  const byNormTitre = new Map(); // titre normalisé -> record (pour le rapprochement)
  const coveredCoteNumbers = new Set(); // numéros déjà couverts par une cote periodiques.csv

  rows1.forEach(row => {
    const periodId = clean(row['period-id']);
    const nom = clean(row['nom']);
    if (!periodId) { sansId++; return; }
    if (!nom) { sansNom++; return; }
    const rec = { sourceRef: `fonds-periodiques-${periodId}`, row, cote: dedupeCote(row['cote']) };
    records.push(rec);
    const norm = normalizeTitreForMatch(nom);
    if (norm && !byNormTitre.has(norm)) byNormTitre.set(norm, rec);
    const n = coteNumber(rec.cote);
    if (n) coveredCoteNumbers.add(n);
  });
  console.log(`  · ${records.length} périodiques (periodiques.csv) retenus (${sansId} sans period-id ignorés, ${sansNom} sans nom ignorés)`);

  // ── Passe 1 : rapprochement par titre ─────────────────────────────────────
  const records2 = []; // nouvelles lignes issues de periodiques2.csv, sans correspondance
  let matchedByTitre = 0, matchedByCoteNumber = 0, sansCoteP2 = 0;
  const unmatchedP2 = [];

  rows2.forEach(row => {
    const cote = clean(row['Cote']);
    if (!cote) { sansCoteP2++; return; }
    const norm = normalizeTitreForMatch(row['Titre']);
    const hit = norm ? byNormTitre.get(norm) : null;
    if (hit) {
      hit.row['_coteFromPeriodiques2'] = cote;
      hit.cote = dedupeCote(cote);
      const n = coteNumber(cote);
      if (n) coveredCoteNumbers.add(n);
      matchedByTitre++;
      return;
    }
    unmatchedP2.push(row);
  });

  // ── Passe 2 : rapprochement par numéro de cote (titres trop différents) ──
  unmatchedP2.forEach((row, i) => {
    const cote = clean(row['Cote']);
    const n = coteNumber(cote);
    if (n && coveredCoteNumbers.has(n)) {
      matchedByCoteNumber++;
      return; // déjà représenté côté periodiques.csv, pas de doublon
    }
    records2.push({ sourceRef: `fonds-periodiques2-row-${i}`, row });
  });

  console.log(
    `  · rapprochement periodiques2.csv : ${matchedByTitre} par titre, ` +
    `${matchedByCoteNumber} par numéro de cote (déjà couverts, ignorés), ` +
    `${sansCoteP2} sans cote ignorées, ${records2.length} nouvelles entrées`
  );

  const avecCote = records.filter(r => r.cote).length;
  console.log(`    → periodiques.csv : ${avecCote}/${records.length} avec cote après rapprochement`);

  const pool = getPool({ unpooled: true });
  const col920t = quoteCol('920$t');

  // ── Upsert notices + exemplaires (periodiques.csv) ────────────────────────
  console.log(`  · upsert notices (${records.length} lignes, source='excel_import')`);
  const noticeCols = ['source', 'source_notice_id', 'titre', 'editeur_date', 'raw'];
  const noticeIdByRef = new Map();
  for (const batch of batches(records, CONFIG.batchSize)) {
    const rowsIns = batch.map(({ sourceRef, row }) => ({
      source: 'excel_import',
      source_notice_id: sourceRef,
      titre: clean(row['nom']) || null,
      editeur_date: clean(row['date de première parution']) || null,
      raw: JSON.stringify(row),
    }));
    const { sql, values } = buildBatchInsert('notices', noticeCols, rowsIns, {
      onConflict: `ON CONFLICT (source, source_notice_id) DO UPDATE SET
        titre=EXCLUDED.titre, editeur_date=EXCLUDED.editeur_date, raw=EXCLUDED.raw,
        updated_at=now(), synced_at=now()`,
      returning: 'id, source_notice_id',
    });
    const { rows: returned } = await pool.query(sql, values);
    for (const r of returned) noticeIdByRef.set(r.source_notice_id, r.id);
  }

  console.log(`  · upsert exemplaires (${records.length} lignes, type_document='periodique', barcode NULL)`);
  const exemplaireCols = ['source', 'source_ref', 'type_document', 'notice_id', 'cote_1', 'cote_complete', col920t, 'raw'];
  let upserted = 0;
  for (const batch of batches(records, CONFIG.batchSize)) {
    const rowsIns = batch
      .map(({ sourceRef, row, cote }) => ({
        source: 'excel_import',
        source_ref: sourceRef,
        type_document: 'periodique',
        notice_id: noticeIdByRef.get(sourceRef),
        cote_1: cote || null,
        cote_complete: cote || null,
        [col920t]: TYPE_DOCUMENT_CODE_PERIODIQUE,
        raw: JSON.stringify(row),
      }))
      .filter(r => r.notice_id);
    const { sql, values } = buildBatchInsert('exemplaires', exemplaireCols, rowsIns, {
      onConflict: `ON CONFLICT (source, source_ref) WHERE source_ref IS NOT NULL DO UPDATE SET
        notice_id=EXCLUDED.notice_id, cote_1=EXCLUDED.cote_1, cote_complete=EXCLUDED.cote_complete,
        ${col920t}=EXCLUDED.${col920t}, raw=EXCLUDED.raw, updated_at=now(), synced_at=now()`,
    });
    if (sql) await pool.query(sql, values);
    upserted += rowsIns.length;
  }
  console.log(`    → ${upserted} exemplaire(s) upsertés (periodiques.csv)`);

  // ── Upsert notices + exemplaires (periodiques2.csv, nouvelles entrées) ────
  if (records2.length) {
    console.log(`  · upsert notices (${records2.length} lignes, nouvelles entrées periodiques2.csv)`);
    const noticeIdByRef2 = new Map();
    for (const batch of batches(records2, CONFIG.batchSize)) {
      const rowsIns = batch.map(({ sourceRef, row }) => ({
        source: 'excel_import',
        source_notice_id: sourceRef,
        titre: clean(row['Titre']) || null,
        editeur_date: null,
        raw: JSON.stringify(row),
      }));
      const { sql, values } = buildBatchInsert('notices', noticeCols, rowsIns, {
        onConflict: `ON CONFLICT (source, source_notice_id) DO UPDATE SET
          titre=EXCLUDED.titre, raw=EXCLUDED.raw, updated_at=now(), synced_at=now()`,
        returning: 'id, source_notice_id',
      });
      const { rows: returned } = await pool.query(sql, values);
      for (const r of returned) noticeIdByRef2.set(r.source_notice_id, r.id);
    }

    console.log(`  · upsert exemplaires (${records2.length} lignes, type_document='periodique', barcode NULL)`);
    let upserted2 = 0;
    for (const batch of batches(records2, CONFIG.batchSize)) {
      const rowsIns = batch
        .map(({ sourceRef, row }) => ({
          source: 'excel_import',
          source_ref: sourceRef,
          type_document: 'periodique',
          notice_id: noticeIdByRef2.get(sourceRef),
          cote_1: clean(row['Cote']) || null,
          cote_complete: clean(row['Cote']) || null,
          [col920t]: TYPE_DOCUMENT_CODE_PERIODIQUE,
          raw: JSON.stringify(row),
        }))
        .filter(r => r.notice_id);
      const { sql, values } = buildBatchInsert('exemplaires', exemplaireCols, rowsIns, {
        onConflict: `ON CONFLICT (source, source_ref) WHERE source_ref IS NOT NULL DO UPDATE SET
          notice_id=EXCLUDED.notice_id, cote_1=EXCLUDED.cote_1, cote_complete=EXCLUDED.cote_complete,
          ${col920t}=EXCLUDED.${col920t}, raw=EXCLUDED.raw, updated_at=now(), synced_at=now()`,
      });
      if (sql) await pool.query(sql, values);
      upserted2 += rowsIns.length;
    }
    console.log(`    → ${upserted2} exemplaire(s) upsertés (periodiques2.csv)`);
  }

  const dur = ((Date.now() - startedAt) / 1000).toFixed(2);
  console.log(`✓ db-migrate-fonds-periodiques: terminé en ${dur}s`);
}

main()
  .then(() => closeAllPools())
  .catch(async (err) => {
    console.error('✖ db-migrate-fonds-periodiques:', err.stack || err.message);
    await closeAllPools();
    process.exit(1);
  });
