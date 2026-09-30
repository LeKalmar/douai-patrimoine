/**
 * /api/voyageurs-admin — lecture/écriture du schéma `expo_voyageurs`
 * (db/migrations/0009_expo_voyageurs.sql) pour l'éditeur
 * voyageurs-admin.html.
 *
 * GET  : tout le contenu de l'exposition, brouillons (`publie = false`)
 *        compris, avec pour chaque voyageur/voyage une `version`
 *        (updated_at en texte) servant au contrôle de concurrence.
 * POST : une action par appel, chacune dans sa propre transaction :
 *   { action:'saveVoyageur', voyageur:{…, ecrits:[…]}, originalId?, version? }
 *   { action:'saveVoyage',   voyage:{…, voyageurId, sources:[…], points:[…]}, originalId?, version? }
 *   { action:'deleteVoyageur', id }      { action:'deleteVoyage', id }
 *   { action:'reorder', kind:'voyageurs'|'voyages', ids:[…] }
 *   Un voyage est réécrit en bloc (étapes et sources supprimées puis
 *   réinsérées, ordres renumérotés de 10 en 10) : l'éditeur envoie toujours
 *   le voyage complet, jamais un patch d'étape isolée.
 *   `originalId` absent = création ; présent = mise à jour (l'identifiant
 *   peut changer, les tables filles suivent par ON UPDATE CASCADE).
 *   `version` différente de celle en base = un·e collègue a enregistré entre-
 *   temps → 409, rien n'est écrit.
 *
 * GET ET POST authentifiés (contrairement aux endpoints R2 dont la lecture
 * est publique) : les brouillons sont des notes de recherche non publiées.
 *
 * Après chaque écriture réussie :
 *   - le cache mémoire de /data/voyageurs.json est invalidé
 *     (lib/data-json-cache.mjs), pour que la page publique reflète la saisie
 *     tout de suite plutôt qu'au bout du TTL de 60 s ;
 *   - data/voyageurs.json (repli committé, voyages publiés seulement) est
 *     réécrit — même contenu que `npm run snapshot:voyageurs`, qui n'a donc
 *     plus besoin d'être lancé à la main après une saisie par l'éditeur.
 */
import { writeFile } from 'node:fs/promises';
import { requireAuth } from '../lib/auth.mjs';
import { invalidate } from '../lib/data-json-cache.mjs';
import { getPool } from '../scripts/lib/pg.mjs';
import { readVoyageursFromDb } from '../scripts/lib/export-voyageurs.mjs';

const SNAPSHOT = new URL('../data/voyageurs.json', import.meta.url);
const ORDRE_PAS = 10;
const ID_RE = /^[a-z0-9-]+$/;
const DATE_RE = /^\d{4}(-\d{2}(-\d{2})?)?$/;
const COULEUR_RE = /^#[0-9A-Fa-f]{6}$/;
const MODES = new Set(['bateau', 'jonque', 'pied', 'attelage', 'civiere', 'inconnu']);
// Bornes du zoom forcé d'une étape — mêmes que le CHECK SQL (0010_voyageurs_zoom.sql).
const ZOOM_MIN = 1, ZOOM_MAX = 13;

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const bad = (msg) => new HttpError(400, msg);

/** Chaîne nettoyée, ou null si vide. */
function txt(v) {
  if (v == null) return null;
  const s = String(v).trim();
  return s ? s : null;
}

function checkDate(value, label) {
  const s = txt(value);
  if (s == null) return null;
  if (!DATE_RE.test(s)) throw bad(`${label} : « ${s} » n'est pas au format AAAA, AAAA-MM ou AAAA-MM-JJ.`);
  const [, mo, d] = s.split('-').map(Number);
  if (mo != null && (mo < 1 || mo > 12)) throw bad(`${label} : mois invalide (« ${s} »).`);
  if (d != null && (d < 1 || d > 31)) throw bad(`${label} : jour invalide (« ${s} »).`);
  return s;
}

// ─── Lecture ────────────────────────────────────────────────────────────────

async function readAll() {
  const pool = getPool();
  const [vr, ec, vo, et, so] = await Promise.all([
    pool.query(`SELECT id, nom, vie, lien_douai, portrait, couleur, resume, publie, updated_at::text AS version
                FROM expo_voyageurs.voyageurs ORDER BY ordre, nom`),
    pool.query(`SELECT voyageur_id, titre, annee, cote FROM expo_voyageurs.ecrits ORDER BY voyageur_id, ordre`),
    pool.query(`SELECT id, voyageur_id, titre, sous_titre, publie, updated_at::text AS version
                FROM expo_voyageurs.voyages ORDER BY voyageur_id, ordre, id`),
    pool.query(`SELECT voyage_id, lieu, lng, lat, date_arrivee, date_depart, date_approx, mode, zoom,
                       arret_titre, arret_texte, arret_citation, arret_source
                FROM expo_voyageurs.etapes ORDER BY voyage_id, ordre`),
    pool.query(`SELECT voyage_id, reference FROM expo_voyageurs.sources ORDER BY voyage_id, ordre`),
  ]);
  const group = (rows, key) => {
    const m = new Map();
    for (const r of rows) (m.get(r[key]) || m.set(r[key], []).get(r[key])).push(r);
    return m;
  };
  const ecrits = group(ec.rows, 'voyageur_id');
  const voyages = group(vo.rows, 'voyageur_id');
  const etapes = group(et.rows, 'voyage_id');
  const sources = group(so.rows, 'voyage_id');

  return vr.rows.map(v => ({
    id: v.id, nom: v.nom, vie: v.vie || '', lienDouai: v.lien_douai || '', portrait: v.portrait || '',
    couleur: v.couleur, resume: v.resume || '', publie: v.publie, version: v.version,
    ecrits: (ecrits.get(v.id) || []).map(e => ({ titre: e.titre, annee: e.annee || '', cote: e.cote || '' })),
    voyages: (voyages.get(v.id) || []).map(y => ({
      id: y.id, voyageurId: v.id, titre: y.titre, sousTitre: y.sous_titre || '',
      publie: y.publie, version: y.version,
      sources: (sources.get(y.id) || []).map(s => s.reference),
      points: (etapes.get(y.id) || []).map(p => ({
        lieu: p.lieu || '', coord: [p.lng, p.lat],
        date: p.date_arrivee || '', depart: p.date_depart || '', approx: p.date_approx, mode: p.mode || '',
        zoom: p.zoom ?? '',
        arret: p.arret_titre ? {
          titre: p.arret_titre, texte: p.arret_texte || '',
          citation: p.arret_citation || '', source: p.arret_source || '',
        } : null,
      })),
    })),
  }));
}

// ─── Écriture ───────────────────────────────────────────────────────────────

async function checkVersion(client, table, id, version) {
  const { rows } = await client.query(
    `SELECT updated_at::text AS version FROM expo_voyageurs.${table} WHERE id = $1 FOR UPDATE`, [id]);
  if (!rows.length) throw new HttpError(404, `« ${id} » n'existe plus en base (supprimé par un·e collègue ?).`);
  if (version && rows[0].version !== version) {
    throw new HttpError(409, 'Cette fiche a été modifiée entre-temps par un·e collègue. ' +
      'Rechargez la page pour récupérer sa version (vos modifications non enregistrées seront perdues).');
  }
}

async function saveVoyageur(client, body) {
  const v = body.voyageur || {};
  const id = txt(v.id);
  const nom = txt(v.nom);
  if (!nom) throw bad('Le nom du voyageur est obligatoire.');
  if (!id || !ID_RE.test(id)) throw bad('Identifiant : minuscules, chiffres et tirets uniquement (ex. trigault).');
  const couleur = txt(v.couleur) || '#B4213C';
  if (!COULEUR_RE.test(couleur)) throw bad('Couleur : format #RRGGBB attendu.');
  const ecrits = (Array.isArray(v.ecrits) ? v.ecrits : [])
    .map(e => ({ titre: txt(e.titre), annee: txt(e.annee), cote: txt(e.cote) }))
    .filter(e => e.titre || e.annee || e.cote);
  if (ecrits.some(e => !e.titre)) throw bad('Chaque écrit doit avoir un titre.');

  const vals = [id, nom, txt(v.vie), txt(v.lienDouai), txt(v.portrait), couleur, txt(v.resume), !!v.publie];
  const originalId = txt(body.originalId);
  if (originalId) {
    await checkVersion(client, 'voyageurs', originalId, body.version);
    await client.query(
      `UPDATE expo_voyageurs.voyageurs SET id=$1, nom=$2, vie=$3, lien_douai=$4, portrait=$5, couleur=$6,
         resume=$7, publie=$8, updated_at=now() WHERE id=$9`, [...vals, originalId]);
  } else {
    await client.query(
      `INSERT INTO expo_voyageurs.voyageurs (id, nom, vie, lien_douai, portrait, couleur, resume, publie, ordre)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,
         (SELECT coalesce(max(ordre), 0) + ${ORDRE_PAS} FROM expo_voyageurs.voyageurs))`, vals);
  }
  await client.query('DELETE FROM expo_voyageurs.ecrits WHERE voyageur_id = $1', [id]);
  for (const [i, e] of ecrits.entries()) {
    await client.query(
      'INSERT INTO expo_voyageurs.ecrits (voyageur_id, ordre, titre, annee, cote) VALUES ($1,$2,$3,$4,$5)',
      [id, (i + 1) * ORDRE_PAS, e.titre, e.annee, e.cote]);
  }
  return id;
}

function normalizePoint(p, i) {
  const n = i + 1;
  const lng = Number(p?.coord?.[0]), lat = Number(p?.coord?.[1]);
  if (!Number.isFinite(lng) || lng < -180 || lng > 180) throw bad(`Étape ${n} : longitude invalide.`);
  if (!Number.isFinite(lat) || lat < -90 || lat > 90) throw bad(`Étape ${n} : latitude invalide.`);
  const date = checkDate(p.date, `Étape ${n}, date d'arrivée`);
  const depart = checkDate(p.depart, `Étape ${n}, date de départ`);
  if (depart && !date) throw bad(`Étape ${n} : une date de départ demande aussi une date d'arrivée.`);
  const mode = txt(p.mode);
  if (mode && !MODES.has(mode)) throw bad(`Étape ${n} : moyen de transport inconnu (« ${mode} »).`);
  // Zoom forcé : vide = automatique (d'après le moyen de transport).
  let zoom = null;
  if (p.zoom != null && String(p.zoom).trim() !== '') {
    zoom = Number(String(p.zoom).replace(',', '.'));
    if (!Number.isFinite(zoom) || zoom < ZOOM_MIN || zoom > ZOOM_MAX) {
      throw bad(`Étape ${n} : zoom invalide (entre ${ZOOM_MIN} et ${ZOOM_MAX}, ou vide pour automatique).`);
    }
    zoom = Math.round(zoom * 10) / 10;
  }
  const a = p.arret || null;
  const arret = a ? {
    titre: txt(a.titre), texte: txt(a.texte), citation: txt(a.citation), source: txt(a.source),
  } : null;
  if (arret && !arret.titre && (arret.texte || arret.citation || arret.source)) {
    throw bad(`Étape ${n} : un arrêt raconté doit avoir un titre.`);
  }
  return {
    lieu: txt(p.lieu), lng: Math.round(lng * 1e5) / 1e5, lat: Math.round(lat * 1e5) / 1e5,
    date, depart, approx: !!p.approx, mode, zoom,
    arret_titre: arret?.titre || null, arret_texte: arret?.titre ? arret.texte : null,
    arret_citation: arret?.titre ? arret.citation : null, arret_source: arret?.titre ? arret.source : null,
  };
}

async function saveVoyage(client, body) {
  const y = body.voyage || {};
  const id = txt(y.id);
  const titre = txt(y.titre);
  const voyageurId = txt(y.voyageurId);
  if (!titre) throw bad('Le titre du voyage est obligatoire.');
  if (!id || !ID_RE.test(id)) throw bad('Identifiant du voyage : minuscules, chiffres et tirets uniquement (ex. trigault-1618).');
  if (!voyageurId) throw bad('Voyageur manquant.');
  const points = (Array.isArray(y.points) ? y.points : []).map(normalizePoint);
  const sources = (Array.isArray(y.sources) ? y.sources : []).map(txt).filter(Boolean);
  const publie = !!y.publie;
  if (publie) {
    if (points.length < 2) throw bad('Un voyage publié doit avoir au moins deux étapes.');
    if (!points.some(p => p.date)) throw bad('Un voyage publié doit avoir au moins une étape datée.');
  }

  const vals = [id, voyageurId, titre, txt(y.sousTitre), publie];
  const originalId = txt(body.originalId);
  if (originalId) {
    await checkVersion(client, 'voyages', originalId, body.version);
    await client.query(
      `UPDATE expo_voyageurs.voyages SET id=$1, voyageur_id=$2, titre=$3, sous_titre=$4, publie=$5,
         updated_at=now() WHERE id=$6`, [...vals, originalId]);
  } else {
    await client.query(
      `INSERT INTO expo_voyageurs.voyages (id, voyageur_id, titre, sous_titre, publie, ordre)
       VALUES ($1,$2,$3,$4,$5,
         (SELECT coalesce(max(ordre), 0) + ${ORDRE_PAS} FROM expo_voyageurs.voyages WHERE voyageur_id = $2))`, vals);
  }

  await client.query('DELETE FROM expo_voyageurs.etapes WHERE voyage_id = $1', [id]);
  await client.query('DELETE FROM expo_voyageurs.sources WHERE voyage_id = $1', [id]);
  for (const [i, p] of points.entries()) {
    await client.query(
      `INSERT INTO expo_voyageurs.etapes (voyage_id, ordre, lieu, lng, lat, date_arrivee, date_depart,
         date_approx, mode, zoom, arret_titre, arret_texte, arret_citation, arret_source)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [id, (i + 1) * ORDRE_PAS, p.lieu, p.lng, p.lat, p.date, p.depart, p.approx, p.mode, p.zoom,
       p.arret_titre, p.arret_texte, p.arret_citation, p.arret_source]);
  }
  for (const [i, s] of sources.entries()) {
    await client.query('INSERT INTO expo_voyageurs.sources (voyage_id, ordre, reference) VALUES ($1,$2,$3)',
      [id, (i + 1) * ORDRE_PAS, s]);
  }
  return id;
}

async function reorder(client, body) {
  const table = body.kind === 'voyageurs' ? 'voyageurs' : body.kind === 'voyages' ? 'voyages' : null;
  if (!table || !Array.isArray(body.ids)) throw bad('Réordonnancement : paramètres invalides.');
  for (const [i, id] of body.ids.entries()) {
    await client.query(`UPDATE expo_voyageurs.${table} SET ordre = $1 WHERE id = $2`, [(i + 1) * ORDRE_PAS, String(id)]);
  }
}

async function remove(client, table, id) {
  if (!txt(id)) throw bad('Identifiant manquant.');
  // Les tables filles suivent par ON DELETE CASCADE.
  await client.query(`DELETE FROM expo_voyageurs.${table} WHERE id = $1`, [id]);
}

const ACTIONS = {
  saveVoyageur,
  saveVoyage,
  reorder,
  deleteVoyageur: (c, b) => remove(c, 'voyageurs', b.id),
  deleteVoyage: (c, b) => remove(c, 'voyages', b.id),
};

/** Traduit les violations de contraintes Postgres en messages lisibles. */
function pgMessage(err) {
  if (err.code === '23505') return 'Cet identifiant est déjà utilisé : choisissez-en un autre.';
  if (err.code === '23503') return 'Le voyageur rattaché n\'existe pas (supprimé entre-temps ?).';
  if (err.code === '23514') return `Donnée refusée par la base (contrainte ${err.constraint || 'CHECK'}).`;
  if (err.code === 'ECONNREFUSED' || err.code === '57P03') {
    return 'La base de données n\'est pas démarrée (npm run db:local:start sur le poste serveur).';
  }
  return null;
}

async function refreshPublic() {
  invalidate('/data/voyageurs.json');
  try {
    const data = await readVoyageursFromDb();
    await writeFile(SNAPSHOT, JSON.stringify(data, null, 2) + '\n');
  } catch (err) {
    // La saisie est bien en base : seul le fichier de repli est en retard.
    console.warn('[voyageurs-admin] data/voyageurs.json non réécrit :', err.message);
  }
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    requireAuth(req);
    if (req.method === 'GET') {
      res.status(200).json({ voyageurs: await readAll() });
      return;
    }
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'GET, POST');
      res.status(405).json({ error: 'Méthode non supportée.' });
      return;
    }
    const body = req.body || {};
    const action = ACTIONS[body.action];
    if (!action) throw bad(`Action inconnue : ${body.action}`);

    const client = await getPool().connect();
    let result;
    try {
      await client.query('BEGIN');
      result = await action(client, body);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
    await refreshPublic();
    res.status(200).json({ ok: true, id: result ?? null, voyageurs: await readAll() });
  } catch (err) {
    const status = err.status || (pgMessage(err) ? (err.code?.startsWith('23') ? 400 : 503) : 500);
    if (status >= 500) console.error('[api/voyageurs-admin]', err);
    res.status(status).json({ error: pgMessage(err) || err.message || 'Erreur serveur.' });
  }
}
