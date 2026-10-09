/* Libellés de la classification décimale de Dewey (français), pour la
   répartition par thème des rayons importés dans rotobib.html.
   Trois niveaux : les 100 divisions (« 940 » = Histoire de l'Europe, clé sur
   2 chiffres + 0), les 100 indices à 3 chiffres de la classe 900 (Histoire,
   géographie — premiers rayons désherbés), et quelques subdivisions
   décimales d'usage courant en histoire. Hors de ces tables,
   deweyLabel() remonte au niveau connu le plus proche (944.123 → 944.1 →
   944 → 940). Libellés courts, adaptés à un affichage en liste. */
(function (global) {
  const DIVISIONS = {
    '000': 'Généralités', '010': 'Bibliographies', '020': 'Bibliothéconomie', '030': 'Encyclopédies',
    '040': 'Généralités (non attribué)', '050': 'Périodiques', '060': 'Associations, musées',
    '070': 'Journalisme, édition', '080': 'Recueils', '090': 'Manuscrits, livres rares',
    '100': 'Philosophie', '110': 'Métaphysique', '120': 'Épistémologie', '130': 'Parapsychologie, ésotérisme',
    '140': 'Écoles philosophiques', '150': 'Psychologie', '160': 'Logique', '170': 'Morale',
    '180': 'Philosophie antique, médiévale, orientale', '190': 'Philosophie occidentale moderne',
    '200': 'Religion', '210': 'Philosophie de la religion', '220': 'Bible', '230': 'Christianisme',
    '240': 'Pratique chrétienne', '250': 'Églises locales, ordres religieux', '260': 'Théologie sociale chrétienne',
    '270': 'Histoire de l\'Église', '280': 'Confessions chrétiennes', '290': 'Autres religions',
    '300': 'Sciences sociales', '310': 'Statistiques', '320': 'Science politique', '330': 'Économie',
    '340': 'Droit', '350': 'Administration publique, art militaire', '360': 'Problèmes et services sociaux',
    '370': 'Éducation', '380': 'Commerce, communications, transports', '390': 'Coutumes, folklore',
    '400': 'Langues', '410': 'Linguistique', '420': 'Langue anglaise', '430': 'Langue allemande',
    '440': 'Langue française', '450': 'Langue italienne', '460': 'Langues espagnole, portugaise',
    '470': 'Latin', '480': 'Grec', '490': 'Autres langues',
    '500': 'Sciences', '510': 'Mathématiques', '520': 'Astronomie', '530': 'Physique', '540': 'Chimie',
    '550': 'Sciences de la Terre', '560': 'Paléontologie', '570': 'Sciences de la vie', '580': 'Botanique',
    '590': 'Zoologie',
    '600': 'Techniques', '610': 'Médecine, santé', '620': 'Ingénierie', '630': 'Agriculture',
    '640': 'Vie domestique, cuisine', '650': 'Gestion', '660': 'Génie chimique', '670': 'Fabrication industrielle',
    '680': 'Fabrications diverses', '690': 'Bâtiment',
    '700': 'Arts', '710': 'Urbanisme, paysage', '720': 'Architecture', '730': 'Sculpture',
    '740': 'Dessin, arts décoratifs', '750': 'Peinture', '760': 'Gravure, arts graphiques', '770': 'Photographie',
    '780': 'Musique', '790': 'Loisirs, spectacles, sports',
    '800': 'Littérature', '810': 'Littérature américaine', '820': 'Littérature anglaise',
    '830': 'Littérature allemande', '840': 'Littérature française', '850': 'Littérature italienne',
    '860': 'Littératures espagnole, portugaise', '870': 'Littérature latine', '880': 'Littérature grecque',
    '890': 'Autres littératures',
    '900': 'Histoire, géographie', '910': 'Géographie, voyages', '920': 'Biographies, généalogie',
    '930': 'Histoire ancienne', '940': 'Histoire de l\'Europe', '950': 'Histoire de l\'Asie',
    '960': 'Histoire de l\'Afrique', '970': 'Histoire de l\'Amérique du Nord',
    '980': 'Histoire de l\'Amérique du Sud', '990': 'Histoire de l\'Océanie, régions polaires',
  };

  const INDICES = {
    '900': 'Histoire et géographie (généralités)', '901': 'Philosophie de l\'histoire',
    '902': 'Histoire : chronologies, ouvrages divers', '903': 'Dictionnaires d\'histoire',
    '904': 'Récits d\'événements', '905': 'Périodiques d\'histoire', '906': 'Sociétés historiques',
    '907': 'Historiographie, enseignement de l\'histoire', '908': 'Histoire de groupes de personnes',
    '909': 'Histoire universelle, civilisations',
    '910': 'Géographie, voyages', '911': 'Géographie historique', '912': 'Atlas, cartes',
    '913': 'Géographie du monde ancien', '914': 'Géographie de l\'Europe', '915': 'Géographie de l\'Asie',
    '916': 'Géographie de l\'Afrique', '917': 'Géographie de l\'Amérique du Nord',
    '918': 'Géographie de l\'Amérique du Sud', '919': 'Géographie de l\'Océanie, régions polaires',
    '920': 'Biographies collectives', '921': 'Biographies : philosophie', '922': 'Biographies : religion',
    '923': 'Biographies : sciences sociales, politique', '924': 'Biographies : langues',
    '925': 'Biographies : sciences', '926': 'Biographies : techniques', '927': 'Biographies : arts, sports',
    '928': 'Biographies : littérature', '929': 'Généalogie, noms, emblèmes',
    '930': 'Monde antique, archéologie', '931': 'Chine ancienne', '932': 'Égypte ancienne',
    '933': 'Palestine ancienne', '934': 'Inde ancienne', '935': 'Mésopotamie, Perse ancienne',
    '936': 'Europe ancienne (Celtes, Gaule…)', '937': 'Rome antique', '938': 'Grèce antique',
    '939': 'Autres régions du monde antique',
    '940': 'Europe (histoire générale, guerres mondiales)', '941': 'Îles Britanniques', '942': 'Angleterre', '943': 'Allemagne, Europe centrale',
    '944': 'France', '945': 'Italie', '946': 'Espagne, Portugal', '947': 'Russie, Europe de l\'Est',
    '948': 'Scandinavie', '949': 'Autres pays d\'Europe',
    '950': 'Asie', '951': 'Chine', '952': 'Japon', '953': 'Péninsule arabique', '954': 'Inde, Asie du Sud',
    '955': 'Iran', '956': 'Moyen-Orient', '957': 'Sibérie', '958': 'Asie centrale', '959': 'Asie du Sud-Est',
    '960': 'Afrique', '961': 'Tunisie, Libye', '962': 'Égypte, Soudan', '963': 'Éthiopie, Érythrée',
    '964': 'Maroc, Afrique du Nord-Ouest', '965': 'Algérie', '966': 'Afrique de l\'Ouest',
    '967': 'Afrique centrale et de l\'Est', '968': 'Afrique australe', '969': 'Îles de l\'océan Indien',
    '970': 'Amérique du Nord', '971': 'Canada', '972': 'Mexique, Amérique centrale, Antilles',
    '973': 'États-Unis', '974': 'États-Unis (Nord-Est)', '975': 'États-Unis (Sud-Est)',
    '976': 'États-Unis (Centre-Sud)', '977': 'États-Unis (Centre-Nord)', '978': 'États-Unis (Ouest)',
    '979': 'États-Unis (côte Pacifique)',
    '980': 'Amérique du Sud', '981': 'Brésil', '982': 'Argentine', '983': 'Chili', '984': 'Bolivie',
    '985': 'Pérou', '986': 'Colombie, Équateur', '987': 'Venezuela', '988': 'Guyanes',
    '989': 'Paraguay, Uruguay',
    '990': 'Océanie, régions polaires', '993': 'Nouvelle-Zélande', '994': 'Australie',
    '995': 'Mélanésie, Nouvelle-Guinée', '996': 'Polynésie, îles du Pacifique',
    '997': 'Îles de l\'Atlantique', '998': 'Arctique', '999': 'Antarctique',
  };

  const DECIMALES = {
    '909.07': 'Monde : Moyen Âge', '909.08': 'Monde : époque moderne et contemporaine',
    '909.8': 'Monde : depuis 1800', '909.82': 'Monde : XXe siècle', '909.83': 'Monde : XXIe siècle',
    '930.1': 'Archéologie, préhistoire',
    '940.1': 'Europe médiévale', '940.2': 'Europe moderne (1453-1914)',
    '940.3': 'Première Guerre mondiale', '940.4': 'Première Guerre mondiale : opérations militaires',
    '940.5': 'Europe au XXe siècle', '940.53': 'Seconde Guerre mondiale',
    '940.54': 'Seconde Guerre mondiale : opérations militaires', '940.55': 'Europe depuis 1945',
    '943.08': 'Allemagne depuis 1866 (Empire, nazisme…)',
    '944.0': 'France : périodes historiques',
    '944.01': 'France : Gaule, Mérovingiens, Carolingiens', '944.02': 'France : Capétiens, Valois (987-1589)',
    '944.03': 'France : Bourbons (1589-1789)', '944.04': 'Révolution française (1789-1804)',
    '944.05': 'Premier Empire (1804-1815)', '944.06': 'Restauration, monarchie de Juillet (1815-1848)',
    '944.07': 'IIe République, Second Empire (1848-1870)', '944.08': 'France depuis 1870',
    '947.08': 'Russie : XXe siècle (URSS…)',
  };

  /* Indice Dewey d'une cote : premier groupe « 3 chiffres [.décimales] »
     isolé (entouré d'espaces ou en bord de chaîne) — couvre « 944 DUP »,
     « 940.53 KER », mais aussi « A10025 930.1 CLI ». Les numéros
     d'enregistrement à 5/6 chiffres des magasins ne matchent pas.
     → { d3:'944', dec:'04' } ou null. */
  function deweyOf(cote) {
    const m = String(cote || '').match(/(?:^|\s)(\d{3})(?:\.(\d+))?(?=\s|$)/);
    return m ? { d3: m[1], dec: m[2] || '' } : null;
  }

  // Clé de regroupement selon le niveau : 'division' (940), 'indice' (944),
  // 'precis' (944.04 — 2 décimales au plus).
  function deweyKey(dw, level) {
    if (!dw) return null;
    if (level === 'division') return dw.d3.slice(0, 2) + '0';
    if (level === 'precis' && dw.dec) return dw.d3 + '.' + dw.dec.slice(0, 2);
    return dw.d3;
  }

  // `level` = 'division' : « 940 » désigne toute la division (941…949
  // compris), pas l'indice 940 seul — libellé de DIVISIONS en priorité.
  function deweyLabel(key, level) {
    if (!key) return 'Sans indice Dewey';
    if (level === 'division' && DIVISIONS[key]) return DIVISIONS[key];
    let k = key;
    while (k.includes('.')) {
      if (DECIMALES[k]) return DECIMALES[k];
      k = k.slice(0, -1);
      if (k.endsWith('.')) k = k.slice(0, -1);
    }
    if (INDICES[k]) return INDICES[k];
    return DIVISIONS[k.slice(0, 2) + '0'] || 'Indice ' + key;
  }

  global.dewey = { deweyOf, deweyKey, deweyLabel };
})(typeof window !== 'undefined' ? window : globalThis);
