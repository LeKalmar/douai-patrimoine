#!/usr/bin/env node
/**
 * build-natural-earth.mjs
 * ────────────────────────────────────────────────────────────────────────────
 * Fond de carte vectoriel de l'exposition voyageurs.html : télécharge les
 * couches Natural Earth au 1:10m (la plus fine résolution publiée, domaine
 * public — https://www.naturalearthdata.com) depuis le dépôt officiel
 * nvkelso/natural-earth-vector, les découpe en tuiles vectorielles (format
 * Mapbox Vector Tile) du zoom 0 au zoom MAX_ZOOM, et les range dans UNE seule
 * archive PMTiles : data/natural-earth/fond.pmtiles.
 *
 * Pourquoi des tuiles plutôt que des fichiers GeoJSON (2026-09-26) : un
 * GeoJSON doit être téléchargé en entier puis redécoupé par le navigateur à
 * chaque zoom — la bathymétrie pesait à elle seule plusieurs Mo de polygones
 * à retravailler côté client. Une archive PMTiles se lit par morceaux (en-tête
 * HTTP Range) : le navigateur ne demande que les tuiles de la vue courante,
 * déjà découpées et simplifiées pour leur zoom. C'est aussi ce qui permet de
 * passer au 1:10m sans simplification préalable : au zoom 7, une tuile ne
 * porte que le détail de ses 3 degrés de côté.
 *
 * Couches (source-layer de l'archive) :
 *   - terres       ← ne_10m_land + ne_10m_minor_islands
 *   - lacs         ← ne_10m_lakes + compléments régionaux (Europe, Amérique du
 *                    Nord, Australie)
 *   - fleuves      ← ne_10m_rivers_lake_centerlines + compléments régionaux
 *   - bathymetrie  ← ne_10m_bathymetry_K_200 … A_10000, propriété `depth` (m).
 *                    Chaque palier couvre toutes les zones PLUS profondes que
 *                    lui ; ils sont écrits du moins au plus profond pour se
 *                    recouvrir dans cet ordre. L_0 (« toute la mer ») est omis :
 *                    c'est la couleur de fond de la carte.
 * Lacs et fleuves n'entrent dans une tuile qu'à partir de leur `min_zoom`
 * Natural Earth (moins un, pour les voir un cran plus tôt) : les petits cours
 * d'eau n'alourdissent pas les tuiles des vues d'ensemble.
 *
 * Aucune dépendance npm ajoutée au projet :
 *   - le découpage est fait par geojson-vt (bibliothèque de référence de
 *     MapLibre/Mapbox), téléchargée à la volée depuis jsDelivr en version
 *     épinglée et refusée si l'empreinte SHA-256 d'un fichier diffère ;
 *   - l'encodage des tuiles (protobuf MVT) et l'écriture de l'archive
 *     PMTiles v3 sont écrits ici à la main, comme la signature R2 de
 *     lib/r2.mjs — deux formats publics, courts et stables.
 *
 * Publication : l'archive est servie telle quelle, en local par
 * scripts/dev-server.mjs (qui gère les en-têtes Range), ou depuis le bucket
 * R2 public — voir FOND_CARTE_URL dans js/voyageurs.js.
 *
 * Usage : node scripts/build-natural-earth.mjs      (npm run build:natural-earth)
 *         MAX_ZOOM=8 node scripts/build-natural-earth.mjs   (plus de détail, plus lourd)
 * ────────────────────────────────────────────────────────────────────────────
 */
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const NE_BASE = 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/';
const OUT_DIR = resolve('data/natural-earth');
const OUT_FILE = resolve(OUT_DIR, 'fond.pmtiles');
const MAX_ZOOM = Number(process.env.MAX_ZOOM || 7);
const EXTENT = 4096;

const LAYERS = [
  { name: 'terres', sources: ['ne_10m_land', 'ne_10m_minor_islands'] },
  { name: 'lacs', minZoomFilter: true,
    sources: ['ne_10m_lakes', 'ne_10m_lakes_europe', 'ne_10m_lakes_north_america', 'ne_10m_lakes_australia'] },
  { name: 'fleuves', minZoomFilter: true,
    sources: ['ne_10m_rivers_lake_centerlines', 'ne_10m_rivers_europe',
              'ne_10m_rivers_north_america', 'ne_10m_rivers_australia'] },
  { name: 'bathymetrie', keep: ['depth'],
    sources: [['K', 200], ['J', 1000], ['I', 2000], ['H', 3000], ['G', 4000], ['F', 5000],
              ['E', 6000], ['D', 7000], ['C', 8000], ['B', 9000], ['A', 10000]]
      .map(([l, d]) => ({ name: `ne_10m_bathymetry_${l}_${d}`, props: { depth: d } })) },
];

/* ── geojson-vt, version épinglée et vérifiée ─────────────────────────────── */
const GVT_VERSION = '5.0.2';
const GVT_FILES = {
  'index.js': '08f3831953baf2e6990761c468a83f925b14ad17c2c57ee697bae02a0178f907',
  'convert.js': '02c7d5411c1095ba7b5e51d615874737d540bd4d8e35924214bf1e14683c6c94',
  'clip.js': 'a650cc07f4f387b7ba791972d5be25e52926ebf2a63ce3d59dfaa2df969e2718',
  'wrap.js': '0093757087f1ba3eec1425741bf5ccdccd9550d7d5e93ba27b8070c4cc871903',
  'tile.js': 'b9c8986cabbf5850b348a3299fefaf62bc84df415aaf6e15881b87b7218c5149',
  'feature.js': '8563099e39ae66925d27d5f1011eba844d0bbf71ad808a6cd3545931e3c65720',
  'simplify.js': '0dcaa18590aaecd174b9cde85118c1785553d48da4746b2b54aadd25e0b89f40',
};
const sha256 = buf => createHash('sha256').update(buf).digest('hex');

async function loadGeojsonVt() {
  const dir = join(tmpdir(), `rp-geojson-vt-${GVT_VERSION}`);
  mkdirSync(dir, { recursive: true });
  for (const [file, hash] of Object.entries(GVT_FILES)) {
    const path = join(dir, file);
    if (existsSync(path) && sha256(readFileSync(path)) === hash) continue;
    const res = await fetch(`https://cdn.jsdelivr.net/npm/geojson-vt@${GVT_VERSION}/src/${file}`);
    if (!res.ok) throw new Error(`geojson-vt ${file} : HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (sha256(buf) !== hash) {
      rmSync(path, { force: true });
      throw new Error(`geojson-vt ${file} : empreinte SHA-256 inattendue, fichier refusé`);
    }
    writeFileSync(path, buf);
  }
  return (await import(pathToFileURL(join(dir, 'index.js')).href)).default;
}

/* ── Natural Earth ─────────────────────────────────────────────────────────── */
async function fetchNE(name) {
  const res = await fetch(NE_BASE + name + '.geojson');
  if (!res.ok) throw new Error(`${name} : HTTP ${res.status}`);
  return res.json();
}

/** Aire signée d'un anneau en lng/lat (positive = sens trigonométrique). */
function ringArea(r) {
  let s = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) s += (r[j][0] - r[i][0]) * (r[j][1] + r[i][1]);
  return -s / 2;
}
/** Oriente un polygone pour qu'il sorte au bon sens dans les tuiles : la
    spécification MVT veut l'anneau extérieur dans le sens horaire en
    coordonnées écran (y vers le bas), donc — l'axe y étant inversé par la
    projection — dans le sens HORAIRE en lng/lat, et les trous dans le sens
    inverse. geojson-vt 5 ne réoriente plus rien lui-même, et Natural Earth
    ne garantit pas le sens de ses anneaux. */
function rewindPolygon(rings) {
  return rings.map((ring, i) => {
    const clockwise = ringArea(ring) < 0;
    const wantClockwise = i === 0;
    return clockwise === wantClockwise ? ring : ring.slice().reverse();
  });
}
function normalizeFeature(f, props) {
  const g = f.geometry;
  if (!g) return null;
  let geometry = g;
  if (g.type === 'Polygon') geometry = { type: 'Polygon', coordinates: rewindPolygon(g.coordinates) };
  else if (g.type === 'MultiPolygon') geometry = { type: 'MultiPolygon', coordinates: g.coordinates.map(rewindPolygon) };
  return { type: 'Feature', properties: props, geometry };
}

/* ── Encodage Mapbox Vector Tile (protobuf) ───────────────────────────────── */
class Pbf {
  constructor() { this.bytes = []; }
  varint(v) {
    v = Math.floor(v);
    while (v > 0x7f) { this.bytes.push((v & 0x7f) | 0x80); v = Math.floor(v / 128); }
    this.bytes.push(v);
    return this;
  }
  tag(field, wire) { return this.varint(field * 8 + wire); }
  message(field, pbf) {
    this.tag(field, 2).varint(pbf.bytes.length);
    // Boucle plutôt que push(...bytes) : une couche de bathymétrie dépasse la
    // taille d'arguments qu'accepte un appel de fonction.
    for (const b of pbf.bytes) this.bytes.push(b);
    return this;
  }
  string(field, s) {
    const b = Buffer.from(s, 'utf8');
    this.tag(field, 2).varint(b.length);
    for (const x of b) this.bytes.push(x);
    return this;
  }
  packed(field, values) {
    const p = new Pbf();
    for (const v of values) p.varint(v);
    return this.message(field, p);
  }
}
const zigzag = n => (n << 1) ^ (n >> 31);
const command = (id, count) => (id & 7) | (count << 3);

/** Géométrie MVT (commandes MoveTo/LineTo/ClosePath, deltas en zigzag) à partir
    des anneaux « plats » de geojson-vt ([x0, y0, x1, y1, …]). */
function encodeGeometry(type, rings) {
  const out = [];
  let cx = 0, cy = 0;
  for (const flat of rings) {
    const pts = [];
    for (let i = 0; i < flat.length; i += 2) {
      const x = flat[i], y = flat[i + 1];
      const last = pts[pts.length - 1];
      if (!last || last[0] !== x || last[1] !== y) pts.push([x, y]);
    }
    if (type === 3 && pts.length > 1) {
      const a = pts[0], b = pts[pts.length - 1];
      if (a[0] === b[0] && a[1] === b[1]) pts.pop();          // ClosePath referme l'anneau
    }
    if ((type === 3 && pts.length < 3) || (type === 2 && pts.length < 2)) continue;
    out.push(command(1, 1), zigzag(pts[0][0] - cx), zigzag(pts[0][1] - cy));
    cx = pts[0][0]; cy = pts[0][1];
    out.push(command(2, pts.length - 1));
    for (let i = 1; i < pts.length; i++) {
      out.push(zigzag(pts[i][0] - cx), zigzag(pts[i][1] - cy));
      cx = pts[i][0]; cy = pts[i][1];
    }
    if (type === 3) out.push(command(7, 1));
  }
  return out;
}

/** Une couche MVT. Les propriétés conservées sont toutes des entiers positifs
    (uint_value) — c'est le seul cas dont ce fond de carte a besoin. */
function encodeLayer(name, features, keep) {
  const layer = new Pbf();
  layer.tag(15, 0).varint(2);                    // version
  layer.string(1, name);
  const keys = [], values = [];
  let n = 0;
  for (const f of features) {
    if (f.type !== 2 && f.type !== 3) continue;
    const geom = encodeGeometry(f.type, f.geometry);
    if (!geom.length) continue;
    const tags = [];
    for (const k of keep) {
      const v = f.tags && f.tags[k];
      if (v == null) continue;
      let ki = keys.indexOf(k); if (ki < 0) { ki = keys.length; keys.push(k); }
      let vi = values.indexOf(v); if (vi < 0) { vi = values.length; values.push(v); }
      tags.push(ki, vi);
    }
    const feat = new Pbf();
    if (tags.length) feat.packed(2, tags);
    feat.tag(3, 0).varint(f.type);
    feat.packed(4, geom);
    layer.message(2, feat);
    n++;
  }
  if (!n) return null;
  for (const k of keys) layer.string(3, k);
  for (const v of values) layer.message(4, new Pbf().tag(5, 0).varint(v));
  layer.tag(5, 0).varint(EXTENT);
  return layer;
}

/* ── Archive PMTiles v3 (https://github.com/protomaps/PMTiles/blob/main/spec/v3/spec.md) ── */
/** Numéro de tuile PMTiles : tuiles des zooms inférieurs + rang sur la courbe
    de Hilbert du zoom z. */
function zxyToTileId(z, x, y) {
  let acc = 0;
  for (let i = 0; i < z; i++) acc += 4 ** i;
  const n = 2 ** z;
  let d = 0;
  for (let s = n / 2; s >= 1; s /= 2) {
    const rx = (x & s) > 0 ? 1 : 0;
    const ry = (y & s) > 0 ? 1 : 0;
    d += s * s * ((3 * rx) ^ ry);
    if (ry === 0) {
      if (rx === 1) { x = n - 1 - x; y = n - 1 - y; }
      const t = x; x = y; y = t;
    }
  }
  return acc + d;
}

function serializeDirectory(entries) {
  const p = new Pbf();
  p.varint(entries.length);
  let last = 0;
  for (const e of entries) { p.varint(e.tileId - last); last = e.tileId; }
  for (const e of entries) p.varint(e.runLength);
  for (const e of entries) p.varint(e.length);
  entries.forEach((e, i) => {
    const prev = entries[i - 1];
    p.varint(i > 0 && e.offset === prev.offset + prev.length ? 0 : e.offset + 1);
  });
  return gzipSync(Buffer.from(p.bytes));
}

/** Répertoire racine + répertoires feuilles : la racine doit tenir, avec
    l'en-tête, dans les 16 384 premiers octets (première lecture du client). */
function buildDirectories(entries) {
  const root = serializeDirectory(entries);
  if (root.length <= 16384 - 127) return { root, leaves: Buffer.alloc(0) };
  for (let leafSize = 4096; ; leafSize *= 2) {
    const leafBufs = [], rootEntries = [];
    let offset = 0;
    for (let i = 0; i < entries.length; i += leafSize) {
      const chunk = entries.slice(i, i + leafSize);
      const buf = serializeDirectory(chunk);
      rootEntries.push({ tileId: chunk[0].tileId, offset, length: buf.length, runLength: 0 });
      leafBufs.push(buf);
      offset += buf.length;
    }
    const r = serializeDirectory(rootEntries);
    if (r.length <= 16384 - 127) return { root: r, leaves: Buffer.concat(leafBufs) };
  }
}

function writePmtiles(file, tiles, metadata) {
  // tiles : [{tileId, data}] triés par tileId. Contenus identiques dédoublonnés
  // (très fréquents : pleine mer d'un même palier, intérieur des continents).
  const data = [], byHash = new Map(), entries = [];
  let dataLen = 0;
  for (const t of tiles) {
    const h = sha256(t.data);
    let ref = byHash.get(h);
    if (!ref) {
      ref = { offset: dataLen, length: t.data.length };
      byHash.set(h, ref);
      data.push(t.data);
      dataLen += t.data.length;
    }
    const last = entries[entries.length - 1];
    if (last && last.offset === ref.offset && last.tileId + last.runLength === t.tileId) last.runLength++;
    else entries.push({ tileId: t.tileId, offset: ref.offset, length: ref.length, runLength: 1 });
  }
  const { root, leaves } = buildDirectories(entries);
  const meta = gzipSync(Buffer.from(JSON.stringify(metadata)));

  const rootOff = 127, metaOff = rootOff + root.length, leafOff = metaOff + meta.length, dataOff = leafOff + leaves.length;
  const h = Buffer.alloc(127);
  h.write('PMTiles', 0, 'ascii'); h.writeUInt8(3, 7);
  const u64 = (v, at) => h.writeBigUInt64LE(BigInt(v), at);
  u64(rootOff, 8); u64(root.length, 16);
  u64(metaOff, 24); u64(meta.length, 32);
  u64(leafOff, 40); u64(leaves.length, 48);
  u64(dataOff, 56); u64(dataLen, 64);
  u64(tiles.length, 72); u64(entries.length, 80); u64(data.length, 88);
  h.writeUInt8(1, 96);          // clustered : contenus rangés par tileId
  h.writeUInt8(2, 97);          // compression interne : gzip
  h.writeUInt8(2, 98);          // compression des tuiles : gzip
  h.writeUInt8(1, 99);          // type : Mapbox Vector Tile
  h.writeUInt8(0, 100); h.writeUInt8(MAX_ZOOM, 101);
  h.writeInt32LE(-180e7, 102); h.writeInt32LE(-85e7, 106);
  h.writeInt32LE(180e7, 110); h.writeInt32LE(85e7, 114);
  h.writeUInt8(0, 118); h.writeInt32LE(0, 119); h.writeInt32LE(0, 123);

  writeFileSync(file, Buffer.concat([h, root, meta, leaves, ...data]));
  return { entries: entries.length, contents: data.length, bytes: 127 + root.length + meta.length + leaves.length + dataLen };
}

/* ── Programme ─────────────────────────────────────────────────────────────── */
async function main() {
  const t0 = Date.now();
  const GeoJSONVT = await loadGeojsonVt();
  mkdirSync(OUT_DIR, { recursive: true });

  const indexes = [];
  for (const layer of LAYERS) {
    const features = [];
    for (const src of layer.sources) {
      const name = typeof src === 'string' ? src : src.name;
      const fc = await fetchNE(name);
      for (const f of fc.features) {
        const props = typeof src === 'string'
          ? { min_zoom: Math.max(0, Math.floor(Number(f.properties.min_zoom ?? 0)) - 1) }
          : src.props;
        const nf = normalizeFeature(f, props);
        if (nf) features.push(nf);
      }
      console.log(`    ${name} : ${fc.features.length} objets`);
    }
    const index = new GeoJSONVT({ type: 'FeatureCollection', features },
      { maxZoom: MAX_ZOOM, indexMaxZoom: 0, extent: EXTENT, buffer: 64, tolerance: 3 });
    indexes.push({ layer, index });
    console.log(`  · couche ${layer.name} : ${features.length} objets indexés`);
  }

  const tiles = [];
  let raw = 0;
  for (let z = 0; z <= MAX_ZOOM; z++) {
    const n = 2 ** z;
    let count = 0;
    for (let x = 0; x < n; x++) {
      for (let y = 0; y < n; y++) {
        const tile = new Pbf();
        for (const { layer, index } of indexes) {
          const t = index.getTileRaw(z, x, y);
          if (!t) continue;
          const feats = layer.minZoomFilter
            ? t.features.filter(f => !f.tags || (f.tags.min_zoom ?? 0) <= z)
            : t.features;
          const enc = encodeLayer(layer.name, feats, layer.keep || []);
          if (enc) tile.message(3, enc);
        }
        if (!tile.bytes.length) continue;
        const buf = Buffer.from(tile.bytes);
        raw += buf.length;
        tiles.push({ tileId: zxyToTileId(z, x, y), data: gzipSync(buf) });
        count++;
      }
    }
    console.log(`  · zoom ${z} : ${count} tuiles`);
  }
  tiles.sort((a, b) => a.tileId - b.tileId);

  const stats = writePmtiles(OUT_FILE, tiles, {
    name: 'Fond Natural Earth 1:10m — voyageurs.html',
    attribution: '<a href="https://www.naturalearthdata.com">Natural Earth</a>',
    vector_layers: LAYERS.map(l => ({ id: l.name, fields: Object.fromEntries((l.keep || []).map(k => [k, 'Number'])),
                                      minzoom: 0, maxzoom: MAX_ZOOM })),
  });
  console.log(`  · ${OUT_FILE} : ${(stats.bytes / 1e6).toFixed(1)} Mo, ` +
    `${tiles.length} tuiles, ${stats.contents} contenus distincts, ${stats.entries} entrées de répertoire ` +
    `(${(raw / 1e6).toFixed(1)} Mo avant gzip) — ${((Date.now() - t0) / 1000).toFixed(0)} s`);
}

console.log(`▶ build-natural-earth (1:10m, zooms 0-${MAX_ZOOM})`);
main()
  .then(() => console.log('✓ build-natural-earth : terminé'))
  .catch(err => { console.error('✖ build-natural-earth :', err.stack || err.message); process.exit(1); });
