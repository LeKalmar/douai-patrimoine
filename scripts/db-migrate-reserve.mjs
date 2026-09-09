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
 * Aucune dépendance npm au-delà de `pg`. Node ≥ 18.
 * ────────────────────────────────────────────────────────────────────────────
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { r2Get, r2Configured } from '../lib/r2.mjs';
import { indexNotices, buildItems, isReserveDouaisienne } from './lib/reserve-index.mjs';
import { getPool, buildBatchInsert, closeAllPools } from './lib/pg.mjs';

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
  batchSize: 500,
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

// Extrait les contributeurs répétables (700/701/702) d'un enregistrement
// aplati. Les sous-champs sont censés être alignés positionnellement (chaque
// occurrence du tag apporte un $a/$b/$3/$4/$f/$c), mais la qualité MARC réelle
// varie : on zippe défensivement par index jusqu'à la plus longue série
// présente, plutôt que de supposer un alignement parfait.
function extractContributors(rec, tag) {
  const codes = ['a', 'b', '3', '4', 'f', 'c'];
  const arrays = {};
  let maxLen = 0;
  for (const code of codes) {
    const raw = rec[`${tag}$${code}`];
    arrays[code] = raw ? raw.split('§') : [];
    maxLen = Math.max(maxLen, arrays[code].length);
  }
  const out = [];
  for (let i = 0; i < maxLen; i++) {
    const nom = arrays.a[i] || null;
    if (!nom) continue; // pas de nom exploitable pour cette position : rien à rattacher
    out.push({
      rang: i + 1,
      nom,
      prenom: arrays.b[i] || null,
      syracuse_id: arrays['3'][i] || null,
      fonction_code: arrays['4'][i] || null,
      dates: arrays.f[i] || null,
      qualif: arrays.c[i] || null,
    });
  }
  return out;
}

async function main() {
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
    noticeRowsByKey.set(key, {
      source: 'reserve_marc',
      source_notice_id: key,
      leader: it._leader || null,
      titre: it['200$a'] || null,
      titre_complement: it['200$e'] || null,
      editeur_nom: it['210$c'] || null,
      editeur_lieu: it['210$a'] || null,
      editeur_date: it['210$d'] || null,
      collation_desc: it['215$a'] || null,
      dimensions: it['215$d'] || null,
      langue: it['101$a'] || null,
      pays: it['102$a'] || null,
      isbn: null,
      issn: null,
      notes: it['300$a'] || null,
      auteur_principal: null,
      raw: JSON.stringify(raw),
    });
  }
  console.log(`  · upsert notices (${noticeRowsByKey.size} lignes)`);
  const notice_id_by_key = new Map();
  const noticeCols = [
    'source', 'source_notice_id', 'leader', 'titre', 'titre_complement',
    'editeur_nom', 'editeur_lieu', 'editeur_date', 'collation_desc', 'dimensions',
    'langue', 'pays', 'isbn', 'issn', 'notes', 'auteur_principal', 'raw',
  ];
  for (const batch of batches([...noticeRowsByKey.entries()], CONFIG.batchSize)) {
    const rows = batch.map(([, row]) => row);
    const { sql, values } = buildBatchInsert('notices', noticeCols, rows, {
      onConflict: `ON CONFLICT (source, source_notice_id) DO UPDATE SET
        leader=EXCLUDED.leader, titre=EXCLUDED.titre, titre_complement=EXCLUDED.titre_complement,
        editeur_nom=EXCLUDED.editeur_nom, editeur_lieu=EXCLUDED.editeur_lieu, editeur_date=EXCLUDED.editeur_date,
        collation_desc=EXCLUDED.collation_desc, dimensions=EXCLUDED.dimensions, langue=EXCLUDED.langue, pays=EXCLUDED.pays,
        isbn=EXCLUDED.isbn, issn=EXCLUDED.issn, notes=EXCLUDED.notes, auteur_principal=EXCLUDED.auteur_principal,
        raw=EXCLUDED.raw, updated_at=now(), synced_at=now()`,
      returning: 'id, source_notice_id',
    });
    const { rows: returned } = await pool.query(sql, values);
    for (const r of returned) notice_id_by_key.set(r.source_notice_id, r.id);
  }
  console.log(`    → ${notice_id_by_key.size} id(s) de notice résolus`);

  // ── 2. Contributeurs (700/701/702) + liens notice_contributeurs ────────
  const contribRowsWithId = new Map();   // syracuse_id -> row
  const contribRowsNoId = new Map();     // "nom|prenom|dates" -> row
  const links = []; // { noticeKey, role_tag, rang, contribKey, hasId, fonction_code, qualif }

  const processedNoticeKeys = new Set();
  for (const it of items) {
    const key = it._noticeId || `orphan:${it._itemId}`;
    if (processedNoticeKeys.has(key)) continue;
    processedNoticeKeys.add(key);

    for (const roleTag of [700, 701, 702]) {
      for (const c of extractContributors(it, roleTag)) {
        const hasId = !!c.syracuse_id;
        const contribKey = hasId ? c.syracuse_id : `${c.nom}|${c.prenom || ''}|${c.dates || ''}`;
        if (hasId) {
          contribRowsWithId.set(contribKey, { syracuse_id: c.syracuse_id, nom: c.nom, prenom: c.prenom, dates: c.dates });
        } else {
          contribRowsNoId.set(contribKey, { nom: c.nom, prenom: c.prenom || '', dates: c.dates || '' });
        }
        links.push({ noticeKey: key, role_tag: roleTag, rang: c.rang, contribKey, hasId, fonction_code: c.fonction_code, qualif: c.qualif });
      }
    }
  }
  console.log(`  · upsert contributeurs (${contribRowsWithId.size} avec syracuse_id, ${contribRowsNoId.size} sans)`);

  const contrib_id_by_key = new Map();
  for (const batch of batches([...contribRowsWithId.entries()], CONFIG.batchSize)) {
    const rows = batch.map(([, r]) => r);
    const { sql, values } = buildBatchInsert('contributeurs', ['syracuse_id', 'nom', 'prenom', 'dates'], rows, {
      onConflict: `ON CONFLICT (syracuse_id) DO UPDATE SET
        nom=EXCLUDED.nom, prenom=EXCLUDED.prenom, dates=EXCLUDED.dates, updated_at=now()`,
      returning: 'id, syracuse_id',
    });
    const { rows: returned } = await pool.query(sql, values);
    for (const r of returned) contrib_id_by_key.set(r.syracuse_id, r.id);
  }
  for (const batch of batches([...contribRowsNoId.entries()], CONFIG.batchSize)) {
    const rows = batch.map(([, r]) => r);
    const { sql, values } = buildBatchInsert('contributeurs', ['nom', 'prenom', 'dates'], rows, {
      onConflict: `ON CONFLICT (nom, prenom, dates) WHERE syracuse_id IS NULL DO UPDATE SET
        nom=EXCLUDED.nom, updated_at=now()`,
      returning: 'id, nom, prenom, dates',
    });
    const { rows: returned } = await pool.query(sql, values);
    for (const r of returned) contrib_id_by_key.set(`${r.nom}|${r.prenom}|${r.dates}`, r.id);
  }
  console.log(`    → ${contrib_id_by_key.size} id(s) de contributeur résolus`);

  const linkRows = links
    .map(l => ({
      notice_id: notice_id_by_key.get(l.noticeKey),
      role_tag: l.role_tag,
      rang: l.rang,
      contributeur_id: contrib_id_by_key.get(l.contribKey),
      fonction_code: l.fonction_code,
      qualif: l.qualif,
    }))
    .filter(r => r.notice_id && r.contributeur_id);
  console.log(`  · upsert notice_contributeurs (${linkRows.length} liens)`);
  for (const batch of batches(linkRows, CONFIG.batchSize)) {
    const { sql, values } = buildBatchInsert(
      'notice_contributeurs',
      ['notice_id', 'role_tag', 'rang', 'contributeur_id', 'fonction_code', 'qualif'],
      batch,
      { onConflict: `ON CONFLICT (notice_id, role_tag, rang) DO UPDATE SET
          contributeur_id=EXCLUDED.contributeur_id, fonction_code=EXCLUDED.fonction_code, qualif=EXCLUDED.qualif` },
    );
    await pool.query(sql, values);
  }

  // ── 3. Groupes de reliure ($481/$482) ───────────────────────────────────
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

  // ── 4. Exemplaires ───────────────────────────────────────────────────────
  console.log(`  · upsert exemplaires (${items.length} lignes)`);
  const exemplaireCols = [
    'barcode', 'source', 'notice_id', 'cote_1', 'cote_2', 'cote_3', 'cote_complete',
    'piege_a_code', 'piege_b_code', 'piege_c_texte', 'piege_label',
    'reliure_groupe_id', 'reserve_physique', 'date_entree', 'raw',
  ];
  let inserted = 0;
  for (const batch of batches(items, CONFIG.batchSize)) {
    const rows = batch.map(it => {
      const key = it._noticeId || `orphan:${it._itemId}`;
      const cote1 = it['930$g'] || null, cote2 = it['930$h'] || null, cote3 = it['930$i'] || null;
      return {
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
        date_entree: it['920$d'] || null,
        raw: JSON.stringify(it._itemRaw || {}),
      };
    }).filter(r => r.notice_id); // sécurité : notice_id NOT NULL en base

    const { sql, values } = buildBatchInsert('exemplaires', exemplaireCols, rows, {
      onConflict: `ON CONFLICT (barcode) WHERE barcode IS NOT NULL DO UPDATE SET
        source=EXCLUDED.source, notice_id=EXCLUDED.notice_id,
        cote_1=EXCLUDED.cote_1, cote_2=EXCLUDED.cote_2, cote_3=EXCLUDED.cote_3, cote_complete=EXCLUDED.cote_complete,
        piege_a_code=EXCLUDED.piege_a_code, piege_b_code=EXCLUDED.piege_b_code, piege_c_texte=EXCLUDED.piege_c_texte,
        piege_label=EXCLUDED.piege_label, reliure_groupe_id=EXCLUDED.reliure_groupe_id,
        reserve_physique=EXCLUDED.reserve_physique, date_entree=EXCLUDED.date_entree, raw=EXCLUDED.raw,
        updated_at=now(), synced_at=now()`,
    });
    await pool.query(sql, values);
    inserted += rows.length;
  }
  console.log(`    → ${inserted} exemplaire(s) upsertés`);

  const dur = ((Date.now() - startedAt) / 1000).toFixed(2);
  console.log(`✓ db-migrate-reserve: terminé en ${dur}s`);
}

main()
  .then(() => closeAllPools())
  .catch(async (err) => {
    console.error('✖ db-migrate-reserve:', err.stack || err.message);
    await closeAllPools();
    process.exit(1);
  });
