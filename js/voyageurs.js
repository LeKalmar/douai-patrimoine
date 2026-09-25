/* ============================================================
   VOYAGEURS DOUAISIENS — carte-globe animée (voyageurs.html)
   ------------------------------------------------------------
   Données : /data/voyageurs.json, généré depuis le schéma PostgreSQL
   `expo_voyageurs` (scripts/lib/export-voyageurs.mjs ; repli sur le
   fichier committé data/voyageurs.json si la base est arrêtée).

   Principe de l'animation : chaque voyage est découpé en « phases »
   successives — des déplacements (d'un point au suivant, longueur en km)
   et des séjours (le voyageur reste sur place entre `date` et `depart`,
   l'icône ne bouge pas mais le compteur de jours avance). Toutes les
   phases sont mises bout à bout sur un même axe `u` ; la lecture fait
   avancer `u` à vitesse constante et tout le reste (position, date, jour,
   moyen de transport, tracé parcouru) en est déduit. Aller à un arrêt ou
   cliquer sur la barre de progression revient simplement à changer `u`.

   Les dates des points qui n'en ont pas sont estimées au prorata de la
   distance entre les deux points datés qui les encadrent ; elles sont
   alors affichées précédées de « ≈ ».
   ============================================================ */
(function () {
  'use strict';

  fetch('data/voyageurs.json', { cache: 'no-cache' })
    .then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    })
    .then(start)
    .catch(function (err) {
      console.error('[voyageurs]', err);
      var list = document.getElementById('vy-list');
      if (list) list.textContent = "Les données de l'exposition n'ont pas pu être chargées.";
    });

  function start(DATA) {
  var EMBEDDED = document.documentElement.classList.contains('rp-embedded');
  var REDUCED_MOTION = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  var DAY = 86400000;
  var BASE_SECONDS = 50;          // durée d'un voyage complet à la vitesse 1×
  var DENSIFY_KM = 40;            // pas des points intermédiaires sur les grands cercles
  var MODE_ZOOM = { bateau: 3.1, attelage: 5.2, pied: 6.2, civiere: 6.8 };
  var MODE_LABEL = { bateau: 'En mer', attelage: 'En voiture à cheval', pied: 'À pied', civiere: 'Porté en civière' };
  var MOIS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet',
              'août', 'septembre', 'octobre', 'novembre', 'décembre'];
  var PRECISION_RANK = { annee: 0, mois: 1, jour: 2 };
  var DOUAI = [3.08, 50.37];

  /* ---------------------------------------------------------- icônes */
  var ICONS = {
    bateau:
      '<svg viewBox="0 0 48 48" aria-hidden="true">' +
      '<path d="M5 31h38l-6 9H11z" fill="#7a4a24" stroke="#3a2412" stroke-width="1.5" stroke-linejoin="round"/>' +
      '<path d="M8 35h32" stroke="#3a2412" stroke-width="1"/>' +
      '<path d="M24 5v26" stroke="#3a2412" stroke-width="2"/>' +
      '<path d="M25.5 8c8 3 11.5 10 11.5 20H25.5z" fill="#fbf8f1" stroke="#3a2412" stroke-width="1.3"/>' +
      '<path d="M22.5 11c-6 3-9 8.5-9 17h9z" fill="#efe6d2" stroke="#3a2412" stroke-width="1.3"/>' +
      '<path d="M24 5l7 2.2-7 2.2z" fill="#B4213C"/>' +
      '</svg>',
    pied:
      '<svg viewBox="0 0 48 48" aria-hidden="true" fill="none" stroke="#3a2412" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">' +
      '<circle cx="25" cy="8" r="4" fill="#efe6d2"/>' +
      '<path d="M24 13l-3 13 7 7 1 10"/><path d="M21 26l-5 9-3 8"/>' +
      '<path d="M23 16l-7 6"/><path d="M24 16l6 6 5 1"/>' +
      '<path d="M36 12v33" stroke="#7a4a24"/>' +
      '</svg>',
    attelage:
      '<svg viewBox="0 0 48 48" aria-hidden="true">' +
      '<path d="M16 14h22v16H14z" fill="#7a4a24" stroke="#3a2412" stroke-width="1.5" stroke-linejoin="round"/>' +
      '<rect x="20" y="17" width="6" height="6" fill="#efe6d2"/><rect x="29" y="17" width="6" height="6" fill="#efe6d2"/>' +
      '<path d="M14 26H4" stroke="#3a2412" stroke-width="2"/>' +
      '<circle cx="18" cy="35" r="6" fill="#efe6d2" stroke="#3a2412" stroke-width="2"/>' +
      '<circle cx="34" cy="35" r="6" fill="#efe6d2" stroke="#3a2412" stroke-width="2"/>' +
      '<path d="M16 11h24" stroke="#B4213C" stroke-width="2.5" stroke-linecap="round"/>' +
      '</svg>',
    civiere:
      '<svg viewBox="0 0 48 48" aria-hidden="true" fill="none" stroke="#3a2412" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M12 12h24l-3 7H15z" fill="#efe6d2"/>' +
      '<path d="M15 19v5M33 19v5"/>' +
      '<path d="M3 24h42" stroke="#7a4a24" stroke-width="3"/>' +
      '<circle cx="7" cy="17" r="3" fill="#efe6d2"/><path d="M7 21v10l-3 10M7 31l3 10"/>' +
      '<circle cx="41" cy="17" r="3" fill="#efe6d2"/><path d="M41 21v10l-3 10M41 31l3 10"/>' +
      '</svg>'
  };

  /* ---------------------------------------------------------- utilitaires */
  function $(sel) { return document.querySelector(sel); }
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function clamp(x, a, b) { return Math.max(a, Math.min(b, x)); }
  function initials(name) {
    return name.split(/\s+/).filter(Boolean).map(function (w) { return w[0]; }).slice(0, 2).join('').toUpperCase();
  }

  /* ---------------------------------------------------------- dates */
  function parseDate(s, approx) {
    if (!s) return null;
    var m = /^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?$/.exec(String(s));
    if (!m) return null;
    var y = +m[1], mo = m[2] ? +m[2] - 1 : 6, d = m[3] ? +m[3] : (m[2] ? 15 : 1);
    return { t: Date.UTC(y, mo, d), precision: m[3] ? 'jour' : (m[2] ? 'mois' : 'annee'), approx: !!approx };
  }
  function formatDate(t, precision) {
    var d = new Date(t);
    var y = d.getUTCFullYear(), mo = MOIS[d.getUTCMonth()], day = d.getUTCDate();
    if (precision === 'annee') return String(y);
    if (precision === 'mois') return mo + ' ' + y;
    return (day === 1 ? '1er' : day) + ' ' + mo + ' ' + y;
  }
  function minPrecision(a, b) {
    return PRECISION_RANK[a] <= PRECISION_RANK[b] ? a : b;
  }

  /* ---------------------------------------------------------- géodésie */
  var RAD = Math.PI / 180;
  function toVec(c) {
    var lng = c[0] * RAD, lat = c[1] * RAD;
    return [Math.cos(lat) * Math.cos(lng), Math.cos(lat) * Math.sin(lng), Math.sin(lat)];
  }
  function angleBetween(a, b) {
    var va = toVec(a), vb = toVec(b);
    var dot = clamp(va[0] * vb[0] + va[1] * vb[1] + va[2] * vb[2], -1, 1);
    return Math.acos(dot);
  }
  function distKm(a, b) { return angleBetween(a, b) * 6371; }
  /** Point à la fraction f du grand cercle a→b. */
  function slerp(a, b, f) {
    var d = angleBetween(a, b);
    if (d < 1e-9) return [a[0], a[1]];
    var va = toVec(a), vb = toVec(b);
    var A = Math.sin((1 - f) * d) / Math.sin(d), B = Math.sin(f * d) / Math.sin(d);
    var x = A * va[0] + B * vb[0], y = A * va[1] + B * vb[1], z = A * va[2] + B * vb[2];
    return [Math.atan2(y, x) / RAD, Math.atan2(z, Math.sqrt(x * x + y * y)) / RAD];
  }

  /* ---------------------------------------------------------- préparation d'un voyage */
  function prepareVoyage(voyageur, v) {
    var pts = v.points;
    var n = pts.length;

    // 1. Géométrie densifiée + kilomètre cumulé à chaque sommet.
    var path = [pts[0].coord.slice()], pathKm = [0], pointKm = [0];
    for (var i = 0; i < n - 1; i++) {
      var a = pts[i].coord, b = pts[i + 1].coord;
      var d = distKm(a, b);
      var steps = Math.max(1, Math.ceil(d / DENSIFY_KM));
      var base = pathKm[pathKm.length - 1];
      for (var s = 1; s <= steps; s++) {
        path.push(slerp(a, b, s / steps));
        pathKm.push(base + d * s / steps);
      }
      pointKm.push(base + d);
    }
    var totalKm = pointKm[n - 1];

    // 2. Dates d'arrivée/départ ; les points non datés sont estimés au
    //    prorata de la distance entre les deux points datés voisins.
    var arrive = new Array(n), leave = new Array(n), prec = new Array(n), approx = new Array(n);
    var anchors = [];
    pts.forEach(function (p, i) {
      var a = parseDate(p.date, p.approx);
      if (a) {
        var dep = parseDate(p.depart, p.approx) || a;
        arrive[i] = a.t; leave[i] = dep.t; prec[i] = a.precision; approx[i] = a.approx;
        anchors.push(i);
      }
    });
    if (!anchors.length) throw new Error('Voyage sans aucune date : ' + v.id);
    for (var k = 0; k < anchors.length - 1; k++) {
      var i0 = anchors[k], i1 = anchors[k + 1];
      var span = pointKm[i1] - pointKm[i0] || 1;
      var p0 = minPrecision(prec[i0], prec[i1]);
      for (var j = i0 + 1; j < i1; j++) {
        var f = (pointKm[j] - pointKm[i0]) / span;
        arrive[j] = leave[j] = leave[i0] + f * (arrive[i1] - leave[i0]);
        prec[j] = p0; approx[j] = true;
      }
    }
    // Avant la première / après la dernière date : on recopie la date voisine.
    for (var b0 = 0; b0 < anchors[0]; b0++) {
      arrive[b0] = leave[b0] = arrive[anchors[0]]; prec[b0] = prec[anchors[0]]; approx[b0] = true;
    }
    var last = anchors[anchors.length - 1];
    for (var e0 = last + 1; e0 < n; e0++) {
      arrive[e0] = leave[e0] = leave[last]; prec[e0] = prec[last]; approx[e0] = true;
    }

    var t0 = arrive[0], t1 = leave[n - 1];
    var totalDays = Math.max(1, (t1 - t0) / DAY);

    // 3. Phases mises bout à bout sur l'axe u. La durée d'affichage d'un
    //    déplacement mêle pour moitié sa part de la distance totale et pour
    //    moitié sa part du temps écoulé : au kilomètre seul, douze jours de
    //    marche dans le désert défileraient en un éclair à côté d'une
    //    traversée de 5 000 km ; au temps seul, une longue attente sans
    //    repère daté ralentirait tout. Un séjour ne compte que par sa durée.
    var WEIGHT_KM = 0.5, WEIGHT_TIME = 0.5;
    var phases = [], u = 0, stopU = {};
    var mode = pts[0].mode || 'bateau';
    for (var p = 0; p < n; p++) {
      if (pts[p].arret) stopU[p] = u;
      var stayDays = (leave[p] - arrive[p]) / DAY;
      if (stayDays > 0) {
        var len = clamp(WEIGHT_TIME * stayDays / totalDays, 0.02, 0.12);
        phases.push({ kind: 'stay', at: p, u0: u, len: len, t0: arrive[p], t1: leave[p] });
        u += len;
      }
      if (p < n - 1) {
        if (pts[p].mode) mode = pts[p].mode;
        var km = pointKm[p + 1] - pointKm[p];
        var days = Math.max(0, arrive[p + 1] - leave[p]) / DAY;
        var mlen = WEIGHT_KM * km / (totalKm || 1) + WEIGHT_TIME * days / totalDays;
        phases.push({ kind: 'move', from: p, u0: u, len: mlen, km: km, km0: pointKm[p], mode: mode });
        u += mlen;
      }
    }

    return {
      voyageur: voyageur, v: v, pts: pts, path: path, pathKm: pathKm, pointKm: pointKm,
      totalKm: totalKm, totalU: u, phases: phases, stopU: stopU,
      arrive: arrive, leave: leave, prec: prec, approx: approx,
      t0: t0, t1: t1, totalDays: totalDays,
      // Nombre de jours affiché, bornes comprises (du jour 1 au jour N).
      dayCount: Math.floor((t1 - t0) / DAY) + 1,
      durationKnown: prec[0] !== 'annee' && prec[n - 1] !== 'annee'
    };
  }

  /** Position, date, mode… à l'abscisse u du voyage. */
  function stateAt(V, u) {
    u = clamp(u, 0, V.totalU);
    var ph = V.phases[0];
    for (var i = 0; i < V.phases.length; i++) {
      if (V.phases[i].u0 <= u) ph = V.phases[i]; else break;
    }
    var f = ph.len > 0 ? clamp((u - ph.u0) / ph.len, 0, 1) : 0;
    var st = { u: u };
    if (ph.kind === 'stay') {
      st.km = V.pointKm[ph.at];
      st.t = ph.t0 + f * (ph.t1 - ph.t0);
      st.mode = null;
      st.precision = V.prec[ph.at];
      st.approx = true;
      st.at = ph.at;
    } else {
      var a = ph.from, b = a + 1;
      st.km = ph.km0 + f * ph.km;
      st.t = V.leave[a] + f * (V.arrive[b] - V.leave[a]);
      st.mode = ph.mode;
      st.precision = minPrecision(V.prec[a], V.prec[b]);
      st.approx = f > 0.001 && f < 0.999 ? (st.precision !== 'jour' || V.approx[a] || V.approx[b]) : V.approx[f < 0.5 ? a : b];
      st.at = f <= 0.001 ? a : (f >= 0.999 ? b : null);
      st.segFrom = a;
    }
    // Position sur le tracé densifié.
    var km = st.km, pk = V.pathKm, lo = 0, hi = pk.length - 1;
    while (hi - lo > 1) { var mid = (lo + hi) >> 1; if (pk[mid] <= km) lo = mid; else hi = mid; }
    var span = pk[hi] - pk[lo];
    var g = span > 0 ? (km - pk[lo]) / span : 0;
    st.idx = lo;
    st.pos = slerp(V.path[lo], V.path[hi], g);
    st.ahead = V.path[Math.min(hi + 2, V.path.length - 1)];
    st.day = Math.floor((st.t - V.t0) / DAY) + 1;
    return st;
  }

  /* ---------------------------------------------------------- données préparées */
  var VOYAGES = [];
  DATA.forEach(function (vr) {
    (vr.voyages || []).forEach(function (v) {
      try { VOYAGES.push(prepareVoyage(vr, v)); }
      catch (err) { console.error(err); }
    });
  });
  function findVoyage(id) {
    for (var i = 0; i < VOYAGES.length; i++) if (VOYAGES[i].v.id === id) return VOYAGES[i];
    return null;
  }

  /* ---------------------------------------------------------- carte */
  var map = new maplibregl.Map({
    container: 'vy-map',
    style: {
      version: 8,
      projection: { type: 'globe' },
      sources: {
        relief: {
          type: 'raster',
          tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Physical_Map/MapServer/tile/{z}/{y}/{x}'],
          tileSize: 256,
          maxzoom: 8,
          attribution: 'Fond : Esri, US National Park Service'
        }
      },
      sky: {
        'atmosphere-blend': ['interpolate', ['linear'], ['zoom'], 0, 1, 5, 1, 7, 0]
      },
      layers: [
        { id: 'fond', type: 'background', paint: { 'background-color': '#e9e1cf' } },
        { id: 'relief', type: 'raster', source: 'relief',
          paint: { 'raster-saturation': -0.45, 'raster-contrast': -0.05, 'raster-brightness-min': 0.08 } }
      ]
    },
    center: [30, 25],
    zoom: EMBEDDED ? 1.3 : 1.6,
    maxZoom: 8,
    attributionControl: false,
    cooperativeGestures: EMBEDDED,
    locale: {
      'CooperativeGesturesHandler.WindowsHelpText': 'Utilisez Ctrl + molette pour zoomer',
      'CooperativeGesturesHandler.MacHelpText': 'Utilisez ⌘ + molette pour zoomer',
      'CooperativeGesturesHandler.MobileHelpText': 'Utilisez deux doigts pour déplacer la carte'
    }
  });
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
  map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-right');

  var EMPTY_LINE = { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [] } };
  // Un voyage choisi avant la fin du chargement de la carte (clic rapide dans
  // la liste, ancre #id dans l'URL) est mis en attente : ses couches
  // n'existent pas encore.
  var mapReady = false, queuedVoyage = null;

  map.on('load', function () {
    map.addSource('vy-all', {
      type: 'geojson',
      data: {
        type: 'FeatureCollection',
        features: VOYAGES.map(function (V) {
          return { type: 'Feature', properties: { id: V.v.id, couleur: V.voyageur.couleur },
                   geometry: { type: 'LineString', coordinates: V.path } };
        })
      }
    });
    map.addLayer({ id: 'vy-all-line', type: 'line', source: 'vy-all',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': ['get', 'couleur'], 'line-width': 2.5, 'line-opacity': 0.75 } });
    // Zone de clic élargie, invisible.
    map.addLayer({ id: 'vy-all-hit', type: 'line', source: 'vy-all',
      paint: { 'line-color': '#000', 'line-width': 16, 'line-opacity': 0.001 } });

    map.addSource('vy-active-full', { type: 'geojson', data: EMPTY_LINE });
    map.addLayer({ id: 'vy-active-full', type: 'line', source: 'vy-active-full',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': '#3a2412', 'line-width': 1.6, 'line-opacity': 0.55, 'line-dasharray': [2, 2.5] } });

    map.addSource('vy-active-done', { type: 'geojson', data: EMPTY_LINE });
    map.addLayer({ id: 'vy-active-casing', type: 'line', source: 'vy-active-done',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': '#fbf8f1', 'line-width': 7, 'line-opacity': 0.9 } });
    map.addLayer({ id: 'vy-active-done', type: 'line', source: 'vy-active-done',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': '#B4213C', 'line-width': 3.5 } });

    map.on('mouseenter', 'vy-all-hit', function () { if (!current) map.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', 'vy-all-hit', function () { map.getCanvas().style.cursor = ''; });
    map.on('click', 'vy-all-hit', function (e) {
      if (current || !e.features || !e.features.length) return;
      selectVoyage(e.features[0].properties.id);
    });

    addOverviewMarkers();
    mapReady = true;

    var fromHash = decodeURIComponent((location.hash || '').replace(/^#/, ''));
    if (!queuedVoyage && fromHash && findVoyage(fromHash)) queuedVoyage = fromHash;
    if (queuedVoyage) selectVoyage(queuedVoyage);
    else startSpin();
  });

  /* ---------------------------------------------------------- rotation du globe en vue d'ensemble */
  var spinning = false, spinLast = 0, userTouched = false;
  function startSpin() {
    if (REDUCED_MOTION || userTouched || spinning) return;
    spinning = true; spinLast = performance.now();
    requestAnimationFrame(spinFrame);
  }
  function spinFrame(now) {
    if (!spinning) return;
    var dt = Math.min(64, now - spinLast); spinLast = now;
    var c = map.getCenter();
    map.jumpTo({ center: [c.lng + dt * 0.0035, c.lat] });
    requestAnimationFrame(spinFrame);
  }
  function stopSpin() { spinning = false; }
  ['mousedown', 'touchstart', 'wheel'].forEach(function (ev) {
    map.getCanvasContainer().addEventListener(ev, function () { userTouched = true; stopSpin(); }, { passive: true });
  });

  /* ---------------------------------------------------------- marqueurs */
  var overviewMarkers = [], stopMarkers = [], travelerMarker = null, travelerEl = null;

  function addOverviewMarkers() {
    // Douai, point de départ commun de l'exposition.
    var d = el('div', 'vy-douai');
    d.appendChild(el('span', 'vy-douai-dot'));
    d.appendChild(el('span', 'vy-douai-label', 'Douai'));
    new maplibregl.Marker({ element: d, anchor: 'left', offset: [-6, 0] }).setLngLat(DOUAI).addTo(map);

    VOYAGES.forEach(function (V) {
      var m = el('button', 'vy-portrait-marker');
      m.type = 'button';
      m.style.borderColor = V.voyageur.couleur;
      m.setAttribute('aria-label', V.voyageur.nom + ' — ' + V.v.titre);
      m.title = V.voyageur.nom + ' — ' + V.v.titre;
      fillPortrait(m, V.voyageur);
      m.addEventListener('click', function (e) { e.stopPropagation(); selectVoyage(V.v.id); });
      var mk = new maplibregl.Marker({ element: m }).setLngLat(V.pts[0].coord).addTo(map);
      overviewMarkers.push(mk);
    });
  }
  function setOverviewMarkersVisible(on) {
    overviewMarkers.forEach(function (mk) { mk.getElement().style.display = on ? '' : 'none'; });
  }
  function fillPortrait(node, vr) {
    if (vr.portrait) {
      node.style.backgroundImage = 'url("' + encodeURI(vr.portrait) + '")';
      node.classList.add('has-img');
    } else {
      node.textContent = initials(vr.nom);
    }
  }

  function buildStopMarkers(V) {
    clearStopMarkers();
    var num = 0;
    V.pts.forEach(function (p, i) {
      if (!p.arret) return;
      num++;
      var b = el('button', 'vy-stop-marker', String(num));
      b.type = 'button';
      b.style.setProperty('--c', V.voyageur.couleur);
      b.title = p.arret.titre;
      b.setAttribute('aria-label', 'Arrêt ' + num + ' : ' + p.arret.titre);
      b.addEventListener('click', function (e) { e.stopPropagation(); goToStop(i); });
      stopMarkers.push(new maplibregl.Marker({ element: b }).setLngLat(p.coord).addTo(map));
    });
  }
  function clearStopMarkers() {
    stopMarkers.forEach(function (m) { m.remove(); });
    stopMarkers = [];
  }

  function ensureTraveler() {
    if (travelerMarker) return;
    travelerEl = el('div', 'vy-traveler');
    travelerEl.appendChild(el('div', 'vy-traveler-icon'));
    travelerMarker = new maplibregl.Marker({ element: travelerEl }).setLngLat([0, 0]).addTo(map);
  }
  var lastIconMode = null;
  function setTravelerIcon(mode) {
    if (mode === lastIconMode) return;
    lastIconMode = mode;
    travelerEl.firstChild.innerHTML = ICONS[mode] || ICONS.pied;
  }

  /* ---------------------------------------------------------- état de lecture */
  var current = null;        // voyage préparé sélectionné
  var u = 0;                 // abscisse de lecture
  var playing = false;
  var speed = 1;
  var follow = true;
  var pendingStop = null;    // index du prochain arrêt raconté à déclencher
  var shownStop = null;      // index de l'arrêt dont la carte est affichée
  var camZoom = null;
  var rafId = 0, lastFrame = 0;
  var facing = 1;

  var ui = {
    list: $('#vy-list'),
    detail: $('#vy-detail'),
    hud: $('#vy-hud'),
    hudDate: $('#vy-hud-date'),
    hudDay: $('#vy-hud-day'),
    hudMode: $('#vy-hud-mode'),
    hudName: $('#vy-hud-name'),
    player: $('#vy-player'),
    play: $('#vy-play'),
    restart: $('#vy-restart'),
    track: $('#vy-track'),
    fill: $('#vy-track-fill'),
    ticks: $('#vy-track-ticks'),
    speeds: document.querySelectorAll('.vy-speed'),
    card: $('#vy-card'),
    recenter: $('#vy-recenter'),
    intro: $('#vy-intro')
  };

  /* ---------------------------------------------------------- panneau latéral */
  function renderList() {
    ui.list.innerHTML = '';
    DATA.forEach(function (vr) {
      var card = el('article', 'vy-person');
      card.style.setProperty('--c', vr.couleur);
      var head = el('div', 'vy-person-head');
      var ph = el('span', 'vy-person-portrait');
      fillPortrait(ph, vr);
      head.appendChild(ph);
      var id = el('div', 'vy-person-id');
      id.appendChild(el('h3', 'vy-person-name', vr.nom));
      id.appendChild(el('p', 'vy-person-life', vr.vie));
      id.appendChild(el('p', 'vy-person-link', vr.lienDouai));
      head.appendChild(id);
      card.appendChild(head);
      card.appendChild(el('p', 'vy-person-resume', vr.resume));
      if (vr.ecrits && vr.ecrits.length) {
        var ec = el('p', 'vy-person-ecrits');
        ec.appendChild(el('span', 'vy-label', 'Écrits · '));
        ec.appendChild(document.createTextNode(vr.ecrits.map(function (e) {
          return e.titre + (e.annee ? ' (' + e.annee + ')' : '');
        }).join(' ; ')));
        card.appendChild(ec);
      }
      (vr.voyages || []).forEach(function (v) {
        var b = el('button', 'vy-voyage-btn');
        b.type = 'button';
        b.dataset.voyage = v.id;
        b.appendChild(el('span', 'vy-voyage-title', v.titre));
        b.appendChild(el('span', 'vy-voyage-sub', v.sousTitre || ''));
        b.addEventListener('click', function () { selectVoyage(v.id); });
        card.appendChild(b);
      });
      ui.list.appendChild(card);
    });
  }

  function renderDetail(V) {
    ui.detail.innerHTML = '';
    var back = el('button', 'vy-back', '← Tous les voyageurs');
    back.type = 'button';
    back.addEventListener('click', deselect);
    ui.detail.appendChild(back);

    var head = el('div', 'vy-person-head');
    var ph = el('span', 'vy-person-portrait');
    fillPortrait(ph, V.voyageur);
    head.appendChild(ph);
    var id = el('div', 'vy-person-id');
    id.appendChild(el('h3', 'vy-person-name', V.voyageur.nom));
    id.appendChild(el('p', 'vy-person-life', V.voyageur.vie));
    head.appendChild(id);
    ui.detail.appendChild(head);

    ui.detail.appendChild(el('h4', 'vy-detail-title', V.v.titre));
    ui.detail.appendChild(el('p', 'vy-detail-sub', V.v.sousTitre || ''));
    var facts = el('p', 'vy-detail-facts',
      Math.round(V.totalKm).toLocaleString('fr-FR') + ' km · ' +
      (V.durationKnown ? V.dayCount.toLocaleString('fr-FR') + ' jours' : 'durée à préciser'));
    ui.detail.appendChild(facts);

    var ol = el('ol', 'vy-stops');
    V.pts.forEach(function (p, i) {
      if (!p.arret) return;
      var li = el('li');
      var b = el('button', 'vy-stop-btn');
      b.type = 'button';
      b.dataset.stop = i;
      b.appendChild(el('span', 'vy-stop-name', p.arret.titre));
      b.appendChild(el('span', 'vy-stop-date', dateLabelAtPoint(V, i)));
      b.addEventListener('click', function () { goToStop(i); });
      li.appendChild(b);
      ol.appendChild(li);
    });
    ui.detail.appendChild(ol);

    if (V.v.sources && V.v.sources.length) {
      var src = el('p', 'vy-detail-sources');
      src.appendChild(el('span', 'vy-label', 'Sources · '));
      src.appendChild(document.createTextNode(V.v.sources.join(' ; ')));
      ui.detail.appendChild(src);
    }
  }

  function dateLabelAtPoint(V, i) {
    return (V.approx[i] ? '≈ ' : '') + formatDate(V.arrive[i], V.prec[i]);
  }

  /* ---------------------------------------------------------- sélection */
  function selectVoyage(id) {
    var V = findVoyage(id);
    if (!V) return;
    if (!mapReady) { queuedVoyage = id; return; }
    stopSpin(); userTouched = true;
    pause();
    current = V;
    u = 0; follow = true; camZoom = null; shownStop = null; lastIconMode = null;
    pendingStop = firstStopIndex(V, -1);

    document.body.classList.add('vy-has-voyage');
    ui.list.hidden = true;
    ui.detail.hidden = false;
    ui.intro.hidden = true;
    renderDetail(V);
    renderTicks(V);

    setOverviewMarkersVisible(false);
    map.setPaintProperty('vy-all-line', 'line-opacity', ['case', ['==', ['get', 'id'], V.v.id], 0, 0.2]);
    map.setPaintProperty('vy-active-done', 'line-color', V.voyageur.couleur);
    map.getSource('vy-active-full').setData({ type: 'Feature', properties: {},
      geometry: { type: 'LineString', coordinates: V.path } });
    buildStopMarkers(V);
    ensureTraveler();
    travelerMarker.getElement().style.display = '';

    ui.hud.hidden = false;
    ui.player.hidden = false;
    ui.hudName.textContent = V.voyageur.nom;
    ui.hud.style.setProperty('--c', V.voyageur.couleur);

    try { history.replaceState(null, '', '#' + encodeURIComponent(V.v.id)); } catch (e) { /* file:// */ }

    // Vue d'ensemble du voyage, puis carte du premier arrêt (le départ).
    var bounds = new maplibregl.LngLatBounds();
    V.path.forEach(function (c) { bounds.extend(c); });
    map.fitBounds(bounds, { padding: fitPadding(), duration: REDUCED_MOTION ? 0 : 2200, maxZoom: 6 });
    render();
    if (pendingStop === 0) {
      map.once('moveend', function () { if (current === V && u === 0) triggerStop(0); });
    }
  }

  function deselect() {
    pause();
    current = null;
    hideCard();
    clearStopMarkers();
    if (travelerMarker) travelerMarker.getElement().style.display = 'none';
    document.body.classList.remove('vy-has-voyage');
    ui.list.hidden = false;
    ui.detail.hidden = true;
    ui.hud.hidden = true;
    ui.player.hidden = true;
    ui.recenter.hidden = true;
    ui.intro.hidden = false;
    setOverviewMarkersVisible(true);
    map.setPaintProperty('vy-all-line', 'line-opacity', 0.75);
    map.getSource('vy-active-full').setData(EMPTY_LINE);
    map.getSource('vy-active-done').setData(EMPTY_LINE);
    try { history.replaceState(null, '', location.pathname + location.search); } catch (e) { /* file:// */ }
    map.flyTo({ center: [30, 25], zoom: EMBEDDED ? 1.3 : 1.6, duration: REDUCED_MOTION ? 0 : 1800 });
  }

  function fitPadding() {
    // En haut : le tableau de bord ; en bas : le lecteur.
    var narrow = window.innerWidth < 760;
    return narrow ? { top: 110, bottom: 90, left: 30, right: 30 }
                  : { top: 120, bottom: 100, left: 60, right: 60 };
  }

  function firstStopIndex(V, after) {
    for (var i = after + 1; i < V.pts.length; i++) if (V.pts[i].arret) return i;
    return null;
  }

  /* ---------------------------------------------------------- lecture */
  function play() {
    if (!current) return;
    if (u >= current.totalU - 1e-6) restart();
    hideCard();
    playing = true;
    follow = true;
    ui.recenter.hidden = true;
    ui.play.setAttribute('aria-label', 'Pause');
    ui.play.classList.add('is-playing');
    lastFrame = performance.now();
    cancelAnimationFrame(rafId);
    rafId = requestAnimationFrame(frame);
  }
  function pause() {
    playing = false;
    cancelAnimationFrame(rafId);
    ui.play.setAttribute('aria-label', 'Lecture');
    ui.play.classList.remove('is-playing');
  }
  function restart() {
    if (!current) return;
    u = 0; camZoom = null;
    pendingStop = firstStopIndex(current, -1);
    // L'arrêt de départ a déjà été vu : on repart directement.
    if (pendingStop === 0) pendingStop = firstStopIndex(current, 0);
    hideCard();
    render();
  }

  function frame(now) {
    if (!playing || !current) return;
    var dt = Math.min(100, now - lastFrame) / 1000;
    lastFrame = now;
    var next = u + dt * speed * current.totalU / BASE_SECONDS;

    // Arrêt raconté atteint : on s'y cale et on met en pause.
    if (pendingStop != null && current.stopU[pendingStop] <= next) {
      u = current.stopU[pendingStop];
      var idx = pendingStop;
      pendingStop = firstStopIndex(current, idx);
      render();
      pause();
      triggerStop(idx);
      return;
    }
    u = next;
    if (u >= current.totalU) {
      u = current.totalU;
      render();
      pause();
      return;
    }
    render();
    rafId = requestAnimationFrame(frame);
  }

  function goToStop(i) {
    if (!current) return;
    pause();
    u = current.stopU[i];
    pendingStop = firstStopIndex(current, i);
    follow = true;
    ui.recenter.hidden = true;
    render(true);
    triggerStop(i);
  }

  function seek(frac) {
    if (!current) return;
    var wasPlaying = playing;
    pause();
    hideCard();
    u = clamp(frac, 0, 1) * current.totalU;
    // Le prochain arrêt raconté est le premier situé après la nouvelle position.
    pendingStop = null;
    for (var i = 0; i < current.pts.length; i++) {
      if (current.pts[i].arret && current.stopU[i] > u + 1e-6) { pendingStop = i; break; }
    }
    follow = true;
    render(true);
    if (wasPlaying) play();
  }

  /* ---------------------------------------------------------- rendu d'une image */
  function render(jump) {
    var V = current;
    if (!V) return;
    var st = stateAt(V, u);

    // Tracé parcouru.
    var done = V.path.slice(0, st.idx + 1);
    done.push(st.pos);
    map.getSource('vy-active-done').setData({ type: 'Feature', properties: {},
      geometry: { type: 'LineString', coordinates: done } });

    // Voyageur : icône selon le moyen de transport, tournée dans le sens de la marche.
    var mode = st.mode || modeAtPoint(V, st.at);
    setTravelerIcon(mode);
    travelerMarker.setLngLat(st.pos);
    var p1 = map.project(st.pos), p2 = map.project(st.ahead);
    if (Math.abs(p2.x - p1.x) > 0.5) facing = p2.x >= p1.x ? 1 : -1;
    travelerEl.firstChild.style.transform = 'scaleX(' + facing + ')';

    // Tableau de bord.
    ui.hudDate.textContent = (st.approx ? '≈ ' : '') + formatDate(st.t, st.precision);
    // Dates connues à l'année seulement : un « jour 213 / 366 » serait une
    // fausse précision. On garde un ordre de grandeur, sans total.
    ui.hudDay.textContent = V.durationKnown
      ? 'Jour ' + Math.max(1, st.day).toLocaleString('fr-FR') + ' / ' + V.dayCount.toLocaleString('fr-FR')
      : '≈ jour ' + Math.max(1, st.day).toLocaleString('fr-FR');
    ui.hudMode.innerHTML = '';
    var ic = el('span', 'vy-hud-icon'); ic.innerHTML = ICONS[mode] || '';
    ui.hudMode.appendChild(ic);
    ui.hudMode.appendChild(document.createTextNode(st.mode ? MODE_LABEL[st.mode] : placeLabel(V, st)));

    var frac = V.totalU ? u / V.totalU : 0;
    ui.fill.style.width = (frac * 100).toFixed(2) + '%';
    ui.track.setAttribute('aria-valuenow', Math.round(frac * 100));
    ui.track.setAttribute('aria-valuetext', ui.hudDate.textContent + ', ' + ui.hudDay.textContent);

    // Caméra : suit le voyageur, zoom adapté au moyen de transport.
    if (follow && (playing || jump)) {
      var target = MODE_ZOOM[mode] || 4;
      if (camZoom == null || jump) camZoom = map.getZoom();
      camZoom += (target - camZoom) * (jump ? 1 : 0.02);
      if (jump) map.easeTo({ center: st.pos, zoom: camZoom, duration: REDUCED_MOTION ? 0 : 900 });
      else map.jumpTo({ center: st.pos, zoom: camZoom });
    }
  }

  function modeAtPoint(V, at) {
    if (at == null) return 'pied';
    for (var i = at; i >= 0; i--) if (V.pts[i].mode) return V.pts[i].mode;
    return 'pied';
  }
  function placeLabel(V, st) {
    var p = st.at != null ? V.pts[st.at] : null;
    return p && p.lieu ? 'À ' + p.lieu : 'Halte';
  }

  function renderTicks(V) {
    ui.ticks.innerHTML = '';
    V.pts.forEach(function (p, i) {
      if (!p.arret) return;
      var t = el('button', 'vy-tick');
      t.type = 'button';
      t.style.left = (V.stopU[i] / V.totalU * 100) + '%';
      t.title = p.arret.titre;
      t.setAttribute('aria-label', 'Aller à : ' + p.arret.titre);
      t.addEventListener('click', function (e) { e.stopPropagation(); goToStop(i); });
      ui.ticks.appendChild(t);
    });
  }

  /* ---------------------------------------------------------- carte d'arrêt */
  function triggerStop(i) {
    var V = current, p = V.pts[i];
    shownStop = i;
    // Arrêt atteint : « Continuer » doit repartir vers le suivant, pas
    // retomber sur celui-ci.
    if (pendingStop === i) pendingStop = firstStopIndex(V, i);
    ui.card.innerHTML = '';
    ui.card.style.setProperty('--c', V.voyageur.couleur);
    var meta = el('p', 'vy-card-meta', (p.lieu ? p.lieu + ' · ' : '') + dateLabelAtPoint(V, i));
    ui.card.appendChild(meta);
    ui.card.appendChild(el('h3', 'vy-card-title', p.arret.titre));
    ui.card.appendChild(el('p', 'vy-card-text', p.arret.texte));
    if (p.arret.citation) ui.card.appendChild(el('blockquote', 'vy-card-quote', p.arret.citation));
    if (p.arret.source) ui.card.appendChild(el('p', 'vy-card-source', p.arret.source));
    var isLast = firstStopIndex(V, i) == null && V.stopU[i] >= V.totalU - 1e-6;
    var actions = el('div', 'vy-card-actions');
    var go = el('button', 'vy-card-go', isLast ? 'Revoir le voyage ↺' : (i === 0 ? 'Partir ▸' : 'Continuer ▸'));
    go.type = 'button';
    go.addEventListener('click', function () {
      if (isLast) { restart(); }
      play();
    });
    actions.appendChild(go);
    ui.card.appendChild(actions);
    ui.card.hidden = false;
    document.querySelectorAll('.vy-stop-btn').forEach(function (b) {
      b.classList.toggle('is-current', +b.dataset.stop === i);
    });
    stopMarkers.forEach(function (m) { m.getElement().classList.remove('is-current'); });
    var n = 0;
    V.pts.forEach(function (pp, j) {
      if (!pp.arret) return;
      if (j === i && stopMarkers[n]) stopMarkers[n].getElement().classList.add('is-current');
      n++;
    });
    go.focus({ preventScroll: true });
  }
  function hideCard() {
    ui.card.hidden = true;
    shownStop = null;
    document.querySelectorAll('.vy-stop-btn.is-current').forEach(function (b) { b.classList.remove('is-current'); });
    stopMarkers.forEach(function (m) { m.getElement().classList.remove('is-current'); });
  }

  /* ---------------------------------------------------------- commandes */
  ui.play.addEventListener('click', function () { playing ? pause() : play(); });
  ui.restart.addEventListener('click', function () { var was = playing; pause(); restart(); if (was) play(); });
  ui.speeds.forEach(function (b) {
    b.addEventListener('click', function () {
      speed = +b.dataset.speed;
      ui.speeds.forEach(function (x) { x.setAttribute('aria-pressed', x === b ? 'true' : 'false'); });
    });
  });
  ui.recenter.addEventListener('click', function () {
    follow = true; ui.recenter.hidden = true; render(true);
  });
  ui.track.addEventListener('click', function (e) {
    var r = ui.track.getBoundingClientRect();
    seek((e.clientX - r.left) / r.width);
  });
  ui.track.addEventListener('keydown', function (e) {
    if (!current) return;
    var step = e.shiftKey ? 0.1 : 0.02, frac = u / current.totalU;
    if (e.key === 'ArrowRight') { seek(frac + step); e.preventDefault(); }
    else if (e.key === 'ArrowLeft') { seek(frac - step); e.preventDefault(); }
    else if (e.key === 'Home') { seek(0); e.preventDefault(); }
    else if (e.key === 'End') { seek(1); e.preventDefault(); }
  });
  // Déplacer la carte à la main suspend le suivi de caméra.
  map.on('dragstart', function (e) {
    if (!current || !e.originalEvent) return;
    follow = false;
    ui.recenter.hidden = false;
  });
  document.addEventListener('keydown', function (e) {
    if (!current || e.target.closest('input, textarea, select')) return;
    if (e.key === ' ' && !e.target.closest('button, [role="slider"]')) {
      e.preventDefault();
      playing ? pause() : play();
    } else if (e.key === 'Escape' && !ui.card.hidden) {
      hideCard();
    }
  });

  renderList();
  ui.detail.hidden = true;
  ui.hud.hidden = true;
  ui.player.hidden = true;
  ui.card.hidden = true;
  ui.recenter.hidden = true;
  } // start()
})();
