#!/usr/bin/env node
/**
 * db-migrate-fonds-car.mjs
 * ────────────────────────────────────────────────────────────────────────────
 * Peuple la base depuis csv/Fonds CAR.csv (registre du fonds Cartes — 425
 * documents absents de Syracuse, jamais catalogués). Même patron que
 * scripts/db-migrate-non-catalogues.mjs : `source='excel_import'`, déjà
 * prévu par db/migrations/0001_init.sql, aucune migration de schéma requise
 * (`type_document='carte'` existe déjà dans le CHECK de `exemplaires`).
 *
 * Colonnes du CSV (17, séparateur ';', ISO-8859-1 — vérifié, pas d'UTF-8) :
 *   Nom, Auteur, Éditeur/imprimeur, Lieu édition, Lieu représenté, Formats,
 *   échelle, importance matérielle, type de carte, Année, Boîte, N°,
 *   ancienne cote1, ancienne cote2, date d'entrée, intérêt BM DOUAI,
 *   justification
 *
 * « ancienne cote2 » est de facto la cote actuellement en usage pour ces
 * documents (confirmé par l'équipe, 2026-09-23 — le nom de la colonne est
 * trompeur) → exemplaires.cote_1. « ancienne cote1 » (identifiant historique
 * du fonds, ex. "M4217") n'a pas de colonne dédiée dans le schéma : conservé
 * dans `raw`, jamais perdu.
 *
 * « intérêt BM DOUAI » (oui/non/peut-être/priorité…) et « justification »
 * n'ont pas d'équivalent dans le référentiel de codes Syracuse `pieges`
 * (921$a/921$b) — texte libre, propre à ce registre plutôt qu'un code fermé.
 * Concaténées dans exemplaires.piege_c_texte (921$c, note libre) au format
 * "<intérêt> — <justification>", sur demande explicite de l'équipe plutôt
 * que réparties en piege_a_code/piege_b_code (qui resteraient NULL ici —
 * aucun code Syracuse ne correspond à ces valeurs).
 *
 * `exemplaires."920$t"` (Type de document, voir
 * scripts/lib/type-document-labels.mjs) posé en dur à 'CAR' (Carte) pour
 * toute la ligne — pas de colonne source dédiée, ce registre ne couvre que
 * des cartes.
 *
 * `source_ref` : pas de code-barres ni d'identifiant Syracuse sur ce
 * registre — la position de la ligne dans le CSV sert de clé d'idempotence
 * (même choix que db-migrate-non-catalogues.mjs), préfixée "fonds-car-" pour
 * ne jamais entrer en collision avec les "csv-row-N" de ce dernier : les deux
 * scripts partagent le même `source='excel_import'`, donc le même espace de
 * noms (source, source_ref).
 *
 * Aucune dépendance npm au-delà de `pg`. Node ≥ 18.
 * ────────────────────────────────────────────────────────────────────────────
 */
import { readFileSync, existsSync } from 'node:fs';
import { parseCsvObjects } from './lib/csv.mjs';
import { getPool, buildBatchInsert, closeAllPools } from './lib/pg.mjs';
import { quoteCol } from './lib/marc-columns.mjs';

// Code Syracuse "Type de document" (920$t / "Type de document (Code)" de
// xml/bib.xml — voir scripts/lib/type-document-labels.mjs) correspondant à
// une carte. Fixe pour tout le fichier : Fonds CAR ne contient que des
// cartes, pas besoin de colonne source dédiée dans le CSV.
const TYPE_DOCUMENT_CODE_CARTE = 'CAR';

const CONFIG = {
  input: 'csv/Fonds CAR.csv',
  encoding: 'latin1', // ISO-8859-1, vérifié (accents corrects, pas de mojibake)
  delimiter: ';',
  batchSize: 500,
};

function clean(v) {
  const s = (v || '').replace(/\s+/g, ' ').trim();
  return s || '';
}

function batches(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function main() {
  const startedAt = Date.now();
  console.log('▶ db-migrate-fonds-car: démarrage');

  if (!existsSync(CONFIG.input)) throw new Error(`${CONFIG.input} introuvable.`);
  const text = readFileSync(CONFIG.input, CONFIG.encoding);
  const rows = parseCsvObjects(text, { delimiter: CONFIG.delimiter });
  console.log(`  · ${rows.length} lignes lues`);

  const records = []; // { sourceRef, row, cote, piegeTexte }
  let sansNom = 0, sansCote = 0;
  rows.forEach((row, i) => {
    const nom = clean(row['Nom']);
    const cote = clean(row['ancienne cote2']);
    if (!nom) { sansNom++; return; }
    if (!cote) { sansCote++; return; }

    const interet = clean(row['intérêt BM DOUAI']);
    const justification = clean(row['justification']);
    const piegeTexte = [interet, justification].filter(Boolean).join(' — ') || null;

    records.push({ sourceRef: `fonds-car-row-${i}`, row, cote, piegeTexte });
  });
  console.log(`  · ${records.length} documents retenus (${sansNom} sans titre ignorés, ${sansCote} sans cote ignorés)`);

  const pool = getPool({ unpooled: true });

  console.log(`  · upsert notices (${records.length} lignes, source='excel_import')`);
  // editeur_lieu/dimensions/collation_desc n'existent plus sur `notices`
  // depuis 0003_marc_literal_fields.sql (colonnes reserve_marc uniquement,
  // supprimées) — "Lieu édition"/"Formats"/"importance matérielle" restent
  // captées dans `raw`, sans colonne typée dédiée (comme pour bib_xml).
  const noticeCols = ['source', 'source_notice_id', 'titre', 'auteur_principal', 'editeur_nom', 'editeur_date', 'raw'];
  const noticeIdByRef = new Map();
  for (const batch of batches(records, CONFIG.batchSize)) {
    const rows2 = batch.map(({ sourceRef, row }) => ({
      source: 'excel_import',
      source_notice_id: sourceRef,
      titre: clean(row['Nom']) || null,
      auteur_principal: clean(row['Auteur']) || null,
      editeur_nom: clean(row['Éditeur/imprimeur']) || null,
      editeur_date: clean(row['Année']) || null,
      raw: JSON.stringify(row),
    }));
    const { sql, values } = buildBatchInsert('notices', noticeCols, rows2, {
      onConflict: `ON CONFLICT (source, source_notice_id) DO UPDATE SET
        titre=EXCLUDED.titre, auteur_principal=EXCLUDED.auteur_principal,
        editeur_nom=EXCLUDED.editeur_nom, editeur_date=EXCLUDED.editeur_date,
        raw=EXCLUDED.raw, updated_at=now(), synced_at=now()`,
      returning: 'id, source_notice_id',
    });
    const { rows: returned } = await pool.query(sql, values);
    for (const r of returned) noticeIdByRef.set(r.source_notice_id, r.id);
  }

  console.log(`  · upsert exemplaires (${records.length} lignes, source='excel_import', type_document='carte', barcode NULL)`);
  const col920t = quoteCol('920$t');
  const exemplaireCols = [
    'source', 'source_ref', 'type_document', 'notice_id',
    'cote_1', 'cote_complete', 'piege_c_texte', 'piege_label', col920t, 'raw',
  ];
  let upserted = 0;
  for (const batch of batches(records, CONFIG.batchSize)) {
    const rows2 = batch
      .map(({ sourceRef, row, cote, piegeTexte }) => ({
        source: 'excel_import',
        source_ref: sourceRef,
        type_document: 'carte',
        notice_id: noticeIdByRef.get(sourceRef),
        cote_1: cote,
        cote_complete: cote,
        piege_c_texte: piegeTexte,
        piege_label: piegeTexte,
        [col920t]: TYPE_DOCUMENT_CODE_CARTE,
        raw: JSON.stringify(row),
      }))
      .filter(r => r.notice_id);
    const { sql, values } = buildBatchInsert('exemplaires', exemplaireCols, rows2, {
      // uq_exemplaires_source_ref est un index unique PARTIEL (WHERE
      // source_ref IS NOT NULL) — l'inférence ON CONFLICT doit répéter ce
      // prédicat, même patron que db-migrate-non-catalogues.mjs.
      onConflict: `ON CONFLICT (source, source_ref) WHERE source_ref IS NOT NULL DO UPDATE SET
        notice_id=EXCLUDED.notice_id, cote_1=EXCLUDED.cote_1, cote_complete=EXCLUDED.cote_complete,
        piege_c_texte=EXCLUDED.piege_c_texte, piege_label=EXCLUDED.piege_label,
        ${col920t}=EXCLUDED.${col920t}, raw=EXCLUDED.raw, updated_at=now(), synced_at=now()`,
    });
    if (sql) await pool.query(sql, values);
    upserted += rows2.length;
  }
  console.log(`    → ${upserted} exemplaire(s) upsertés`);

  const dur = ((Date.now() - startedAt) / 1000).toFixed(2);
  console.log(`✓ db-migrate-fonds-car: terminé en ${dur}s`);
}

main()
  .then(() => closeAllPools())
  .catch(async (err) => {
    console.error('✖ db-migrate-fonds-car:', err.stack || err.message);
    await closeAllPools();
    process.exit(1);
  });
