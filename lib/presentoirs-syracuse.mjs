/**
 * Fascicules bulletinés aujourd'hui dans Syracuse → mis en façade des
 * présentoirs de presse (presentoirs.html). Servi par
 * `POST /api/transferts?store=presentoirs&syracuse=jour` (authentifié),
 * appelé UNE fois au chargement de la page — jamais en boucle (demande
 * explicite, 2026-10-21 : on rafraîchit en rechargeant la page).
 *
 * Source : le portail public (voir API-SYRACUSE.MD). Un fascicule bulletiné
 * est une notice « Numéro de revue » (Frmt FASC) dont le titre vaut
 * « <Titre de série>. <numéro>, <date> » (« Elle. 4212, 11/09/2026 »), et
 * dont le code-barre n'est donné que par GetHoldings.
 *
 * « Bulletiné aujourd'hui » = champ Solr `timestamp` depuis minuit (heure de
 * Paris). Ce champ bouge aussi à chaque prêt/retour : d'anciens numéros
 * remontent (Femme actuelle de 2024…). D'où deux filtres avant tout
 * GetHoldings, qui écartent ce bruit sans appel supplémentaire :
 *   - le titre doit correspondre exactement à un étage occupé (titres
 *     bulletinés seulement) ;
 *   - le numéro doit être PLUS RÉCENT que celui en façade (même règle que le
 *     scan, compareIssues) — ou, étage sans numéro, paru il y a moins de
 *     MAX_AGE_DAYS.
 * Un seul numéro (le plus récent) par étage et par type (normal / HS).
 *
 * Ménagement de Syracuse : appels séquentiels espacés de 300 ms (comme
 * api/syracuse-tick.mjs), MAX_PAGES recherches et MAX_HOLDINGS GetHoldings
 * au plus, et COOLDOWN_MS entre deux imports réels quel que soit le nombre
 * de postes qui rechargent la page.
 */
import { r2Get, r2CasUpdate } from './r2.mjs';
import { search, getHoldings } from '../api/syracuse-tick.mjs';
import { PRESENTOIRS_KEY, emptyPresentoirsState, applyPresentoirsPatch, normSerie, parsePartie, compareIssues } from './presentoirs-state.mjs';
import { findMissingCovers, applyFoundCovers } from './presentoirs-covers.mjs';

const SITE = 'Douai Marceline Desbordes-Valmore';
const RESULT_SIZE = 50;
const MAX_PAGES = 8;
const MAX_HOLDINGS = 30;
const CALL_SPACING_MS = 300;
const COOLDOWN_MS = 2 * 60 * 1000;
const MAX_AGE_DAYS = 120;
const DAY_MS = 24 * 60 * 60 * 1000;

const sleep = ms => new Promise(r => setTimeout(r, ms));

/* Minuit à Paris, en UTC ISO (Solr compare en UTC). */
export function parisMidnightIso(now = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(now).map(p => [p.type, p.value]));
  const parisAsUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  const offset = parisAsUtc - Math.floor(now.getTime() / 1000) * 1000;
  return new Date(Date.UTC(+parts.year, +parts.month - 1, +parts.day) - offset).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/* « Que choisir ?. 660, 09/2026 » → { key:'que choisir', partie:'660 09/2026' }
   — seulement si le titre est EXACTEMENT celui d'un étage (sinon « Elle
   décoration » tomberait sur « Elle »). */
export function splitTitle(ttl, keys) {
  const t = String(ttl || '');
  for (let i = t.indexOf('. '); i >= 0; i = t.indexOf('. ', i + 1)) {
    const key = normSerie(t.slice(0, i));
    if (keys.has(key)) return { key, partie: t.slice(i + 2).replace(/,\s*/g, ' ').replace(/\s+/g, ' ').trim() };
  }
  return null;
}

function recentEnough(date, now) {
  if (!date || date.length < 7) return false;
  const d = Date.parse(date.length === 7 ? date + '-01' : date);
  return !isNaN(d) && Math.abs(now - d) < MAX_AGE_DAYS * DAY_MS;
}

/* dryRun : ni plancher ni écriture R2 (essai depuis un poste, voir
   scripts/… ou la console Node) — renvoie ce qui serait mis en façade. */
export async function importFasciculesDuJour({ now = new Date(), dryRun = false } = {}) {
  const current = await r2Get(PRESENTOIRS_KEY);
  const state = current ? JSON.parse(current.body) : emptyPresentoirsState();
  const last = state.syracuseJour;
  if (!dryRun && last && last.ts && now.getTime() - last.ts < COOLDOWN_MS) {
    return { skipped: 'recent', ...last, state };
  }

  const keyBySerie = new Map(); // normSerie → slotKey
  for (const [key, s] of Object.entries(state.slots || {})) {
    if (s && s.serie && !s.nonBulletine) keyBySerie.set(normSerie(s.serie), key);
  }

  const since = parisMidnightIso(now);
  const best = new Map(); // slotKey|kind → candidat
  let scanned = 0, total = 0, truncated = false;
  if (keyBySerie.size) {
    const q = `TypeOfDocument_exact:"Numéro de revue" AND LocationSite_exact:"${SITE}" AND timestamp:[${since} TO NOW]`;
    for (let page = 0; page < MAX_PAGES; page++) {
      if (page) await sleep(CALL_SPACING_MS);
      const r = await search(q, { page, resultSize: RESULT_SIZE });
      if (!r || !r.success || !r.d) throw new Error('Recherche Syracuse en échec.');
      total = (r.d.SearchInfo && r.d.SearchInfo.NBResults) || 0;
      const results = r.d.Results || [];
      for (const x of results) {
        scanned++;
        const R = x.Resource || {};
        if (R.RscBase && R.RscBase !== 'SYRACUSE') continue;
        const m = splitTitle(R.Ttl, keyBySerie);
        if (!m) continue;
        const p = parsePartie(m.partie);
        if (!p.numero && !p.date) continue;
        const slotKey = keyBySerie.get(m.key);
        const kind = p.hs ? 'hs' : 'normal';
        const cur = state.slots[slotKey][kind];
        const issue = { numero: p.numero, date: p.date, hs: p.hs, label: m.partie };
        if (cur ? compareIssues(issue, cur) <= 0 : !recentEnough(p.date, now)) continue;
        const k = `${slotKey}|${kind}`;
        const prev = best.get(k);
        if (!prev || compareIssues(issue, prev.issue) > 0) best.set(k, { slotKey, kind, serieKey: m.key, issue, rscId: R.RscId });
      }
      if (!results.length || (page + 1) * RESULT_SIZE >= total) break;
      if (page === MAX_PAGES - 1) truncated = true;
    }
  }

  // Code-barre : GetHoldings, exemplaire de Marceline Desbordes-Valmore hors jeunesse.
  const found = [];
  let calls = 0;
  for (const c of best.values()) {
    if (calls >= MAX_HOLDINGS) { truncated = true; break; }
    await sleep(CALL_SPACING_MS);
    calls++;
    const h = await getHoldings(c.rscId);
    const list = (h && h.d && h.d.Holdings) || [];
    const hold = list.find(x => x.Barcode && x.Site === SITE && !/jeun|ados/i.test(x.Section || ''));
    if (hold) found.push({ ...c, barcode: String(hold.Barcode) });
  }

  const ts = now.getTime();
  let placed = [];
  const fascicules = found.map(f => ({ barcode: f.barcode, serieKey: f.serieKey, partie: f.issue.label }));
  const mutate = st => {
    placed = [];
    let s = st;
    for (const f of found) {
      const slot = s.slots && s.slots[f.slotKey];
      if (!slot || normSerie(slot.serie) !== f.serieKey) continue; // étage réaffecté entre-temps
      const cur = slot[f.kind];
      if (cur && (cur.barcode === f.barcode || compareIssues(f.issue, cur) <= 0)) continue;
      s = applyPresentoirsPatch(s, {
        type: 'issue', key: f.slotKey, kind: f.kind,
        issue: { barcode: f.barcode, numero: f.issue.numero, date: f.issue.date, hs: f.issue.hs, label: f.issue.label, ts, photo: null },
      });
      placed.push({ key: f.slotKey, kind: f.kind, serie: slot.serie, barcode: f.barcode, label: f.issue.label, prev: cur ? { numero: cur.numero, date: cur.date, hs: cur.hs, label: cur.label } : null });
    }
    return { ...s, syracuseJour: { ts, since, placed, fascicules, scanned, total, truncated } };
  };
  let updated = dryRun ? mutate(state) : await r2CasUpdate(PRESENTOIRS_KEY, mutate, emptyPresentoirsState);

  // Couvertures : pour chaque numéro en façade sans couverture (ceux qui
  // viennent d'être bulletinés, et ceux dont la couverture n'était pas
  // encore publiée au dernier essai), lib/presentoirs-covers.mjs. Un échec
  // ici ne doit jamais faire échouer l'import lui-même.
  let covers = { found: [], errors: [] };
  try {
    const res = await findMissingCovers(updated, { now: ts, budgetMs: 12000 });
    covers = { found: res.found, errors: res.errors };
    if (res.patches.length || res.tried.length) {
      const addCovers = st => applyFoundCovers(st, res, applyPresentoirsPatch, ts);
      updated = dryRun ? addCovers(updated) : await r2CasUpdate(PRESENTOIRS_KEY, addCovers, emptyPresentoirsState);
    }
  } catch (e) {
    covers.errors.push(e.message);
  }

  return { ...updated.syracuseJour, covers, state: updated };
}
