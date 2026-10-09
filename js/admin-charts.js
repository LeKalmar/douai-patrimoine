/* ============================================================================
   js/admin-charts.js — primitives de graphiques des outils pro (window.rpCharts)

   Script classique, sans dépendance. Fonctions PURES : chacune renvoie une
   chaîne HTML (les pages construisent leur DOM en innerHTML). Les styles sont
   dans css/admin.css (classes pro-chart-*). Un seul gestionnaire d'infobulle
   délégué : rpCharts.attachTooltips(rootEl).

     bars(items, {max, unit, axis, height, title, valueFmt, valueLabels})
     hbars(items, {max, valueFmt, median, title, thin})
     stacked(segments, {legend: true|false|'inline', height, title, total, decimals})
     sparkline(values, {width, height, color, area, dot, min, max, label})
     miniBars(values, {color, lastColor, max, labels})
     ring(segments, {size, label, sub, total, thickness, ariaLabel})
     heatmapCalendar(days, {weeks, end, unit, title})
     scatter(points, {xDomain, yDomain, yScale, xLabel, yLabel, highlight, height})
     lorenz(values, {title})
     PLAN, DECISION, DECISION_ORDER, PRETS  (palettes — mêmes valeurs que le CSS)

   Chaque graphique porte role="img" + aria-label qui résume les données ;
   tous les textes sont échappés ; une barre ou un point qui a une infobulle
   (`tip`) est focalisable au clavier. Les infobulles sont positionnées en
   absolu dans le conteneur .pro-chart (jamais en position:fixed : voir
   CLAUDE.md, publication en iframe).
   ========================================================================== */
(function (global) {
  'use strict';

  var NNBSP = ' ';   // voir rpUI.fmt.n : U+202F ne s'affiche pas avec les polices du site
  var NBSP = ' ';

  /* ── Palettes (valeurs identiques à css/admin.css — validées daltonisme) ── */
  var PLAN = {
    cat:      { label: 'Catalogué',          color: '#1A1E99' },
    manuel:   { label: 'Exemplarisé rapide', color: '#F9A825' },
    noncat:   { label: 'Non catalogué',      color: '#c62828' },
    nonrange: { label: 'Non rangé',          color: '#8E24AA' },
    vide:     { label: 'Vide confirmé',      color: '#c8e6c9', border: '#388e3c' },
    inconnu:  { label: 'Non inventorié',     color: '#e0e0e0', border: '#bdbdbd' }
  };
  var DECISION = {
    conserver:      { label: 'Conserver',      color: '#2e7d32', ink: '#fff',    textOnWhite: '#2e7d32' },
    braderie:       { label: 'Braderie',       color: '#e8a200', ink: '#2b1d00', textOnWhite: '#8a5f00' },
    relocalisation: { label: 'Relocalisation', color: '#2A3CD4', ink: '#fff',    textOnWhite: '#2A3CD4' },
    pilon:          { label: 'Pilon',          color: '#c62828', ink: '#fff',    textOnWhite: '#c62828' },
    todo:           { label: 'Non traité',     color: '#e3e4ec', ink: '#3E3E52', textOnWhite: '#3E3E52' }
  };
  var DECISION_ORDER = ['conserver', 'braderie', 'relocalisation', 'pilon', 'todo'];
  var PRETS = '#0f9d8a';
  var BLEU = '#2A3CD4';
  var BLEU_CLAIR = '#7F8BE8';
  var CARMIN = '#B4213C';

  /* ── Utilitaires ─────────────────────────────────────────────────────── */
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  /* Valeur d'attribut : en plus, les sauts de ligne survivent (&#10;). */
  function attr(s) { return esc(s).replace(/\n/g, '&#10;'); }

  function fmtN(v, decimals) {
    if (v == null || !isFinite(Number(v))) return '—';
    var x = Number(v);
    var parts = Math.abs(x).toFixed(decimals || 0).split('.');
    return (x < 0 ? '−' : '') + parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, NNBSP) + (parts[1] ? ',' + parts[1] : '');
  }
  function fmtPct(fraction, decimals) { return fmtN(fraction * 100, decimals || 0) + NBSP + '%'; }
  function num(v) { v = Number(v); return isFinite(v) ? v : 0; }
  function css(n) { return (Math.round(n * 100) / 100).toString(); }   // 12.3456 → "12.35"
  function safeColor(c, fallback) {
    /* Les couleurs viennent du code des pages, pas de saisies — on garde
       néanmoins le style inline à l'abri d'une injection. */
    return /^[#a-zA-Z0-9(),.\s%-]+$/.test(c || '') ? c : fallback;
  }

  /* Étape « ronde » 1-2-5 × 10^k pour un axe gradué. */
  function niceTicks(max, target, exact) {
    if (!(max > 0)) return { max: 1, ticks: [0, 1], step: 1 };
    var raw = max / (target || 5);
    var mag = Math.pow(10, Math.floor(Math.log10(raw)));
    var n = raw / mag;
    var step = (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * mag;
    var top = exact ? max : Math.ceil(max / step - 1e-9) * step;
    var ticks = [];
    for (var i = 0; i * step <= top + step * 1e-6; i++) ticks.push(+(i * step).toPrecision(12));
    return { max: top, ticks: ticks, step: step };
  }

  function luminance(hex) {
    var m = /^#([0-9a-f]{6})$/i.exec(hex || '');
    if (!m) return 0.5;
    var v = parseInt(m[1], 16);
    var r = (v >> 16) & 255, g = (v >> 8) & 255, b = v & 255;
    return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  }
  function inkFor(color) { return luminance(color) > 0.6 ? '#2b1d00' : '#fff'; }

  /* Attributs communs d'un élément à infobulle : focalisable + libellé. */
  function tipAttrs(tip) {
    if (!tip) return '';
    var plain = String(tip).replace(/\n/g, ', ');
    return ' data-tip="' + attr(tip) + '" tabindex="0" aria-label="' + attr(plain) + '"';
  }

  function chartOpen(ariaLabel, extraClass) {
    return '<div class="pro-chart' + (extraClass ? ' ' + extraClass : '') + '" role="img" aria-label="' + attr(ariaLabel) + '">';
  }

  /* ── Barres verticales ───────────────────────────────────────────────── */
  function bars(items, o) {
    items = items || [];
    o = o || {};
    var height = o.height || 200;
    var valueFmt = o.valueFmt || function (v) { return fmtN(v); };
    var dataMax = 0;
    items.forEach(function (it) { dataMax = Math.max(dataMax, num(it.value)); });
    var axisMax, ticks = [];
    if (o.axis !== false) {
      var nt = niceTicks(o.max || dataMax, 5, !!o.max);
      axisMax = nt.max; ticks = nt.ticks;
    } else {
      axisMax = o.max || dataMax || 1;
    }

    var unit = o.unit ? ' ' + o.unit : '';
    var aria = (o.title ? o.title + ' : ' : '') + items.map(function (it) {
      return fmtN(it.value) + unit + ' ' + (/^\d{4}/.test(it.label) ? 'en ' : 'pour ') + it.label;
    }).join(', ');

    var h = chartOpen(aria);
    if (o.unit && o.axis !== false) h += '<div class="pro-chart-unit" aria-hidden="true">' + esc(o.unit) + '</div>';
    h += '<div class="pro-chart-vbars" style="--h:' + height + 'px">';
    if (o.axis !== false) {
      h += '<div class="pro-chart-vbars__axis" aria-hidden="true">';
      ticks.forEach(function (t) {
        h += '<span style="bottom:' + css(t / axisMax * 100) + '%">' + fmtN(t) + '</span>';
      });
      h += '</div>';
    } else {
      h += '<div class="pro-chart-vbars__axis" aria-hidden="true" style="width:0"></div>';
    }
    h += '<div class="pro-chart-vbars__plot">';
    ticks.forEach(function (t) {
      if (t > 0) h += '<span class="pro-chart-vbars__grid" aria-hidden="true" style="bottom:' + css(t / axisMax * 100) + '%"></span>';
    });
    h += '<div class="pro-chart-vbars__cols">';
    items.forEach(function (it) {
      var v = num(it.value);
      var color = safeColor(it.color, BLEU);
      h += '<div class="pro-chart-vbars__col">' +
        (o.valueLabels === false ? '' : '<span class="pro-chart-vbars__val">' + esc(valueFmt(v, it)) + '</span>') +
        '<span class="pro-chart-vbars__bar' + (it.hatched ? ' pro-chart-vbars__bar--hatched' : '') + '"' +
        ' style="height:' + css(Math.min(100, v / axisMax * 100)) + '%;--c:' + color + '"' + tipAttrs(it.tip) + '></span>' +
        '</div>';
    });
    h += '</div></div></div>';
    // Beaucoup de colonnes (ex. une par année) : une étiquette sur `step`, sur
    // une seule ligne — sinon « 2008 » se casse chiffre par chiffre. La
    // première et la dernière restent toujours affichées.
    var dense = items.length > 10;
    var step = dense ? Math.ceil(items.length / 10) : 1;
    h += '<div class="pro-chart-vbars__x" aria-hidden="true"' + (o.axis === false ? ' style="padding-left:0"' : '') + '><div class="pro-chart-vbars__xin' + (dense ? ' pro-chart-vbars__xin--dense' : '') + '">';
    items.forEach(function (it, i) {
      var show = !dense || i % step === 0 || i === items.length - 1;
      h += '<span>' + (show ? esc(it.label) : '') + '</span>';
    });
    h += '</div></div></div>';
    return h;
  }

  /* ── Barres horizontales classées ────────────────────────────────────── */
  /* items : [{label, code?, value, color?, tip?, valueText?, bars?:[{value,color,tip?}]}]
     `bars` dessine plusieurs barres fines par ligne (ex. part des livres /
     part des prêts) ; sinon une seule barre pleine. */
  function hbars(items, o) {
    items = items || [];
    o = o || {};
    var valueFmt = o.valueFmt || function (v) { return fmtN(v); };
    var max = o.max || 0;
    if (!max) {
      items.forEach(function (it) {
        if (it.bars) it.bars.forEach(function (b) { max = Math.max(max, num(b.value)); });
        else max = Math.max(max, num(it.value));
      });
    }
    if (!(max > 0)) max = 1;
    var multi = items.some(function (it) { return it.bars; });

    var aria = (o.title ? o.title + ' : ' : '') + items.map(function (it) {
      var vals = it.valueText || (it.bars ? it.bars.map(function (b) { return valueFmt(num(b.value), it); }).join(' / ') : valueFmt(num(it.value), it));
      return (it.code ? it.code + ' ' : '') + it.label + ' ' + vals;
    }).join(', ');

    var h = chartOpen(aria);
    h += '<div class="pro-chart-hbars' + (o.thin || multi ? ' pro-chart-hbars--thin' : '') + (o.median != null ? ' pro-chart-hbars--median' : '') + '">';
    if (o.median != null) {
      var med = typeof o.median === 'object' ? o.median : { value: o.median };
      var mp = Math.max(0, Math.min(100, num(med.value) / max * 100));
      h += '<span class="pro-chart-hbars__median" aria-hidden="true"><i style="left:' + css(mp) + '%"></i><b style="left:' + css(mp) + '%">' +
        esc(med.label || ('médiane ' + valueFmt(num(med.value), null))) + '</b></span>';
    }
    items.forEach(function (it) {
      var list = it.bars || [{ value: it.value, color: it.color, tip: it.tip }];
      var valueText = it.valueText != null ? it.valueText
        : (it.bars ? it.bars.map(function (b) { return valueFmt(num(b.value), it); }).join(' · ') : valueFmt(num(it.value), it));
      h += '<div class="pro-chart-hbars__row">' +
        '<span class="pro-chart-hbars__label">' + (it.code ? '<strong>' + esc(it.code) + '</strong> ' : '') + esc(it.label) + '</span>' +
        '<span class="pro-chart-hbars__track">';
      list.forEach(function (b) {
        h += '<span class="pro-chart-hbars__t"' + tipAttrs(b.tip || it.tip) + '><span class="pro-chart-hbars__bar" style="width:' +
          css(Math.min(100, num(b.value) / max * 100)) + '%;--c:' + safeColor(b.color || it.color, BLEU) + '"></span></span>';
      });
      h += '</span><span class="pro-chart-hbars__value">' + esc(valueText) + '</span></div>';
    });
    h += '</div></div>';
    return h;
  }

  /* ── Barre empilée 100 % + légende chiffrée ──────────────────────────── */
  /* segments : [{label, value, color, ink?, tip?}] */
  function stacked(segments, o) {
    segments = segments || [];
    o = o || {};
    var decimals = o.decimals == null ? 1 : o.decimals;
    var total = o.total || segments.reduce(function (a, s) { return a + num(s.value); }, 0);
    var aria = (o.title ? o.title + ' : ' : '') + segments.map(function (s) {
      return s.label + ' ' + fmtPct(total ? num(s.value) / total : 0, decimals);
    }).join(', ');

    var h = chartOpen(aria);
    h += '<div class="pro-chart-stack" style="--h:' + (o.height || 26) + 'px">';
    segments.forEach(function (s) {
      var p = total ? num(s.value) / total * 100 : 0;
      if (p <= 0) return;
      var color = safeColor(s.color, '#e3e4ec');
      var tip = s.tip || (s.label + '\n' + fmtN(s.value) + ' · ' + fmtPct(p / 100, decimals));
      h += '<span class="pro-chart-stack__seg" style="--w:' + css(p) + '%;--c:' + color + ';--ink:' + safeColor(s.ink, inkFor(color)) + '"' + tipAttrs(tip) + '>' +
        (p >= 12 ? esc(fmtPct(p / 100, decimals)) : '') + '</span>';
    });
    h += '</div>';
    if (o.legend !== false) {
      var inline = o.legend === 'inline';
      h += '<div class="pro-chart-legend' + (inline ? ' pro-chart-legend--inline' : '') + '">';
      segments.forEach(function (s) {
        var p = total ? num(s.value) / total : 0;
        h += '<div class="pro-chart-legend__item"><span class="pro-chart-legend__sw" aria-hidden="true" style="--c:' + safeColor(s.color, '#e3e4ec') + '"></span>' +
          '<span><strong>' + esc(fmtN(s.value)) + '</strong> ' + esc(s.label) + (inline ? ' <small>' : '<small>') + esc(fmtPct(p, decimals)) + '</small></span></div>';
      });
      h += '</div>';
    }
    h += '</div>';
    return h;
  }

  /* ── Sparkline ───────────────────────────────────────────────────────── */
  function sparkline(values, o) {
    values = (values || []).map(num);
    o = o || {};
    var W = 260, H = 64, x0 = 4, w = 252, top = 6, hh = 52;
    var color = safeColor(o.color, BLEU);
    var dotColor = safeColor(o.dotColor, o.color ? color : CARMIN);
    var max = o.max != null ? o.max : Math.max.apply(null, values.concat([1]));
    var min = o.min != null ? o.min : 0;
    var span = (max - min) || 1;
    var n = values.length;
    var pts = values.map(function (v, i) {
      return [n > 1 ? x0 + i * (w / (n - 1)) : x0 + w / 2, top + hh - ((v - min) / span) * hh];
    });
    var line = pts.map(function (p) { return p[0].toFixed(1) + ',' + p[1].toFixed(1); }).join(' ');
    var last = pts[n - 1];
    var vmin = n ? Math.min.apply(null, values) : 0, vmax = n ? Math.max.apply(null, values) : 0;
    var aria = (o.label || 'Évolution') + ' : ' + n + ' valeurs, de ' + fmtN(vmin) + ' à ' + fmtN(vmax) +
      (n ? ', dernière valeur ' + fmtN(values[n - 1]) : '');
    var size = o.width ? ' width="' + o.width + '"' + (o.height ? ' height="' + o.height + '"' : '') : '';
    var s = '<svg class="pro-chart-spark' + (o.width ? ' pro-chart-spark--fixed' : '') + '" viewBox="0 0 ' + W + ' ' + H + '"' + size +
      ' role="img" aria-label="' + attr(aria) + '" focusable="false">';
    if (n > 1) {
      if (o.area !== false && !o.color) s += '<polygon points="' + x0 + ',' + (top + hh) + ' ' + line + ' ' + (x0 + w) + ',' + (top + hh) + '" fill="#E6E8F7"/>';
      s += '<polyline points="' + line + '" fill="none" stroke="' + color + '" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>';
    }
    if (last && o.dot !== false) s += '<circle cx="' + last[0].toFixed(1) + '" cy="' + last[1].toFixed(1) + '" r="4" fill="' + dotColor + '" stroke="#fff" stroke-width="2"/>';
    return s + '</svg>';
  }

  /* ── Mini-histogramme (une ligne de tableau) ─────────────────────────── */
  function miniBars(values, o) {
    values = (values || []).map(num);
    o = o || {};
    var color = safeColor(o.color, BLEU);
    var lastColor = o.lastColor === false ? color : safeColor(o.lastColor, BLEU_CLAIR);
    var max = o.max || Math.max.apply(null, values.concat([1]));
    var labels = o.labels || [];
    var aria = (o.title || 'Valeurs') + ' : ' + values.map(function (v, i) {
      return fmtN(v) + (labels[i] ? ' en ' + labels[i] : '');
    }).join(', ');
    var h = '<span class="pro-chart-minibars" role="img" aria-label="' + attr(aria) + '">';
    values.forEach(function (v, i) {
      var isLast = i === values.length - 1;
      var hgt = v === 0 ? '2px' : Math.max(10, Math.round(v / max * 100)) + '%';
      h += '<span style="height:' + hgt + ';--c:' + (isLast ? lastColor : color) + '"></span>';
    });
    return h + '</span>';
  }

  /* ── Anneau d'avancement (conic-gradient) ────────────────────────────── */
  /* segments : [{value, color, label?}] ; `total` = valeur qui représente 100 %
     (par défaut la somme). Le chiffre central par défaut = part du 1er segment. */
  function ring(segments, o) {
    segments = segments || [];
    o = o || {};
    var size = o.size || 120;
    var total = o.total || segments.reduce(function (a, s) { return a + num(s.value); }, 0) || 1;
    var thickness = o.thickness || Math.round(size * 0.12);
    var track = safeColor(o.track, '#EFEBE2');
    var stops = [], acc = 0;
    segments.forEach(function (s) {
      var p = Math.max(0, Math.min(100 - acc, num(s.value) / total * 100));
      if (p <= 0) return;
      var c = safeColor(s.color, BLEU);
      stops.push(c + ' ' + css(acc) + '% ' + css(acc + p) + '%');
      acc += p;
    });
    if (acc < 100) stops.push(track + ' ' + css(acc) + '% 100%');
    var first = segments[0] ? num(segments[0].value) / total : 0;
    var center = o.label != null ? o.label : fmtPct(first, 0);
    var aria = o.ariaLabel || ((o.sub ? o.sub + ' : ' : '') + (o.label != null ? o.label : fmtPct(first, 0)) +
      (segments.length > 1 || (segments[0] && segments[0].label)
        ? ' (' + segments.map(function (s) { return (s.label ? s.label + ' ' : '') + fmtPct(num(s.value) / total, 0); }).join(', ') + ')' : ''));
    return '<div class="pro-chart-ring" role="img" aria-label="' + attr(aria) + '" style="--s:' + size + 'px;--t:' + thickness + 'px">' +
      '<span class="pro-chart-ring__disc" style="--bg:conic-gradient(from 0deg, ' + stops.join(', ') + ')"></span>' +
      '<span class="pro-chart-ring__txt" aria-hidden="true"><span class="pro-chart-ring__big">' + esc(center) + '</span>' +
      (o.sub ? '<span class="pro-chart-ring__sub">' + esc(o.sub) + '</span>' : '') + '</span></div>';
  }

  /* ── Calendrier thermique (jours × semaines) ─────────────────────────── */
  var MONTHS = ['janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin', 'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.'];
  function parseDay(s) {                    // 'YYYY-MM-DD' → ms UTC à minuit
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s || '');
    return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) : NaN;
  }
  function dayKey(ms) {
    var d = new Date(ms);
    return d.getUTCFullYear() + '-' + ('0' + (d.getUTCMonth() + 1)).slice(-2) + '-' + ('0' + d.getUTCDate()).slice(-2);
  }
  function frDate(ms) {
    var d = new Date(ms);
    return ('0' + d.getUTCDate()).slice(-2) + '/' + ('0' + (d.getUTCMonth() + 1)).slice(-2) + '/' + d.getUTCFullYear();
  }

  /* days : [{date:'2026-10-09', value}] */
  function heatmapCalendar(days, o) {
    days = days || [];
    o = o || {};
    var weeks = o.weeks || 12;
    var byDay = {}, max = 0, total = 0, bestKey = null, endMs = NaN;
    days.forEach(function (d) {
      var k = String(d.date).slice(0, 10), ms = parseDay(k);
      if (isNaN(ms)) return;
      var v = num(d.value);
      byDay[k] = (byDay[k] || 0) + v;
      if (isNaN(endMs) || ms > endMs) endMs = ms;
    });
    Object.keys(byDay).forEach(function (k) {
      total += byDay[k];
      if (byDay[k] > max) { max = byDay[k]; bestKey = k; }
    });
    if (o.end) endMs = parseDay(o.end);
    if (isNaN(endMs)) { var t = new Date(); endMs = Date.UTC(t.getFullYear(), t.getMonth(), t.getDate()); }
    var DAY = 86400000;
    var endDow = (new Date(endMs).getUTCDay() + 6) % 7;          // lundi = 0
    var startMs = endMs - endDow * DAY - (weeks - 1) * 7 * DAY;  // lundi de la 1re semaine
    var unit = o.unit ? ' ' + o.unit : '';
    var active = Object.keys(byDay).filter(function (k) { return byDay[k] > 0; }).length;

    var aria = (o.title ? o.title + ' : ' : 'Activité par jour : ') + active + ' jour' + (active > 1 ? 's' : '') + ' avec activité sur ' + weeks + ' semaines, ' +
      fmtN(total) + unit + ' au total' + (bestKey ? ', maximum ' + fmtN(max) + unit + ' le ' + frDate(parseDay(bestKey)) : '');

    var months = '', cells = '', prevMonth = -1;
    for (var w = 0; w < weeks; w++) {
      var monMs = startMs + w * 7 * DAY;
      var mo = new Date(monMs).getUTCMonth();
      months += '<span>' + (mo !== prevMonth && (w === 0 || new Date(monMs).getUTCDate() <= 7) ? MONTHS[mo] : '') + '</span>';
      prevMonth = mo;
      for (var d = 0; d < 7; d++) {
        var ms = monMs + d * DAY;
        if (ms > endMs) { cells += '<span class="pro-chart-cal__cell is-out"></span>'; continue; }
        var k = dayKey(ms), v = byDay[k] || 0;
        var lvl = v <= 0 || max <= 0 ? 0 : (v / max <= 0.25 ? 1 : v / max <= 0.5 ? 2 : v / max <= 0.75 ? 3 : 4);
        cells += '<span class="pro-chart-cal__cell' + (lvl ? ' l' + lvl : '') + '" data-tip="' + attr(frDate(ms) + '\n' + fmtN(v) + unit) + '"></span>';
      }
    }
    return chartOpen(aria) + '<div class="pro-chart-cal__scroll"><div class="pro-chart-cal" style="--weeks:' + weeks + '">' +
      '<span></span><div class="pro-chart-cal__months" aria-hidden="true">' + months + '</div>' +
      '<div class="pro-chart-cal__days" aria-hidden="true"><span>lun.</span><span></span><span>mer.</span><span></span><span>ven.</span><span></span><span></span></div>' +
      '<div class="pro-chart-cal__grid">' + cells + '</div></div></div>' +
      '<div class="pro-chart-cal__legend" aria-hidden="true">moins <i style="background:var(--pro-cal0)"></i><i style="background:var(--pro-cal1)"></i>' +
      '<i style="background:var(--pro-cal2)"></i><i style="background:var(--pro-cal3)"></i><i style="background:var(--pro-cal4)"></i> plus</div></div>';
  }

  /* ── Nuage de points ─────────────────────────────────────────────────── */
  /* points : [{x, y, color?, tip?, id?}] — des div positionnés en %. */
  function scatter(points, o) {
    points = points || [];
    o = o || {};
    var height = o.height || 260;
    var xs = points.map(function (p) { return num(p.x); }), ys = points.map(function (p) { return num(p.y); });
    var xDom = o.xDomain || [0, Math.max.apply(null, xs.concat([1]))];
    var yDom = o.yDomain || [0, Math.max.apply(null, ys.concat([1]))];
    var sqrt = o.yScale === 'sqrt';
    var xt = niceTicks(xDom[1] - xDom[0], 5, false);
    function px(x) { return Math.max(0, Math.min(100, (x - xDom[0]) / ((xDom[1] - xDom[0]) || 1) * 100)); }
    function py(y) {
      var a = Math.max(0, y - yDom[0]), b = (yDom[1] - yDom[0]) || 1;
      return Math.max(0, Math.min(100, (sqrt ? Math.sqrt(a) / Math.sqrt(b) : a / b) * 100));
    }
    /* Graduation Y : « ronde » en linéaire ; en racine carrée, valeurs 1-2-5
       suffisamment espacées à l'écran pour ne pas se chevaucher. */
    var yTicks = [];
    if (sqrt) {
      var mags = [0, 1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000, 50000, 100000];
      var lastPos = -100;
      mags.forEach(function (v) {
        if (v < yDom[0] || v > yDom[1]) return;
        var pos = py(v);
        if (pos - lastPos >= 11) { yTicks.push(v); lastPos = pos; }
      });
    } else {
      yTicks = niceTicks(yDom[1] - yDom[0], 5, false).ticks.filter(function (v) { return v + yDom[0] <= yDom[1] + 1e-9; }).map(function (v) { return v + yDom[0]; });
    }
    var hi = o.highlight, hiFn = null;
    if (typeof hi === 'function') hiFn = hi;
    else if (Array.isArray(hi)) { var set = {}; hi.forEach(function (id) { set[id] = 1; }); hiFn = function (p) { return p.id != null && set[p.id] === 1; }; }

    var nHi = hiFn ? points.filter(function (p, i) { return hiFn(p, i); }).length : 0;
    var aria = (o.title ? o.title + ' : ' : 'Nuage de points : ') + fmtN(points.length) + ' points' +
      (o.xLabel ? ', ' + o.xLabel + ' en abscisse' : '') + (o.yLabel ? ', ' + o.yLabel + ' en ordonnée' : '') +
      (hiFn ? ', dont ' + fmtN(nHi) + ' mis en évidence' : '');
    var focusable = points.length <= 80;

    var h = chartOpen(aria);
    if (o.yLabel) h += '<div class="pro-chart-scatter__yl" aria-hidden="true">' + esc(o.yLabel) + '</div>';
    h += '<div class="pro-chart-scatter" style="--h:' + height + 'px">';
    h += '<div class="pro-chart-scatter__y" aria-hidden="true">';
    yTicks.forEach(function (v) { h += '<span style="bottom:' + css(py(v)) + '%">' + fmtN(v) + '</span>'; });
    h += '</div><div class="pro-chart-scatter__plot">';
    yTicks.forEach(function (v) { if (v > yDom[0]) h += '<span class="pro-chart-scatter__grid" aria-hidden="true" style="bottom:' + css(py(v)) + '%"></span>'; });
    points.forEach(function (p, i) {
      var cls = 'pro-chart-scatter__pt' + (hiFn ? (hiFn(p, i) ? ' is-hi' : ' is-dim') : '');
      var tip = p.tip;
      var tipHtml = tip ? (focusable ? tipAttrs(tip) : ' data-tip="' + attr(tip) + '"') : '';
      h += '<span class="' + cls + '" style="left:' + css(px(num(p.x))) + '%;bottom:' + css(py(num(p.y))) + '%' +
        (p.color ? ';--c:' + safeColor(p.color, BLEU) : '') + '"' + tipHtml + '></span>';
    });
    h += '</div><div class="pro-chart-scatter__x" aria-hidden="true">';
    xt.ticks.forEach(function (v) {
      var val = v + xDom[0];
      if (val <= xDom[1] + 1e-9) h += '<span style="left:' + css(px(val)) + '%">' + fmtN(val) + '</span>';
    });
    h += '</div>';
    if (o.xLabel) h += '<div class="pro-chart-scatter__xl" aria-hidden="true">' + esc(o.xLabel) + (sqrt ? ' · échelle racine carrée en ordonnée' : '') + '</div>';
    return h + '</div></div>';
  }

  /* ── Courbe de Lorenz (concentration) ────────────────────────────────── */
  function lorenz(values, o) {
    o = o || {};
    var v = (values || []).map(num).filter(function (x) { return x >= 0; }).sort(function (a, b) { return a - b; });
    var n = v.length, total = 0, i;
    for (i = 0; i < n; i++) total += v[i];
    var cum = new Float64Array(n + 1);
    for (i = 0; i < n; i++) cum[i + 1] = cum[i] + v[i];
    function L(p) {                       // part cumulée des prêts pour la fraction p d'exemplaires
      if (!n || !total) return p;
      var idx = p * n, lo = Math.floor(idx), f = idx - lo;
      var a = cum[lo], b = cum[Math.min(n, lo + 1)];
      return (a + (b - a) * f) / total;
    }
    var S = 100, pad = 24, steps = 100, d = '', area = 0, prev = 0, y;
    for (i = 0; i <= steps; i++) {
      var p = i / steps;
      y = L(p);
      d += (i ? 'L' : 'M') + css(pad + p * S) + ',' + css(S - y * S + 6) + ' ';
      if (i) area += (prev + y) / 2 / steps;
      prev = y;
    }
    var gini = Math.max(0, Math.min(1, 1 - 2 * area));
    var top10 = 1 - L(0.9);
    var aria = (o.title || 'Courbe de concentration') + ' : les 10' + NBSP + '% les plus empruntés représentent ' + fmtPct(top10, 0) +
      ' du total ; indice de Gini ' + fmtN(gini, 2);
    var x0 = pad, y0 = S + 6, x1 = pad + S, y1 = 6;
    var s = chartOpen(aria) +
      '<svg class="pro-chart-lorenz" viewBox="0 0 ' + (pad + S + 10) + ' ' + (S + 34) + '" focusable="false" aria-hidden="true">' +
      '<line x1="' + x0 + '" y1="' + y0 + '" x2="' + x1 + '" y2="' + y1 + '" stroke="#C9C4B8" stroke-width="1" stroke-dasharray="3 3"/>' +
      '<path d="' + d + '" fill="rgba(42,60,212,0.12)" stroke="' + BLEU + '" stroke-width="2" stroke-linejoin="round"/>' +
      '<path d="M' + x0 + ',' + y1 + ' L' + x0 + ',' + y0 + ' L' + x1 + ',' + y0 + '" fill="none" stroke="#6B6B7B" stroke-width="1"/>' +
      '<text x="' + (x0 - 4) + '" y="' + (y0 + 3) + '" text-anchor="end">0</text>' +
      '<text x="' + (x0 - 4) + '" y="' + (y1 + 3) + '" text-anchor="end">100' + NBSP + '%</text>' +
      '<text x="' + x1 + '" y="' + (y0 + 12) + '" text-anchor="end">100' + NBSP + '%</text>' +
      '<text x="' + (x0 + S / 2) + '" y="' + (y0 + 22) + '" text-anchor="middle">part des exemplaires, du moins au plus emprunté</text>' +
      '</svg>' +
      '<div class="pro-chart__caption">Les 10' + NBSP + '% les plus empruntés concentrent <strong>' + esc(fmtPct(top10, 0)) + '</strong> du total · indice de Gini <strong>' + esc(fmtN(gini, 2)) + '</strong>.</div></div>';
    return s;
  }

  /* ── Infobulle déléguée ──────────────────────────────────────────────── */
  function attachTooltips(rootEl) {
    if (!rootEl || rootEl.__rpTips) return;
    rootEl.__rpTips = true;
    var tip = null, current = null;
    var seq = 0;

    function hide() {
      if (tip) tip.classList.remove('is-on');
      if (current && current.removeAttribute) current.removeAttribute('aria-describedby');
      current = null;
    }

    function show(target) {
      var chart = target.closest('.pro-chart');
      if (!chart) return;
      if (!tip || tip.parentNode !== chart) {
        if (tip && tip.parentNode) tip.parentNode.removeChild(tip);
        tip = chart.querySelector(':scope > .pro-chart-tip');
        if (!tip) {
          tip = document.createElement('div');
          tip.className = 'pro-chart-tip';
          tip.setAttribute('role', 'tooltip');
          tip.id = 'pro-chart-tip-' + (++seq) + '-' + Math.floor(Math.random() * 1e6);
          chart.appendChild(tip);
        }
      }
      var lines = String(target.getAttribute('data-tip') || '').split('\n');
      tip.textContent = '';
      var title = document.createElement('span');
      title.className = 'pro-chart-tip__title';
      title.textContent = lines[0];
      tip.appendChild(title);
      for (var i = 1; i < lines.length; i++) {
        var l = document.createElement('span');
        l.style.display = 'block';
        l.textContent = lines[i];
        tip.appendChild(l);
      }
      current = target;
      target.setAttribute('aria-describedby', tip.id);
      tip.classList.add('is-on');
      /* Position : au-dessus de la cible, centré, dans les limites du conteneur ;
         sous la cible s'il n'y a pas de place en haut. */
      var cr = chart.getBoundingClientRect(), tr = target.getBoundingClientRect();
      var tw = tip.offsetWidth, th = tip.offsetHeight;
      var left = tr.left + tr.width / 2 - cr.left - tw / 2;
      left = Math.max(0, Math.min(left, cr.width - tw));
      var top = tr.top - cr.top - th - 8;
      if (top < 0) top = tr.bottom - cr.top + 8;
      tip.style.left = Math.round(left) + 'px';
      tip.style.top = Math.round(top) + 'px';
    }

    function targetOf(ev) { return ev.target && ev.target.closest ? ev.target.closest('[data-tip]') : null; }

    rootEl.addEventListener('mouseover', function (ev) {
      var t = targetOf(ev);
      if (t && rootEl.contains(t) && t !== current) show(t);
    });
    rootEl.addEventListener('mouseout', function (ev) {
      var t = targetOf(ev);
      if (!t) return;
      var to = ev.relatedTarget;
      if (to && t.contains(to)) return;
      if (t === current) hide();
    });
    rootEl.addEventListener('focusin', function (ev) { var t = targetOf(ev); if (t && rootEl.contains(t)) show(t); });
    rootEl.addEventListener('focusout', function (ev) { if (targetOf(ev) === current) hide(); });
    rootEl.addEventListener('keydown', function (ev) { if (ev.key === 'Escape') hide(); });
    /* Défilement ou redimensionnement : l'infobulle ne suivrait plus sa cible. */
    window.addEventListener('resize', hide);
  }

  global.rpCharts = {
    bars: bars,
    hbars: hbars,
    stacked: stacked,
    sparkline: sparkline,
    miniBars: miniBars,
    ring: ring,
    heatmapCalendar: heatmapCalendar,
    scatter: scatter,
    lorenz: lorenz,
    attachTooltips: attachTooltips,
    niceTicks: niceTicks,
    esc: esc,
    PLAN: PLAN,
    DECISION: DECISION,
    DECISION_ORDER: DECISION_ORDER,
    PRETS: PRETS
  };
})(window);
