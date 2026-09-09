/* ════════════════════════════════════════════════════════════════════════
   CACHE INDEXEDDB DES CATALOGUES DE RÉFÉRENCE (lecture seule)

   Problème résolu : data/magasins.json pèse ~85 Mo bruts (199 583
   exemplaires depuis le passage à bib.xml, voir CLAUDE.md « Magasins
   2e/5e/6e étage »). Chaque ouverture de recolement.html le retéléchargeait
   (~6,9 Mo brotli), le décompressait, le passait à JSON.parse (0,4 s sur un
   poste rapide, 2 à 4 s sur un poste de banque d'accueil) et matérialisait
   un tableau de 199 583 objets — ~112 Mo de tas, uniquement pour en
   extraire 8 champs par exemplaire.

   Ce module met en cache le CATALOGUE DÉJÀ CONSTRUIT (pas le JSON brut),
   sous forme colonnaire, dans IndexedDB. Au deuxième chargement : aucun
   téléchargement, aucun JSON.parse, aucun tableau intermédiaire.

   ─── SÉCURITÉ DES DONNÉES DE RÉCOLEMENT ───
   Ce cache vit dans une base IndexedDB SÉPARÉE (`rp_catalog_cache`), sans
   aucun rapport avec `rp_recolement_idb` (stores `scans`/`baseline`, qui
   contiennent le récolement lui-même). Aucune fonction de ce fichier
   n'ouvre, ne lit ni n'écrit la base du récolement. Le cache est par
   ailleurs purement dérivé : il ne contient que des données reconstruites à
   partir de data/magasins.json, donc le vider ou le perdre ne fait au pire
   que provoquer un rechargement réseau.

   ─── DÉGRADATION ───
   Toutes les opérations sont « best-effort » : aucune ne rejette jamais.
   En cas d'indisponibilité d'IndexedDB (mode privé strict, quota dépassé,
   vieux navigateur), read() renvoie null et write() renvoie false —
   l'appelant retombe alors exactement sur le comportement d'avant ce cache
   (fetch + build), sans que rien ne casse.
   ════════════════════════════════════════════════════════════════════════ */
(function (global) {
  'use strict';

  const DB_NAME = 'rp_catalog_cache';
  const DB_VERSION = 1;
  const STORE = 'catalogues';
  // Même filet de sécurité que openIdb() dans recolement.html : si un autre
  // onglet bloque un upgrade, onsuccess/onerror ne se déclenchent jamais et
  // l'appel resterait pendant indéfiniment.
  const OPEN_TIMEOUT_MS = 5000;

  // Version du FORMAT colonnaire ci-dessous (distincte de la version des
  // DONNÉES, qui est le generatedAt du build-report). Incrémenter en cas de
  // changement de forme du payload : les entrées cachées à l'ancien format
  // sont alors ignorées puis réécrites, sans intervention.
  const FMT = 1;

  function openDb() {
    return new Promise((resolve, reject) => {
      if (!global.indexedDB) { reject(new Error('IndexedDB indisponible')); return; }
      let settled = false;
      const timeout = setTimeout(() => {
        if (!settled) { settled = true; reject(new Error('IndexedDB open timeout (onblocked ?)')); }
      }, OPEN_TIMEOUT_MS);
      let req;
      try { req = global.indexedDB.open(DB_NAME, DB_VERSION); }
      catch (e) { clearTimeout(timeout); reject(e); return; }
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'name' });
      };
      req.onsuccess = () => { if (!settled) { settled = true; clearTimeout(timeout); resolve(req.result); } };
      req.onerror = () => { if (!settled) { settled = true; clearTimeout(timeout); reject(req.error || new Error('open failed')); } };
      req.onblocked = () => { /* le timeout ci-dessus tranchera */ };
    });
  }

  /* Lit l'entrée `name` si elle existe ET si sa version de données
     correspond à `version` (le generatedAt du build-report côté appelant).
     Renvoie le payload colonnaire, ou null pour tout autre cas — entrée
     absente, périmée, format obsolète, IndexedDB indisponible. Une entrée
     périmée est supprimée au passage pour ne pas occuper le quota. */
  async function read(name, version) {
    let db = null;
    try {
      db = await openDb();
      const rec = await new Promise((resolve, reject) => {
        const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(name);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => reject(req.error);
      });
      if (!rec) return null;
      if (rec.fmt !== FMT || !rec.version || rec.version !== version) {
        // Périmée : on la retire (sans attendre) et on signale un miss.
        clear(name);
        return null;
      }
      return rec.payload || null;
    } catch (e) {
      console.warn('[catalog-cache] lecture impossible, repli sur le réseau :', e && e.message);
      return null;
    } finally {
      if (db) try { db.close(); } catch (e) { /* rien à faire */ }
    }
  }

  /* Écrit (ou remplace) l'entrée `name`. Renvoie true si l'écriture a
     abouti. Un échec (quota dépassé notamment, le payload magasins pèse
     ~25 Mo) est journalisé mais sans conséquence : la page continue de
     fonctionner, elle rechargera simplement depuis le réseau la prochaine
     fois. */
  async function write(name, version, payload) {
    let db = null;
    try {
      db = await openDb();
      await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).put({ name, version, fmt: FMT, savedAt: Date.now(), payload });
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error || new Error('transaction abandonnée'));
      });
      return true;
    } catch (e) {
      console.warn('[catalog-cache] écriture impossible (quota ?), cache non persisté :', e && e.message);
      return false;
    } finally {
      if (db) try { db.close(); } catch (e) { /* rien à faire */ }
    }
  }

  async function clear(name) {
    let db = null;
    try {
      db = await openDb();
      await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).delete(name);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
      return true;
    } catch (e) {
      return false;
    } finally {
      if (db) try { db.close(); } catch (e) { /* rien à faire */ }
    }
  }

  /* ════════ ENCODAGE COLONNAIRE ════════
     Un catalogue est un objet { [barcode]: entry }. Le stocker tel quel
     ferait cloner 199 583 objets JS par la structured-clone d'IndexedDB
     (lent, et volumineux à cause de l'overhead par objet). On le range donc
     en colonnes parallèles :

     - les champs à forte cardinalité (cote, titre, auteur, digit) en
       tableaux de chaînes — c'est la vraie donnée, incompressible ;
     - les champs à faible cardinalité (fonds : 67 valeurs distinctes,
       piege : 272, etat : 1) en dictionnaire + tableau d'indices ;
     - les booléens (manuel, isMagasin) en bits d'un Uint8Array ;
     - `noticeId` omis quand il vaut partout le code-barre (cas des magasins
       et des exemplaires d'exemplarisation.html, voir buildCatalogFromItems
       dans recolement.html) ;
     - `relies` (reliures $481/$482) stocké en objet creux : seules les
       entrées non vides, soit 703 sur 15 518 côté réserve, aucune côté
       magasins.

     Les tableaux typés et les tableaux de chaînes sont clonés bien plus
     efficacement que des objets, et le tas reste proportionnel à la donnée
     réelle et non au nombre de propriétés. */

  const FLAG_MANUEL = 1;
  const FLAG_IS_MAGASIN = 2;

  function encode(catalog) {
    const bcs = Object.keys(catalog);
    const n = bcs.length;
    const cote = new Array(n), titre = new Array(n), auteur = new Array(n), digit = new Array(n);
    const flags = new Uint8Array(n);
    const fondsVals = [], fondsMap = new Map(), fondsIdx = new Int32Array(n);
    const piegeVals = [], piegeMap = new Map(), piegeIdx = new Int32Array(n);
    const etatVals = [], etatMap = new Map(), etatIdx = new Int32Array(n);
    const relies = {};
    const noticeId = new Array(n);
    let noticeIdAllSameAsBarcode = true;

    const intern = (vals, map, v) => {
      let i = map.get(v);
      if (i === undefined) { i = vals.length; vals.push(v); map.set(v, i); }
      return i;
    };

    for (let i = 0; i < n; i++) {
      const bc = bcs[i];
      const e = catalog[bc];
      cote[i] = e.cote || '';
      titre[i] = e.titre || '';
      auteur[i] = e.auteur || '';
      digit[i] = e.coteDigitRun || '';
      fondsIdx[i] = intern(fondsVals, fondsMap, e.fonds || '');
      piegeIdx[i] = intern(piegeVals, piegeMap, e.piege || '');
      etatIdx[i] = intern(etatVals, etatMap, e.etat || '');
      let f = 0;
      if (e.manuel) f |= FLAG_MANUEL;
      // isMagasin absent (catalogue réserve) ⇒ dans le périmètre, comme
      // inGroupScope() côté recolement.html.
      if (e.isMagasin !== false) f |= FLAG_IS_MAGASIN;
      flags[i] = f;
      if (e.relies && e.relies.length) relies[bc] = e.relies.slice();
      noticeId[i] = e.noticeId || bc;
      if (noticeId[i] !== bc) noticeIdAllSameAsBarcode = false;
    }

    return {
      n, bc: bcs, cote, titre, auteur, digit, flags,
      fondsVals, fondsIdx, piegeVals, piegeIdx, etatVals, etatIdx,
      noticeId: noticeIdAllSameAsBarcode ? null : noticeId,
      relies,
    };
  }

  /* Reconstruit { [barcode]: entry } à l'identique de ce qu'a produit
     buildCatalogFromItems() — mêmes clés, mêmes types, y compris le
     `relies: []` et le `coteDigitRun: null` des entrées qui n'en ont pas. */
  function decode(payload) {
    const { n, bc, cote, titre, auteur, digit, flags,
            fondsVals, fondsIdx, piegeVals, piegeIdx, etatVals, etatIdx,
            noticeId, relies } = payload;
    const catalog = {};
    for (let i = 0; i < n; i++) {
      const b = bc[i];
      const f = flags[i];
      catalog[b] = {
        cote: cote[i],
        titre: titre[i],
        auteur: auteur[i],
        fonds: fondsVals[fondsIdx[i]],
        etat: etatVals[etatIdx[i]],
        noticeId: noticeId ? noticeId[i] : b,
        manuel: (f & FLAG_MANUEL) !== 0,
        // Un tableau neuf par entrée, jamais une instance vide partagée :
        // buildCatalogFromItems() fait de même, et applyManualReliureGroups()
        // (js/reliures-manuelles-shared.js) réaffecte aujourd'hui `relies`
        // plutôt que de le muter — mais partager une instance rendrait une
        // future mutation en place silencieusement globale.
        relies: relies[b] ? relies[b].slice() : [],
        piege: piegeVals[piegeIdx[i]],
        coteDigitRun: digit[i] || null,
        isMagasin: (f & FLAG_IS_MAGASIN) !== 0,
      };
    }
    return catalog;
  }

  global.catalogCache = { read, write, clear, encode, decode, FMT, DB_NAME };
})(typeof window !== 'undefined' ? window : globalThis);
