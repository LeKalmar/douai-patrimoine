#!/usr/bin/env node
/**
 * npm run upload:registre -- <dossier de photos> <identifiant> [--dry-run]
 *   ex. npm run upload:registre -- excel/bib_registres registre-01
 *
 * Pousse les photos d'un registre d'inventaire papier vers R2, sous
 * `registres/<identifiant>/pages/<nom>.jpg`, plus un `registres/<identifiant>/manifest.json`
 * (ordre de prise de vue, empreinte, orientation d'origine). Le traitement
 * (OCR du manuscrit) se fait sur une autre machine, qui relit ce préfixe.
 *
 * Orientation : photographié à plat au-dessus d'un registre relié, le
 * téléphone se trompe sur son propre sens et note dans l'EXIF une orientation
 * fausse (3 = à l'envers, 8 = quart de tour à gauche) pour une bonne part des
 * photos, alors que les pixels, eux, sont toujours enregistrés de la même
 * façon (haut de page à gauche — vérifié le 2026-10-16 sur le premier
 * registre). On réécrit donc l'étiquette à 6 (quart de tour horaire) sur la
 * copie envoyée : aucun réencodage, aucune perte, fichiers locaux intacts.
 *
 * Reprise : une page déjà présente dans R2 avec la même taille est sautée.
 * Identifiants R2 lus dans le .env local (jamais commité, voir CLAUDE.md).
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { loadDotEnv } from './lib/dotenv.mjs';
import { r2Put, r2ListAll, r2Configured } from '../lib/r2.mjs';

const UPRIGHT = 6;      // pixels haut de page à gauche → quart de tour horaire
const CONCURRENCY = 4;

loadDotEnv();
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const [dir, id] = args.filter(a => !a.startsWith('--'));
if (!dir || !id || !/^[a-z0-9-]+$/.test(id)) {
  console.error('Usage : npm run upload:registre -- <dossier> <identifiant en minuscules, ex. registre-01> [--dry-run]');
  process.exit(1);
}
if (!dryRun && !r2Configured()) {
  console.error('R2 non configuré : renseignez les variables R2_* dans .env (voir CLAUDE.md).');
  process.exit(1);
}

/** Position de la valeur EXIF Orientation (IFD0, tag 0x0112), ou null. */
function findOrientation(buf) {
  let p = 2;
  while (p < buf.length - 4 && buf[p] === 0xFF) {
    const marker = buf[p + 1], len = buf.readUInt16BE(p + 2);
    if (marker === 0xE1 && buf.toString('latin1', p + 4, p + 10) === 'Exif\0\0') {
      const t = p + 10;
      const le = buf.toString('latin1', t, t + 2) === 'II';
      const r16 = o => le ? buf.readUInt16LE(o) : buf.readUInt16BE(o);
      const r32 = o => le ? buf.readUInt32LE(o) : buf.readUInt32BE(o);
      const ifd = t + r32(t + 4);
      for (let k = 0, n = r16(ifd); k < n; k++) {
        const e = ifd + 2 + k * 12;
        if (r16(e) === 0x0112) return { pos: e + 8, le, value: r16(e + 8) };
      }
      return null;
    }
    if (marker === 0xDA) break;
    p += 2 + len;
  }
  return null;
}

const files = readdirSync(dir).filter(f => /\.jpe?g$/i.test(f)).sort();
if (!files.length) { console.error(`Aucune photo .jpg dans ${dir}`); process.exit(1); }
const prefix = `registres/${id}/`;
const existing = dryRun ? new Map() : new Map((await r2ListAll(prefix + 'pages/')).map(o => [o.key, o.size]));

const pages = [];
const origCounts = {};
let sent = 0, skipped = 0, next = 0;

async function worker() {
  while (next < files.length) {
    const i = next++;
    const name = files[i];
    const buf = readFileSync(join(dir, name));
    const o = findOrientation(buf);
    if (!o) throw new Error(`${name} : pas d'orientation EXIF, impossible de corriger sans réencoder`);
    origCounts[o.value] = (origCounts[o.value] || 0) + 1;
    if (o.le) buf.writeUInt16LE(UPRIGHT, o.pos); else buf.writeUInt16BE(UPRIGHT, o.pos);
    const key = `${prefix}pages/${name}`;
    const m = name.match(/(\d{4})(\d\d)(\d\d)_(\d\d)(\d\d)(\d\d)/);
    pages[i] = {
      index: i + 1, file: name, key, bytes: buf.length,
      sha256: createHash('sha256').update(buf).digest('hex'),
      takenAt: m ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}` : null,
      exifOrientationOriginal: o.value,
    };
    if (existing.get(key) === buf.length) { skipped++; continue; }
    if (!dryRun) await r2Put(key, buf, { contentType: 'image/jpeg' });
    sent++;
    if (sent % 25 === 0) console.log(`  ${sent + skipped}/${files.length}…`);
  }
}

console.log(`${files.length} photo(s) de ${dir} → R2 ${prefix}${dryRun ? ' (simulation)' : ''}`);
await Promise.all(Array.from({ length: CONCURRENCY }, worker));

const manifest = {
  id, generatedAt: new Date().toISOString(), sourceDir: dir, pageCount: pages.length,
  exifOrientation: `réécrite à ${UPRIGHT} sur toutes les pages (pixels non modifiés)`,
  exifOrientationOriginalCounts: origCounts,
  pages,
};
if (!dryRun) await r2Put(`${prefix}manifest.json`, JSON.stringify(manifest, null, 2));
console.log(`Terminé : ${sent} envoyée(s), ${skipped} déjà présente(s). Orientations d'origine :`, origCounts);
