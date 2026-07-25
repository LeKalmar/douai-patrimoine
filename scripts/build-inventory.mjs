#!/usr/bin/env node
/**
 * build-inventory.mjs
 * ────────────────────────────────────────────────────────────────────────────
 * Construit `data/inventaire.json` (et `data/build-report.json`) à partir des
 * exports Syracuse en MARC-XML.
 *
 *   - data/xml/notices.xml       ← export "MarcXChange (avec recommandation 995)"
 *   - data/xml/exemplaires.xml   ← export "MarcXChange" (sans 995)
 *
 *   Si les variables R2_ACCOUNT_ID / R2_BUCKET / R2_ACCESS_KEY_ID /
 *   R2_SECRET_ACCESS_KEY sont définies (via .env en local, ou variables
 *   d'environnement Vercel), ces deux fichiers sont d'abord téléchargés
 *   depuis R2 (clés xml/notices.xml, xml/exemplaires.xml) et écrasent les
 *   fichiers locaux — voir `npm run upload:xml`. Sinon, comportement
 *   d'origine : lecture des fichiers locaux tels quels.
 *
 * Jointure :
 *   1. Principale : item.$915$b === notice.$995$f
 *   2. Secours    : notice.$940$s (liste des cotes du multi-exemplaire) mappé
 *                   sur item.$930$g
 *
 * Sortie :
 *   Un tableau d'objets, un par EXEMPLAIRE, avec les clés notice dénormalisées.
 *   Les clés suivent le format `<tag>$<code>` (ex : '200$a', '930$g'…).
 *   Quand plusieurs valeurs partagent la même clé (champs répétés), elles sont
 *   jointes par le séparateur '§' — exactement ce que `inventaire.js` sait déjà
 *   splitter.
 *
 * Mode strict :
 *   Le script fait échouer le build en cas d'anomalie (fichier manquant, 0
 *   record extrait, taux de jointure catastrophique). Pour forcer un build
 *   quand même : `SYRACUSE_FORCE=1 npm run build`.
 *
 *   Aucune dépendance npm. Node ≥ 18.
 * ────────────────────────────────────────────────────────────────────────────
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { loadDotEnv } from './lib/dotenv.mjs';
import { r2Get, r2Configured } from '../lib/r2.mjs';
import {
  iterateRecords, parseRecord, getSubfield, getAllSubfields, flatten,
} from './lib/marc-xml.mjs';

loadDotEnv();

// ── Config ─────────────────────────────────────────────────────────────────
const CONFIG = {
  input: {
    notices:     'data/xml/notices.xml',
    exemplaires: 'data/xml/exemplaires.xml',
  },
  output: {
    inventaire: 'data/inventaire.json',
    report:     'data/build-report.json',
  },
  // Base fixe du bucket de vignettes. Le nom de fichier est toujours le
  // code-barres de l'exemplaire (= $915$b côté exemplaire = $995$f côté
  // notice, la clé de jointure principale) suivi de ".jpg".
  vignetteBaseUrl: 'https://pub-85062da5f8a7451b9c168f8b3cfd980b.r2.dev/vignette/',
  // Seuil minimal de jointure : si moins de X% des items sont rattachés à une
  // notice, on considère que quelque chose cloche (mauvais fichier, IDs
  // décalés, encodage…). Réglable.
  minJoinRate: 0.20,
  // Séparateur pour les valeurs multi-occurrences d'une même clé. Doit
  // correspondre à celui utilisé côté inventaire.js (.split('§')).
  multiSep: '§',
  // Champs dont on veut TOUT récupérer sur l'exemplaire (au minimum).
  // Les autres champs sont aussi copiés, mais ceux-ci sont garantis.
  itemFieldsWhitelist: ['915', '920', '921', '922', '925', '926', '930', '201', '202', '316'],
  // Idem côté notice.
  noticeFieldsWhitelist: [
    '100','101','102','105','106','140','200','210','214','215',
    '300','303','307','316','517','610','686','700','701','702',
    '801','902','940',
  ],
  force: process.env.SYRACUSE_FORCE === '1',
};

// ── Étape 1 : indexer les notices ──────────────────────────────────────────
function indexNotices(xml) {
  const notices = new Map();               // noticeId -> flattened data
  const primaryItemToNotice = new Map();   // $995$f  -> noticeId
  const coteToNotice = new Map();          // cote    -> noticeId (via $940$s)

  let count = 0;
  for (const recXml of iterateRecords(xml)) {
    const rec = parseRecord(recXml);
    const noticeId = rec.controlfields['001'];
    if (!noticeId) continue;

    const flat = flatten(rec, CONFIG.noticeFieldsWhitelist);
    flat._noticeId = noticeId;
    if (rec.leader) flat._leader = rec.leader;
    notices.set(noticeId, flat);

    // Lien principal : $995$f
    const f995 = getSubfield(rec, '995', 'f');
    if (f995) primaryItemToNotice.set(f995.trim(), noticeId);

    // Lien de secours : $940$s (multi-exemplaires)
    for (const s of getAllSubfields(rec, '940', 's')) {
      const key = s.trim();
      if (key) coteToNotice.set(key, noticeId);
    }

    count++;
  }

  return { notices, primaryItemToNotice, coteToNotice, count };
}

// ── Étape 2 : itérer les exemplaires et faire la jointure ──────────────────
// Réserve physique d'un exemplaire à partir du préfixe de sa cote (930$g).
// Même ordre de test que FONDS_PREFIXES dans js/inventaire.js (les préfixes
// les plus spécifiques d'abord, pour éviter qu'un préfixe court comme "L" ne
// capture à tort une cote "LIVA…" ou "RD…") — mais un mapping différent :
// le fonds *nommé* "Réserve Douaisienne" (préfixe RD) n'est PAS la réserve
// physique du même nom. Sont physiquement en Réserve Douaisienne les fonds
// Douaisien (D), Littérature (L), Protestantisme (P) et Mines (MIN). Tout le
// reste (RD, LIVA, I, cotes sans préfixe reconnu) est physiquement en
// Réserve patrimoniale. Les magasins 2e/5e étage sont un export distinct
// (voir build-magasins.mjs), sans lien avec ce classement.
const PHYSICAL_RESERVE_PREFIXES = [
  { prefix: 'RD',   physical: 'patrimoniale' },
  { prefix: 'LIVA', physical: 'patrimoniale' },
  { prefix: 'MIN',  physical: 'douaisienne' },
  { prefix: 'D',    physical: 'douaisienne' },
  { prefix: 'I',    physical: 'patrimoniale' },
  { prefix: 'L',    physical: 'douaisienne' },
  { prefix: 'P',    physical: 'douaisienne' },
];

function isReserveDouaisienne(coteG) {
  if (!coteG) return false;
  const cote = coteG.split(',')[0].trim().toUpperCase();
  const match = PHYSICAL_RESERVE_PREFIXES.find(({ prefix }) => cote.startsWith(prefix));
  return match ? match.physical === 'douaisienne' : false;
}

function buildItems(xml, index) {
  const items = [];
  const stats = {
    totalItems: 0,
    joinedByPrimary: 0,
    joinedByCote: 0,
    orphans: 0,
    orphansSample: [],
    reserveDouaisienne: 0,
    reservePatrimoniale: 0,
  };

  for (const recXml of iterateRecords(xml)) {
    const rec = parseRecord(recXml);
    stats.totalItems++;

    const itemFlat = flatten(rec, CONFIG.itemFieldsWhitelist);
    const itemId = rec.controlfields['001'] ?? null;
    const g930 = getSubfield(rec, '930', 'g');

    if (isReserveDouaisienne(g930)) stats.reserveDouaisienne++;
    else stats.reservePatrimoniale++;

    // Tenter la jointure principale
    const b915 = getSubfield(rec, '915', 'b');
    let noticeId = b915 ? index.primaryItemToNotice.get(b915.trim()) : null;
    let joinType = null;
    if (noticeId) {
      stats.joinedByPrimary++;
      joinType = 'primary';
    } else {
      // Secours : tenter par $930$g
      if (g930) noticeId = index.coteToNotice.get(g930.trim());
      if (noticeId) {
        stats.joinedByCote++;
        joinType = 'cote';
      } else {
        stats.orphans++;
        if (stats.orphansSample.length < 10) {
          stats.orphansSample.push({ itemId, b915, g930 });
        }
      }
    }

    const noticeData = noticeId ? index.notices.get(noticeId) : {};

    // L'exemplaire écrase la notice en cas de collision de clé (ne devrait
    // jamais arriver — les whitelists sont disjointes — mais par sécurité).
    const merged = { ...noticeData, ...itemFlat };
    merged._itemId = itemId;
    merged._noticeId = noticeId ?? null;
    merged._joinType = joinType;

    // Vignette : reconstruite à partir du code-barres de l'exemplaire, plus
    // besoin d'une colonne CSV dédiée — l'URL S3/R2 est fixe, seul le nom du
    // fichier (le code-barres) change.
    const barcode = b915 ? b915.trim() : null;
    if (barcode) {
      merged.lien_num = `${CONFIG.vignetteBaseUrl}${barcode}.jpg`;
      merged['995$f'] = barcode;
    }

    items.push(merged);
  }

  return { items, stats };
}

// ── Étape 3 : contrôles qualité stricts ────────────────────────────────────
function assertQuality(index, buildResult) {
  const errors = [];

  if (index.count === 0) errors.push('Aucune notice extraite du fichier notices.xml.');
  if (buildResult.stats.totalItems === 0) errors.push('Aucun exemplaire extrait du fichier exemplaires.xml.');

  const joined = buildResult.stats.joinedByPrimary + buildResult.stats.joinedByCote;
  const rate = buildResult.stats.totalItems > 0 ? joined / buildResult.stats.totalItems : 0;
  if (buildResult.stats.totalItems > 0 && rate < CONFIG.minJoinRate) {
    errors.push(
      `Taux de jointure trop faible : ${(rate * 100).toFixed(1)}% ` +
      `(${joined}/${buildResult.stats.totalItems}). Attendu : ≥ ${(CONFIG.minJoinRate * 100).toFixed(0)}%.` +
      ' Vérifiez que les deux XML proviennent bien du même export Syracuse.'
    );
  }

  return errors;
}

// ── Récupération des XML depuis R2 (si configuré) ──────────────────────────
// But : ne plus committer notices.xml/exemplaires.xml (61 Mo + 14 Mo) dans
// git à chaque refresh Syracuse. Si les variables R2_* sont absentes (dev
// local sans .env), on garde le comportement d'origine : lecture des
// fichiers locaux, échec strict s'ils manquent.
async function syncXmlFromR2() {
  if (!r2Configured()) return;
  console.log('  · R2 configuré : récupération de xml/notices.xml et xml/exemplaires.xml…');
  const targets = [
    { key: 'xml/notices.xml', local: CONFIG.input.notices },
    { key: 'xml/exemplaires.xml', local: CONFIG.input.exemplaires },
  ];
  for (const t of targets) {
    try {
      const obj = await r2Get(t.key);
      if (!obj) {
        console.warn(`  ⚠ ${t.key} absent de R2 — on garde le fichier local existant (${t.local}) s'il y en a un.`);
        continue;
      }
      mkdirSync(dirname(resolve(t.local)), { recursive: true });
      writeFileSync(t.local, obj.body, 'utf-8');
      console.log(`    → ${t.local} mis à jour depuis R2 (${(obj.body.length / 1e6).toFixed(1)} Mo)`);
    } catch (err) {
      console.warn(`  ⚠ Échec de récupération de ${t.key} depuis R2 : ${err.message} — on garde le fichier local existant.`);
    }
  }
}

// ── Main ───────────────────────────────────────────────────────────────────
async function main() {
  const startedAt = Date.now();
  console.log('▶ build-inventory: démarrage');

  await syncXmlFromR2();

  // Contrôle d'existence des entrées
  for (const [role, path] of Object.entries(CONFIG.input)) {
    if (!existsSync(path)) {
      const msg = `Fichier d'entrée manquant : ${path} (${role})`;
      if (CONFIG.force) {
        console.warn(`⚠  ${msg} — SYRACUSE_FORCE=1, on continue en gardant l'ancien inventaire.json si présent.`);
        writeReport({ status: 'skipped', reason: msg, startedAt });
        process.exit(0);
      }
      console.error(`✖ ${msg}`);
      console.error('   Astuce : lancez avec SYRACUSE_FORCE=1 pour conserver l\'ancien fichier de sortie.');
      process.exit(1);
    }
  }

  // Lecture
  console.log(`  · lecture ${CONFIG.input.notices}`);
  const noticesXml = readFileSync(CONFIG.input.notices, 'utf-8');
  console.log(`  · lecture ${CONFIG.input.exemplaires}`);
  const exemplairesXml = readFileSync(CONFIG.input.exemplaires, 'utf-8');

  // Indexation des notices
  console.log('  · indexation des notices');
  const index = indexNotices(noticesXml);
  console.log(`     ${index.count} notices, ${index.primaryItemToNotice.size} liens $995$f, ${index.coteToNotice.size} cotes de secours ($940$s)`);

  // Construction des items
  console.log('  · construction de l\'inventaire (un enregistrement par exemplaire)');
  const buildResult = buildItems(exemplairesXml, index);
  const s = buildResult.stats;
  const rate = s.totalItems > 0 ? ((s.joinedByPrimary + s.joinedByCote) / s.totalItems) : 0;
  console.log(`     ${s.totalItems} exemplaires ・ ${s.joinedByPrimary} joints par ID, ${s.joinedByCote} par cote, ${s.orphans} orphelins (${(rate * 100).toFixed(1)}% joints)`);

  // Contrôles qualité
  const errors = assertQuality(index, buildResult);
  if (errors.length && !CONFIG.force) {
    console.error('✖ Contrôles qualité en échec :');
    for (const e of errors) console.error(`   - ${e}`);
    console.error('   Pour forcer le build malgré tout : SYRACUSE_FORCE=1 npm run build');
    process.exit(1);
  }
  if (errors.length && CONFIG.force) {
    console.warn('⚠  Contrôles qualité en échec, mais SYRACUSE_FORCE=1 → on continue.');
    for (const e of errors) console.warn(`   - ${e}`);
  }

  // Écriture des sorties
  mkdirSync(dirname(resolve(CONFIG.output.inventaire)), { recursive: true });
  writeFileSync(CONFIG.output.inventaire, JSON.stringify(buildResult.items), 'utf-8');
  console.log(`  · écrit ${CONFIG.output.inventaire} (${buildResult.items.length} entrées)`);

  writeReport({
    status: errors.length ? 'ok-with-warnings' : 'ok',
    warnings: errors,
    startedAt,
    stats: {
      notices: index.count,
      items: s.totalItems,
      joinedByPrimary: s.joinedByPrimary,
      joinedByCote: s.joinedByCote,
      orphans: s.orphans,
      joinRate: Number((rate * 100).toFixed(2)),
      reserveDouaisienne: s.reserveDouaisienne,
      reservePatrimoniale: s.reservePatrimoniale,
    },
    orphansSample: s.orphansSample,
  });

  const dur = ((Date.now() - startedAt) / 1000).toFixed(2);
  console.log(`✓ build-inventory: terminé en ${dur}s`);
}

// Archive le rapport du build précédent avant de le remplacer, pour que
// l'espace pro puisse afficher « export actuel vs export précédent » et un
// delta de documents. Un seul niveau d'historique (écrasé au build suivant).
function archivePreviousReport() {
  if (!existsSync(CONFIG.output.report)) return;
  const previousPath = CONFIG.output.report.replace(/\.json$/, '-previous.json');
  writeFileSync(previousPath, readFileSync(CONFIG.output.report, 'utf-8'), 'utf-8');
  console.log(`  · archivé ${CONFIG.output.report} → ${previousPath}`);
}

function writeReport(payload) {
  mkdirSync(dirname(resolve(CONFIG.output.report)), { recursive: true });
  archivePreviousReport();
  const report = {
    generatedAt: new Date().toISOString(),
    durationMs: Date.now() - (payload.startedAt ?? Date.now()),
    ...payload,
  };
  delete report.startedAt;
  writeFileSync(CONFIG.output.report, JSON.stringify(report, null, 2), 'utf-8');
  console.log(`  · écrit ${CONFIG.output.report}`);
}

await main();
