#!/usr/bin/env node
/**
 * db-voyageurs.mjs
 * ────────────────────────────────────────────────────────────────────────────
 * Aller-retour entre le schéma `expo_voyageurs`
 * (db/migrations/0009_expo_voyageurs.sql) et le fichier de repli committé
 * data/voyageurs.json.
 *
 *   node scripts/db-voyageurs.mjs seed [--force]    (npm run db:seed:voyageurs)
 *     Remplit la base depuis data/voyageurs.json. Refuse si le schéma
 *     contient déjà des voyageurs — c'est la base qui fait foi une fois
 *     remplie, un second passage écraserait les saisies faites depuis.
 *     --force vide d'abord les cinq tables (dans la même transaction).
 *
 *   node scripts/db-voyageurs.mjs snapshot          (npm run snapshot:voyageurs)
 *     Réécrit data/voyageurs.json depuis la base (voyages publiés
 *     uniquement), pour que le repli reste à jour. À relancer avant de
 *     committer après une série de saisies.
 *
 * Aucune dépendance npm au-delà de `pg`. Node ≥ 18.
 * ────────────────────────────────────────────────────────────────────────────
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { getPool, buildBatchInsert, closeAllPools } from './lib/pg.mjs';
import { readVoyageursFromDb } from './lib/export-voyageurs.mjs';

const FILE = 'data/voyageurs.json';
const ORDRE_PAS = 10; // trous entre deux ordres, pour pouvoir insérer une étape plus tard

async function seed(force) {
  const data = JSON.parse(readFileSync(FILE, 'utf-8'));
  const pool = getPool({ unpooled: true });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: [{ n }] } = await client.query('SELECT count(*)::int AS n FROM expo_voyageurs.voyageurs');
    if (n > 0 && !force) {
      throw new Error(`le schéma expo_voyageurs contient déjà ${n} voyageur(s). ` +
        `La base fait foi : relancez avec --force pour tout remplacer par ${FILE}.`);
    }
    if (n > 0) {
      // Les étapes, écrits, voyages et sources suivent par ON DELETE CASCADE.
      await client.query('DELETE FROM expo_voyageurs.voyageurs');
      console.log(`  · ${n} voyageur(s) supprimé(s) (--force)`);
    }

    const voyageurs = [], ecrits = [], voyages = [], etapes = [], sources = [];
    data.forEach((vr, i) => {
      voyageurs.push({
        id: vr.id, nom: vr.nom, vie: vr.vie, lien_douai: vr.lienDouai, portrait: vr.portrait,
        couleur: vr.couleur || '#B4213C', resume: vr.resume, ordre: (i + 1) * ORDRE_PAS, publie: true,
      });
      (vr.ecrits || []).forEach((e, j) => ecrits.push({
        voyageur_id: vr.id, ordre: (j + 1) * ORDRE_PAS, titre: e.titre, annee: e.annee, cote: e.cote,
      }));
      (vr.voyages || []).forEach((v, j) => {
        voyages.push({ id: v.id, voyageur_id: vr.id, titre: v.titre, sous_titre: v.sousTitre,
                       ordre: (j + 1) * ORDRE_PAS, publie: true });
        (v.sources || []).forEach((s, k) => sources.push({ voyage_id: v.id, ordre: (k + 1) * ORDRE_PAS, reference: s }));
        v.points.forEach((p, k) => etapes.push({
          voyage_id: v.id, ordre: (k + 1) * ORDRE_PAS, lieu: p.lieu,
          lng: p.coord[0], lat: p.coord[1],
          date_arrivee: p.date, date_depart: p.depart, date_approx: !!p.approx, mode: p.mode,
          arret_titre: p.arret?.titre, arret_texte: p.arret?.texte,
          arret_citation: p.arret?.citation, arret_source: p.arret?.source,
        }));
      });
    });

    const inserts = [
      ['expo_voyageurs.voyageurs', ['id', 'nom', 'vie', 'lien_douai', 'portrait', 'couleur', 'resume', 'ordre', 'publie'], voyageurs],
      ['expo_voyageurs.ecrits', ['voyageur_id', 'ordre', 'titre', 'annee', 'cote'], ecrits],
      ['expo_voyageurs.voyages', ['id', 'voyageur_id', 'titre', 'sous_titre', 'ordre', 'publie'], voyages],
      ['expo_voyageurs.sources', ['voyage_id', 'ordre', 'reference'], sources],
      ['expo_voyageurs.etapes', ['voyage_id', 'ordre', 'lieu', 'lng', 'lat', 'date_arrivee', 'date_depart',
        'date_approx', 'mode', 'arret_titre', 'arret_texte', 'arret_citation', 'arret_source'], etapes],
    ];
    for (const [table, cols, rows] of inserts) {
      const q = buildBatchInsert(table, cols, rows);
      if (q) await client.query(q.sql, q.values);
      console.log(`  · ${table} : ${rows.length} ligne(s)`);
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function snapshot() {
  const data = await readVoyageursFromDb();
  writeFileSync(FILE, JSON.stringify(data, null, 2) + '\n');
  const nVoyages = data.reduce((s, v) => s + (v.voyages?.length || 0), 0);
  console.log(`  · ${FILE} réécrit : ${data.length} voyageur(s), ${nVoyages} voyage(s) publié(s)`);
}

const [cmd, ...flags] = process.argv.slice(2);
const run = cmd === 'seed' ? () => seed(flags.includes('--force'))
          : cmd === 'snapshot' ? snapshot
          : null;
if (!run) {
  console.error('Usage : node scripts/db-voyageurs.mjs seed [--force] | snapshot');
  process.exit(2);
}
console.log(`▶ db-voyageurs ${cmd}`);
run()
  .then(() => closeAllPools())
  .then(() => console.log(`✓ db-voyageurs ${cmd} : terminé`))
  .catch(async (err) => {
    console.error(`✖ db-voyageurs ${cmd} :`, err.message);
    await closeAllPools();
    process.exit(1);
  });
