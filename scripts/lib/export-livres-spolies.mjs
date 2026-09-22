/**
 * export-livres-spolies.mjs
 * ────────────────────────────────────────────────────────────────────────────
 * Reconstruit `data/livres-spolies.json` (données de base + overrides déjà
 * fusionnés en une seule table par db-migrate-spolies.mjs — voir
 * db/migrations/0002_livres_spolies.sql) dans la même forme de ligne que le
 * fichier committé.
 */
import { getPool } from './pg.mjs';

export async function exportLivresSpolies() {
  const pool = getPool({ unpooled: true });
  const { rows } = await pool.query(`
    SELECT id, caisse, cote_bm, type, volumes, auteur, titre, lieu, editeur, date, trouve, ex_libris, possesseur
    FROM livres_spolies ORDER BY id
  `);
  return rows.map(r => ({
    id: r.id,
    caisse: r.caisse ?? '',
    coteBM: r.cote_bm ?? '',
    type: r.type ?? '',
    volumes: r.volumes ?? '',
    auteur: r.auteur ?? '',
    titre: r.titre ?? '',
    lieu: r.lieu ?? '',
    editeur: r.editeur ?? '',
    date: r.date ?? '',
    trouve: r.trouve,
    exLibris: r.ex_libris,
    possesseur: r.possesseur ?? '',
  }));
}
