/* Lecture minimale d'un classeur .xlsx, sans dépendance npm (comme le reste
   du projet) : un .xlsx est une archive zip de fichiers XML. On lit le
   répertoire central du zip, on décompresse (deflate brut, node:zlib) les
   deux seuls fichiers utiles — xl/sharedStrings.xml et la feuille demandée —
   et on renvoie ses lignes sous forme de tableaux de chaînes.

   Limites assumées : valeurs brutes uniquement (pas de formats de date ni
   de formules recalculées — la valeur en cache est lue telle quelle), pas de
   zip64 (classeurs < 4 Go, largement suffisant pour les registres). */
import { readFileSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';

function unzipEntries(buf){
  // Fin du répertoire central : signature 0x06054b50, dans les 64 derniers Ko.
  let eocd = -1;
  for(let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--){
    if(buf.readUInt32LE(i) === 0x06054b50){ eocd = i; break; }
  }
  if(eocd < 0) throw new Error('xlsx : archive zip illisible (pas de répertoire central)');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const entries = new Map();
  for(let n = 0; n < count; n++){
    if(buf.readUInt32LE(p) !== 0x02014b50) throw new Error('xlsx : entrée du répertoire central invalide');
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nlen = buf.readUInt16LE(p + 28), xlen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nlen);
    entries.set(name, { method, csize, local });
    p += 46 + nlen + xlen + clen;
  }
  return name => {
    const e = entries.get(name);
    if(!e) return null;
    const lnlen = buf.readUInt16LE(e.local + 26), lxlen = buf.readUInt16LE(e.local + 28);
    const data = buf.subarray(e.local + 30 + lnlen + lxlen, e.local + 30 + lnlen + lxlen + e.csize);
    if(e.method === 0) return data.toString('utf8');
    if(e.method === 8) return inflateRawSync(data).toString('utf8');
    throw new Error(`xlsx : méthode de compression ${e.method} non gérée (${name})`);
  };
}

const decode = s => s
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
  .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
  .replace(/&amp;/g, '&');

function colIndex(ref){
  let n = 0;
  for(const ch of ref.match(/^[A-Z]+/)[0]) n = n * 26 + ch.charCodeAt(0) - 64;
  return n - 1;
}

/** Lignes de la première feuille (ou de `sheet`, ex. "sheet2"), cellules en chaînes. */
export function readXlsxRows(path, sheet = 'sheet1'){
  const read = unzipEntries(readFileSync(path));
  const ssXml = read('xl/sharedStrings.xml');
  const shared = ssXml
    ? [...ssXml.matchAll(/<si>([\s\S]*?)<\/si>/g)].map(m => decode([...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map(t => t[1]).join('')))
    : [];
  const xml = read(`xl/worksheets/${sheet}.xml`);
  if(!xml) throw new Error(`xlsx : feuille ${sheet} absente de ${path}`);
  const rows = [];
  for(const m of xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)){
    const row = [];
    for(const c of m[1].matchAll(/<c r="([A-Z]+\d+)"([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)){
      const type = (c[2].match(/t="(\w+)"/) || [])[1];
      const body = c[3] || '';
      let v;
      if(type === 's') v = shared[+((body.match(/<v>([\s\S]*?)<\/v>/) || [])[1])] ?? '';
      else if(type === 'inlineStr') v = decode((body.match(/<t[^>]*>([\s\S]*?)<\/t>/) || [, ''])[1]);
      else v = decode((body.match(/<v>([\s\S]*?)<\/v>/) || [, ''])[1]);
      row[colIndex(c[1])] = v;
    }
    rows.push(Array.from(row, x => x == null ? '' : String(x)));
  }
  return rows;
}

/** Lignes en objets, d'après la ligne d'en-tête (noms de colonnes nettoyés). */
export function readXlsxObjects(path, sheet){
  const [head, ...rows] = readXlsxRows(path, sheet);
  const keys = head.map(h => h.trim());
  return rows
    .filter(r => r.some(v => v.trim()))
    .map(r => Object.fromEntries(keys.map((k, i) => [k, (r[i] || '').trim()])));
}
