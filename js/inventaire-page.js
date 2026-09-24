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

  /* Les fonds mis en avant en tête de page — cette liste ne fixe plus que
     LESQUELS sont mis en avant, pas leur ordre : renderFondsCards() les
     classe par nombre de notices décroissant (demande explicite,
     2026-09-23). Un fonds absent de l'export courant est simplement sauté —
     la rangée n'est pas figée à 5. */
  var FONDS_VEDETTE = [
    'Imprimés', 'Manuscrits', 'Douaisien', "Livres d'Artiste",
    'Littérature', 'Mines', 'Réserve Douaisienne', 'Protestantisme', 'Robaut',
    'Cartes géographiques', 'Périodiques'
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
  var sortKey = 'date'; // tri par défaut : date croissante (demande explicite, 2026-09-23)
  var openDetailId = null;
  /* Axes de la colonne "Affiner" dépliés au-delà de FACET_MAX (bouton "Voir
     plus", demande explicite 2026-09-23) — survit aux re-rendus de
     renderFacets() (un changement de filtre ne referme pas ce qui a été
     déplié), remis à zéro seulement si la page est rechargée. */
  var expandedFacets = {};

  /* Facettes actives : un Set de valeurs par axe. Plusieurs valeurs sur le même
     axe se lisent en OU (« Douaisien OU Imprimés »), deux axes différents en ET
     — la convention habituelle d'une recherche à facettes. */
  var active = { fonds: new Set(), type: new Set(), lieu: new Set(), langue: new Set(), auteur: new Set(), numerise: new Set(), sansDate: new Set() };
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
     revanche « Parisiis »/« Lutetiae Parisiorum » (formes latines du titre)
     sont laissées distinctes : c'est une information sur l'édition, pas une
     variante de saisie.

     Beaucoup de notices anciennes portent l'adresse complète de l'éditeur
     recopiée depuis la page de titre plutôt que le seul lieu (« Paris, chez
     Briasson, rue Saint-Jacques… M.DCC.XXVII »), ce qui fragmentait
     énormément la facette — Paris à lui seul apparaissait sous plusieurs
     centaines de formes différentes (demande explicite, 2026-09-23). Sur ces
     pages de titre, le lieu est presque toujours ce qui précède la première
     virgule/deux-points/point-virgule ; on ne garde que ça. Compromis
     précision/rappel assumé (même esprit que ailleurs sur le site, voir
     reliures.html/CLAUDE.md) : une poignée de formulations anciennes sans
     ponctuation (« On les vend à Paris… ») ne sont pas reconnues et restent
     telles quelles, mais elles sont rares (occurrence unique la plupart du
     temps) et ne polluent donc plus le haut de la liste. */
  function normLieu(raw) {
    var s = String(raw || '').trim();
    if (!s) return '';
    // Occurrences répétées d'un même champ 210$a (« Amsterdam§Paris »,
    // convention « § » du projet) : on ne garde que la première, le lieu
    // principal de la page de titre — les suivantes sont des éditions/
    // impressions alternatives mentionnées à la suite.
    if (s.indexOf('§') !== -1) s = s.split('§')[0].trim();
    s = s.replace(/^\[|\]$/g, '').trim();
    // Chaîne entièrement encadrée de parenthèses restantes (« (Lens) »,
    // « (Lille) ») : déballer plutôt que supprimer par la suite — sinon la
    // suppression de « ville (département) » ci-dessous effacerait tout,
    // la ville elle-même étant entre parenthèses.
    var wholeParen = s.match(/^\((.*)\)$/);
    if (wholeParen) s = wholeParen[1].trim();
    s = s.replace(/^[àa]\s+/i, '');          // « A Paris » → « Paris »
    var cut = s.search(/[,:;]/);
    if (cut !== -1) s = s.slice(0, cut);     // « Paris, chez Briasson… » → « Paris »
    s = s.replace(/\s*\([^)]*\)\s*$/, '');   // « Bouvignies (Nord) » → « Bouvignies »
    s = s.replace(/[.,;:]+$/, '').trim();
    s = s.replace(/\s+/g, ' ');
    if (!s) return '';
    if (/^s\.?\s*l\.?$/i.test(s)) return 'Sans lieu';
    return s.charAt(0).toUpperCase() + s.slice(1);
  }

  function yearOf(rec) {
    var p = parsePublicationDate(rec['210$d']);
    return p ? p.start : null;
  }

  /* « s.d. » (sans date), sous toutes ses graphies relevées dans l'export
     courant (accents/casse/espaces/ponctuation/enrobage variables — « s.d. »,
     « [sd] », « [s. d.] », « (s. d.) », « [S. d.] », « [s.d.?] », « [n.d.] »…) :
     réduite à ses seules lettres, une notation "sans date" vaut toujours
     "sd" ou "nd" (« n.d. », équivalent anglophone croisé une fois dans
     l'export). Volontairement PAS étendu aux notations d'incertitude qui
     portent quand même une information temporelle approximative
     (« 19--- », « [16..] », « 177? »…) : ce ne sont pas des documents SANS
     date, seulement des documents dont l'année précise est incertaine — même
     distinction que le "s.l." de normLieu() ci-dessus, qui lui est un vrai
     répertoire de lieu inconnu. */
  function isSansDateNotation(str) {
    var core = String(str || '').toLowerCase().replace(/[^a-z]/g, '');
    return core === 'sd' || core === 'nd';
  }

  /* Sans date = champ 210$d vide, OU renseigné mais ne contenant qu'une
     notation "sans date" reconnue ci-dessus — jamais un simple échec de
     parsePublicationDate() (qui, lui, englobe aussi les notes de format
     "26 cm", les lieux mal saisis dans ce champ, etc. : du texte non
     exploitable, pas une absence de date confirmée par le catalogueur). Un
     champ à plusieurs segments joints par « § » (voir parsePublicationDate)
     n'est donc "sans date" que si RIEN d'autre n'y figure — « s.d.§26 cm »
     ne matche plus une fois lettres concaténées ("sdcm" ≠ "sd"), ce qui est
     le comportement voulu : il y a bien une info en plus du "s.d.". */
  function isSansDate(rec) {
    var raw = rec['210$d'];
    if (parsePublicationDate(raw)) return false;
    var str = String(raw || '').trim();
    if (!str) return true;
    return isSansDateNotation(str);
  }

  /* "NOM Prénom" par auteur, un par entrée du tableau (pas de valeur vide
     pour un document sans auteur). Même reconstruction que
     buildExpandedContent() dans js/inventaire.js (700$a/700$b, occurrences
     répétées jointes par §), voir le commentaire sur r._auteurListe. */
  function authorNamesOf(rec) {
    var prenoms = (rec['700$b'] || '').split('§').map(function (s) { return s.trim(); });
    var noms = (rec['700$a'] || '').split('§').map(function (s) { return s.trim(); }).filter(Boolean);
    return noms.map(function (n, i) {
      return (n.toUpperCase() + (prenoms[i] ? ' ' + prenoms[i] : '')).trim();
    });
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
          langue: Array.from(active.langue),
          auteur: Array.from(active.auteur),
          numerise: Array.from(active.numerise),
          sansDate: Array.from(active.sansDate)
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

    sortKey = st.sortKey || 'date';
    document.getElementById('inv-sort').value = sortKey;

    page = st.page || 1;

    ['fonds', 'type', 'lieu', 'langue', 'auteur', 'numerise', 'sansDate'].forEach(function (axis) {
      ((st.active && st.active[axis]) || []).forEach(function (v) { active[axis].add(v); });
    });

    pendingOpenId = (typeof st.openDetailId === 'number') ? st.openDetailId : null;
    pendingScrollY = (typeof st.scrollY === 'number') ? st.scrollY : null;
  }

  // ── Chargement ──────────────────────────────────────────────────────────
  function load() {
    Promise.all([
      /* Priorité à /api/inventaire (généré en direct depuis Postgres — voir
         scripts/lib/export-inventaire.mjs, inclut déjà réserve + pièces non
         cataloguées Manuscrits/Robaut/Objets + fonds Cartes/Périodiques,
         voir db/migrations/0007_split_reserve_tables.sql et
         0008_reserve_non_catalogues.sql) ; repli, SI l'API échoue (base
         arrêtée, page ouverte sans `npm run dev`…), sur les DEUX fichiers
         statiques committés recomposés côté client — data/inventaire.json
         (réserve, généré par npm run build) et data/non-catalogues.json
         (Manuscrits/Robaut/Objets, npm run build:non-catalogues) ne se
         recouvrent pas, il faut les deux pour retrouver ce que /api/inventaire
         donne en un seul appel. Même patron que loadRecolement() dans
         reserve.html pour le principe API-d'abord/statique-en-repli. */
      fetch('/api/inventaire')
        .then(function (r) { if (!r.ok) throw new Error('api-unavailable'); return r.json(); })
        .catch(function () {
          return Promise.all([
            fetch('data/inventaire.json').then(function (r) {
              if (!r.ok) throw new Error('HTTP ' + r.status);
              return r.json();
            }),
            fetch('data/non-catalogues.json').then(function (r) {
              return r.ok ? r.json() : [];
            }).catch(function () { return []; }),
          ]).then(function (parts) { return parts[0].concat(parts[1]); });
        }),
      /* Exemplaires créés via exemplarisation.html (état partagé R2). Échoue
         silencieusement — même dégradation que partout ailleurs : mieux vaut un
         catalogue amputé des créations récentes qu'une page vide. */
      typeof fetchExemplairesManuelsAsCatalogRows === 'function'
        ? fetchExemplairesManuelsAsCatalogRows().catch(function () { return []; })
        : Promise.resolve([]),
      /* Presse numérisée (fonds Périodiques, scripts/build-manifest-presse.mjs) :
         { "D19": ["1895","1896",…], … } — quelles années sont consultables
         dans la visionneuse pour un titre donné (cote 930$g = "D19"/"D23"/
         "D24", voir scripts/lib/fonds-periodiques-record.mjs). Petit fichier
         statique, jamais absent en usage normal, mais dégradation silencieuse
         comme les autres sources si le fetch échoue. */
      fetch('js/presse-index.json').then(function (r) {
        return r.ok ? r.json() : {};
      }).catch(function () { return {}; })
    ])
      .then(function (res) {
        records = res[0].concat(res[1]);
        var presseIndex = res[2] || {};
        records.forEach(function (r, i) {
          r._id = i;
          /* _fondsLabel (data/non-catalogues.json, data/magasins.json) est
             posé directement depuis une source fiable pour ce sous-ensemble
             (930$e du registre papier) — préféré à getFondsFromCote() plutôt
             que de deviner un fonds depuis une cote qui ne suit pas toujours
             la même convention de préfixe (ex. fonds Robaut : cotes
             "RI-01-…", pas "ROBAUT…"). Même patron que
             `buildCatalogFromItems()` dans recolement.html (CLAUDE.md,
             "Reconnaissance de code-barre par un second catalogue"). */
          r._fonds = r._fondsLabel || getFondsFromCote(r);
          /* _typeDocument (scripts/lib/type-document-labels.mjs) vient du code
             fermé 920$t (exemplaire), posé au build sur 100% des exemplaires
             de la réserve — préféré à 200$b (champ notice en texte libre : vide
             sur 43% des exemplaires au 2026-09-23, casse flottante, accents
             cassés, coquilles). Absent sur les sources fusionnées qui n'ont
             jamais eu de code Syracuse (exemplaires manuels
             d'exemplarisation.html, pièces non cataloguées du fonds
             Manuscrits/Robaut/Objets) : repli sur l'ancien normType(200$b)
             pour elles uniquement. */
          r._type = r._typeDocument || normType(r['200$b']);
          r._lieu = normLieu(r['210$a']);
          /* Presse numérisée (fonds Périodiques) : la cote (930$g) d'un titre
             numérisé est directement son code de collecte ("D19"/"D23"/"D24",
             voir scripts/lib/fonds-periodiques-record.mjs) — on la cherche
             telle quelle dans presseIndex plutôt que de filtrer par
             _fondsLabel, pour rester correct même si ce fonds change de nom
             un jour. _presseCalendar (année → mois → jour → nom du "book" de
             CE numéro, voir scripts/build-manifest-presse.mjs) alimente le
             calendrier année/mois/jour de buildExpandedContent()
             (js/inventaire.js) — chaque "book" ne contient que les pages de
             son propre numéro, pas toute l'année. */
          var presseCote = (r['930$g'] || '').trim().toUpperCase();
          var presseEntry = presseIndex[presseCote];
          if (presseEntry && presseEntry.years) {
            r._presseCalendar = presseEntry.years;
            r._presseYears = Object.keys(presseEntry.years).sort();
            /* Vignette de la notice : 1re page de la parution la plus
               ancienne (posée par le script de build). Ces notices n'ont
               sinon aucun lien_num (pas d'exemplaire physique associé). */
            if (presseEntry.cover && !r['lien_num']) r['lien_num'] = presseEntry.cover;
            /* Bornes réelles de la collection numérisée : affinent les dates
               de première/dernière parution du registre papier (930$g,
               scripts/lib/fonds-periodiques-record.mjs), parfois
               approximatives (ex. "ap1896" pour Douai Républicain) — toute la
               collection étant numérisée d'un coup, la première et la
               dernière année réellement scannées (r._presseYears, déjà
               triées) sont une source plus fiable que le registre papier.
               Avant _year (calculé juste plus bas) pour que le tri/filtre
               par date en profite aussi, pas seulement l'affichage. */
            if (r._presseYears.length) {
              var anneeDebut = r._presseYears[0];
              var anneeFin = r._presseYears[r._presseYears.length - 1];
              r['210$d'] = anneeDebut === anneeFin ? anneeDebut : (anneeDebut + ' – ' + anneeFin);
              r._parution = r['210$d'];
            }
          }
          /* Numérisé = un document réellement consultable dans la visionneuse
             (dossier Syracuse "num", lien posé à la main via
             exemplarisation.html — "_lienNumerise", ou presse numérisée par
             année ci-dessus), pas juste "a une vignette" (lien_num existe
             pour la plupart des exemplaires, même sans le moindre scan
             complet derrière). */
          r._numerise = (r['num'] || r['_lienNumerise'] || r._presseYears) ? 'Numérisé' : 'Non numérisé';
          r._sansDate = isSansDate(r) ? 'Sans date connue' : 'Date connue';
          /* Un auteur par entrée (pas une chaîne "NOM Prénom, NOM Prénom"
             jointe) — nécessaire pour filtrer par UN auteur précis quand un
             document en a plusieurs. Même reconstruction "NOM Prénom" que
             buildExpandedContent() dans js/inventaire.js (700$a/700$b joints
             par §), dupliquée ici plutôt que factorisée : l'un rend une
             chaîne d'affichage, l'autre une liste de valeurs de facette —
             voir authorNamesOf() ci-dessous. */
          r._auteurListe = authorNamesOf(r);
          /* Une langue par entrée (pas une chaîne "Français, Russe" jointe) —
             même raison que r._auteurListe juste au-dessus : un document
             bilingue ne doit pas ouvrir une case "Français, Russe" à part
             dans la colonne "Affiner" (qui fragmentait la facette d'autant
             de combinaisons que de couples de langues), mais compter dans
             les deux cases "Français" ET "Russe" (demande explicite,
             2026-09-23). _langue (déjà traduit et dédoublonné par
             langueLabelOf(), voir scripts/lib/langue-labels.mjs) reste la
             chaîne affichée telle quelle dans le panneau de détail — aucun
             libellé de langue ne contient de virgule, le séparateur ", "
             qu'utilise langueLabelOf() est donc sans ambiguïté à re-découper
             ici plutôt que de dupliquer la table de traduction côté client. */
          r._langueListe = r._langue ? r._langue.split(', ') : [];
          r._year = yearOf(r);
          /* _frequence/_villeLabel/_imprimeurLabel (fonds Périodiques, voir
             scripts/lib/fonds-periodiques-record.mjs) : absents sur tous les
             autres fonds, donc sans effet sur leur recherche — rendent par
             exemple "Crépin" ou "hebdomadaire" trouvables. */
          r._hay = [
            r['200$a'], r['700$a'], r['701$a'], r['930$g'], r['610$a'],
            r._frequence, r._villeLabel, r._imprimeurLabel
          ].join(' ').toLowerCase();
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
    bindAdvancedSearch();
    renderFondsCards();
    if (pendingOpenId != null && records[pendingOpenId]) openDetailId = pendingOpenId;
    apply();

    /* Notice rouverte au retour de la visionneuse (voir « État persisté »
       ci-dessus) : plus une ligne dépliée dans la liste, mais la même
       modale que celle ouverte par un clic normal sur une notice. */
    if (openDetailId != null && records[openDetailId]) showDetail(records[openDetailId]);

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
      active.langue.clear();
      active.auteur.clear();
      active.numerise.clear();
      active.sansDate.clear();
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
    /* Axes multi-valeurs (un document peut avoir plusieurs langues, plusieurs
       auteurs) : match dès qu'AU MOINS une valeur du document est dans
       l'ensemble actif — même lecture "OU" que les autres axes, appliquée
       ici valeur par valeur plutôt que document par document. */
    if (skipAxis !== 'langue' && active.langue.size &&
        !(r._langueListe && r._langueListe.some(function (l) { return active.langue.has(l); }))) return false;
    if (skipAxis !== 'auteur' && active.auteur.size &&
        !(r._auteurListe && r._auteurListe.some(function (a) { return active.auteur.has(a); }))) return false;
    if (skipAxis !== 'numerise' && active.numerise.size && !active.numerise.has(r._numerise)) return false;
    if (skipAxis !== 'sansDate' && active.sansDate.size && !active.sansDate.has(r._sansDate)) return false;
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

  /* Un « [10xx] » (siècle approximatif, voir parsePublicationDate() dans
     js/inventaire.js) vaut 1001 en interne pour rester comparable à une
     année pleine, mais afficher « 1001 » comme borne d'une période suggère
     une précision à l'année qui n'existe pas dans la donnée d'origine —
     demande explicite : cette borne s'affiche en siècle (« XIe siècle »)
     plutôt qu'en chiffres quand elle vient de cette notation. Une année
     pleine (« 1479 ») reste affichée telle quelle. */
  function eraEndpointLabel(rec, yearFallback) {
    var raw = rec && rec['210$d'];
    var s = String(raw || '').trim();
    if (/^\[\d{2}xx\]$/i.test(s)) return formatPublicationDate(s);
    return String(yearFallback);
  }

  // ── Cartes de fonds ─────────────────────────────────────────────────────
  function renderFondsCards() {
    var counts = {};
    var spans = {};
    records.forEach(function (r) {
      var f = r._fonds;
      counts[f] = (counts[f] || 0) + 1;
      if (r._year != null) {
        if (!spans[f]) spans[f] = { min: r._year, max: r._year, minRec: r, maxRec: r };
        else {
          if (r._year < spans[f].min) { spans[f].min = r._year; spans[f].minRec = r; }
          if (r._year > spans[f].max) { spans[f].max = r._year; spans[f].maxRec = r; }
        }
      }
    });

    var list = FONDS_VEDETTE.filter(function (f) { return counts[f]; });
    list.sort(function (a, b) { return counts[b] - counts[a]; });
    var host = document.getElementById('inv-fonds-cards');
    host.innerHTML = '';

    list.forEach(function (name) {
      var span = spans[name];
      var era = '';
      if (span) {
        var lo = eraEndpointLabel(span.minRec, span.min);
        era = (span.min === span.max) ? lo : lo + ' – ' + eraEndpointLabel(span.maxRec, span.max);
      }
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
  // Pas d'entrée 'fonds' ici : ce filtre reste piloté par les cartes de fonds
  // en haut de page (renderFondsCards()/toggleFacet('fonds', …)), qui
  // couvrent déjà la sélection — une case à cocher redondante dans la
  // colonne "Affiner" ci-dessous ferait doublon (demande explicite). `active.
  // fonds`/`matches()` restent inchangés : le filtrage par fonds fonctionne
  // toujours, seul son rendu dans cette colonne est retiré.
  var FACET_DEFS = [
    { axis: 'type', title: 'Type de document', field: '_type' },
    { axis: 'lieu', title: 'Lieu d’édition', field: '_lieu' },
    /* _langueListe (voir r._langueListe/scripts/lib/langue-labels.mjs)
       n'existe que sur les exemplaires issus de data/inventaire.json —
       absent (tableau vide) sur les fusions exemplaires-manuels/
       non-catalogues, qui n'ont pas de code UNIMARC 101$a à traduire.
       Ignorés de cette facette comme n'importe quelle valeur vide (voir le
       filtre `if (v && …)` dans renderFacets()), pas une exclusion
       spécifique à coder ici. Champ multi-valeur (comme _auteurListe) :
       un document en plusieurs langues compte dans chacune d'elles plutôt
       que d'ouvrir une case "Français, Russe" à part. */
    { axis: 'langue', title: 'Langue', field: '_langueListe' },
    /* host distinct : rendue après le bloc "Période" (statique, tout en bas
       de la colonne Affiner), pas dans #inv-facets avec les trois autres —
       demande explicite pour que ce filtre reste le dernier de la colonne. */
    { axis: 'numerise', title: 'Numérisation', field: '_numerise', host: 'inv-facets-bottom' },
    /* Même hôte que Numérisation, même raison : filtre dérivé plutôt que
       catégorie de catalogage, mieux à sa place en bas de la colonne
       "Affiner" qu'avec type/lieu/langue. Voir isSansDate() ci-dessus pour
       ce qui distingue "Sans date connue" d'un simple échec de parsing. */
    { axis: 'sansDate', title: 'Date', field: '_sansDate', host: 'inv-facets-bottom' },
    /* manualOnly : pas de bloc de cases à cocher dans la colonne "Affiner"
       (des milliers de noms distincts — une liste à cocher serait inutilisable,
       voir la recherche avancée / ADV_CATEGORIES qui pilote cet axe via une
       saisie à suggestions). Présent dans FACET_DEFS uniquement pour que
       renderChips()/le scope de renderResults()/le bouton "Effacer" (qui les
       parcourent déjà tous les trois) couvrent aussi les auteurs choisis. */
    { axis: 'auteur', title: 'Auteur', field: '_auteurListe', manualOnly: true }
  ];

  function renderFacets() {
    var host = document.getElementById('inv-facets');
    host.innerHTML = '';
    var bottomHost = document.getElementById('inv-facets-bottom');
    if (bottomHost) bottomHost.innerHTML = '';

    FACET_DEFS.forEach(function (def) {
      if (def.manualOnly) return;
      /* Les comptes d'un axe sont calculés en ignorant ce même axe : sinon,
         dès qu'on coche « Douaisien », tous les autres fonds tomberaient à 0 et
         il deviendrait impossible d'en ajouter un second. */
      var pool = records.filter(function (r) { return matches(r, def.axis); });
      var counts = {};
      pool.forEach(function (r) {
        var raw = r[def.field];
        /* Champ multi-valeur (ex. _langueListe, déjà un tableau) : chaque
           valeur compte pour elle-même — un document en compte plusieurs à
           la fois, plutôt qu'une case combinée par combinaison rencontrée
           (voir le commentaire sur r._langueListe plus haut). Un champ
           simple (_type/_lieu) est enveloppé en tableau à une entrée pour
           partager la même boucle. */
        var values = Array.isArray(raw) ? raw : (raw ? [raw] : []);
        values.forEach(function (v) {
          /* « (Sans fonds) » (repli de getFondsFromCote pour une cote au
             préfixe non reconnu) n'est pas un fonds réel : pas de case à
             cocher pour ça dans la colonne "Affiner" (demande explicite
             2026-09-12). */
          if (v && v !== '(Sans fonds)') counts[v] = (counts[v] || 0) + 1;
        });
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
      if (!entries.length) return;

      // "Voir plus" : au-delà de FACET_MAX, replié par défaut — expandedFacets
      // retient le dépliage d'un axe entre deux rendus (voir sa déclaration).
      var expanded = !!expandedFacets[def.axis];
      var hasMore = entries.length > FACET_MAX;
      var visible = expanded ? entries : entries.slice(0, FACET_MAX);

      var block = document.createElement('div');
      block.className = 'inv-facet';
      block.innerHTML = '<div class="inv-facet-title">' + esc(def.title) + '</div>';

      visible.forEach(function (e) {
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

      if (hasMore) {
        var more = document.createElement('button');
        more.type = 'button';
        more.className = 'inv-facet-more' + (expanded ? ' inv-facet-more--open' : '');
        more.setAttribute('aria-expanded', expanded ? 'true' : 'false');
        more.innerHTML =
          '<span>' + (expanded ? 'Voir moins' : 'Voir plus (' + (entries.length - FACET_MAX) + ')') + '</span>' +
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>';
        more.addEventListener('click', function () {
          expandedFacets[def.axis] = !expanded;
          renderFacets();
        });
        block.appendChild(more);
      }

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

  function buildChip(axis, value) {
    var chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'inv-chip';
    chip.innerHTML = esc(value) + ' <span aria-hidden="true">✕</span>';
    chip.setAttribute('aria-label', 'Retirer le filtre ' + value);
    chip.addEventListener('click', function () { toggleFacet(axis, value); });
    return chip;
  }

  function renderChips() {
    var host = document.getElementById('inv-chips');
    host.innerHTML = '';
    var any = false;

    FACET_DEFS.forEach(function (def) {
      active[def.axis].forEach(function (v) {
        any = true;
        host.appendChild(buildChip(def.axis, v));
      });
    });

    host.hidden = !any;
    document.getElementById('inv-clear').hidden = !any && !query && !dateStart && !dateEnd;
  }

  // ── Recherche avancée (panneau à côté du bouton "Rechercher") ──────────
  /* Ajoute des critères EXACTS, en plus de la recherche libre de #inv-search
     — un même axe (type/lieu/langue/auteur) coché ici équivaut à le cocher
     dans la colonne "Affiner" (toggleFacet() est réutilisée telle quelle).
     Une LIGNE = un critère (catégorie + valeur) : le bouton "+" en ajoute
     une, le "−" de chaque ligne la retire — et défait au passage le filtre
     qu'elle portait, pour qu'une ligne supprimée ou reconfigurée ne laisse
     jamais un filtre actif orphelin (voir clearAdvRowValue()).

     Une seule famille de rendu pour toutes les catégories : champ texte +
     suggestions qui s'affinent à la frappe (renderAdvAutocomplete). Un menu
     déroulant natif a d'abord été essayé pour type/lieu/langue (peu de
     valeurs distinctes, pensait-on) mais "Lieu d'édition" en particulier
     s'est révélé avoir des centaines de variantes orthographiques
     (« Parisiis », « A Paris »…) — un <select> "interminable" plutôt que
     pratique (demande explicite, 2026-09-22). Choisir une personne précise
     parmi des homonymes (voir l'exemple "moreau" pour Auteur) reste la même
     idée pour toutes les catégories : suggérer plutôt que dérouler. */
  var ADV_CATEGORIES = [
    { value: 'type', label: 'Type de document', axis: 'type', field: '_type' },
    { value: 'lieu', label: 'Lieu d’édition', axis: 'lieu', field: '_lieu' },
    { value: 'langue', label: 'Langue', axis: 'langue', field: '_langueListe', multi: true },
    { value: 'auteur', label: 'Auteur', axis: 'auteur', field: '_auteurListe', multi: true }
  ];

  /* Valeurs d'un enregistrement pour une catégorie donnée, toujours en
     tableau — `multi` (ex. _auteurListe, _langueListe) est déjà un tableau,
     les autres champs (_type/_lieu) sont de simples chaînes qu'on enveloppe
     pour que renderAdvAutocomplete ait un seul code à écrire pour les deux. */
  function advValuesOf(r, cat) {
    var v = r[cat.field];
    if (cat.multi) return v || [];
    return v ? [v] : [];
  }

  function advCategoryByValue(value) {
    for (var i = 0; i < ADV_CATEGORIES.length; i++) {
      if (ADV_CATEGORIES[i].value === value) return ADV_CATEGORIES[i];
    }
    return null;
  }

  var advRows = []; // { id, axis, value, el, valueWrap }
  var advRowSeq = 0;

  function bindAdvancedSearch() {
    var toggle = document.getElementById('inv-adv-toggle');
    var panel = document.getElementById('inv-adv');
    toggle.addEventListener('click', function () {
      panel.hidden = !panel.hidden;
      toggle.setAttribute('aria-expanded', panel.hidden ? 'false' : 'true');
    });

    addAdvRow(); // une ligne dès l'ouverture plutôt qu'un panneau vide au premier coup d'œil
  }

  /* + et − vivent sur CHAQUE ligne (demande explicite), pas un unique bouton
     "Ajouter" séparé en bas du panneau : "+" ajoute une nouvelle ligne à la
     suite, "−" retire celle-ci. Toujours au moins une ligne à l'écran — voir
     removeAdvRow(), qui réinitialise plutôt que supprime la dernière. */
  function addAdvRow() {
    var row = { id: ++advRowSeq, axis: null, value: null };
    advRows.push(row);

    var el = document.createElement('div');
    el.className = 'inv-adv-row';

    var catSelect = document.createElement('select');
    catSelect.className = 'inv-adv-cat';
    catSelect.setAttribute('aria-label', 'Catégorie du critère');
    var optionsHtml = '<option value="">Choisir une catégorie…</option>';
    ADV_CATEGORIES.forEach(function (cat) {
      optionsHtml += '<option value="' + esc(cat.value) + '">' + esc(cat.label) + '</option>';
    });
    catSelect.innerHTML = optionsHtml;

    var valueWrap = document.createElement('div');
    valueWrap.className = 'inv-adv-value-wrap';
    valueWrap.innerHTML = '<p class="inv-adv-hint">Choisissez d’abord une catégorie.</p>';

    var addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.className = 'inv-adv-row-btn inv-adv-row-add';
    addBtn.setAttribute('aria-label', 'Ajouter un autre critère');
    addBtn.textContent = '+';
    addBtn.addEventListener('click', addAdvRow);

    var removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'inv-adv-row-btn inv-adv-row-remove';
    removeBtn.setAttribute('aria-label', 'Retirer ce critère');
    removeBtn.textContent = '−';
    removeBtn.addEventListener('click', function () { removeAdvRow(row); });

    catSelect.addEventListener('change', function () {
      clearAdvRowValue(row); // l'ancien critère de cette ligne, le cas échéant, ne doit pas survivre au changement de catégorie
      row.axis = catSelect.value || null;
      renderAdvRowValue(row);
    });

    el.appendChild(catSelect);
    el.appendChild(valueWrap);
    el.appendChild(addBtn);
    el.appendChild(removeBtn);
    row.el = el;
    row.catSelect = catSelect;
    row.valueWrap = valueWrap;

    document.getElementById('inv-adv-rows').appendChild(el);
  }

  function removeAdvRow(row) {
    clearAdvRowValue(row);
    if (advRows.length <= 1) {
      // Jamais zéro ligne à l'écran (sinon plus aucun "+" cliquable pour en
      // recréer une) : on réinitialise la dernière au lieu de la retirer.
      row.axis = null;
      row.catSelect.value = '';
      renderAdvRowValue(row);
      return;
    }
    advRows = advRows.filter(function (r) { return r.id !== row.id; });
    if (row.el && row.el.parentNode) row.el.parentNode.removeChild(row.el);
  }

  /* Défait le critère actif porté par cette ligne (s'il y en a un). Appelée
     avant de changer de catégorie et à la suppression de la ligne — jamais
     à la simple frappe dans le champ auteur (voir renderAdvAutocomplete). */
  function clearAdvRowValue(row) {
    if (row.axis && row.value != null) toggleFacet(row.axis, row.value);
    row.value = null;
  }

  /* Une ligne ne porte qu'UN critère à la fois : choisir une nouvelle valeur
     remplace la précédente au lieu de s'accumuler avec elle — pour ajouter
     "Auteur = X OU Y", on ajoute une seconde LIGNE (bouton "+"), plutôt que
     de cocher deux valeurs dans la même. */
  function setAdvRowValue(row, value) {
    if (row.value != null) toggleFacet(row.axis, row.value);
    row.value = value;
    toggleFacet(row.axis, value);
  }

  function renderAdvRowValue(row) {
    var wrap = row.valueWrap;
    wrap.innerHTML = '';
    var cat = advCategoryByValue(row.axis);
    if (!cat) {
      wrap.innerHTML = '<p class="inv-adv-hint">Choisissez d’abord une catégorie.</p>';
      return;
    }
    renderAdvAutocomplete(row, wrap, cat);
  }

  /* Champ texte + liste de suggestions, recalculées à chaque frappe
     (debounce 200 ms, comme la recherche libre) plutôt qu'un index construit
     une fois pour toutes — largement assez rapide sur ce volume (quelques
     dizaines de milliers de documents, filtre de sous-chaîne) et toujours
     cohérent avec les autres filtres actifs sans code de mise en cache
     séparé à maintenir. Comptes sur le même pool "scopé par les autres axes
     actifs" que renderFacets() (skipAxis évite qu'un critère s'auto-exclue). */
  function renderAdvAutocomplete(row, wrap, cat) {
    wrap.innerHTML =
      '<div class="inv-adv-autocomplete">' +
        '<input type="text" aria-label="' + esc(cat.label) + '" placeholder="Taper : ' + esc(cat.label.toLowerCase()) + '…" autocomplete="off">' +
        '<ul class="inv-adv-suggestions" hidden></ul>' +
      '</div>';

    var input = wrap.querySelector('input');
    var list = wrap.querySelector('.inv-adv-suggestions');
    if (row.value) input.value = row.value; // ligne déjà configurée (ex. après un changement ailleurs sur la page)

    function closeList() { list.hidden = true; list.innerHTML = ''; }

    input.addEventListener('input', debounce(function () {
      // Retaper après avoir déjà choisi une valeur désengage ce choix : la
      // ligne ne représente plus ce critère tant qu'une nouvelle suggestion
      // n'est pas cliquée.
      if (row.value != null && input.value !== row.value) clearAdvRowValue(row);

      var q = input.value.trim().toLowerCase();
      if (q.length < 2) { closeList(); return; }

      var pool = records.filter(function (r) { return matches(r, cat.axis); });
      var counts = {};
      pool.forEach(function (r) {
        advValuesOf(r, cat).forEach(function (v) {
          if (v && v.toLowerCase().indexOf(q) !== -1) counts[v] = (counts[v] || 0) + 1;
        });
      });
      var entries = Object.keys(counts).sort(function (a, b) { return counts[b] - counts[a]; }).slice(0, 8);

      if (!entries.length) { closeList(); return; }
      list.innerHTML = '';
      entries.forEach(function (v) {
        var li = document.createElement('li');
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.innerHTML = '<span>' + esc(v) + '</span><span class="inv-adv-suggestion-n">' + counts[v].toLocaleString('fr-FR') + '</span>';
        btn.addEventListener('click', function () {
          setAdvRowValue(row, v);
          input.value = v;
          closeList();
        });
        li.appendChild(btn);
        list.appendChild(li);
      });
      list.hidden = false;
    }, 200));

    // Referme la liste au clic ailleurs sur la page (pas à l'intérieur du champ/de la liste).
    document.addEventListener('click', function (e) {
      if (!wrap.contains(e.target)) closeList();
    });
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

  /* Ouvre la notice dans la modale centrée (js/inventaire.js —
     openDetailModal/buildExpandedContent), en gardant openDetailId à jour
     pour que le retour de la visionneuse (voir « État persisté ») rouvre la
     même notice. Le rappel de fermeture efface cet état : un rechargement
     après avoir simplement refermé la modale ne doit pas la rouvrir. */
  function showDetail(rec) {
    openDetailId = rec._id;
    saveState();
    openDetailModal(rec, (rec['lien_num'] || '').trim(), function () {
      openDetailId = null;
      saveState();
    });
  }

  function buildRow(rec) {
    var wrap = document.createElement('article');
    wrap.className = 'inv-item';

    var row = document.createElement('div');
    row.className = 'inv-row';
    row.tabIndex = 0;
    row.setAttribute('role', 'button');
    row.setAttribute('aria-haspopup', 'dialog');

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
      '<span class="inv-more">Voir la notice →</span>';
    row.appendChild(side);

    wrap.appendChild(row);

    function openThis() { showDetail(rec); }
    row.addEventListener('click', openThis);
    row.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openThis(); }
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
