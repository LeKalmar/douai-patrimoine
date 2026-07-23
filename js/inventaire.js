// ══════════════════════════════════════════
//  Configuration
// ══════════════════════════════════════════
const JSON_PATH = 'data/inventaire.json';
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
  'Protestantisme':               ['#4a6a3a', '#2a4a1a'],
};
const FONDS_COLORS_DEFAULT = ['#b07a20', '#7a4a00'];
const FONDS_IMAGES = {
  'Douaisien':                   'images/beffroi.jpg',
  'Marceline Desbordes-Valmore': 'images/marceline.jpg',
  'Mines':                       'images/mines.jpg',
  'Hospice':                     'images/hospice.jpg',
  'Protestantisme':              'images/protestantisme.jpg',
  'Manuscrits':                  'images/manuscrits.jpg',
  'Littérature':                 'images/litterature.jpg',
  'Robaut':                      'images/robaut.jpg',
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
  'Mines': "Documents relatifs à l'Histoire de la mine dans les autres bassins miniers du monde.",
  'Réserve Douaisienne': "",
  'Robaut':"Fonds iconographique comprenant de nombreuses réalisations des ateliers Robaut au XIXe siècle",
  'Objets': "Divers objets versés à la bibliothèque municipale de Douai.",
  'Manuscrits': "Plus de 2 500 manuscrits, du IX\u1d49 au XIX\u1d49 siècle, dont un grand nombre est enluminé. Provenant principalement des confiscations des collections des abbayes d'Anchin et de Marchiennes lors de la Révolution." 
};

// Détermination du fonds d'un document à partir du préfixe de sa cote (930$g),
// plutôt que du champ 930$e (peu renseigné). Les préfixes les plus spécifiques
// sont testés avant les préfixes courts qu'ils contiennent (ex. "LIVA" avant "L").
const FONDS_PREFIXES = [
  { prefix: 'RD',   fonds: 'Réserve Douaisienne' },
  { prefix: 'LIVA', fonds: "Livres d'Artiste" },
  { prefix: 'MIN',  fonds: 'Mines' },
  { prefix: 'D',    fonds: 'Douaisien' },
  { prefix: 'I',    fonds: 'Imprimés' },
  { prefix: 'L',    fonds: 'Littérature' },
  { prefix: 'P',    fonds: 'Protestantisme' },
];

function getFondsFromCote(record) {
  const cote = (record['930$g'] || '').split(',')[0].trim().toUpperCase();
  if (!cote) return '(Sans fonds)';
  const match = FONDS_PREFIXES.find(({ prefix }) => cote.startsWith(prefix));
  return match ? match.fonds : '(Sans fonds)';
}

// Colonnes à afficher
const COLS = [
  { key: '_thumb',  label: '',        cls: 'td-thumb col-thumb',     width: '10%', noSort: true },
  { key: '200$a',   label: 'Titre',   cls: 'td-titre col-titre',     width: '33%' },
  { key: '700$a',   label: 'Auteur',  cls: 'td-auteur col-auteur',   width: '18%' },  
  { key: '210$d',   label: 'Année',   cls: 'td-annee col-annee',     width: '7%'  },
  { key: '930$g',   label: 'Cote',    cls: 'td-cote col-cote',       width: '12%' },
  { key: '200$b',   label: 'Type',    cls: 'td-type col-type',       width: '5%'  },
];

// Icônes SVG par type de document (200$b)
const TYPE_ICONS = {
  'MANU': {
    label: 'Manuscrit',
    color: '#8b3a1e',
    svg: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6">
      <path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/>
      <path d="m15 5 4 4"/>
    </svg>`
  },
  'IMP': {
    label: 'Texte Imprimé',
    color: '#2d5a4a',
    svg: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6">
      <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/>
      <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>
      <line x1="9" y1="7" x2="15" y2="7"/>
      <line x1="9" y1="11" x2="15" y2="11"/>
    </svg>`
  },
  'Document Cartographique': {
    label: 'Document Cartographique',
    color: '#3a7ca5',
    svg: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6">
      <polygon points="3 6 9 3 15 6 21 3 21 18 15 21 9 18 3 21"/>
      <line x1="9" y1="3" x2="9" y2="18"/>
      <line x1="15" y1="6" x2="15" y2="21"/>
    </svg>`
  },
  'ICO': {
    label: 'Iconographie',
    color: '#7a4a8b',
    svg: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6">
      <rect x="3" y="3" width="18" height="18" rx="2"/>
      <circle cx="8.5" cy="8.5" r="1.5"/>
      <polyline points="21 15 16 10 5 21"/>
    </svg>`
  },
  'Photographie': {
    label: 'Photographie',
    color: '#4a6a8a',
    svg: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6">
      <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/>
      <circle cx="12" cy="13" r="4"/>
    </svg>`
  },
  'NUMI': {
    label: 'Numismatique',
    color: '#b07a20',
    svg: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6">
      <circle cx="12" cy="12" r="9"/>
      <circle cx="12" cy="12" r="5" stroke-dasharray="2 2"/>
      <line x1="12" y1="8" x2="12" y2="10"/>
      <line x1="12" y1="14" x2="12" y2="16"/>
    </svg>`
  },
  "LIVA": {
    label: "Livre d'Artiste",
    color: '#6a3a8b',
    svg: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6">
      <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/>
      <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>
      <path d="M9.5 10.5 Q11 8 12.5 10.5 Q14 13 15.5 10.5" stroke-linecap="round"/>
    </svg>`
  },
};

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

// Onglet actif : 'fonds' | 'themes'
let activeTab = 'fonds';

// État des blocs thématiques (même structure que fondsState)
const themeState = {};
const sousThemeState = {};

// ══════════════════════════════════════════
//  Chargement du JSON
// ══════════════════════════════════════════
function loadCSV() {                       // gardez le nom, ça évite de toucher au reste
  fetch(JSON_PATH)
    .then(r => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    })
    .then(data => {
      allRecords = data;
      init();
    })
    .catch(err => {
      document.getElementById('loader').innerHTML =
        `<p style="color:var(--red)">Erreur de chargement : ${err.message}</p>`;
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

  // ── Injecter la barre d'onglets au-dessus de #fonds-list
  const fondsList = document.getElementById('fonds-list');
  const tabBar = document.createElement('div');
  tabBar.className = 'inv-tabs';
  tabBar.setAttribute('role', 'tablist');
  tabBar.innerHTML = `
    <button class="inv-tab inv-tab--active" role="tab" aria-selected="true" data-tab="fonds"
            id="tab-fonds" aria-controls="fonds-list">
      Par fonds
    </button>
    <button class="inv-tab" role="tab" aria-selected="false" data-tab="themes"
            id="tab-themes" aria-controls="fonds-list">
      Par thème
    </button>`;
  fondsList.parentNode.insertBefore(tabBar, fondsList);

  tabBar.querySelectorAll('.inv-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      activeTab = btn.dataset.tab;
      tabBar.querySelectorAll('.inv-tab').forEach(b => {
        b.classList.toggle('inv-tab--active', b === btn);
        b.setAttribute('aria-selected', b === btn ? 'true' : 'false');
      });
      applyFilters();
    });
  });

  // Événements filtres
  document.getElementById('search-global').addEventListener('input', debounce(applyFilters, 200));
  document.getElementById('filter-date-start').addEventListener('input', debounce(applyFilters, 200));
  document.getElementById('filter-date-end').addEventListener('input', debounce(applyFilters, 200));
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

  if (activeTab === 'themes') {
    renderThemesList();
  } else {
    renderFondsList();
  }
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
    const f = getFondsFromCote(r);
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
//  Rendu de la liste par thème (930$e_11)
// ══════════════════════════════════════════
function renderThemesList() {
  const container = document.getElementById('fonds-list');
  container.innerHTML = '';

  // Grouper par thème (colonne 930$e_11)
  const groups = {};
  filteredRecords.forEach(r => {
    const raw = r['930$e_11'] || '';
    // La valeur peut contenir plusieurs thèmes séparés par § ou ,
    const themes = raw.split(/[§,]/).map(t => t.trim()).filter(Boolean);
    const keys = themes.length ? themes : ['(Sans thème)'];
    keys.forEach(t => {
      if (!groups[t]) groups[t] = [];
      groups[t].push(r);
    });
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

  // Trier les thèmes : "(Sans thème)" en dernier, reste alphabétique
  const sortedThemes = Object.keys(groups).sort((a, b) => {
    if (a === '(Sans thème)') return 1;
    if (b === '(Sans thème)') return -1;
    return a.localeCompare(b, 'fr');
  });

  sortedThemes.forEach(themeName => {
    const records = groups[themeName];
    if (!themeState[themeName]) {
      themeState[themeName] = { page: 1, sortCol: null, sortDir: 'asc', open: false };
    }
    container.appendChild(buildThemeBlock(themeName, records));
  });
}

// ══════════════════════════════════════════
//  Construction d'un bloc thème
// ══════════════════════════════════════════
function buildThemeBlock(themeName, records) {
  const state = themeState[themeName];

  // Dates extrêmes
  const years = records
    .map(r => parseInt(r['210$d'] || ''))
    .filter(y => y > 0 && y < 2100);
  const dateMin = years.length ? Math.min(...years) : null;
  const dateMax = years.length ? Math.max(...years) : null;
  const dateStr = dateMin
    ? (dateMin === dateMax ? `${dateMin}` : `${dateMin} – ${dateMax}`)
    : 'Non renseignées';

  const block = document.createElement('div');
  block.className = 'fonds-block theme-block' + (state.open ? ' open' : '');
  block.dataset.theme = themeName;

  // Icône neutre avec initiale
  const initial = themeName.replace(/^\(/, '').charAt(0).toUpperCase();
  const iconSVG = `<span class="fonds-color-icon theme-icon">
    <span class="theme-icon-letter">${esc(initial)}</span>
  </span>`;

  const header = document.createElement('button');
  header.className = 'fonds-header';
  header.setAttribute('aria-expanded', state.open);
  header.innerHTML = `
    ${iconSVG}
    <div class="fonds-header-text">
      <div class="fonds-header-top">
        <span class="fonds-name">${esc(themeName)}</span>
        <span class="fonds-badge">${records.length.toLocaleString('fr-FR')} doc${records.length > 1 ? 's' : ''}</span>
      </div>
      <div class="fonds-header-meta">
        <span class="fonds-meta-dates">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="13" height="13" style="vertical-align:-2px;margin-right:4px;"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>${dateStr}
        </span>
      </div>
    </div>
    <svg class="fonds-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <path d="M6 9l6 6 6-6"/>
    </svg>`;
  header.addEventListener('click', () => toggleTheme(themeName));
  block.appendChild(header);

  const body = document.createElement('div');
  body.className = 'fonds-body';
  body.id = `body-theme-${slugify(themeName)}`;
  block.appendChild(body);

  if (state.open) renderTable(body, records, 'theme||' + themeName, state);

  return block;
}

function toggleTheme(themeName) {
  const state = themeState[themeName];
  state.open = !state.open;

  const block = document.querySelector(`.theme-block[data-theme="${CSS.escape(themeName)}"]`);
  if (!block) return;

  block.classList.toggle('open', state.open);
  block.querySelector('.fonds-header').setAttribute('aria-expanded', state.open);

  if (state.open) {
    const raw_records = filteredRecords.filter(r => {
      const raw = r['930$e_11'] || '';
      const themes = raw.split(/[§,]/).map(t => t.trim()).filter(Boolean);
      return themes.length ? themes.includes(themeName) : themeName === '(Sans thème)';
    });
    const body = block.querySelector('.fonds-body');
    renderTable(body, raw_records, 'theme||' + themeName, state);
  }
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
  const desc = FONDS_INFO[fondsName] || '';
  const header = document.createElement('button');
  header.className = 'fonds-header';
  header.setAttribute('aria-expanded', state.open);
  header.innerHTML = `
    ${iconSVG}
    <div class="fonds-header-text">
      <div class="fonds-header-top">
        <span class="fonds-name">${fondsName}</span>
        <span class="fonds-badge">${records.length.toLocaleString('fr-FR')} doc${records.length > 1 ? 's' : ''}</span>
      </div>
      ${desc ? `<p class="fonds-header-desc">${esc(desc)}</p>` : ''}
      <div class="fonds-header-meta">
        <span class="fonds-meta-dates">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="13" height="13" style="vertical-align:-2px;margin-right:4px;"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>${dateStr}
        </span>
      </div>
    </div>
    <svg class="fonds-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <path d="M6 9l6 6 6-6"/>
    </svg>`;
  header.addEventListener('click', (e) => {
    if (e.target.closest('.fonds-info-btn')) return;
    toggleFonds(fondsName);
  });
  block.appendChild(header);

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
  block.querySelector('.fonds-header').setAttribute('aria-expanded', state.open);

  if (state.open) {
    const records = filteredRecords.filter(r => getFondsFromCote(r) === fondsName);
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
      const ra = state.sortDir === 'asc' ? a : b;
      const rb = state.sortDir === 'asc' ? b : a;
      if (state.sortCol === '930$g') {
        return compareCotes(ra['930$g'] || '', rb['930$g'] || '');
      }
      const va = (ra[state.sortCol] || '').toLowerCase();
      const vb = (rb[state.sortCol] || '').toLowerCase();
      return va.localeCompare(vb, 'fr');
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
    if (col.noSort) {
      th.innerHTML = col.label || '';
    } else {
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
    }
    hr.appendChild(th);
  });
  thead.appendChild(hr);
  table.appendChild(thead);

  // Corps
  const tbody = document.createElement('tbody');
  pageRecords.forEach((rec, idx) => {
    const rowId = `${slugify(stateKey)}-${start + idx}`;
    const lienNum = (rec['lien_num'] || '').trim();

    // ── Ligne compacte (état replié) ──────────────────────────
    const tr = document.createElement('tr');
    tr.className = 'inv-row';
    tr.dataset.rowId = rowId;
    tr.dataset.lienNum = lienNum;
    tr.style.cursor = 'pointer';
    tr.addEventListener('click', () => toggleDetail(rowId, rec));

    COLS.forEach(col => {
      const td = document.createElement('td');
      td.className = col.cls;
      let val = rec[col.key] || '';

      if (col.key === '_thumb') {
        const inner = document.createElement('div');
        inner.className = 'td-thumb-inner';
        inner.appendChild(buildThumbFrame(lienNum, false));
        td.appendChild(inner);
      } else if (col.key === '200$a') {
        td.innerHTML = `<span class="td-titre-text">${esc(val) || '<em style="color:var(--text-light)">Sans titre</em>'}</span>`;
      } else if (col.key === '700$a') {
        const prenoms = (rec['700$b'] || '').split('§').map(s => s.trim());
        const noms = val.split('§').map(s => s.trim()).filter(Boolean);
        const formatted = noms.map((n, i) => (n.toUpperCase() + (prenoms[i] ? ' ' + prenoms[i] : '')).trim()).join(', ');
        td.textContent = truncate(formatted, 60);
      } else if (col.key === '930$g') {
        td.innerHTML = val.split(',').map(c => `<span style="display:block">${esc(c.trim())}</span>`).join('');
      } else if (col.key === '200$b') {
        const typeInfo = TYPE_ICONS[val.trim()];
        if (typeInfo) {
          td.innerHTML = `<span class="type-icon-wrap" title="${esc(typeInfo.label)}" style="color:${typeInfo.color}">${typeInfo.svg}</span>`;
        } else if (val) {
          td.innerHTML = `<span class="type-icon-unknown" title="${esc(val)}">${esc(val.slice(0, 3))}</span>`;
        }
      } else {
        td.textContent = val;
      }
      tr.appendChild(td);
    });
    tbody.appendChild(tr);

    // ── Ligne expansée (état ouvert) ──────────────────────────
    const dtr = document.createElement('tr');
    dtr.className = 'inv-row-expanded';
    dtr.id = `detail-${rowId}`;
    const dtd = document.createElement('td');
    dtd.className = 'inv-expanded-cell';
    dtd.colSpan = COLS.length;
    dtd.appendChild(buildExpandedContent(rec, lienNum));
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
//  Miniature — fabrique un cadre image réutilisable
// ══════════════════════════════════════════
function buildThumbFrame(lienNum, large = false) {
  const frame = document.createElement('div');
  frame.className = 'doc-thumb-frame' + (large ? ' doc-thumb-frame--large' : '');

  const setPlaceholder = () => {
    frame.innerHTML = '';
    frame.classList.add('doc-thumb-frame--empty');
    frame.setAttribute('aria-hidden', 'true');
    frame.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2">
        <rect x="3" y="3" width="18" height="18" rx="2"/>
        <circle cx="8.5" cy="8.5" r="1.5"/>
        <polyline points="21 15 16 10 5 21"/>
      </svg>`;
  };

  if (lienNum) {
    const img = document.createElement('img');
    img.alt = '';
    img.className = 'doc-thumbnail';
    img.loading = 'lazy';
    img.decoding = 'async';
    img.title = 'Ouvrir le document numérisé';
    img.addEventListener('error', () => setPlaceholder());
    if (!large) {
      img.addEventListener('click', (e) => {
        e.stopPropagation();
        window.open(lienNum, '_blank', 'noopener');
      });
    }
    frame.appendChild(img);
    img.src = lienNum;
  } else {
    setPlaceholder();
  }
  return frame;
}

// ══════════════════════════════════════════
//  Contenu de la ligne expansée
// ══════════════════════════════════════════
function buildExpandedContent(rec, lienNum) {
  const wrap = document.createElement('div');
  wrap.className = 'inv-expanded-wrap';

  // ── Colonne gauche : grande miniature ──
  const imgCol = document.createElement('div');
  imgCol.className = 'inv-expanded-img';
  const largeFrame = buildThumbFrame(lienNum, true);
  if (lienNum) {
    largeFrame.addEventListener('click', (e) => {
      e.stopPropagation();
      window.open(lienNum, '_blank', 'noopener');
    });
    largeFrame.style.cursor = 'zoom-in';
  }
  imgCol.appendChild(largeFrame);
  wrap.appendChild(imgCol);

  // ── Colonne droite : titre complet + métadonnées ──
  const infoCol = document.createElement('div');
  infoCol.className = 'inv-expanded-info';

  // Titre complet
  const titre = rec['200$a'] || '';
  const titreEl = document.createElement('h3');
  titreEl.className = 'inv-expanded-title';
  titreEl.textContent = titre || '(Sans titre)';
  infoCol.appendChild(titreEl);

  // Auteur
  const prenoms = (rec['700$b'] || '').split('§').map(s => s.trim());
  const noms = (rec['700$a'] || '').split('§').map(s => s.trim()).filter(Boolean);
  const auteur = noms.map((n, i) => (n.toUpperCase() + (prenoms[i] ? ' ' + prenoms[i] : '')).trim()).join(', ');
  if (auteur) {
    const auteurEl = document.createElement('p');
    auteurEl.className = 'inv-expanded-author';
    auteurEl.textContent = auteur;
    infoCol.appendChild(auteurEl);
  }

  // Type de document avec icône
  const typeVal = (rec['200$b'] || '').trim();
  const typeInfo = TYPE_ICONS[typeVal];
  if (typeInfo || typeVal) {
    const typeEl = document.createElement('p');
    typeEl.className = 'inv-expanded-type';
    if (typeInfo) {
      typeEl.innerHTML = `<span class="type-icon-wrap" style="color:${typeInfo.color}">${typeInfo.svg}</span> ${esc(typeInfo.label)}`;
    } else {
      typeEl.textContent = typeVal;
    }
    infoCol.appendChild(typeEl);
  }

  // Grille de métadonnées
  const grid = document.createElement('div');
  grid.className = 'inv-expanded-grid';

  // Cote
  const cote = rec['930$g'] || '';
  if (cote) {
    const item = document.createElement('div');
    item.className = 'inv-expanded-item';
    item.innerHTML = `<span class="detail-label">Cote</span><span class="detail-value">${esc(cote)}</span>`;
    grid.appendChild(item);
  }

  // Année
  const annee = rec['210$d'] || '';
  if (annee) {
    const item = document.createElement('div');
    item.className = 'inv-expanded-item';
    item.innerHTML = `<span class="detail-label">Année</span><span class="detail-value">${esc(annee)}</span>`;
    grid.appendChild(item);
  }

  DETAIL_COLS.forEach(col => {
    const val = rec[col.key] || '';
    if (!val.trim()) return;
    const item = document.createElement('div');
    item.className = 'inv-expanded-item';
    item.innerHTML = `<span class="detail-label">${esc(col.label)}</span>
                      <span class="detail-value">${esc(truncate(val, 300))}</span>`;
    grid.appendChild(item);
  });
  infoCol.appendChild(grid);

  // Résumé
  const resume = rec['Description du contenu (résumé)'] || '';
  if (resume.trim()) {
    const p = document.createElement('div');
    p.className = 'inv-expanded-resume';
    p.innerHTML = `<em>Résumé —</em> ${esc(resume)}`;
    infoCol.appendChild(p);
  }

  // Bouton visionneuse — conditionné par la colonne "num"
  const numVal = (rec['num'] || '').trim();
  if (numVal) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'inv-expanded-link';
    btn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg> Consulter le document numérisé`;
    btn.addEventListener('click', e => {
      e.stopPropagation();
      openVisionneuse(numVal, rec['200$a'] || '');
    });
    infoCol.appendChild(btn);
  }

  wrap.appendChild(infoCol);

  // ── Pills cote + code-barre (bas droite du wrap) ──
  const pills = document.createElement('div');
  pills.className = 'inv-expanded-pills';
  const coteVal = (rec['930$g'] || '').trim();
  const barcode  = (rec['995$f'] || '').trim();
  if (coteVal) {
    pills.innerHTML += `<span class="inv-pill inv-pill--cote">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="11" height="11"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>
      ${esc(coteVal)}
    </span>`;
  }
  if (barcode) {
    pills.innerHTML += `<span class="inv-pill inv-pill--barcode">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="11" height="11"><path d="M3 5v14M7 5v14M11 5v14M15 5v14M19 5v14M3 5h2M3 19h2M7 5h2M7 19h2M11 5h2M11 19h2M15 5h2M15 19h2M19 5h2M19 19h2"/></svg>
      ${esc(barcode)}
    </span>`;
  }
  if (coteVal || barcode) wrap.appendChild(pills);

  return wrap;
}

function toggleDetail(rowId, rec) {
  const dtr = document.getElementById(`detail-${rowId}`);
  if (!dtr) return;

  const isOpen = dtr.classList.contains('visible');

  // Fermer toutes les autres lignes expansées
  document.querySelectorAll('.inv-row-expanded.visible').forEach(el => {
    if (el.id !== `detail-${rowId}`) {
      el.classList.remove('visible');
      const sibling = document.querySelector(`[data-row-id="${el.id.replace('detail-', '')}"]`);
      if (sibling) sibling.classList.remove('expanded');
    }
  });

  dtr.classList.toggle('visible', !isOpen);
  const tr = document.querySelector(`[data-row-id="${rowId}"]`);
  if (tr) tr.classList.toggle('expanded', !isOpen);

  // Scroll doux vers la ligne si on l'ouvre
  if (!isOpen) {
    setTimeout(() => dtr.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 50);
  }
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
  // Chercher le body du bon bloc (sous-fonds, thème, ou fonds)
  const sfBlock   = document.querySelector(`.sous-fonds-block[data-sfkey="${CSS.escape(stateKey)}"]`);
  const themeKey  = stateKey.startsWith('theme||') ? stateKey.slice(7) : null;
  const themeBlock = themeKey
    ? document.querySelector(`.theme-block[data-theme="${CSS.escape(themeKey)}"]`)
    : null;
  const fondsBlock = document.querySelector(`.fonds-block[data-fonds="${CSS.escape(stateKey)}"]`);
  const body = sfBlock
    ? sfBlock.querySelector('.sous-fonds-body')
    : themeBlock
      ? themeBlock.querySelector('.fonds-body')
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

/**
 * Décompose une cote en une liste de segments alternant texte et nombre,
 * pour permettre un tri naturel quel que soit le format :
 *   - "MS 1234"      → [{ t:'ms ', n:null }, { t:null, n:1234 }]
 *   - "A-B-3-12-7"   → [{ t:'a', n:null }, { t:'b', n:null }, { t:null, n:3 }, ...]
 * Les deux séparateurs reconnus sont l'espace (format lettre + numéro)
 * et le tiret (format hiérarchique).
 */
function parseCote(cote) {
  if (!cote) return [];
  // Normaliser : on traite la virgule (plusieurs cotes sur un enregistrement)
  // en ne comparant que la première cote listée
  const first = cote.split(',')[0].trim();
  // Découper sur les tirets et les espaces, en conservant le séparateur
  // pour distinguer les deux formats ; on utilise un split sur chaque
  // caractère non-alphanumérique
  const segments = [];
  // Regex : séquence de chiffres ou séquence de non-chiffres
  const re = /(\d+)|([^\d]+)/g;
  let m;
  while ((m = re.exec(first)) !== null) {
    if (m[1] !== undefined) {
      // Segment numérique
      segments.push({ isNum: true, num: parseInt(m[1], 10), str: m[1] });
    } else {
      // Segment textuel : on normalise en minuscules et on ignore
      // les séparateurs purs (espace, tiret) pour que la comparaison
      // porte sur les parties signifiantes
      const txt = m[2].toLowerCase();
      // On ne pousse pas les séparateurs seuls comme segment autonome
      // mais on les garde pour séparer les blocs alphanuméiques
      segments.push({ isNum: false, num: null, str: txt });
    }
  }
  return segments;
}

/**
 * Compare deux cotes selon un ordre naturel :
 *   1. Segment par segment (lettre avant chiffre)
 *   2. Les segments textuels sont comparés alphabétiquement
 *   3. Les segments numériques sont comparés numériquement
 * Retourne un entier négatif, nul, ou positif (comme localeCompare).
 */
function compareCotes(a, b) {
  const sa = parseCote(a);
  const sb = parseCote(b);
  const len = Math.max(sa.length, sb.length);
  for (let i = 0; i < len; i++) {
    if (i >= sa.length) return -1; // a plus court → avant
    if (i >= sb.length) return  1; // b plus court → avant
    const pa = sa[i], pb = sb[i];
    if (pa.isNum && pb.isNum) {
      if (pa.num !== pb.num) return pa.num - pb.num;
    } else if (!pa.isNum && !pb.isNum) {
      const c = pa.str.localeCompare(pb.str, 'fr');
      if (c !== 0) return c;
    } else {
      // Type différent : texte avant nombre
      return pa.isNum ? 1 : -1;
    }
  }
  return 0;
}

// ══════════════════════════════════════════
//  Modale visionneuse
// ══════════════════════════════════════════

/**
 * Ouvre la visionneuse patrimoniale dans une modale plein-écran.
 * @param {string} dossier  – valeur de la colonne "num" (identifiant du dossier dans le manifeste)
 * @param {string} titre    – titre du document, pour l'aria-label
 */
function openVisionneuse(dossier, titre) {
  // Créer la modale si elle n'existe pas encore
  let overlay = document.getElementById('visionneuse-overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'visionneuse-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.innerHTML = `
      <div class="visionneuse-modal" id="visionneuse-modal">
        <div class="visionneuse-modal-bar">
          <span class="visionneuse-modal-title" id="visionneuse-modal-title"></span>
          <button class="visionneuse-close-btn" id="visionneuse-close-btn" aria-label="Fermer la visionneuse">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" width="18" height="18">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
            Fermer
          </button>
        </div>
        <iframe id="visionneuse-iframe" class="visionneuse-iframe"
                src="" title="Visionneuse patrimoniale" allowfullscreen></iframe>
      </div>`;

    // Fermer en cliquant sur l'overlay (hors modale)
    overlay.addEventListener('click', e => {
      if (e.target === overlay) closeVisionneuse();
    });

    // Injecter le CSS de la modale
    if (!document.getElementById('visionneuse-modal-style')) {
      const style = document.createElement('style');
      style.id = 'visionneuse-modal-style';
      style.textContent = `
        #visionneuse-overlay {
          position: fixed;
          inset: 0;
          z-index: 9999;
          background: rgba(20, 16, 12, 0.78);
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 1.5rem;
          backdrop-filter: blur(3px);
          animation: visionneuse-fadein 0.18s ease;
        }
        @keyframes visionneuse-fadein {
          from { opacity: 0; }
          to   { opacity: 1; }
        }
        .visionneuse-modal {
          background: #1a1714;
          border-radius: 10px;
          width: 100%;
          max-width: 1400px;
          height: calc(100vh - 3rem);
          display: flex;
          flex-direction: column;
          overflow: hidden;
          box-shadow: 0 24px 64px rgba(0,0,0,0.6);
          animation: visionneuse-slidein 0.2s ease;
        }
        @keyframes visionneuse-slidein {
          from { transform: translateY(12px) scale(0.98); opacity: 0; }
          to   { transform: none; opacity: 1; }
        }
        .visionneuse-modal-bar {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 0.55rem 1rem 0.55rem 1.25rem;
          background: #111;
          border-bottom: 1px solid rgba(255,255,255,0.08);
          flex-shrink: 0;
        }
        .visionneuse-modal-title {
          font-family: Georgia, serif;
          font-size: 0.85rem;
          color: rgba(255,255,255,0.65);
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
          max-width: calc(100% - 140px);
        }
        .visionneuse-close-btn {
          display: inline-flex;
          align-items: center;
          gap: 0.35rem;
          padding: 0.3rem 0.75rem;
          border: 1px solid rgba(255,255,255,0.18);
          border-radius: 20px;
          background: transparent;
          color: rgba(255,255,255,0.75);
          font-family: inherit;
          font-size: 0.78rem;
          cursor: pointer;
          transition: background 0.15s, color 0.15s;
          flex-shrink: 0;
        }
        .visionneuse-close-btn:hover {
          background: rgba(255,255,255,0.1);
          color: #fff;
        }
        .visionneuse-iframe {
          flex: 1;
          border: none;
          width: 100%;
          display: block;
        }
        @media (max-width: 600px) {
          #visionneuse-overlay { padding: 0; }
          .visionneuse-modal { border-radius: 0; height: 100vh; }
        }
      `;
      document.head.appendChild(style);
    }

    document.body.appendChild(overlay);
    document.getElementById('visionneuse-close-btn').addEventListener('click', closeVisionneuse);
  }

  // Mettre à jour le titre et l'URL de l'iframe
  document.getElementById('visionneuse-modal-title').textContent = titre || 'Document numérisé';
  overlay.setAttribute('aria-label', `Visionneuse — ${titre || 'Document numérisé'}`);

  const src = `visionneuse.html?dossier=${encodeURIComponent(dossier)}`;
  document.getElementById('visionneuse-iframe').src = src;

  overlay.style.display = 'flex';
  document.body.style.overflow = 'hidden';

  // Fermer avec Échap
  overlay._escHandler = e => { if (e.key === 'Escape') closeVisionneuse(); };
  document.addEventListener('keydown', overlay._escHandler);
}

function closeVisionneuse() {
  const overlay = document.getElementById('visionneuse-overlay');
  if (!overlay) return;
  // Vider l'iframe avant de cacher pour libérer les ressources
  const iframe = document.getElementById('visionneuse-iframe');
  if (iframe) iframe.src = '';
  overlay.style.display = 'none';
  document.body.style.overflow = '';
  if (overlay._escHandler) {
    document.removeEventListener('keydown', overlay._escHandler);
    overlay._escHandler = null;
  }
}

// Exposer globalement (utile si appelé depuis d'autres scripts)
window.openVisionneuse  = openVisionneuse;
window.closeVisionneuse = closeVisionneuse;

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