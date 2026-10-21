#!/usr/bin/env node
/**
 * import-couvertures.mjs
 * ────────────────────────────────────────────────────────────────────────────
 * Importe les couvertures publiées par un éditeur sur son site, pour
 * presentoirs.html : chaque image va dans R2 (vignette/presse_<source>_….jpg,
 * relue par GET /api/vignette) et son identifiant est rangé dans
 * presentoirs.json → covers["<titre normalisé>|n|325"] (ou "|hs|81"), la même
 * clé que celle que calcule la page (presentoirCoverKey, lib/presentoirs-state.mjs).
 * Une couverture est donc liée au titre + numéro, pas à un étage ni à un
 * code-barre : elle s'affiche dès que ce numéro passe en façade.
 *
 *   npm run import:couvertures -- natgeo            simulation (rien n'est écrit)
 *   npm run import:couvertures -- natgeo --apply    écrit dans R2
 *   … --force                                        réimporte les couvertures déjà présentes
 *   npm run import:couvertures -- auto [--apply]     couvertures automatiques (lib/presentoirs-covers.mjs)
 *                                                    pour TOUS les numéros en place et leurs
 *                                                    prédécesseurs (casier), sans attendre l'import du jour
 *
 * Ajouter un titre = une entrée dans SOURCES : la page à lire, le titre de
 * série EXACT tel qu'il figure dans Syracuse (« Titre de série » de bib.xml),
 * et une fonction qui renvoie [{ numero, hs, date, imageUrl }]. Ces pages
 * changent sans prévenir : si un import ne trouve plus rien, c'est le
 * parseur de la source qui est à revoir.
 *
 * Aucune dépendance npm. Node ≥ 18. Nécessite R2 configuré (.env).
 * ────────────────────────────────────────────────────────────────────────────
 */
import { loadDotEnv } from './lib/dotenv.mjs';
import { r2Get, r2Put, r2CasUpdate, r2Configured } from '../lib/r2.mjs';
import { PRESENTOIRS_KEY, emptyPresentoirsState, applyPresentoirsPatch, presentoirCoverKey } from '../lib/presentoirs-state.mjs';
import { findMissingCovers, applyFoundCovers } from '../lib/presentoirs-covers.mjs';

loadDotEnv();

const UA = 'Mozilla/5.0 (Bibliotheques de Douai - presentoirs de presse)';

const SOURCES = {
  natgeo: {
    serie: 'National geographic magazine France',
    url: 'https://www.natgeomagazine.fr/tous-les-numeros',
    /* Une carte par numéro : <article class="offer-card…"> avec l'image
       (TwicPics, data-twic-src="image:/media/…jpg"), « n°325 » ou « HS n°81 »
       et le mois de parution. */
    parse(html) {
      return html.split('<article class="offer-card').slice(1).map(card => {
        const img = (card.match(/data-twic-src="image:([^"]+)"/) || [])[1];
        const num = ((card.match(/offer-card-vpc__num">([^<]*)/) || [])[1] || '').trim();
        const date = ((card.match(/offer-card-vpc__date">([^<]*)/) || [])[1] || '').trim();
        const m = num.match(/(HS)?\s*n°\s*(\d+)/i);
        if (!img || !m) return null;
        // resize=600 : le plan affiche ~100 px, la fiche ~80 px ; 600 suffit largement.
        return { numero: m[2], hs: !!m[1], date, imageUrl: `https://nationalgeographic.twic.pics${img}?twic=v1/resize=600` };
      }).filter(Boolean);
    },
  },
};

/* Même recherche que celle lancée après l'import Syracuse du jour, mais sur
   tous les numéros en place ET l'historique, sans plafond de temps ni
   délai entre deux essais : les adresses trouvées sont rangées telles quelles
   (covers[k].url), rien n'est copié dans R2. */
async function auto(apply) {
  if (!r2Configured()) { console.error('✖ R2 non configuré (.env).'); process.exit(1); }
  const current = await r2Get(PRESENTOIRS_KEY);
  const state = current ? JSON.parse(current.body) : emptyPresentoirsState();
  const res = await findMissingCovers({ ...state, coverTries: {} }, { includeHist: true, budgetMs: Infinity });
  for (const f of res.found) console.log(`  ✓ ${f.serie} — ${f.coverKey}
      ${f.url}`);
  for (const e of res.errors) console.warn(`  ⚠ ${e}`);
  console.log(`
${res.found.length} couverture(s) trouvée(s) sur ${res.tried.length} numéro(s) cherché(s).`);
  if (!apply) { console.log('Simulation : relancer avec --apply pour écrire dans R2.'); return; }
  if (!res.patches.length) return;
  await r2CasUpdate(PRESENTOIRS_KEY, st => applyFoundCovers(st, res, applyPresentoirsPatch), emptyPresentoirsState);
  console.log(`✓ Enregistré dans ${PRESENTOIRS_KEY}.`);
}

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const force = args.includes('--force');
  const name = args.find(a => !a.startsWith('--'));
  if (name === 'auto') return auto(apply);
  const src = SOURCES[name];
  if (!src) {
    console.error(`Usage : npm run import:couvertures -- <source> [--apply] [--force]\nSources : ${Object.keys(SOURCES).join(', ')}, auto`);
    process.exit(1);
  }
  if (apply && !r2Configured()) { console.error('✖ R2 non configuré (.env).'); process.exit(1); }

  console.log(`▶ ${src.url}`);
  const res = await fetch(src.url, { headers: { 'User-Agent': UA } });
  if (!res.ok) { console.error(`✖ ${res.status} sur ${src.url}`); process.exit(1); }
  const issues = src.parse(await res.text());
  if (!issues.length) { console.error('✖ Aucun numéro trouvé : la page a sans doute changé, revoir parse().'); process.exit(1); }

  const current = r2Configured() ? await r2Get(PRESENTOIRS_KEY) : null;
  const covers = current ? (JSON.parse(current.body).covers || {}) : {};

  const patches = [];
  for (const it of issues) {
    const coverKey = presentoirCoverKey(src.serie, it.hs, it.numero);
    const label = `${it.hs ? 'HS ' : 'n°'}${it.numero} (${it.date})`;
    if (covers[coverKey] && !force) { console.log(`  · ${label} — déjà présente`); continue; }
    const photo = `presse_${name}_${it.hs ? 'hs' : 'n'}${it.numero}`;
    if (!apply) { console.log(`  · ${label} → ${coverKey} (simulation)`); continue; }
    const img = await fetch(it.imageUrl, { headers: { 'User-Agent': UA } });
    const type = img.headers.get('content-type') || '';
    if (!img.ok || !type.startsWith('image/jpeg')) { console.warn(`  ⚠ ${label} — image refusée (${img.status} ${type})`); continue; }
    const buf = Buffer.from(await img.arrayBuffer());
    await r2Put(`vignette/${photo}.jpg`, buf, { contentType: 'image/jpeg' });
    patches.push({ type: 'cover', coverKey, photo, source: it.imageUrl, ts: Date.now() });
    console.log(`  ✓ ${label} → vignette/${photo}.jpg (${Math.round(buf.length / 1024)} Ko)`);
    await new Promise(r => setTimeout(r, 300)); // un appel à la fois, sans marteler le site
  }

  if (!apply) { console.log(`\n${issues.length} numéros trouvés. Relancer avec --apply pour écrire dans R2.`); return; }
  if (!patches.length) { console.log('\nRien de nouveau à enregistrer.'); return; }
  await r2CasUpdate(PRESENTOIRS_KEY, state => patches.reduce(applyPresentoirsPatch, state), emptyPresentoirsState);
  console.log(`\n✓ ${patches.length} couverture(s) enregistrée(s) dans ${PRESENTOIRS_KEY}.`);
}

await main();
