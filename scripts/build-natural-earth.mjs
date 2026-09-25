#!/usr/bin/env node
/**
 * build-natural-earth.mjs
 * ────────────────────────────────────────────────────────────────────────────
 * Fond de carte vectoriel de l'exposition voyageurs.html : télécharge les
 * couches Natural Earth (domaine public, https://www.naturalearthdata.com)
 * depuis le dépôt officiel nvkelso/natural-earth-vector et les écrit,
 * allégées, dans data/natural-earth/ :
 *   - land.json        ← ne_50m_land                     (terres émergées)
 *   - lakes.json       ← ne_50m_lakes                    (lacs)
 *   - rivers.json      ← ne_50m_rivers_lake_centerlines  (fleuves)
 *   - bathymetry.json  ← ne_10m_bathymetry_K_200 … A_10000 (paliers de profondeur)
 *
 * Allègement : propriétés retirées (sauf `scalerank`, qui sert à n'afficher
 * les petits lacs/fleuves qu'en zoomant), coordonnées arrondies à 3
 * décimales (~100 m). Extension .json plutôt que .geojson pour que
 * scripts/dev-server.mjs les serve compressées (TEXT_EXT).
 *
 * Bathymétrie : Natural Earth ne la publie qu'au 1:10m, soit ~43 Mo pour
 * les 11 paliers retenus — intransportable dans une page. Chaque palier est
 * donc simplifié (Douglas-Peucker, tolérance BATHY_TOLERANCE en degrés) et
 * les anneaux devenus minuscules sont retirés. Chaque polygone d'un palier
 * couvre toutes les zones PLUS profondes que sa profondeur ; les paliers
 * sont emboîtés et écrits du moins profond au plus profond, dans un seul
 * fichier, avec une propriété `depth` (m) : dessinés dans cet ordre, chacun
 * recouvre le précédent là où la mer est plus profonde. Le palier L_0
 * (« toute la mer ») est omis : c'est la couleur de fond de la carte.
 *
 * Usage : node scripts/build-natural-earth.mjs      (npm run build:natural-earth)
 * ────────────────────────────────────────────────────────────────────────────
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const BASE = 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/';
const OUT_DIR = resolve('data/natural-earth');
const LAYERS = [
  { src: 'ne_50m_land', out: 'land.json', keep: [] },
  { src: 'ne_50m_lakes', out: 'lakes.json', keep: ['scalerank'] },
  { src: 'ne_50m_rivers_lake_centerlines', out: 'rivers.json', keep: ['scalerank'] },
];
const BATHY = [
  ['K', 200], ['J', 1000], ['I', 2000], ['H', 3000], ['G', 4000], ['F', 5000],
  ['E', 6000], ['D', 7000], ['C', 8000], ['B', 9000], ['A', 10000],
];
// Tolérance de simplification de la bathymétrie, en degrés (0,1° ≈ 11 km).
// Mesuré le 2026-09-25 : 0,04° → 7,0 Mo (2,3 Mo compressés), 0,08° → 3,5 Mo,
// 0,12° → 2,0 Mo (0,7 Mo). Sur un globe vu entre les zooms 1 et 5, un pixel
// couvre déjà 40 à 150 km ; les paliers ne sont qu'un fond, pas un contour
// qu'on lit. NE_BATHY_TOL permet d'essayer une autre valeur sans éditer ici.
const BATHY_TOLERANCE = Number(process.env.NE_BATHY_TOL || 0.1);
const PRECISION = 1e3;

function round(p) {
  return [Math.round(p[0] * PRECISION) / PRECISION, Math.round(p[1] * PRECISION) / PRECISION];
}
function roundCoords(c) {
  return typeof c[0] === 'number' ? round(c) : c.map(roundCoords);
}

/** Douglas-Peucker itératif (pas de récursion : certains anneaux ont des
    dizaines de milliers de points). Garde le premier et le dernier point. */
function simplifyLine(pts, tol) {
  if (pts.length <= 4) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  const tol2 = tol * tol;
  while (stack.length) {
    const [a, b] = stack.pop();
    const [ax, ay] = pts[a], [bx, by] = pts[b];
    const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
    let maxD = -1, idx = -1;
    for (let i = a + 1; i < b; i++) {
      const [px, py] = pts[i];
      let t = len2 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
      t = Math.max(0, Math.min(1, t));
      const ex = ax + t * dx - px, ey = ay + t * dy - py;
      const d = ex * ex + ey * ey;
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (maxD > tol2) {
      keep[idx] = 1;
      stack.push([a, idx], [idx, b]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}
function ringArea(r) {
  let s = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) s += (r[j][0] + r[i][0]) * (r[j][1] - r[i][1]);
  return Math.abs(s / 2);
}
/** Anneau simplifié, ou null s'il est devenu trop petit pour être vu. */
function simplifyRing(ring, tol) {
  const s = simplifyLine(ring, tol).map(round);
  if (s.length < 4 || ringArea(s) < tol * tol * 4) return null;
  return s;
}
function simplifyPolygon(rings, tol) {
  const outer = simplifyRing(rings[0], tol);
  if (!outer) return null;
  return [outer, ...rings.slice(1).map(r => simplifyRing(r, tol)).filter(Boolean)];
}

async function fetchLayer(name) {
  const res = await fetch(BASE + name + '.geojson');
  if (!res.ok) throw new Error(`${name} : HTTP ${res.status}`);
  return res.json();
}
function write(file, features) {
  const body = JSON.stringify({ type: 'FeatureCollection', features });
  writeFileSync(resolve(OUT_DIR, file), body);
  console.log(`  · ${file} : ${features.length} objets, ${(body.length / 1024).toFixed(0)} Ko`);
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });

  for (const layer of LAYERS) {
    const fc = await fetchLayer(layer.src);
    write(layer.out, fc.features.filter(f => f.geometry).map(f => ({
      type: 'Feature',
      properties: Object.fromEntries(layer.keep.map(k => [k, f.properties[k]])),
      geometry: { type: f.geometry.type, coordinates: roundCoords(f.geometry.coordinates) },
    })));
  }

  const bathy = [];
  for (const [letter, depth] of BATHY) {
    const fc = await fetchLayer(`ne_10m_bathymetry_${letter}_${depth}`);
    const polys = [];
    for (const f of fc.features) {
      const g = f.geometry;
      if (!g) continue;
      const list = g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];
      for (const p of list) {
        const s = simplifyPolygon(p, BATHY_TOLERANCE);
        if (s) polys.push(s);
      }
    }
    if (polys.length) {
      bathy.push({ type: 'Feature', properties: { depth },
                   geometry: { type: 'MultiPolygon', coordinates: polys } });
    }
    console.log(`    palier ${depth} m : ${polys.length} polygone(s)`);
  }
  write('bathymetry.json', bathy);
}

console.log('▶ build-natural-earth');
main()
  .then(() => console.log('✓ build-natural-earth : terminé'))
  .catch(err => { console.error('✖ build-natural-earth :', err.message); process.exit(1); });
