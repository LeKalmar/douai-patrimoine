/* ============================================================================
   js/admin-ui.js — composants d'interface partagés des outils pro (window.rpUI)

   Script classique, sans dépendance. À charger après css/admin.css :
     <script src="js/admin-ui.js"></script>   (sans defer : le script de la page l'utilise)

     rpUI.toast(message, {type, action:{label,onClick}, timeout})
     rpUI.confirmInline(anchorEl, message, {okLabel, cancelLabel, danger}) → Promise<boolean>
     rpUI.tabs(rootEl, {hashPrefix}) → {select(id), current()}
     rpUI.help(detailsEl, key)
     rpUI.fmt.n / pct / date / time / ago
     rpUI.esc(s)
     rpUI.icon(name, {size, stroke}) / rpUI.icons

   Contraintes d'intégration en iframe (voir CLAUDE.md) : sous html.rp-embedded,
   rien n'est positionné en `fixed` — le conteneur de toasts est inséré dans le
   flux, juste sous l'en-tête de la page.
   ========================================================================== */
(function (global) {
  'use strict';

  var doc = global.document;
  var NNBSP = ' ';   // espace insécable (séparateur de milliers) — U+202F (fine) ne s'affiche pas avec DM Sans / Moret
  var NBSP = ' ';    // espace insécable (avant « % »)

  /* ── Utilitaires ─────────────────────────────────────────────────────── */
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function isEmbedded() {
    if (global.rpEmbed && typeof global.rpEmbed.isEmbedded === 'boolean') return global.rpEmbed.isEmbedded;
    return !!(doc.documentElement && doc.documentElement.classList.contains('rp-embedded'));
  }

  function lsGet(key) { try { return global.localStorage.getItem(key); } catch (e) { return null; } }
  function lsSet(key, val) { try { global.localStorage.setItem(key, val); } catch (e) { /* stockage indisponible */ } }

  function refreshHeight() { if (global.rpEmbed && global.rpEmbed.refresh) global.rpEmbed.refresh(); }

  /* ── Icônes (SVG à trait, comme le reste du kit) ─────────────────────── */
  var ICONS = {
    check: 'M5 12l4 4 10-10',
    checkCircle: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z M8 12l3 3 5-6',
    warn: 'M12 4l9 16H3z M12 10v4 M12 17h.01',
    error: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z M9 9l6 6 M15 9l-6 6',
    info: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z M12 11v5 M12 8h.01',
    x: 'M6 6l12 12 M18 6L6 18',
    plus: 'M6 12h12 M12 6v12',
    minus: 'M6 12h12',
    chevDown: 'M6 9l6 6 6-6',
    chevLeft: 'M15 6l-6 6 6 6',
    chevRight: 'M9 6l6 6-6 6',
    arrow: 'M5 12h14 M13 6l6 6-6 6',
    arrowUp: 'M12 19V5 M6 11l6-6 6 6',
    arrowDown: 'M12 5v14 M6 13l6 6 6-6',
    search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14z M21 21l-5-5',
    download: 'M12 4v11 M7 11l5 5 5-5 M5 20h14',
    edit: 'M4 20h4L19 9l-4-4L4 16z M13 7l4 4',
    refresh: 'M21 12a9 9 0 0 1-15.5 6.2 M3 12A9 9 0 0 1 18.5 5.8 M18 2v4h-4 M6 22v-4h4',
    tag: 'M20 12l-8 8-9-9V3h8z M7.5 7.5h.01',
    swap: 'M4 8h14 M14 4l4 4-4 4 M20 16H6 M10 12l-4 4 4 4',
    book: 'M4 5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2z M4 19V5',
    clock: 'M12 7v5l3 2 M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z',
    box: 'M3 7l9-4 9 4v10l-9 4-9-4z M3 7l9 4 9-4 M12 11v10',
    scan: 'M3 7V5a2 2 0 0 1 2-2h2 M17 3h2a2 2 0 0 1 2 2v2 M21 17v2a2 2 0 0 1-2 2h-2 M7 21H5a2 2 0 0 1-2-2v-2 M7 8v8 M11 8v8 M15 8v8 M18 8v8',
    map: 'M3 5l6-2 6 2 6-2v16l-6 2-6-2-6 2z M9 3v16 M15 5v16',
    link: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1 M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1',
    cycle: 'M21 12a9 9 0 0 1-15.5 6.2 M3 12A9 9 0 0 1 18.5 5.8 M18 2v4h-4 M6 22v-4h4',
    clipboard: 'M9 4h6v3H9z M7 5H5v16h14V5h-2 M9 14l2 2 4-4',
    columns: 'M4 20V10 M10 20V4 M16 20v-7 M22 20H2',
    shelf: 'M4 4h6v16H4z M12 4h4v16h-4z M18 5l3 .8-3.4 14.3-2.6-.6',
    hash: 'M5 9h14 M5 15h14 M10 3L8 21 M16 3l-2 18',
    lock: 'M5 11h14v10H5z M8 11V7a4 4 0 0 1 8 0v4',
    crop: 'M6 2v14a2 2 0 0 0 2 2h14 M2 6h14a2 2 0 0 1 2 2v14',
    file: 'M6 2h9l5 5v15H6z M14 2v6h6 M9 13h8 M9 17h8',
    globe: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z M3 12h18 M12 3c3 3 3 15 0 18 M12 3c-3 3-3 15 0 18',
    route: 'M6 19a2 2 0 1 0 0-4 2 2 0 0 0 0 4z M18 9a2 2 0 1 0 0-4 2 2 0 0 0 0 4z M8 17h6a3 3 0 0 0 0-6h-4a3 3 0 0 1 0-6h6'
  };

  function icon(name, opts) {
    opts = opts || {};
    var size = opts.size || 18;
    var d = ICONS[name] || ICONS.info;
    return '<svg width="' + size + '" height="' + size + '" viewBox="0 0 24 24" fill="none" stroke="currentColor"' +
      ' stroke-width="' + (opts.stroke || 2) + '" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"' +
      ' focusable="false"><path d="' + d + '"/></svg>';
  }

  /* ── Formats ─────────────────────────────────────────────────────────── */
  function pad2(n) { return n < 10 ? '0' + n : String(n); }

  function toDate(ts) {
    if (ts == null || ts === '') return null;
    var d = ts instanceof Date ? ts : new Date(ts);
    return isNaN(d.getTime()) ? null : d;
  }

  var fmt = {
    /* 1234567 → « 1 234 567 » (espaces insécables). `decimals` fixe le
       nombre de décimales (virgule française). */
    n: function (value, decimals) {
      if (value == null || value === '' || !isFinite(Number(value))) return '—';
      var v = Number(value);
      var neg = v < 0;
      var fixed = Math.abs(v).toFixed(decimals || 0).split('.');
      var intPart = fixed[0].replace(/\B(?=(\d{3})+(?!\d))/g, NNBSP);
      return (neg ? '−' : '') + intPart + (fixed[1] ? ',' + fixed[1] : '');
    },
    /* 0.613 → « 61 % » (la fraction est 0–1). */
    pct: function (fraction, decimals) {
      if (fraction == null || !isFinite(Number(fraction))) return '—';
      return fmt.n(Number(fraction) * 100, decimals || 0) + NBSP + '%';
    },
    /* → « 09/10/2026 » (heure locale) */
    date: function (ts) {
      var d = toDate(ts);
      return d ? pad2(d.getDate()) + '/' + pad2(d.getMonth() + 1) + '/' + d.getFullYear() : '—';
    },
    /* → « 14:02 » */
    time: function (ts) {
      var d = toDate(ts);
      return d ? pad2(d.getHours()) + ':' + pad2(d.getMinutes()) : '—';
    },
    /* → « il y a 5 min » */
    ago: function (ts, now) {
      var d = toDate(ts);
      if (!d) return '—';
      var diff = ((now == null ? Date.now() : now) - d.getTime()) / 1000;
      if (diff < 0) diff = 0;
      if (diff < 45) return 'à l’instant';
      var min = Math.round(diff / 60);
      if (min < 60) return 'il y a ' + min + ' min';
      var h = Math.round(diff / 3600);
      if (h < 24) return 'il y a ' + h + ' h';
      var days = Math.round(diff / 86400);
      if (days === 1) return 'hier';
      if (days < 30) return 'il y a ' + days + ' j';
      return fmt.date(d);
    }
  };

  /* ── Toasts ──────────────────────────────────────────────────────────── */
  var toastHost = null;

  function ensureToastHost() {
    var embedded = isEmbedded();
    if (!toastHost || !toastHost.isConnected) {
      toastHost = doc.createElement('div');
      toastHost.className = 'pro-toasts';
      toastHost.setAttribute('aria-live', 'polite');
      toastHost.setAttribute('aria-relevant', 'additions text');
    }
    /* En iframe : dans le flux, juste sous l'en-tête (ou en tête de page).
       Ailleurs : en fin de <body>, ancré par le CSS (position fixe). */
    var wantAfter = embedded ? (doc.querySelector('.pro-head') || null) : null;
    if (embedded) {
      if (wantAfter) {
        if (toastHost.previousElementSibling !== wantAfter) wantAfter.insertAdjacentElement('afterend', toastHost);
      } else if (toastHost.parentNode !== doc.body || doc.body.firstElementChild !== toastHost) {
        doc.body.insertBefore(toastHost, doc.body.firstChild);
      }
    } else if (toastHost.parentNode !== doc.body) {
      doc.body.appendChild(toastHost);
    }
    return toastHost;
  }

  var TOAST_ICON = { ok: 'checkCircle', warn: 'warn', error: 'error', info: 'info' };

  function toast(message, opts) {
    opts = opts || {};
    var type = TOAST_ICON[opts.type] ? opts.type : 'info';
    var host = ensureToastHost();
    var el = doc.createElement('div');
    el.className = 'pro-toast pro-toast--' + type;
    el.setAttribute('role', type === 'error' ? 'alert' : 'status');

    var html = '<span class="pro-toast__icon">' + icon(TOAST_ICON[type], { size: 20, stroke: 2.2 }) + '</span>' +
      '<span class="pro-toast__msg"></span>';
    el.innerHTML = html;
    var msg = el.querySelector('.pro-toast__msg');
    /* `message` est du texte brut. Pour un titre en gras : {title, text}. */
    if (message && typeof message === 'object') {
      if (message.title) { var st = doc.createElement('strong'); st.textContent = message.title + ' '; msg.appendChild(st); }
      msg.appendChild(doc.createTextNode(message.text || ''));
    } else {
      msg.textContent = message == null ? '' : String(message);
    }

    var timer = null;
    function close() {
      if (timer) { clearTimeout(timer); timer = null; }
      if (el.parentNode) el.parentNode.removeChild(el);
      refreshHeight();
    }

    if (opts.action && opts.action.label) {
      var act = doc.createElement('button');
      act.type = 'button';
      act.className = 'pro-btn pro-btn--ghost pro-toast__action';
      act.textContent = opts.action.label;
      act.addEventListener('click', function () {
        try { if (typeof opts.action.onClick === 'function') opts.action.onClick(); } finally { close(); }
      });
      el.appendChild(act);
    } else {
      var x = doc.createElement('button');
      x.type = 'button';
      x.className = 'pro-btn pro-btn--ghost pro-btn--icon pro-toast__close';
      x.style.border = '0';
      x.setAttribute('aria-label', 'Fermer le message');
      x.innerHTML = icon('x', { size: 16, stroke: 2.4 });
      x.addEventListener('click', close);
      el.appendChild(x);
    }

    host.appendChild(el);
    /* En iframe, un message d'erreur ou d'alerte placé en haut de la page doit
       être amené sous les yeux du visiteur (scrollIntoView traverse la
       frontière d'iframe). */
    if (isEmbedded() && (type === 'error' || type === 'warn') && el.scrollIntoView) {
      try { el.scrollIntoView({ block: 'nearest' }); } catch (e) { /* ancien navigateur */ }
    }
    refreshHeight();

    var timeout = opts.timeout == null ? 5000 : opts.timeout;
    /* Un message avec action ou d'erreur reste un peu plus longtemps. */
    if (timeout > 0) timer = setTimeout(close, opts.action && opts.timeout == null ? 9000 : timeout);
    return { close: close, element: el };
  }

  /* ── Confirmation en ligne ───────────────────────────────────────────── */
  var openConfirms = [];

  function confirmInline(anchorEl, message, opts) {
    opts = opts || {};
    return new Promise(function (resolve) {
      /* Une seule confirmation par ancre : la précédente est annulée. */
      openConfirms = openConfirms.filter(function (c) {
        if (c.anchor === anchorEl) { c.finish(false, true); return false; }
        return true;
      });

      var bar = doc.createElement('div');
      bar.className = 'pro-confirm' + (opts.danger ? ' pro-confirm--danger' : '');
      bar.setAttribute('role', 'alertdialog');
      bar.setAttribute('aria-label', 'Confirmation');
      var msg = doc.createElement('span');
      msg.className = 'pro-confirm__msg';
      msg.textContent = message == null ? '' : String(message);
      var actions = doc.createElement('span');
      actions.className = 'pro-confirm__actions';
      var cancel = doc.createElement('button');
      cancel.type = 'button';
      cancel.className = 'pro-btn pro-btn--secondary';
      cancel.textContent = opts.cancelLabel || 'Annuler';
      var ok = doc.createElement('button');
      ok.type = 'button';
      ok.className = 'pro-btn ' + (opts.danger ? 'pro-btn--danger' : 'pro-btn--primary');
      ok.textContent = opts.okLabel || 'Confirmer';
      actions.appendChild(cancel);
      actions.appendChild(ok);
      bar.appendChild(msg);
      bar.appendChild(actions);

      /* Ancre dans un tableau : la barre devient une ligne pleine largeur. */
      var node = bar;
      if (anchorEl && anchorEl.tagName === 'TR') {
        var tr = doc.createElement('tr');
        var td = doc.createElement('td');
        td.colSpan = Math.max(1, anchorEl.children.length);
        td.appendChild(bar);
        tr.appendChild(td);
        node = tr;
      }

      var record = { anchor: anchorEl, finish: null };
      var done = false;
      function finish(value, silentFocus) {
        if (done) return;
        done = true;
        openConfirms = openConfirms.filter(function (c) { return c !== record; });
        if (node.parentNode) node.parentNode.removeChild(node);
        if (!silentFocus && anchorEl && anchorEl.isConnected && anchorEl.focus) {
          try { anchorEl.focus({ preventScroll: true }); } catch (e) { /* élément non focalisable */ }
        }
        refreshHeight();
        resolve(value);
      }
      record.finish = finish;
      openConfirms.push(record);

      cancel.addEventListener('click', function () { finish(false); });
      ok.addEventListener('click', function () { finish(true); });
      bar.addEventListener('keydown', function (ev) {
        if (ev.key === 'Escape') { ev.stopPropagation(); finish(false); }
      });

      if (anchorEl && anchorEl.insertAdjacentElement) anchorEl.insertAdjacentElement('afterend', node);
      else doc.body.appendChild(node);
      ok.focus();
      if (isEmbedded() && node.scrollIntoView) { try { node.scrollIntoView({ block: 'nearest' }); } catch (e) { /* ignoré */ } }
      refreshHeight();
    });
  }

  /* ── Onglets accessibles ─────────────────────────────────────────────── */
  /* Contrat : rootEl contient un [role="tablist"] dont les [role="tab"]
     désignent leur panneau soit par aria-controls (id), soit par data-tab
     (identifiant → élément [data-tab="…"] qui n'est pas un onglet, ou #id). Les panneaux
     peuvent être n'importe où dans le document (l'en-tête est souvent séparé
     du contenu). */
  function tabs(rootEl, opts) {
    opts = opts || {};
    var prefix = opts.hashPrefix || '';
    var list = rootEl.matches && rootEl.matches('[role="tablist"]') ? rootEl : rootEl.querySelector('[role="tablist"]');
    if (!list) return null;
    var tabEls = Array.prototype.slice.call(list.querySelectorAll('[role="tab"]'));
    if (!tabEls.length) return null;

    function idOf(tab, i) {
      return tab.getAttribute('data-tab') || tab.getAttribute('aria-controls') || ('tab' + i);
    }
    function panelOf(tab, id) {
      var cid = tab.getAttribute('aria-controls');
      return (cid && doc.getElementById(cid)) ||
        doc.querySelector('[data-tab="' + id + '"]:not([role="tab"])') ||
        doc.getElementById(id);
    }
    var items = tabEls.map(function (tab, i) {
      var id = idOf(tab, i);
      var panel = panelOf(tab, id);
      if (!tab.id) tab.id = 'rp-tab-' + id;
      if (panel) {
        if (!panel.id) panel.id = 'rp-panel-' + id;
        tab.setAttribute('aria-controls', panel.id);
        panel.setAttribute('role', 'tabpanel');
        panel.setAttribute('aria-labelledby', tab.id);
        panel.classList.add('pro-tabpanel');
      }
      return { id: id, tab: tab, panel: panel };
    });

    var currentId = null;

    function select(id, opt) {
      var item = items.filter(function (it) { return it.id === id; })[0] || items[0];
      var changed = item.id !== currentId;
      currentId = item.id;
      items.forEach(function (it) {
        var on = it === item;
        it.tab.setAttribute('aria-selected', on ? 'true' : 'false');
        it.tab.tabIndex = on ? 0 : -1;
        if (it.panel) it.panel.hidden = !on;
      });
      if (prefix && !(opt && opt.noHash)) {
        try { global.history.replaceState(null, '', '#' + prefix + item.id); } catch (e) { /* file:// */ }
      }
      if (changed) {
        rootEl.dispatchEvent(new CustomEvent('rp-tab-change', {
          bubbles: true, detail: { id: item.id, tab: item.tab, panel: item.panel }
        }));
        refreshHeight();
      }
      return item;
    }

    list.addEventListener('click', function (ev) {
      var t = ev.target.closest && ev.target.closest('[role="tab"]');
      if (!t || tabEls.indexOf(t) < 0) return;
      ev.preventDefault();
      select(idOf(t, tabEls.indexOf(t)));
    });
    list.addEventListener('keydown', function (ev) {
      var t = ev.target.closest && ev.target.closest('[role="tab"]');
      var i = tabEls.indexOf(t);
      if (i < 0) return;
      var to = -1;
      if (ev.key === 'ArrowRight') to = (i + 1) % tabEls.length;
      else if (ev.key === 'ArrowLeft') to = (i - 1 + tabEls.length) % tabEls.length;
      else if (ev.key === 'Home') to = 0;
      else if (ev.key === 'End') to = tabEls.length - 1;
      if (to < 0) return;
      ev.preventDefault();
      select(items[to].id);
      tabEls[to].focus();
    });

    function fromHash() {
      if (!prefix) return null;
      var h = (global.location.hash || '').replace(/^#/, '');
      if (h.indexOf(prefix) !== 0) return null;
      var id = decodeURIComponent(h.slice(prefix.length));
      return items.some(function (it) { return it.id === id; }) ? id : null;
    }
    if (prefix) {
      global.addEventListener('hashchange', function () {
        var id = fromHash();
        if (id && id !== currentId) select(id, { noHash: true });
      });
    }

    var initial = fromHash();
    if (!initial) {
      var pre = items.filter(function (it) { return it.tab.getAttribute('aria-selected') === 'true'; })[0];
      initial = (pre || items[0]).id;
    }
    select(initial, { noHash: true });

    return { select: function (id) { select(id); }, current: function () { return currentId; } };
  }

  /* ── Aide repliable : mémorise ouvert/fermé ──────────────────────────── */
  function help(detailsEl, key) {
    if (!detailsEl || !key) return;
    var storageKey = 'rp_help_' + key;
    var saved = lsGet(storageKey);
    if (saved === '1') detailsEl.open = true;
    else if (saved === '0') detailsEl.open = false;
    detailsEl.addEventListener('toggle', function () {
      lsSet(storageKey, detailsEl.open ? '1' : '0');
      refreshHeight();
    });
  }

  global.rpUI = {
    toast: toast,
    confirmInline: confirmInline,
    tabs: tabs,
    help: help,
    fmt: fmt,
    esc: esc,
    icon: icon,
    icons: ICONS
  };
})(window);
