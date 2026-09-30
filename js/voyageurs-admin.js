/* ============================================================
   VOYAGEURS DOUAISIENS — éditeur (voyageurs-admin.html)
   ------------------------------------------------------------
   Lit et écrit le schéma Postgres `expo_voyageurs` via
   /api/voyageurs-admin (GET/POST authentifiés, voir l'en-tête de
   api/voyageurs-admin.mjs). L'API renvoie les points dans la même forme
   que /data/voyageurs.json (coord, date, depart, approx, mode, arret) :
   ce que l'on édite ici est exactement ce que lit js/voyageurs.js.

   Principe : une fiche (voyageur ou voyage) est copiée dans `draft` à
   l'ouverture ; toute saisie modifie `draft`, rien ne part au serveur
   avant « Enregistrer ». La comparaison `serialize()` / `saved` dit s'il
   reste des modifications non enregistrées. Le serveur réécrit un voyage
   en bloc (étapes renumérotées de 10 en 10) : pas de patch d'étape.

   Le tracé est dessiné comme sur la page publique — grand cercle entre
   deux points — pour que ce que l'on voit ici soit ce qui sera animé.
   Les fonctions de géodésie et d'estimation des dates sont recopiées de
   js/voyageurs.js (même logique, pas de module partagé sans bundler).
   ============================================================ */
(function () {
  'use strict';

  if (localStorage.getItem('rp_admin_auth') !== '1') {
    window.location.href = 'index.html';
    return;
  }

  var API = '/api/voyageurs-admin';
  var DOUAI = [3.08, 50.37];
  var MOIS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet',
              'août', 'septembre', 'octobre', 'novembre', 'décembre'];
  var MODE_OPTIONS = [
    ['', '— inchangé —'],
    ['bateau', '⛵ En bateau'],
    ['jonque', '⛵ En jonque (plus lent)'],
    ['pied', '🚶 À pied'],
    ['attelage', '🐎 En voiture à cheval'],
    ['civiere', '🛏 Porté en civière'],
    ['inconnu', '🕊 Inconnu']
  ];
  var MODE_SHORT = { bateau: '⛵ bateau', jonque: '⛵ jonque', pied: '🚶 à pied', attelage: '🐎 attelage', civiere: '🛏 civière', inconnu: '🕊 inconnu' };
  var MODE_LABEL = { bateau: 'en bateau', jonque: 'en jonque', pied: 'à pied', attelage: 'en voiture à cheval', civiere: 'porté en civière', inconnu: 'moyen de transport inconnu' };
  var DEFAULT_MODE = 'bateau'; // valeur prise par js/voyageurs.js quand la 1re étape n'en a pas
  // Zoom automatique de la caméra (MODE_ZOOM de js/voyageurs.js) et bornes du
  // zoom imposé d'une étape (CHECK SQL de 0010_voyageurs_zoom.sql).
  var MODE_ZOOM = { bateau: 3.1, jonque: 7, attelage: 6, pied: 6.2, civiere: 6.8, inconnu: 4 };
  var ZOOM_MIN = 1, ZOOM_MAX = 13;
  var PALETTE = ['#B4213C', '#2A3CD4', '#1B7F5B', '#C26A00', '#6B3FA0', '#0E7C86', '#8E1A30', '#3E3E52'];
  var ID_RE = /^[a-z0-9-]+$/;
  var HISTORY_MAX = 100;

  /* ---------------------------------------------------------- état */
  var DATA = [];          // voyageurs tels que renvoyés par l'API
  var view = null;        // { kind: 'voyageur'|'voyage', originalId, version }
  var draft = null;       // copie modifiable de la fiche ouverte
  var saved = '';         // serialize() au dernier chargement/enregistrement
  var idTouched = false;  // l'identifiant a été saisi à la main : ne plus le proposer
  var saving = false;
  var issuesOpen = false;

  // Éditeur de tracé
  var selected = -1;      // index de l'étape ouverte, -1 = liste
  var tool = 'select';    // 'select' | 'add'
  var undoStack = [];
  var textSnapshotPending = false;
  var map = null, mapReady = false, onMapReady = [];
  var markers = [], dispCoords = [], dragging = false, lineRaf = 0;
  var segPopup = null, projGlobe = false, osmOn = false, fondWarned = false;

  /* ---------------------------------------------------------- utilitaires */
  function $(sel) { return document.querySelector(sel); }
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function clamp(x, a, b) { return Math.max(a, Math.min(b, x)); }
  function nf(n) { return Math.round(n).toLocaleString('fr-FR'); }
  function trim(s) { return String(s == null ? '' : s).trim(); }
  /** Zoom imposé d'une étape : null si vide (automatique), NaN si illisible ou hors bornes. */
  function zoomOf(p) {
    var s = trim(p.zoom).replace(',', '.');
    if (!s) return null;
    var z = Number(s);
    return isFinite(z) && z >= ZOOM_MIN && z <= ZOOM_MAX ? z : NaN;
  }
  function slug(s) {
    return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
      .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '');
  }
  function initials(name) {
    return String(name || '?').split(/\s+/).filter(Boolean).map(function (w) { return w[0]; })
      .slice(0, 2).join('').toUpperCase();
  }
  function isTyping(t) {
    return t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
  }
  function wrapLng(lng) { return ((lng + 180) % 360 + 360) % 360 - 180; }
  function round5(x) { return Math.round(x * 1e5) / 1e5; }

  var toastTimer = 0;
  function toast(msg, isErr, ms) {
    var t = $('#va-toast');
    t.textContent = msg;
    t.className = 'va-toast' + (isErr ? ' va-toast--err' : '');
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, ms || (isErr ? 8000 : 3500));
  }
  function setStatus(ok, text) {
    $('#va-status').classList.toggle('va-status--off', !ok);
    $('#va-status-text').textContent = text;
  }

  /* ---------------------------------------------------------- dates */
  function parseDate(s, approx) {
    var m = /^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?$/.exec(trim(s));
    if (!m) return null;
    var y = +m[1], mo = m[2] ? +m[2] - 1 : 6, d = m[3] ? +m[3] : (m[2] ? 15 : 1);
    if (mo < 0 || mo > 11 || d < 1 || d > 31) return null;
    var t = Date.UTC(y, mo, d);
    if (m[3] && new Date(t).getUTCDate() !== d) return null; // 30 février…
    return { t: t, precision: m[3] ? 'jour' : (m[2] ? 'mois' : 'annee'), approx: !!approx };
  }
  function formatDate(t, precision) {
    var d = new Date(t);
    var y = d.getUTCFullYear(), mo = MOIS[d.getUTCMonth()], day = d.getUTCDate();
    if (precision === 'annee') return String(y);
    if (precision === 'mois') return mo + ' ' + y;
    return (day === 1 ? '1er' : day) + ' ' + mo + ' ' + y;
  }
  /** Saisie à la française (16/04/1618, 04/1618) → format attendu par la base. */
  function normalizeDateInput(s) {
    s = trim(s);
    var m = /^(\d{1,2})[\/.](\d{1,2})[\/.](\d{4})$/.exec(s);
    if (m) return m[3] + '-' + ('0' + m[2]).slice(-2) + '-' + ('0' + m[1]).slice(-2);
    m = /^(\d{1,2})[\/.](\d{4})$/.exec(s);
    if (m) return m[2] + '-' + ('0' + m[1]).slice(-2);
    return s;
  }
  function describeDate(s) {
    if (!trim(s)) return { text: '', bad: false };
    var d = parseDate(s);
    if (!d) return { text: 'Format attendu : AAAA, AAAA-MM ou AAAA-MM-JJ (ex. 1618-04-16).', bad: true };
    return { text: '→ ' + formatDate(d.t, d.precision), bad: false };
  }

  /* ---------------------------------------------------------- géodésie (cf. js/voyageurs.js) */
  var RAD = Math.PI / 180;
  function toVec(c) {
    var lng = c[0] * RAD, lat = c[1] * RAD;
    return [Math.cos(lat) * Math.cos(lng), Math.cos(lat) * Math.sin(lng), Math.sin(lat)];
  }
  function angleBetween(a, b) {
    var va = toVec(a), vb = toVec(b);
    return Math.acos(clamp(va[0] * vb[0] + va[1] * vb[1] + va[2] * vb[2], -1, 1));
  }
  function distKm(a, b) { return angleBetween(a, b) * 6371; }
  function slerp(a, b, f) {
    var d = angleBetween(a, b);
    if (d < 1e-9) return [a[0], a[1]];
    var va = toVec(a), vb = toVec(b);
    var A = Math.sin((1 - f) * d) / Math.sin(d), B = Math.sin(f * d) / Math.sin(d);
    var x = A * va[0] + B * vb[0], y = A * va[1] + B * vb[1], z = A * va[2] + B * vb[2];
    return [Math.atan2(y, x) / RAD, Math.atan2(z, Math.sqrt(x * x + y * y)) / RAD];
  }

  /** Kilométrage cumulé, dates effectives (saisies ou estimées) et moyen de
      transport effectif de chaque étape — même règles que prepareVoyage()
      de js/voyageurs.js. */
  function derive(pts) {
    var n = pts.length, km = [0], out = [];
    for (var i = 1; i < n; i++) km.push(km[i - 1] + distKm(pts[i - 1].coord, pts[i].coord));
    var arrive = [], leave = [], prec = [], est = [], anchors = [];
    pts.forEach(function (p, i) {
      var a = parseDate(p.date);
      if (a) {
        var dep = parseDate(p.depart) || a;
        arrive[i] = a.t; leave[i] = dep.t; prec[i] = a.precision; est[i] = false;
        anchors.push(i);
      }
    });
    for (var k = 0; k < anchors.length - 1; k++) {
      var i0 = anchors[k], i1 = anchors[k + 1], span = km[i1] - km[i0] || 1;
      var p0 = prec[i0] === 'annee' || prec[i1] === 'annee' ? 'annee'
             : (prec[i0] === 'mois' || prec[i1] === 'mois' ? 'mois' : 'jour');
      for (var j = i0 + 1; j < i1; j++) {
        arrive[j] = leave[j] = leave[i0] + (km[j] - km[i0]) / span * (arrive[i1] - leave[i0]);
        prec[j] = p0; est[j] = true;
      }
    }
    if (anchors.length) {
      for (var b = 0; b < anchors[0]; b++) { arrive[b] = leave[b] = arrive[anchors[0]]; prec[b] = prec[anchors[0]]; est[b] = true; }
      var last = anchors[anchors.length - 1];
      for (var e = last + 1; e < n; e++) { arrive[e] = leave[e] = leave[last]; prec[e] = prec[last]; est[e] = true; }
    }
    var mode = pts.length && pts[0].mode ? pts[0].mode : DEFAULT_MODE;
    for (var q = 0; q < n; q++) {
      if (pts[q].mode) mode = pts[q].mode;
      out.push({ km: km[q], t: arrive[q], tLeave: leave[q], prec: prec[q], est: !!est[q], mode: mode });
    }
    return { pts: out, totalKm: n ? km[n - 1] : 0, anchors: anchors };
  }

  /* ---------------------------------------------------------- API */
  function api(method, body) {
    var headers = { 'Content-Type': 'application/json' };
    var token = localStorage.getItem('rp_admin_token');
    if (token) headers.Authorization = 'Basic ' + token;
    return fetch(API, {
      method: method, headers: headers, cache: 'no-store',
      body: body ? JSON.stringify(body) : undefined
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok) {
          var msg = j.error || ('Erreur HTTP ' + r.status);
          if (r.status === 401) msg = 'Session non reconnue par le serveur : déconnectez-vous puis reconnectez-vous depuis la page d\'accueil. (' + msg + ')';
          var err = new Error(msg);
          err.status = r.status;
          throw err;
        }
        return j;
      });
    });
  }

  function findVoyageur(id) {
    for (var i = 0; i < DATA.length; i++) if (DATA[i].id === id) return DATA[i];
    return null;
  }
  function findVoyage(id) {
    for (var i = 0; i < DATA.length; i++) {
      for (var j = 0; j < DATA[i].voyages.length; j++) {
        if (DATA[i].voyages[j].id === id) return { voyageur: DATA[i], voyage: DATA[i].voyages[j] };
      }
    }
    return null;
  }

  /* ---------------------------------------------------------- forme canonique des fiches */
  function canonPoint(p) {
    return {
      lieu: trim(p.lieu), coord: [p.coord[0], p.coord[1]],
      date: trim(p.date), depart: trim(p.depart), approx: !!p.approx, mode: p.mode || '',
      zoom: zoomOf(p) == null ? '' : (isNaN(zoomOf(p)) ? trim(p.zoom) : zoomOf(p)),
      arret: p.arret ? {
        titre: trim(p.arret.titre), texte: trim(p.arret.texte),
        citation: trim(p.arret.citation), source: trim(p.arret.source)
      } : null
    };
  }
  function payloadVoyageur() {
    return {
      id: trim(draft.id), nom: trim(draft.nom), vie: trim(draft.vie), lienDouai: trim(draft.lienDouai),
      portrait: trim(draft.portrait), couleur: draft.couleur, resume: trim(draft.resume), publie: !!draft.publie,
      ecrits: draft.ecrits.map(function (e) {
        return { titre: trim(e.titre), annee: trim(e.annee), cote: trim(e.cote) };
      }).filter(function (e) { return e.titre || e.annee || e.cote; })
    };
  }
  function payloadVoyage() {
    return {
      id: trim(draft.id), voyageurId: draft.voyageurId, titre: trim(draft.titre), sousTitre: trim(draft.sousTitre),
      publie: !!draft.publie,
      sources: String(draft.sourcesText || '').split('\n').map(trim).filter(Boolean),
      points: draft.points.map(canonPoint)
    };
  }
  function serialize() {
    if (!view) return '';
    return JSON.stringify(view.kind === 'voyageur' ? payloadVoyageur() : payloadVoyage());
  }
  function isDirty() { return !!view && serialize() !== saved; }
  function confirmDiscard() {
    return !isDirty() || window.confirm('Des modifications ne sont pas enregistrées. Les abandonner ?');
  }

  function voyageurDraft(vr) {
    return {
      id: vr.id, nom: vr.nom, vie: vr.vie, lienDouai: vr.lienDouai, portrait: vr.portrait,
      couleur: vr.couleur, resume: vr.resume, publie: vr.publie,
      ecrits: vr.ecrits.map(function (e) { return { titre: e.titre, annee: e.annee, cote: e.cote }; })
    };
  }
  function voyageDraft(vy) {
    return {
      id: vy.id, voyageurId: vy.voyageurId, titre: vy.titre, sousTitre: vy.sousTitre, publie: vy.publie,
      sourcesText: vy.sources.join('\n'), points: vy.points.map(canonPoint)
    };
  }

  /* ---------------------------------------------------------- identifiants proposés */
  function uniqueId(base, taken) {
    if (!base) return '';
    var id = base, k = 2;
    while (taken(id)) id = base + '-' + (k++);
    return id;
  }
  function autoId() {
    if (view.kind === 'voyageur') {
      var last = trim(draft.nom).split(/\s+/).pop();
      return uniqueId(slug(last), function (id) { return id !== view.originalId && !!findVoyageur(id); });
    }
    var year = '';
    for (var i = 0; i < draft.points.length && !year; i++) {
      var m = /^\d{4}/.exec(trim(draft.points[i].date));
      if (m) year = m[0];
    }
    var base = slug(draft.voyageurId + '-' + (year || slug(draft.titre).split('-').slice(0, 3).join('-')));
    return uniqueId(base, function (id) { return id !== view.originalId && !!findVoyage(id); });
  }
  function refreshAutoId() {
    if (idTouched) return;
    draft.id = autoId();
    var input = document.querySelector('#' + (view.kind === 'voyageur' ? 'vr-form' : 'vy-form') + ' [data-f="id"]');
    if (input) input.value = draft.id;
  }

  /* ---------------------------------------------------------- validation */
  function validate() {
    var errs = [], warns = [];
    function E(msg, point) { errs.push({ msg: msg, point: point }); }
    function W(msg, point) { warns.push({ msg: msg, point: point }); }
    if (!view) return { errs: errs, warns: warns };

    var id = trim(draft.id);
    if (view.kind === 'voyageur') {
      if (!trim(draft.nom)) E('Le nom est obligatoire.');
      if (!id) E('L\'identifiant est obligatoire.');
      else if (!ID_RE.test(id)) E('Identifiant : minuscules, chiffres et tirets uniquement.');
      else if (id !== view.originalId && findVoyageur(id)) E('L\'identifiant « ' + id + ' » est déjà pris par un autre voyageur.');
      if (!/^#[0-9A-Fa-f]{6}$/.test(draft.couleur || '')) E('Couleur invalide.');
      draft.ecrits.forEach(function (e, i) {
        if (!trim(e.titre) && (trim(e.annee) || trim(e.cote))) E('Écrit n° ' + (i + 1) + ' : le titre est obligatoire.');
      });
      var vr = view.originalId ? findVoyageur(view.originalId) : null;
      if (draft.publie && (!vr || !vr.voyages.some(function (v) { return v.publie && v.points.length >= 2; }))) {
        W('Aucun voyage publié : le voyageur apparaîtra sur l\'exposition sans voyage à suivre.');
      }
      return { errs: errs, warns: warns };
    }

    // Voyage
    if (!trim(draft.titre)) E('Le titre du voyage est obligatoire.');
    if (!id) E('L\'identifiant est obligatoire.');
    else if (!ID_RE.test(id)) E('Identifiant : minuscules, chiffres et tirets uniquement.');
    else if (id !== view.originalId && findVoyage(id)) E('L\'identifiant « ' + id + ' » est déjà pris par un autre voyage.');
    var orig = view.originalId ? findVoyage(view.originalId) : null;
    if (orig && orig.voyage.publie && id !== view.originalId && ID_RE.test(id)) {
      W('Identifiant modifié : les liens déjà diffusés vers voyageurs.html#' + view.originalId + ' ne fonctionneront plus.');
    }

    var pts = draft.points;
    var hasDate = false;
    pts.forEach(function (p, i) {
      var n = 'Étape ' + (i + 1) + (trim(p.lieu) ? ' (' + trim(p.lieu) + ')' : '');
      var dOk = !trim(p.date) || !!parseDate(p.date);
      var depOk = !trim(p.depart) || !!parseDate(p.depart);
      if (!dOk) E(n + ' : date d\'arrivée au mauvais format.', i);
      if (!depOk) E(n + ' : date de départ au mauvais format.', i);
      if (trim(p.date) && dOk) hasDate = true;
      if (trim(p.depart) && !trim(p.date)) E(n + ' : une date de départ demande aussi une date d\'arrivée.', i);
      if (dOk && depOk && trim(p.date) && trim(p.depart) && parseDate(p.depart).t < parseDate(p.date).t) {
        W(n + ' : la date de départ précède la date d\'arrivée.', i);
      }
      if (p.arret && !trim(p.arret.titre)) E(n + ' : un arrêt raconté doit avoir un titre (ou repassez-le en point de passage).', i);
      if (isNaN(zoomOf(p))) E(n + ' : zoom invalide (entre ' + ZOOM_MIN + ' et ' + ZOOM_MAX + ', ou vide pour automatique).', i);
    });
    if (draft.publie && pts.length < 2) E('Pour publier le voyage, il faut au moins deux étapes.');
    if (draft.publie && pts.length && !hasDate) E('Pour publier le voyage, au moins une étape doit être datée.');
    if (!draft.publie && pts.length < 2) W('Au moins deux étapes seront nécessaires pour publier ce voyage.');
    if (!draft.publie && pts.length >= 2 && !hasDate) W('Au moins une étape datée sera nécessaire pour publier ce voyage.');
    if (pts.length && !pts[0].mode) W('Étape 1 : moyen de transport non précisé — « bateau » sera utilisé.', 0);
    if (pts.length >= 2 && !pts.some(function (p) { return p.arret; })) {
      W('Aucun arrêt raconté : la lecture ira d\'un bout à l\'autre sans pause ni récit.');
    }
    // Chronologie des dates saisies
    var prevT = null, prevI = -1;
    pts.forEach(function (p, i) {
      var a = parseDate(p.date);
      if (!a) return;
      if (prevT != null && a.t < prevT) {
        W('Étape ' + (i + 1) + ' : date antérieure à celle de l\'étape ' + (prevI + 1) + '.', i);
      }
      var d = parseDate(p.depart);
      prevT = d ? d.t : a.t; prevI = i;
    });
    if (draft.publie) {
      var owner = findVoyageur(draft.voyageurId);
      if (owner && !owner.publie) W('Le voyageur « ' + owner.nom + ' » n\'est pas publié : ce voyage restera invisible.');
    }
    return { errs: errs, warns: warns };
  }

  /* ---------------------------------------------------------- barre d'enregistrement */
  function updateSaveBar() {
    if (!view) return;
    var dirty = isDirty(), v = validate();
    $('#va-dirty').innerHTML = dirty
      ? '<strong>Modifications non enregistrées.</strong> '
      : (view.originalId ? 'Tout est enregistré. ' : '<strong>Nouvelle fiche, pas encore enregistrée.</strong> ');
    var tog = $('#va-issues-toggle');
    tog.className = 'va-issues-toggle';
    if (v.errs.length) {
      tog.classList.add('has-err');
      tog.textContent = v.errs.length + ' problème' + (v.errs.length > 1 ? 's' : '') + ' à corriger' +
        (v.warns.length ? ' · ' + v.warns.length + ' remarque' + (v.warns.length > 1 ? 's' : '') : '') +
        (issuesOpen ? ' ▴' : ' ▾');
    } else if (v.warns.length) {
      tog.classList.add('has-warn');
      tog.textContent = v.warns.length + ' remarque' + (v.warns.length > 1 ? 's' : '') + (issuesOpen ? ' ▴' : ' ▾');
    } else {
      tog.classList.add('is-ok');
      tog.textContent = '✓ Aucun problème détecté';
    }
    var list = $('#va-issues');
    list.innerHTML = '';
    v.errs.map(function (x) { x.cls = 'va-issue-err'; return x; })
      .concat(v.warns.map(function (x) { x.cls = 'va-issue-warn'; return x; }))
      .forEach(function (it) {
        var li = el('li', it.cls);
        if (it.point != null) {
          var b = el('button', null, it.msg);
          b.type = 'button';
          b.addEventListener('click', function () { selectPoint(it.point, true); $('#va-mapwrap').scrollIntoView({ block: 'center', behavior: 'smooth' }); });
          li.appendChild(b);
        } else {
          li.textContent = it.msg;
        }
        list.appendChild(li);
      });
    list.hidden = !issuesOpen || (!v.errs.length && !v.warns.length);

    $('#va-save').disabled = saving || v.errs.length > 0 || (!dirty && !!view.originalId);
    $('#va-save').textContent = saving ? 'Enregistrement…' : 'Enregistrer';
    $('#va-revert').textContent = view.originalId ? 'Annuler les modifications' : 'Abandonner';
    $('#va-revert').disabled = saving || (!dirty && !!view.originalId);
    var del = $('#va-delete');
    del.hidden = !view.originalId;
    del.textContent = view.kind === 'voyageur' ? 'Supprimer ce voyageur…' : 'Supprimer ce voyage…';
  }
  function changed() { updateSaveBar(); }

  $('#va-issues-toggle').addEventListener('click', function () {
    issuesOpen = !issuesOpen;
    updateSaveBar();
  });

  /* ---------------------------------------------------------- navigation */
  function show(which) {
    $('#va-welcome').hidden = which !== 'welcome';
    $('#va-voyageur').hidden = which !== 'voyageur';
    $('#va-voyage').hidden = which !== 'voyage';
    $('#va-savebar').hidden = which === 'welcome';
  }
  function setHash() {
    var h = view && view.originalId ? '#' + view.kind + '=' + encodeURIComponent(view.originalId) : '';
    window.history.replaceState(null, '', location.pathname + location.search + h);
  }

  function goWelcome() {
    view = null; draft = null; saved = '';
    show('welcome');
    renderTree();
    setHash();
  }

  /* ---------------------------------------------------------- arborescence */
  function badge(text, cls) { return el('span', 'va-badge ' + cls, text); }
  function upDown(i, len, onMove) {
    var box = el('span', 'va-updown');
    [['▲', -1, 'Monter'], ['▼', 1, 'Descendre']].forEach(function (d) {
      var b = el('button', null, d[0]);
      b.type = 'button';
      b.title = d[2];
      b.setAttribute('aria-label', d[2]);
      b.disabled = i + d[1] < 0 || i + d[1] >= len;
      b.addEventListener('click', function (e) { e.stopPropagation(); onMove(d[1]); });
      box.appendChild(b);
    });
    return box;
  }

  function renderTree() {
    var tree = $('#va-tree');
    tree.innerHTML = '';
    DATA.forEach(function (vr, i) {
      var box = el('div', 'va-vr');
      box.style.setProperty('--c', vr.couleur);
      var head = el('div', 'va-vr-head');
      var name = el('button', 'va-vr-name', vr.nom);
      name.type = 'button';
      if (!vr.publie) name.appendChild(badge('brouillon', 'va-badge--draft'));
      if (view && view.kind === 'voyageur' && view.originalId === vr.id) name.classList.add('is-active');
      name.addEventListener('click', function () { openVoyageur(vr.id); });
      head.appendChild(name);
      head.appendChild(upDown(i, DATA.length, function (d) {
        var ids = DATA.map(function (v) { return v.id; });
        ids.splice(i + d, 0, ids.splice(i, 1)[0]);
        reorder('voyageurs', ids);
      }));
      box.appendChild(head);

      var ul = el('ul', 'va-vys');
      vr.voyages.forEach(function (vy, j) {
        var li = el('li', 'va-vy-row');
        var b = el('button', 'va-vy');
        b.type = 'button';
        b.appendChild(document.createTextNode(vy.titre));
        if (!vy.publie) b.appendChild(badge('brouillon', 'va-badge--draft'));
        var arrets = vy.points.filter(function (p) { return p.arret; }).length;
        b.appendChild(el('small', null, vy.points.length + ' étape' + (vy.points.length > 1 ? 's' : '') +
          ' · ' + arrets + ' arrêt' + (arrets > 1 ? 's' : '') + ' raconté' + (arrets > 1 ? 's' : '')));
        if (view && view.kind === 'voyage' && view.originalId === vy.id) b.classList.add('is-active');
        b.addEventListener('click', function () { openVoyage(vy.id); });
        li.appendChild(b);
        li.appendChild(upDown(j, vr.voyages.length, function (d) {
          var ids = vr.voyages.map(function (v) { return v.id; });
          ids.splice(j + d, 0, ids.splice(j, 1)[0]);
          reorder('voyages', ids);
        }));
        ul.appendChild(li);
      });
      if (view && view.kind === 'voyage' && !view.originalId && draft.voyageurId === vr.id) {
        var nli = el('li', 'va-vy-row');
        var nb = el('button', 'va-vy is-active', trim(draft.titre) || 'Nouveau voyage');
        nb.type = 'button';
        nb.appendChild(badge('non enregistré', 'va-badge--new'));
        nli.appendChild(nb);
        ul.appendChild(nli);
      }
      box.appendChild(ul);
      var add = el('button', 'va-add-vy', '+ Nouveau voyage');
      add.type = 'button';
      add.addEventListener('click', function () { openVoyage(null, vr.id); });
      box.appendChild(add);
      tree.appendChild(box);
    });
    if (view && view.kind === 'voyageur' && !view.originalId) {
      var nbox = el('div', 'va-vr');
      nbox.style.setProperty('--c', draft.couleur);
      var nn = el('button', 'va-vr-name is-active', trim(draft.nom) || 'Nouveau voyageur');
      nn.type = 'button';
      nn.appendChild(badge('non enregistré', 'va-badge--new'));
      nbox.appendChild(nn);
      tree.appendChild(nbox);
    }
    if (!DATA.length && !(view && !view.originalId)) {
      tree.appendChild(el('p', 'va-help', 'Aucun voyageur pour l\'instant.'));
    }
  }

  function reorder(kind, ids) {
    api('POST', { action: 'reorder', kind: kind, ids: ids })
      .then(function (j) { DATA = j.voyageurs; renderTree(); toast('Ordre enregistré.'); })
      .catch(function (err) { toast(err.message, true); });
  }

  $('#va-new-voyageur').addEventListener('click', function () { openVoyageur(null); });

  /* ---------------------------------------------------------- champs [data-f] */
  function fillForm(root) {
    root.querySelectorAll('[data-f]').forEach(function (input) {
      var k = input.getAttribute('data-f');
      if (input.type === 'checkbox') input.checked = !!draft[k];
      else input.value = draft[k] == null ? '' : draft[k];
    });
  }
  function onFieldInput(e) {
    var t = e.target, k = t.getAttribute && t.getAttribute('data-f');
    if (!k || !view) return;
    var v = t.type === 'checkbox' ? t.checked : t.value;
    if (k === 'id') {
      idTouched = true;
      var clean = String(v).toLowerCase().replace(/\s+/g, '-');
      if (clean !== v) { var pos = t.selectionStart; t.value = clean; t.setSelectionRange(pos, pos); }
      v = clean;
    }
    draft[k] = v;
    if (k === 'nom' || k === 'titre' || k === 'voyageurId') refreshAutoId();
    if (view.kind === 'voyageur') {
      if (k === 'nom') $('#vr-heading').textContent = trim(draft.nom) || 'Nouveau voyageur';
      if (k === 'nom' || k === 'couleur' || k === 'portrait') updatePortrait();
      if (k === 'nom' || k === 'couleur') renderTree();
    } else {
      if (k === 'titre') { $('#vy-heading').textContent = trim(draft.titre) || 'Nouveau voyage'; if (!view.originalId) renderTree(); }
      if (k === 'voyageurId') { updateVoyageHeader(); renderPath(); renderTree(); }
      if (k === 'id') updateIdHint();
    }
    changed();
  }
  ['input', 'change'].forEach(function (ev) {
    $('#va-voyageur').addEventListener(ev, onFieldInput);
    $('#va-voyage').addEventListener(ev, onFieldInput);
  });

  /* ---------------------------------------------------------- fiche voyageur */
  function openVoyageur(id) {
    if (!confirmDiscard()) return;
    var vr = id ? findVoyageur(id) : null;
    if (id && !vr) { toast('Voyageur introuvable : ' + id, true); return; }
    view = { kind: 'voyageur', originalId: id, version: vr ? vr.version : null };
    draft = vr ? voyageurDraft(vr) : {
      id: '', nom: '', vie: '', lienDouai: '', portrait: '', couleur: nextColor(), resume: '', publie: false,
      ecrits: []
    };
    idTouched = !!id;
    saved = serialize();
    show('voyageur');
    fillVoyageurForm();
    renderTree();
    updateSaveBar();
    setHash();
    if (!id) document.querySelector('#vr-form [data-f="nom"]').focus();
  }

  function nextColor() {
    var used = DATA.map(function (v) { return v.couleur.toUpperCase(); });
    for (var i = 0; i < PALETTE.length; i++) if (used.indexOf(PALETTE[i].toUpperCase()) < 0) return PALETTE[i];
    return PALETTE[DATA.length % PALETTE.length];
  }

  function fillVoyageurForm() {
    $('#vr-heading').textContent = trim(draft.nom) || 'Nouveau voyageur';
    fillForm($('#vr-form'));
    updatePortrait();
    renderEcrits();
    var sw = $('#vr-swatches');
    sw.innerHTML = '';
    PALETTE.forEach(function (c) {
      var b = el('button', 'va-swatch');
      b.type = 'button';
      b.style.background = c;
      b.title = c;
      b.setAttribute('aria-label', 'Couleur ' + c);
      b.addEventListener('click', function () {
        draft.couleur = c;
        document.querySelector('#vr-form [data-f="couleur"]').value = c;
        updatePortrait(); renderTree(); changed();
      });
      sw.appendChild(b);
    });
    var vr = view.originalId ? findVoyageur(view.originalId) : null;
    var list = $('#vr-voyages');
    list.innerHTML = '';
    (vr ? vr.voyages : []).forEach(function (vy) {
      var li = el('li');
      var b = el('button', 'va-btn', vy.titre);
      b.type = 'button';
      if (!vy.publie) b.appendChild(badge('brouillon', 'va-badge--draft'));
      b.addEventListener('click', function () { openVoyage(vy.id); });
      li.appendChild(b);
      list.appendChild(li);
    });
    $('#vr-voyages-hint').hidden = !!vr;
    $('#vr-add-voyage').hidden = !vr;
  }

  var portraitCheck = 0;
  function updatePortrait() {
    var box = $('#vr-portrait-prev');
    box.style.setProperty('--c', draft.couleur);
    box.style.backgroundImage = '';
    box.textContent = initials(draft.nom);
    var hint = box.parentNode.parentNode.querySelector('small');
    hint.className = '';
    hint.textContent = 'Chemin de l\'image depuis la racine du site. Sans image, les initiales sont affichées.';
    var path = trim(draft.portrait);
    if (!path) return;
    var token = ++portraitCheck;
    var img = new Image();
    img.onload = function () {
      if (token !== portraitCheck) return;
      box.textContent = '';
      box.style.backgroundImage = 'url("' + encodeURI(path).replace(/"/g, '%22') + '")';
    };
    img.onerror = function () {
      if (token !== portraitCheck) return;
      hint.className = 'va-hint-bad';
      hint.textContent = 'Image introuvable à cette adresse (vérifiez le nom exact du fichier, accents et majuscules compris).';
    };
    img.src = encodeURI(path);
  }

  function renderEcrits() {
    var box = $('#vr-ecrits');
    box.innerHTML = '';
    draft.ecrits.forEach(function (e, i) {
      var row = el('div', 'va-ecrit');
      [['titre', 'Titre de l\'ouvrage, de la lettre…'], ['annee', 'Ex. 1615'], ['cote', 'Cote']].forEach(function (f) {
        var input = el('input');
        input.type = 'text';
        input.value = e[f[0]] || '';
        input.placeholder = f[1];
        input.setAttribute('aria-label', f[0] + ' de l\'écrit ' + (i + 1));
        input.addEventListener('input', function () { draft.ecrits[i][f[0]] = input.value; changed(); });
        row.appendChild(input);
      });
      var del = el('button', 'va-btn va-btn--small va-btn--danger', '✕');
      del.type = 'button';
      del.title = 'Retirer cet écrit';
      del.addEventListener('click', function () { draft.ecrits.splice(i, 1); renderEcrits(); changed(); });
      row.appendChild(del);
      box.appendChild(row);
    });
  }
  $('#vr-add-ecrit').addEventListener('click', function () {
    draft.ecrits.push({ titre: '', annee: '', cote: '' });
    renderEcrits();
    var inputs = $('#vr-ecrits').querySelectorAll('.va-ecrit input');
    if (inputs.length) inputs[inputs.length - 3].focus();
    changed();
  });
  $('#vr-add-voyage').addEventListener('click', function () {
    if (view && view.originalId) openVoyage(null, view.originalId);
  });

  /* ---------------------------------------------------------- fiche voyage */
  function openVoyage(id, voyageurId) {
    if (!confirmDiscard()) return;
    var found = id ? findVoyage(id) : null;
    if (id && !found) { toast('Voyage introuvable : ' + id, true); return; }
    view = { kind: 'voyage', originalId: id, version: found ? found.voyage.version : null };
    draft = found ? voyageDraft(found.voyage) : {
      id: '', voyageurId: voyageurId, titre: '', sousTitre: '', publie: false, sourcesText: '', points: []
    };
    idTouched = !!id;
    if (!id) draft.id = autoId();
    saved = serialize();
    undoStack = [];
    $('#va-undo').disabled = true;
    selected = -1;
    show('voyage');
    fillVoyageurSelect();
    fillForm($('#va-voyage'));
    updateVoyageHeader();
    updateIdHint();
    renderSteps();
    setTool(found ? 'select' : 'add');
    ensureMap(function () { renderPath(); fitVoyage(false); });
    renderTree();
    updateSaveBar();
    setHash();
    if (!id) document.querySelector('#vy-form [data-f="titre"]').focus();
  }

  function fillVoyageurSelect() {
    var sel = $('#vy-voyageur-select');
    sel.innerHTML = '';
    DATA.forEach(function (vr) {
      var o = el('option', null, vr.nom);
      o.value = vr.id;
      sel.appendChild(o);
    });
  }
  function voyageurColor() {
    var vr = findVoyageur(draft.voyageurId);
    return vr ? vr.couleur : '#B4213C';
  }
  function updateVoyageHeader() {
    var vr = findVoyageur(draft.voyageurId);
    $('#vy-eyebrow').textContent = 'Voyage de ' + (vr ? vr.nom : '—');
    $('#vy-heading').textContent = trim(draft.titre) || 'Nouveau voyage';
    var found = view.originalId ? findVoyage(view.originalId) : null;
    var link = $('#vy-public-link');
    var visible = found && found.voyage.publie && found.voyageur.publie && found.voyage.points.length >= 2;
    link.hidden = !visible;
    if (visible) link.href = 'voyageurs.html#' + encodeURIComponent(found.voyage.id);
  }
  function updateIdHint() {
    $('#vy-id-hint').textContent = 'Adresse directe du voyage : voyageurs.html#' + (trim(draft.id) || '…');
  }

  $('#vy-suggest-sub').addEventListener('click', function () {
    var pts = draft.points;
    if (pts.length < 2) { toast('Placez d\'abord au moins deux étapes.', true); return; }
    var named = pts.map(function (p, i) { return { lieu: trim(p.lieu), i: i, arret: !!p.arret }; })
      .filter(function (x) { return x.lieu && (x.arret || x.i === 0 || x.i === pts.length - 1); });
    var names = [];
    if (named.length) {
      names.push(named[0].lieu);
      var middle = named.slice(1, -1);
      var step = Math.max(1, Math.ceil(middle.length / 2));
      for (var k = 0; k < middle.length && names.length < 3; k += step) names.push(middle[k].lieu);
      if (named.length > 1) names.push(named[named.length - 1].lieu);
    }
    var years = pts.map(function (p) { return (/^\d{4}/.exec(trim(p.date)) || [])[0]; }).filter(Boolean);
    var span = years.length ? (years[0] === years[years.length - 1] ? years[0] : years[0] + '-' + years[years.length - 1]) : '';
    var sub = names.filter(function (n, i) { return names.indexOf(n) === i; }).join(' → ') + (span ? ', ' + span : '');
    if (!trim(sub)) { toast('Donnez un nom aux étapes de départ et d\'arrivée pour obtenir une proposition.', true); return; }
    draft.sousTitre = sub;
    document.querySelector('#vy-form [data-f="sousTitre"]').value = sub;
    changed();
  });

  /* ---------------------------------------------------------- historique (annuler) */
  function pushHistory() {
    undoStack.push({ points: JSON.stringify(draft.points), selected: selected });
    if (undoStack.length > HISTORY_MAX) undoStack.shift();
    $('#va-undo').disabled = false;
  }
  function undo() {
    var h = undoStack.pop();
    if (!h) return;
    draft.points = JSON.parse(h.points);
    selected = h.selected < draft.points.length ? h.selected : -1;
    $('#va-undo').disabled = !undoStack.length;
    renderAll();
    changed();
  }
  $('#va-undo').addEventListener('click', undo);

  /* ---------------------------------------------------------- opérations sur les étapes */
  function newPoint(lngLat, lieu) {
    return {
      lieu: lieu || '', coord: [round5(wrapLng(lngLat[0])), round5(clamp(lngLat[1], -90, 90))],
      date: '', depart: '', approx: false, mode: '', zoom: '', arret: null
    };
  }
  function insertPoint(at, lngLat, lieu) {
    pushHistory();
    var p = newPoint(lngLat, lieu);
    // La toute première étape d'un voyage : proposer un moyen de transport
    // explicite plutôt que de laisser le défaut implicite.
    if (!draft.points.length) p.mode = DEFAULT_MODE;
    draft.points.splice(at, 0, p);
    selected = at;
    renderAll();
    changed();
  }
  function addPointAfterSelection(lngLat, lieu) {
    insertPoint(selected >= 0 ? selected + 1 : draft.points.length, lngLat, lieu);
  }
  function deletePoint(i) {
    pushHistory();
    draft.points.splice(i, 1);
    selected = -1;
    renderAll();
    changed();
  }
  /* Retour par le même chemin : recopie, juste après l'étape i, les points
     i-1 … k en sens inverse. Le tracé de retour passe par exactement les
     mêmes coordonnées que l'aller, donc se superpose à lui sur la carte au
     lieu d'en être une copie approximative redessinée à la main.
     Moyens de transport : `mode` vaut pour le tronçon qui PART d'un point.
     Le tronçon copie(j) → copie(j-1) rejoue à l'envers l'aller j-1 → j, il
     prend donc le mode effectif de j-1 ; le premier tronçon du retour part
     de i lui-même. Si d'autres étapes suivaient i, la dernière copie reprend
     le mode qui partait de i, pour que la suite du voyage ne change pas. */
  function returnOptions(i) {
    var out = '';
    for (var j = i - 1; j >= 0; j--) {
      var p = draft.points[j];
      var label = trim(p.lieu) || (p.arret ? trim(p.arret.titre) || 'Arrêt sans titre' : 'Point de passage');
      out += '<option value="' + j + '">Étape ' + (j + 1) + ' — ' + esc(label) + '</option>';
    }
    return out;
  }
  function addReturnPath(i, k) {
    var pts = draft.points;
    if (!(k >= 0 && k < i && i < pts.length)) return;
    pushHistory();
    var eff = derive(pts).pts.map(function (dp) { return dp.mode; });
    var contMode = i < pts.length - 1 ? eff[i] : '';
    pts[i].mode = eff[i - 1];
    var copies = [];
    for (var j = i - 1; j >= k; j--) {
      var src = pts[j];
      copies.push({
        lieu: src.lieu || '', coord: [src.coord[0], src.coord[1]],
        date: '', depart: '', approx: false,
        mode: j > k ? eff[j - 1] : contMode,
        zoom: src.zoom == null ? '' : src.zoom, arret: null
      });
    }
    Array.prototype.splice.apply(pts, [i + 1, 0].concat(copies));
    selected = i + copies.length;
    renderAll();
    changed();
    toast(copies.length + ' point(s) de retour ajouté(s), jusqu\'à l\'étape ' + (selected + 1) + '. ' +
      'Datez cette dernière si la date de retour est connue ; Ctrl+Z pour annuler.', false, 7000);
  }

  function movePoint(i, d) {
    var j = i + d;
    if (j < 0 || j >= draft.points.length) return;
    pushHistory();
    draft.points.splice(j, 0, draft.points.splice(i, 1)[0]);
    selected = j;
    renderAll();
    changed();
  }
  function selectPoint(i, fly) {
    selected = i;
    markers.forEach(function (m, k) { m.getElement().classList.toggle('is-sel', k === i); });
    renderSteps();
    updateHint();
    if (fly && i >= 0 && map && dispCoords[i]) {
      var b = map.getBounds();
      if (!b.contains(dispCoords[i])) map.easeTo({ center: dispCoords[i], duration: 600 });
    }
  }

  /* ---------------------------------------------------------- carte */
  var THEME = { eauClaire: '#FFFFFF', eauProfonde: '#2A3CD4', terre: '#FFCAD7' };
  var PROFONDEURS = [
    [0, 0.05], [200, 0.10], [1000, 0.17], [2000, 0.23], [3000, 0.29], [4000, 0.35],
    [5000, 0.41], [6000, 0.47], [7000, 0.53], [8000, 0.58], [9000, 0.62]
  ];
  function mixHex(a, b, t) {
    var pa = parseInt(a.slice(1), 16), pb = parseInt(b.slice(1), 16), out = '#';
    [16, 8, 0].forEach(function (sh) {
      var ca = (pa >> sh) & 255, cb = (pb >> sh) & 255;
      out += ('0' + Math.round(ca + (cb - ca) * t).toString(16)).slice(-2);
    });
    return out;
  }
  function eau(t) { return mixHex(THEME.eauClaire, THEME.eauProfonde, t); }

  function ensureMap(cb) {
    if (map) {
      map.resize();
      if (mapReady) cb(); else onMapReady.push(cb);
      return;
    }
    onMapReady.push(cb);
    var couleurProfondeur = ['match', ['get', 'depth']];
    PROFONDEURS.slice(1).forEach(function (p) { couleurProfondeur.push(p[0], eau(p[1])); });
    couleurProfondeur.push(eau(PROFONDEURS[PROFONDEURS.length - 1][1]));
    // Même archive que la page publique (voir FOND_CARTE_URL dans js/voyageurs.js).
    var fondUrl = new URL('data/natural-earth/fond.pmtiles', location.href).href;
    maplibregl.addProtocol('pmtiles', new pmtiles.Protocol().tile);

    map = new maplibregl.Map({
      container: 'va-map',
      style: {
        version: 8,
        projection: { type: 'mercator' },
        sources: {
          fond: { type: 'vector', url: 'pmtiles://' + fondUrl,
            attribution: '<a href="https://www.naturalearthdata.com">Natural Earth</a>' },
          // Fond détaillé facultatif (bouton « Fond détaillé ») : villes, ports
          // et routes pour placer une étape précisément. Jamais sur la page
          // publique.
          osm: { type: 'raster', tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'], tileSize: 256,
            maxzoom: 19, attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>' }
        },
        layers: [
          { id: 'eau', type: 'background', paint: { 'background-color': eau(PROFONDEURS[0][1]) } },
          { id: 'bathymetrie', type: 'fill', source: 'fond', 'source-layer': 'bathymetrie',
            paint: { 'fill-color': couleurProfondeur, 'fill-antialias': false } },
          { id: 'terres', type: 'fill', source: 'fond', 'source-layer': 'terres',
            paint: { 'fill-color': THEME.terre } },
          { id: 'lacs', type: 'fill', source: 'fond', 'source-layer': 'lacs', paint: { 'fill-color': eau(0.17) } },
          { id: 'fleuves', type: 'line', source: 'fond', 'source-layer': 'fleuves',
            paint: { 'line-color': eau(0.35), 'line-width': ['interpolate', ['linear'], ['zoom'], 1, 0.4, 4, 1, 8, 2.2] } },
          { id: 'osm', type: 'raster', source: 'osm', layout: { visibility: 'none' }, paint: { 'raster-opacity': 0.9 } }
        ]
      },
      center: DOUAI,
      zoom: 2,
      maxZoom: 13,
      attributionControl: false
    });
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
    map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-right');
    map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-right');

    map.on('error', function (e) {
      var msg = (e && e.error && e.error.message) || '';
      if (fondWarned || !(e.sourceId === 'fond' || /pmtiles|fond/i.test(msg))) return;
      fondWarned = true;
      var w = $('#va-mapwarn');
      w.innerHTML = 'Fond de carte introuvable (<code>data/natural-earth/fond.pmtiles</code>). ' +
        'Lancez <code>npm run build:natural-earth</code> sur le poste serveur, ou utilisez le bouton ' +
        '<strong>🗺 Fond détaillé</strong> en attendant.';
      w.hidden = false;
    });

    map.once('style.load', function () {
      map.addSource('va-path', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      map.addLayer({ id: 'va-path-casing', type: 'line', source: 'va-path',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#F7F5F0', 'line-width': 7, 'line-opacity': 0.9 } });
      map.addLayer({ id: 'va-path-line', type: 'line', source: 'va-path',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#B4213C', 'line-width': 3.2 } });
      map.addLayer({ id: 'va-path-hit', type: 'line', source: 'va-path',
        paint: { 'line-color': '#000', 'line-width': 18, 'line-opacity': 0.001 } });

      segPopup = new maplibregl.Popup({ closeButton: false, closeOnClick: false, className: 'va-popup', offset: 12 });
      map.on('mousemove', 'va-path-hit', function (e) {
        if (dragging || !e.features || !e.features.length) return;
        var pr = e.features[0].properties;
        map.getCanvas().style.cursor = tool === 'add' ? 'copy' : '';
        segPopup.setLngLat(e.lngLat).setHTML(
          'Tronçon <strong>' + (pr.seg + 1) + ' → ' + (pr.seg + 2) + '</strong> · ' + esc(MODE_LABEL[pr.mode] || pr.mode) +
          ' · ' + nf(pr.km) + ' km' +
          (tool === 'add' ? '<br><em>Cliquez pour insérer une étape ici</em>' : '')
        ).addTo(map);
      });
      map.on('mouseleave', 'va-path-hit', function () {
        map.getCanvas().style.cursor = '';
        segPopup.remove();
      });

      map.on('click', function (e) {
        if (!view || view.kind !== 'voyage') return;
        if (tool !== 'add') {
          if (selected >= 0) selectPoint(-1);
          return;
        }
        var hit = map.queryRenderedFeatures(e.point, { layers: ['va-path-hit'] });
        if (hit.length) insertPoint(hit[0].properties.seg + 1, [e.lngLat.lng, e.lngLat.lat]);
        else addPointAfterSelection([e.lngLat.lng, e.lngLat.lat]);
      });

      mapReady = true;
      var q = onMapReady; onMapReady = [];
      q.forEach(function (f) { f(); });
    });
  }

  /** Segments densifiés (grand cercle) avec longitudes « déroulées » pour
      qu'un tracé qui franchit l'antiméridien ne traverse pas toute la carte
      plane. dispCoords = position affichée de chaque étape. */
  function buildPath() {
    var pts = draft.points, feats = [], disp = [];
    if (!pts.length) return { feats: feats, disp: disp };
    var prevLng = pts[0].coord[0];
    disp.push([prevLng, pts[0].coord[1]]);
    var d = derive(pts);
    for (var i = 0; i < pts.length - 1; i++) {
      var a = pts[i].coord, b = pts[i + 1].coord, km = distKm(a, b);
      var steps = Math.max(1, Math.ceil(km / 60));
      var coords = [disp[i].slice()];
      for (var s = 1; s <= steps; s++) {
        var c = slerp(a, b, s / steps), lng = c[0];
        while (lng - prevLng > 180) lng -= 360;
        while (lng - prevLng < -180) lng += 360;
        prevLng = lng;
        coords.push([lng, c[1]]);
      }
      disp.push(coords[coords.length - 1]);
      feats.push({ type: 'Feature', properties: { seg: i, mode: d.pts[i].mode, km: km },
                   geometry: { type: 'LineString', coordinates: coords } });
    }
    return { feats: feats, disp: disp };
  }

  function renderPathLine() {
    if (!mapReady) return;
    var built = buildPath();
    dispCoords = built.disp;
    map.getSource('va-path').setData({ type: 'FeatureCollection', features: built.feats });
    map.setPaintProperty('va-path-line', 'line-color', voyageurColor());
  }
  function scheduleLine() {
    if (lineRaf) return;
    lineRaf = requestAnimationFrame(function () { lineRaf = 0; renderPathLine(); renderStats(); });
  }

  function renderMarkers() {
    if (!mapReady) return;
    markers.forEach(function (m) { m.remove(); });
    markers = [];
    var col = voyageurColor(), n = draft.points.length;
    draft.points.forEach(function (p, i) {
      var e = el('div', 'va-pt' + (p.arret ? ' va-pt--arret' : '') + (i === selected ? ' is-sel' : ''));
      e.style.setProperty('--c', col);
      e.appendChild(el('span', null, String(i + 1)));
      if (i === 0) e.appendChild(el('b', 'va-pt-flag', 'Départ'));
      else if (i === n - 1) e.appendChild(el('b', 'va-pt-flag', 'Arrivée'));
      e.title = 'Étape ' + (i + 1) + (trim(p.lieu) ? ' — ' + trim(p.lieu) : '') +
        (p.arret ? ' (arrêt raconté)' : ' (point de passage)') + ' — glisser pour déplacer';
      var m = new maplibregl.Marker({ element: e, draggable: true }).setLngLat(dispCoords[i]).addTo(map);
      e.addEventListener('click', function (ev) { ev.stopPropagation(); selectPoint(i); });
      m.on('dragstart', function () { pushHistory(); dragging = true; segPopup && segPopup.remove(); });
      m.on('drag', function () {
        var ll = m.getLngLat();
        draft.points[i].coord = [round5(wrapLng(ll.lng)), round5(ll.lat)];
        scheduleLine();
      });
      m.on('dragend', function () {
        dragging = false;
        selected = i;
        // Hors de l'événement : renderAll() recrée les marqueurs, dont celui-ci.
        setTimeout(function () { renderAll(); changed(); }, 0);
      });
      markers.push(m);
    });
  }

  function renderPath() {
    renderPathLine();
    renderMarkers();
    renderStats();
  }
  function renderAll() {
    renderPath();
    renderSteps();
    updateHint();
  }

  function renderStats() {
    var pts = draft.points, box = $('#va-mapstats');
    if (!pts.length) { box.textContent = ''; return; }
    var d = derive(pts);
    var arrets = pts.filter(function (p) { return p.arret; }).length;
    var txt = pts.length + ' étape' + (pts.length > 1 ? 's' : '') + ' · ' + arrets + ' arrêt' + (arrets > 1 ? 's' : '') +
      ' raconté' + (arrets > 1 ? 's' : '') + ' · ' + nf(d.totalKm) + ' km';
    if (d.anchors.length) {
      var a = d.pts[0], z = d.pts[pts.length - 1];
      txt += ' · ' + formatDate(a.t, a.prec) + ' → ' + formatDate(z.tLeave, z.prec);
      if (a.prec === 'jour' && z.prec === 'jour' && !a.est && !z.est) {
        txt += ' (' + nf(Math.floor((z.tLeave - a.t) / 86400000) + 1) + ' jours)';
      }
    }
    box.textContent = txt;
  }

  function fitVoyage(animate) {
    if (!mapReady) return;
    var c = dispCoords;
    if (!c.length) { map.jumpTo({ center: DOUAI, zoom: 3 }); return; }
    if (c.length === 1) { map.easeTo({ center: c[0], zoom: 5, duration: animate ? 600 : 0 }); return; }
    var b = new maplibregl.LngLatBounds(c[0], c[0]);
    c.forEach(function (x) { b.extend(x); });
    map.fitBounds(b, { padding: { top: 80, bottom: 60, left: 50, right: 50 }, maxZoom: 7, duration: animate ? 700 : 0 });
  }

  /* ---------------------------------------------------------- outils de la carte */
  function setTool(t) {
    tool = t;
    $('#va-tool-select').setAttribute('aria-pressed', String(t === 'select'));
    $('#va-tool-add').setAttribute('aria-pressed', String(t === 'add'));
    $('#va-mapwrap').classList.toggle('is-adding', t === 'add');
    updateHint();
  }
  function updateHint() {
    var h = $('#va-maphint');
    if (!view || view.kind !== 'voyage' || tool !== 'add') { h.hidden = true; return; }
    var n = draft.points.length, where;
    if (!n) {
      where = 'Cliquez sur la carte à l\'endroit du <b>départ</b> du voyage (ou cherchez un lieu en haut).';
    } else {
      var target = selected >= 0 && selected < n - 1
        ? 'après l\'étape ' + (selected + 1) + (trim(draft.points[selected].lieu) ? ' (' + esc(trim(draft.points[selected].lieu)) + ')' : '')
        : 'à la fin du voyage';
      where = 'Cliquez sur la carte : l\'étape sera ajoutée <b>' + target + '</b>. Cliquez sur le trait pour insérer entre deux étapes.';
    }
    h.innerHTML = where + ' <kbd>Échap</kbd> pour terminer.';
    h.hidden = false;
  }
  $('#va-tool-select').addEventListener('click', function () { setTool('select'); });
  $('#va-tool-add').addEventListener('click', function () { setTool('add'); });
  $('#va-fit').addEventListener('click', function () { fitVoyage(true); });
  $('#va-proj').addEventListener('click', function () {
    projGlobe = !projGlobe;
    this.setAttribute('aria-pressed', String(projGlobe));
    if (map) map.setProjection({ type: projGlobe ? 'globe' : 'mercator' });
  });
  $('#va-osm').addEventListener('click', function () {
    osmOn = !osmOn;
    this.setAttribute('aria-pressed', String(osmOn));
    if (mapReady) map.setLayoutProperty('osm', 'visibility', osmOn ? 'visible' : 'none');
  });

  document.addEventListener('keydown', function (e) {
    if (!view || view.kind !== 'voyage') return;
    var typing = isTyping(e.target);
    if (e.key === 'Escape') {
      if (e.target === $('#va-search')) { $('#va-search-results').hidden = true; return; }
      if (typing) return;
      if (tool === 'add') setTool('select');
      else if (selected >= 0) selectPoint(-1);
    } else if (e.key === 'Delete' && !typing && selected >= 0) {
      e.preventDefault();
      deletePoint(selected);
    } else if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'z' && !typing) {
      e.preventDefault();
      undo();
    }
  });

  /* ---------------------------------------------------------- recherche de lieux
     Nominatim (OpenStreetMap), à la demande seulement (touche Entrée) : sa
     politique d'usage interdit l'autocomplétion à chaque frappe. */
  function geocode(q) {
    var url = 'https://nominatim.openstreetmap.org/search?format=jsonv2&limit=6&accept-language=fr&q=' + encodeURIComponent(q);
    return fetch(url).then(function (r) {
      if (!r.ok) throw new Error('Service de recherche indisponible (HTTP ' + r.status + ').');
      return r.json();
    });
  }
  function shortName(res) { return res.name || String(res.display_name || '').split(',')[0]; }

  $('#va-search').addEventListener('keydown', function (e) {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    var q = trim(this.value);
    var box = $('#va-search-results');
    if (!q) { box.hidden = true; return; }
    box.innerHTML = '<div class="va-search-empty">Recherche…</div>';
    box.hidden = false;
    geocode(q).then(function (list) {
      box.innerHTML = '';
      if (!list.length) { box.innerHTML = '<div class="va-search-empty">Aucun lieu trouvé.</div>'; return; }
      list.forEach(function (res) {
        var ll = [+res.lon, +res.lat];
        var item = el('div', 'va-search-item');
        item.appendChild(el('strong', null, shortName(res)));
        item.appendChild(el('span', null, res.display_name));
        var row = el('div', 'va-inline');
        var see = el('button', 'va-btn va-btn--small', 'Voir');
        see.type = 'button';
        see.addEventListener('click', function () { map.flyTo({ center: ll, zoom: Math.max(map.getZoom(), 5) }); });
        var add = el('button', 'va-btn va-btn--small va-btn--primary', '+ Ajouter comme étape');
        add.type = 'button';
        add.addEventListener('click', function () {
          addPointAfterSelection(ll, shortName(res));
          box.hidden = true;
          map.easeTo({ center: dispCoords[selected] || ll, duration: 600 });
        });
        row.appendChild(see); row.appendChild(add);
        item.appendChild(row);
        box.appendChild(item);
      });
    }).catch(function (err) {
      box.innerHTML = '<div class="va-search-empty">' + esc(err.message) + '</div>';
    });
  });
  document.addEventListener('click', function (e) {
    if (!e.target.closest || !e.target.closest('.va-search')) $('#va-search-results').hidden = true;
  });

  /* ---------------------------------------------------------- colonne des étapes */
  function renderSteps() {
    var box = $('#va-steps');
    if (!draft || view.kind !== 'voyage') return;
    if (selected >= 0 && selected < draft.points.length) renderPointForm(box);
    else renderStepList(box);
  }

  function renderStepList(box) {
    var pts = draft.points, col = voyageurColor();
    box.innerHTML = '';
    box.style.setProperty('--c', col);
    var head = el('div', 'va-steps-head');
    var arrets = pts.filter(function (p) { return p.arret; }).length;
    head.appendChild(el('strong', null, 'Étapes (' + pts.length + ')'));
    head.appendChild(el('span', 'va-step-date', arrets + ' arrêt' + (arrets > 1 ? 's' : '') + ' raconté' + (arrets > 1 ? 's' : '')));
    box.appendChild(head);
    if (!pts.length) {
      box.appendChild(el('p', 'va-empty',
        'Aucune étape pour l\'instant. Passez en mode « ✚ Ajouter des étapes » et cliquez sur la carte à l\'endroit ' +
        'du départ, ou cherchez un lieu dans le champ de recherche de la carte.'));
      return;
    }
    box.appendChild(el('p', 'va-steps-legend',
      '● plein = arrêt raconté (pause et récit) · ○ = point de passage. Cliquez une étape pour la compléter.'));
    var d = derive(pts);
    var ol = el('ol', 'va-steps-list');
    pts.forEach(function (p, i) {
      var li = el('li');
      var b = el('button', 'va-step' + (p.arret ? '' : ' va-step--passage'));
      b.type = 'button';
      b.appendChild(el('span', 'va-step-num', String(i + 1)));
      var main = el('span', 'va-step-main');
      var label = trim(p.lieu) || (p.arret ? (trim(p.arret.titre) || 'Arrêt sans titre') : 'Point de passage');
      main.appendChild(el('span', 'va-step-name', label));
      var dt = derive_label(p, d.pts[i]);
      if (dt.text) main.appendChild(el('span', 'va-step-date' + (dt.est ? ' is-est' : ''), dt.text));
      b.appendChild(main);
      var right = el('span', 'va-step-mode');
      if (hasPointError(p)) right.appendChild(el('span', 'va-step-err', '⚠ '));
      if (p.mode && i < pts.length - 1) right.appendChild(document.createTextNode(MODE_SHORT[p.mode] || p.mode));
      var zi = zoomOf(p);
      if (zi != null && !isNaN(zi)) right.appendChild(el('span', 'va-step-zoom', ' 🔍 ' + zi));
      b.appendChild(right);
      b.addEventListener('click', function () { selectPoint(i, true); });
      li.appendChild(b);
      ol.appendChild(li);
    });
    box.appendChild(ol);
  }
  function derive_label(p, dp) {
    var a = parseDate(p.date);
    if (a) {
      var dep = parseDate(p.depart);
      var s = (p.approx ? '≈ ' : '') + formatDate(a.t, a.precision);
      if (dep) s += ' → ' + formatDate(dep.t, dep.precision);
      return { text: s, est: false };
    }
    if (trim(p.date)) return { text: 'date invalide', est: false };
    if (dp && dp.t != null) return { text: '≈ ' + formatDate(dp.t, dp.prec) + ' (estimée)', est: true };
    return { text: '', est: false };
  }
  function hasPointError(p) {
    return (trim(p.date) && !parseDate(p.date)) || (trim(p.depart) && !parseDate(p.depart)) ||
      (trim(p.depart) && !trim(p.date)) || (p.arret && !trim(p.arret.titre)) || isNaN(zoomOf(p));
  }

  function modeOptions(current) {
    return MODE_OPTIONS.map(function (o) {
      return '<option value="' + o[0] + '"' + (o[0] === (current || '') ? ' selected' : '') + '>' + esc(o[1]) + '</option>';
    }).join('');
  }

  function renderPointForm(box) {
    var i = selected, p = draft.points[i], n = draft.points.length, isLast = i === n - 1;
    box.style.setProperty('--c', voyageurColor());
    box.innerHTML =
      '<div class="va-steps-head">' +
        '<button type="button" class="va-btn va-btn--small" data-act="list">← Toutes les étapes</button>' +
        '<span class="va-inline">' +
          '<button type="button" class="va-btn va-btn--small" data-act="prev" title="Étape précédente"' + (i === 0 ? ' disabled' : '') + '>‹</button>' +
          '<strong>' + (i + 1) + ' / ' + n + '</strong>' +
          '<button type="button" class="va-btn va-btn--small" data-act="next" title="Étape suivante"' + (isLast ? ' disabled' : '') + '>›</button>' +
        '</span>' +
      '</div>' +
      '<div class="va-pform">' +
        '<div class="va-pform-title" id="va-pf-title"></div>' +
        '<div class="va-kind" role="radiogroup" aria-label="Type d\'étape">' +
          '<label><input type="radio" name="va-kind" value="passage"' + (p.arret ? '' : ' checked') + '>' +
            '<span><strong>Point de passage</strong>Guide le tracé, sans pause.</span></label>' +
          '<label><input type="radio" name="va-kind" value="arret"' + (p.arret ? ' checked' : '') + '>' +
            '<span><strong>Arrêt raconté</strong>La lecture s\'arrête et affiche un récit.</span></label>' +
        '</div>' +
        '<label class="va-field"><span>Nom du lieu</span>' +
          '<span class="va-inline"><input type="text" data-p="lieu" placeholder="Ex. Cap de Bonne-Espérance">' +
          '<button type="button" class="va-btn va-btn--small" data-act="geocode" title="Chercher ce nom et y placer le point">📍 Placer</button></span>' +
          '<small>Facultatif pour un point de passage. « 📍 Placer » cherche le lieu et y déplace le point.</small></label>' +
        '<div class="va-grid">' +
          '<label class="va-field"><span>Longitude</span><input type="number" step="0.01" min="-180" max="180" data-p="lng"></label>' +
          '<label class="va-field"><span>Latitude</span><input type="number" step="0.01" min="-90" max="90" data-p="lat"></label>' +
        '</div>' +
        '<fieldset><legend>Dates</legend>' +
          '<label class="va-field"><span>Arrivée</span><input type="text" data-p="date" placeholder="AAAA-MM-JJ, AAAA-MM ou AAAA" spellcheck="false">' +
            '<small id="va-pf-date-hint"></small></label>' +
          '<label class="va-field"><span>Départ <small>(seulement si le voyageur séjourne sur place)</small></span>' +
            '<input type="text" data-p="depart" placeholder="Laisser vide s\'il repart aussitôt" spellcheck="false">' +
            '<small id="va-pf-depart-hint"></small></label>' +
          '<label class="va-check"><input type="checkbox" data-p="approx"><span>Date approximative' +
            '<small>Affichée précédée de « ≈ » sur l\'exposition.</small></span></label>' +
        '</fieldset>' +
        '<fieldset><legend>Moyen de transport</legend>' +
          '<label class="va-field"><span>À partir de cette étape</span>' +
            '<select data-p="mode"' + (isLast ? ' disabled' : '') + '>' + modeOptions(p.mode) + '</select>' +
            '<small id="va-pf-mode-hint"></small></label>' +
        '</fieldset>' +
        '<fieldset><legend>Caméra</legend>' +
          '<label class="va-field"><span>Zoom à cette étape</span>' +
            '<span class="va-inline"><input type="number" step="0.5" min="' + ZOOM_MIN + '" max="' + ZOOM_MAX + '" data-p="zoom" placeholder="Automatique">' +
            '<button type="button" class="va-btn va-btn--small" data-act="zoom-take" title="Reprendre le zoom actuel de la carte">Zoom de la carte</button>' +
            '<button type="button" class="va-btn va-btn--small" data-act="zoom-preview" title="Afficher l\'étape à ce zoom">Aperçu</button></span>' +
            '<small id="va-pf-zoom-hint"></small></label>' +
        '</fieldset>' +
        (i > 0 ?
          '<fieldset><legend>Retour</legend>' +
            '<label class="va-field"><span>Revenir par le même chemin jusqu\'à</span>' +
              '<span class="va-inline"><select id="va-return-to" style="flex:1;min-width:0">' + returnOptions(i) + '</select>' +
              '<button type="button" class="va-btn va-btn--small" data-act="return">↩ Créer le retour</button></span>' +
              '<small>Ajoute après cette étape les points de l\'aller, en sens inverse : le retour suit exactement le même tracé. ' +
              'Ce sont des points de passage (dates estimées, pas de récit) ; moyens de transport et zooms sont repris de l\'aller.</small></label>' +
          '</fieldset>' : '') +
        (p.arret ?
          '<fieldset><legend>Récit de l\'arrêt</legend>' +
            '<label class="va-field"><span>Titre <span class="req">*</span></span><input type="text" data-p="arret.titre" placeholder="Ex. Le passage du cap"></label>' +
            '<label class="va-field"><span>Récit</span><textarea data-p="arret.texte" rows="5" placeholder="Ce qui se passe ici, en quelques phrases."></textarea></label>' +
            '<label class="va-field"><span>Citation</span><textarea data-p="arret.citation" rows="3" placeholder="Extrait du récit de voyage, cité tel quel (sans guillemets)."></textarea></label>' +
            '<label class="va-field"><span>Source</span><input type="text" data-p="arret.source" placeholder="Ouvrage, page, cote…"></label>' +
          '</fieldset>' : '') +
        '<div class="va-pform-actions">' +
          '<button type="button" class="va-btn va-btn--small" data-act="up"' + (i === 0 ? ' disabled' : '') + '>↑ Monter</button>' +
          '<button type="button" class="va-btn va-btn--small" data-act="down"' + (isLast ? ' disabled' : '') + '>↓ Descendre</button>' +
          '<button type="button" class="va-btn va-btn--small" data-act="center">◎ Centrer</button>' +
          '<button type="button" class="va-btn va-btn--small va-btn--danger" data-act="delete">Supprimer l\'étape</button>' +
        '</div>' +
      '</div>';

    box.querySelectorAll('[data-p]').forEach(function (input) {
      var v = getP(p, input.getAttribute('data-p'));
      if (input.type === 'checkbox') input.checked = !!v;
      else if (input.tagName !== 'SELECT') input.value = v == null ? '' : v;
    });
    refreshPointHints();
    box.scrollTop = 0;
  }

  function getP(p, key) {
    if (key === 'lng') return p.coord[0];
    if (key === 'lat') return p.coord[1];
    if (key.indexOf('arret.') === 0) return p.arret ? p.arret[key.slice(6)] : '';
    return p[key];
  }

  function refreshPointHints() {
    if (selected < 0) return;
    var p = draft.points[selected], n = draft.points.length;
    var title = $('#va-pf-title');
    if (!title) return;
    title.textContent = trim(p.lieu) || (p.arret ? trim(p.arret.titre) || 'Arrêt raconté' : 'Point de passage');
    var d = derive(draft.points);
    var dh = describeDate(p.date), hint = $('#va-pf-date-hint');
    if (!trim(p.date)) {
      var dp = d.pts[selected];
      hint.className = '';
      hint.textContent = dp && dp.t != null
        ? 'Sans date : estimée à ≈ ' + formatDate(dp.t, dp.prec) + ' d\'après la distance.'
        : 'Sans date. Au moins une étape du voyage doit être datée.';
    } else {
      hint.className = dh.bad ? 'va-hint-bad' : 'va-hint-ok';
      hint.textContent = dh.text;
    }
    var dep = describeDate(p.depart), dhint = $('#va-pf-depart-hint');
    dhint.className = dep.bad ? 'va-hint-bad' : 'va-hint-ok';
    dhint.textContent = trim(p.depart) && !trim(p.date) ? 'Indiquez aussi la date d\'arrivée.' : dep.text;
    if (trim(p.depart) && !trim(p.date)) dhint.className = 'va-hint-bad';
    var mh = $('#va-pf-mode-hint');
    if (selected === n - 1) mh.textContent = 'Dernière étape : pas de tronçon après elle.';
    else {
      var eff = d.pts[selected].mode;
      mh.textContent = 'Vaut pour le tronçon vers l\'étape ' + (selected + 2) + ' et les suivants, jusqu\'au prochain changement. ' +
        (p.mode ? '' : 'Actuellement : ' + (MODE_LABEL[eff] || eff) + '.');
    }
    var zh = $('#va-pf-zoom-hint'), z = zoomOf(p);
    var autoMode = d.pts[selected] ? d.pts[selected].mode : DEFAULT_MODE;
    zh.className = isNaN(z) ? 'va-hint-bad' : '';
    zh.textContent = z == null
      ? 'Vide = automatique (' + String(MODE_ZOOM[autoMode] || 4).replace('.', ',') + ', ' + (MODE_LABEL[autoMode] || autoMode) +
        '). Plus le nombre est grand, plus on est près : 3 ≈ un océan, 6 ≈ une région, 10 ≈ une ville, 13 ≈ quelques rues.'
      : isNaN(z)
        ? 'Entre ' + ZOOM_MIN + ' et ' + ZOOM_MAX + ', ou vide pour automatique.'
        : 'La caméra plonge à ce zoom en approchant de l\'étape et remonte en repartant. ' +
          'À partir de 10, l\'exposition affiche le fond OpenStreetMap (bouton « 🗺 Fond détaillé » pour le voir ici).';
    var zin = document.querySelector('#va-steps [data-p="zoom"]');
    if (zin) zin.classList.toggle('is-invalid', isNaN(z));
    ['date', 'depart'].forEach(function (k) {
      var inp = document.querySelector('#va-steps [data-p="' + k + '"]');
      if (inp) inp.classList.toggle('is-invalid', !!trim(p[k]) && !parseDate(p[k]));
    });
    var at = document.querySelector('#va-steps [data-p="arret.titre"]');
    if (at) at.classList.toggle('is-invalid', !trim(p.arret && p.arret.titre));
  }

  var stepsBox = $('#va-steps');
  stepsBox.addEventListener('focusin', function (e) {
    if (e.target.hasAttribute && e.target.hasAttribute('data-p')) textSnapshotPending = true;
  });
  stepsBox.addEventListener('input', onPointInput);
  stepsBox.addEventListener('change', function (e) {
    var t = e.target;
    if (t.name === 'va-kind') {
      pushHistory();
      var p = draft.points[selected];
      if (t.value === 'arret' && !p.arret) {
        p.arret = p._stash || { titre: trim(p.lieu), texte: '', citation: '', source: '' };
      } else if (t.value === 'passage' && p.arret) {
        p._stash = p.arret;
        p.arret = null;
      }
      renderAll();
      changed();
      if (p.arret) { var ti = document.querySelector('#va-steps [data-p="arret.titre"]'); if (ti) ti.focus(); }
      return;
    }
    var key = t.getAttribute && t.getAttribute('data-p');
    if (key === 'date' || key === 'depart') {
      var norm = normalizeDateInput(t.value);
      if (norm !== t.value) { t.value = norm; onPointInput(e); }
    }
    if (key === 'mode' || key === 'approx') onPointInput(e);
  });

  function onPointInput(e) {
    var t = e.target, key = t.getAttribute && t.getAttribute('data-p');
    if (!key || selected < 0) return;
    if (e.type === 'input' && (t.type === 'checkbox' || t.tagName === 'SELECT')) return; // traités par 'change'
    if (textSnapshotPending) { pushHistory(); textSnapshotPending = false; }
    var p = draft.points[selected];
    var v = t.type === 'checkbox' ? t.checked : t.value;
    if (key === 'lng' || key === 'lat') {
      var num = parseFloat(v), ok = isFinite(num) && Math.abs(num) <= (key === 'lng' ? 180 : 90);
      t.classList.toggle('is-invalid', !ok);
      if (!ok) return;
      p.coord[key === 'lng' ? 0 : 1] = round5(num);
      renderPathLine();
      if (markers[selected]) markers[selected].setLngLat(dispCoords[selected]);
      renderStats();
    } else if (key.indexOf('arret.') === 0) {
      if (p.arret) p.arret[key.slice(6)] = v;
    } else {
      p[key] = v;
      if (key === 'mode') renderPathLine();
      if (key === 'lieu' && markers[selected]) markers[selected].getElement().title = 'Étape ' + (selected + 1) + ' — ' + v;
      if (key === 'date' || key === 'depart') { renderStats(); refreshAutoId(); }
    }
    refreshPointHints();
    changed();
  }

  stepsBox.addEventListener('click', function (e) {
    var b = e.target.closest && e.target.closest('[data-act]');
    if (!b || b.disabled) return;
    var act = b.getAttribute('data-act'), i = selected;
    if (act === 'list') selectPoint(-1);
    else if (act === 'prev') selectPoint(i - 1, true);
    else if (act === 'next') selectPoint(i + 1, true);
    else if (act === 'up') movePoint(i, -1);
    else if (act === 'down') movePoint(i, 1);
    else if (act === 'center') map && map.easeTo({ center: dispCoords[i], zoom: Math.max(map.getZoom(), 4), duration: 600 });
    else if (act === 'delete') deletePoint(i);
    else if (act === 'return') {
      var sel = document.getElementById('va-return-to');
      if (sel) addReturnPath(i, parseInt(sel.value, 10));
    }
    else if (act === 'zoom-take') {
      if (!map) return;
      pushHistory();
      draft.points[i].zoom = Math.round(clamp(map.getZoom(), ZOOM_MIN, ZOOM_MAX) * 2) / 2;
      renderAll();
      changed();
    } else if (act === 'zoom-preview') {
      var zp = zoomOf(draft.points[i]);
      if (!map || isNaN(zp)) return;
      if (zp == null) zp = MODE_ZOOM[derive(draft.points).pts[i].mode] || 4;
      map.easeTo({ center: dispCoords[i], zoom: zp, duration: 700 });
    }
    else if (act === 'geocode') {
      var name = trim(draft.points[i].lieu);
      if (!name) { toast('Saisissez d\'abord le nom du lieu.', true); return; }
      b.disabled = true;
      geocode(name).then(function (list) {
        if (!list.length) { toast('Aucun lieu trouvé pour « ' + name + ' ». Déplacez le point à la main ou reformulez.', true); return; }
        pushHistory();
        draft.points[i].coord = [round5(+list[0].lon), round5(+list[0].lat)];
        selected = i;
        renderAll();
        changed();
        map.easeTo({ center: dispCoords[i], zoom: Math.max(map.getZoom(), 5), duration: 700 });
        toast('Placé sur : ' + list[0].display_name + '. Si ce n\'est pas le bon endroit, faites glisser le point.', false, 6000);
      }).catch(function (err) { toast(err.message, true); })
        .then(function () { b.disabled = false; });
    }
  });

  /* ---------------------------------------------------------- enregistrer / annuler / supprimer */
  function afterServerData(j, id) {
    DATA = j.voyageurs;
    if (view.kind === 'voyageur') {
      var vr = findVoyageur(id);
      view = { kind: 'voyageur', originalId: id, version: vr.version };
      draft = voyageurDraft(vr);
      idTouched = true;
      saved = serialize();
      fillVoyageurForm();
    } else {
      var f = findVoyage(id);
      view = { kind: 'voyage', originalId: id, version: f.voyage.version };
      var keepSel = selected;
      draft = voyageDraft(f.voyage);
      idTouched = true;
      saved = serialize();
      selected = keepSel < draft.points.length ? keepSel : -1;
      fillVoyageurSelect();
      fillForm($('#va-voyage'));
      updateVoyageHeader();
      updateIdHint();
      renderAll();
    }
    renderTree();
    setHash();
  }

  $('#va-save').addEventListener('click', function () {
    var v = validate();
    if (v.errs.length) { issuesOpen = true; updateSaveBar(); return; }
    saving = true;
    updateSaveBar();
    var body = view.kind === 'voyageur'
      ? { action: 'saveVoyageur', voyageur: payloadVoyageur(), originalId: view.originalId, version: view.version }
      : { action: 'saveVoyage', voyage: payloadVoyage(), originalId: view.originalId, version: view.version };
    var pub = body.voyageur ? body.voyageur.publie : body.voyage.publie;
    api('POST', body).then(function (j) {
      afterServerData(j, j.id);
      toast(pub ? 'Enregistré ✓ — visible sur l\'exposition.' : 'Enregistré ✓ (brouillon, non publié).');
    }).catch(function (err) {
      toast(err.message, true, err.status === 409 ? 15000 : 8000);
    }).then(function () {
      saving = false;
      updateSaveBar();
    });
  });

  $('#va-revert').addEventListener('click', function () {
    if (!view) return;
    if (!view.originalId) {
      if (!isDirty() || window.confirm('Abandonner cette nouvelle fiche ?')) { saved = serialize(); goWelcome(); }
      return;
    }
    if (!window.confirm('Revenir à la dernière version enregistrée ? Les modifications en cours seront perdues.')) return;
    var id = view.originalId;
    saved = serialize(); // neutralise la confirmation d'abandon
    if (view.kind === 'voyageur') openVoyageur(id); else openVoyage(id);
  });

  $('#va-delete').addEventListener('click', function () {
    if (!view || !view.originalId) return;
    var msg;
    if (view.kind === 'voyageur') {
      var vr = findVoyageur(view.originalId);
      msg = 'Supprimer définitivement « ' + vr.nom + ' »' +
        (vr.voyages.length ? ' et ses ' + vr.voyages.length + ' voyage(s)' : '') + ' ? Cette action est irréversible.';
    } else {
      msg = 'Supprimer définitivement le voyage « ' + findVoyage(view.originalId).voyage.titre + ' » et toutes ses étapes ? Cette action est irréversible.';
    }
    if (!window.confirm(msg)) return;
    api('POST', { action: view.kind === 'voyageur' ? 'deleteVoyageur' : 'deleteVoyage', id: view.originalId })
      .then(function (j) {
        DATA = j.voyageurs;
        saved = serialize();
        goWelcome();
        toast('Supprimé.');
      })
      .catch(function (err) { toast(err.message, true); });
  });

  window.addEventListener('beforeunload', function (e) {
    if (isDirty()) { e.preventDefault(); e.returnValue = ''; }
  });

  /* ---------------------------------------------------------- démarrage */
  api('GET').then(function (j) {
    DATA = j.voyageurs;
    setStatus(true, 'Base connectée');
    $('#va-loading').hidden = true;
    var m = /^#(voyageur|voyage)=(.+)$/.exec(location.hash);
    var id = m ? decodeURIComponent(m[2]) : null;
    if (m && m[1] === 'voyageur' && findVoyageur(id)) openVoyageur(id);
    else if (m && m[1] === 'voyage' && findVoyage(id)) openVoyage(id);
    else goWelcome();
  }).catch(function (err) {
    setStatus(false, 'Base injoignable');
    $('#va-loading').hidden = true;
    var box = $('#va-fatal');
    box.innerHTML = '<strong>Impossible de charger les données de l\'exposition.</strong><br>' + esc(err.message) +
      (err.status === 404 ? '<br>Cette page doit être ouverte via le serveur du site (<code>npm run dev</code>).' : '');
    box.hidden = false;
  });
})();
