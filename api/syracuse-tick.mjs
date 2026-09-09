/**
 * Moteur de synchronisation incrémentale avec le portail Syracuse
 * (bm-douai.fr) — voir API-SYRACUSE.MD, §19-22, pour la découverte du
 * champ Solr `timestamp` et le protocole qui a validé qu'une notice
 * modifiée est détectable en moins d'une minute avec la cote à jour.
 *
 * POST /api/syracuse-tick, non authentifié, déclenché en tâche de fond
 * par js/syracuse-sync-trigger.js à chaque chargement de recolement.html,
 * magasins.html ou reserve.html — voir CLAUDE.md, section « Synchronisation
 * incrémentale Syracuse ». Contrairement aux six autres endpoints du
 * projet, il n'expose aucune donnée fournie par l'appelant : un appel
 * ne fait qu'avancer (ou pas) un job serveur déjà entièrement défini
 * côté serveur. C'est ce qui permet de le laisser public sans risque —
 * voir les garde-fous ci-dessous, qui rendent des appels répétés (même
 * malveillants) sans effet sur Syracuse.
 *
 * Volontairement PAS un proxy générique vers Search.svc/Search ou
 * ILSClient.svc/GetHoldings : exposer ces deux actions en passthrough
 * public serait le vrai risque de surcharge (n'importe qui pourrait
 * relayer des requêtes illimitées vers Syracuse à travers notre propre
 * domaine, sans la friction d'un navigateur). search()/getHoldings()
 * restent donc des fonctions internes, jamais routées.
 *
 * ─── Garde-fous (tous ici, aucun reporté à plus tard) ───
 * 1. Plancher (FLOOR_MS, 1 min) + verrou anti-concurrence, tous deux
 *    vérifiés AVANT le moindre appel réseau vers Syracuse (voir
 *    claimSlot()) : posés via une écriture R2 en compare-and-swap
 *    (r2CasUpdate), qui garantit qu'un seul appel concurrent « prend la
 *    main » — un second appel presque simultané relit l'état que le
 *    premier vient de poser et se déclare `too-soon`/`in-progress` à son
 *    tour. Un verrou resté posé plus de 2 min (LOCK_STALE_MS, largement
 *    au-dessus de la durée réelle d'une tranche, de l'ordre de ~33 s) est
 *    considéré comme issu d'une invocation plantée et peut être repris,
 *    plancher ignoré.
 * 2. Jamais de Promise.all entre appels Syracuse : boucle for séquentielle,
 *    300 ms d'attente entre deux appels (CALL_SPACING_MS, INTOUCHÉ — c'est
 *    la seule protection réelle du débit vers Syracuse), search compris.
 *    FLOOR_MS et MAX_HOLDINGS_PER_TICK (cadence relevée le 2026-09-09, voir
 *    CLAUDE.md) ne changent que la durée/fréquence des rafales, jamais
 *    leur intensité crête.
 * 3. Comparaison avant écriture : une réindexation en masse bouge
 *    `timestamp` sans changer le contenu (§19) — on ne grossit l'état que
 *    sur un vrai changement.
 * 4. Interrupteur automatique : MAX_CONSECUTIVE_ERRORS tranches en échec
 *    d'affilée → enabled:false. Seul un POST authentifié vers
 *    /api/syracuse-sync ({type:'setEnabled', enabled:true}) peut le
 *    relever — décision humaine requise.
 * 5. Détection de la disparition du champ `timestamp` (§19) : si aucune
 *    notice détectée depuis SANITY_CHECK_QUIET_MS alors que la baseline
 *    mesurée est de ~200 à 800/jour, une requête de contrôle ponctuelle
 *    `timestamp:[* TO *]` confirme — si elle aussi renvoie 0, coupure
 *    automatique. Ne coûte rien tant que le flux est normal.
 */
import { r2Configured, r2CasUpdate } from '../lib/r2.mjs';
import { SYRACUSE_SYNC_KEY, emptySyracuseSyncState } from '../lib/syracuse-sync-state.mjs';

const KEY = SYRACUSE_SYNC_KEY;
const emptyState = emptySyracuseSyncState;

const SEARCH_URL = 'https://www.bm-douai.fr/Portal/Recherche/Search.svc/Search';
const HOLDINGS_URL = 'https://www.bm-douai.fr/Portal/Services/ILSClient.svc/GetHoldings';
const COMMON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'User-Agent': 'DouaiPatrimoine-InternalSync/1.0 (usage interne bibliotheque, cf. API-SYRACUSE.MD)',
  'Referer': 'https://www.bm-douai.fr/',
};

/* Cadence relevée le 2026-09-09 (voir CLAUDE.md, section « Synchronisation
   incrémentale Syracuse » — « Cadence relevée ») : un retard initial de
   plusieurs dizaines de milliers de notices, et des modifications groupées
   fréquentes côté équipe (corrections de pièges en masse), rendaient la
   cadence d'origine (10 notices / 5 min) beaucoup trop lente. Le levier de
   sécurité reste CALL_SPACING_MS — jamais touché — c'est lui qui fixe le
   débit RÉEL vers Syracuse (recherche du doc : « ~300 ms entre deux
   appels »). FLOOR_MS et MAX_HOLDINGS_PER_TICK ne changent que la durée et
   la fréquence des rafales, jamais leur intensité crête. */
const FLOOR_MS = 60 * 1000; // 1 min (était 5 min)
const LOCK_STALE_MS = 2 * 60 * 1000;
// Budget mesuré pour 40 GetHoldings : ~1,5 s (recherche) + 40×(~0,3-0,5 s
// d'appel + 300 ms d'attente) ≈ 33 s — sous les 45 s de `export const
// config` plus bas (voir ce bloc pour pourquoi ce n'est PAS FLOOR_MS : une
// tranche plus longue que le plancher entre deux tranches ferait tourner
// le job en continu, sans vrai repos entre deux rafales).
const MAX_HOLDINGS_PER_TICK = 40; // était 10
const RESULT_SIZE = 50; // liste blanche §11 : 50 = valeur max autorisée (était 25)
const CALL_SPACING_MS = 300; // ⚠️ ne pas réduire — c'est la seule protection réelle de Syracuse
const MAX_CONSECUTIVE_ERRORS = 3;
const SANITY_CHECK_QUIET_MS = 12 * 60 * 60 * 1000;

class SkipTick extends Error {
  constructor(reason, extra) {
    super(reason);
    this.skip = reason;
    this.extra = extra;
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function postJson(url, body) {
  const res = await fetch(url, { method: 'POST', headers: COMMON_HEADERS, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`Syracuse ${url} a répondu ${res.status}`);
  return res.json();
}

/* Reconstruit la requête à chaque appel plutôt que de réinjecter le
   `Query` normalisé renvoyé par le serveur (§4) : plus simple à faire
   traverser des invocations serverless successives, et acceptable ici —
   contrairement à une recherche utilisateur, la nôtre est un Solr
   canonique entièrement re-dérivable de (fenêtre, page). Le doc note que
   « reconstruire fonctionne aussi », au prix du QueryGuid perdu, sans
   conséquence pour un usage interne.

   Tri `timestamp` décroissant (`SortOrder:1`, absent de `d.Sorts` mais
   accepté — §19) : dans une fenêtre en retard de plusieurs jours (des
   dizaines de milliers de notices, voir le premier amorçage), un ordre non
   trié laisserait une modification toute récente n'importe où dans la
   file — potentiellement des milliers de tranches avant d'être atteinte.
   Trié par ordre décroissant, elle apparaît près du sommet dès la première
   tranche de CETTE fenêtre (`windowEnd` fixe, voir runSlice) : les
   réindexations en masse concurrentes peuvent en retarder quelques-unes
   (elles aussi timestampées « maintenant » sans changement réel de
   contenu — vérifié en conditions réelles le 2026-09-09 : plus de 100
   notices avaient un timestamp plus récent qu'une modification faite
   15 min plus tôt), mais jamais indéfiniment, contrairement à un ordre
   arbitraire sur 32 000 entrées. */
export async function search(queryString, { page = 0, resultSize = RESULT_SIZE } = {}) {
  return postJson(SEARCH_URL, {
    query: {
      QueryString: queryString,
      Page: page,
      PageRange: 3,
      ScenarioCode: 'DEFAULT',
      SearchLabel: '',
      InitialSearch: true,
      SearchContext: 0,
      ResultSize: resultSize,
      SortField: 'timestamp',
      SortOrder: 1,
    },
  });
}

export async function getHoldings(rscId) {
  return postJson(HOLDINGS_URL, { Record: { RscId: String(rscId), Docbase: 'SYRACUSE' } });
}

/* Point de départ du tout premier passage (voir runSlice) : le
   `generatedAt` du dernier rebuild de data/magasins.json, pas "maintenant"
   — pour que la fraîcheur apportée par l'API prenne le relais exactement
   là où le socle XML s'arrête, sans laisser un trou (voir CLAUDE.md,
   section « Synchronisation incrémentale Syracuse »). Lu dynamiquement sur
   le déploiement lui-même (fichier statique, servi par Vercel) plutôt que
   codé en dur, pour rester correct après un futur rebuild + {type:'reset'}
   sans avoir à retoucher ce fichier. `origin` vient des en-têtes de la
   requête entrante (host/proto) — pas de domaine supposé fixe. En cas
   d'échec (réseau, champ absent) : repli sur `now`, jamais d'erreur fatale
   pour un simple amorçage. */
async function resolveBootstrapLastSync(origin, nowIso) {
  try {
    const res = await fetch(`${origin}/data/magasins-build-report.json`);
    if (!res.ok) return nowIso;
    const report = await res.json();
    return (report && report.generatedAt) || nowIso;
  } catch {
    return nowIso;
  }
}

function recordEquals(a, b) {
  if (!a) return false;
  return (
    a.cote === b.cote &&
    a.titre === b.titre &&
    a.auteur === b.auteur &&
    a.dt === b.dt &&
    a.section === b.section &&
    a.site === b.site &&
    a.statut === b.statut &&
    a.rscId === b.rscId
  );
}

function noticeBarcodesEqual(existing, barcodes) {
  if (!existing || !Array.isArray(existing.barcodes)) return false;
  if (existing.barcodes.length !== barcodes.length) return false;
  const a = [...existing.barcodes].sort();
  const b = [...barcodes].sort();
  return a.every((v, i) => v === b[i]);
}

/* Prend la main sur le job, ou lève SkipTick sans jamais toucher R2 en
   écriture (le throw se produit avant que r2CasUpdate n'atteigne son
   r2Put — voir lib/r2.mjs). */
function claimSlot(state, now) {
  if (state.enabled === false) throw new SkipTick('disabled');
  const lastAttempt = state.lastSyncAttempt ? Date.parse(state.lastSyncAttempt) : 0;
  const age = now - lastAttempt;
  if (state.syncInProgress && age < LOCK_STALE_MS) {
    throw new SkipTick('in-progress');
  }
  const lockIsStale = state.syncInProgress && age >= LOCK_STALE_MS;
  if (!lockIsStale && age < FLOOR_MS) {
    throw new SkipTick('too-soon', { nextEligibleAt: new Date(lastAttempt + FLOOR_MS).toISOString() });
  }
  return { ...state, lastSyncAttempt: new Date(now).toISOString(), syncInProgress: true };
}

/* Coupe-circuit §19 : ne coûte un appel Syracuse supplémentaire que si le
   flux est silencieux depuis anormalement longtemps (la baseline mesurée
   est de ~200 à 800 notices/jour sur tout le catalogue). */
async function checkTimestampFieldAlive() {
  await sleep(CALL_SPACING_MS);
  const sanity = await search('timestamp:[* TO *]', { page: 0, resultSize: 5 });
  const nb = sanity.success && sanity.d && sanity.d.SearchInfo ? sanity.d.SearchInfo.NBResults : null;
  if (nb === 0) {
    throw new Error(
      'Le champ Solr "timestamp" ne renvoie plus aucun document — probable retrait côté Syracuse. Synchronisation coupée automatiquement.'
    );
  }
}

/* Une tranche : au plus MAX_HOLDINGS_PER_TICK notices, en série. La
   fenêtre [lastSync, windowEnd] reste fixe tant qu'il reste des pages à
   traiter (cursor porte windowEnd/page/offsetInPage) — lastSync n'avance
   que quand la fenêtre entière est épuisée, pour ne jamais sauter ni
   retraiter indéfiniment une notice sur un pic de réindexation en masse
   (+16 222 notices en une journée, mesuré §19).

   Limite connue : chaque tranche reconstruit la requête plutôt que de
   réinjecter le `Query` normalisé du serveur (§4), donc rien ne garantit
   qu'une page déjà partiellement consommée renvoie EXACTEMENT le même
   ordre de résultats à la tranche suivante si l'index a bougé entre-temps
   — une notice pourrait en théorie glisser sous un offset déjà traité et
   être manquée pour ce passage. Risque étroit en pratique (1-2 tranches
   par page avec MAX_HOLDINGS_PER_TICK=40/RESULT_SIZE=50) et auto-cicatrisant
   (rattrapé à la prochaine modification de cette notice, ou par le rebuild
   mensuel complet — voir CLAUDE.md). Pas corrigé
   pour ne pas complexifier une phase pensée pour être observée avant
   d'être affichée. */
async function runSlice(state, origin) {
  const nowIso = new Date().toISOString();
  const cursor = state.cursor;

  /* Tout premier passage (lastSync jamais posé) : on amorce sur la date du
     dernier rebuild XML (`data/magasins-build-report.json`), pas sur
     "maintenant" — pour couvrir sans trou tout ce qui a changé depuis le
     dernier export bib.xml. Choix explicite de l'utilisateur (2026-09-09) :
     l'écart peut représenter plusieurs dizaines de milliers de notices
     (§19-20 : ~32 000 sur une semaine de retard), donc plusieurs jours à
     réel régime de tick avant résorption complète du retard — accepté,
     puisque le débit par tranche reste identique quel que soit le volume
     restant (le plancher de 5 min protège Syracuse dans tous les cas, seul
     le temps total de rattrapage varie). Aucun appel Syracuse à ce stade,
     juste la lecture (via HTTP, sur notre propre déploiement) de ce
     fichier statique. */
  if (!state.lastSync && !cursor) {
    const bootstrapFrom = await resolveBootstrapLastSync(origin, nowIso);
    return { recordsPatch: {}, noticesPatch: {}, newLastSync: bootstrapFrom, newCursor: null, processed: 0, remaining: 0 };
  }

  const windowEnd = cursor ? cursor.windowEnd : nowIso;
  const lastSync = state.lastSync;
  const page = cursor ? cursor.page : 0;
  const offsetInPage = cursor ? cursor.offsetInPage : 0;

  if (!cursor && state.lastSync) {
    const quietFor = Date.now() - Date.parse(state.lastSync);
    if (quietFor >= SANITY_CHECK_QUIET_MS) {
      await checkTimestampFieldAlive();
    }
  }

  const queryString = `timestamp:[${lastSync} TO ${windowEnd}]`;
  await sleep(CALL_SPACING_MS);
  const searchResult = await search(queryString, { page, resultSize: RESULT_SIZE });
  if (!searchResult.success) {
    throw new Error(`Search Syracuse a échoué : ${(searchResult && searchResult.message) || 'raison inconnue'}`);
  }
  const d = searchResult.d;
  // Bruit d'index (§18) : au moins un RscId non bibliographique (ex. "VDOUC") a été observé.
  const results = (d.Results || []).filter(r => r.Resource && r.Resource.RscBase === 'SYRACUSE');
  const nbResults = (d.SearchInfo && d.SearchInfo.NBResults) || 0;

  const recordsPatch = {};
  const noticesPatch = {};
  const toProcess = results.slice(offsetInPage, offsetInPage + MAX_HOLDINGS_PER_TICK);
  let processed = 0;

  for (const r of toProcess) {
    const resource = r.Resource;
    const rscId = String(resource.RscId);
    await sleep(CALL_SPACING_MS);
    const holdingsResult = await getHoldings(rscId);
    if (!holdingsResult.success) {
      processed++;
      continue; // notice sans exemplaire exploitable via GetHoldings — pas fatal pour la tranche
    }
    const holdings = (holdingsResult.d && holdingsResult.d.Holdings) || [];
    const entryTs = new Date().toISOString();
    const barcodes = [];
    for (const h of holdings) {
      if (!h.Barcode) continue;
      barcodes.push(h.Barcode);
      // titre/auteur/dt ne sont PAS dans GetHoldings (§16) : ils viennent
      // de la réponse Search déjà en main (§3), pas d'appel supplémentaire.
      const candidate = {
        cote: h.Cote || null,
        titre: resource.Ttl || null,
        auteur: resource.Crtr || null,
        dt: resource.Dt || null,
        section: h.Section || null,
        site: h.Site || null,
        statut: h.Statut || null,
        rscId,
        ts: entryTs,
      };
      if (!recordEquals(state.records[h.Barcode], candidate)) {
        recordsPatch[h.Barcode] = candidate;
      }
    }
    if (!noticeBarcodesEqual(state.notices[rscId], barcodes)) {
      noticesPatch[rscId] = { barcodes, ts: entryTs };
    }
    processed++;
  }

  const pageExhausted = offsetInPage + toProcess.length >= results.length;
  const isLastPage = (page + 1) * RESULT_SIZE >= nbResults;

  let newCursor;
  let newLastSync = state.lastSync;
  if (!pageExhausted) {
    newCursor = { windowEnd, page, offsetInPage: offsetInPage + toProcess.length };
  } else if (!isLastPage) {
    newCursor = { windowEnd, page: page + 1, offsetInPage: 0 };
  } else {
    newCursor = null;
    newLastSync = windowEnd;
  }

  const remaining = Math.max(0, nbResults - (page * RESULT_SIZE + offsetInPage + toProcess.length));
  return { recordsPatch, noticesPatch, newLastSync, newCursor, processed, remaining };
}

function commitSlice(state, outcome) {
  return {
    ...state,
    records: { ...state.records, ...outcome.recordsPatch },
    notices: { ...state.notices, ...outcome.noticesPatch },
    lastSync: outcome.newLastSync,
    cursor: outcome.newCursor,
    syncInProgress: false,
    consecutiveErrors: 0,
    lastError: null,
  };
}

function commitFailure(state, err) {
  const consecutiveErrors = (state.consecutiveErrors || 0) + 1;
  const next = {
    ...state,
    syncInProgress: false,
    consecutiveErrors,
    lastError: `${new Date().toISOString()} — ${err.message || String(err)}`,
  };
  if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
    next.enabled = false;
  }
  return next;
}

/* Durée max explicite (convention Vercel Serverless Functions), pour que
   la fonction dispose des ~33 s que prend une tranche de
   MAX_HOLDINGS_PER_TICK=40 — sans ce `config`, une fonction reste sur la
   limite par défaut du projet (peut être bien plus basse que ce que le
   plan autorise, voir CLAUDE.md « Cadence relevée »).
   ⚠️ La valeur DOIT être un littéral écrit ici, PAS une référence vers une
   constante (`MAX_DURATION_S` par ex.) : l'analyse statique de Vercel qui
   lit ce `config` ne fait qu'un parcours d'AST léger, sans exécuter le
   module — elle sait lire un nombre en dur, pas résoudre un identifiant.
   Une référence a fait échouer le déploiement du 2026-09-09 avec `Error:
   Unhandled type: "Identifier"` (aucun rapport avec la limite du plan —
   diagnostiqué à tort au départ, corrigé une fois le vrai message d'erreur
   obtenu). Vérifié depuis auprès de la documentation Vercel : le plan
   Hobby de ce compte autorise, avec Fluid Compute (actif par défaut),
   jusqu'à 300 s — 45 s est donc large, choisi pour rester sous FLOOR_MS
   (1 min) et garder un vrai repos entre deux tranches plutôt que pousser
   la fonction jusqu'au plafond du plan. */
export const config = { maxDuration: 45 };

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    res.status(405).json({ error: 'Méthode non supportée.' });
    return;
  }
  if (!r2Configured()) {
    res.status(503).json({ error: 'R2 non configuré côté serveur (variables R2_* manquantes sur Vercel).' });
    return;
  }
  res.setHeader('Cache-Control', 'no-store');

  // Pour resolveBootstrapLastSync() : notre propre origine, dérivée des
  // en-têtes de la requête (Vercel les pose systématiquement) plutôt que
  // d'un domaine supposé fixe — fonctionne aussi bien en preview qu'en prod.
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const origin = `${proto}://${host}`;

  const now = Date.now();
  let claimed;
  try {
    claimed = await r2CasUpdate(KEY, state => claimSlot(state, now), emptyState);
  } catch (err) {
    if (err instanceof SkipTick) {
      res.status(200).json({ skipped: err.skip, ...(err.extra || {}) });
      return;
    }
    res.status(500).json({ error: err.message || 'Erreur serveur.' });
    return;
  }

  try {
    const outcome = await runSlice(claimed, origin);
    await r2CasUpdate(KEY, state => commitSlice(state, outcome), emptyState);
    res.status(200).json({ ok: true, processed: outcome.processed, remaining: outcome.remaining });
  } catch (err) {
    await r2CasUpdate(KEY, state => commitFailure(state, err), emptyState).catch(() => {});
    res.status(502).json({ error: err.message || 'Échec de la synchronisation Syracuse.' });
  }
}
