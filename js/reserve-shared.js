/* Structure physique de la réserve et utilitaires de tri/classement des cotes,
   partagés entre reserve.html et recolement.html. */

const TRAVEES = [
  {id:'I',     nbCols:4, maxEt:6},
  {id:'II',    nbCols:5, maxEt:6},
  {id:'III',   nbCols:5, maxEt:6},
  {id:'IV',    nbCols:5, maxEt:7},
  {id:'V',     nbCols:5, maxEt:9},
  {id:'VI',    nbCols:8, maxEt:8},
  {id:'VII',   nbCols:8, maxEt:6},
  {id:'VIII',  nbCols:8, maxEt:6},
  {id:'IX',    nbCols:8, maxEt:6},
  {id:'X',     nbCols:8, maxEt:9},
  {id:'XI',    nbCols:8, maxEt:7},
  {id:'XII',   nbCols:8, maxEt:6},
  {id:'XIII',  nbCols:8, maxEt:6},
  {id:'XIV',   nbCols:8, maxEt:6},
  {id:'XV',    nbCols:8, maxEt:6},
  {id:'XVI',   nbCols:8, maxEt:6},
  {id:'XVII',  nbCols:8, maxEt:6},
  {id:'XVIII', nbCols:8, maxEt:6},
  {id:'XIX',   nbCols:8, maxEt:6},
];
const GROUPES = [
  ['I'],
  ['II','III'],
  ['IV','V','VI','VII','VIII'],
  ['IX','X','XI','XII','XIII','XIV','XV'],
  ['XVI','XVII','XVIII','XIX'],
];

/* Réserve Douaisienne — second local physique, distinct de la réserve
   principale ci-dessus. Identifiants de travée préfixés "RD-" pour ne pas
   entrer en collision avec les travées I à VII de la réserve principale
   (les deux locaux numérotent leurs travées en chiffres romains à partir de I). */
const TRAVEES_DOUAISIENNE = ['I','II','III','IV','V','VI','VII'].map(id => ({id:'RD-'+id, nbCols:5, maxEt:6}));
const TRAVEES_ALL = [...TRAVEES, ...TRAVEES_DOUAISIENNE];

const RESERVES = [
  {id:'patrimoniale', label:'Réserve patrimoniale', travees:TRAVEES},
  {id:'douaisienne',  label:'Réserve Douaisienne',  travees:TRAVEES_DOUAISIENNE},
];
function traveesOfReserve(reserveId){
  const r = RESERVES.find(r=>r.id===reserveId);
  return r ? r.travees : TRAVEES;
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
