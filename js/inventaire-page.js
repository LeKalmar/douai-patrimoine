/* ══════════════════════════════════════════════════════════════════════════
   INVENTAIRE — page dédiée (planche 3a de « Révision design », 2026-09-08)

   Rendu de inventaire.html : rangée de cartes de fonds, colonne de facettes à
   gauche, liste de notices à vignette, pagination.

   Ce fichier est chargé APRÈS js/inventaire.js, qu'il utilise comme
   bibliothèque plutôt que d'en recopier la moitié. js/inventaire.js est inerte
   tant qu'on n'appelle pas startInventaire() : à l'analyse il ne fait que
   déclarer ses constantes et ses fonctions. On lui reprend donc, tels quels :

     getFondsFromCote()      le fonds déduit du préfixe de cote (930$g)
     FONDS_IMAGES            la vignette illustrant chaque fonds
     dateMatchesFilter()     le filtre de période, qui sait lire « [17xx] »
     parsePublicationDate()  et « [154x] » aussi bien qu'une année pleine
     formatPublicationDate() « [18xx] » affiché « XIXe siècle »
     buildThumbFrame()       le cadre de vignette, avec repli si l'image manque
     buildExpandedContent()  le panneau de détail complet (métadonnées, pills,
                             bouton visionneuse) — c'est le gros morceau réutilisé
     esc() / debounce() / compareCotes()

   Tout est enveloppé dans une IIFE : js/inventaire.js déclare allRecords,
   filteredRecords, init()… au niveau global, et deux `let` de même nom dans la
   portée lexicale globale d'un script classique, c'est une SyntaxError qui
   casserait les deux fichiers d'un coup.
   ══════════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  var PAGE_SIZE = 10;

  /* Nombre de valeurs listées par facette. Au-delà, la traîne est faite de
     variantes d'orthographe à un ou deux exemplaires (« Parisiis », « A
     Paris »…) qui allongent la colonne sans aider à trier. */
  var FACET_MAX = 12;

  /* Les fonds mis en avant en tête de page, dans cet ordre. Un fonds absent de
     l'export courant est simplement sauté — la rangée n'est pas figée à 5. */
  var FONDS_VEDETTE = [
    'Imprimés', 'Manuscrits', 'Douaisien', "Livres d'Artiste",
    'Littérature', 'Mines', 'Réserve Douaisienne', 'Protestantisme', 'Robaut'
  ];

  /* Repli d'illustration pour les fonds que FONDS_IMAGES (js/inventaire.js) ne
     couvre pas : il n'existe pas de photo dédiée pour « Imprimés ». */
  var FONDS_IMAGES_EXTRA = {
    'Imprimés': 'images/documents.jpg',
    'Réserve Douaisienne': 'images/hospice.jpg'
  };

  // ── État ────────────────────────────────────────────────────────────────
  var records = [];
  var filtered = [];
  var page = 1;
  var sortKey = 'cote';
  var openDetailId = null;

  /* Facettes actives : un Set de valeurs par axe. Plusieurs valeurs sur le même
     axe se lisent en OU (« Douaisien OU Imprimés »), deux axes différents en ET
     — la convention habituelle d'une recherche à facettes. */
  var active = { fonds: new Set(), type: new Set(), lieu: new Set(), numerise: new Set() };
  var query = '';
  var dateStart = null;
  var dateEnd = null;

  // ── Normalisation des valeurs de facette ────────────────────────────────

  /* 200$b arrive en vrac de Syracuse : casse flottante, crochets, accents
     cassés à l'export (« imprim<U+FFFD>e »), coquilles (« texte tmprimé »).
     Sans regroupement, la facette afficherait sept fois « texte imprimé ». */
  var TYPE_CANON = [
    [/^(?:texte|titre)\b.*m?prim/, 'Texte imprimé'],
    [/^musique\b.*m?prim/, 'Musique imprimée'],
    [/^texte\s+manuscrit/, 'Manuscrit'],
    [/^document\s+cartograph/, 'Document cartographique'],
    [/^enregistrement\s+sonore/, 'Enregistrement sonore'],
    [/^image\s+fixe/, 'Image fixe'],
    [/^multim/, 'Multimédia multisupport'],
    [/^liv$/, "Livre d'artiste"]
  ];

  function normType(raw) {
    var s = String(raw || '').trim();
    if (!s) return '';
    s = s.replace(/^\[|\]$/g, '').trim();
    s = s.replace(/�/g, '');           // caractère de remplacement de l'export
    s = s.replace(/\s+/g, ' ');
    var key = s.toLowerCase();
    for (var i = 0; i < TYPE_CANON.length; i++) {
      if (TYPE_CANON[i][0].test(key)) return TYPE_CANON[i][1];
    }
    return s.charAt(0).toUpperCase() + s.slice(1);
  }

  /* 210$a : « Paris », « [Paris] » et « A Paris » sont le même lieu. En
     revanche « Parisiis » (forme latine du titre) est laissé distinct : c'est
     une information sur l'édition, pas une variante de saisie. */
  function normLieu(raw) {
    var s = String(raw || '').trim();
    if (!s) return '';
    s = s.replace(/^\[|\]$/g, '').trim();
    s = s.replace(/\s*\([^)]*\)\s*$/, '');   // « Bouvignies (Nord) » → « Bouvignies »
    s = s.replace(/^[àa]\s+/i, '');          // « A Paris » → « Paris »
    s = s.replace(/[.,;:]+$/, '').trim();
    s = s.replace(/\s+/g, ' ');
    if (/^s\.?\s*l\.?$/i.test(s)) return 'Sans lieu';
    return s.charAt(0).toUpperCase() + s.slice(1);
  }

  function yearOf(rec) {
    var p = parsePublicationDate(rec['210$d']);
    return p ? p.start : null;
  }

  function fondsImage(name) {
    return (typeof FONDS_IMAGES !== 'undefined' && FONDS_IMAGES[name])
      || FONDS_IMAGES_EXTRA[name]
      || 'images/documents.jpg';
  }

  // ── État persisté (retour depuis la visionneuse) ───────────────────────
  /* « Accéder au document numérisé » (js/inventaire.js) navigue en direct
     vers visionneuse.html (window.location.href, pas un onglet/une modale —
     voir CLAUDE.md « Document numérisé »), et son bouton « Retour à
     l'inventaire » revient ici par une navigation tout aussi classique :
     rien ne garantit que le navigateur restaure la page depuis le
     back-forward cache plutôt que de relancer ce script à zéro. On
     sauvegarde donc recherche/filtres/tri/page/notice dépliée/défilement
     dans le sessionStorage (borné à l'onglet, comme le reste du projet) à
     chaque rendu, pour les restaurer si présents au chargement — sans quoi
     ce retour atterrirait sur une page blanche, perdant tout ce qui avait
     été affiné. Volontairement PAS restauré si l'URL porte un `?fonds=`
     explicite (cartes de l'accueil) : ce lien direct doit toujours ouvrir
     une vue neuve sur ce fonds, pas un vieil état de session. */
  var STATE_KEY = 'rp_inventaire_state';
  var pendingOpenId = null;
  var pendingScrollY = null;

  function saveState() {
    try {
      var searchEl = document.getElementById('inv-search');
      var d1El = document.getElementById('inv-date-start');
      var d2El = document.getElementById('inv-date-end');
      sessionStorage.setItem(STATE_KEY, JSON.stringify({
        query: searchEl ? searchEl.value : '',
        dateStart: d1El ? d1El.value : '',
        dateEnd: d2El ? d2El.value : '',
        sortKey: sortKey,
        page: page,
        active: {
          fonds: Array.from(active.fonds),
          type: Array.from(active.type),
          lieu: Array.from(active.lieu),
          numerise: Array.from(active.numerise)
        },
        openDetailId: openDetailId,
        scrollY: window.scrollY
      }));
    } catch (e) { /* stockage indisponible : tant pis, pas de restauration */ }
  }

  function restoreState() {
    var raw, st;
    try { raw = sessionStorage.getItem(STATE_KEY); } catch (e) { return; }
    if (!raw) return;
    try { st = JSON.parse(raw); } catch (e) { return; }
    if (!st) return;

    query = String(st.query || '').trim().toLowerCase();
    document.getElementById('inv-search').value = st.query || '';

    var d1 = document.getElementById('inv-date-start');
    var d2 = document.getElementById('inv-date-end');
    d1.value = st.dateStart || '';
    d2.value = st.dateEnd || '';
    dateStart = parseInt(st.dateStart, 10) || null;
    dateEnd = parseInt(st.dateEnd, 10) || null;

    sortKey = st.sortKey || 'cote';
    document.getElementById('inv-sort').value = sortKey;

    page = st.page || 1;

    ['fonds', 'type', 'lieu', 'numerise'].forEach(function (axis) {
      ((st.active && st.active[axis]) || []).forEach(function (v) { active[axis].add(v); });
    });

    pendingOpenId = (typeof st.openDetailId === 'number') ? st.openDetailId : null;
    pendingScrollY = (typeof st.scrollY === 'number') ? st.scrollY : null;
  }

  // ── Chargement ──────────────────────────────────────────────────────────
  function load() {
    Promise.all([
      fetch('data/inventaire.json').then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      }),
      /* Exemplaires créés via exemplarisation.html (état partagé R2). Échoue
         silencieusement — même dégradation que partout ailleurs : mieux vaut un
         catalogue amputé des créations récentes qu'une page vide. */
      typeof fetchExemplairesManuelsAsCatalogRows === 'function'
        ? fetchExemplairesManuelsAsCatalogRows().catch(function () { return []; })
        : Promise.resolve([]),
      /* Pièces sans code-barre (jamais cataloguées dans Syracuse — fonds
         Manuscrits notamment, voir scripts/build-non-catalogues.mjs), issues
         de csv/inventaire.csv. Statique comme data/inventaire.json (pas
         d'API à ménager) : un échec de fetch dégrade vers un tableau vide
         plutôt que de bloquer le reste du catalogue. */
      fetch('data/non-catalogues.json').then(function (r) {
        return r.ok ? r.json() : [];
      }).catch(function () { return []; }),
      /* Surcouche Syracuse (synchronisation incrémentale, voir
         js/syracuse-sync-shared.js) : corrige cote/titre/auteur/date sur les
         exemplaires touchés depuis le dernier rebuild XML — { } si l'API est
         indisponible ou si rien n'a encore été synchronisé. */
      typeof fetchSyracuseSyncOverlay === 'function'
        ? fetchSyracuseSyncOverlay()
        : Promise.resolve({})
    ])
      .then(function (res) {
        records = res[0].concat(res[1]).concat(res[2]);
        var overlay = res[3] || {};
        records.forEach(function (r, i) {
          r._id = i;
          var barcode = (r['995$f'] || r['915$b'] || '').trim();
          var fresh = barcode ? overlay[barcode] : null;
          if (fresh) {
            // Appliqué AVANT _year/_hay pour que la correction alimente
            // aussi le tri/la recherche/le filtre par date, pas seulement
            // l'affichage — mêmes champs que ce que rend buildRow()/
            // buildExpandedContent() (210$d, 200$a, 700$a, 930$g).
            console.log('[syracuse-sync] correction appliquée sur', barcode, '—', fresh);
            if (fresh.dt) r['210$d'] = fresh.dt;
            if (fresh.titre) r['200$a'] = fresh.titre;
            if (fresh.auteur) r['700$a'] = fresh.auteur;
            if (fresh.cote) r['930$g'] = fresh.cote;
          }
          /* _fondsLabel (data/non-catalogues.json, data/magasins.json) est
             posé directement depuis une source fiable pour ce sous-ensemble
             (930$e du registre papier) — préféré à getFondsFromCote() plutôt
             que de deviner un fonds depuis une cote qui ne suit pas toujours
             la même convention de préfixe (ex. fonds Robaut : cotes
             "RI-01-…", pas "ROBAUT…"). Même patron que
             `buildCatalogFromItems()` dans recolement.html (CLAUDE.md,
             "Reconnaissance de code-barre par un second catalogue"). */
          r._fonds = r._fondsLabel || getFondsFromCote(r);
          r._type = normType(r['200$b']);
          r._lieu = normLieu(r['210$a']);
          /* Numérisé = un document réellement consultable dans la visionneuse
             (dossier Syracuse "num", ou lien posé à la main via
             exemplarisation.html — "_lienNumerise"), pas juste "a une
             vignette" (lien_num existe pour la plupart des exemplaires, même
             sans le moindre scan complet derrière). */
          r._numerise = (r['num'] || r['_lienNumerise']) ? 'Numérisé' : 'Non numérisé';
          r._year = yearOf(r);
          r._hay = [r['200$a'], r['700$a'], r['701$a'], r['930$g'], r['610$a']]
            .join(' ').toLowerCase();
        });
        /* Un document sans cote (930$g) n'est pas localisable en réserve —
           masqué de l'inventaire public plutôt qu'affiché avec une case vide
           (demande explicite 2026-09-12). Après application de la surcouche
           Syracuse : une cote corrigée à distance (fresh.cote ci-dessus) doit
           pouvoir faire réapparaître un exemplaire qui en était dépourvu. */
        records = records.filter(function (r) { return (r['930$g'] || '').trim(); });
        boot();
      })
      .catch(function (err) {
        document.getElementById('inv-results').innerHTML =
          '<p class="inv-empty">Erreur de chargement du catalogue : ' + esc(err.message) + '</p>';
        document.getElementById('inv-loader').style.display = 'none';
      });
  }

  function boot() {
    /* Fonds passé en URL (« inventaire.html?fonds=Douaisien »), utilisé par les
       cartes de l'accueil — prime sur un éventuel état restauré (voir
       restoreState() ci-dessus) : ce lien direct est une visite neuve, pas un
       retour depuis la visionneuse. */
    var target = new URLSearchParams(window.location.search).get('fonds');
    if (target && records.some(function (r) { return r._fonds === target; })) {
      active.fonds.add(target);
    } else {
      restoreState();
    }

    document.getElementById('inv-loader').style.display = 'none';
    document.getElementById('inv-app').hidden = false;

    bindControls();
    renderFondsCards();
    if (pendingOpenId != null && records[pendingOpenId]) openDetailId = pendingOpenId;
    apply();

    if (pendingScrollY != null) {
      var y = pendingScrollY;
      // Double rAF : laisse le temps aux vignettes/à la mise en page de se
      // stabiliser après le rendu synchrone ci-dessus avant de défiler.
      requestAnimationFrame(function () { requestAnimationFrame(function () { window.scrollTo(0, y); }); });
    }
    pendingOpenId = null;
    pendingScrollY = null;
  }

  // ── Contrôles ───────────────────────────────────────────────────────────
  function bindControls() {
    var search = document.getElementById('inv-search');
    search.addEventListener('input', debounce(function () {
      query = search.value.trim().toLowerCase();
      page = 1;
      apply();
    }, 200));

    document.getElementById('inv-form').addEventListener('submit', function (e) {
      e.preventDefault();
    });

    var d1 = document.getElementById('inv-date-start');
    var d2 = document.getElementById('inv-date-end');
    [d1, d2].forEach(function (el) {
      el.addEventListener('input', debounce(function () {
        dateStart = parseInt(d1.value, 10) || null;
        dateEnd = parseInt(d2.value, 10) || null;
        page = 1;
        apply();
      }, 250));
    });

    document.getElementById('inv-sort').addEventListener('change', function (e) {
      sortKey = e.target.value;
      page = 1;
      apply();
    });

    document.getElementById('inv-clear').addEventListener('click', function () {
      active.fonds.clear();
      active.type.clear();
      active.lieu.clear();
      active.numerise.clear();
      query = '';
      dateStart = dateEnd = null;
      search.value = '';
      d1.value = '';
      d2.value = '';
      page = 1;
      apply();
    });
  }

  // ── Filtrage ────────────────────────────────────────────────────────────
  function matches(r, skipAxis) {
    if (skipAxis !== 'fonds' && active.fonds.size && !active.fonds.has(r._fonds)) return false;
    if (skipAxis !== 'type' && active.type.size && !active.type.has(r._type)) return false;
    if (skipAxis !== 'lieu' && active.lieu.size && !active.lieu.has(r._lieu)) return false;
    if (skipAxis !== 'numerise' && active.numerise.size && !active.numerise.has(r._numerise)) return false;
    if (!dateMatchesFilter(r['210$d'], dateStart, dateEnd)) return false;
    if (query && r._hay.indexOf(query) === -1) return false;
    return true;
  }

  function apply() {
    filtered = records.filter(function (r) { return matches(r); });
    sortRecords();
    var maxPage = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
    if (page > maxPage) page = maxPage;

    renderFacets();
    renderChips();
    renderResults();
    updateFondsCardStates();
  }

  function sortRecords() {
    var dir = sortKey === 'date-desc' ? -1 : 1;
    filtered.sort(function (a, b) {
      if (sortKey === 'titre') {
        return String(a['200$a'] || '').localeCompare(String(b['200$a'] || ''), 'fr');
      }
      if (sortKey === 'date' || sortKey === 'date-desc') {
        /* Une notice sans date exploitable part en fin de liste dans les deux
           sens de tri : elle n'est ni « ancienne » ni « récente ». */
        if (a._year == null && b._year == null) return 0;
        if (a._year == null) return 1;
        if (b._year == null) return -1;
        return (a._year - b._year) * dir;
      }
      return compareCotes(a['930$g'] || '', b['930$g'] || '');
    });
  }

  // ── Cartes de fonds ─────────────────────────────────────────────────────
  function renderFondsCards() {
    var counts = {};
    var spans = {};
    records.forEach(function (r) {
      var f = r._fonds;
      counts[f] = (counts[f] || 0) + 1;
      if (r._year != null) {
        if (!spans[f]) spans[f] = { min: r._year, max: r._year };
        else {
          if (r._year < spans[f].min) spans[f].min = r._year;
          if (r._year > spans[f].max) spans[f].max = r._year;
        }
      }
    });

    var list = FONDS_VEDETTE.filter(function (f) { return counts[f]; });
    var host = document.getElementById('inv-fonds-cards');
    host.innerHTML = '';

    list.forEach(function (name) {
      var span = spans[name];
      var era = span ? (span.min === span.max ? String(span.min) : span.min + ' – ' + span.max) : '';
      var card = document.createElement('button');
      card.type = 'button';
      card.className = 'inv-fcard';
      card.dataset.fonds = name;
      card.innerHTML =
        '<span class="inv-fcard-cover" style="background-image:url(\'' + fondsImage(name) + '\')">' +
          (era ? '<span class="inv-fcard-era">' + esc(era) + '</span>' : '') +
        '</span>' +
        '<span class="inv-fcard-body">' +
          '<span class="inv-fcard-name">' + esc(name) + '</span>' +
          '<span class="inv-fcard-count">' +
            '<strong>' + counts[name].toLocaleString('fr-FR') + '</strong> notices' +
          '</span>' +
        '</span>';
      card.addEventListener('click', function () {
        toggleFacet('fonds', name);
      });
      host.appendChild(card);
    });

    document.getElementById('inv-fonds-summary').textContent =
      list.length + ' fonds · ' + records.length.toLocaleString('fr-FR') + ' documents';
  }

  function updateFondsCardStates() {
    document.querySelectorAll('.inv-fcard').forEach(function (el) {
      el.classList.toggle('inv-fcard--on', active.fonds.has(el.dataset.fonds));
    });
  }

  // ── Facettes ────────────────────────────────────────────────────────────
  var FACET_DEFS = [
    { axis: 'fonds', title: 'Fonds', field: '_fonds' },
    { axis: 'type', title: 'Type de document', field: '_type' },
    { axis: 'lieu', title: 'Lieu d’édition', field: '_lieu' },
    /* host distinct : rendue après le bloc "Période" (statique, tout en bas
       de la colonne Affiner), pas dans #inv-facets avec les trois autres —
       demande explicite pour que ce filtre reste le dernier de la colonne. */
    { axis: 'numerise', title: 'Numérisation', field: '_numerise', host: 'inv-facets-bottom' }
  ];

  function renderFacets() {
    var host = document.getElementById('inv-facets');
    host.innerHTML = '';
    var bottomHost = document.getElementById('inv-facets-bottom');
    if (bottomHost) bottomHost.innerHTML = '';

    FACET_DEFS.forEach(function (def) {
      /* Les comptes d'un axe sont calculés en ignorant ce même axe : sinon,
         dès qu'on coche « Douaisien », tous les autres fonds tomberaient à 0 et
         il deviendrait impossible d'en ajouter un second. */
      var pool = records.filter(function (r) { return matches(r, def.axis); });
      var counts = {};
      pool.forEach(function (r) {
        var v = r[def.field];
        /* « (Sans fonds) » (repli de getFondsFromCote pour une cote au préfixe
           non reconnu) n'est pas un fonds réel : pas de case à cocher pour ça
           dans la colonne "Affiner" (demande explicite 2026-09-12). */
        if (v && v !== '(Sans fonds)') counts[v] = (counts[v] || 0) + 1;
      });

      var entries = Object.keys(counts).map(function (k) {
        return { label: k, n: counts[k] };
      });
      /* Une valeur cochée reste visible même si elle sort du top : sans ça, on
         ne pourrait plus la décocher depuis la colonne. */
      entries.sort(function (a, b) {
        var aOn = active[def.axis].has(a.label) ? 1 : 0;
        var bOn = active[def.axis].has(b.label) ? 1 : 0;
        if (aOn !== bOn) return bOn - aOn;
        return b.n - a.n;
      });
      entries = entries.slice(0, FACET_MAX);
      if (!entries.length) return;

      var block = document.createElement('div');
      block.className = 'inv-facet';
      block.innerHTML = '<div class="inv-facet-title">' + esc(def.title) + '</div>';

      entries.forEach(function (e) {
        var on = active[def.axis].has(e.label);
        var row = document.createElement('button');
        row.type = 'button';
        row.className = 'inv-facet-row' + (on ? ' inv-facet-row--on' : '');
        row.setAttribute('aria-pressed', on ? 'true' : 'false');
        row.innerHTML =
          '<span class="inv-facet-box" aria-hidden="true">' + (on ? '✓' : '') + '</span>' +
          '<span class="inv-facet-label">' + esc(e.label) + '</span>' +
          '<span class="inv-facet-n">' + e.n.toLocaleString('fr-FR') + '</span>';
        row.addEventListener('click', function () { toggleFacet(def.axis, e.label); });
        block.appendChild(row);
      });

      var targetHost = (def.host && document.getElementById(def.host)) || host;
      targetHost.appendChild(block);
    });
  }

  function toggleFacet(axis, value) {
    if (active[axis].has(value)) active[axis].delete(value);
    else active[axis].add(value);
    page = 1;
    apply();
  }

  function renderChips() {
    var host = document.getElementById('inv-chips');
    host.innerHTML = '';
    var any = false;

    FACET_DEFS.forEach(function (def) {
      active[def.axis].forEach(function (v) {
        any = true;
        var chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'inv-chip';
        chip.innerHTML = esc(v) + ' <span aria-hidden="true">✕</span>';
        chip.setAttribute('aria-label', 'Retirer le filtre ' + v);
        chip.addEventListener('click', function () { toggleFacet(def.axis, v); });
        host.appendChild(chip);
      });
    });

    host.hidden = !any;
    document.getElementById('inv-clear').hidden = !any && !query && !dateStart && !dateEnd;
  }

  // ── Résultats ───────────────────────────────────────────────────────────
  function renderResults() {
    var host = document.getElementById('inv-results');
    host.innerHTML = '';

    var total = filtered.length;
    var scope = [];
    FACET_DEFS.forEach(function (def) {
      active[def.axis].forEach(function (v) { scope.push(v); });
    });
    document.getElementById('inv-count').innerHTML =
      '<strong>' + total.toLocaleString('fr-FR') + '</strong> notice' + (total > 1 ? 's' : '') +
      (scope.length ? ' · ' + esc(scope.join(' · ')) : '');

    if (!total) {
      host.innerHTML = '<p class="inv-empty">Aucun document ne correspond à cette recherche.</p>';
      document.getElementById('inv-pagination').innerHTML = '';
      return;
    }

    var start = (page - 1) * PAGE_SIZE;
    var slice = filtered.slice(start, start + PAGE_SIZE);

    slice.forEach(function (rec) {
      host.appendChild(buildRow(rec));
    });

    renderPagination(total, start);
    saveState();
  }

  function buildRow(rec) {
    var wrap = document.createElement('article');
    wrap.className = 'inv-item';

    var row = document.createElement('div');
    row.className = 'inv-row';
    row.tabIndex = 0;
    row.setAttribute('role', 'button');
    row.setAttribute('aria-expanded', openDetailId === rec._id ? 'true' : 'false');

    // Vignette (js/inventaire.js) — repli automatique si l'image est absente.
    var thumb = document.createElement('div');
    thumb.className = 'inv-thumb';
    var thumbNumVal = (rec['num'] || '').trim();
    var thumbLienNumeriseVal = (rec['_lienNumerise'] || '').trim();
    thumb.appendChild(buildThumbFrame(
      (rec['lien_num'] || '').trim(), false,
      thumbNumVal || thumbLienNumeriseVal, thumbNumVal ? 'dossier' : 'image'
    ));
    row.appendChild(thumb);

    var main = document.createElement('div');
    main.className = 'inv-main';

    var titre = (rec['200$a'] || '').trim() || '(Sans titre)';
    var h = document.createElement('h3');
    h.className = 'inv-title';
    h.textContent = titre;
    main.appendChild(h);

    var noms = (rec['700$a'] || '').split('§').map(function (s) { return s.trim(); }).filter(Boolean);
    var meta = document.createElement('p');
    meta.className = 'inv-meta';
    meta.innerHTML = esc(noms.join(', ') || 'Auteur non renseigné') +
      (rec._lieu ? ' · <span class="inv-meta-soft">' + esc(rec._lieu) + '</span>' : '');
    main.appendChild(meta);

    var tags = document.createElement('div');
    tags.className = 'inv-tags';
    var cote = (rec['930$g'] || '').trim();
    if (cote) tags.innerHTML += '<span class="inv-tag-cote">' + esc(cote) + '</span>';
    if (rec._type) tags.innerHTML += '<span class="inv-tag-type">' + esc(rec._type) + '</span>';
    main.appendChild(tags);

    row.appendChild(main);

    var side = document.createElement('div');
    side.className = 'inv-side';
    var dateTxt = formatPublicationDate((rec['210$d'] || '').trim());
    side.innerHTML =
      '<span class="inv-date">' + esc(dateTxt || '—') + '</span>' +
      '<span class="inv-more">' + (openDetailId === rec._id ? 'Fermer ↑' : 'Voir la notice →') + '</span>';
    row.appendChild(side);

    wrap.appendChild(row);

    var detail = document.createElement('div');
    detail.className = 'inv-detail';
    detail.hidden = openDetailId !== rec._id;
    if (openDetailId === rec._id) {
      detail.appendChild(buildExpandedContent(rec, (rec['lien_num'] || '').trim()));
    }
    wrap.appendChild(detail);

    function toggle() {
      var opening = openDetailId !== rec._id;
      openDetailId = opening ? rec._id : null;
      renderResults();
      if (opening) {
        var el = document.querySelector('.inv-item .inv-detail:not([hidden])');
        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }
    }
    row.addEventListener('click', toggle);
    row.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
    });

    return wrap;
  }

  function renderPagination(total, start) {
    var host = document.getElementById('inv-pagination');
    var totalPages = Math.ceil(total / PAGE_SIZE);
    var end = Math.min(start + PAGE_SIZE, total);

    host.innerHTML = '';
    var info = document.createElement('span');
    info.className = 'inv-page-info';
    info.textContent = (start + 1).toLocaleString('fr-FR') + ' – ' + end.toLocaleString('fr-FR') +
      ' sur ' + total.toLocaleString('fr-FR');
    host.appendChild(info);

    if (totalPages <= 1) return;

    function goToPage(target) {
      target = Math.max(1, Math.min(totalPages, target));
      if (target === page) return;
      page = target;
      openDetailId = null;
      renderResults();
      document.getElementById('inv-results').scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    var btns = document.createElement('div');
    btns.className = 'inv-page-btns';

    function pageBtn(label, target, opts) {
      opts = opts || {};
      var b = document.createElement('button');
      b.type = 'button';
      b.textContent = label;
      if (opts.disabled) b.disabled = true;
      else b.addEventListener('click', function () { goToPage(target); });
      btns.appendChild(b);
    }

    /* Remplace la case qui montrerait la page courante par un champ
       directement éditable (au lieu d'un bouton "is-current" inerte à côté
       d'un formulaire "Page … sur … Aller" séparé) : on tape le numéro de
       page voulu à la place, moins de largeur prise et un seul geste. */
    function currentPageInput() {
      var input = document.createElement('input');
      input.type = 'number';
      input.className = 'inv-page-current-input';
      input.min = '1';
      input.max = String(totalPages);
      input.inputMode = 'numeric';
      input.value = String(page);
      input.style.width = (String(totalPages).length + 1.5) + 'ch';
      input.setAttribute('aria-label', 'Aller à la page (sur ' + totalPages.toLocaleString('fr-FR') + ')');
      function commit() {
        var v = parseInt(input.value, 10);
        var target = isNaN(v) ? page : Math.max(1, Math.min(totalPages, v));
        if (target === page) input.value = String(page);
        else goToPage(target);
      }
      input.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
      });
      input.addEventListener('blur', commit);
      btns.appendChild(input);
    }

    pageBtn('‹ Précédent', page - 1, { disabled: page === 1 });
    pageRange(page, totalPages).forEach(function (p) {
      if (p === '…') {
        var s = document.createElement('span');
        s.className = 'inv-page-gap';
        s.textContent = '…';
        btns.appendChild(s);
      } else if (p === page) {
        currentPageInput();
      } else {
        pageBtn(String(p), p);
      }
    });
    pageBtn('Suivant ›', page + 1, { disabled: page === totalPages });

    host.appendChild(btns);
  }

  function pageRange(current, total) {
    if (total <= 7) {
      return Array.from({ length: total }, function (_, i) { return i + 1; });
    }
    var pages = [1];
    if (current > 3) pages.push('…');
    for (var i = Math.max(2, current - 1); i <= Math.min(total - 1, current + 1); i++) pages.push(i);
    if (current < total - 2) pages.push('…');
    pages.push(total);
    return pages;
  }

  /* Rafraîchit l'état juste avant de quitter la page (clic sur « Accéder au
     document numérisé », fermeture d'onglet…) : renderResults() a déjà
     sauvegardé l'état à chaque rendu, mais le défilement, lui, peut avoir
     bougé depuis sans déclencher de rendu (l'utilisateur·rice fait défiler
     jusqu'au bouton avant de cliquer). `pagehide` capture cette position
     finale sans gêner le back-forward cache (contrairement à `unload`). */
  window.addEventListener('pagehide', saveState);

  // ── Démarrage ───────────────────────────────────────────────────────────
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', load);
  } else {
    load();
  }
})();
