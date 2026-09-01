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

// ── Piège (MARC 921$a/$b) ────────────────────────────────────────────────
// Champ Syracuse indiquant un statut particulier de l'exemplaire (pilon,
// braderie, consultation sur place, perdu…). Contrairement à bib.xml (export
// GESMARC, voir build-magasins.mjs) qui porte directement un libellé lisible
// ("Pièges"), le MARC-XML utilisé ici ne porte que les codes bruts ($a =
// nature de l'exclusion, $b = motif détaillé) — on les résout à la main avec
// cette table, construite par relevé exhaustif des couples (Code)/(Libellé)
// de bib.xml (les deux exports partagent la même table de codes Syracuse).
// Un code absent de la table est affiché tel quel plutôt que masqué.
const PIEGE_A_LABELS = {
  1: 'Exclu du prêt temporairement',
  2: 'Exclu DEFINITIVEMENT du prêt',
  3: 'Magasin', // Sans libellé dans la table Syracuse (bib.xml) — confirmé par l'équipe.
  4: 'Non réservable',
};
const PIEGE_B_LABELS = {
  2: 'en réserve',
  3: 'perdu',
  4: 'pilon',
  7: 'Equipement',
  8: 'Réserve Patrimoniale',
  9: 'Voir banque de prêt',
  10: 'Réserve Saint Exupery',
  BRAD: 'Braderie',
  CSP: 'Consultation sur place',
  EXC: 'Exclu de la recherche portail',
  MAG: 'En magasin',
  PAD: 'Prêt à Domicile',
  PER: 'Perdu',
  PIL: 'Pilon',
  QUAR: 'Quarantaine',
  RAP: '3 rappels envoyés',
  REP: 'En réparation',
  TRA: 'En traitement',
};
// Reproduit le format du champ "Pièges" déjà concaténé côté GESMARC (voir
// build-magasins.mjs), pour que recolement.html affiche la même chose quel
// que soit la source (réserve ou magasins).
function piegeLabelOf(merged) {
  const a = (merged['921$a'] || '').trim();
  const b = (merged['921$b'] || '').trim();
  const c = (merged['921$c'] || '').trim();
  const parts = [];
  if (a) parts.push(PIEGE_A_LABELS[a] || a);
  if (b) parts.push(PIEGE_B_LABELS[b] || b);
  if (c) parts.push(c);
  return parts.length ? parts.join(' ') : null;
}

// ── Reliures ($481 « aussi relié dans ce volume » / $482 « relié à la suite
// de ») ──────────────────────────────────────────────────────────────────
// Ces deux champs référencent (sous-champ $3) une AUTRE notice du même
// fichier par son numéro de contrôle ($001) : deux notices reliées dans un
// même volume physique se trouvent forcément au même emplacement en
// réserve. On construit un graphe non orienté (peu importe si le lien n'est
// enregistré que dans un sens — observé en pratique : 82 notices portent un
// $481, 487 portent un $482, seulement 32 portent les deux) et on calcule
// ses composantes connexes via Union-Find, pour regrouper même des reliures
// à plus de deux documents. Sert ensuite (voir buildItems) à propager
// automatiquement un scan à tout le groupe quand recolement.html en scanne
// un seul membre.
function makeUnionFind() {
  const parent = new Map();
  function find(x) {
    if (!parent.has(x)) parent.set(x, x);
    let root = x;
    while (parent.get(root) !== root) root = parent.get(root);
    let cur = x;
    while (parent.get(cur) !== root) { const next = parent.get(cur); parent.set(cur, root); cur = next; }
    return root;
  }
  function union(a, b) {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  }
  return { find, union };
}

// ── Étape 1 : indexer les notices ──────────────────────────────────────────
function indexNotices(xml) {
  const notices = new Map();               // noticeId -> flattened data
  const primaryItemToNotice = new Map();   // $995$f  -> noticeId
  const coteToNotice = new Map();          // cote    -> noticeId (via $940$s)
  const barcodeByNotice = new Map();       // noticeId -> $995$f (barcode propre à la notice)
  const uf = makeUnionFind();
  const reliureNodes = new Set();          // noticeId ayant au moins un lien $481/$482

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
    if (f995) {
      primaryItemToNotice.set(f995.trim(), noticeId);
      barcodeByNotice.set(noticeId, f995.trim());
    }

    // Lien de secours : $940$s (multi-exemplaires)
    for (const s of getAllSubfields(rec, '940', 's')) {
      const key = s.trim();
      if (key) coteToNotice.set(key, noticeId);
    }

    // Reliures : $481$3 et $482$3 pointent tous les deux vers un $001 d'une
    // autre notice, peu importe le sens de la relation pour notre usage.
    for (const targetId of [...getAllSubfields(rec, '481', '3'), ...getAllSubfields(rec, '482', '3')]) {
      const t = targetId.trim();
      if (!t || t === noticeId) continue;
      uf.union(noticeId, t);
      reliureNodes.add(noticeId);
      reliureNodes.add(t);
    }

    count++;
  }

  // Regroupe les noticeId par composante connexe, puis convertit chaque
  // groupe en liste de barcodes (une notice sans $995$f ne contribue aucun
  // barcode au groupe — elle n'a simplement pas d'exemplaire propre connu).
  const groupsByRoot = new Map(); // root -> Set(noticeId)
  for (const id of reliureNodes) {
    const root = uf.find(id);
    if (!groupsByRoot.has(root)) groupsByRoot.set(root, new Set());
    groupsByRoot.get(root).add(id);
  }
  const reliureSiblings = new Map(); // barcode -> [barcodes des autres documents du même volume]
  let reliureGroupCount = 0;
  for (const members of groupsByRoot.values()) {
    const barcodes = [...new Set([...members].map(id => barcodeByNotice.get(id)).filter(Boolean))];
    if (barcodes.length < 2) continue; // groupe sans au moins 2 exemplaires identifiés : rien à propager
    reliureGroupCount++;
    for (const bc of barcodes) reliureSiblings.set(bc, barcodes.filter(b => b !== bc));
  }

  return { notices, primaryItemToNotice, coteToNotice, count, reliureSiblings, reliureGroupCount };
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
    reliureItems: 0,
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
    merged._piege = piegeLabelOf(merged);

    // Vignette : reconstruite à partir du code-barres de l'exemplaire, plus
    // besoin d'une colonne CSV dédiée — l'URL S3/R2 est fixe, seul le nom du
    // fichier (le code-barres) change.
    const barcode = b915 ? b915.trim() : null;
    if (barcode) {
      merged.lien_num = `${CONFIG.vignetteBaseUrl}${barcode}.jpg`;
      merged['995$f'] = barcode;

      // Reliures ($481/$482, voir indexNotices) : autres barcodes physiquement
      // dans le même volume — consommé par recolement.html pour récoler tout
      // le groupe d'un coup quand un seul de ses membres est scanné.
      const siblings = index.reliureSiblings.get(barcode);
      if (siblings && siblings.length) {
        merged._relies = siblings;
        stats.reliureItems++;
      }
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
  console.log(`     ${index.reliureGroupCount} groupe(s) de documents reliés ($481/$482), ${index.reliureSiblings.size} exemplaires concernés`);

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
