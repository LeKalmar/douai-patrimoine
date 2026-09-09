/* Structure physique de la réserve et utilitaires de tri/classement des cotes,
   partagés entre reserve.html et recolement.html. */

/* Nombre d'étagères par défaut pour une travée classique (réserve
   patrimoniale ou Douaisienne), tant qu'aucune "dernière étagère" n'a été
   marquée pour la colonne concernée (bouton "Marquer comme dernière
   étagère de cette colonne" dans recolement.html, donnée `lastShelves`).
   Remplace un ancien maxEt codé en dur et différent par travée (6 à 9
   selon la travée) : ça empêchait de scanner/marquer au-delà de la valeur
   codée en dur dès qu'une colonne avait en réalité plus d'étagères que
   prévu. maxEtageOf()/miniMaxEtageOf() étendent ce défaut dès qu'une
   colonne a une dernière étagère marquée plus haute (ou des données réelles
   allant plus loin) — voir reserve.html et recolement.html. N'affecte que
   les travées ; les armoires et tiroirs (EMPLACEMENTS_ARMOIRE/TIROIR plus
   bas) gardent leur propre maxEt, ce sont des meubles à capacité fixe. */
const DEFAULT_MAX_ETAGE = 8;

const TRAVEES = [
  {id:'I',     nbCols:4},
  {id:'II',    nbCols:5},
  {id:'III',   nbCols:5},
  {id:'IV',    nbCols:5},
  {id:'V',     nbCols:5},
  {id:'VI',    nbCols:8},
  {id:'VII',   nbCols:8},
  {id:'VIII',  nbCols:8},
  {id:'IX',    nbCols:8},
  {id:'X',     nbCols:8},
  {id:'XI',    nbCols:8},
  {id:'XII',   nbCols:8},
  {id:'XIII',  nbCols:8},
  {id:'XIV',   nbCols:8},
  {id:'XV',    nbCols:8},
  {id:'XVI',   nbCols:8},
  {id:'XVII',  nbCols:8},
  {id:'XVIII', nbCols:8},
  {id:'XIX',   nbCols:8},
];
const GROUPES = [
  ['I','II','III','IV','V','VI','VII'],
  ['VIII','IX','X','XI','XII'],
  ['XIII','XIV','XV','XVI','XVII'],
  ['XVIII','XIX'],
];

/* Réserve Douaisienne — second local physique, distinct de la réserve
   patrimoniale ci-dessus. Identifiants de travée préfixés "RD-" pour ne pas
   entrer en collision avec les travées I à VII de la réserve patrimoniale
   (les deux locaux numérotent leurs travées en chiffres romains à partir de I). */
const TRAVEES_DOUAISIENNE = [
  {id:'RD-I',   nbCols:5},
  {id:'RD-II',  nbCols:4},
  {id:'RD-III', nbCols:4},
  {id:'RD-IV',  nbCols:4},
  {id:'RD-V',   nbCols:4},
  {id:'RD-VI',  nbCols:4},
  {id:'RD-VII', nbCols:4},
];
/* Magasin — 2e étage : local physique séparé de la réserve (autre étage du
   bâtiment), catalogué à part dans data/magasins.json (voir magasins.html
   et CLAUDE.md, section magasins) plutôt que dans data/inventaire.json.
   Identifiants de travée préfixés "M2-" pour ne jamais entrer en collision
   avec les travées I..XIX de la réserve patrimoniale ou RD-I..RD-VII de la
   Réserve Douaisienne (même principe que le préfixe RD- ci-dessus).
   Géométrie fournie par l'équipe (2026-08-18) : travées alpha/bêta/delta
   puis travées numérotées I à XX, capacités variables par travée — pas de
   règle générale, valeurs listées telles quelles. `maxEt:6` sur chaque
   travée (au lieu du DEFAULT_MAX_ETAGE=8 de la réserve) : la quasi-totalité
   des travées des magasins d'étage font 6 étagères — juste une référence
   par défaut, pas un plafond dur (voir DEFAULT_MAX_ETAGE plus haut :
   maxEtageOf() s'étend automatiquement au-delà dès que des données réelles
   ou une "dernière étagère" marquée dépassent cette valeur, pour les
   travées qui font exception). */
const TRAVEES_MAGASIN2 = [
  {id:'M2-ALPHA', nbCols:14, maxEt:6},
  {id:'M2-BETA',  nbCols:6, maxEt:6},
  {id:'M2-DELTA', nbCols:2, maxEt:6},
  {id:'M2-I',     nbCols:5, maxEt:6},
  {id:'M2-II',    nbCols:5, maxEt:6},
  {id:'M2-III',   nbCols:5, maxEt:6},
  {id:'M2-IV',    nbCols:12, maxEt:6},
  {id:'M2-V',     nbCols:14, maxEt:6},
  {id:'M2-VI',    nbCols:14, maxEt:6},
  {id:'M2-VII',   nbCols:14, maxEt:6},
  {id:'M2-VIII',  nbCols:14, maxEt:6},
  {id:'M2-IX',    nbCols:14, maxEt:6},
  {id:'M2-X',     nbCols:14, maxEt:6},
  {id:'M2-XI',    nbCols:14, maxEt:6},
  {id:'M2-XII',   nbCols:14, maxEt:6},
  {id:'M2-XIII',  nbCols:14, maxEt:6},
  {id:'M2-XIV',   nbCols:14, maxEt:6},
  {id:'M2-XV',    nbCols:14, maxEt:6},
  {id:'M2-XVI',   nbCols:14, maxEt:6},
  {id:'M2-XVII',  nbCols:14, maxEt:6},
  {id:'M2-XVIII', nbCols:14, maxEt:6},
  {id:'M2-XIX',   nbCols:8, maxEt:6},
  {id:'M2-XX',    nbCols:5, maxEt:6},
];

/* Magasin — 5e étage : même principe que le 2e étage ci-dessus (local
   physique séparé, catalogue data/magasins.json), identifiants préfixés
   "M5-". Géométrie fournie par l'équipe (2026-08-18) : travée I (6
   colonnes), travées II à V (5 colonnes chacune), travées VI à XIX (14
   colonnes chacune), et une travée alpha à 1 seule colonne — ordre et
   valeurs listés tels quels, aucune règle générale sous-jacente. Même
   `maxEt:6` par défaut que le 2e étage (voir commentaire ci-dessus). */
const TRAVEES_MAGASIN5 = [
  {id:'M5-I',     nbCols:6, maxEt:6},
  {id:'M5-II',    nbCols:5, maxEt:6},
  {id:'M5-III',   nbCols:5, maxEt:6},
  {id:'M5-IV',    nbCols:5, maxEt:6},
  {id:'M5-V',     nbCols:5, maxEt:6},
  {id:'M5-VI',    nbCols:14, maxEt:6},
  {id:'M5-VII',   nbCols:14, maxEt:6},
  {id:'M5-VIII',  nbCols:14, maxEt:6},
  {id:'M5-IX',    nbCols:14, maxEt:6},
  {id:'M5-X',     nbCols:14, maxEt:6},
  {id:'M5-XI',    nbCols:14, maxEt:6},
  {id:'M5-XII',   nbCols:14, maxEt:6},
  {id:'M5-XIII',  nbCols:14, maxEt:6},
  {id:'M5-XIV',   nbCols:14, maxEt:6},
  {id:'M5-XV',    nbCols:14, maxEt:6},
  {id:'M5-XVI',   nbCols:14, maxEt:6},
  {id:'M5-XVII',  nbCols:14, maxEt:6},
  {id:'M5-XVIII', nbCols:14, maxEt:6},
  {id:'M5-XIX',   nbCols:14, maxEt:6},
  {id:'M5-ALPHA', nbCols:1, maxEt:6},
];

/* Magasin — 6e étage : même principe que les 2e/5e étage ci-dessus,
   préfixe "M6-" pour ne pas entrer en collision avec M2-/M5-/RD-/la réserve
   patrimoniale. Géométrie propre fournie par l'équipe (2026-08-26,
   remplace l'hypothèse initiale de partage du plan du 5e étage) : travée I
   (5 colonnes), travées II à XV (11 colonnes chacune) — valeurs listées
   telles quelles, aucune règle générale sous-jacente. Même `maxEt:6` par
   défaut que les 2e/5e étage. Contrairement aux 2e/5e étage (uniquement
   cotes numériques), le 6e étage couvre aussi les cotes littérales/Dewey —
   voir CLAUDE.md, section magasins. */
const TRAVEES_MAGASIN6 = [
  {id:'M6-I',     nbCols:5, maxEt:6},
  {id:'M6-II',    nbCols:11, maxEt:6},
  {id:'M6-III',   nbCols:11, maxEt:6},
  {id:'M6-IV',    nbCols:11, maxEt:6},
  {id:'M6-V',     nbCols:11, maxEt:6},
  {id:'M6-VI',    nbCols:11, maxEt:6},
  {id:'M6-VII',   nbCols:11, maxEt:6},
  {id:'M6-VIII',  nbCols:11, maxEt:6},
  {id:'M6-IX',    nbCols:11, maxEt:6},
  {id:'M6-X',     nbCols:11, maxEt:6},
  {id:'M6-XI',    nbCols:11, maxEt:6},
  {id:'M6-XII',   nbCols:11, maxEt:6},
  {id:'M6-XIII',  nbCols:11, maxEt:6},
  {id:'M6-XIV',   nbCols:11, maxEt:6},
  {id:'M6-XV',    nbCols:11, maxEt:6},
];

const TRAVEES_ALL = [...TRAVEES, ...TRAVEES_DOUAISIENNE, ...TRAVEES_MAGASIN2, ...TRAVEES_MAGASIN5, ...TRAVEES_MAGASIN6];

/* "horsreserve" est une pseudo-réserve sans travées : sert uniquement à
   recolement.html pour scanner des exemplaires retrouvés hors de la
   réserve au moment du récolement (voir handleScanHorsReserve()). Aucun
   emplacement (travée/colonne/étage) n'a de sens ici — les scans de ce mode
   sont enregistrés avec la travée conventionnelle "HORS-RESERVE" (voir
   locFieldsOf()), qui n'apparaît dans aucune LOCATIONS_ALL et n'est donc
   jamais représentée dans le plan de reserve.html : c'est volontaire, ces
   exemplaires ne sont par définition sur aucune étagère. */
// catalogGroup distingue, pour recolement.html, quel catalogue de
// reconnaissance de code-barre utiliser (voir syncActiveCatalog()) :
// 'reserve' = data/inventaire.json (+ exemplaires manuels/reliures),
// 'magasin' = data/magasins.json. Partagé par anticipation entre le
// magasin 2e étage et un futur magasin 5e étage (même catalogue source,
// non scindé par étage) — ajouter le 5e étage plus tard ne demandera
// qu'une nouvelle entrée RESERVES avec ce même catalogGroup.
const RESERVES = [
  {id:'patrimoniale', label:'Réserve patrimoniale', travees:TRAVEES, catalogGroup:'reserve'},
  {id:'douaisienne',  label:'Réserve Douaisienne',  travees:TRAVEES_DOUAISIENNE, catalogGroup:'reserve'},
  {id:'magasin2',     label:'Magasin — 2e étage',   travees:TRAVEES_MAGASIN2, catalogGroup:'magasin'},
  {id:'magasin5',     label:'Magasin — 5e étage',   travees:TRAVEES_MAGASIN5, catalogGroup:'magasin'},
  {id:'magasin6',     label:'Magasin — 6e étage',   travees:TRAVEES_MAGASIN6, catalogGroup:'magasin'},
  {id:'horsreserve',  label:'Non rangé (hors réserve)', travees:[], catalogGroup:'reserve'},
];
function traveesOfReserve(reserveId){
  const r = RESERVES.find(r=>r.id===reserveId);
  return r ? r.travees : TRAVEES;
}
function catalogGroupOfReserve(reserveId){
  const r = RESERVES.find(r=>r.id===reserveId);
  return r ? r.catalogGroup : 'reserve';
}

/* Meubles hors travées (armoires en bois et armoires à tiroirs), physiquement
   dans la réserve patrimoniale uniquement. Modélisés comme des pseudo-travées
   à une seule entrée (colonne = quel meuble, étage = tiroir/niveau dans ce
   meuble) pour réutiliser telle quelle toute la mécanique des travées
   (UI de récolement, rendu du plan, calcul d'occupation) plutôt qu'un système
   séparé de meubles nommés individuellement.
   6 armoires en bois, jusqu'à 34 niveaux chacune ; 3 armoires à tiroirs,
   jusqu'à 10 tiroirs (Armoire tiroirs 1 et 2 en ont 10, Armoire 7 tiroirs en
   a 7 — 10 est retenu comme borne commune, même approximation que maxEt par
   travée pour des colonnes de capacités différentes). */
const EMPLACEMENTS_ARMOIRE = [{id:'ARMOIRE', label:'Armoires (bois)',     nbCols:6, maxEt:34}];
const EMPLACEMENTS_TIROIR  = [{id:'TIROIR',  label:'Armoires à tiroirs',  nbCols:3, maxEt:10}];
const LOCATIONS_ALL = [...TRAVEES_ALL, ...EMPLACEMENTS_ARMOIRE, ...EMPLACEMENTS_TIROIR];

/* maxEt par défaut d'un emplacement : la valeur propre au meuble si elle
   existe (armoires/tiroirs), sinon DEFAULT_MAX_ETAGE pour une travée. */
function defaultMaxEtageOf(def){ return (def && def.maxEt!=null) ? def.maxEt : DEFAULT_MAX_ETAGE; }

/* ════════════ TRI DES COTES (ex. "D104214" < "D104273") ════════════ */
function parseCote(cote){
  if(!cote) return [];
  const first=cote.split(',')[0].trim().toLowerCase();
  const segs=[]; const re=/(\d+)|([^\d\s\-.]+)/g; let m;
  while((m=re.exec(first))!==null){
    if(m[1]!==undefined) segs.push({isNum:true, num:parseInt(m[1],10), str:m[1]});
    else                 segs.push({isNum:false,num:null,               str:m[2]});
  }
  return segs;
}
function compareCotes(a,b){
  const sa=parseCote(a),sb=parseCote(b);
  const len=Math.max(sa.length,sb.length);
  for(let i=0;i<len;i++){
    if(i>=sa.length) return -1;
    if(i>=sb.length) return  1;
    const pa=sa[i],pb=sb[i];
    if(pa.isNum&&pb.isNum){if(pa.num!==pb.num) return pa.num-pb.num;}
    else if(!pa.isNum&&!pb.isNum){const c=pa.str.localeCompare(pb.str,'fr',{sensitivity:'base'});if(c!==0) return c;}
    else return pa.isNum?1:-1;
  }
  return 0;
}

/* ════════════ FONDS À PARTIR DU PRÉFIXE DE COTE (930$g) ════════════ */
const FONDS_PREFIXES = [
  { prefix: 'RD',   fonds: 'Réserve Douaisienne' },
  { prefix: 'LIVA', fonds: "Livres d'Artiste" },
  { prefix: 'MIN',  fonds: 'Mines' },
  { prefix: 'D',    fonds: 'Douaisien' },
  { prefix: 'I',    fonds: 'Imprimés' },
  { prefix: 'L',    fonds: 'Littérature' },
  { prefix: 'P',    fonds: 'Protestantisme' },
];
function getFondsFromCote(cote){
  const c=(cote||'').split(',')[0].trim().toUpperCase();
  if(!c) return '(Sans fonds)';
  const match=FONDS_PREFIXES.find(({prefix})=>c.startsWith(prefix));
  return match?match.fonds:'(Sans fonds)';
}
