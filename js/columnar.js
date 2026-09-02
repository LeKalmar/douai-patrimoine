/* ════════════════════════════════════════════════════════════════════════
   CONTENEUR COLONNAIRE POUR LES GROS JEUX DE DONNÉES

   data/magasins.json était un tableau de 199 583 objets plats, soit ~85 Mo.
   L'essentiel de ce poids n'était pas de la donnée :

   - les 15 noms de champs ("930$g", "_coteDigitRun"…) répétés 199 583 fois ;
   - `lien_num`, une URL R2 complète par exemplaire — 14,4 Mo, alors qu'elle
     vaut toujours <préfixe>/vignette/<code-barre>.jpg, donc entièrement
     dérivable ;
   - `210$d`, vide sur la totalité des lignes de l'export courant ;
   - `_bibliotheque` (2 valeurs distinctes), `_isMagasin` (2), `_secteur`
     (66), `_fondsLabel` (67), `_piege` (272), stockés en chaînes pleines.

   Ce module range les mêmes lignes en colonnes, chacune encodée selon sa
   nature (constante, dictionnaire, gabarit dérivé, ou brute). Le résultat
   reste du JSON ordinaire, sans dépendance ni format binaire.

   ─── AUCUNE PERTE ───
   decode() reconstruit des lignes strictement identiques aux lignes
   d'origine — mêmes clés, mêmes valeurs, mêmes null. C'est un changement de
   rangement, pas de contenu ; scripts/verify-columnar.mjs le vérifie ligne
   à ligne sur le jeu réel.

   Les lignes n'ont pas toutes les mêmes clés : data/desherbage.json est un
   export MARC où chaque notice porte les seuls champs qu'elle renseigne (56
   clés sur une ligne, 91 sur l'union). Une colonne distingue donc « valeur
   null » de « clé absente » — un dictionnaire marque l'absence par l'indice
   -1, une colonne brute par la liste `miss` des lignes concernées — et
   readRow n'écrit tout simplement pas la clé dans ce cas. Sans cela, une
   ligne ressortirait avec 35 clés à null qu'elle n'avait jamais eues.

   ─── PARTAGE NODE / NAVIGATEUR ───
   Ce fichier est un script classique qui pose `window.columnar` : les pages
   le chargent par <script src>. Les scripts de build, eux, l'évaluent avec
   `loadColumnar()` (scripts/lib/load-columnar.mjs) plutôt que d'en tenir une
   seconde copie en ESM — le format d'encodage et celui de décodage ne
   doivent jamais pouvoir diverger.
   ════════════════════════════════════════════════════════════════════════ */
(function (global) {
  'use strict';

  const FORMAT = 'columns/1';

  /* Un tableau colonnaire est-il ce conteneur, ou l'ancien tableau plat ?
     Permet aux pages d'accepter les deux pendant une transition, et de ne
     jamais casser sur un data/magasins.json plus ancien. */
  function isColumnar(data) {
    return !!data && !Array.isArray(data) && data.format === FORMAT;
  }

  function rowCount(data) {
    return isColumnar(data) ? data.n : (data ? data.length : 0);
  }

  /* opts.templates : [{ col, from, prefix, suffix }] — colonnes dont chaque
     valeur se déduit d'une autre colonne. Le gabarit n'est retenu que s'il
     est vérifié sur TOUTES les lignes ; sinon la colonne retombe en brut,
     donc une donnée inattendue ne peut jamais être silencieusement perdue. */
  /* Clé d'internement d'une valeur. Les primitives sont leur propre clé ;
     les objets/tableaux (ex. `prets: {an, an1, …}` dans data/desherbage.json)
     seraient sinon comparés par référence, donc jamais reconnus comme
     identiques alors qu'ils le sont en valeur — et la plupart des lignes
     partagent le même objet tout-à-zéro. On les interne donc sur leur forme
     JSON. Le préfixe \u0000 évite qu'une vraie chaîne entre en collision
     avec la sérialisation d'un objet. */
  function dictKey(v) {
    return (v !== null && typeof v === 'object') ? '\u0000' + JSON.stringify(v) : v;
  }

  // Copie défensive d'une valeur non primitive : une entrée de dictionnaire
  // est partagée par toutes les lignes qui la portent, alors qu'avant ce
  // format chaque ligne recevait son propre objet de JSON.parse. Sans copie,
  // une page qui modifierait row.prets contaminerait toutes les autres lignes.
  function cloneValue(v) {
    if (v === null || typeof v !== 'object') return v;
    if (Array.isArray(v)) return v.map(cloneValue);
    const o = {};
    for (const k in v) o[k] = cloneValue(v[k]);
    return o;
  }

  function encode(rows, opts) {
    const options = opts || {};
    const n = rows.length;
    const keys = [];
    const seen = new Set();
    for (let i = 0; i < n; i++) {
      for (const k in rows[i]) if (!seen.has(k)) { seen.add(k); keys.push(k); }
    }

    const templates = {};
    (options.templates || []).forEach(t => { templates[t.col] = t; });

    const columns = {};
    for (const key of keys) {
      const tpl = templates[key];
      if (tpl && n > 0) {
        const pre = tpl.prefix || '', suf = tpl.suffix || '';
        let holds = true;
        for (let i = 0; i < n; i++) {
          const src = rows[i][tpl.from];
          if (rows[i][key] !== pre + (src == null ? '' : src) + suf) { holds = false; break; }
        }
        if (holds) { columns[key] = { t: 't', from: tpl.from, prefix: pre, suffix: suf }; continue; }
      }

      // `o` : la colonne contient des valeurs non primitives, donc readRow
      // devra en rendre une copie (voir cloneValue).
      let hasObjects = false, anyMissing = false;
      for (let i = 0; i < n; i++) {
        if (!(key in rows[i])) { anyMissing = true; continue; }
        const v = rows[i][key];
        if (v !== null && typeof v === 'object') hasObjects = true;
      }

      // Constante : une seule valeur distincte, et présente sur chaque ligne.
      if (!anyMissing) {
        const firstKey = rows[0] ? dictKey(rows[0][key]) : undefined;
        let allSame = true;
        for (let i = 1; i < n; i++) { if (dictKey(rows[i][key]) !== firstKey) { allSame = false; break; } }
        if (allSame) {
          columns[key] = { t: 'c', v: rows[0] ? rows[0][key] : null };
          if (hasObjects) columns[key].o = 1;
          continue;
        }
      }

      // Dictionnaire quand la cardinalité est faible devant le nombre de
      // lignes : on ne stocke alors qu'un entier par ligne.
      const limit = Math.max(64, Math.floor(n / 50));
      const values = [], index = new Map(), idx = new Array(n);
      let dictOk = true;
      for (let i = 0; i < n; i++) {
        // -1 : clé absente de cette ligne (distinct d'une valeur null).
        if (!(key in rows[i])) { idx[i] = -1; continue; }
        const v = rows[i][key];
        const dk = dictKey(v);
        let at = index.get(dk);
        if (at === undefined) {
          if (values.length >= limit) { dictOk = false; break; }
          at = values.length; values.push(v); index.set(dk, at);
        }
        idx[i] = at;
      }
      if (dictOk) {
        columns[key] = { t: 'd', v: values, i: idx };
        if (hasObjects) columns[key].o = 1;
        continue;
      }

      const plain = new Array(n);
      const miss = [];
      for (let i = 0; i < n; i++) {
        if (!(key in rows[i])) { plain[i] = null; miss.push(i); continue; }
        plain[i] = rows[i][key];
      }
      columns[key] = { t: 'p', v: plain };
      if (miss.length) columns[key].miss = miss;
      if (hasObjects) columns[key].o = 1;
    }

    return { format: FORMAT, n, keys, columns };
  }

  // Valeur d'une colonne pour la ligne i. `row` sert aux colonnes dérivées,
  // dont la source est déjà reconstruite (les gabarits sont résolus après
  // les colonnes ordinaires, voir readRow).
  // Marqueur interne « cette ligne n'a pas cette clé » — readRow n'écrit
  // alors pas la propriété, au lieu de la poser à null.
  const ABSENT = {};

  function cellAt(col, i, row) {
    switch (col.t) {
      case 'c': return col.o ? cloneValue(col.v) : col.v;
      case 'd': {
        const at = col.i[i];
        if (at === -1) return ABSENT;
        const v = col.v[at];
        return col.o ? cloneValue(v) : v;
      }
      case 'p': {
        if (col.missSet && col.missSet.has(i)) return ABSENT;
        const v = col.v[i];
        return col.o ? cloneValue(v) : v;
      }
      case 't': { const s = row[col.from]; return col.prefix + (s == null ? '' : s) + col.suffix; }
      default: return null;
    }
  }

  // `miss` est sérialisé en tableau ; on le convertit une fois en Set pour
  // que la lecture reste en O(1) par cellule.
  function prepare(data) {
    if (data.__prepared) return;
    for (const k of data.keys) {
      const col = data.columns[k];
      if (col.miss && !col.missSet) col.missSet = new Set(col.miss);
    }
    data.__prepared = true;
  }

  function readRow(data, i) {
    prepare(data);
    const row = {};
    const derived = [];
    for (const k of data.keys) {
      const col = data.columns[k];
      if (col.t === 't') { derived.push(k); continue; }
      const v = cellAt(col, i, row);
      if (v !== ABSENT) row[k] = v;
    }
    for (const k of derived) row[k] = cellAt(data.columns[k], i, row);
    return row;
  }

  /* Parcourt les lignes sans jamais matérialiser le tableau complet : c'est
     la voie à privilégier côté page, où les lignes sont de toute façon
     transformées à la volée (catalogue, index de recherche, tableau
     affiché). Évite de garder en mémoire ~112 Mo d'objets intermédiaires.
     Accepte aussi l'ancien tableau plat, pour que les pages n'aient qu'un
     seul chemin de code. */
  function forEachRow(data, cb) {
    if (!isColumnar(data)) { (data || []).forEach(cb); return; }
    for (let i = 0; i < data.n; i++) cb(readRow(data, i), i);
  }

  function decode(data) {
    if (!isColumnar(data)) return data || [];
    const out = new Array(data.n);
    for (let i = 0; i < data.n; i++) out[i] = readRow(data, i);
    return out;
  }

  global.columnar = { FORMAT, isColumnar, rowCount, encode, decode, readRow, forEachRow };
})(typeof window !== 'undefined' ? window : globalThis);
