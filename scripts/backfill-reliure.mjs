#!/usr/bin/env node
/**
 * node scripts/backfill-reliure.mjs [--apply]
 *
 * Rattrapage rétroactif de la fonctionnalité "reliures" (récolement en
 * cascade des documents catalogués ensemble via $481/$482 — voir
 * build-inventory.mjs et handleScan()/applyReliureCascade() dans
 * recolement.html) : pour chaque groupe de documents reliés dans
 * data/inventaire.json (champ `_relies`), si au moins un membre du groupe a
 * déjà été récolé (scans.<barcode> dans l'état partagé R2), les autres
 * membres du même groupe qui n'ont PAS encore de scan reçoivent un scan
 * synthétique au même emplacement (marqué `viaReliure`, comme le ferait
 * handleScan() en direct). Sans ce script, seuls les scans faits APRÈS la
 * mise en place de la cascade en bénéficient — les emplacements déjà
 * récolés avant ce jour ne seraient jamais rattrapés.
 *
 * Ne touche jamais un scan déjà existant : n'ajoute que les barcodes
 * manquants. Si les membres déjà scannés d'un même groupe sont à des
 * emplacements DIFFÉRENTS (incohérence à vérifier à la main — reliure mal
 * identifiée, ou scan erroné), le groupe est signalé et laissé de côté.
 *
 * Par défaut : dry-run (affiche ce qui serait fait, n'écrit rien). Avec
 * --apply : pousse réellement le lot vers R2 via un patch bulkMerge
 * (compare-and-swap, comme le reste de la synchro — voir
 * api/recolement.mjs), donc visible immédiatement par tout le monde via
 * /api/recolement, sans qu'aucun navigateur n'ait besoin de rejouer quoi que
 * ce soit.
 */
import { readFileSync } from 'node:fs';
import { loadDotEnv } from './lib/dotenv.mjs';
import { r2Get, r2CasUpdate, r2Configured } from '../lib/r2.mjs';

loadDotEnv();

const APPLY = process.argv.includes('--apply');
const KEY = 'recolement.json';

function locKeyOf(r) { return `${r.travee}|${r.colonne}|${r.etage}`; }

function emptyState() {
  return { scans: [], nonCatalogues: [], videShelves: [], nonRangeShelves: [], lastShelves: [], resolvedIssues: [] };
}

function buildCatalogGroups() {
  if (!r2Configured()) {
    console.error('R2 non configuré (.env manquant) — impossible de lire/écrire l\'état partagé.');
    process.exit(1);
  }

  console.log('· lecture data/inventaire.json');
  const items = JSON.parse(readFileSync('data/inventaire.json', 'utf-8'));
  const catalogByBc = new Map();
  items.forEach(it => {
    const bc = (it['995$f'] || '').trim();
    if (bc) catalogByBc.set(bc, it);
  });

  // Reconstruit les groupes (cliques) à partir de _relies, en dédoublonnant
  // (chaque membre du groupe porte la même liste de siblings, à lui-même près).
  const seen = new Set();
  const groups = [];
  items.forEach(it => {
    const bc = (it['995$f'] || '').trim();
    if (!bc || seen.has(bc) || !Array.isArray(it._relies) || !it._relies.length) return;
    const group = [...new Set([bc, ...it._relies])];
    group.forEach(b => seen.add(b));
    groups.push(group);
  });
  console.log(`· ${groups.length} groupe(s) de documents reliés dans le catalogue actuel`);

  return { items, catalogByBc, groups };
}

async function run() {
  const { catalogByBc, groups } = buildCatalogGroups();

  console.log('· lecture de l\'état partagé R2 (recolement.json)');
  const current = await r2Get(KEY);
  const state = current ? JSON.parse(current.body) : emptyState();
  const scansByBc = new Map();
  (state.scans || []).forEach(r => { if (r.barcode) scansByBc.set(r.barcode, r); });

  const toAdd = [];       // nouveaux scans synthétiques
  const conflicts = [];   // groupes à emplacements incohérents, laissés de côté
  let groupsAlreadyDone = 0;
  let groupsUntouched = 0;

  for (const group of groups) {
    const scannedMembers = group.filter(bc => scansByBc.has(bc));
    if (scannedMembers.length === 0) { groupsUntouched++; continue; }

    const locKeys = new Set(scannedMembers.map(bc => locKeyOf(scansByBc.get(bc))));
    if (locKeys.size > 1) {
      conflicts.push({
        group,
        details: scannedMembers.map(bc => ({ barcode: bc, cote: catalogByBc.get(bc)?.['930$g'] || '', loc: locKeyOf(scansByBc.get(bc)) })),
      });
      continue;
    }
    if (scannedMembers.length === group.length) { groupsAlreadyDone++; continue; }

    const reference = scansByBc.get(scannedMembers[0]);
    const missing = group.filter(bc => !scansByBc.has(bc));
    missing.forEach(bc => {
      const cat = catalogByBc.get(bc);
      toAdd.push({
        barcode: bc,
        cote: (cat?.['930$g'] || '').trim(),
        titre: (cat?.['200$a'] || '').trim(),
        auteur: (cat?.['700$a'] || '').trim(),
        fonds: reference.fonds || '',
        etat: (cat?.['316$a'] || '').trim(),
        manuel: false,
        kind: reference.kind,
        travee: reference.travee, colonne: reference.colonne, etage: reference.etage,
        barcodeAbime: false,
        viaReliure: scannedMembers[0],
        ts: reference.ts,
      });
    });
  }

  console.log('');
  console.log(`✓ ${groupsAlreadyDone} groupe(s) déjà entièrement récolés — rien à faire`);
  console.log(`✓ ${groupsUntouched} groupe(s) pas encore récolés du tout — seront traités automatiquement au premier scan (cascade en direct)`);
  console.log(`→ ${toAdd.length} scan(s) synthétique(s) à ajouter, répartis sur ${new Set(toAdd.map(r=>r.viaReliure)).size} groupe(s) partiellement récolés`);
  if (conflicts.length) {
    console.log(`⚠ ${conflicts.length} groupe(s) à emplacements INCOHÉRENTS entre membres déjà scannés — laissés de côté, à vérifier à la main :`);
    conflicts.forEach(c => {
      console.log(`   groupe ${c.group.length} doc(s) :`);
      c.details.forEach(d => console.log(`     - ${d.barcode} (${d.cote || 'cote inconnue'}) → ${d.loc}`));
    });
  }

  if (toAdd.length) {
    console.log('');
    console.log('Aperçu (10 premiers) :');
    toAdd.slice(0, 10).forEach(r => {
      console.log(`   + ${r.barcode} (${r.cote || 'cote inconnue'}) → ${r.travee}|${r.colonne}|${r.etage} [relié avec ${r.viaReliure}]`);
    });
  }

  if (!APPLY) {
    console.log('');
    console.log('Dry-run (rien écrit). Relancer avec --apply pour pousser ces scans vers R2.');
    return;
  }

  if (!toAdd.length) {
    console.log('');
    console.log('Rien à appliquer.');
    return;
  }

  console.log('');
  console.log(`· écriture de ${toAdd.length} scan(s) dans R2 (compare-and-swap)…`);
  await r2CasUpdate(KEY, data => {
    const scans = {};
    (data.scans || []).forEach(r => { if (r.barcode) scans[r.barcode] = r; });
    toAdd.forEach(r => {
      const existing = scans[r.barcode];
      if (!existing || !existing.ts || r.ts > existing.ts) scans[r.barcode] = r;
    });
    return { ...data, scans: Object.values(scans) };
  }, emptyState);
  console.log('✓ terminé — visible immédiatement via /api/recolement pour tout le monde.');
}

await run();
