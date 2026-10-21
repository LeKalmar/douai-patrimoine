/**
 * Couvertures automatiques des présentoirs de presse (presentoirs.html).
 *
 * Pour un numéro en façade sans couverture, cherche l'image de CE numéro
 * (même numéro, ou même date de parution à quelques jours près) sur une
 * source publique connue pour le titre, et la range dans state.covers sous
 * la clé presentoirCoverKey() — sous forme d'adresse (`url`), affichée depuis
 * le site d'origine comme une adresse collée à la main dans la fiche.
 *
 * Appelé par lib/presentoirs-syracuse.mjs juste après l'import des
 * fascicules bulletinés du jour (donc au chargement de la page, jamais en
 * boucle), et par `npm run import:couvertures -- auto` pour rattraper les
 * numéros déjà en place.
 *
 * Règle d'or : ne JAMAIS prendre « le dernier numéro paru » sans vérifier
 * qu'il s'agit bien du numéro en façade — une source en retard (Le Point
 * s'est arrêté en juin sur Cafeyn) donnerait sinon la couverture d'un autre
 * numéro, comme la couverture du Monde collée par erreur sur le Canard.
 *
 * Ajouter un titre = une ligne dans SOURCES, sous son « Titre de série »
 * Syracuse exact. Pour Cafeyn : identifiant numérique de la publication (seul
 * accepté par la liste des numéros) et nom court (`urlFormattedTitle`, pour
 * s'y retrouver) — le premier se lit dans « publicationId » de
 *   https://api.cafeyn.co/b2c/publications/<nom court>/lastIssue
 * Titres essayés sans succès le 2026-10-21 (absents de Cafeyn, en retard, ou
 * site qui refuse les robots) : Le Point (Cafeyn arrêté en juin, lepoint.fr
 * 403), Santé magazine (le « Santé » de Cafeyn est un homonyme néerlandais —
 * vérifier originCountryId = 76 dans /b2c/publications/<id>), M le magazine du Monde, Télérama, Marianne, Courrier international,
 * Notre temps, Version femina, Philosophie magazine, Le Particulier, 60
 * millions, L'Équipe magazine, Que choisir, Charlie hebdo, Front populaire
 * (images signées), Pour la science / Chasseur d'images / Fluide glacial /
 * Les Inrockuptibles (arrêtés sur Cafeyn depuis des années).
 */
import { normSerie, presentoirCoverKey, numVal } from './presentoirs-state.mjs';

const UA = 'Mozilla/5.0 (Bibliotheques de Douai - presentoirs de presse)';
const FETCH_TIMEOUT_MS = 8000;
const CAFEYN_SPACING_MS = 250;
const RETRY_AFTER_MS = 6 * 60 * 60 * 1000; // couverture pas encore publiée : on réessaie 6 h plus tard
const TRIES_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

const cafeyn = (id, slug) => ({ type: 'cafeyn', id, slug });
const SOURCES_BY_SERIE = {
  "L' Histoire": cafeyn(2010922, 'lhistoire'),
  'Terre sauvage': cafeyn(22011882, 'terre-sauvage'),
  "L' obs": cafeyn(22011869, 'le-nouvel-obs'),
  'Le Point': cafeyn(396, 'le-point'),
  'Figaro magazine (Le)': cafeyn(1980430, 'le-figaro-magazine'),
  'Madame figaro': cafeyn(1980436, 'madame-figaro'),
  'Causeur': cafeyn(866268, 'causeur'),
  'Rebondir': cafeyn(1511636, 'rebondir'),
  'Psychologies': cafeyn(22020282, 'psychologies'),
  "Ca m'intéresse": cafeyn(894116, 'ca-minteresse'),
  'Science et vie': cafeyn(1184565, 'science-vie'),
  "L'informaticien": cafeyn(335, 'linformaticien'),
  'Transfuge': cafeyn(155, 'transfuge'),
  'Lire': cafeyn(596094, 'lire-magazine'),
  'Beaux-arts magazine': cafeyn(2706, 'beaux-arts-magazine'),
  'Archéologia': cafeyn(22012520, 'archeologia'),
  "Les Dossiers d'archéologie": cafeyn(22012521, 'dossiers-darcheologie'),
  'Diapason': cafeyn(1276960, 'diapason'),
  'Tsugi': cafeyn(21598080, 'tsugi'),
  'Mad movies': cafeyn(21499494, 'mad-movies'),
  'Trois couleurs': cafeyn(1853874, 'troiscouleurs'),
  'Rock & [et] folk': cafeyn(597059, 'rock-folk'),
  'Topo': cafeyn(1947130, 'topo'),
  'Jeux vidéo magazine': cafeyn(989832, 'jeux-video-magazine'),
  "L' éléphant": cafeyn(1886781, 'lelephant'),
  'Cuisine actuelle': cafeyn(895188, 'cuisine-actuelle'),
  'Marie Claire idées': cafeyn(291889, 'marie-claire-idees'),
  'Système D Pratique': cafeyn(1009462, 'systeme-d'),
  'Art et décoration': cafeyn(901190, 'art-decoration'),
  'Rustica': cafeyn(1558468, 'rustica'),
  "L' Auto-journal": cafeyn(1276944, 'lauto-journal'),
  'Prima': cafeyn(894121, 'prima'),
  'Paris match': cafeyn(901212, 'paris-match'),
  'Elle': cafeyn(901198, 'elle-fr'),
  'Femme actuelle': cafeyn(894117, 'femme-actuelle'),
  "Express (L')": { type: 'lexpress' },
  'Le Monde diplomatique': { type: 'mdiplo' },
  'Alternatives économiques': { type: 'altereco' },
  'National geographic magazine France': { type: 'natgeo' },
};
const SOURCES = new Map(Object.entries(SOURCES_BY_SERIE).map(([s, src]) => [normSerie(s), src]));

export function coverSourceOf(serie) {
  return SOURCES.get(normSerie(serie)) || null;
}

/* ── Rapprochement candidat ↔ numéro en façade ─────────────────────────── */

/* Un « numéro » de 8 chiffres (20261016) est une date déguisée (Cafeyn pour
   Le Figaro Magazine, Psychologies…) : ne compte pas comme numéro. */
const realNum = n => { const v = numVal(n); return !isNaN(v) && v < 1e6 ? v : NaN; };

/* Date de parution → intervalle [début, fin] en ms. Syracuse écrit souvent un
   mensuel « 01/11/2026 » : le 1er du mois vaut le mois entier. Un mensuel
   paraît en général 2 à 6 semaines AVANT le mois de couverture. */
function dateWindow(date) {
  const s = String(date || '');
  let m;
  if ((m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/)) && m[3] !== '01') {
    const t = Date.UTC(+m[1], +m[2] - 1, +m[3]);
    return [t - 3 * DAY_MS, t + 3 * DAY_MS];
  }
  if ((m = s.match(/^(\d{4})-(\d{2})/))) {
    const start = Date.UTC(+m[1], +m[2] - 1, 1);
    return [start - 45 * DAY_MS, start + 20 * DAY_MS];
  }
  return null;
}

/* candidates = [{ numero, date (AAAA-MM-JJ), hs, url }] ; issue = numéro en
   façade. Numéro identique si les deux en ont un, sinon date compatible —
   le plus proche du début de l'intervalle s'il y en a plusieurs. */
export function pickCandidate(candidates, issue) {
  const hs = !!issue.hs;
  const pool = candidates.filter(c => c.url && !!c.hs === hs);
  const want = realNum(issue.numero);
  if (!isNaN(want)) {
    const byNum = pool.filter(c => !isNaN(realNum(c.numero)));
    if (byNum.length) return byNum.find(c => realNum(c.numero) === want) || null;
  }
  const win = dateWindow(issue.date);
  if (!win) return null;
  const inWin = pool
    .map(c => ({ c, t: Date.parse(String(c.date || '').slice(0, 10)) }))
    .filter(x => !isNaN(x.t) && x.t >= win[0] && x.t <= win[1]);
  if (!inWin.length) return null;
  const mid = (win[0] + win[1]) / 2;
  inWin.sort((a, b) => Math.abs(a.t - mid) - Math.abs(b.t - mid));
  return inWin[0].c;
}

/* ── Sources ─────────────────────────────────────────────────────────── */

async function get(url, accept) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: accept || 'text/html', 'Accept-Language': 'fr-FR,fr' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`${res.status} sur ${url}`);
  return accept === 'application/json' ? res.json() : res.text();
}

const FETCHERS = {
  /* API publique de la liseuse Cafeyn : les 10 derniers numéros, avec
     numéro, date de parution et couverture (med1.jpg ≈ 600 px). */
  async cafeyn(src) {
    const j = await get(`https://api.cafeyn.co/b2c/publications/${src.id}/issues`, 'application/json');
    return (j.collection || []).map(i => ({
      numero: i.issueNumber == null ? null : String(i.issueNumber),
      date: String(i.paperReleaseDate || i.releaseDate || '').slice(0, 10),
      hs: false,
      url: i.coverHDUrl || i.coverUrl || null,
    }));
  },
  /* lexpress.fr/hebdo/ : seulement le numéro de la semaine (« édition du
     15 octobre »), rapproché par la date. */
  async lexpress() {
    const html = await get('https://www.lexpress.fr/hebdo/');
    const m = html.match(/"wekly-publish-last".{0,400}?"display_date":"(\d{4}-\d{2}-\d{2})/s);
    const img = html.match(/hebdo-current__img[\s\S]{0,600}?<img src="(https:\/\/www\.lexpress\.fr\/resizer\/v2\/[^"]+)"/);
    if (!m || !img) return [];
    return [{ numero: null, date: m[1], hs: false, url: img[1].replace(/&amp;/g, '&') }];
  },
  /* Page d'accueil du Monde diplomatique : couverture du mois en cours
     (local/couv/AAAA-MM.jpg). L'adresse d'un mois à venir existe déjà mais
     montre une page blanche : on ne prend que les mois annoncés sur la page. */
  async mdiplo() {
    const html = await get('https://www.monde-diplomatique.fr/');
    const months = [...new Set([...html.matchAll(/local\/couv\/(\d{4})-(\d{2})\.jpg/g)].map(m => `${m[1]}-${m[2]}`))];
    // Mensuel daté du mois de couverture : on lui donne le 15 pour tomber
    // dans la fenêtre d'un « 10/2026 » comme d'un « 01/10/2026 ».
    return months.map(ym => ({ numero: null, date: `${ym}-15`, hs: false, url: `https://www.monde-diplomatique.fr/local/couv/${ym}.jpg` }));
  },
  /* Boutique d'Alternatives économiques : numéro dans le nom du fichier
     (…-ae475-couv-800px.webp). Les hors-séries (hs131…) et autres titres
     de l'éditeur sont écartés. */
  async altereco() {
    const html = await get('https://boutique.alternatives-economiques.fr/');
    const seen = new Map();
    for (const m of html.matchAll(/https:\/\/boutique\.alternatives-economiques\.fr\/media\/cache\/product_card\/[^'")\s]*?-ae(\d{3,4})-couv[^'")\s]*/g)) {
      if (!seen.has(m[1])) seen.set(m[1], { numero: m[1], date: null, hs: false, url: m[0] });
    }
    return [...seen.values()];
  },
  /* Même page que scripts/import-couvertures.mjs (source natgeo). */
  async natgeo() {
    const html = await get('https://www.natgeomagazine.fr/tous-les-numeros');
    return html.split('<article class="offer-card').slice(1).map(card => {
      const img = (card.match(/data-twic-src="image:([^"]+)"/) || [])[1];
      const num = ((card.match(/offer-card-vpc__num">([^<]*)/) || [])[1] || '').trim();
      const m = num.match(/(HS)?\s*n°\s*(\d+)/i);
      if (!img || !m) return null;
      return { numero: m[2], date: null, hs: !!m[1], url: `https://nationalgeographic.twic.pics${img}?twic=v1/resize=600` };
    }).filter(Boolean);
  },
};

/* ── Recherche des couvertures manquantes ──────────────────────────────── */

/* Numéros à couvrir : façade (normal et HS) de chaque étage dont le titre a
   une source, sans couverture déjà connue (photo prise, import, adresse
   collée) ni essai récent. includeHist : aussi les numéros remplacés. */
function wanted(state, { now, includeHist }) {
  const out = [];
  const seen = new Set();
  for (const [key, slot] of Object.entries(state.slots || {})) {
    if (!slot || !slot.serie) continue;
    const src = coverSourceOf(slot.serie);
    if (!src) continue;
    const issues = [slot.normal, slot.hs, ...(includeHist ? slot.hist || [] : [])].filter(Boolean);
    for (const it of issues) {
      if (it.photo) continue;
      const ck = presentoirCoverKey(slot.serie, it.hs, it.numero, it.date);
      if (!ck || seen.has(ck) || (state.covers && state.covers[ck])) continue;
      const tried = state.coverTries && state.coverTries[ck];
      if (tried && now - tried < RETRY_AFTER_MS) continue;
      seen.add(ck);
      out.push({ key, serie: slot.serie, src, ck, issue: it });
    }
  }
  return out;
}

/* Renvoie { patches:[{type:'cover',…}], tried:[ck…], found:[…], errors:[…] }
   sans rien écrire : l'appelant applique les patchs (CAS). Une page de
   source n'est lue qu'une fois par appel, même pour plusieurs numéros.
   budgetMs : on ne lance plus de nouvelle source au-delà (la fonction Vercel
   a déjà consommé une partie de ses 45 s avec Syracuse). */
export async function findMissingCovers(state, { now = Date.now(), includeHist = false, budgetMs = 15000 } = {}) {
  const start = Date.now();
  const todo = wanted(state, { now, includeHist });
  const cache = new Map();
  const patches = [], tried = [], found = [], errors = [];
  let lastCafeyn = 0;
  for (const w of todo) {
    const srcId = w.src.type === 'cafeyn' ? `cafeyn:${w.src.id}` : w.src.type;
    if (!cache.has(srcId)) {
      if (Date.now() - start > budgetMs) break;
      if (w.src.type === 'cafeyn') {
        const wait = lastCafeyn + CAFEYN_SPACING_MS - Date.now();
        if (wait > 0) await new Promise(r => setTimeout(r, wait));
        lastCafeyn = Date.now();
      }
      try {
        cache.set(srcId, await FETCHERS[w.src.type](w.src));
      } catch (e) {
        cache.set(srcId, null);
        errors.push(`${w.serie} : ${e.message}`);
      }
    }
    const candidates = cache.get(srcId);
    if (!candidates) continue; // source en panne : pas noté comme essayé, on retentera au prochain import
    tried.push(w.ck);
    const c = pickCandidate(candidates, w.issue);
    if (!c) continue;
    patches.push({ type: 'cover', coverKey: w.ck, url: c.url, source: `auto:${srcId}`, ts: now });
    found.push({ key: w.key, serie: w.serie, coverKey: w.ck, url: c.url });
  }
  return { patches, tried, found, errors };
}

/* Applique le résultat de findMissingCovers à un état (dans un r2CasUpdate) :
   ne remplace jamais une couverture posée entre-temps, et note les essais
   pour ne pas réinterroger les sources à chaque chargement de page. */
export function applyFoundCovers(state, { patches, tried }, applyPatch, now = Date.now()) {
  let s = state;
  for (const p of patches) {
    if (s.covers && s.covers[p.coverKey]) continue;
    s = applyPatch(s, p);
  }
  const coverTries = {};
  for (const [ck, ts] of Object.entries(s.coverTries || {})) if (now - ts < TRIES_TTL_MS) coverTries[ck] = ts;
  for (const ck of tried) coverTries[ck] = now;
  return { ...s, coverTries };
}
