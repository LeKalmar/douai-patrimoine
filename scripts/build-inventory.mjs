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
import { indexNotices, buildItems } from './lib/reserve-index.mjs';

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
  const index = indexNotices(noticesXml, { whitelist: CONFIG.noticeFieldsWhitelist });
  console.log(`     ${index.count} notices, ${index.primaryItemToNotice.size} liens $995$f, ${index.coteToNotice.size} cotes de secours ($940$s)`);
  console.log(`     ${index.reliureGroupCount} groupe(s) de documents reliés ($481/$482), ${index.reliureSiblings.size} exemplaires concernés`);

  // Construction des items
  console.log('  · construction de l\'inventaire (un enregistrement par exemplaire)');
  const buildResult = buildItems(exemplairesXml, index, {
    whitelist: CONFIG.itemFieldsWhitelist,
    vignetteBaseUrl: CONFIG.vignetteBaseUrl,
  });
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
      reliureGroups: index.reliureGroupCount,
      reliureItems: s.reliureItems,
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
