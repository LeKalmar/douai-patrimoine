/* ════════════════════════════════════════════════════════════
   Bibliothèque virtuelle — Réserve patrimoniale de Douai
   Organisation : étagères fictives par fonds (930$e)
   et sous-collections par thème (930$e_12)
   ════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  /* ──────────────────────────────────────────────────────────
     Configuration
  ────────────────────────────────────────────────────────── */
  const CSV_PATH      = 'csv/inventaire.csv';
  const MANIFEST_PATH = 'js/manifest.json';
  const IMAGES_ROOT   = 'https://pub-85062da5f8a7451b9c168f8b3cfd980b.r2.dev/';

  const PX_PER_CM  = 4.5;
  const MIN_HEIGHT = 36;
  const MAX_HEIGHT = 280;
  const MIN_WIDTH  = 8;
  const MAX_WIDTH  = 38;

  /* Métadonnées éditoriales des fonds — descriptions et icônes pour le grand public */
  const FONDS_META = {
    'Généalogie':                  { icon:'<i class="fa-solid fa-code-fork"></i>',     desc:'Ouvrages réunissant des informations généalogiques. Blasons, arbres, histoire de familles.' },
    'Religion':                    { icon:'<i class="fa-solid fa-book-bible"></i>',    desc:'' },
    'Marceline Desbordes-Valmore': { icon:'<i class="fa-solid fa-feather"></i>',       desc:'' },
    'Photographie':                { icon:'<i class="fa-solid fa-camera"></i>',        desc:'' },
    'Numismatique':                { icon:'<i class="fa-solid fa-coins"></i>',         desc:'' },
    'Cartographie':                { icon:'<i class="fa-solid fa-map"></i>',           desc:'' },
    'Iconographie':                { icon:'<i class="fa-solid fa-images"></i>',        desc:'' },
    'Réserve Douaisienne':         { icon:'<i class="fa-solid fa-scroll"></i>',        desc:'' },
    'Protestantisme':              { icon:'<i class="fa-solid fa-cross"></i>',         desc:'' },
    'Objets':                      { icon:'<i class="fa-solid fa-box-archive"></i>',   desc:'' },
  };

  function fondsIcon(fonds) {
    return (FONDS_META[fonds] || { icon: '<i class="fa-solid fa-book"></i>' }).icon;
  }
  function fondsDesc(fonds) {
    return (FONDS_META[fonds] || { desc: '' }).desc;
  }

  /* ──────────────────────────────────────────────────────────
     État global
  ────────────────────────────────────────────────────────── */
  let allRecords  = [];
  let manifest    = null;
  let bookIndex   = new Map();   // num → {name, pages:[{path,name}]}
  let fondsData   = new Map();   // fonds → Map<themeKey → [records]>

  let currentFonds    = null;   // null = hall
  let currentThemeIdx = 0;      // index dans la liste triée des thèmes du fonds courant
  let currentRowPage  = 0; 

  // Modale
  let modalCurrentPages = [];
  let modalPageIdx      = 0;

  /* ──────────────────────────────────────────────────────────
     Démarrage
  ────────────────────────────────────────────────────────── */
  function start() {
    waitFor(() => typeof window.Papa !== 'undefined', loadData,
      () => showFatalError('PapaParse n\'a pas pu être chargé. Vérifiez votre connexion.'));
  }
  function waitFor(test, ok, ko, n) {
    n = n || 0;
    if (test()) return ok();
    if (n > 60)  return ko();
    setTimeout(() => waitFor(test, ok, ko, n + 1), 100);
  }

  function loadData() {
    Promise.all([
      new Promise((res, rej) => Papa.parse(CSV_PATH, {
        download: true, header: true, delimiter: ';',
        encoding: 'ISO-8859-1', skipEmptyLines: true,
        complete: r => res(r.data), error: e => rej(e)
      })),
      fetch(MANIFEST_PATH).then(r => r.ok ? r.json() : null).catch(() => null)
    ])
    .then(([rows, manif]) => {
      allRecords = rows;
      // Affecter un __id stable à chaque notice (nécessaire même sans localisation physique)
      allRecords.forEach((row, i) => { row.__id = i; });
      manifest = manif;
      if (manif) buildBookIndex(manif);
      buildFondsIndex();
      buildNav();
      renderHall();
      bindSearch();
    })
    .catch(err => showFatalError('Erreur de chargement : ' + (err?.message || err)));
  }

  function showFatalError(msg) {
    document.getElementById('stage').innerHTML = `
      <div class="loader-state">
        <h2 style="color:#ffb3a8">Impossible d'ouvrir la réserve</h2>
        <p>${escapeHtml(msg)}</p>
      </div>`;
  }

  /* ──────────────────────────────────────────────────────────
     Index manifest (inchangé)
  ────────────────────────────────────────────────────────── */
  function buildBookIndex(node) {
    if (!node) return;
    if (node.type === 'book') {
      bookIndex.set(normalizeNum(node.name), {
        name: node.name,
        pages: (node.pages || []).map(p => ({ path: p.path, name: p.name || '' }))
      });
    } else if (node.type === 'folder') {
      const ch = node.children || [];
      if (ch.length && ch.every(c => c.type === 'image')) {
        bookIndex.set(normalizeNum(node.name), {
          name: node.name, pages: ch.map(c => ({ path: c.path, name: c.name || '' }))
        });
      }
      ch.forEach(buildBookIndex);
    }
  }
  function normalizeNum(s) { return String(s || '').trim().toLowerCase().replace(/\s+/g, ''); }

  /* ──────────────────────────────────────────────────────────
     Index par fonds et thème
     fondsData : Map< fonds_name → Map< themeKey → [records] > >
     themeKey = '__general__' quand 930$e_12 est absent
  ────────────────────────────────────────────────────────── */
  function buildFondsIndex() {
    fondsData = new Map();
    allRecords.forEach(row => {
      const fonds = (row['930$e_11'] || '').trim();
      if (!fonds || fonds === 'NULL') return;
      const theme = (row['930$e_12'] || '').trim() || '__general__';
      if (!fondsData.has(fonds)) fondsData.set(fonds, new Map());
      const tm = fondsData.get(fonds);
      if (!tm.has(theme)) tm.set(theme, []);
      tm.get(theme).push(row);
    });
    // Trier chaque groupe par cote
    fondsData.forEach(themeMap => {
      themeMap.forEach(recs => recs.sort((a, b) => compareCotes(a['930$g'] || '', b['930$g'] || '')));
    });
  }

  /* Renvoie la liste triée des thèmes d'un fonds sous forme :
     [{key, label, records}]
     '__general__' en premier, puis les autres par nombre de docs décroissant */
  function getThemeList(fonds) {
    const themeMap = fondsData.get(fonds);
    if (!themeMap) return [];
    const list = [...themeMap.entries()].map(([key, records]) => ({
      key, records,
      label: key === '__general__' ? 'Tous les documents' : key
    }));
    list.sort((a, b) => {
      if (a.key === '__general__') return -1;
      if (b.key === '__general__') return 1;
      return b.records.length - a.records.length;
    });
    return list;
  }

  function countFonds(fonds) {
    const tm = fondsData.get(fonds);
    if (!tm) return 0;
    let n = 0;
    tm.forEach(recs => n += recs.length);
    return n;
  }
  function countNumInFonds(fonds) {
    const tm = fondsData.get(fonds);
    if (!tm) return 0;
    let n = 0;
    tm.forEach(recs => recs.forEach(r => { if ((r['num'] || '').trim()) n++; }));
    return n;
  }

  /* ──────────────────────────────────────────────────────────
     Navigation — barre de fonds
  ────────────────────────────────────────────────────────── */
  function buildNav() {
    const tabs  = document.getElementById('travee-tabs');
    const label = document.getElementById('travee-nav-label');
    tabs.innerHTML = '';
    if (label) label.textContent = 'Choisir une collection';

    // Bouton Hall
    const home = document.createElement('button');
    home.className = 'travee-tab armoire' + (!currentFonds ? ' active' : '');
    home.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14" style="vertical-align:middle"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>`;
    home.setAttribute('aria-label', 'Accueil — toutes les collections');
    home.setAttribute('title', 'Accueil');
    home.addEventListener('click', () => { currentFonds = null; currentThemeIdx = 0; buildNav(); renderHall(); });
    tabs.appendChild(home);

    // Un onglet par fonds
    [...fondsData.keys()].forEach(fonds => {
      const n   = countFonds(fonds);
      const btn = document.createElement('button');
      btn.className = 'travee-tab armoire' + (currentFonds === fonds ? ' active' : '');
      btn.dataset.fonds = fonds;
      btn.innerHTML = `${fondsIcon(fonds)} ${escapeHtml(fonds)}<span class="tab-count">${n.toLocaleString('fr-FR')} doc${n > 1 ? 's' : ''}</span>`;
      btn.setAttribute('aria-label', `${fonds} — ${n} documents`);
      btn.addEventListener('click', () => selectFonds(fonds));
      tabs.appendChild(btn);
    });
  }

  function selectFonds(fonds) {
    currentFonds    = fonds;
    currentThemeIdx = 0;
    currentRowPage = 0;
    buildNav();
    renderFonds(fonds);
    document.querySelector('main').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  /* ──────────────────────────────────────────────────────────
     Hall d'accueil — grille de fonds
  ────────────────────────────────────────────────────────── */
  function renderHall() {
    const stage = document.getElementById('stage');
    const totalDocs = allRecords.length;
    const totalNum  = allRecords.filter(r => (r['num'] || '').trim()).length;

    const cardsHtml = [...fondsData.keys()].map(fonds => {
      const n      = countFonds(fonds);
      const num    = countNumInFonds(fonds);
      const themes = getThemeList(fonds).filter(t => t.key !== '__general__');
      const meta   = FONDS_META[fonds] || {};

      return `
        <button class="hall-card hall-card--fonds" data-fonds="${escapeAttr(fonds)}">
          <div class="hall-card-fonds-icon">${fondsIcon(fonds)}</div>
          <div class="hall-card-fonds-name">${escapeHtml(fonds)}</div>
          <div class="hall-card-fonds-desc">${escapeHtml(meta.desc || '')}</div>
          <div class="hall-card-fonds-stats">
            <strong>${n.toLocaleString('fr-FR')}</strong> document${n > 1 ? 's' : ''}
            ${num ? `<span class="stat-num">· ${num.toLocaleString('fr-FR')} numérisé${num > 1 ? 's' : ''}</span>` : ''}
            ${themes.length ? `<span class="stat-themes">· ${themes.length} sous-collection${themes.length > 1 ? 's' : ''}</span>` : ''}
          </div>
        </button>`;
    }).join('');

    stage.innerHTML = `
      <div class="hall-split">
        <div class="hall-split-img" aria-hidden="true">
          <img src="images/marceline-patrimoine.png" alt="">
        </div>
        <div class="hall-split-content">
          <div class="hall">
            <div class="hall-intro">
              <div class="hall-eyebrow">Réserve patrimoniale · Douai</div>
              <h2 class="hall-title">Explorez <em>nos collections</em></h2>
              <p class="hall-lead">
                Choisissez une collection pour parcourir ses ouvrages sur les rayons.
                Les reliures visibles appartiennent aux documents numérisés : cliquez pour les feuilleter.
              </p>
            </div>
            <div class="hall-grid hall-grid--fonds">${cardsHtml}</div>
            <div class="hall-stats">
              <strong>${totalDocs.toLocaleString('fr-FR')}</strong> notices · 
              <strong>${totalNum.toLocaleString('fr-FR')}</strong> documents numérisés
            </div>
          </div>
        </div>
      </div>`;

    stage.querySelectorAll('.hall-card--fonds').forEach(btn => {
      btn.addEventListener('click', () => selectFonds(btn.dataset.fonds));
    });
  }

  /* ──────────────────────────────────────────────────────────
     Vue d'un fonds — navigation par thème + étagère
  ────────────────────────────────────────────────────────── */
  function renderFonds(fonds) {
    const stage   = document.getElementById('stage');
    const themes  = getThemeList(fonds);
    const total   = countFonds(fonds);
    const numTotal= countNumInFonds(fonds);

    // Clamp l'index dans les bornes
    if (currentThemeIdx < 0) currentThemeIdx = 0;
    if (currentThemeIdx >= themes.length) currentThemeIdx = Math.max(0, themes.length - 1);

    const hasMultiThemes = themes.length > 1;
    const current = themes[currentThemeIdx];
    if (!current) {
      stage.innerHTML = '<p style="color:var(--parchment-d);padding:2rem;text-align:center">Aucun document dans cette collection.</p>';
      return;
    }

    /* ── En-tête du fonds ── */
    const headerHtml = `
      <div class="fonds-header">
        <div class="fonds-header-left">
          <div class="fonds-icon-lg">${fondsIcon(fonds)}</div>
          <div>
            <div class="fonds-eyebrow">Collection</div>
            <h2 class="fonds-title">${escapeHtml(fonds)}</h2>
            <p class="fonds-desc">${escapeHtml(fondsDesc(fonds))}</p>
            <div class="fonds-counts">
              <strong>${total.toLocaleString('fr-FR')}</strong> document${total > 1 ? 's' : ''}
              ${numTotal ? `· <span style="color:var(--gold)">${numTotal.toLocaleString('fr-FR')} numérisé${numTotal > 1 ? 's' : ''}</span>` : ''}
            </div>
          </div>
        </div>
        <div class="legend-mini">
          <div class="legend-mini-item"><div class="legend-swatch num"></div>Numérisé</div>
          <div class="legend-mini-item"><div class="legend-swatch notnum"></div>Non numérisé — cliquer pour la fiche</div>
        </div>
      </div>`;

    /* ── Navigation entre thèmes (uniquement si plusieurs) ── */
    let themeNavHtml = '';
    if (hasMultiThemes) {
      const prevDis = currentThemeIdx === 0;
      const nextDis = currentThemeIdx >= themes.length - 1;

      // Minimap : un chip par thème
      const minimapHtml = themes.map((t, i) => `
        <button class="theme-dot ${i === currentThemeIdx ? 'active' : ''}" 
          data-idx="${i}" title="${escapeAttr(t.label)} — ${t.records.length} documents">
          <span class="theme-dot-label">${escapeHtml(t.key === '__general__' ? 'Général' : t.label)}</span>
          <span class="theme-dot-count">${t.records.length.toLocaleString('fr-FR')}</span>
        </button>`).join('');

      themeNavHtml = `
        <div class="theme-nav" id="theme-nav">
          <button class="theme-nav-btn" id="theme-prev" ${prevDis ? 'disabled' : ''} aria-label="Sous-collection précédente">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" width="18" height="18"><polyline points="15 18 9 12 15 6"/></svg>
            <span class="theme-nav-label">Précédente</span>
          </button>
          <div class="theme-nav-center">
            <div class="theme-nav-current">
              <span class="theme-nav-eyebrow">Sous-collection</span>
              <span class="theme-nav-name">${escapeHtml(current.label)}</span>
              <span class="theme-nav-count">${current.records.length.toLocaleString('fr-FR')} document${current.records.length > 1 ? 's' : ''}</span>
            </div>
            <div class="theme-minimap">${minimapHtml}</div>
          </div>
          <button class="theme-nav-btn" id="theme-next" ${nextDis ? 'disabled' : ''} aria-label="Sous-collection suivante">
            <span class="theme-nav-label">Suivante</span>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" width="18" height="18"><polyline points="9 18 15 12 9 6"/></svg>
          </button>
        </div>`;
    }

    /* ── Étagère ── */
    const shelfHtml = renderShelf(current.records);

    stage.innerHTML = headerHtml + themeNavHtml + shelfHtml;

    // Bind clics livres
    bindBookClicks(stage);
    bindRowNav(current.records);

    // Bind navigation thème
    if (hasMultiThemes) {
      document.getElementById('theme-prev')?.addEventListener('click', () => {
        currentThemeIdx--;
        currentRowPage = 0;
        renderFonds(fonds);
        document.querySelector('.theme-nav')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      });
      document.getElementById('theme-next')?.addEventListener('click', () => {
        currentThemeIdx++;
        renderFonds(fonds);
        document.querySelector('.theme-nav')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      });
      stage.querySelectorAll('.theme-dot').forEach(dot => {
        dot.addEventListener('click', () => {
          currentThemeIdx = parseInt(dot.dataset.idx, 10);
          renderFonds(fonds);
        });
      });
    }
  }

  /* ──────────────────────────────────────────────────────────
     Rendu de l'étagère pour un tableau de notices
  ────────────────────────────────────────────────────────── */
  const ROWS_PER_PAGE = 3;

  function renderShelf(records) {
    if (!records.length) {
      return '<p style="text-align:center;color:var(--parchment-d);padding:3rem;font-style:italic">Aucun document dans cette sous-collection.</p>';
    }

    const bpr = calcBooksPerRow();

    // Découper tous les livres en rangées
    const allRows = [];
    for (let i = 0; i < records.length; i += bpr) allRows.push(records.slice(i, i + bpr));

    const totalPages = Math.ceil(allRows.length / ROWS_PER_PAGE);
    if (currentRowPage >= totalPages) currentRowPage = Math.max(0, totalPages - 1);
    if (currentRowPage < 0) currentRowPage = 0;

    const startRow  = currentRowPage * ROWS_PER_PAGE;
    const pageRows  = allRows.slice(startRow, startRow + ROWS_PER_PAGE);
    const firstDoc  = startRow * bpr + 1;
    const lastDoc   = Math.min((startRow + ROWS_PER_PAGE) * bpr, records.length);

    const rowsHtml = pageRows.map(row =>
      `<div class="shelf-row">${row.map(rec => bookHtml(rec)).join('')}</div>`
    ).join('');

    const navHtml = (dir) => `
      <div class="row-nav">
        <button class="row-nav-btn" data-rowdir="-1" ${currentRowPage === 0 ? 'disabled' : ''} aria-label="Étagères précédentes">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" width="16" height="16"><polyline points="15 18 9 12 15 6"/></svg>
          Précédentes
        </button>
        <span class="row-nav-info">
          <strong>${currentRowPage + 1}</strong> / ${totalPages}
          <span class="row-nav-sub">${firstDoc.toLocaleString('fr-FR')}–${lastDoc.toLocaleString('fr-FR')} sur ${records.length.toLocaleString('fr-FR')}</span>
        </span>
        <button class="row-nav-btn" data-rowdir="1" ${currentRowPage >= totalPages - 1 ? 'disabled' : ''} aria-label="Étagères suivantes">
          Suivantes
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" width="16" height="16"><polyline points="9 18 15 12 9 6"/></svg>
        </button>
      </div>`;

    return `
      <div id="shelf-area">
        ${totalPages > 1 ? navHtml('top') : ''}
        <div class="shelf-room">
          <div class="shelf-column shelf-column--full">
            <div class="shelf-column-frame">${rowsHtml}</div>
          </div>
        </div>
        ${totalPages > 1 ? navHtml('bottom') : ''}
      </div>`;
  }
  function refreshShelfArea(records) {
  const area = document.getElementById('shelf-area');
  if (!area) return;
  const tmp = document.createElement('div');
  tmp.innerHTML = renderShelf(records);
  const newArea = tmp.firstElementChild;
  area.replaceWith(newArea);
  bindBookClicks(newArea);
  bindRowNav(records);
  newArea.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function bindRowNav(records) {
  const area = document.getElementById('shelf-area');
  if (!area) return;
  area.addEventListener('click', e => {
    const btn = e.target.closest('[data-rowdir]');
    if (!btn || btn.disabled) return;
    currentRowPage += parseInt(btn.dataset.rowdir, 10);
    refreshShelfArea(records);
  });
}

  function calcBooksPerRow() {
    // Largeur disponible estimée moins marges et padding du cadre
    const avail = Math.min(window.innerWidth - 100, 1520);
    // Largeur moyenne d'un livre sur l'étagère ≈ 21 px (tranche + 1px gap)
    const n = Math.floor(avail / 21);
    return Math.max(12, Math.min(70, n));
  }

  /* ──────────────────────────────────────────────────────────
     Livre sur l'étagère
  ────────────────────────────────────────────────────────── */
  function bookHtml(rec) {
    const titre   = (rec['200$a'] || '').trim();
    const titreAff = formatTitle(rec);
    const cote    = (rec['930$g'] || '').trim();
    const lienNum = (rec['lien_num'] || '').trim();
    const num     = (rec['num'] || '').trim();
    const fonds   = (rec['930$e_11'] || '').trim();
    const dims    = parseBookDimensions(rec['215$d'] || '', rec['200$b'] || '', rec['215$a'] || '', cote);
    const isNum   = !!num;

    const fondsClass = fondsToClass(fonds);
    const cls   = `book ${isNum && lienNum ? 'book-num' : 'book-notnum'} ${!lienNum ? fondsClass : ''}`;
    const style = `width:${dims.width}px;height:${dims.height}px;`
                + (isNum && lienNum ? `background-image:url('${escapeAttr(lienNum)}');` : '');

    let spineHtml = '';
    if (!isNum || !lienNum) {
      const txt = cote || truncate(titreAff, 22);
      if (txt && dims.height >= 70) spineHtml = `<span class="spine-text">${escapeHtml(truncate(txt, 22))}</span>`;
      if (dims.height >= 90 && stableHash(cote || titre) % 3 !== 0) spineHtml += `<span class="spine-label"></span>`;
    }

    return `<div class="${cls}" data-recid="${rec.__id}" style="${style}" tabindex="0" role="button"
      aria-label="${escapeAttr((titreAff || 'Document sans titre') + (cote ? ' — ' + cote : ''))}">${spineHtml}</div>`;
  }

  function fondsToClass(fonds) {
    if (!fonds) return 'fonds-Default';
    if (fonds.includes('Marceline')) return 'fonds-Marceline';
    if (fonds.includes('Artiste')) return 'fonds-Artistes';
    if (fonds.includes('Douaisien') || fonds.includes('Douaisi')) return 'fonds-Douaisien';
    return 'fonds-' + fonds.replace(/[^a-zA-Zà-üÀ-Ü]/g, '');
  }

  function bindBookClicks(stage) {
    stage.querySelectorAll('.book').forEach(el => {
      el.addEventListener('click', () => {
        const rec = allRecords.find(r => r.__id === parseInt(el.dataset.recid, 10));
        if (rec) openBookModal(rec);
      });
      el.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); el.click(); } });
      el.addEventListener('mouseenter', e => {
        const rec = allRecords.find(r => r.__id === parseInt(el.dataset.recid, 10));
        if (rec) showTooltip(rec, e);
      });
      el.addEventListener('mousemove', positionTooltip);
      el.addEventListener('mouseleave', hideTooltip);
      el.addEventListener('focus', () => {
        const rec = allRecords.find(r => r.__id === parseInt(el.dataset.recid, 10));
        if (!rec) return;
        const rect = el.getBoundingClientRect();
        showTooltip(rec, { clientX: rect.left + rect.width / 2, clientY: rect.top });
      });
      el.addEventListener('blur', hideTooltip);
    });
  }

  /* Tooltip */
  function showTooltip(rec, e) {
    const tt = document.getElementById('book-tooltip');
    const titre  = formatTitle(rec);
    const auteur = formatAuthor(rec);
    const cote   = (rec['930$g'] || '').trim();
    const annee  = (rec['210$d'] || '').trim();
    const theme  = (rec['930$e_12'] || '').trim();
    const isNum  = !!(rec['num'] || '').trim();

    tt.innerHTML = `
      <div class="tt-titre">${escapeHtml(truncate(titre, 110))}</div>
      ${auteur ? `<div class="tt-meta">${escapeHtml(truncate(auteur, 80))}</div>` : ''}
      ${annee  ? `<div class="tt-meta">${escapeHtml(annee)}</div>` : ''}
      <div style="margin-top:4px;display:flex;flex-wrap:wrap;gap:3px">
        ${cote  ? `<span class="tt-cote">${escapeHtml(cote)}</span>` : ''}
        ${theme ? `<span class="tt-theme">${escapeHtml(theme)}</span>` : ''}
        ${isNum ? `<span class="tt-num">Numérisé</span>` : ''}
      </div>`;
    tt.classList.add('show');
    positionTooltip(e);
  }
  function positionTooltip(e) {
    const tt = document.getElementById('book-tooltip');
    if (!tt.classList.contains('show')) return;
    const pad = 14, rect = tt.getBoundingClientRect();
    let x = e.clientX + pad, y = e.clientY + pad;
    if (x + rect.width  > window.innerWidth  - 10) x = e.clientX - rect.width  - pad;
    if (y + rect.height > window.innerHeight - 10) y = e.clientY - rect.height - pad;
    tt.style.left = Math.max(8, x) + 'px';
    tt.style.top  = Math.max(8, y) + 'px';
  }
  function hideTooltip() { document.getElementById('book-tooltip').classList.remove('show'); }

  /* ──────────────────────────────────────────────────────────
     Dimensions (inchangé)
  ────────────────────────────────────────────────────────── */
  function parseBookDimensions(rawDim, type, pagination, cote) {
    const d = String(rawDim || '').toLowerCase();
    let h = null;
    const m1 = d.match(/(\d{1,3})\s*[x×]\s*(\d{1,3})/); if (m1) h = parseInt(m1[1], 10);
    if (!h) { const m2 = d.match(/(\d{1,3})\s*cm/);       if (m2) h = parseInt(m2[1], 10); }
    if (!h) { const m3 = d.match(/^\s*(\d{1,3})\s*$/);    if (m3) h = parseInt(m3[1], 10); }
    if (!h) {
      if (/in[-\s]?fol|^fol|folio/.test(d)) h = 40;
      else if (/in[-\s]?4|quarto/.test(d))  h = 28;
      else if (/in[-\s]?8|octavo/.test(d))  h = 22;
      else if (/in[-\s]?12/.test(d))        h = 17;
      else if (/in[-\s]?16/.test(d))        h = 13;
      else if (/in[-\s]?32/.test(d))        h = 11;
    }
    if (!h) h = type === 'MANU' ? 28 : 22;
    h = Math.max(6, Math.min(65, h));
    const heightPx = Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, Math.round(h * PX_PER_CM)));
    const pages = paginationToPageCount(pagination);
    let w = pages !== null
      ? Math.round(8 + Math.sqrt(pages) * 0.7)
      : MIN_WIDTH + stableHash(cote || rawDim || String(Math.random())) % (MAX_WIDTH - MIN_WIDTH);
    return { width: Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, w)), height: heightPx };
  }
  function paginationToPageCount(s) {
    if (!s) return null;
    const m = String(s).match(/(\d{1,4})\s*p\b/g);
    return m ? Math.max(...m.map(x => parseInt(x, 10))) : null;
  }
  function stableHash(s) {
    s = String(s || ''); let h = 0;
    for (let i = 0; i < s.length; i++) { h = ((h << 5) - h) + s.charCodeAt(i); h |= 0; }
    return Math.abs(h);
  }

  /* ──────────────────────────────────────────────────────────
     Comparateur de cotes (inchangé)
  ────────────────────────────────────────────────────────── */
  function parseCote(c) {
    if (!c) return [];
    const segs = [], re = /(\d+)|([^\d\s\-.]+)/g; let m;
    while ((m = re.exec(c.split(',')[0].trim().toLowerCase())) !== null)
      segs.push(m[1] !== undefined ? { isNum: true, num: parseInt(m[1], 10) } : { isNum: false, str: m[2] });
    return segs;
  }
  function compareCotes(a, b) {
    const sa = parseCote(a), sb = parseCote(b), len = Math.max(sa.length, sb.length);
    for (let i = 0; i < len; i++) {
      if (i >= sa.length) return -1;
      if (i >= sb.length) return 1;
      const pa = sa[i], pb = sb[i];
      if (pa.isNum && pb.isNum) { if (pa.num !== pb.num) return pa.num - pb.num; }
      else if (!pa.isNum && !pb.isNum) { const c = pa.str.localeCompare(pb.str, 'fr', { sensitivity: 'base' }); if (c !== 0) return c; }
      else return pa.isNum ? 1 : -1;
    }
    return 0;
  }

  /* ──────────────────────────────────────────────────────────
     Modale — vue détaillée d'un document
  ────────────────────────────────────────────────────────── */
  function openBookModal(rec) {
    const num = (rec['num'] || '').trim();
    modalCurrentPages = [];
    modalPageIdx = 0;
    if (num) {
      const book = bookIndex.get(normalizeNum(num));
      if (book) modalCurrentPages = book.pages;
    }
    renderModalInfo(rec);
    renderModalCover(rec);
    document.getElementById('modal').classList.add('show');
    document.body.style.overflow = 'hidden';
  }
  function closeModal() {
    document.getElementById('modal').classList.remove('show');
    document.body.style.overflow = '';
    modalCurrentPages = [];
    modalPageIdx = 0;
  }

  function renderModalInfo(rec) {
    const titre   = formatTitle(rec);
    const auteur  = formatAuthor(rec);
    const cote    = (rec['930$g'] || '').trim();
    const fonds   = (rec['930$e_11'] || '').trim();
    const theme   = (rec['930$e_12'] || '').trim();
    const annee   = (rec['210$d'] || '').trim();
    const lieu    = (rec['210$a'] || '').trim();
    const editeur = (rec['210$c'] || '').trim();
    const langue  = (rec['101$a'] || '').trim();
    const pagin   = (rec['215$a'] || '').trim();
    const dims    = (rec['215$d'] || '').trim();
    const sujets  = (rec['610$a'] || '').trim();
    const note    = (rec['300$a'] || '').trim();
    const resume  = (rec['Description du contenu (résumé)'] || '').trim();
    const type    = (rec['200$b'] || '').trim();
    const isNum   = !!(rec['num'] || '').trim();

    // La localisation physique est conservée pour l'usage interne des équipes,
    // mais affichée discrètement en bas de fiche.
    const trv = (rec['travee'] || '').trim();
    const col = (rec['5']      || '').trim();
    const et  = (rec['etage']  || '').trim();

    // Barre de titre modale : fonds + thème plutôt que localisation physique
    document.getElementById('modal-bar-loc').innerHTML = fonds
      ? `${fondsIcon(fonds)} <strong>${escapeHtml(fonds)}</strong>${theme ? ` · ${escapeHtml(theme)}` : ''}`
      : '';

    document.getElementById('modal-info').innerHTML = `
      <div class="modal-eyebrow">${escapeHtml(fonds || 'Réserve patrimoniale')}</div>
      <h2 class="modal-title" id="modal-title">${escapeHtml(titre)}</h2>
      ${auteur ? `<p class="modal-author">${escapeHtml(auteur)}</p>` : ''}

      <div class="modal-pills">
        ${cote  ? `<span class="modal-pill pill-cote">${escapeHtml(cote)}</span>` : ''}
        ${type  ? `<span class="modal-pill">${escapeHtml(typeLabel(type))}</span>` : ''}
        ${annee ? `<span class="modal-pill">${escapeHtml(annee)}</span>` : ''}
        ${theme ? `<span class="modal-pill pill-theme">${escapeHtml(theme)}</span>` : ''}
        ${isNum ? `<span class="modal-pill pill-num">Numérisé</span>` : ''}
      </div>

      <div class="modal-meta-grid">
        ${lieu    ? metaItem('Lieu d\'édition', lieu)    : ''}
        ${editeur ? metaItem('Éditeur', editeur)          : ''}
        ${pagin   ? metaItem('Pagination', pagin)         : ''}
        ${dims    ? metaItem('Dimensions', dims)          : ''}
        ${langue  ? metaItem('Langue', langue)            : ''}
        ${sujets  ? metaItem('Sujets', truncate(sujets, 120)) : ''}
        ${note    ? metaItem('Note', truncate(note, 200)) : ''}
      </div>

      ${resume ? `<div class="modal-summary"><strong>Résumé —</strong> ${escapeHtml(resume)}</div>` : ''}

      ${trv ? `
        <details class="modal-loc-details">
          <summary>Localisation interne (usage bibliothèque)</summary>
          <div class="modal-loc-info">
            <span>Travée ${escapeHtml(trv)}${col ? ' · col. ' + escapeHtml(col) : ''}${et ? ' · ét. ' + escapeHtml(et) : ''}</span>
            ${(rec['995$f'] || '').trim() ? `<span>Code-barres : ${escapeHtml((rec['995$f'] || '').trim())}</span>` : ''}
          </div>
        </details>` : ''}`;
  }

  function metaItem(label, val) {
    return `<div class="modal-meta-item">
      <span class="modal-meta-label">${escapeHtml(label)}</span>
      <span class="modal-meta-value">${escapeHtml(val)}</span>
    </div>`;
  }
  function typeLabel(t) {
    return { 'MANU': 'Manuscrit', 'IMP': 'Texte imprimé', 'ICO': 'Iconographie', 'NUMI': 'Numismatique', 'LIVA': 'Livre d\'artiste' }[t.trim()] || t;
  }

  /* Couverture + navigation pages */
  function renderModalCover(rec) {
    const cover   = document.getElementById('modal-cover');
    const lienNum = (rec['lien_num'] || '').trim();
    const num     = (rec['num'] || '').trim();
    const titre   = (rec['200$a'] || 'Sans titre').trim();
    const isNum   = !!num;

    if (isNum && modalCurrentPages.length > 0) {
      const firstSrc = lienNum || (IMAGES_ROOT + modalCurrentPages[0].path);
      cover.innerHTML = `
        <div class="modal-cover-frame">
          <img src="${escapeAttr(firstSrc)}" alt="${escapeAttr(titre)}" class="modal-cover-img" id="modal-cover-img">
          <div class="cover-loading" id="cover-loading"><div class="loader-dots"><span></span><span></span><span></span></div></div>
        </div>
        <div class="pages-nav" role="group" aria-label="Navigation entre les pages">
          <button class="pages-btn" id="page-prev" aria-label="Page précédente"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="15 18 9 12 15 6"/></svg></button>
          <span class="pages-counter" id="page-counter"><strong>Couverture</strong></span>
          <button class="pages-btn" id="page-next" aria-label="Page suivante"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="9 18 15 12 9 6"/></svg></button>
          <button class="pages-fullscreen" id="page-fs" aria-label="Visionneuse complète" title="Visionneuse complète"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg></button>
        </div>`;
      modalPageIdx = lienNum ? -1 : 0;
      updatePagesNav();
      document.getElementById('page-prev').addEventListener('click', () => goToPage(modalPageIdx - 1, rec));
      document.getElementById('page-next').addEventListener('click', () => goToPage(modalPageIdx + 1, rec));
      document.getElementById('page-fs').addEventListener('click', () => window.open(`visionneuse.html?dossier=${encodeURIComponent(num)}`, '_blank', 'noopener'));
    } else if (lienNum) {
      cover.innerHTML = `<div class="modal-cover-frame"><img src="${escapeAttr(lienNum)}" alt="${escapeAttr(titre)}" class="modal-cover-img"></div>`;
    } else {
      cover.innerHTML = `
        <div class="modal-cover-placeholder">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>
          <p>Ce document n'a pas encore été numérisé.</p>
          <small>La consultation est possible sur rendez-vous, sur place.</small>
        </div>`;
    }
  }

  function goToPage(newIdx, rec) {
    const total = modalCurrentPages.length;
    if (!total) return;
    const lienNum = (rec['lien_num'] || '').trim();
    newIdx = Math.max(lienNum ? -1 : 0, Math.min(total - 1, newIdx));
    if (newIdx === modalPageIdx) return;
    modalPageIdx = newIdx;
    const img = document.getElementById('modal-cover-img');
    const ld  = document.getElementById('cover-loading');
    if (!img) return;
    const src = modalPageIdx === -1 ? lienNum : IMAGES_ROOT + modalCurrentPages[modalPageIdx].path;
    if (ld) ld.classList.add('show');
    const pre = new Image();
    pre.onload  = () => { img.src = src; if (ld) ld.classList.remove('show'); };
    pre.onerror = () => { if (ld) ld.classList.remove('show'); };
    pre.src = src;
    updatePagesNav();
  }
  function updatePagesNav() {
    const prev = document.getElementById('page-prev');
    const next = document.getElementById('page-next');
    const ctr  = document.getElementById('page-counter');
    if (!prev || !next || !ctr) return;
    prev.disabled = modalPageIdx <= -1;
    next.disabled = modalPageIdx >= modalCurrentPages.length - 1;
    if (modalPageIdx === -1) { ctr.innerHTML = '<strong>Couverture</strong>'; return; }
    const pn = modalCurrentPages[modalPageIdx]?.name;
    ctr.innerHTML = pn
      ? `<strong>${escapeHtml(truncate(pn, 28))}</strong>`
      : `<strong>p.&nbsp;${modalPageIdx + 1}</strong>&nbsp;/&nbsp;${modalCurrentPages.length}`;
  }

  /* ──────────────────────────────────────────────────────────
     Recherche
  ────────────────────────────────────────────────────────── */
  function bindSearch() {
    const input    = document.getElementById('search-input');
    const dropdown = document.getElementById('search-dropdown');
    input.addEventListener('input', debounce(() => {
      const q = input.value.trim().toLowerCase();
      if (q.length < 2) { dropdown.classList.remove('show'); return; }
      renderSearchResults(q);
    }, 200));
    document.addEventListener('click', e => {
      if (!e.target.closest('.search-wrap')) dropdown.classList.remove('show');
    });
    input.addEventListener('keydown', e => {
      if (e.key === 'Escape') { input.value = ''; dropdown.classList.remove('show'); input.blur(); }
    });
  }

  function renderSearchResults(q) {
    const dropdown = document.getElementById('search-dropdown');
    const hits = [];
    for (let i = 0; i < allRecords.length && hits.length < 30; i++) {
      const r = allRecords[i];
      const hay = [r['200$a'], r['700$a'], r['701$a'], r['930$g'], r['610$a'], r['930$e_11'], r['930$e_12']]
        .filter(Boolean).join(' ').toLowerCase();
      if (hay.includes(q)) hits.push(r);
    }
    if (!hits.length) {
      dropdown.innerHTML = `<div class="search-result-item" style="opacity:0.6;cursor:default">Aucun résultat.</div>`;
      dropdown.classList.add('show'); return;
    }
    dropdown.innerHTML = hits.map(r => {
      const titre  = formatTitle(rec);
      const auteur = formatAuthor(r);
      const cote   = (r['930$g'] || '').trim();
      const fonds  = (r['930$e_11'] || '').trim();
      const theme  = (r['930$e_12'] || '').trim();
      const isNum  = !!(r['num'] || '').trim();
      return `<div class="search-result-item" data-recid="${r.__id}">
        <div class="search-result-title">${escapeHtml(truncate(titre, 75))}${isNum ? ' <span style="color:var(--gold)">●</span>' : ''}</div>
        <div class="search-result-meta">
          ${auteur ? escapeHtml(truncate(auteur, 50)) + ' ' : ''}
          ${cote   ? `<span class="cote">${escapeHtml(cote)}</span>` : ''}
          ${fonds  ? `<span style="opacity:0.65"> · ${escapeHtml(fonds)}</span>` : ''}
          ${theme  ? `<span style="opacity:0.65"> · ${escapeHtml(theme)}</span>` : ''}
        </div>
      </div>`;
    }).join('');
    dropdown.classList.add('show');
    dropdown.querySelectorAll('.search-result-item[data-recid]').forEach(el => {
      el.addEventListener('click', () => {
        const rec = allRecords.find(r => r.__id === parseInt(el.dataset.recid, 10));
        if (!rec) return;
        dropdown.classList.remove('show');
        document.getElementById('search-input').value = '';
        // Naviguer vers le bon fonds si nécessaire
        const fondsDest = (rec['930$e_11'] || '').trim();
        if (fondsDest && fondsDest !== currentFonds) {
          // Trouver l'index du thème correspondant
          const themes = getThemeList(fondsDest);
          const themeKey = (rec['930$e_12'] || '').trim() || '__general__';
          const idx = themes.findIndex(t => t.key === themeKey);
          currentFonds    = fondsDest;
          currentThemeIdx = Math.max(0, idx);
          buildNav();
          renderFonds(fondsDest);
          setTimeout(() => openBookModal(rec), 200);
        } else {
          openBookModal(rec);
        }
      });
    });
  }

  /* ──────────────────────────────────────────────────────────
     Modale — bind global + raccourcis clavier
  ────────────────────────────────────────────────────────── */
  function bindModalGlobal() {
    document.getElementById('modal-close').addEventListener('click', closeModal);
    document.getElementById('modal').addEventListener('click', e => { if (e.target.id === 'modal') closeModal(); });
    document.addEventListener('keydown', e => {
      const modal = document.getElementById('modal');
      if (!modal.classList.contains('show')) return;
      if (e.key === 'Escape') { closeModal(); return; }
      const prev = document.getElementById('page-prev');
      const next = document.getElementById('page-next');
      if (e.key === 'ArrowLeft'  && prev && !prev.disabled) prev.click();
      if (e.key === 'ArrowRight' && next && !next.disabled) next.click();
    });
    // Navigation thème au clavier (hors modale)
    document.addEventListener('keydown', e => {
      if (document.getElementById('modal')?.classList.contains('show')) return;
      if (!currentFonds) return;
      const themes = getThemeList(currentFonds);
      if (e.key === 'ArrowLeft'  && currentThemeIdx > 0) {
        e.preventDefault(); currentThemeIdx--; renderFonds(currentFonds);
      }
      if (e.key === 'ArrowRight' && currentThemeIdx < themes.length - 1) {
        e.preventDefault(); currentThemeIdx++; renderFonds(currentFonds);
      }
    });
  }

  /* ──────────────────────────────────────────────────────────
     Helpers
  ────────────────────────────────────────────────────────── */
  function formatAuthor(rec) {
    const prenoms = (rec['700$b'] || '').split('§').map(s => s.trim());
    return (rec['700$a'] || '').split('§').map(s => s.trim()).filter(Boolean)
      .map((n, i) => (n.toUpperCase() + (prenoms[i] ? ' ' + prenoms[i] : '')).trim()).join(', ');
  }
  function debounce(fn, ms) { let t; return function (...a) { clearTimeout(t); t = setTimeout(() => fn.apply(this, a), ms); }; }
  function truncate(s, n) { s = String(s || ''); return s.length > n ? s.slice(0, n) + '…' : s; }
  function escapeHtml(s) { return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }
  function escapeAttr(s) { return escapeHtml(s); }
  function formatTitle(rec) {
    const titre = (rec['200$a'] || '').trim();
    const raw   = (rec['200$e'] || '').trim();
    if (!raw) return titre || 'Sans titre';
    const subs = raw.split('§').map(s => s.trim()).filter(Boolean);
    return subs.length ? `${titre} : ${subs.join(', ')}` : (titre || 'Sans titre');
  }

  /* ──────────────────────────────────────────────────────────
     GO !
  ────────────────────────────────────────────────────────── */
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => { bindModalGlobal(); start(); });
  } else {
    bindModalGlobal(); start();
  }
})();