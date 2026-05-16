/* ============================================================
   CONFIGURATION CENTRALE DES MÉTIERS
   ============================================================ */
const METIERS = [
    { key: 'imprimeur',   icon: 'fa-print',            bg: '#ee1e23', label: 'Imprimeur',   labelPl: 'Imprimeurs',   cssClass: 'imprimeur'   },
    { key: 'lithographe', icon: 'fa-palette',          bg: '#f1c40f', label: 'Lithographe', labelPl: 'Lithographes', cssClass: 'litho',  color: '#333' },
    { key: 'libraire',    icon: 'fa-book',             bg: '#3498db', label: 'Libraire',    labelPl: 'Libraires',    cssClass: 'libraire'    },
    { key: 'graveur',     icon: 'fa-screwdriver',      bg: '#9b59b6', label: 'Graveur',     labelPl: 'Graveurs',     cssClass: 'graveur'     },
    { key: 'relieur',     icon: 'fa-scroll',           bg: '#479167', label: 'Relieur',     labelPl: 'Relieurs',     cssClass: 'relieur'     },
    { key: 'typographe',  icon: 'fa-font',             bg: '#34495e', label: 'Typographe',  labelPl: 'Typographes',  cssClass: 'typographe'  },
    { key: 'journaliste', icon: 'fa-newspaper',        bg: '#8f6127', label: 'Journaliste', labelPl: 'Journalistes', cssClass: 'journaliste' },
    { key: 'photographe', icon: 'fa-camera-retro',     bg: '#ef8833', label: 'Photographe', labelPl: 'Photographes', cssClass: 'photographe' },
];

/* ============================================================
   ÉTAT GLOBAL
   ============================================================ */
const START_YEAR = 1550, END_YEAR = 2026;

let allDocsGlobal          = [];
let allIndividusGlobal     = [];
let allImprimeriesGlobal   = [];
let allImprimeriesCoordMap = {};
let allLieuxMap            = {};
let allRows                = [];
let timelineGroups         = [];
let allPeriodiquesGlobal   = [];
// Index : imprimerieId (string) → [périodiques]
let periodiquesParImprimerie = {};
let currentMarkers         = [];

let selectedEnseigne  = null;
let selectedPersonne  = null;
let selectedMetier    = null;
let lastViewBeforePersonne = 'list';

/* ============================================================
   UTILITAIRES
   ============================================================ */

/** Charge un fichier texte distant */
async function loadCSV(path) {
    const response = await fetch(path);
    return response.text();
}

/**
 * Retarde l'exécution d'une fonction jusqu'à ce que l'utilisateur
 * arrête d'appeler (utile pour la recherche).
 */
function debounce(fn, delay) {
    let timer;
    return (...args) => {
        clearTimeout(timer);
        timer = setTimeout(() => fn(...args), delay);
    };
}

/** Retourne l'année courante affichée dans l'interface */
function getCurrentYear() {
    return parseInt(yearValEl.textContent, 10);
}

/** Convertit un pourcentage de position en année */
function getYearPos(year) {
    return ((year - START_YEAR) / (END_YEAR - START_YEAR)) * 100;
}

/** Déplace la carte vers des coordonnées "lat,lng" */
function zoomTo(coordsStr) {
    if (!coordsStr || !coordsStr.includes(',')) return;
    const [lat, lng] = coordsStr.split(',').map(parseFloat);
    map.flyTo({ center: [lng, lat], zoom: 18, essential: true });
}

/** Formate une date "jj/mm/aaaa" en texte lisible */
function formatDate(dateStr) {
    if (!dateStr) return '?';
    const MOIS = ['janvier','février','mars','avril','mai','juin',
                  'juillet','août','septembre','octobre','novembre','décembre'];
    const m = dateStr.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (!m) return dateStr;
    return `${parseInt(m[1])} ${MOIS[parseInt(m[2]) - 1]} ${m[3]}`;
}

/** Résout un com-id en libellé de lieu */
function formatLieu(comId) {
    if (!comId || String(comId).trim() === '') return '';
    const lieu = allLieuxMap[String(comId).trim()];
    if (!lieu) return String(comId);
    const extras = [lieu['Département'], lieu['Pays']]
        .filter(v => v && v.trim())
        .map(v => v.trim());
    return extras.length > 0 ? `${lieu['Nom']} (${extras.join(', ')})` : lieu['Nom'];
}

/** Reformate un titre en petites capitales pour les mots tout-majuscules */
function formatTitle(str) {
    if (!str) return '';
    return str.replace(/\//g, ' ').replace(/\s+/g, ' ').trim()
        .split(' ')
        .map(word => {
            const cleanWord = word.replace(/[.,()!:;]/g, '');
            if (/^[A-ZÀ-ÖÙ-Ý]{2,}$/.test(cleanWord)) {
                return `<span class="custom-sc">${word[0]}<span>${word.slice(1).toLowerCase()}</span></span>`;
            }
            return word;
        })
        .join(' ');
}

/* ============================================================
   INITIALISATION DE LA CARTE
   ============================================================ */
const map = new maplibregl.Map({
    container: 'map',
    style: 'js/douai-livres-style.json',
    center: [3.0799, 50.3693],
    zoom: 15
});

map.on('load', async () => {
    /* --- Contour de la ville --- */
    map.addSource('douai-ville', { type: 'geojson', data: DouaiVilleGeojson });
    map.addLayer({
        id: 'douai-ville-layer',
        type: 'line',
        source: 'douai-ville',
        paint: { 'line-color': '#ee1e23', 'line-width': 3 }
    });

    /* --- Masque sombre hors arrondissement --- */
    map.addSource('douai-arrondissement', { type: 'geojson', data: DouaiArrondissementGeojson });
    try {
        const feature  = DouaiArrondissementGeojson.features[0];
        const geomType = feature.geometry.type;
        const coords   = feature.geometry.coordinates;

        let outerRing;
        if (geomType === 'MultiPolygon') {
            let biggest = coords[0][0];
            coords.forEach(poly => { if (poly[0].length > biggest.length) biggest = poly[0]; });
            outerRing = biggest;
        } else {
            outerRing = coords[0];
        }

        const inverseMask = {
            type: 'FeatureCollection',
            features: [{
                type: 'Feature',
                geometry: {
                    type: 'Polygon',
                    coordinates: [
                        [[-180, -85], [180, -85], [180, 85], [-180, 85], [-180, -85]],
                        [...outerRing]
                    ]
                }
            }]
        };

        map.addSource('douai-mask', { type: 'geojson', data: inverseMask });
        map.addLayer({
            id: 'douai-mask-layer',
            type: 'fill',
            source: 'douai-mask',
            paint: { 'fill-color': '#2c3e50', 'fill-opacity': 0.6 }
        }, 'douai-ville-layer');
        
        map.addSource('lignes-employes', {
            type: 'geojson',
            data: { type: 'FeatureCollection', features: [] }
        });
        map.addLayer({
            id: 'lignes-employes-layer',
            type: 'line',
            source: 'lignes-employes',
            paint: {
                'line-color': '#ee1e23',
                'line-opacity': 1,
                'line-width': 1.5,
                'line-dasharray': [4, 3]
            }
        });
        /* --- Chargement des données CSV --- */
        const [csvProf, csvIndiv, csvDocs, csvLieux, csvImprim, csvPeriod] = await Promise.all([
            loadCSV('csv/Professionnels.csv'),
            loadCSV('csv/Individus.csv'),
            loadCSV('csv/Documents.csv'),
            loadCSV('csv/Lieux.csv'),
            loadCSV('csv/Imprimeries.csv'),
            loadCSV('csv/periodiques.csv')
        ]);
        processAllData(csvProf, csvIndiv, csvDocs, csvLieux, csvImprim, csvPeriod);

    } catch (e) {
        console.warn('Erreur chargement masque ou données :', e);
    }

    /* --- Marqueurs des bibliothèques --- */
    let bibliothequesMarkers = [];

    function addBibliotheques() {
        bibliothequesMarkers.forEach(m => m.remove());
        bibliothequesMarkers = [];

        DouaiBibliotheques.forEach(biblio => {
            const el = document.createElement('div');
            el.style.cssText = 'width:auto; display:flex; flex-direction:column; align-items:center; justify-content:center;';
            el.innerHTML = `
                <i class="fa-solid fa-book-open" style="color:#ee1e23; font-size:13px; background:rgba(255,255,255,0.25); padding:5px;"></i>
                <span style="font-size:10px; font-weight:bold; color:#333; text-align:center; white-space:nowrap; background:rgba(255,255,255,0.25); padding:2px; border-radius:3px;">
                    ${biblio.nom}
                </span>`;

            bibliothequesMarkers.push(
                new maplibregl.Marker({ element: el, anchor: 'top' })
                    .setLngLat(biblio.coords)
                    .addTo(map)
            );
        });
    }

    addBibliotheques();

    /* Masquer/afficher selon le zoom — debounce léger pour éviter le surappel */
    map.on('zoom', debounce(() => {
        const zoom = map.getZoom();
        bibliothequesMarkers.forEach(m => {
            m.getElement().style.display = zoom > 12 ? 'flex' : 'none';
        });
        currentMarkers.forEach(m => {
            m.getElement().style.display = zoom >= 13 ? '' : 'none';
        });
        updateCityBadges(getCurrentYear());
    }, 50));

    if (map.getZoom() <= 12) {
        bibliothequesMarkers.forEach(m => m.getElement().style.display = 'none');
    }

    map.setMinZoom(9.5);
});

/* ============================================================
   TRAITEMENT DES DONNÉES
   ============================================================ */
function processAllData(csvProf, csvIndiv, csvDocs, csvLieux, csvImprim, csvPeriod) {
    /* --- Individus --- */
    const individusData = Papa.parse(csvIndiv, { header: true, delimiter: ';' }).data;
    allIndividusGlobal  = individusData;
    const individusMap  = {};
    individusData.forEach(ind => { if (ind['ind-id']) individusMap[ind['ind-id']] = ind; });

    /* --- Lieux --- */
    Papa.parse(csvLieux, { header: true, delimiter: ';' }).data
        .forEach(l => { if (l['com-id']) allLieuxMap[l['com-id']] = l; });

    /* --- Imprimeries --- */
    const imprimData = Papa.parse(csvImprim, { header: true, delimiter: ';' }).data;
    allImprimeriesGlobal = imprimData.filter(imp => imp['Nom'] && imp['Localisation']).map(imp => ({
        nom: imp['Nom'].trim(),
        coords: imp['Localisation'],
        start: parseInt(imp["Début d'activité"], 10) || 0,
        end: parseInt(imp["Fin d'activité"], 10) || 0
    }));
    const imprimeriesMap = {};
    imprimData.forEach(imp => { if (imp['N°']) imprimeriesMap[imp['N°']] = imp['Nom']; });

    allImprimeriesCoordMap = {};
    imprimData.forEach(imp => {
        if (imp['N°'] && imp['Localisation']) {
            allImprimeriesCoordMap[imp['N°'].trim()] = imp['Localisation'].trim();
        }
    });

    /* --- Documents + liaison par auteur secondaire --- */
    const docsData = Papa.parse(csvDocs, { header: true, delimiter: ';' }).data;
    allDocsGlobal  = docsData;

    const docsMap = {};
    docsData.forEach(doc => {
        const raw = doc['Auteur secondaire'];
        if (!raw) return;
        raw.split(';').forEach(entry => {
            const parts = entry.split('.');
            const proId = parts[0].trim();
            const role  = parts[1] ? parts[1].trim() : null;
            if (!docsMap[proId]) docsMap[proId] = [];
            docsMap[proId].push({ ...doc, roleSpecifique: role });
        });
    });

    /* --- Professionnels --- */
    const extractYear = str => {
        if (!str) return null;
        const m = str.match(/\d{4}/);
        return m ? parseInt(m[0], 10) : null;
    };

    allRows = Papa.parse(csvProf, { header: true, delimiter: ';' }).data
        .filter(row => row.Nom && row.Nom.trim())
        .map(row => {
            const ind    = individusMap[row.Nom];
            const proId  = row['pro-id'];
            const nomAff = ind
                ? `${ind.Nom.toUpperCase()} ${ind['Prénom(s)'] || ''}`.trim()
                : 'Nom inconnu';

            const sesDocuments = (docsMap[proId] || [])
                .sort((a, b) => (parseInt(a['Année de publication'], 10) || 0)
                              - (parseInt(b['Année de publication'], 10) || 0));

            let start = parseInt(row["Début d'activité"], 10) || 0;
            let end   = parseInt(row['Fin d\'activité'],  10) || 0;

            if (start === 0 && row['Notes']) {
                const m = row['Notes'].match(/\b(1[5-9]\d{2}|20\d{2})\b/);
                if (m) start = parseInt(m[0], 10);
            }

            const nomImprimerie = imprimeriesMap[row.imprimerie?.trim()] || row.imprimerie?.trim() || null;

            return {
                ...row,
                nomComplet:    nomAff,
                nomFamille:    ind ? ind['Nom']        : '',
                prenoms:       ind ? ind['Prénom(s)']  : '',
                dateNaissance: ind ? ind['Date de naissance'] : '?',
                lieuNaissance: ind ? formatLieu(ind['Lieu de naissance']) : '',
                dateDeces:     ind ? ind['Date de décès']      : '?',
                lieuDeces:     ind ? formatLieu(ind['Lieu de décès'])     : '',
                pere:     ind ? ind['Père']           : '',
                mere:     ind ? ind['Mère']           : '',
                conjoint: ind ? ind['Epouse / Epoux'] : '',
                documents:    sesDocuments,
                communeLabel: formatLieu(row['Commune']),
                imprimerie:   nomImprimerie,
                imprimerieId: row.imprimerie?.trim() || null,
                start,
                end
            };
        })
        .filter(row => row.start > 0 || row.coordonnées);

    /* --- Groupes timeline --- */
    timelineGroups = imprimData
    .filter(imp => imp['Nom'] && imp['Nom'].trim())
    .map(imp => ({
        name:     imp['Nom'].trim(),
        minStart: parseInt(imp["Début d'activité"], 10) || 0,
        maxEnd:   parseInt(imp["Fin d'activité"],   10) || 0,
    }))
    .filter(g => g.minStart > 0)
    .sort((a, b) => a.minStart - b.minStart);

    /* --- Périodiques --- */
    if (csvPeriod) {
        allPeriodiquesGlobal = Papa.parse(csvPeriod, { header: true, delimiter: ';' }).data
            .filter(p => p['nom'] && p['nom'].trim());

        periodiquesParImprimerie = {};
        allPeriodiquesGlobal.forEach(p => {
            ['imprimeur', 'imprimeur2', 'imprimeur3'].forEach(col => {
                const val = p[col] ? String(p[col]).trim().replace(/\.0$/, '') : null;
                if (!val || val === '' || val === 'NaN') return;
                if (!periodiquesParImprimerie[val]) periodiquesParImprimerie[val] = [];
                // Éviter les doublons si le même titre est déjà là
                if (!periodiquesParImprimerie[val].find(x => x['period-id'] === p['period-id'])) {
                    periodiquesParImprimerie[val].push(p);
                }
            });
        });
    }

    setupTimeline();
    updateDisplay(1862);
}

/* ============================================================
   GÉNÉRATION DE L'INTERFACE
   ============================================================ */

/** Badge inline compact (petit rond coloré) pour chaque métier exercé */
function getBadges(p) {
    let h = '<div style="display:inline-flex; gap:4px;">';
    let any = false;
    METIERS.forEach(m => {
        if (p[m.key] === '1') {
            h += `<span class="brevet-badge bg-${m.cssClass}" title="${m.label}"><i class="fa-solid ${m.icon}"></i></span>`;
            any = true;
        }
    });
    if (!any) h += `<span class="brevet-badge bg-unknown"><i class="fa-solid fa-question"></i></span>`;
    return h + '</div>';
}

/** Badge large cliquable (accès à la liste du métier) */
function getBigBadges(p) {
    const badges = METIERS
        .filter(m => p[m.key] === '1')
        .map(m => `
            <div onclick="showMetierList('${m.key}')"
                    title="Voir tous les ${m.labelPl}"
                    style="display:flex; align-items:center; background:white; border:1px solid #ddd; border-radius:20px; padding:4px 12px; gap:8px; font-size:0.8em; margin-bottom:5px; cursor:pointer; transition:0.2s;"
                    onmouseover="this.style.background='#f0f4ff'; this.style.borderColor='#aab';"
                    onmouseout="this.style.background='white'; this.style.borderColor='#ddd';">
                <i class="fa-solid ${m.icon}" style="color:${m.bg};"></i>
                <strong style="color:${m.color || '#2c3e50'}">${m.label}</strong>
            </div>`);
    return badges.length > 0 ? badges.join('') : '<i>Non renseigné</i>';
}

function getMetierTagsForEnseigne(allMetiers) {
    return METIERS
        .filter(m => allMetiers.has(m.key))
        .map(m => `
            <div onclick="showMetierList('${m.key}')"
                    title="Voir tous les ${m.labelPl}"
                    style="display:flex; align-items:center; background:white; border:1px solid #ddd; border-radius:20px; padding:4px 12px; gap:8px; font-size:0.8em; cursor:pointer; transition:0.2s;"
                    onmouseover="this.style.background='#f0f4ff'; this.style.borderColor='#aab';"
                    onmouseout="this.style.background='white'; this.style.borderColor='#ddd';">
                <i class="fa-solid ${m.icon}" style="color:${m.bg};"></i>
                <strong style="color:${m.color || '#2c3e50'}">${m.label}</strong>
            </div>`).join('');
}

function renderDocumentsList(docs) {
    if (!docs || docs.length === 0) return '';
    return `
    <details class="docs-accordion" style="margin-top:15px; border-top:1px dashed #ccc; padding-top:10px;">
        <summary style="display:flex; align-items:center; justify-content:space-between; font-size:0.75em; color:#ee1e23; font-weight:bold; text-transform:uppercase; cursor:pointer; list-style:none; outline:none;">
            <span><i class="fa-solid fa-book-open"></i> Publications (${docs.length})</span>
            <i class="fa-solid fa-chevron-down toggle-icon" style="font-size:0.9em; transition: 0.3s;"></i>
        </summary>
        <div style="margin-top:10px; max-height: 400px; overflow-y: auto; padding-right: 5px;">
            ${docs.map(d => {
                const docId = d['Identifiant (id)'] || d['Titre'];
                const roleBadge = d.roleSpecifique ? `<span style="font-size:0.8em; color:#7f8c8d; font-style:italic; margin-left:5px;">(${d.roleSpecifique})</span>` : '';
                return `
                <div class="doc-item"
                        onclick="event.stopPropagation(); showBookDetail('${docId.replace(/'/g, "\\'")}')"
                        style="display:flex; background:#fff; border:1px solid #eee; padding:8px; border-radius:5px; margin-bottom:5px; font-size:0.85em; cursor:pointer; transition:0.2s;">
                    <div style="min-width:40px; font-weight:bold; color:#ee1e23; border-right:1px solid #eee; margin-right:8px;">
                        ${d['Année de publication'] || 's.d.'}
                    </div>
                    <div style="flex:1;">
                        <div class="doc-item-title" style="font-weight:bold; color:#2c3e50; font-variant:none;">
                            ${formatTitle(d['Titre'])} ${roleBadge}
                        </div>
                    </div>
                </div>`;
            }).join('')}
        </div>
    </details>`;
}

/** Ouvre le panneau de détail d'un périodique */
function showPeriodicalDetail(periodId) {
    const p = allPeriodiquesGlobal.find(x => String(x['period-id']) === String(periodId));
    if (!p) return;

    const panel = document.getElementById('book-panel');
    panel.style.display = 'block';

    const debut   = p['date de première parution'] || '?';
    const fin     = p['date de dernière parution']  || '?';
    const freq    = p['fréquence']  || null;
    const cote    = p['cote']       || null;
    const notes   = p['notes']      || null;
    const source  = p['source1']    || null;
    const villeLabel = formatLieu(String(p['ville'] || '').trim());

    // Résoudre les noms des imprimeurs (peuvent être plusieurs)
    const imprimeurIds = ['imprimeur', 'imprimeur2', 'imprimeur3']
        .map(col => p[col] ? String(p[col]).trim().replace(/\.0$/, '') : null)
        .filter(v => v && v !== '' && v !== 'NaN');

    const dateChangement = p["date changement d'imprimeur"] || null;

    const imprimeurItems = imprimeurIds.map((id, idx) => {
        // Chercher l'enseigne correspondant à cet ID
        const impData = allImprimeriesGlobal.find(imp => {
            // allImprimeriesGlobal n'a pas l'id brut, on cherche via allRows
            return false;
        });
        // Chercher dans allRows le nom d'enseigne via imprimerieId
        const pro = allRows.find(r => r.imprimerieId && String(r.imprimerieId).trim() === String(id));
        const nomEnseigne = pro ? pro.imprimerie : `Imprimerie n°${id}`;
        const changeNote = (idx === 0 && dateChangement) ? `<span style="font-size:0.8em; color:#999; margin-left:6px;">(jusqu'au ${dateChangement})</span>` : '';
        const clickable = !!pro;
        return `
        <div ${clickable ? `onclick="document.getElementById('book-panel').style.display='none'; selectedEnseigne='${(nomEnseigne || '').replace(/'/g, "\\'")}'; selectedPersonne=null; updateDisplay(getCurrentYear());" style="cursor:pointer;"` : ''}
             style="display:inline-flex; align-items:center; gap:6px; background:#f8f9fa; border:1px solid #e0e0e0; border-radius:6px; padding:5px 10px; margin-bottom:5px; font-size:0.85em; ${clickable ? 'transition:0.2s;' : ''}"
             ${clickable ? `onmouseover="this.style.borderColor='#ee1e23'; this.style.background='#fffafa';" onmouseout="this.style.borderColor='#e0e0e0'; this.style.background='#f8f9fa';"` : ''}>
            <i class="fa-solid fa-shop" style="color:#2c3e50;"></i>
            <strong>${nomEnseigne}</strong>${changeNote}
        </div>`;
    }).join('');

    // Icône fréquence
    const freqIconMap = {
        'quotidien': 'fa-calendar-day',
        'hebdomadaire': 'fa-calendar-week',
        'mensuel': 'fa-calendar',
        'bimensuel': 'fa-calendar',
        'trihebdomadaire': 'fa-calendar-week',
        'bihebdomadaire': 'fa-calendar-week',
        'bimestriel': 'fa-calendar',
        'trimestriel': 'fa-calendar',
        'annuel': 'fa-calendar',
        'irrégulier': 'fa-calendar-xmark',
    };
    const freqKey = freq ? Object.keys(freqIconMap).find(k => freq.toLowerCase().includes(k)) : null;
    const freqIcon = freqKey ? freqIconMap[freqKey] : 'fa-clock';

    panel.innerHTML = `
        <button class="close-book-btn" onclick="document.getElementById('book-panel').style.display='none'">&times;</button>
        <div class="book-detail-header">
            <h3 class="book-title-styled" style="color:#3498db;">
                <i class="fa-solid fa-newspaper" style="font-size:0.7em; opacity:0.7; margin-right:6px;"></i>${p['nom']}
            </h3>
        </div>

        <div class="book-field">
            <span class="book-label">Période de parution</span>
            <div class="book-value" style="font-size:1.05em; font-weight:bold; color:#2c3e50;">
                ${debut} — ${fin}
            </div>
        </div>

        ${freq ? `
        <div class="book-field">
            <span class="book-label">Fréquence</span>
            <div class="book-value">
                <span style="display:inline-flex; align-items:center; gap:7px; background:#eaf4fb; border:1px solid #c5e3f5; border-radius:20px; padding:4px 12px; font-size:0.88em; color:#2471a3;">
                    <i class="fa-solid ${freqIcon}"></i> ${freq}
                </span>
            </div>
        </div>` : ''}

        ${villeLabel ? `
        <div class="book-field">
            <span class="book-label">Ville</span>
            <div class="book-value">${villeLabel}</div>
        </div>` : ''}

        ${imprimeurIds.length > 0 ? `
        <div class="book-field">
            <span class="book-label">Imprimeur${imprimeurIds.length > 1 ? 's' : ''}</span>
            <div class="book-value" style="display:flex; flex-direction:column; gap:4px; margin-top:4px;">
                ${imprimeurItems}
            </div>
        </div>` : ''}

        ${notes ? `
        <div class="book-field">
            <span class="book-label">Notes</span>
            <div class="book-value" style="font-style:italic; font-size:0.9em; color:#555;">${notes}</div>
        </div>` : ''}

        ${(cote || source) ? `
        <hr style="border:none; border-top:1px solid #eee; margin:15px 0;">
        <div class="book-field" style="background:#f8f9fa; padding:12px; border-radius:8px; border:1px solid #e0e0e0;">
            <span class="book-label">Références bibliothèque</span>
            ${cote   ? `<div class="book-value"><i class="fa-solid fa-bookmark" style="color:#3498db; margin-right:6px;"></i><strong>Cote :</strong> ${cote}</div>`   : ''}
            ${source ? `<div class="book-value" style="margin-top:4px;"><i class="fa-solid fa-book" style="color:#7f8c8d; margin-right:6px;"></i><strong>Source :</strong> ${source}</div>` : ''}
        </div>` : ''}

        <div class="book-field" style="margin-top:12px; opacity:0.5; font-size:0.7em;">
            <span class="book-label">Identifiant technique</span>
            <div>${p['period-id']}</div>
        </div>`;
}

/** Formate et affiche la liste des périodiques d'une enseigne */
function renderPeriodiquesForEnseigne(imprimerieId) {
    const periodiques = periodiquesParImprimerie[String(imprimerieId)] || [];
    if (periodiques.length === 0) return '';

    const items = periodiques
        .slice()
        .sort((a, b) => {
            const ya = parseInt((a['date de première parution'] || '').match(/\d{4}/)?.[0], 10) || 9999;
            const yb = parseInt((b['date de première parution'] || '').match(/\d{4}/)?.[0], 10) || 9999;
            return ya - yb;
        })
        .map(p => {
            const debut = p['date de première parution'] || '?';
            const fin   = p['date de dernière parution'] || '?';
            const freq  = p['fréquence'] || null;
            const pid   = String(p['period-id']);
            return `
            <div class="doc-item"
                    onclick="event.stopPropagation(); showPeriodicalDetail('${pid}')"
                    style="display:flex; align-items:stretch; background:#fff; border:1px solid #d6eaf8; border-left:3px solid #3498db; padding:0; border-radius:5px; margin-bottom:6px; font-size:0.85em; cursor:pointer; transition:0.2s; overflow:hidden;"
                    onmouseover="this.style.background='#eaf4fb';" onmouseout="this.style.background='#fff';">
                <div style="min-width:46px; display:flex; flex-direction:column; align-items:center; justify-content:center; background:#eaf4fb; border-right:1px solid #d6eaf8; padding:6px 4px; gap:1px;">
                    <div style="font-weight:bold; color:#2471a3; font-size:0.88em; text-align:center; line-height:1.1;">${debut.match(/\d{4}/)?.[0] || '?'}</div>
                    <div style="color:#aaa; font-size:0.7em;">↓</div>
                    <div style="font-weight:bold; color:#2471a3; font-size:0.82em; text-align:center; line-height:1.1;">${fin.match(/\d{4}/)?.[0] || fin}</div>
                </div>
                <div style="flex:1; padding:7px 9px;">
                    <div style="font-weight:bold; color:#2c3e50; line-height:1.3;">${p['nom']}</div>
                    ${freq ? `<div style="margin-top:3px; font-size:0.78em; color:#7f8c8d; font-style:italic;"><i class="fa-solid fa-clock" style="margin-right:3px;"></i>${freq}</div>` : ''}
                </div>
                <div style="display:flex; align-items:center; padding:0 8px; color:#aaa; font-size:0.8em;">
                    <i class="fa-solid fa-chevron-right"></i>
                </div>
            </div>`;
        }).join('');

    return `
    <details class="docs-accordion" style="margin-top:15px; border-top:1px dashed #ccc; padding-top:10px;">
        <summary style="display:flex; align-items:center; justify-content:space-between; font-size:0.75em; color:#3498db; font-weight:bold; text-transform:uppercase; cursor:pointer; list-style:none; outline:none;">
            <span><i class="fa-solid fa-newspaper"></i> Périodiques (${periodiques.length})</span>
            <i class="fa-solid fa-chevron-down toggle-icon" style="font-size:0.9em; transition: 0.3s;"></i>
        </summary>
        <div style="margin-top:10px; max-height:350px; overflow-y:auto; padding-right:5px;">
            ${items}
        </div>
    </details>`;
}


/** Affiche la liste des publications regroupées par dirigeant de l'enseigne */
function renderPublicationsParDirigeant(titulaires) {
    // Ne garder que les dirigeants ayant au moins une publication
    const avecDocs = titulaires.filter(p => p.documents && p.documents.length > 0);
    if (avecDocs.length === 0) return '';

    const totalDocs = avecDocs.reduce((sum, p) => sum + p.documents.length, 0);

    const items = avecDocs.map(p => {
        const docItems = p.documents.map(d => {
            const docId = d['Identifiant (id)'] || d['Titre'];
            const roleBadge = d.roleSpecifique ? `<span style="font-size:0.8em; color:#7f8c8d; font-style:italic; margin-left:5px;">(${d.roleSpecifique})</span>` : '';
            return `
            <div class="doc-item"
                    onclick="event.stopPropagation(); showBookDetail('${docId.replace(/'/g, "\\'")}')"
                    style="display:flex; background:#fff; border:1px solid #eee; padding:7px 8px; border-radius:5px; margin-bottom:4px; font-size:0.82em; cursor:pointer; transition:0.2s;">
                <div style="min-width:40px; font-weight:bold; color:#ee1e23; border-right:1px solid #eee; margin-right:8px;">
                    ${d['Année de publication'] || 's.d.'}
                </div>
                <div style="flex:1;">
                    <div class="doc-item-title" style="font-weight:bold; color:#2c3e50; font-variant:none;">
                        ${formatTitle(d['Titre'])} ${roleBadge}
                    </div>
                </div>
            </div>`;
        }).join('');

        return `
        <div style="margin-bottom:10px;">
            <div style="font-size:0.78em; font-weight:bold; color:#555; text-transform:uppercase; letter-spacing:0.03em; margin-bottom:5px; padding:4px 6px; background:#f5f5f5; border-radius:4px;">
                <i class="fa-solid fa-user-tie" style="color:#ee1e23; margin-right:5px;"></i>${p.nomComplet}
                <span style="font-weight:normal; color:#999; margin-left:4px;">(${p.documents.length} pub.)</span>
            </div>
            ${docItems}
        </div>`;
    }).join('');

    return `
    <details class="docs-accordion" style="margin-top:15px; border-top:1px dashed #ccc; padding-top:10px;">
        <summary style="display:flex; align-items:center; justify-content:space-between; font-size:0.75em; color:#ee1e23; font-weight:bold; text-transform:uppercase; cursor:pointer; list-style:none; outline:none;">
            <span><i class="fa-solid fa-book-open"></i> Monographies (${totalDocs})</span>
            <i class="fa-solid fa-chevron-down toggle-icon" style="font-size:0.9em; transition: 0.3s;"></i>
        </summary>
        <div style="margin-top:10px; max-height:450px; overflow-y:auto; padding-right:5px;">
            ${items}
        </div>
    </details>`;
}

function generateMaterialBadges(langCode, descMat) {
    const badges = [];

    const langMap = {
        fre: { label: 'Français',  flag: '🇫🇷' },
        eng: { label: 'Anglais',   flag: '🇬🇧' },
        lat: { label: 'Latin',     flag: '🏛️'  },
        dut: { label: 'Néerl.',    flag: '🇳🇱' },
        nld: { label: 'Néerl.',    flag: '🇳🇱' },
        ger: { label: 'Allemand',  flag: '🇩🇪' },
        deu: { label: 'Allemand',  flag: '🇩🇪' },
        spa: { label: 'Espagnol',  flag: '🇪🇸' },
        ita: { label: 'Italien',   flag: '🇮🇹' },
        por: { label: 'Portugais', flag: '🇵🇹' },
        gre: { label: 'Grec',      flag: '🏺'  },
        heb: { label: 'Hébreu',    flag: '✡️'  },
        ara: { label: 'Arabe',     flag: '🌙'  },
    };

    if (langCode && langCode.trim()) {
        const lang = langMap[langCode.trim().toLowerCase()] || { label: langCode.trim().toUpperCase(), flag: '🌐' };
        badges.push(`
            <div class="mat-badge" title="Langue : ${lang.label}">
                <span style="font-size:1.7em; line-height:1;">${lang.flag}</span>
                <span class="mat-badge-label">${lang.label}</span>
            </div>`);
    }

    if (!descMat || !descMat.trim()) return badges.join('');

    const parts = descMat.split(/[,;]/).map(s => s.trim()).filter(s => s.length > 0);
    if (parts.length === 0) return badges.join('');

    const lastPart = parts[parts.length - 1];
    const cmMatch  = lastPart.match(/^(\d[\d,.]*)\s*cm$/i);
    const inMatch  = lastPart.match(/^in[-\s]?(\d+|2|plano|4|8|f°)/i);
    const hasFormat    = cmMatch || inMatch;
    const contentParts = hasFormat ? parts.slice(0, -1) : parts;

    /* Badge pages */
    if (contentParts.length > 0) {
        const first  = contentParts[0];
        const pMatch = first.match(/\(([IVXLC\d][\w\s]*?\d+)\s*(?:p|f)\.\)/)
                    || first.match(/([IVXLC\d][\d\s\-+]*)\s*(?:p|f)\./i);
        if (pMatch) {
            const isFeuillets = /\bf\b/i.test(first) && !/\bp\b/i.test(first);
            badges.push(`
                <div class="mat-badge" title="${first}">
                    <i class="fa-solid fa-file-lines" style="font-size:1.5em; color:#ee1e23;"></i>
                    <span class="mat-badge-label">${pMatch[1].trim()} ${isFeuillets ? 'f.' : 'p.'}</span>
                </div>`);
        } else if (first.length < 30) {
            badges.push(`
                <div class="mat-badge" title="${first}">
                    <i class="fa-solid fa-book-open" style="font-size:1.4em; color:#3498db;"></i>
                    <span class="mat-badge-label" style="font-size:0.6em; text-transform:none; font-weight:500; max-width:80px; white-space:normal; line-height:1.1;">${first}</span>
                </div>`);
        }
    }

    /* Badges illustrations */
    const illTypes = [
        { test: /portr/,                icon: 'fa-user',             color: '#8e44ad', label: 'Portrait(s)' },
        { test: /carte|plan(?!che)/,    icon: 'fa-map',              color: '#27ae60', label: 'Carte(s)'    },
        { test: /fig/,                  icon: 'fa-chart-area',       color: '#e67e22', label: 'Figure(s)'   },
        { test: /pl\./,                 icon: 'fa-images',           color: '#2980b9', label: 'Planche(s)'  },
        { test: /front/,                icon: 'fa-image',            color: '#c0392b', label: 'Frontispice' },
        { test: /couv(?:erture)?.*ill/, icon: 'fa-book',             color: '#e67e22', label: 'Couv. ill.'  },
        { test: /ill/,                  icon: 'fa-palette',          color: '#e67e22', label: 'Ill.'        },
        { test: /grav/,                 icon: 'fa-drafting-compass', color: '#7f8c8d', label: 'Gravure(s)'  },
        { test: /photo/,                icon: 'fa-camera',           color: '#2c3e50', label: 'Photo(s)'    },
        { test: /music|not(?:e|ation)/, icon: 'fa-music',            color: '#9b59b6', label: 'Musique'     },
    ];

    const illParts  = contentParts.slice(1);
    const illText   = illParts.join(', ').toLowerCase();
    const isColor   = /coul/i.test(illText);
    const shownTypes = new Set();

    illParts.forEach(part => {
        illTypes.forEach(t => {
            if (t.test.test(part.toLowerCase()) && !shownTypes.has(t.label)) {
                shownTypes.add(t.label);
                const colorStyle = `color:${isColor && t.icon.includes('palette') ? '#ee1e23' : t.color};`;
                badges.push(`
                    <div class="mat-badge" title="${part}">
                        <i class="fa-solid ${t.icon}" style="font-size:1.4em; ${colorStyle}"></i>
                        <span class="mat-badge-label">${t.label}</span>
                        ${isColor ? '<span class="mat-badge-sub">couleur</span>' : ''}
                    </div>`);
            }
        });
    });

    /* Badge format */
    if (hasFormat) {
        let iconSizePx, formatLabel;
        if (cmMatch) {
            const cm = parseFloat(cmMatch[1]);
            formatLabel = `${cm} cm`;
            if      (cm >= 50) iconSizePx = 34;
            else if (cm >= 38) iconSizePx = 29;
            else if (cm >= 30) iconSizePx = 24;
            else if (cm >= 22) iconSizePx = 20;
            else if (cm >= 16) iconSizePx = 16;
            else if (cm >= 12) iconSizePx = 13;
            else               iconSizePx = 11;
        } else {
            const inVal = inMatch[1].toLowerCase();
            formatLabel = `in-${inVal}`;
            const inSizes = { plano:2,'f°':2,folio:2,'2':2,'4':1.7,quarto:1.7,'8':1.35,octavo:1.35,
                              '12':1.1,'16':0.9,'18':0.85,'24':0.75,'32':0.65,'64':0.55 };
            iconSizePx = Math.round(20 * (inSizes[inVal] || 1.1));
        }
        badges.push(`
            <div class="mat-badge" title="Format : ${lastPart}">
                <i class="fa-solid fa-ruler-combined" style="font-size:${iconSizePx}px; color:#2c3e50;"></i>
                <span class="mat-badge-label">${formatLabel}</span>
            </div>`);
    }

    return badges.join('');
}

/** Formatte la cellule "Auteur secondaire" en liens cliquables */
function formatSecondaryAuthors(idsString) {
    if (!idsString) return '<em>Non renseigné</em>';
    return idsString.split(';').map(entry => {
        const parts     = entry.trim().split('.');
        const numericId = parts[0].trim();
        const role      = parts[1] ? parts[1].trim() : null;
        const roleBadge = role ? `<span class="contributeur-role">(${role})</span>` : '';

        const pro = allRows.find(p => String(p['pro-id']) === numericId);
        if (pro) {
            return `<a class="contributeur-pill"
                        onclick="selectedPersonne='${pro.Nom}'; document.getElementById('book-panel').style.display='none'; updateDisplay(${pro.start}); zoomTo('${pro.coordonnées || ''}');">
                        <i class="fa-solid fa-user-tie" style="margin-right:10px;"></i> ${pro.nomComplet}${roleBadge}
                    </a>`;
        }

        const brute = allIndividusGlobal.find(i => String(i['ind-id']) === numericId);
        if (brute) {
            return `<span style="color:#7f8c8d;">${brute.Nom} ${brute['Prénom(s)'] || ''}${roleBadge}</span>`;
        }

        return entry;
    }).join(' ');
}

function showBookDetail(id) {
    const book = allDocsGlobal.find(d =>
        String(d['Identifiant (id)']) === String(id) || d['Titre'] === id
    );
    if (!book) return;

    const panel = document.getElementById('book-panel');
    panel.style.display = 'block';

    const contributeursHTML = formatSecondaryAuthors(book['Auteur secondaire']);
    const idno         = book['Identifiant (IDNO)'];
    const syracuseLink = idno ? `https://www.bm-douai.fr/Default/doc/SYRACUSE/${idno}` : null;
    const titreNettoye = formatTitle(book['Titre']);

    const codesBarres   = (book['Code-barres exemplaire'] || '').split(',').map(s => s.trim());
    const cotes         = (book['Cote 1 des exemplaires'] || '').split(',').map(s => s.trim());
    const localisations = (book['Localisation'] || '').split(',').map(s => s.trim());

    let exemplairesHTML = '';
    for (let i = 0; i < Math.max(codesBarres.length, cotes.length); i++) {
        const loc = localisations[i] || localisations[0] || 'Réserve patrimoniale';
        exemplairesHTML += `
            <div class="exemplaire-box">
                <div class="exemplaire-loc">
                    <i class="fa-solid fa-map-marker-alt" style="color:#ee1e23; margin-right:5px;"></i>
                    ${loc}
                </div>
                <div class="exemplaire-pills">
                    <div class="pill pill-barcode"><i class="fa-solid fa-barcode"></i> ${codesBarres[i] || 'N/A'}</div>
                    <div class="pill pill-cote"><i class="fa-solid fa-bookmark"></i> ${cotes[i] || 'N/A'}</div>
                </div>
            </div>`;
    }

    panel.innerHTML = `
        <button class="close-book-btn" onclick="document.getElementById('book-panel').style.display='none'">&times;</button>
        <div class="book-detail-header">
            <h3 class="book-title-styled">${titreNettoye}</h3>
        </div>
        <div class="book-field">
            <span class="book-label">Année et Lieu</span>
            <div class="book-value">${book['Année de publication'] || 's.d.'} — ${book['Adresse de publication'] || 'Douai'}</div>
        </div>
        <div class="book-field">
            <span class="book-label">Auteur principal</span>
            <div class="book-value">${book['Auteur (AUTA_display)'] || 'Anonyme'}</div>
        </div>
        <div class="book-field">
            <span class="book-label">Contributeur(s)</span>
            <div class="book-value" style="margin-top:5px;">${contributeursHTML}</div>
        </div>
        ${(book['Code langue du document'] || book['Description matérielle']) ? `
        <div class="book-field">
            <span class="book-label">Caractéristiques matérielles</span>
            <div class="mat-badges-row">
                ${generateMaterialBadges(book['Code langue du document'], book['Description matérielle'])}
            </div>
        </div>` : ''}
        ${book['Note générale'] ? `
        <div class="book-field">
            <span class="book-label">Notes</span>
            <div class="book-value" style="font-style:italic; font-size:0.9em;">${book['Note générale']}</div>
        </div>` : ''}
        <hr style="border:none; border-top:1px solid #eee; margin:20px 0;">
        <div class="book-field" style="background:#f8f9fa; padding:15px; border-radius:8px; border:1px solid #e0e0e0;">
            <span class="book-label">Localisation physique</span>
            <div class="book-value" style="margin-bottom:12px;">
                <strong><i class="fa-solid fa-book"></i> Bibliothèque Marceline Desbordes-Valmore — Douai</strong>
            </div>
            <div class="exemplaires-container">${exemplairesHTML}</div>
            ${syracuseLink ? `
                <a href="${syracuseLink}" target="_blank"
                        style="display:inline-flex; align-items:center; gap:8px; background-color:#2c3e50; color:white; padding:10px 15px; border-radius:5px; text-decoration:none; font-size:0.85em; font-weight:bold; margin-top:15px; width:calc(100% - 30px); justify-content:center;">
                    <i class="fa-solid fa-external-link-alt"></i> Voir sur le site de la Bibliothèque
                </a>` : ''}
        </div>
        <div class="book-field" style="margin-top:15px; opacity:0.6; font-size:0.7em;">
            <span class="book-label">Identifiant technique</span>
            <div>${book['Identifiant (id)']}</div>
            <div>${book['Créateur de la notice']}</div>
        </div>`;
}

/** Affiche tous les professionnels d'un métier donné */
function showMetierList(metierKey) {
    selectedMetier = metierKey;
    const meta = METIERS.find(m => m.key === metierKey);

    const liste = allRows
        .filter(r => r[metierKey] === '1')
        .sort((a, b) => (a.start || 9999) - (b.start || 9999));

    const grp = {}, indep = [];
    liste.forEach(p => {
        if (p.imprimerie?.trim()) {
            if (!grp[p.imprimerie]) grp[p.imprimerie] = [];
            grp[p.imprimerie].push(p);
        } else {
            indep.push(p);
        }
    });

    const year = getCurrentYear();
    let html = `
        <div class="info-header">
            <button class="back-btn" onclick="selectedMetier=null; renderPanel(${year})">
                <i class="fa-solid fa-arrow-left"></i> Retour
            </button>
            <h2><i class="fa-solid ${meta.icon}" style="color:${meta.bg};"></i> ${meta.labelPl}</h2>
            <small>${liste.length} professionnel${liste.length > 1 ? 's' : ''} recensé${liste.length > 1 ? 's' : ''}</small>
        </div>`;

    Object.keys(grp).sort().forEach(e => {
        const membres = grp[e];
        const minS = Math.min(...membres.map(p => p.start).filter(s => s > 0));
        const maxE = Math.max(...membres.map(p => p.end).filter(e => e > 0));
        html += `
            <div class="enseigne-group">
                <div class="box-header" onclick="selectedEnseigne='${e.replace(/'/g, "\\'")}'; selectedMetier=null; updateDisplay(${Math.max(year, minS)});">
                    <div class="box-title"><i class="fa-solid fa-shop"></i> ${e}</div>
                    <div style="font-size:0.75em; color:#666;">
                        ${minS || '?'} — ${maxE > 0 ? maxE : '?'}
                    </div>
                </div>
                ${membres.map(p => `
                    <div class="employe-item"
                            onclick="event.stopPropagation(); lastViewBeforePersonne='list'; selectedPersonne='${p.Nom.replace(/'/g, "\\'")}'; selectedMetier=null; updateDisplay(${p.start || year})">
                        <div style="display:flex; justify-content:space-between; align-items:center;">
                            <div>
                                <strong>${p.nomComplet}</strong>
                                <div style="font-size:0.8em; color:#7f8c8d;">
                                    ${p.start || '?'} — ${p.end > 0 ? p.end : '?'}
                                </div>
                            </div>
                            ${getBadges(p)}
                        </div>
                    </div>`).join('')}
            </div>`;
    });

    indep.forEach(p => {
        html += `
            <div class="enseigne-group">
                <div class="box-header"
                        onclick="lastViewBeforePersonne='list'; selectedPersonne='${p.Nom.replace(/'/g, "\\'")}'; selectedMetier=null; updateDisplay(${p.start || year}); zoomTo('${p.coordonnées || ''}')">
                    <div class="box-title-row">
                        <div class="box-title"><i class="fa-solid fa-user"></i> ${p.nomComplet}</div>
                        <div>${getBadges(p)}</div>
                    </div>
                    <div style="font-size:0.75em; color:#666; margin-top:3px;">
                        ${p.start || '?'} — ${p.end > 0 ? p.end : '?'}
                    </div>
                </div>
            </div>`;
    });

    document.getElementById('info-content').innerHTML = html || '<p>Aucun résultat.</p>';
}

/** Rendu du panneau latéral selon l'état global */
function renderPanel(year) {
    const content = document.getElementById('info-content');

    /* --- Vue : détail d'une enseigne --- */
    if (selectedEnseigne) {
        const hist    = allRows.filter(r => r.imprimerie === selectedEnseigne).sort((a, b) => a.start - b.start);
        const minStart = Math.min(...hist.map(p => p.start).filter(s => s > 0));
        const maxEnd   = Math.max(...hist.map(p => p.end).filter(e => e > 0));
        const periodeStr = `${minStart || '?'} — ${maxEnd > 0 ? maxEnd : 'en activité'}`;

        const allMetiers = new Set();
        hist.forEach(p => METIERS.forEach(m => { if (p[m.key] === '1') allMetiers.add(m.key); }));

        const titulaires = hist.filter(p => p.patron === '1');
        const ouvriers   = hist.filter(p => p.patron !== '1');

        const adresseRef = hist.find(p => p.adresse)?.adresse || 'Adresse inconnue';
        const communeRef = hist.find(p => p.communeLabel)?.communeLabel || '';
        const coordRef   = hist.find(p => p.coordonnées)?.coordonnées;

        // Récupère l'ID numérique de l'imprimerie pour chercher les périodiques
        const impIdRef = hist.find(p => p.imprimerieId)?.imprimerieId || null;

        content.innerHTML = `
            <div class="info-header">
                <button class="back-btn" onclick="selectedEnseigne=null; updateDisplay(${year})">
                    <i class="fa-solid fa-arrow-left"></i> Retour
                </button>
                <h2><i class="fa-solid fa-shop"></i> Établissement</h2>
                <small><i>${selectedEnseigne}</i></small>
            </div>
            <div class="id-card-container">
                <div class="id-card-top">
                    <div class="id-photo-placeholder" style="font-size:38px; background:#eaf0fb; border-color:#bcd;">
                        <i class="fa-solid fa-shop" style="color:#2c3e50;"></i>
                    </div>
                    <div class="id-main-title">
                        <div class="id-name-birth" style="font-size:1.05em; line-height:1.3;">
                            ${selectedEnseigne.toUpperCase()}
                        </div>
                        <div style="margin-top:6px; font-size:0.82em; color:#555; line-height:1.8; border-top:1px dashed #ddd; padding-top:6px;">
                            <div style="color:#7f8c8d; font-style:italic;">${hist.length} patron${hist.length > 1 ? 's' : ''} successif${hist.length > 1 ? 's' : ''}</div>
                        </div>
                    </div>
                </div>
                <div class="id-details">
                    <div class="id-section-sep"></div>
                    <span class="id-label">Adresse :</span>
                    <div style="color:#2c3e50; line-height:1.8;">
                        ${adresseRef}, ${communeRef}
                        ${coordRef ? `<button onclick="zoomTo('${coordRef}')" style="margin-left:8px; background:#ee1e23; color:white; border:none; border-radius:4px; padding:2px 7px; font-size:0.85em; cursor:pointer;" title="Centrer la carte"><i class="fa-solid fa-crosshairs"></i></button>` : ''}
                    </div>
                    <div class="id-section-sep"></div>
                    <span class="id-label">Activités exercées :</span>
                    <div style="display:flex; flex-wrap:wrap; gap:5px; margin:10px 0; justify-content:space-evenly;">
                        ${getMetierTagsForEnseigne(allMetiers)}
                    </div>
                    <span class="id-label">Période d'activité :</span> 
                    <div style="text-align:center; font-size:1.2em; color:#2c3e50; margin-bottom:10px; padding:5px;">
                        <strong>${periodeStr}</strong>
                    </div>
                    <div class="id-section-sep"></div>
                    <span class="id-label"><i class="fa-solid fa-user-tie"></i> Dirigeants :</span>
                    ${titulaires.map(p => renderPersonItem(p, year)).join('')}

                    ${ouvriers.length > 0 ? `
                        <div class="id-section-sep"></div>
                        <span class="id-label"><i class="fa-solid fa-users"></i> Ouvriers et employés :</span>
                        ${ouvriers.map(p => renderPersonItem(p, year)).join('')}
                    ` : ''}
                </div>
                ${renderPublicationsParDirigeant(titulaires)}
                ${impIdRef ? renderPeriodiquesForEnseigne(impIdRef) : ''}
            </div>`;

    /* --- Vue : fiche d'un individu --- */
    } else if (selectedPersonne) {
        const p = allRows.find(r => r.Nom === selectedPersonne);
        if (!p) { content.innerHTML = '<p>Personne introuvable.</p>'; return; }

        const predId = p['Prédécesseur'] ? String(p['Prédécesseur']).trim() : null;
        const succId = p['Successeur']   ? String(p['Successeur']).trim()   : null;

        const predIndiv = allIndividusGlobal.find(i => String(i['ind-id']).trim() === predId);
        const succIndiv = allIndividusGlobal.find(i => String(i['ind-id']).trim() === succId);
        const predPro   = allRows.find(r => String(r.Nom).trim() === predId);
        const succPro   = allRows.find(r => String(r.Nom).trim() === succId);

        const buildSucc = (indiv, pro, label, icon) => {
            if (!indiv) return `<div style="opacity:0.3;"><small style="font-size:0.65em;">Aucun ${label.toLowerCase()}</small></div>`;
            const nom = `${indiv.Nom.toUpperCase()} ${indiv['Prénom(s)'] || ''}`.trim();
            const clickable = !!pro;
            const action = clickable ? `selectedPersonne='${indiv['ind-id']}'; updateDisplay(${pro.start})` : '';
            return `
                <div onclick="${action}"
                        style="cursor:${clickable ? 'pointer' : 'default'}; text-align:${icon === 'left' ? 'left' : 'right'}; border:1px solid #eee; padding:8px; border-radius:6px; background:#fff; transition:0.2s; ${!clickable ? 'opacity:0.6;' : ''}"
                        ${clickable ? `onmouseover="this.style.borderColor='#ee1e23'; this.style.background='#fffafa';" onmouseout="this.style.borderColor='#eee'; this.style.background='#fff';"` : ''}>
                    <small style="color:#ee1e23; font-weight:bold; text-transform:uppercase; font-size:0.65em; display:block; margin-bottom:3px;">
                        ${icon === 'left' ? '<i class="fa-solid fa-arrow-left"></i> ' : ''}${label}${icon === 'right' ? ' <i class="fa-solid fa-arrow-right"></i>' : ''}
                    </small>
                    <div style="font-size:0.85em; font-weight:bold; color:#2c3e50; line-height:1.2;">${nom}</div>
                    ${!clickable ? '<small style="font-size:0.7em; color:#999;">(Pas de fiche pro)</small>' : ''}
                </div>`;
        };

        content.innerHTML = `
            <div class="info-header">
                <button class="back-btn" onclick="handleBackFromPersonne(${year})">
                    <i class="fa-solid fa-arrow-left"></i> Retour
                </button>
                <h2><i class="fa-solid fa-user"></i> Individu</h2>
                <small><i>${p.prenoms ? p.prenoms.split(' ')[0] : ''} ${p.nomFamille ? p.nomFamille.toUpperCase() : ''}</i></small>
            </div>
            <div class="id-card-container">
                <div class="id-card-top">
                    <div class="id-photo-placeholder"><i class="fa-solid fa-user-tie"></i></div>
                    <div class="id-main-title">
                        <div class="id-name-birth" style="font-size:1.1em;">
                            ${p.prenoms ? p.prenoms.split(' ')[0] : ''} ${p.nomFamille ? p.nomFamille.toUpperCase() : ''}
                        </div>
                        <div style="margin-top:6px; font-size:0.82em; color:#555; line-height:1.8; border-top:1px dashed #ddd; padding-top:6px;">
                            <div><span style="font-weight:700; text-transform:uppercase; font-size:0.85em; color:#7f8c8d;">Nom</span>
                                &nbsp;${p.nomFamille ? p.nomFamille.toUpperCase() : '<i>—</i>'}</div>
                            <div><span style="font-weight:700; text-transform:uppercase; font-size:0.85em; color:#7f8c8d;">Prénom(s)</span>
                                &nbsp;${p.prenoms || '<i>—</i>'}</div>
                        </div>
                    </div>
                </div>
                <div class="id-details">
                    <div class="id-section-sep"></div>
                    <span class="id-label">État civil :</span>
                    <div style="font-size:0.78em; color:#2c3e50; line-height:1.6;">
                        <div><i class="fa-solid fa-baby-carriage" style="color:#ee1e23; width:14px;"></i> le ${formatDate(p.dateNaissance)} ${p.lieuNaissance ? 'à ' + p.lieuNaissance : ''}</div>
                        <div><i class="fa-solid fa-cross"         style="color:#ee1e23; width:14px;"></i> le ${formatDate(p.dateDeces)} ${p.lieuDeces ? 'à ' + p.lieuDeces : ''}</div>
                    </div>
                    <div class="id-section-sep"></div>
                    <span class="id-label">Famille :</span>
                    <div style="font-size:0.9em; margin-bottom:10px; line-height:1.4;">
                        ${p.pere    ? `<div><strong>Père :</strong> ${p.pere}</div>`       : ''}
                        ${p.mere    ? `<div><strong>Mère :</strong> ${p.mere}</div>`       : ''}
                        ${p.conjoint ? `<div><strong>Conjoint :</strong> ${p.conjoint}</div>` : ''}
                        ${(!p.pere && !p.mere && !p.conjoint) ? '<i>Non renseignée</i>' : ''}
                    </div>
                    <div class="id-section-sep"></div>
                    <span class="id-label">Adresse :</span>
                    <div style="margin-bottom:10px; display:flex; align-items:center; gap:8px;">
                        ${p.adresse || 'Non renseignée'}, ${p.communeLabel}
                        ${p.coordonnées ? `<button onclick="zoomTo('${p.coordonnées}')" style="background:#ee1e23; color:white; border:none; border-radius:4px; padding:2px 7px; font-size:0.85em; cursor:pointer;" title="Centrer la carte"><i class="fa-solid fa-crosshairs"></i></button>` : ''}
                    </div>
                    <div class="id-section-sep"></div>
                    <span class="id-label">Activités exercées :</span>
                    <div style="display:flex; flex-wrap:wrap; justify-content:space-evenly; align-items:center; gap:5px; margin:10px 0;">
                        ${getBigBadges(p)}
                    </div>
                    <div class="id-section-sep"></div>
                    <span class="id-label">Période d'activité :</span> 
                    <div style="text-align:center; font-size:1.2em; color:#2c3e50; margin-bottom:10px; padding:5px;">
                        <strong>${p.start || '?'} — ${p.end > 0 ? p.end : '?'}</strong>
                    </div>
                
                    <!-- SECTION ÉTABLISSEMENT : Affichée pour tous si renseignée -->
                    ${p.imprimerie ? `
                        <div class="id-section-sep"></div>
                        <div onclick="selectedEnseigne='${p.imprimerie.replace(/'/g, "\\'")}'; selectedPersonne=null; updateDisplay(${year})"
                                style="cursor:pointer; background:#f8f9fa; border:1px solid #eee; padding:10px; border-radius:6px; margin:10px 0; transition:0.2s;"
                                onmouseover="this.style.borderColor='#ee1e23'; this.style.background='#fffafa';" 
                                onmouseout="this.style.borderColor='#eee'; this.style.background='#f8f9fa';">
                            <i class="fa-solid fa-shop" style="color:#2c3e50;"></i>
                            <strong style="color:#2c3e50;"> - ${p.imprimerie}</strong>
                        </div>
                    ` : ''}

                    <!-- SECTION SUCCESSION : Uniquement pour les patrons -->
                    ${p.patron === '1' ? `
                        <div style="display:flex; justify-content:space-between; gap:10px; margin-top:10px;">
                            <div style="flex:1;">${buildSucc(predIndiv, predPro, 'Prédécesseur', 'left')}</div>
                            <div style="flex:1;">${buildSucc(succIndiv, succPro, 'Successeur',   'right')}</div>
                        </div>
                    ` : `
                        ${p.imprimerie ? `
                            <div style="padding: 10px; background: #eee; border-radius: 6px; font-size: 0.8em; color: #777; text-align: center; font-style: italic;">
                                <i class="fa-solid fa-users"></i> Ouvrier à l'imprimerie
                            </div>
                        ` : ''}
                    `}
                </div>
                ${renderDocumentsList(p.documents)}
            </div>`;

    /* --- Vue : liste des actifs pour l'année --- */
    } else {
        const actifs = allRows.filter(r => year >= r.start && (r.end === 0 || year <= r.end));
        let html = `<div class="info-header"><h2>Professionnels en ${year}</h2><small>${actifs.length} actif(s)</small></div>`;

        const grp = {}, indep = [];
        actifs.forEach(a => {
            if (a.imprimerie?.trim()) {
                if (!grp[a.imprimerie]) grp[a.imprimerie] = [];
                grp[a.imprimerie].push(a);
            } else {
                indep.push(a);
            }
        });

        Object.keys(grp).sort().forEach(e => {
            html += `<div class="enseigne-group">
                <div class="box-header" onclick="selectedEnseigne='${e.replace(/'/g, "\\'")}'; updateDisplay(${year})">
                    <div class="box-title"><i class="fa-solid fa-shop"></i> ${e}</div>
                    <div style="font-size:0.75em; color:#666;"><i class="fa-solid fa-location-dot"></i> ${grp[e][0].adresse || ''}</div>
                </div>
                ${grp[e].map(m => `
                    <div class="employe-item" onclick="event.stopPropagation(); lastViewBeforePersonne='list'; selectedPersonne='${m.Nom.replace(/'/g, "\\'")}'; updateDisplay(${year});">
                        <strong>${m.nomComplet}</strong> ${getBadges(m)}
                    </div>`).join('')}
            </div>`;
        });

        indep.forEach(i => {
            html += `<div class="enseigne-group">
                <div class="box-header" onclick="lastViewBeforePersonne='list'; selectedPersonne='${i.Nom.replace(/'/g, "\\'")}'; updateDisplay(${year}); zoomTo('${i.coordonnées || ''}')">
                    <div class="box-title-row">
                        <div class="box-title"><i class="fa-solid fa-user"></i> ${i.nomComplet}</div>
                        <div>${getBadges(i)}</div>
                    </div>
                </div>
            </div>`;
        });

        content.innerHTML = html || '<p>Aucun résultat pour cette année.</p>';
    }
}

/** Génère le HTML d'une ligne de professionnel pour les listes */
function renderPersonItem(p, year) {
    const actif = year >= p.start && (p.end === 0 || year <= p.end);
    return `
        <div class="employe-item"
                onclick="lastViewBeforePersonne='enseigne'; selectedPersonne='${p.Nom.replace(/'/g, "\\'")}'; selectedEnseigne=null; updateDisplay(${year})"
                style="${actif ? 'background:#fff5f4; border-left-color:#ee1e23; border-left-width:4px;' : 'opacity:0.75;'}">
            <div style="display:flex; justify-content:space-between; align-items:flex-start;">
                <div>
                    <strong>${p.nomComplet}</strong>
                    ${actif ? '<span style="color:#ee1e23; font-weight:bold; font-size:0.75em; margin-left:6px;">● ACTUEL</span>' : ''}
                    <div style="font-size:0.8em; color:#7f8c8d; margin-top:2px;">
                        ${p.start || '?'} — ${p.end > 0 ? p.end : '?'}
                    </div>
                </div>
                ${getBadges(p)}
            </div>
        </div>`;
}

/** Gère le retour depuis une fiche individu */
function handleBackFromPersonne(year) {
    if (lastViewBeforePersonne === 'enseigne') {
        const p = allRows.find(r => r.Nom === selectedPersonne);
        if (p) selectedEnseigne = p.imprimerie;
        selectedPersonne = null;
    } else {
        selectedPersonne = null;
        selectedEnseigne = null;
    }
    updateDisplay(year);
}

/* ============================================================
   MARQUEURS VILLES (vue dézoomée)
   ============================================================ */
const CITIES = [
    { name: 'Douai',       coords: [3.0799,    50.3693]    },
    { name: 'Orchies',     coords: [3.244110,  50.475226]  },
    { name: 'Marchiennes', coords: [3.281178,  50.407868]  },
    { name: 'Somain',      coords: [3.281058,  50.359018]  },
];
let cityMarkers = [];

function updateCityBadges(year) {
    cityMarkers.forEach(m => m.remove());
    cityMarkers = [];

    if (map.getZoom() >= 13) return;

    const actifs = allRows.filter(r => year >= r.start && (r.end === 0 || year <= r.end) && r.coordonnées);

    CITIES.forEach(city => {
        const count = actifs.filter(r => {
            const [lat, lng] = r.coordonnées.split(',').map(parseFloat);
            const dlat = lat - city.coords[1], dlng = lng - city.coords[0];
            return Math.sqrt(dlat * dlat + dlng * dlng) < 0.09;
        }).length;

        if (count === 0) return;

        const el = document.createElement('div');
        el.style.cssText = `background:#2c3e50; color:white; border:3px solid #ee1e23; border-radius:50px;
            padding:6px 14px; font-weight:bold; font-size:13px; display:flex; align-items:center;
            gap:8px; cursor:pointer; box-shadow:0 2px 8px rgba(0,0,0,0.4); white-space:nowrap;`;
        el.innerHTML = `${city.name} <span style="background:#ee1e23; border-radius:20px; padding:1px 7px;"><i class="fa-solid fa-user"></i> ${count}</span>`;
        el.onclick = () => map.flyTo({ center: city.coords, zoom: 15, essential: true });

        cityMarkers.push(
            new maplibregl.Marker({ element: el, anchor: 'center' })
                .setLngLat(city.coords)
                .addTo(map)
        );
    });
}

/* ============================================================
   MISE À JOUR PRINCIPALE
   ============================================================ */

/** Cache de l'élément DOM de l'année pour éviter les requêtes répétées */
const yearValEl = document.getElementById('year-val');

function updateDisplay(year) {
    yearValEl.textContent = year;
    document.getElementById('current-year-line').style.left = getYearPos(year) + '%';

    currentMarkers.forEach(m => m.remove());
    currentMarkers = [];

    const lignesFeatures = [];
    if (selectedPersonne || selectedEnseigne) {
        allRows.forEach(row => {
            if (!(year >= row.start && (row.end === 0 || year <= row.end))) return;
            if (!row.coordonnées || !row.imprimerieId) return;
            // Si une personne est sélectionnée, ne trace que sa ligne
            // Si une enseigne est sélectionnée, trace les lignes de tous ses employés
            if (selectedPersonne && row.Nom !== selectedPersonne) return;
            if (selectedEnseigne && row.imprimerie !== selectedEnseigne) return;
            const impCoords = allImprimeriesCoordMap[String(row.imprimerieId).trim()];
            if (!impCoords) return;
            const [latP, lngP] = row.coordonnées.split(',').map(parseFloat);
            const [latI, lngI] = impCoords.split(',').map(parseFloat);
            lignesFeatures.push({
                type: 'Feature',
                geometry: { type: 'LineString', coordinates: [[lngP, latP], [lngI, latI]] }
            });
        });
    }
    if (map.getSource('lignes-employes')) {
        map.getSource('lignes-employes').setData({ type: 'FeatureCollection', features: lignesFeatures });
    }

    allRows.forEach(row => {
        if (!(year >= row.start && (row.end === 0 || year <= row.end) && row.coordonnées)) return;

        const [lat, lng] = row.coordonnées.split(',').map(parseFloat);
        const el = document.createElement('div');

        let metierPrincipal = 'unknown';
        let icon = 'fa-question';

        for (const m of METIERS) {
            if (row[m.key] === '1') {
                metierPrincipal = m.cssClass;
                icon = m.icon;
                break;
            }
        }

        el.className = `marker-small bg-${metierPrincipal}`;
        if (selectedPersonne === row.Nom) el.classList.add('marker-selected');
        el.innerHTML = `<i class="fa-solid ${icon}"></i>`;

        el.onclick = (e) => {
            e.stopPropagation();
            selectedPersonne = row.Nom;
            selectedEnseigne = null;
            lastViewBeforePersonne = 'list';
            updateDisplay(year);
        };

        const marker = new maplibregl.Marker({ element: el }).setLngLat([lng, lat]).addTo(map);
        currentMarkers.push(marker);
    });

    allImprimeriesGlobal.forEach(imp => {
        // On vérifie les dates de début et de fin d'activité de l'imprimerie
        if (!(year >= imp.start && (imp.end === 0 || year <= imp.end))) return;

        const [lat, lng] = imp.coords.split(',').map(parseFloat);
        const el = document.createElement('div');
        el.className = `marker-main bg-imprimeur`;
        if (selectedEnseigne === imp.nom) el.classList.add('marker-selected');
        el.innerHTML = `<i class="fa-solid fa-print"></i>`;

        el.onclick = (e) => {
            e.stopPropagation();
            selectedEnseigne = imp.nom;
            selectedPersonne = null;
            updateDisplay(year);
        };

        const marker = new maplibregl.Marker({ element: el }).setLngLat([lng, lat]).addTo(map);
        currentMarkers.push(marker);
    });

    const zoom = map.getZoom();
    currentMarkers.forEach(m => {
        m.getElement().style.display = zoom >= 13 ? '' : 'none';
    });

    updateCityBadges(year);
    document.querySelectorAll('.imprimerie-bar').forEach(bar => {
        const start = parseInt(bar.dataset.start, 10);
        const end   = parseInt(bar.dataset.end, 10);
        const isActive = year >= start && (end === 0 || year <= end);
        bar.classList.toggle('active-year', isActive);
    });
    renderPanel(year);
}

/* ============================================================
   TIMELINE — SOURIS ET TACTILE
   ============================================================ */
function setupTimeline() {
    const tContent = document.getElementById('timeline-content');
    const tYears   = document.getElementById('timeline-years');
    tYears.innerHTML  = '';
    tContent.innerHTML = '';

    for (let y = START_YEAR; y <= END_YEAR; y += 25) {
        const txt = document.createElement('div');
        txt.className = 'year-text';
        txt.style.left = getYearPos(y) + '%';
        txt.textContent = y;
        tYears.appendChild(txt);
    }

    timelineGroups.forEach(group => {
        const row = document.createElement('div');
        row.className = 'imprimerie-row';
        const bar = document.createElement('div');
        bar.className = 'imprimerie-bar';
        bar.style.left  = getYearPos(group.minStart) + '%';
        bar.style.width = Math.max(getYearPos(group.maxEnd) - getYearPos(group.minStart), 1.5) + '%';
        bar.textContent = group.name;
        bar.dataset.start = group.minStart;
        bar.dataset.end   = group.maxEnd;
        bar.onclick = () => {
            selectedEnseigne = group.name;
            selectedPersonne = null;
            updateDisplay(getCurrentYear());
        };
        row.appendChild(bar);
        tContent.appendChild(row);
    });
}

const handle  = document.getElementById('timeline-handle');
const wrapper = document.getElementById('timeline-wrapper');
let isDragging = false;

function getYearFromEvent(clientX) {
    const rect = wrapper.getBoundingClientRect();
    const x = Math.max(0, Math.min(clientX - rect.left, rect.width));
    return Math.round(START_YEAR + ((x / rect.width) * (END_YEAR - START_YEAR)));
}

/* Souris */
handle.addEventListener('mousedown', () => { isDragging = true; });
window.addEventListener('mouseup',   () => { isDragging = false; });
window.addEventListener('mousemove', e => {
    if (!isDragging) return;
    updateDisplay(getYearFromEvent(e.clientX));
});

/* Tactile (tablettes, écrans tactiles) */
handle.addEventListener('touchstart', e => {
    isDragging = true;
    e.preventDefault(); // empêche le scroll pendant le drag
}, { passive: false });

window.addEventListener('touchend', () => { isDragging = false; });

window.addEventListener('touchmove', e => {
    if (!isDragging) return;
    updateDisplay(getYearFromEvent(e.touches[0].clientX));
}, { passive: true });

/* ============================================================
   BARRE DE RECHERCHE — avec debounce
   ============================================================ */
const searchInput   = document.getElementById('search-input');
const searchResults = document.getElementById('search-results');
let currentSearchMode = 'person';

function setSearchMode(mode) {
    currentSearchMode = mode;
    document.getElementById('mode-person').classList.toggle('active-mode', mode === 'person');
    document.getElementById('mode-book').classList.toggle('active-mode', mode === 'book');
    searchInput.placeholder = mode === 'person'
        ? 'Rechercher une personne ou enseigne...'
        : 'Rechercher un titre de livre...';
    searchInput.value = '';
    searchResults.style.display = 'none';
}

searchInput.addEventListener('input', debounce(e => {
    const val = e.target.value.toLowerCase().trim();
    searchResults.innerHTML = '';

    if (val.length < 2) { searchResults.style.display = 'none'; return; }

    let matches = [];

    if (currentSearchMode === 'person') {
        matches = allRows.filter(r =>
            (r.nomComplet  && r.nomComplet.toLowerCase().includes(val)) ||
            (r.imprimerie  && r.imprimerie.toLowerCase().includes(val))
        ).slice(0, 15);

        matches.forEach(m => {
            const div = document.createElement('div');
            div.className = 'search-result-item';
            const shopPart = m.imprimerie
                ? `<span class="search-subtext"><i class="fa-solid fa-shop"></i> ${m.imprimerie}</span>`
                : '<span class="search-subtext">Indépendant</span>';
            div.innerHTML = `<strong>${m.nomComplet}</strong>${shopPart}`;
            div.onclick = () => {
                selectedPersonne = m.Nom;
                selectedEnseigne = null;
                updateDisplay(m.start);
                zoomTo(m.coordonnées);
                searchResults.style.display = 'none';
                searchInput.value = '';
            };
            searchResults.appendChild(div);
        });
    } else {
        // Livres
        const docMatches = allDocsGlobal.filter(d =>
            d['Titre'] && d['Titre'].toLowerCase().includes(val)
        ).slice(0, 10);

        // Périodiques
        const periodMatches = allPeriodiquesGlobal.filter(p =>
            p['nom'] && p['nom'].toLowerCase().includes(val)
        ).slice(0, 5);

        matches = [...docMatches, ...periodMatches];

        docMatches.forEach(d => {
            const div = document.createElement('div');
            div.className = 'search-result-item';
            div.innerHTML = `
                <strong>${formatTitle(d['Titre'])}</strong>
                <span class="search-subtext">
                    ${d['Auteur (AUTA_display)'] || 'Anonyme'} - ${d['Année de publication'] || 's.d.'}
                </span>`;
            div.onclick = () => {
                showBookDetail(d['Identifiant (id)'] || d['Titre']);
                searchResults.style.display = 'none';
                searchInput.value = '';
            };
            searchResults.appendChild(div);
        });

        periodMatches.forEach(p => {
            const div = document.createElement('div');
            div.className = 'search-result-item';
            const debut = (p['date de première parution'] || '?').match(/\d{4}/)?.[0] || '?';
            const fin   = (p['date de dernière parution']  || '?').match(/\d{4}/)?.[0] || p['date de dernière parution'] || '?';
            div.innerHTML = `
                <strong><i class="fa-solid fa-newspaper" style="color:#3498db; margin-right:5px; font-size:0.85em;"></i>${p['nom']}</strong>
                <span class="search-subtext">
                    ${debut} — ${fin}${p['fréquence'] ? ' · ' + p['fréquence'] : ''}
                </span>`;
            div.onclick = () => {
                showPeriodicalDetail(String(p['period-id']));
                searchResults.style.display = 'none';
                searchInput.value = '';
            };
            searchResults.appendChild(div);
        });
    }

    searchResults.style.display = matches.length > 0 ? 'block' : 'none';
}, 200));

/* Ferme les résultats si on clique ailleurs */
document.addEventListener('click', e => {
    if (e.target !== searchInput) searchResults.style.display = 'none';
});