#!/usr/bin/env node
/**
 * db-migrate-reserve.mjs
 * ────────────────────────────────────────────────────────────────────────────
 * Peuple la base "inventaire des collections" à partir des deux exports
 * MARC-XML de la réserve (data/xml/notices.xml + exemplaires.xml) — même
 * source et même logique de jointure/pièges/reliures que
 * `npm run build` (scripts/build-inventory.mjs), réutilisée telle quelle via
 * scripts/lib/reserve-index.mjs pour ne jamais diverger du JSON produit par
 * ailleurs.
 *
 * Idempotent : chaque table est peuplée via `INSERT ... ON CONFLICT ...`
 * (jamais de TRUNCATE) — rejouable après un nouvel export Syracuse sans
 * dupliquer. Écrit avec `source='reserve_marc'`, qui reste TOUJOURS
 * prioritaire sur `source='bib_xml'` en cas de même code-barre (voir
 * db-migrate-bib.mjs) : à exécuter AVANT ce dernier.
 *
 * Colonnes littérales par champ UNIMARC (2026-09-22) : en plus des quelques
 * colonnes renommées partagées avec les sources bib_xml/excel_import
 * (titre, editeur_nom, editeur_date, isbn, issn, auteur_principal sur
 * `notices` ; cote_1/2/3, piege_*, reliure_groupe_id, reserve_physique sur
 * `exemplaires`), chaque champ UNIMARC "significatif" listé dans
 * scripts/lib/marc-columns.mjs reçoit sa PROPRE colonne, nommée exactement
 * comme le tag$sous-champ MARC (ex. "200$a", "921$c") — transfert direct
 * XML → cellule SQL, sans renommage. Un champ plus rare reste malgré tout
 * capturé sans perte dans `raw` (jsonb, flatten() complet).
 *
 * Rafraîchissement cellule par cellule (2026-09-22) : chaque `ON CONFLICT
 * ... DO UPDATE` applique `COALESCE(EXCLUDED.col, table.col)` à toutes les
 * colonnes de contenu — si un export plus étroit qu'un précédent ne porte
 * plus telle sous-champ pour une notice/un exemplaire donné, la cellule
 * existante n'est PAS écrasée par NULL, elle reste telle quelle ; seule une
 * valeur réellement présente dans le nouvel export remplace l'ancienne.
 * `raw` suit la même logique via une fusion jsonb (`||`) plutôt qu'un
 * remplacement complet : un champ rare non promu en colonne dédiée n'est
 * donc jamais perdu même si l'export qui l'a capturé n'est pas rejoué.
 *
 * Journal de rafraîchissement : une ligne est ajoutée à `sync_runs` à
 * chaque exécution (succès ou échec), avec `started_at` capturé AVANT toute
 * lecture du XML — c'est cette date qu'affiche admin.html pour indiquer
 * jusqu'à quand un prochain export Syracuse "notices modifiées depuis" doit
 * remonter (un léger recouvrement est sans risque, une notice réexportée
 * deux fois se réapplique à l'identique).
 *
 * Aucune dépendance npm au-delà de `pg`. Node ≥ 18.
 * ────────────────────────────────────────────────────────────────────────────
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { r2Get, r2Configured } from '../lib/r2.mjs';
import { indexNotices, buildItems, isReserveDouaisienne } from './lib/reserve-index.mjs';
import { getPool, buildBatchInsert, closeAllPools } from './lib/pg.mjs';
import { NOTICE_LITERAL_FIELDS, ITEM_LITERAL_FIELDS, quoteCol } from './lib/marc-columns.mjs';

const CONFIG = {
  input: {
    notices:     'data/xml/notices.xml',
    exemplaires: 'data/xml/exemplaires.xml',
  },
  vignetteBaseUrl: 'https://pub-85062da5f8a7451b9c168f8b3cfd980b.r2.dev/vignette/',
  // Whitelists identiques à celles de scripts/build-inventory.mjs (CONFIG) —
  // dupliquées ici plutôt que partagées, pour ne pas coupler ce script à un
  // module qui exécute un `await main()` en effet de bord à l'import. À
  // maintenir en phase avec build-inventory.mjs si ces listes changent.
  itemFieldsWhitelist: ['915', '920', '921', '922', '925', '926', '930', '201', '202', '316'],
  noticeFieldsWhitelist: [
    '100','101','102','105','106','140','200','210','214','215',
    '300','303','307','316','517','610','686','700','701','702',
    '801','902','940',
  ],
  // PostgreSQL limite un message "Bind" à 65535 paramètres — avec ~210
  // colonnes sur `notices` (10 génériques + 200 champs littéraux), un lot de
  // 500 lignes dépasserait cette limite (105 000 paramètres) et fait échouer
  // la requête. 300 lignes × 210 colonnes = 63 000, sous la limite avec une
  // marge confortable (vaut aussi pour `exemplaires`, bien plus étroite).
  batchSize: 300,
};

// ── Récupération des XML depuis R2 (identique à build-inventory.mjs) ───────
async function syncXmlFromR2() {
  if (!r2Configured()) return;
  console.log('  · R2 configuré : récupération de xml/notices.xml et xml/exemplaires.xml…');
  const targets = [
    { key: 'xml/notices.xml', local: CONFIG.input.notices },
    { key: 'xml/exemplaires.xml', local: CONFIG.input.exemplaires },
  ];
  for (const t of targets) {
    const obj = await r2Get(t.key);
    if (!obj) { console.warn(`  ⚠ ${t.key} absent de R2 — on garde le fichier local existant.`); continue; }
    mkdirSync(dirname(resolve(t.local)), { recursive: true });
    writeFileSync(t.local, obj.body, 'utf-8');
    console.log(`    → ${t.local} mis à jour depuis R2 (${(obj.body.length / 1e6).toFixed(1)} Mo)`);
  }
}

function sha256Hex(str) {
  return createHash('sha256').update(str, 'utf8').digest('hex');
}

function batches(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// ── Journal de rafraîchissement (sync_runs) ─────────────────────────────────
async function recordSyncRun(pool, { startedAt, finishedAt, noticesUpserted, exemplairesUpserted, status, errorMessage }) {
  await pool.query(
    `INSERT INTO sync_runs (source, started_at, finished_at, notices_upserted, exemplaires_upserted, status, error_message)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    ['reserve_marc', startedAt, finishedAt, noticesUpserted ?? null, exemplairesUpserted ?? null, status, errorMessage ?? null],
  );
}

// Capturé au tout début de main() — relu par le handler d'erreur en bas de
// fichier (hors de la portée de main()) pour journaliser started_at même en
// cas d'échec.
let runStartedAt = null;

async function main() {
  runStartedAt = new Date();
  const startedAt = Date.now();
  console.log('▶ db-migrate-reserve: démarrage');

  await syncXmlFromR2();
  for (const [role, path] of Object.entries(CONFIG.input)) {
    if (!existsSync(path)) throw new Error(`Fichier d'entrée manquant : ${path} (${role})`);
  }

  console.log('  · lecture + jointure (mêmes règles que npm run build)');
  const noticesXml = readFileSync(CONFIG.input.notices, 'utf-8');
  const exemplairesXml = readFileSync(CONFIG.input.exemplaires, 'utf-8');
  const index = indexNotices(noticesXml, { whitelist: CONFIG.noticeFieldsWhitelist, captureRaw: true });
  const buildResult = buildItems(exemplairesXml, index, {
    whitelist: CONFIG.itemFieldsWhitelist,
    vignetteBaseUrl: CONFIG.vignetteBaseUrl,
    captureRaw: true,
  });
  const items = buildResult.items;
  console.log(`     ${index.count} notices indexées, ${items.length} exemplaires`);

  const pool = getPool({ unpooled: true });

  // ── 1. Notices uniques (une par _noticeId référencé par ≥1 exemplaire ;
  //      un exemplaire orphelin — aucune notice jointe, aucun cas dans
  //      l'export actuel mais possible dans un futur export — reçoit une
  //      notice minimale propre, clé par son _itemId MARC). ──────────────
  const noticeRowsByKey = new Map(); // key -> row
  for (const it of items) {
    const key = it._noticeId || `orphan:${it._itemId}`;
    if (noticeRowsByKey.has(key)) continue;
    const raw = it._raw || {};
    const row = {
      source: 'reserve_marc',
      source_notice_id: key,
      leader: it._leader || null,
      titre: it['200$a'] || null,
      editeur_nom: it['210$c'] || null,
      editeur_date: it['210$d'] || null,
      isbn: null,
      issn: null,
      auteur_principal: null,
      raw: JSON.stringify(raw),
    };
    // Une colonne par champ UNIMARC significatif (scripts/lib/marc-columns.mjs),
    // transcrite telle quelle depuis le flatten() complet de la notice (raw) —
    // pas seulement les tags de noticeFieldsWhitelist ci-dessus.
    for (const field of NOTICE_LITERAL_FIELDS) row[quoteCol(field)] = raw[field] || null;
    noticeRowsByKey.set(key, row);
  }
  console.log(`  · upsert notices (${noticeRowsByKey.size} lignes, ${NOTICE_LITERAL_FIELDS.length} champs littéraux)`);
  const notice_id_by_key = new Map();
  const noticeCols = [
    'source', 'source_notice_id', 'leader', 'titre', 'editeur_nom', 'editeur_date',
    'isbn', 'issn', 'auteur_principal', 'raw',
    ...NOTICE_LITERAL_FIELDS.map(quoteCol),
  ];
  const noticeSetClause = [
    'leader=COALESCE(EXCLUDED.leader, notices.leader)',
    'titre=COALESCE(EXCLUDED.titre, notices.titre)',
    'editeur_nom=COALESCE(EXCLUDED.editeur_nom, notices.editeur_nom)',
    'editeur_date=COALESCE(EXCLUDED.editeur_date, notices.editeur_date)',
    'isbn=COALESCE(EXCLUDED.isbn, notices.isbn)',
    'issn=COALESCE(EXCLUDED.issn, notices.issn)',
    'auteur_principal=COALESCE(EXCLUDED.auteur_principal, notices.auteur_principal)',
    ...NOTICE_LITERAL_FIELDS.map(f => `${quoteCol(f)}=COALESCE(EXCLUDED.${quoteCol(f)}, notices.${quoteCol(f)})`),
    // Fusion jsonb (pas un remplacement) : un champ capturé par un export
    // passé mais absent de celui-ci reste dans raw au lieu d'être perdu.
    `raw=COALESCE(notices.raw, '{}'::jsonb) || EXCLUDED.raw`,
    'updated_at=now()',
    'synced_at=now()',
  ].join(',\n        ');
  for (const batch of batches([...noticeRowsByKey.entries()], CONFIG.batchSize)) {
    const rows = batch.map(([, row]) => row);
    const { sql, values } = buildBatchInsert('notices', noticeCols, rows, {
      onConflict: `ON CONFLICT (source, source_notice_id) DO UPDATE SET\n        ${noticeSetClause}`,
      returning: 'id, source_notice_id',
    });
    const { rows: returned } = await pool.query(sql, values);
    for (const r of returned) notice_id_by_key.set(r.source_notice_id, r.id);
  }
  console.log(`    → ${notice_id_by_key.size} id(s) de notice résolus`);

  // ── 2. Groupes de reliure ($481/$482) ───────────────────────────────────
  // (Les contributeurs 700/701/702 ne sont plus normalisés dans une table de
  // jonction séparée — voir db/migrations/0003_marc_literal_fields.sql : ils
  // vivent désormais tels quels dans les colonnes littérales "700$a" etc.
  // ci-dessus, occurrences répétées jointes par § comme dans
  // data/inventaire.json.)
  console.log(`  · upsert reliure_groupes (${index.reliureGroups.length} groupes)`);
  const reliure_group_id_by_barcode = new Map();
  const groupRows = index.reliureGroups.map(barcodes => {
    const sorted = [...barcodes].sort();
    return { group_key: sha256Hex(sorted.join(',')), barcodes };
  });
  for (const batch of batches(groupRows, CONFIG.batchSize)) {
    const { sql, values } = buildBatchInsert('reliure_groupes', ['group_key'], batch.map(g => ({ group_key: g.group_key })), {
      onConflict: `ON CONFLICT (group_key) DO UPDATE SET group_key=EXCLUDED.group_key`,
      returning: 'id, group_key',
    });
    const { rows: returned } = await pool.query(sql, values);
    const idByKey = new Map(returned.map(r => [r.group_key, r.id]));
    for (const g of batch) {
      const groupId = idByKey.get(g.group_key);
      for (const bc of g.barcodes) reliure_group_id_by_barcode.set(bc, groupId);
    }
  }

  // ── 3. Exemplaires ───────────────────────────────────────────────────────
  console.log(`  · upsert exemplaires (${items.length} lignes, ${ITEM_LITERAL_FIELDS.length} champs littéraux)`);
  const exemplaireCols = [
    'barcode', 'source', 'notice_id', 'cote_1', 'cote_2', 'cote_3', 'cote_complete',
    'piege_a_code', 'piege_b_code', 'piege_c_texte', 'piege_label',
    'reliure_groupe_id', 'reserve_physique', 'raw',
    ...ITEM_LITERAL_FIELDS.map(quoteCol),
  ];
  const exemplaireSetClause = [
    'source=EXCLUDED.source',
    'notice_id=EXCLUDED.notice_id',
    'cote_1=COALESCE(EXCLUDED.cote_1, exemplaires.cote_1)',
    'cote_2=COALESCE(EXCLUDED.cote_2, exemplaires.cote_2)',
    'cote_3=COALESCE(EXCLUDED.cote_3, exemplaires.cote_3)',
    'cote_complete=COALESCE(EXCLUDED.cote_complete, exemplaires.cote_complete)',
    'piege_a_code=COALESCE(EXCLUDED.piege_a_code, exemplaires.piege_a_code)',
    'piege_b_code=COALESCE(EXCLUDED.piege_b_code, exemplaires.piege_b_code)',
    'piege_c_texte=COALESCE(EXCLUDED.piege_c_texte, exemplaires.piege_c_texte)',
    'piege_label=COALESCE(EXCLUDED.piege_label, exemplaires.piege_label)',
    'reliure_groupe_id=COALESCE(EXCLUDED.reliure_groupe_id, exemplaires.reliure_groupe_id)',
    'reserve_physique=COALESCE(EXCLUDED.reserve_physique, exemplaires.reserve_physique)',
    ...ITEM_LITERAL_FIELDS.map(f => `${quoteCol(f)}=COALESCE(EXCLUDED.${quoteCol(f)}, exemplaires.${quoteCol(f)})`),
    `raw=COALESCE(exemplaires.raw, '{}'::jsonb) || EXCLUDED.raw`,
    'updated_at=now()',
    'synced_at=now()',
  ].join(',\n        ');
  let inserted = 0;
  for (const batch of batches(items, CONFIG.batchSize)) {
    const rows = batch.map(it => {
      const key = it._noticeId || `orphan:${it._itemId}`;
      const cote1 = it['930$g'] || null, cote2 = it['930$h'] || null, cote3 = it['930$i'] || null;
      const itemRaw = it._itemRaw || {};
      const row = {
        barcode: it['995$f'] || null,
        source: 'reserve_marc',
        notice_id: notice_id_by_key.get(key) || null,
        cote_1: cote1,
        cote_2: cote2,
        cote_3: cote3,
        cote_complete: [cote1, cote2, cote3].filter(Boolean).join(' ') || null,
        piege_a_code: it['921$a'] || null,
        piege_b_code: it['921$b'] || null,
        piege_c_texte: it['921$c'] || null,
        piege_label: it._piege || null,
        reliure_groupe_id: it['995$f'] ? (reliure_group_id_by_barcode.get(it['995$f']) || null) : null,
        reserve_physique: isReserveDouaisienne(cote1) ? 'douaisienne' : 'patrimoniale',
        raw: JSON.stringify(itemRaw),
      };
      for (const field of ITEM_LITERAL_FIELDS) row[quoteCol(field)] = itemRaw[field] || null;
      return row;
    }).filter(r => r.notice_id); // sécurité : notice_id NOT NULL en base

    const { sql, values } = buildBatchInsert('exemplaires', exemplaireCols, rows, {
      onConflict: `ON CONFLICT (barcode) WHERE barcode IS NOT NULL DO UPDATE SET\n        ${exemplaireSetClause}`,
    });
    await pool.query(sql, values);
    inserted += rows.length;
  }
  console.log(`    → ${inserted} exemplaire(s) upsertés`);

  await recordSyncRun(pool, {
    startedAt: runStartedAt,
    finishedAt: new Date(),
    noticesUpserted: notice_id_by_key.size,
    exemplairesUpserted: inserted,
    status: 'ok',
  });

  const dur = ((Date.now() - startedAt) / 1000).toFixed(2);
  console.log(`✓ db-migrate-reserve: terminé en ${dur}s`);
}

main()
  .then(() => closeAllPools())
  .catch(async (err) => {
    console.error('✖ db-migrate-reserve:', err.stack || err.message);
    try {
      const pool = getPool({ unpooled: true });
      await recordSyncRun(pool, {
        startedAt: runStartedAt || new Date(),
        finishedAt: new Date(),
        status: 'error',
        errorMessage: err.message,
      });
    } catch (logErr) {
      console.error('  (échec supplémentaire lors de la journalisation dans sync_runs :', logErr.message, ')');
    }
    await closeAllPools();
    process.exit(1);
  });
