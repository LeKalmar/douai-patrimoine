// ══════════════════════════════════════════
//  Configuration
// ══════════════════════════════════════════
const CSV_PATH = 'csv/inventaire.csv';
const PAGE_SIZE = 10;

// Clé de la colonne "sous-fonds" dans le CSV.
// Si la colonne "Sous-fonds" n'existe plus, indiquer ici le nom du champ de remplacement,
// ou laisser null pour désactiver complètement le regroupement par sous-fonds.
const SOUS_FONDS_KEY = 'Sous-fonds'; // ← changer ici si la colonne est renommée

// Couleurs par fonds [couleur haut-gauche, couleur bas-droite]
const FONDS_COLORS = {
  'Manuscrits':                   ['#c0622e', '#8b3a1e'],
  'Douaisien':                    ['#3a7ca5', '#1a4a70'],
  'Imprimés':                     ['#2d5a4a', '#4a8a6a'],
  'Imprimés Douaisiens':          ['#4a7a3a', '#2a5a1a'],
  'Incunables':                   ['#8b3a1e', '#c0622e'],
  'Hospice':                      ['#7a4a8b', '#4a2a6a'],
  'Marceline Desbordes-Valmore':  ['#b94a48', '#7a1a1a'],
  'Situationniste':               ['#b07a20', '#7a4a00'],
  'Littérature':                  ['#1a6a7a', '#0a4a5a'],
  "Livres d'Artiste":             ['#6a3a8b', '#9a5ab0'],
  'Mines':                        ['#5a5a5a', '#8a8a8a'],
  'Réserve Douaisienne':          ['#7a3030', '#a05050'],
};
const FONDS_COLORS_DEFAULT = ['#b07a20', '#7a4a00'];
const FONDS_IMAGES = {
  'Douaisien':                   'images/beffroi.jpg',
  'Marceline Desbordes-Valmore': 'images/marceline.jpg',
  'Mines':                       'images/mines.jpg',
  'Hospice':                     'images/hospice.jpg',
};

// Descriptions et métadonnées des fonds
const FONDS_INFO = {
  'Douaisien': "Ensemble de publications liées à Douai par leur auteur ou leur sujet.",
  'Imprimés': "Collection générale d'imprimés anciens couvrant du XVI\u1d49 au XX\u1d49 siècle, réunissant des ouvrages divers tant par leur provenance que leur sujet.",
  'Imprimés Douaisiens': "Corpus spécifique des imprimés sortis des presses douaisiennes, témoignant de l'activité typographique locale depuis le XVI\u1d49 siècle.",
  'Incunables': "Livres imprimés avant 1501, représentant les premiers témoins de l'imprimerie en Europe. La collection douaisienne est l'une des plus importantes du nord de la France.",
  'Hospice': "Archives et documents provenant de l'Hospice général de Douai.",
  'Marceline Desbordes-Valmore': "Fonds dédié à la poétesse douaisienne Marceline Desbordes-Valmore (1786–1859).",
  'Situationniste': "Collection unique rassemblant publications, tracts et documents de l'Internationale situationniste et des mouvements artistiques avant-gardistes des années 1950–1970.",
  'Littérature': "Fonds littéraire réunissant éditions rares, livres de bibliophilie et œuvres d'auteurs du nord de la France, du XVII\u1d49 au XX\u1d49 siècle.",
  "Livres d'Artiste": "Ensemble exceptionnel de livres d'artistes contemporains alliant création plastique et littéraire, souvent en édition unique ou tirée à très peu d'exemplaires.",
  'Mines': "Documents relatifs à l'Histoire de la mine, dans le bassin minier du Nord-Pas-de-Calais mais aussi d'autres bassins houilliers dans le monde.",
  'Réserve Douaisienne': "",
  'Manuscrits': "Plus de 2 500 manuscrits, du IX\u1d49 au XIX\u1d49 siècle, dont un grand nombre est enluminé. Provenant principalement des confiscations des collections des abbayes d'Anchin et de Marchiennes lors de la Révolution." 
};

// Colonnes à afficher
const COLS = [
  { key: '200$a', label: 'Titre',   cls: 'td-titre col-titre',     width: '35%' },
  { key: '700$a', label: 'Auteur',  cls: 'td-auteur col-auteur',   width: '20%' },  
  { key: '210$d', label: 'Année',   cls: 'td-annee col-annee',     width: '7%'  },
  { key: '930$g', label: 'Cote',    cls: 'td-cote col-cote',       width: '12%' },
  { key: '200$b', label: 'Type',    cls: 'td-type col-type',       width: '8%'  },
];

// Colonnes de détail supplémentaires
const DETAIL_COLS = [
  { key: '215$a',                     label: 'Pagination' },
  { key: '215$b',                     label: 'Volumes' },
  { key: '215$d',                     label: 'Dimensions' },
  { key: '101$a',                     label: 'Langue' },
  { key: '610$a',                     label: 'Sujets' },
  { key: '300$a',                     label: 'Note générale' },
];

// ══════════════════════════════════════════
//  État de l'application
// ══════════════════════════════════════════
let allRecords = [];
let filteredRecords = [];

// Par fonds : page courante et ordre de tri
const fondsState = {};
const sousFondsState = {};

// ══════════════════════════════════════════
//  Chargement du CSV
// ══════════════════════════════════════════
function loadCSV() {
  Papa.parse(CSV_PATH, {
    download: true,
    header: true,
    delimiter: ';',
    encoding: 'ISO-8859-1',
    skipEmptyLines: true,
    complete(results) {
      allRecords = results.data;
      init();
    },
    error(err) {
      document.getElementById('loader').innerHTML =
        `<p style="color:var(--red)">Erreur de chargement : ${err.message}</p>`;
    }
  });
}

// ══════════════════════════════════════════
//  Initialisation
// ══════════════════════════════════════════
function openFondsFromURL() {
  const params = new URLSearchParams(window.location.search);
  const target = params.get('fonds');
  if (!target) return;

  // Attendre que renderFondsList ait construit les blocs
  requestAnimationFrame(() => {
    const block = document.querySelector(`.fonds-block[data-fonds="${CSS.escape(target)}"]`);
    if (!block) return;

    // Ouvrir le fonds si pas déjà ouvert
    if (!fondsState[target]) {
      fondsState[target] = { page: 1, sortCol: null, sortDir: 'asc', open: false };
    }
    if (!fondsState[target].open) {
      toggleFonds(target);
    }

    // Centrer après un court délai (le temps que le DOM se construise)
    setTimeout(() => {
      block.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 150);
  });
}

function init() {
  // Remplir les filtres
  const allTypes = [...new Set(allRecords.map(r => r['Type de document'] || '').filter(Boolean))].sort();

  const selType = document.getElementById('filter-type');
  allTypes.forEach(t => {
    const o = document.createElement('option');
    o.value = t; o.textContent = t;
    selType.appendChild(o);
  });

  // Événements
  document.getElementById('search-global').addEventListener('input', debounce(applyFilters, 200));
  document.getElementById('filter-date-start')
  .addEventListener('input', debounce(applyFilters, 200));

  document.getElementById('filter-date-end')
  .addEventListener('input', debounce(applyFilters, 200));
  selType.addEventListener('change', applyFilters);

  applyFilters();
  document.getElementById('loader').style.display = 'none';
  document.getElementById('fonds-list').style.display = 'flex';
  openFondsFromURL();
}
// ══════════════════════════════════════════
//  Gestion des dates anciennes et intervalles
// ══════════════════════════════════════════

function parsePublicationDate(dateStr) {
  if (!dateStr) return null;

  const str = String(dateStr).trim();

  // Cas : [17xx] → XVIIIe siècle → 1701–1800
  const centuryMatch = str.match(/^\[(\d{2})xx\]$/i);
  if (centuryMatch) {
    const century = parseInt(centuryMatch[1], 10);
    return {
      start: century * 100 + 1,
      end: century * 100 + 100
    };
  }

  // Cas : [154x] → 1540–1549
  const decadeMatch = str.match(/^\[(\d{3})x\]$/i);
  if (decadeMatch) {
    const decade = parseInt(decadeMatch[1], 10) * 10;
    return {
      start: decade,
      end: decade + 9
    };
  }

  // Cas : année précise
  const yearMatch = str.match(/(\d{4})/);
  if (yearMatch) {
    const year = parseInt(yearMatch[1], 10);
    return {
      start: year,
      end: year
    };
  }

  return null;
}

function dateMatchesFilter(recordDate, filterStart, filterEnd) {
  // Aucun filtre
  if (!filterStart && !filterEnd) return true;

  const parsed = parsePublicationDate(recordDate);
  if (!parsed) return false;

  const docStart = parsed.start;
  const docEnd = parsed.end;

  const searchStart = filterStart || 0;
  const searchEnd = filterEnd || 9999;

  // Vérifie si les périodes se chevauchent
  return docEnd >= searchStart && docStart <= searchEnd;
}
// ══════════════════════════════════════════
//  Filtrage global
// ══════════════════════════════════════════
function applyFilters() {
  const q = document.getElementById('search-global').value.trim().toLowerCase();

  const dateStart = parseInt(document.getElementById('filter-date-start').value, 10) || null;
  const dateEnd = parseInt(document.getElementById('filter-date-end').value, 10) || null;

  const type = document.getElementById('filter-type').value;

  filteredRecords = allRecords.filter(r => {

    // Filtre type
    if (type && r['Type de document'] !== type) {
      return false;
    }

    // Filtre date
    if (!dateMatchesFilter(r['210$d'], dateStart, dateEnd)) {
      return false;
    }

    // Recherche texte
    if (q) {
      const hay = [
        r['200$a'],
        r['700$a'],
        r['701$a'],
        r['930$g'],
        r['610$a']
      ].join(' ').toLowerCase();

      if (!hay.includes(q)) {
        return false;
      }
    }

    return true;
  });

  document.getElementById('result-count').innerHTML =
    `<strong>${filteredRecords.length.toLocaleString('fr-FR')}</strong> document${filteredRecords.length > 1 ? 's' : ''}`;

  renderFondsList();
}

// ══════════════════════════════════════════
//  Rendu de la liste des fonds
// ══════════════════════════════════════════
function renderFondsList() {
  const container = document.getElementById('fonds-list');
  container.innerHTML = '';

  // Grouper par fonds
  const groups = {};
  filteredRecords.forEach(r => {
    const f = r['930$e'] || '(Sans fonds)';
    if (!groups[f]) groups[f] = [];
    groups[f].push(r);
  });

  if (Object.keys(groups).length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <path d="M21 21l-4.35-4.35M11 5a6 6 0 100 12 6 6 0 000-12z"/>
        </svg>
        Aucun document ne correspond à votre recherche.
      </div>`;
    return;
  }

  // Trier les fonds alphabétiquement
  const sortedFonds = Object.keys(groups).sort();

  sortedFonds.forEach(fondsName => {
    const records = groups[fondsName];
    if (!fondsState[fondsName]) {
      fondsState[fondsName] = { page: 1, sortCol: null, sortDir: 'asc', open: false };
    }
    container.appendChild(buildFondsBlock(fondsName, records));
  });
}

// ══════════════════════════════════════════
//  Construction d'un bloc fonds
// ══════════════════════════════════════════
function buildFondsBlock(fondsName, records) {
  const state = fondsState[fondsName];
  const colors = FONDS_COLORS[fondsName] || FONDS_COLORS_DEFAULT;
  const c1 = colors[0], c2 = colors[1];

  // Dates extrêmes calculées depuis les données
  const years = records
    .map(r => parseInt(r['210$d'] || ''))
    .filter(y => y > 0 && y < 2100);
  const dateMin = years.length ? Math.min(...years) : null;
  const dateMax = years.length ? Math.max(...years) : null;
  const dateStr = dateMin
    ? (dateMin === dateMax ? `${dateMin}` : `${dateMin} – ${dateMax}`)
    : 'Non renseignées';

  const block = document.createElement('div');
  block.className = 'fonds-block' + (state.open ? ' open' : '');
  block.dataset.fonds = fondsName;

  const img = FONDS_IMAGES[fondsName];
  const iconSVG = `<span class="fonds-color-icon">
    ${img
      ? `<img src="${img}" alt="${fondsName}" style="width:100%;height:100%;object-fit:cover;">`
      : `<svg viewBox="0 0 28 28"><polygon points="0,0 28,0 28,28" fill="${c2}"/><polygon points="0,0 0,28 28,28" fill="${c1}"/></svg>`
    }
  </span>`;

  // ── En-tête cliquable
  const header = document.createElement('button');
  header.className = 'fonds-header';
  header.setAttribute('aria-expanded', state.open);
  header.innerHTML = `
    ${iconSVG}
    <div class="fonds-header-text">
      <span class="fonds-name">${fondsName}</span>
      <span class="fonds-badge">${records.length.toLocaleString('fr-FR')} doc${records.length > 1 ? 's' : ''}</span>
      <svg class="fonds-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M6 9l6 6 6-6"/>
      </svg>
    </div>`;
  header.addEventListener('click', (e) => {
    if (e.target.closest('.fonds-info-btn')) return;
    toggleFonds(fondsName);
  });
  block.appendChild(header);

  // ── Panneau d'information (caché par défaut)
  const infoPanel = document.createElement('div');
  infoPanel.className = 'fonds-info-panel';
  const desc = FONDS_INFO[fondsName] || 'Description non disponible pour ce fonds.';
  infoPanel.innerHTML = `
    <div class="fonds-info-desc">
        <div class="fonds-meta-item">
        <span class="fonds-meta-label">Présentation du fonds :</span>
        </div>
      ${esc(desc)}
    </div>
    <div class="fonds-info-meta">
      <div class="fonds-meta-item">
        <span class="fonds-meta-label">Dates extrêmes</span>
        <span class="fonds-meta-value">${dateStr}</span>
      </div>
      <div class="fonds-meta-item">
        <span class="fonds-meta-label">Documents</span>
        <span class="fonds-meta-value">${records.length.toLocaleString('fr-FR')}</span>
      </div>
    </div>`;
  block.appendChild(infoPanel);

  // ── Corps (table + pagination)
  const body = document.createElement('div');
  body.className = 'fonds-body';
  body.id = `body-${slugify(fondsName)}`;
  block.appendChild(body);

  if (state.open) renderFondsBody(body, records, fondsName, state);

  return block;
}

function toggleFonds(fondsName) {
  const state = fondsState[fondsName];
  state.open = !state.open;

  const block = document.querySelector(`.fonds-block[data-fonds="${CSS.escape(fondsName)}"]`);
  if (!block) return;

  block.classList.toggle('open', state.open);
  block.classList.toggle('info-open', state.open);
  block.querySelector('.fonds-header').setAttribute('aria-expanded', state.open);

  if (state.open) {
    const records = filteredRecords.filter(r => (r['930$e'] || '(Sans fonds)') === fondsName);
    const body = block.querySelector('.fonds-body');
    renderFondsBody(body, records, fondsName, state);
  }
}

// ══════════════════════════════════════════
//  Corps du fonds : table paginée
// ══════════════════════════════════════════
function renderFondsBody(body, records, fondsName, state) {
  body.innerHTML = '';

  const sousFondsValues = SOUS_FONDS_KEY
    ? [...new Set(records.map(r => (r[SOUS_FONDS_KEY] || '').trim()).filter(Boolean))].sort()
    : [];

  if (sousFondsValues.length > 0) {
    const groups = {};
    sousFondsValues.forEach(sf => groups[sf] = []);
    groups['Autres'] = [];
    records.forEach(r => {
      const sf = (r[SOUS_FONDS_KEY] || '').trim();
      if (sf) groups[sf].push(r);
      else groups['Autres'].push(r);
    });
    if (groups['Autres'].length === 0) delete groups['Autres'];

    const sfList = document.createElement('div');
    sfList.className = 'sous-fonds-list';
    Object.entries(groups).forEach(([sfName, sfRecords]) => {
      const sfKey = fondsName + '||' + sfName;
      if (!sousFondsState[sfKey]) {
        sousFondsState[sfKey] = { page: 1, sortCol: null, sortDir: 'asc', open: false };
      }
      sfList.appendChild(buildSousFondsBlock(sfName, sfRecords, fondsName, sfKey));
    });
    body.appendChild(sfList);
  } else {
    renderTable(body, records, fondsName, state);
  }
}
function renderTable(body, records, stateKey, state) {
  body.innerHTML = '';

  // Tri
  let sorted = [...records];
  if (state.sortCol) {
    sorted.sort((a, b) => {
      const va = (a[state.sortCol] || '').toLowerCase();
      const vb = (b[state.sortCol] || '').toLowerCase();
      return state.sortDir === 'asc' ? va.localeCompare(vb, 'fr') : vb.localeCompare(va, 'fr');
    });
  }

  // Pagination
  const totalPages = Math.ceil(sorted.length / PAGE_SIZE);
  if (state.page > totalPages) state.page = 1;
  const start = (state.page - 1) * PAGE_SIZE;
  const pageRecords = sorted.slice(start, start + PAGE_SIZE);

  const wrap = document.createElement('div');
  wrap.className = 'fonds-table-wrap';

  const table = document.createElement('table');
  table.setAttribute('role', 'grid');

  // En-tête
  const thead = document.createElement('thead');
  const hr = document.createElement('tr');
  COLS.forEach(col => {
    const th = document.createElement('th');
    th.className = col.cls;
    if (col.width) th.style.width = col.width;
    th.innerHTML = `${col.label} <span class="sort-icon">${state.sortCol === col.key ? (state.sortDir === 'asc' ? '↑' : '↓') : '↕'}</span>`;
    if (state.sortCol === col.key) th.classList.add('sorted');
    th.addEventListener('click', () => {
      if (state.sortCol === col.key) {
        state.sortDir = state.sortDir === 'asc' ? 'desc' : 'asc';
      } else {
        state.sortCol = col.key;
        state.sortDir = 'asc';
      }
      state.page = 1;
      renderTable(body, records, stateKey, state);
    });
    hr.appendChild(th);
  });
  thead.appendChild(hr);
  table.appendChild(thead);

  // Corps
  const tbody = document.createElement('tbody');
  pageRecords.forEach((rec, idx) => {
    const rowId = `${slugify(stateKey)}-${start + idx}`;

    const tr = document.createElement('tr');
    tr.dataset.rowId = rowId;
    tr.style.cursor = 'pointer';
    tr.addEventListener('click', () => toggleDetail(rowId));

    COLS.forEach(col => {
      const td = document.createElement('td');
      td.className = col.cls;
      let val = rec[col.key] || '';

      if (col.key === '200$a') {
        td.innerHTML = `<span class="td-titre-text">${esc(val) || '<em style="color:var(--text-light)">Sans titre</em>'}</span>`;
      } else if (col.key === '700$a') {
        const prenoms = (rec['700$b'] || '').split('§').map(s => s.trim());
        const noms = val.split('§').map(s => s.trim()).filter(Boolean);
        const formatted = noms.map((n, i) => (n.toUpperCase() + (prenoms[i] ? ' ' + prenoms[i] : '')).trim()).join(', ');
        td.textContent = truncate(formatted, 60);
      } else if (col.key === '930$g') {
        td.innerHTML = val.split(',').map(c => `<span style="display:block">${esc(c.trim())}</span>`).join('');
      } else {
        td.textContent = val;
      }
      tr.appendChild(td);
    });
    tbody.appendChild(tr);

    // Ligne détail
    const dtr = document.createElement('tr');
    dtr.className = 'detail-row';
    dtr.id = `detail-${rowId}`;
    const dtd = document.createElement('td');
    dtd.className = 'detail-cell';
    dtd.colSpan = COLS.length;
    dtd.appendChild(buildDetailContent(rec));
    dtr.appendChild(dtd);
    tbody.appendChild(dtr);
  });
  table.appendChild(tbody);
  wrap.appendChild(table);
  body.appendChild(wrap);

  if (totalPages > 1) {
    body.appendChild(buildPagination(state.page, totalPages, sorted.length, start, stateKey, state, records));
  }
}

function buildSousFondsBlock(sfName, records, fondsName, sfKey) {
  const state = sousFondsState[sfKey];

  const block = document.createElement('div');
  block.className = 'sous-fonds-block' + (state.open ? ' open' : '');
  block.dataset.sfkey = sfKey;

  const header = document.createElement('button');
  header.className = 'sous-fonds-header';
  header.setAttribute('aria-expanded', state.open);
  header.innerHTML = `
    <span class="sous-fonds-name">${esc(sfName)}</span>
    <span class="sous-fonds-badge">${records.length.toLocaleString('fr-FR')} doc${records.length > 1 ? 's' : ''}</span>
    <svg class="sous-fonds-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <path d="M6 9l6 6 6-6"/>
    </svg>`;
  header.addEventListener('click', () => {
    state.open = !state.open;
    block.classList.toggle('open', state.open);
    header.setAttribute('aria-expanded', state.open);
    if (state.open) renderTable(sfBody, records, sfKey, state);
  });
  block.appendChild(header);

  const sfBody = document.createElement('div');
  sfBody.className = 'sous-fonds-body';
  if (state.open) renderTable(sfBody, records, sfKey, state);
  block.appendChild(sfBody);

  return block;
}

// ══════════════════════════════════════════
//  Contenu détaillé d'un document
// ══════════════════════════════════════════
function buildDetailContent(rec) {
  const grid = document.createElement('div');
  grid.className = 'detail-grid';

  DETAIL_COLS.forEach(col => {
    const val = rec[col.key] || '';
    if (!val.trim()) return;
    const item = document.createElement('div');
    item.className = 'detail-item';
    item.innerHTML = `<span class="detail-label">${esc(col.label)}</span>
                      <span class="detail-value">${esc(truncate(val, 200))}</span>`;
    grid.appendChild(item);
  });

  const resume = rec['Description du contenu (résumé)'] || '';
  if (resume.trim()) {
    const p = document.createElement('div');
    p.className = 'detail-resume';
    p.innerHTML = `<em>Résumé —</em> ${esc(resume)}`;
    grid.appendChild(p);
  }

  return grid;
}

function toggleDetail(rowId) {
  const dtr = document.getElementById(`detail-${rowId}`);
  if (!dtr) return;
  // Fermer les autres lignes ouvertes
  document.querySelectorAll('.detail-row.visible').forEach(el => {
    if (el.id !== `detail-${rowId}`) el.classList.remove('visible');
  });
  dtr.classList.toggle('visible');
  // Mettre en évidence la ligne parente
  const tr = document.querySelector(`[data-row-id="${rowId}"]`);
  if (tr) tr.classList.toggle('expanded', dtr.classList.contains('visible'));
}

// ══════════════════════════════════════════
//  Pagination
// ══════════════════════════════════════════
function buildPagination(currentPage, totalPages, total, start, stateKey, state, records) {
  const end = Math.min(start + PAGE_SIZE, total);
  const div = document.createElement('div');
  div.className = 'pagination';

  div.innerHTML = `<span class="pagination-info">Documents ${(start+1).toLocaleString('fr-FR')}–${end.toLocaleString('fr-FR')} sur ${total.toLocaleString('fr-FR')}</span>`;

  const btns = document.createElement('div');
  btns.className = 'pagination-btns';

  // Précédent
  const prev = document.createElement('button');
  prev.textContent = '←';
  prev.disabled = currentPage === 1;
  prev.addEventListener('click', () => goToPage(stateKey, state, records, currentPage - 1));
  btns.appendChild(prev);

  // Pages
  const range = pageRange(currentPage, totalPages);
  range.forEach(p => {
    const btn = document.createElement('button');
    if (p === '…') {
      btn.textContent = '…'; btn.disabled = true;
    } else {
      btn.textContent = p;
      if (p === currentPage) btn.classList.add('active');
      else btn.addEventListener('click', () => goToPage(stateKey, state, records, p));
    }
    btns.appendChild(btn);
  });

  // Suivant
  const next = document.createElement('button');
  next.textContent = '→';
  next.disabled = currentPage === totalPages;
  next.addEventListener('click', () => goToPage(stateKey, state, records, currentPage + 1));
  btns.appendChild(next);

  div.appendChild(btns);
  return div;
}

function goToPage(stateKey, state, records, page) {
  state.page = page;
  // Chercher le body du bon bloc (fonds ou sous-fonds)
  const sfBlock = document.querySelector(`.sous-fonds-block[data-sfkey="${CSS.escape(stateKey)}"]`);
  const fondsBlock = document.querySelector(`.fonds-block[data-fonds="${CSS.escape(stateKey)}"]`);
  const body = sfBlock
    ? sfBlock.querySelector('.sous-fonds-body')
    : fondsBlock?.querySelector('.fonds-body');
  if (body) {
    renderTable(body, records, stateKey, state);
    body.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

function pageRange(current, total) {
  if (total <= 7) return Array.from({length: total}, (_, i) => i + 1);
  const pages = [1];
  if (current > 3) pages.push('…');
  for (let i = Math.max(2, current - 1); i <= Math.min(total - 1, current + 1); i++) pages.push(i);
  if (current < total - 2) pages.push('…');
  pages.push(total);
  return pages;
}

// ══════════════════════════════════════════
//  Utilitaires
// ══════════════════════════════════════════
function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}
function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function truncate(s, n) {
  return s.length > n ? s.slice(0, n) + '…' : s;
}
function slugify(s) {
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]+/gi,'-').toLowerCase();
}

// ══════════════════════════════════════════
//  Démarrage différé
// ══════════════════════════════════════════
// Le catalogue (CSV volumineux) n'est chargé qu'à la première demande,
// déclenchée par l'ouverture de l'accordéon « Trouver un document ».
let inventaireStarted = false;
function startInventaire() {
  if (inventaireStarted) return;
  inventaireStarted = true;
  loadCSV();
}
window.startInventaire = startInventaire;