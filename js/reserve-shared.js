/* Structure physique de la réserve et utilitaires de tri/classement des cotes,
   partagés entre reserve.html et recolement.html. */

const TRAVEES = [
  {id:'I',     nbCols:4, maxEt:5},
  {id:'II',    nbCols:5, maxEt:5},
  {id:'III',   nbCols:5, maxEt:5},
  {id:'IV',    nbCols:5, maxEt:7},
  {id:'V',     nbCols:5, maxEt:9},
  {id:'VI',    nbCols:8, maxEt:8},
  {id:'VII',   nbCols:8, maxEt:5},
  {id:'VIII',  nbCols:8, maxEt:5},
  {id:'IX',    nbCols:8, maxEt:5},
  {id:'X',     nbCols:8, maxEt:9},
  {id:'XI',    nbCols:8, maxEt:7},
  {id:'XII',   nbCols:8, maxEt:5},
  {id:'XIII',  nbCols:8, maxEt:5},
  {id:'XIV',   nbCols:8, maxEt:5},
  {id:'XV',    nbCols:8, maxEt:5},
  {id:'XVI',   nbCols:8, maxEt:5},
  {id:'XVII',  nbCols:8, maxEt:5},
  {id:'XVIII', nbCols:8, maxEt:5},
  {id:'XIX',   nbCols:8, maxEt:5},
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
const TRAVEES_DOUAISIENNE = ['I','II','III','IV','V','VI','VII'].map(id => ({id:'RD-'+id, nbCols:5, maxEt:5}));
const TRAVEES_ALL = [...TRAVEES, ...TRAVEES_DOUAISIENNE];

const RESERVES = [
  {id:'patrimoniale', label:'Réserve patrimoniale', travees:TRAVEES},
  {id:'douaisienne',  label:'Réserve Douaisienne',  travees:TRAVEES_DOUAISIENNE},
];
function traveesOfReserve(reserveId){
  const r = RESERVES.find(r=>r.id===reserveId);
  return r ? r.travees : TRAVEES;
}

/* Armoires à tiroirs côté droit (csvId = identifiant utilisé dans le champ "travee" du récolement) */
const ARMOIRES_TIROIRS = [
  {id:'TIRB1', label:'Armoire tiroirs 1', type:'tiroir', nb:10, csvId:'T1'},
  {id:'TIRB2', label:'Armoire tiroirs 2', type:'tiroir', nb:10, csvId:'T2'},
];
/* Bas de salle */
const ARMOIRES_BAS = [
  {id:'TIRJ1', label:'Armoire 7 tiroirs', type:'tiroir', nb:7,  csvId:'T3'},
  {id:'BOIS1', label:'Armoire bois 1',    type:'bois',   nb:34, csvId:'AB-1'},
  {id:'BOIS2', label:'Armoire bois 2',    type:'bois',   nb:34, csvId:'AB-4'},
  {id:'BOIS3', label:'Armoire bois 3',    type:'bois',   nb:34, csvId:'AB-5'},
  {id:'BOIS4', label:'Armoire bois 4',    type:'bois',   nb:34, csvId:'AB-6'},
  {id:'BOIS5', label:'Armoire bois 5',    type:'bois',   nb:34, csvId:null},
  {id:'BOIS6', label:'Armoire bois 6',    type:'bois',   nb:34, csvId:null},
];

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
