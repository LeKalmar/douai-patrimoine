/**
 * reserve-index.mjs
 * ────────────────────────────────────────────────────────────────────────────
 * Jointure notice/exemplaire + reliures + classement réserve physique pour
 * les deux exports MARC-XML de la réserve (data/xml/notices.xml +
 * exemplaires.xml). Extrait de scripts/build-inventory.mjs (2026-09-09) pour
 * être réutilisable tel quel par la migration SQL
 * (scripts/db-migrate-reserve.mjs) — même logique exacte que celle qui
 * produit data/inventaire.json, pour que le JSON et la base ne divergent
 * jamais. build-inventory.mjs importe ce module au lieu de déclarer ces
 * fonctions inline ; appelé avec les mêmes options qu'avant, son
 * comportement est strictement inchangé (voir CONFIG.itemFieldsWhitelist/
 * noticeFieldsWhitelist, désormais passés en paramètre plutôt que lus sur un
 * CONFIG module-level).
 *
 * `captureRaw` (désactivé par défaut, donc sans effet sur
 * build-inventory.mjs) : quand activé, chaque notice/exemplaire reçoit en
 * plus une clé `_raw`, flatten() SANS whitelist (tous les tags MARC
 * présents, pas seulement ceux listés) — sert à remplir la colonne
 * `raw jsonb` de la base sans reparser le XML une seconde fois.
 *
 * Aucune dépendance npm. Node ≥ 18.
 * ────────────────────────────────────────────────────────────────────────────
 */

import {
  iterateRecords, parseRecord, getSubfield, getAllSubfields, flatten,
} from './marc-xml.mjs';
import { piegeLabelOf } from './piege-labels.mjs';

// ── Union-Find (reliures $481/$482) ─────────────────────────────────────────
export function makeUnionFind() {
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
export function indexNotices(xml, { whitelist = null, multiSep = '§', captureRaw = false } = {}) {
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

    const flat = flatten(rec, whitelist, multiSep);
    flat._noticeId = noticeId;
    if (rec.leader) flat._leader = rec.leader;
    if (captureRaw) flat._raw = flatten(rec, null, multiSep);
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
  const reliureGroups = [];          // [ [barcode, barcode, ...], ... ] — un tableau par groupe (≥2 membres)
  let reliureGroupCount = 0;
  for (const members of groupsByRoot.values()) {
    const barcodes = [...new Set([...members].map(id => barcodeByNotice.get(id)).filter(Boolean))];
    if (barcodes.length < 2) continue; // groupe sans au moins 2 exemplaires identifiés : rien à propager
    reliureGroupCount++;
    reliureGroups.push(barcodes);
    for (const bc of barcodes) reliureSiblings.set(bc, barcodes.filter(b => b !== bc));
  }

  return {
    notices, primaryItemToNotice, coteToNotice, count,
    reliureSiblings, reliureGroupCount, reliureGroups,
  };
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
export const PHYSICAL_RESERVE_PREFIXES = [
  { prefix: 'RD',   physical: 'patrimoniale' },
  { prefix: 'LIVA', physical: 'patrimoniale' },
  { prefix: 'MIN',  physical: 'douaisienne' },
  { prefix: 'D',    physical: 'douaisienne' },
  { prefix: 'I',    physical: 'patrimoniale' },
  { prefix: 'L',    physical: 'douaisienne' },
  { prefix: 'P',    physical: 'douaisienne' },
];

export function isReserveDouaisienne(coteG) {
  if (!coteG) return false;
  const cote = coteG.split(',')[0].trim().toUpperCase();
  const match = PHYSICAL_RESERVE_PREFIXES.find(({ prefix }) => cote.startsWith(prefix));
  return match ? match.physical === 'douaisienne' : false;
}

export function buildItems(xml, index, { whitelist = null, multiSep = '§', vignetteBaseUrl, captureRaw = false } = {}) {
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

    const itemFlat = flatten(rec, whitelist, multiSep);
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
    if (captureRaw) merged._itemRaw = flatten(rec, null, multiSep);

    // Vignette : reconstruite à partir du code-barres de l'exemplaire, plus
    // besoin d'une colonne CSV dédiée — l'URL S3/R2 est fixe, seul le nom du
    // fichier (le code-barres) change.
    const barcode = b915 ? b915.trim() : null;
    if (barcode) {
      if (vignetteBaseUrl) merged.lien_num = `${vignetteBaseUrl}${barcode}.jpg`;
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
