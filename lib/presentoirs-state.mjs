/**
 * État partagé des présentoirs de presse adulte (presentoirs.html), clé R2
 * "presentoirs.json". Servi par api/transferts.mjs sous `?store=presentoirs`
 * — le plan Hobby plafonne un déploiement à 12 fonctions, toutes prises
 * (voir CLAUDE.md, « Présentoirs de presse »).
 *
 * Forme : { slots: { [slotKey]: slot } }, slotKey = "T1|A|1" (travée,
 * colonne, étage — étage 1 en haut). Un étage = un titre.
 *
 *   slot = { serie,            // titre de série Syracuse (« Philosophie magazine »)
 *            nonBulletine,     // true : pas de code-barre, suivi par date de parution
 *            ts,               // dernière modification de l'affectation
 *            normal: issue|null,   // numéro en façade, à consulter sur place
 *            hs:     issue|null,   // dernier hors-série, sur place jusqu'au suivant
 *            hist:   [issue…],     // numéros remplacés, plus récent d'abord (HIST_MAX)
 *            eans:   [ean13…] }    // codes-barres marchands du titre (presse non bulletinée)
 *   issue = { barcode|null, numero, date, label, hs, ts, photo|null }
 *
 * Patchs :
 *   {type:'assign', key, serie, nonBulletine, ts}   affecter / renommer (serie:null = vider l'étage)
 *   {type:'issue', key, kind:'normal'|'hs', issue}  nouveau numéro en façade ; l'ancien part dans hist
 *   {type:'ean', key, ean, remove}                  associe / dissocie un code-barre marchand (EAN-13)
 *   {type:'undo', key, kind}                        rétablit le dernier numéro remplacé de ce type
 *   {type:'photo', key, kind, photo}                rattache une photo de couverture au numéro en place
 *   {type:'cover', coverKey, photo, source}         couverture d'un numéro par titre + numéro (state.covers)
 *
 * `syracuseJour` (hors patchs, écrit par lib/presentoirs-syracuse.mjs) :
 * dernier import des fascicules bulletinés du jour —
 * { ts, since, placed:[…], fascicules:[…], scanned, total, truncated }.
 */

export const PRESENTOIRS_KEY = 'presentoirs.json';
const HIST_MAX = 12;
const EANS_MAX = 10;
const KEY_RE = /^T[1-3]\|[A-Z]{1,2}\|[1-9]$/;

class BadRequest extends Error {
  constructor(message) {
    super(message);
    this.status = 400;
  }
}

export function emptyPresentoirsState() {
  return { slots: {} };
}

function cleanIssue(raw) {
  if (!raw || typeof raw !== 'object') throw new BadRequest('issue requis.');
  const str = (v, max) => (v === undefined || v === null || v === '' ? null : String(v).slice(0, max));
  return {
    barcode: str(raw.barcode, 32),
    numero: str(raw.numero, 40),
    date: str(raw.date, 10),     // AAAA-MM-JJ, AAAA-MM ou AAAA
    label: str(raw.label, 120),
    hs: !!raw.hs,
    ts: Number(raw.ts) || Date.now(),
    photo: str(raw.photo, 64),
  };
}

/* Couvertures indexées par titre + numéro, indépendamment de l'étage et du
   code-barre : une couverture importée d'un site d'éditeur (scripts/
   import-couvertures.mjs) s'affiche dès que ce numéro passe en façade.
   Clé = "<titre normalisé>|n|<numéro>" ou "…|hs|<numéro>". Partagé entre la
   page et le script d'import, pour qu'ils calculent la même clé. */
export function normSerie(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
}
/* Sans numéro (journal non bulletiné), la date de parution sert de clé :
   « …|d|20261020 ». */
export function presentoirCoverKey(serie, hs, numero, date) {
  const m = String(numero == null ? '' : numero).match(/\d+/);
  if (m) return `${normSerie(serie)}|${hs ? 'hs' : 'n'}|${parseInt(m[0], 10)}`;
  const d = String(date || '').replace(/-/g, '');
  return /^\d{4,8}$/.test(d) ? `${normSerie(serie)}|d|${d}` : null;
}
/* Numéros — « Titre de partie et N° de partie » de bib.xml (« 119 05/2018 »,
   « 282 HS 04/2018 », « HS193 04/2018 », « 81 H 08/2026 »…). Partagé entre
   la page et lib/presentoirs-syracuse.mjs (import des fascicules bulletinés
   du jour), pour qu'ils lisent et comparent les numéros de la même façon. */
const pad2 = n => String(n).padStart(2, '0');
export function parsePartie(tp) {
  let s = String(tp || '').trim();
  let date = null;
  const dm = [...s.matchAll(/(?:(\d{1,2})\/)?(\d{1,2})\/(\d{4})/g)].pop();
  if (dm) {
    date = dm[1] ? `${dm[3]}-${pad2(dm[2])}-${pad2(dm[1])}` : `${dm[3]}-${pad2(dm[2])}`;
    s = s.slice(0, dm.index) + s.slice(dm.index + dm[0].length);
  } else {
    const ym = s.match(/^(.+?)\s+((?:19|20)\d{2})$/);
    if (ym) { date = ym[2]; s = ym[1]; }
  }
  // « 282 HS 04/2018 », « HS193 04/2018 », et « 81 H 08/2026 » (National Geographic).
  const hs = /(^|\s)HS(\s|\d|$)|\dHS\b|^\d+\s*H(\s|$)/i.test(String(tp || ''));
  const numero = s.replace(/(^|\s)HS(?=\s|\d|$)/ig, ' ').replace(/^(\d+)\s*H(?=\s|$)/i, '$1').replace(/\s+/g, ' ').trim() || null;
  return { numero, date, hs };
}
export const numVal = n => { const m = String(n || '').match(/\d+/); return m ? parseInt(m[0], 10) : NaN; };
/* < 0 : a plus ancien que b ; par date de parution, puis par numéro. */
export function compareIssues(a, b) {
  if (a.date && b.date) {
    const n = Math.min(a.date.length, b.date.length);
    const c = a.date.slice(0, n).localeCompare(b.date.slice(0, n));
    if (c) return c;
  }
  const na = numVal(a.numero), nb = numVal(b.numero);
  if (!isNaN(na) && !isNaN(nb) && na !== nb) return na - nb;
  return 0;
}

const COVER_KEY_RE = /^[a-z0-9 ]{1,160}\|(n|hs|d)\|\d{1,8}$/;
const COVER_URL_RE = /^https:\/\/[^\s"'<>]{1,500}$/;

export function applyPresentoirsPatch(state, patch) {
  // {type:'cover', coverKey, photo | url, source} — ni photo ni url : retire la couverture.
  // photo = vignette R2 (photo prise, import) ; url = adresse d'image collée
  // à la main (affichée telle quelle depuis le site d'origine).
  if (patch.type === 'cover') {
    if (!COVER_KEY_RE.test(patch.coverKey || '')) throw new BadRequest(`Clé de couverture invalide : ${patch.coverKey}`);
    if (patch.url && !COVER_URL_RE.test(patch.url)) throw new BadRequest('Adresse d\'image invalide (https attendu).');
    const covers = { ...(state.covers || {}) };
    if (patch.photo || patch.url) {
      covers[patch.coverKey] = {
        photo: patch.photo ? String(patch.photo).slice(0, 64) : null,
        url: patch.photo ? null : String(patch.url),
        source: patch.source ? String(patch.source).slice(0, 300) : null,
        ts: Number(patch.ts) || Date.now(),
      };
    } else delete covers[patch.coverKey];
    return { ...state, covers };
  }
  const slots = { ...(state.slots || {}) };
  const key = patch.key;
  if (!KEY_RE.test(key || '')) throw new BadRequest(`Emplacement invalide : ${key}`);
  const slot = slots[key] ? { ...slots[key] } : { serie: null, nonBulletine: false, ts: 0, normal: null, hs: null, hist: [] };
  const kindOf = () => {
    if (patch.kind !== 'normal' && patch.kind !== 'hs') throw new BadRequest('kind : normal ou hs.');
    return patch.kind;
  };

  if (patch.type === 'assign') {
    if (!patch.serie) {
      delete slots[key];
      return { ...state, slots };
    }
    const changed = slot.serie !== patch.serie;
    slot.serie = String(patch.serie).slice(0, 160);
    slot.nonBulletine = !!patch.nonBulletine;
    slot.ts = Number(patch.ts) || Date.now();
    // Un autre titre sur cet étage : ses numéros n'ont plus rien à faire ici.
    if (changed) { slot.normal = null; slot.hs = null; slot.hist = []; slot.eans = []; }
  } else if (patch.type === 'issue') {
    const kind = kindOf();
    const issue = cleanIssue(patch.issue);
    issue.hs = kind === 'hs';
    const prev = slot[kind];
    // Rejeu d'un patch déjà appliqué (file hors ligne) : rien à faire.
    if (prev && prev.ts === issue.ts && prev.barcode === issue.barcode) return state;
    slot.hist = prev ? [prev, ...(slot.hist || [])].slice(0, HIST_MAX) : (slot.hist || []);
    slot[kind] = issue;
    slot.ts = Date.now();
  } else if (patch.type === 'ean') {
    // Code-barre marchand (EAN-13 de la presse) : identifie le TITRE, pas le
    // numéro. Un titre peut en avoir plusieurs (changement de prix…).
    const ean = String(patch.ean || '');
    if (!/^\d{13}$/.test(ean)) throw new BadRequest('ean : 13 chiffres attendus.');
    const eans = (slot.eans || []).filter(e => e !== ean);
    slot.eans = patch.remove ? eans : [ean, ...eans].slice(0, EANS_MAX);
    slot.ts = Date.now();
  } else if (patch.type === 'undo') {
    const kind = kindOf();
    const hist = [...(slot.hist || [])];
    const i = hist.findIndex(it => !!it.hs === (kind === 'hs'));
    slot[kind] = i >= 0 ? hist.splice(i, 1)[0] : null;
    slot.hist = hist;
    slot.ts = Date.now();
  } else if (patch.type === 'photo') {
    const kind = kindOf();
    if (!slot[kind]) return state; // numéro remplacé entre-temps : sans objet
    slot[kind] = { ...slot[kind], photo: patch.photo ? String(patch.photo).slice(0, 64) : null };
  } else {
    throw new BadRequest(`Type de patch inconnu : ${patch.type}`);
  }

  slots[key] = slot;
  return { ...state, slots };
}
