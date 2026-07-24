#!/usr/bin/env node
/**
 * build-magasins.mjs
 * ────────────────────────────────────────────────────────────────────────────
 * Construit `data/magasins.json` (et `data/magasins-build-report.json`) à
 * partir de l'export Syracuse des magasins du 2e et 5e étage :
 *
 *   - xml/magasin/notices.xml.xml      (R2) → data/xml/magasin/notices.xml
 *   - xml/magasin/exemplaires.xml.xml  (R2) → data/xml/magasin/exemplaires.xml
 *
 * Contrairement à l'inventaire principal (data/xml/notices.xml), cet export
 * n'a pas pu être filtré en amont pour exclure les ouvrages du 6e étage —
 * les deux fonds sont mélangés dans le même XML. On les sépare ici par la
 * cote de l'exemplaire ($930$g, éventuellement suivie de $930$h) :
 *
 *   - Les cotes du 2e/5e étage sont des numéros d'enregistrement séquentiels
 *     de 5 ou 6 chiffres (ex : "100350", "156235"), parfois avec un zéro de
 *     tête ("0100011"), parfois suivis d'un tiret et d'un complément
 *     ("104391-182 JOR" — le numéro reste "104391"), parfois écrits avec un
 *     point comme séparateur de milliers pour les nombres à 5 chiffres
 *     ("12.352" = 12352).
 *   - Les cotes du 6e étage sont soit purement littérales ("R FON", "BD
 *     TSI"), soit des indices Dewey classiques à 3 chiffres avant le point
 *     ("940.21 BER", "330.122 KER" — le préfixe à 3 chiffres est le signal
 *     qui les distingue du séparateur de milliers ci-dessus).
 *
 * Règle retenue (voir CLAUDE.md, section magasins) : on extrait tous les
 * groupes de chiffres consécutifs de la cote (après avoir fusionné un
 * éventuel point "1-2 chiffres.3 chiffres" en un seul nombre) ; si un de ces
 * groupes fait 5 ou 6 chiffres (un zéro de tête sur un groupe de 7 étant
 * retiré avant de mesurer), l'exemplaire est gardé comme 2e/5e étage. Sinon
 * il est exclu (6e étage). Validé sur les 38 236 exemplaires réels : ~12 600
 * gardés, ~25 600 exclus, cf. data/magasins-build-report.json pour le détail
 * et des échantillons à relire.
 *
 * Aucune dépendance npm. Node ≥ 18. Nécessite R2 configuré (.env local ou
 * variables Vercel) — ce jeu de données n'a pas de repli local committé.
 * ────────────────────────────────────────────────────────────────────────────
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { loadDotEnv } from './lib/dotenv.mjs';
import { r2Get, r2Configured } from '../lib/r2.mjs';
import { iterateRecords, parseRecord, getSubfield, flatten } from './lib/marc-xml.mjs';

loadDotEnv();

const CONFIG = {
  r2Keys: {
    notices:     'xml/magasin/notices.xml.xml',
    exemplaires: 'xml/magasin/exemplaires.xml.xml',
  },
  input: {
    notices:     'data/xml/magasin/notices.xml',
    exemplaires: 'data/xml/magasin/exemplaires.xml',
  },
  output: {
    magasins: 'data/magasins.json',
    report:   'data/magasins-build-report.json',
  },
  vignetteBaseUrl: 'https://pub-85062da5f8a7451b9c168f8b3cfd980b.r2.dev/vignette/',
  multiSep: '§',
  itemFieldsWhitelist: ['915', '920', '921', '930'],
  noticeFieldsWhitelist: [
    '100', '101', '102', '105', '106', '140', '200', '210', '214', '215',
    '300', '303', '307', '316', '517', '610', '686', '700', '701', '702',
    '801', '902',
  ],
  force: process.env.SYRACUSE_FORCE === '1',
};

// ── Filtre étage : la cote désigne-t-elle un ouvrage du 2e/5e étage ? ──────
// Voir l'en-tête du fichier pour la règle. Retourne le groupe de chiffres
// identifié (utile pour le tri) ou null si la cote est du 6e étage / hors
// périmètre.
function magasinDigitRun(coteG) {
  if (!coteG) return null;
  // Fusionne "1-2 chiffres.3 chiffres" (séparateur de milliers) en un seul
  // nombre. N'affecte pas un préfixe Dewey à 3 chiffres ("940.21" reste
  // "940" + "." + "21", aucun des deux morceaux ne fait 1-2 chiffres suivis
  // de exactement 3 chiffres après le point).
  const merged = coteG.replace(/(?<!\d)(\d{1,2})\.(\d{3})(?!\d)/g, '$1$2');
  const runs = merged.match(/\d+/g) || [];
  for (let run of runs) {
    if (run.length === 7 && run[0] === '0') run = run.slice(1);
    if (run.length === 5 || run.length === 6) return run;
  }
  return null;
}

// ── Étape 1 : indexer les notices ──────────────────────────────────────────
function indexNotices(xml) {
  const notices = new Map();
  const primaryItemToNotice = new Map();

  let count = 0;
  for (const recXml of iterateRecords(xml)) {
    const rec = parseRecord(recXml);
    const noticeId = rec.controlfields['001'];
    if (!noticeId) continue;

    const flat = flatten(rec, CONFIG.noticeFieldsWhitelist, CONFIG.multiSep);
    flat._noticeId = noticeId;
    if (rec.leader) flat._leader = rec.leader;
    notices.set(noticeId, flat);

    const f995 = getSubfield(rec, '995', 'f');
    if (f995) primaryItemToNotice.set(f995.trim(), noticeId);

    count++;
  }

  return { notices, primaryItemToNotice, count };
}

// ── Étape 2 : itérer les exemplaires, joindre, filtrer par étage ───────────
function buildItems(xml, index) {
  const items = [];
  const stats = {
    totalItems: 0,
    joinedByPrimary: 0,
    orphans: 0,
    orphansSample: [],
    kept: 0,
    excluded: 0,
    excludedSample: [],
    keptEdgeSample: [], // cotes gardées avec tiret/point/zéro de tête, à relire
  };

  for (const recXml of iterateRecords(xml)) {
    const rec = parseRecord(recXml);
    stats.totalItems++;

    const itemFlat = flatten(rec, CONFIG.itemFieldsWhitelist, CONFIG.multiSep);
    const itemId = rec.controlfields['001'] ?? null;

    const b915 = getSubfield(rec, '915', 'b');
    const noticeId = b915 ? index.primaryItemToNotice.get(b915.trim()) : null;
    if (noticeId) {
      stats.joinedByPrimary++;
    } else {
      stats.orphans++;
      if (stats.orphansSample.length < 10) stats.orphansSample.push({ itemId, b915 });
    }

    const coteG = getSubfield(rec, '930', 'g');
    const coteH = getSubfield(rec, '930', 'h');
    const coteDisplay = [coteG, coteH].filter(Boolean).join(' ');
    const digitRun = magasinDigitRun(coteG);

    if (!digitRun) {
      stats.excluded++;
      if (stats.excludedSample.length < 30) stats.excludedSample.push(coteDisplay);
      continue;
    }
    stats.kept++;
    if (/[-.]/.test(coteG || '') || /^0/.test(coteG || '')) {
      if (stats.keptEdgeSample.length < 30) stats.keptEdgeSample.push(coteDisplay);
    }

    const noticeData = noticeId ? index.notices.get(noticeId) : {};
    const merged = { ...noticeData, ...itemFlat };
    merged._itemId = itemId;
    merged._noticeId = noticeId ?? null;
    merged._joinType = noticeId ? 'primary' : null;
    merged._coteDigitRun = digitRun;

    const barcode = b915 ? b915.trim() : null;
    if (barcode) {
      merged.lien_num = `${CONFIG.vignetteBaseUrl}${barcode}.jpg`;
      merged['995$f'] = barcode;
    }

    items.push(merged);
  }

  return { items, stats };
}

// ── Récupération des XML depuis R2 ──────────────────────────────────────────
async function syncXmlFromR2() {
  if (!r2Configured()) {
    console.error(
      '✖ R2 non configuré : ce jeu de données (xml/magasin/…) n\'a pas de repli ' +
      'local committé. Renseignez R2_ACCOUNT_ID, R2_BUCKET, R2_ACCESS_KEY_ID, ' +
      'R2_SECRET_ACCESS_KEY dans .env.'
    );
    process.exit(1);
  }
  console.log('  · récupération de xml/magasin/notices.xml.xml et exemplaires.xml.xml…');
  const targets = [
    { key: CONFIG.r2Keys.notices, local: CONFIG.input.notices },
    { key: CONFIG.r2Keys.exemplaires, local: CONFIG.input.exemplaires },
  ];
  for (const t of targets) {
    const obj = await r2Get(t.key);
    if (!obj) {
      console.error(`✖ ${t.key} absent de R2.`);
      process.exit(1);
    }
    mkdirSync(dirname(resolve(t.local)), { recursive: true });
    writeFileSync(t.local, obj.body, 'utf-8');
    console.log(`    → ${t.local} mis à jour depuis R2 (${(obj.body.length / 1e6).toFixed(1)} Mo)`);
  }
}

// ── Main ───────────────────────────────────────────────────────────────────
async function main() {
  const startedAt = Date.now();
  console.log('▶ build-magasins: démarrage');

  const filesExist = existsSync(CONFIG.input.notices) && existsSync(CONFIG.input.exemplaires);
  if (!filesExist || CONFIG.force) {
    await syncXmlFromR2();
  } else {
    console.log('  · fichiers locaux déjà présents (SYRACUSE_FORCE=1 pour forcer le re-téléchargement)');
  }

  console.log(`  · lecture ${CONFIG.input.notices}`);
  const noticesXml = readFileSync(CONFIG.input.notices, 'utf-8');
  console.log(`  · lecture ${CONFIG.input.exemplaires}`);
  const exemplairesXml = readFileSync(CONFIG.input.exemplaires, 'utf-8');

  console.log('  · indexation des notices');
  const index = indexNotices(noticesXml);
  console.log(`     ${index.count} notices, ${index.primaryItemToNotice.size} liens $995$f`);

  console.log('  · construction et filtrage (2e/5e étage uniquement)');
  const buildResult = buildItems(exemplairesXml, index);
  const s = buildResult.stats;
  console.log(
    `     ${s.totalItems} exemplaires ・ ${s.joinedByPrimary} joints, ${s.orphans} orphelins ・ ` +
    `${s.kept} gardés (2e/5e étage), ${s.excluded} exclus (6e étage)`
  );

  mkdirSync(dirname(resolve(CONFIG.output.magasins)), { recursive: true });
  writeFileSync(CONFIG.output.magasins, JSON.stringify(buildResult.items), 'utf-8');
  console.log(`  · écrit ${CONFIG.output.magasins} (${buildResult.items.length} entrées)`);

  const report = {
    generatedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    stats: {
      notices: index.count,
      items: s.totalItems,
      joinedByPrimary: s.joinedByPrimary,
      orphans: s.orphans,
      kept: s.kept,
      excluded: s.excluded,
    },
    orphansSample: s.orphansSample,
    excludedSample: s.excludedSample,
    keptEdgeSample: s.keptEdgeSample,
  };
  writeFileSync(CONFIG.output.report, JSON.stringify(report, null, 2), 'utf-8');
  console.log(`  · écrit ${CONFIG.output.report}`);

  const dur = ((Date.now() - startedAt) / 1000).toFixed(2);
  console.log(`✓ build-magasins: terminé en ${dur}s`);
}

await main();
