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

// ── Parseur MARC-XML minimaliste (sans dépendance) ─────────────────────────
// Le MARC-XML étant très régulier, quelques regex suffisent et sont
// nettement plus rapides que d'instancier un DOM complet sur 14 Mo.

const XML_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
function decodeXml(s) {
  return s.replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (m, ent) => {
    if (ent[0] === '#') {
      const code = ent[1] === 'x' ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
      return String.fromCodePoint(code);
    }
    return XML_ENTITIES[ent.toLowerCase()] ?? m;
  });
}

function* iterateRecords(xml) {
  const re = /<record\b[^>]*>([\s\S]*?)<\/record>/g;
  let m;
  while ((m = re.exec(xml))) yield m[1];
}

function parseRecord(recordXml) {
  const rec = { controlfields: {}, datafields: [] };

  const leader = recordXml.match(/<leader>([^<]*)<\/leader>/);
  if (leader) rec.leader = decodeXml(leader[1]);

  const cfRe = /<controlfield\s+tag="([^"]+)">([^<]*)<\/controlfield>/g;
  let m;
  while ((m = cfRe.exec(recordXml))) {
    rec.controlfields[m[1]] = decodeXml(m[2]);
  }

  const dfRe = /<datafield\s+tag="([^"]+)"[^>]*>([\s\S]*?)<\/datafield>/g;
  while ((m = dfRe.exec(recordXml))) {
    const tag = m[1];
    const inner = m[2];
    const subfields = [];
    const sfRe = /<subfield\s+code="([^"]+)">([\s\S]*?)<\/subfield>/g;
    let sm;
    while ((sm = sfRe.exec(inner))) {
      // Ignorer le sous-champ '#' que Syracuse ajoute partout (métadonnée
      // interne, jamais utile côté site public).
      if (sm[1] === '#') continue;
      subfields.push({ code: sm[1], value: decodeXml(sm[2]) });
    }
    rec.datafields.push({ tag, subfields });
  }

  return rec;
}

// Retourne la première valeur trouvée pour un couple (tag, code), ou null.
function getSubfield(record, tag, code) {
  for (const df of record.datafields) {
    if (df.tag !== tag) continue;
    for (const sf of df.subfields) {
      if (sf.code === code) return sf.value;
    }
  }
  return null;
}

// Retourne TOUS les $s pour tous les $tag (utile pour $940$s multi-cotes).
function getAllSubfields(record, tag, code) {
  const out = [];
  for (const df of record.datafields) {
    if (df.tag !== tag) continue;
    for (const sf of df.subfields) {
      if (sf.code === code) out.push(sf.value);
    }
  }
  return out;
}

// Convertit un record parsé en objet plat { "200$a": "...", "700$a": "..." }
// Les répétitions sont concaténées avec CONFIG.multiSep.
function flatten(record, whitelist = null) {
  const out = {};
  for (const df of record.datafields) {
    if (whitelist && !whitelist.includes(df.tag)) continue;
    for (const sf of df.subfields) {
      const key = `${df.tag}$${sf.code}`;
      if (out[key] === undefined) out[key] = sf.value;
      else out[key] = out[key] + CONFIG.multiSep + sf.value;
    }
  }
  return out;
}

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
function buildItems(xml, index) {
  const items = [];
  const stats = {
    totalItems: 0,
    joinedByPrimary: 0,
    joinedByCote: 0,
    orphans: 0,
    orphansSample: [],
  };

  for (const recXml of iterateRecords(xml)) {
    const rec = parseRecord(recXml);
    stats.totalItems++;

    const itemFlat = flatten(rec, CONFIG.itemFieldsWhitelist);
    const itemId = rec.controlfields['001'] ?? null;

    // Tenter la jointure principale
    const b915 = getSubfield(rec, '915', 'b');
    let noticeId = b915 ? index.primaryItemToNotice.get(b915.trim()) : null;
    let joinType = null;
    if (noticeId) {
      stats.joinedByPrimary++;
      joinType = 'primary';
    } else {
      // Secours : tenter par $930$g
      const g930 = getSubfield(rec, '930', 'g');
      if (g930) noticeId = index.coteToNotice.get(g930.trim());
      if (noticeId) {
        stats.joinedByCote++;
        joinType = 'cote';
      } else {
        stats.orphans++;
        if (stats.orphansSample.length < 10) {
          stats.orphansSample.push({ itemId, b915, g930: getSubfield(rec, '930', 'g') });
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

// ── Main ───────────────────────────────────────────────────────────────────
function main() {
  const startedAt = Date.now();
  console.log('▶ build-inventory: démarrage');

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
    },
    orphansSample: s.orphansSample,
  });

  const dur = ((Date.now() - startedAt) / 1000).toFixed(2);
  console.log(`✓ build-inventory: terminé en ${dur}s`);
}

function writeReport(payload) {
  mkdirSync(dirname(resolve(CONFIG.output.report)), { recursive: true });
  const report = {
    generatedAt: new Date().toISOString(),
    durationMs: Date.now() - (payload.startedAt ?? Date.now()),
    ...payload,
  };
  delete report.startedAt;
  writeFileSync(CONFIG.output.report, JSON.stringify(report, null, 2), 'utf-8');
  console.log(`  · écrit ${CONFIG.output.report}`);
}

main();
