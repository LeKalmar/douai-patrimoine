#!/usr/bin/env node
/**
 * db-migrate-bib.mjs
 * ────────────────────────────────────────────────────────────────────────────
 * Peuple la base "inventaire des collections" à partir de xml/bib.xml (export
 * complet de la bibliothèque, format GESMARC, 738+ Mo — lu en flux via
 * scripts/lib/gesmarc.mjs, jamais chargé entièrement en mémoire, comme
 * scripts/build-magasins.mjs).
 *
 * Dédoublonnage avec la réserve (source reserve_marc, voir
 * db-migrate-reserve.mjs, à exécuter AVANT ce script) : double filet —
 *   1. Pré-filtre en mémoire : l'ensemble des codes-barres déjà
 *      `source='reserve_marc'` est chargé une seule fois au démarrage, tout
 *      item bib.xml dont le code-barre y figure est ignoré sans même
 *      atteindre la base (évite ~15 500 upserts inutiles sur ~200 000 items).
 *   2. Filet de sécurité en SQL (le vrai garant de non-duplication, valable
 *      même si le pré-filtre est périmé par une écriture concurrente) :
 *      `ON CONFLICT (barcode) ... DO UPDATE ... WHERE exemplaires.source =
 *      'bib_xml'` — si le code-barre en conflit appartient à une ligne
 *      `reserve_marc`, la condition est fausse et l'update ne fait rien : la
 *      réserve reste seule autorité sur cette ligne.
 *
 * Idempotent (INSERT ... ON CONFLICT, jamais de TRUNCATE) : un réimport après
 * un nouvel `npm run upload:bib` réutilise les mêmes lignes bib_xml plutôt
 * que d'en créer de nouvelles.
 *
 * Script LOCAL uniquement (jamais une fonction Vercel — fichier de 738+ Mo
 * en flux), comme scripts/build-magasins.mjs aujourd'hui.
 *
 * Aucune dépendance npm au-delà de `pg`. Node ≥ 18.
 * ────────────────────────────────────────────────────────────────────────────
 */
import { existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { r2Get, r2Configured } from '../lib/r2.mjs';
import { iterateGesmarcItemsFromFile, parseGesmarcItem } from './lib/gesmarc.mjs';
import { getPool, buildBatchInsert, closeAllPools } from './lib/pg.mjs';

const CONFIG = {
  r2Key: 'xml/bib.xml',
  input: 'data/xml/bib.xml',
  batchSize: 500,
  logEvery: 20_000,
};

const noticeCols = ['source', 'source_notice_id', 'titre', 'editeur_nom', 'editeur_date', 'isbn', 'issn', 'auteur_principal', 'raw'];
const exemplaireCols = [
  'barcode', 'source', 'notice_id', 'cote_1', 'cote_2', 'cote_3', 'cote_complete',
  'piege_a_code', 'piege_b_code', 'piege_c_texte', 'piege_label',
  'etat_code', 'etat_libelle', 'section_code', 'section_libelle', 'bibliotheque_code', 'bibliotheque_libelle', 'raw',
];

async function syncXmlFromR2() {
  if (existsSync(CONFIG.input)) {
    console.log('  · fichier local déjà présent (supprimez-le pour forcer un retéléchargement depuis R2)');
    return;
  }
  if (!r2Configured()) {
    throw new Error('R2 non configuré et data/xml/bib.xml absent localement — voir R2_* dans .env.');
  }
  console.log(`  · récupération de ${CONFIG.r2Key}… (fichier volumineux, patientez)`);
  const obj = await r2Get(CONFIG.r2Key, { raw: true });
  if (!obj) throw new Error(`${CONFIG.r2Key} absent de R2.`);
  mkdirSync(dirname(resolve(CONFIG.input)), { recursive: true });
  writeFileSync(CONFIG.input, obj.body);
  console.log(`    → ${CONFIG.input} mis à jour depuis R2 (${(obj.body.length / 1e6).toFixed(1)} Mo)`);
}

// Extrait les champs utiles d'un item GESMARC, ou null s'il est hors
// périmètre (pas de code-barre, ou bibliothèque hors réseau Douai — même
// filtre que build-magasins.mjs/build-cotes-numeriques.mjs).
function extractItem(props) {
  const barcode = (props['Code-barres (valeur)'] || '').trim();
  if (!barcode) return null;
  const bibliotheque = props['Bibliothèque (Libellé)'] || '';
  if (!bibliotheque.startsWith('Douai')) return null;

  const cote1 = props['Cote n° 1'] || null;
  const cote2 = props['Cote n° 2'] || null;
  const cote3 = props['Cote n° 3'] || null;

  return {
    barcode,
    titre: props['Titre'] || null,
    editeurNom: props['Editeur'] || null,
    editeurDate: props['Publié le'] || null,
    isbn: props['ISBN'] || null,
    issn: props['ISSN'] || null,
    auteur: props['Auteur'] || null,
    cote1, cote2, cote3,
    coteComplete: [cote1, cote2, cote3].filter(Boolean).join(' ') || null,
    piegeACode: props['Piège 921$a (Code)'] || null,
    piegeBCode: props['Piège 921$b (Code)'] || null,
    piegeCTexte: props['Piège 921$c'] || null,
    piegeLabel: props['Pièges'] || null,
    // NB : "Etat  (Code)"/"Etat  (Libellé)" portent deux espaces avant la
    // parenthèse dans l'export GESMARC réel (vérifié par grep sur bib.xml).
    etatCode: props['Etat  (Code)'] || null,
    etatLibelle: props['Etat  (Libellé)'] || null,
    sectionCode: props['Section (Code)'] || null,
    sectionLibelle: props['Section (Libellé)'] || null,
    bibliothequeCode: props['Bibliothèque (Code)'] || null,
    bibliothequeLibelle: bibliotheque,
    raw: props,
  };
}

async function flushBatch(pool, itemsByBarcode) {
  const items = [...itemsByBarcode.values()];
  if (!items.length) return 0;

  const noticeRows = items.map(it => ({
    source: 'bib_xml_minimal',
    source_notice_id: it.barcode,
    titre: it.titre,
    editeur_nom: it.editeurNom,
    editeur_date: it.editeurDate,
    isbn: it.isbn,
    issn: it.issn,
    auteur_principal: it.auteur,
    raw: JSON.stringify({}), // le détail complet vit sur exemplaires.raw ; pas de duplication ici
  }));
  const { sql: nSql, values: nValues } = buildBatchInsert('notices', noticeCols, noticeRows, {
    onConflict: `ON CONFLICT (source, source_notice_id) DO UPDATE SET
      titre=EXCLUDED.titre, editeur_nom=EXCLUDED.editeur_nom, editeur_date=EXCLUDED.editeur_date,
      isbn=EXCLUDED.isbn, issn=EXCLUDED.issn, auteur_principal=EXCLUDED.auteur_principal,
      updated_at=now(), synced_at=now()`,
    returning: 'id, source_notice_id',
  });
  const { rows: noticeReturned } = await pool.query(nSql, nValues);
  const noticeIdByBarcode = new Map(noticeReturned.map(r => [r.source_notice_id, r.id]));

  const exemplaireRows = items
    .map(it => ({
      barcode: it.barcode,
      source: 'bib_xml',
      notice_id: noticeIdByBarcode.get(it.barcode),
      cote_1: it.cote1,
      cote_2: it.cote2,
      cote_3: it.cote3,
      cote_complete: it.coteComplete,
      piege_a_code: it.piegeACode,
      piege_b_code: it.piegeBCode,
      piege_c_texte: it.piegeCTexte,
      piege_label: it.piegeLabel,
      etat_code: it.etatCode,
      etat_libelle: it.etatLibelle,
      section_code: it.sectionCode,
      section_libelle: it.sectionLibelle,
      bibliotheque_code: it.bibliothequeCode,
      bibliotheque_libelle: it.bibliothequeLibelle,
      raw: JSON.stringify(it.raw),
    }))
    .filter(r => r.notice_id); // sécurité : notice_id NOT NULL en base

  const { sql: eSql, values: eValues } = buildBatchInsert('exemplaires', exemplaireCols, exemplaireRows, {
    // Le WHERE final (sur la table, pas sur l'index) est le vrai mécanisme de
    // dédoublonnage : si le code-barre en conflit appartient à une ligne
    // reserve_marc, la condition est fausse, l'update ne fait rien.
    onConflict: `ON CONFLICT (barcode) WHERE barcode IS NOT NULL DO UPDATE SET
      notice_id=EXCLUDED.notice_id, cote_1=EXCLUDED.cote_1, cote_2=EXCLUDED.cote_2, cote_3=EXCLUDED.cote_3,
      cote_complete=EXCLUDED.cote_complete, piege_a_code=EXCLUDED.piege_a_code, piege_b_code=EXCLUDED.piege_b_code,
      piege_c_texte=EXCLUDED.piege_c_texte, piege_label=EXCLUDED.piege_label,
      etat_code=EXCLUDED.etat_code, etat_libelle=EXCLUDED.etat_libelle,
      section_code=EXCLUDED.section_code, section_libelle=EXCLUDED.section_libelle,
      bibliotheque_code=EXCLUDED.bibliotheque_code, bibliotheque_libelle=EXCLUDED.bibliotheque_libelle,
      raw=EXCLUDED.raw, updated_at=now(), synced_at=now()
      WHERE exemplaires.source = 'bib_xml'`,
  });
  if (eSql) await pool.query(eSql, eValues);
  return exemplaireRows.length;
}

async function main() {
  const startedAt = Date.now();
  console.log('▶ db-migrate-bib: démarrage');

  await syncXmlFromR2();

  const pool = getPool({ unpooled: true });

  console.log('  · pré-filtre : chargement des codes-barres déjà réserve...');
  const { rows: reserveRows } = await pool.query(`SELECT barcode FROM exemplaires WHERE source = 'reserve_marc' AND barcode IS NOT NULL`);
  const reserveBarcodes = new Set(reserveRows.map(r => r.barcode));
  console.log(`    → ${reserveBarcodes.size} code(s)-barres réserve à ignorer`);

  console.log(`  · lecture en flux de ${CONFIG.input}...`);
  let totalItems = 0, keptDouai = 0, skippedReserve = 0, upserted = 0;
  let batch = new Map(); // barcode -> item (dédup intra-lot : dernier gagne)

  for await (const itemXml of iterateGesmarcItemsFromFile(CONFIG.input)) {
    totalItems++;
    const props = parseGesmarcItem(itemXml);
    const it = extractItem(props);
    if (!it) continue;
    keptDouai++;

    if (reserveBarcodes.has(it.barcode)) { skippedReserve++; continue; }

    batch.set(it.barcode, it);
    if (batch.size >= CONFIG.batchSize) {
      upserted += await flushBatch(pool, batch);
      batch = new Map();
    }

    if (totalItems % CONFIG.logEvery === 0) {
      console.log(`    … ${totalItems} items lus, ${keptDouai} Douai, ${skippedReserve} déjà réserve (ignorés), ${upserted} upsertés`);
    }
  }
  upserted += await flushBatch(pool, batch);

  console.log(`  · terminé : ${totalItems} items lus, ${keptDouai} Douai gardés, ${skippedReserve} déjà réserve (ignorés), ${upserted} upsertés en source='bib_xml'`);

  const dur = ((Date.now() - startedAt) / 1000).toFixed(2);
  console.log(`✓ db-migrate-bib: terminé en ${dur}s`);
}

main()
  .then(() => closeAllPools())
  .catch(async (err) => {
    console.error('✖ db-migrate-bib:', err.stack || err.message);
    await closeAllPools();
    process.exit(1);
  });
