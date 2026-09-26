/**
 * export-voyageurs.mjs
 * ────────────────────────────────────────────────────────────────────────────
 * Reconstruit `/data/voyageurs.json` — données de l'exposition
 * voyageurs.html — depuis le schéma `expo_voyageurs`
 * (db/migrations/0009_expo_voyageurs.sql). Seuls les voyageurs et voyages
 * `publie = true` sont exportés : les brouillons de recherche restent en
 * base sans apparaître sur la page publique.
 *
 * Forme de sortie (lue par js/voyageurs.js, identique à data/voyageurs.json) :
 *   [{ id, nom, vie, lienDouai, portrait, couleur, resume,
 *      ecrits:[{titre, annee, cote}],
 *      voyages:[{ id, titre, sousTitre, sources:[…],
 *                 points:[{ lieu, coord:[lng,lat], date, depart, approx, mode,
 *                           arret:{titre, texte, citation, source} }] }] }]
 * Les clés vides sont omises plutôt qu'écrites à null.
 *
 * Repli : contrairement aux autres exports, une base arrêtée ne fait pas
 * échouer la route — c'est une page PUBLIQUE, qui ne doit pas se retrouver
 * vide parce que Postgres n'a pas été relancé. On sert alors le fichier
 * committé data/voyageurs.json (instantané à régénérer avec
 * `npm run snapshot:voyageurs`), avec un avertissement dans la console du
 * serveur.
 */
import { readFile } from 'node:fs/promises';
import { getPool } from './pg.mjs';

const SNAPSHOT = 'data/voyageurs.json';

function compact(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v == null || v === false || v === '') continue;
    if (Array.isArray(v) && !v.length) continue;
    out[k] = v;
  }
  return out;
}

export async function readVoyageursFromDb() {
  const pool = getPool({ unpooled: true });
  const [vr, ec, vo, et, so] = await Promise.all([
    pool.query(`SELECT id, nom, vie, lien_douai, portrait, couleur, resume
                FROM expo_voyageurs.voyageurs WHERE publie ORDER BY ordre, nom`),
    pool.query(`SELECT voyageur_id, titre, annee, cote
                FROM expo_voyageurs.ecrits ORDER BY voyageur_id, ordre`),
    pool.query(`SELECT id, voyageur_id, titre, sous_titre
                FROM expo_voyageurs.voyages WHERE publie ORDER BY voyageur_id, ordre, id`),
    pool.query(`SELECT voyage_id, lieu, lng, lat, date_arrivee, date_depart, date_approx, mode,
                       arret_titre, arret_texte, arret_citation, arret_source
                FROM expo_voyageurs.etapes ORDER BY voyage_id, ordre`),
    pool.query(`SELECT voyage_id, reference
                FROM expo_voyageurs.sources ORDER BY voyage_id, ordre`),
  ]);

  const group = (rows, key) => {
    const m = new Map();
    for (const r of rows) {
      if (!m.has(r[key])) m.set(r[key], []);
      m.get(r[key]).push(r);
    }
    return m;
  };
  const ecrits = group(ec.rows, 'voyageur_id');
  const voyages = group(vo.rows, 'voyageur_id');
  const etapes = group(et.rows, 'voyage_id');
  const sources = group(so.rows, 'voyage_id');

  return vr.rows.map(v => compact({
    id: v.id,
    nom: v.nom,
    vie: v.vie,
    lienDouai: v.lien_douai,
    portrait: v.portrait,
    couleur: v.couleur,
    resume: v.resume,
    ecrits: (ecrits.get(v.id) || []).map(e => compact({ titre: e.titre, annee: e.annee, cote: e.cote })),
    voyages: (voyages.get(v.id) || [])
      // Un voyage sans étape ne peut pas être tracé : on ne l'expose pas.
      .filter(y => (etapes.get(y.id) || []).length >= 2)
      .map(y => compact({
        id: y.id,
        titre: y.titre,
        sousTitre: y.sous_titre,
        sources: (sources.get(y.id) || []).map(s => s.reference),
        points: etapes.get(y.id).map(p => compact({
          lieu: p.lieu,
          coord: [p.lng, p.lat],
          date: p.date_arrivee,
          depart: p.date_depart,
          approx: p.date_approx,
          mode: p.mode,
          arret: p.arret_titre ? compact({
            titre: p.arret_titre,
            texte: p.arret_texte,
            citation: p.arret_citation,
            source: p.arret_source,
          }) : null,
        })),
      })),
  }));
}

// Au-delà, on sert le repli. Constaté le 2026-09-25 : après un plantage, une
// instance Postgres acceptait encore les connexions mais ne répondait plus aux
// requêtes — sans délai, la route restait pendante et la page publique vide,
// le repli ne se déclenchant jamais (aucune erreur levée).
const DB_TIMEOUT_MS = 4000;

export async function exportVoyageurs() {
  let timer;
  try {
    return await Promise.race([
      readVoyageursFromDb(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`pas de réponse en ${DB_TIMEOUT_MS / 1000} s`)), DB_TIMEOUT_MS);
      }),
    ]);
  } catch (err) {
    console.warn(`[voyageurs] base indisponible (${err.message}) — repli sur ${SNAPSHOT}`);
    return JSON.parse(await readFile(SNAPSHOT, 'utf-8'));
  } finally {
    clearTimeout(timer);
  }
}
