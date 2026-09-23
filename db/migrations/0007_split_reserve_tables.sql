-- 0007_split_reserve_tables.sql — Tables dédiées à la réserve (source
-- 'reserve_marc'), séparées de notices/exemplaires (bib_xml + excel_import)
-- ────────────────────────────────────────────────────────────────────────────
-- Mesuré le 2026-09-23 : les ~15 500 lignes reserve_marc étaient mêlées
-- physiquement aux ~285 000 lignes bib_xml/excel_import dans les mêmes
-- fichiers de table — les 15 607 lignes reserve_marc d'`exemplaires`
-- touchaient 9 262 pages disque distinctes sur 55 587 (16,7% des pages pour
-- 5,2% des lignes), contre ~2 890 pages dans l'idéal si rangées côte à côte
-- (3,2× plus de blocs à lire). Sans effet une fois les pages en cache (RAM
-- Postgres/OS — vérifié : un CLUSTER de test n'a rien changé en lecture
-- chaude), mais chaque lecture À FROID (première visite du jour, instance
-- Vercel/Neon froide, cache mémoire de api/inventaire.mjs expiré) repaie ce
-- surcoût disque. `notices_reserve`/`exemplaires_reserve` isolent
-- physiquement la réserve dans des tables compactes, denses par
-- construction — la requête de scripts/lib/export-inventaire.mjs (le seul
-- gros consommateur de ce périmètre) ne touche plus jamais les pages des
-- ~285 000 lignes bib_xml/excel_import.
--
-- Alternative envisagée et écartée : le partitionnement natif Postgres par
-- `source` aurait donné le même bénéfice physique sans duplication de
-- schéma, mais l'équipe a explicitement demandé une vraie table à part
-- (2026-09-23), pas un partitionnement transparent.
--
-- Construites via `LIKE ... INCLUDING ALL` plutôt qu'une recopie manuelle des
-- ~190 colonnes littérales UNIMARC (scripts/lib/marc-columns.mjs) : les deux
-- schémas ne peuvent pas diverger accidentellement à la création. Colonnes
-- retirées ensuite (toujours NULL pour la réserve, confirmées avec l'équipe
-- le 2026-09-23) :
--   - `source` sur les deux tables (une seule valeur possible désormais,
--     colonne redondante) ;
--   - notices_reserve : `auteur_principal`/`isbn`/`issn` — champs GESMARC à
--     plat, toujours NULL pour reserve_marc (db-migrate-reserve.mjs pose
--     `auteur_principal: null`/`isbn: null`/`issn: null` en dur) ; les
--     valeurs réelles vivent dans les colonnes littérales "700$a"/"010$a"/
--     "021$a" ;
--   - exemplaires_reserve : `etat_code`/`etat_libelle`/`section_code`/
--     `section_libelle`/`bibliotheque_code`/`bibliotheque_libelle` — propres
--     à l'export GESMARC (bib_xml), jamais posés par db-migrate-reserve.mjs.
-- Les colonnes piège (`piege_a_code`/`piege_b_code`/`piege_c_texte`/
-- `piege_label` + les 22 colonnes booléennes GENERATED) sont CONSERVÉES :
-- alimentées pour la réserve depuis 921$a/921$b/921$c, elles portent la
-- fonctionnalité "Piège" de recolement.html/reserve.html/admin.html.
--
-- `LIKE` ne copie pas les contraintes FOREIGN KEY (comportement Postgres
-- documenté) : recréées à la main juste après la création des tables.
-- `LIKE` copie le DEFAULT `nextval(...)` de la colonne `id` tel quel : les
-- deux nouvelles tables partagent donc la séquence de leur table d'origine
-- plutôt que d'en avoir une à elles — sans conséquence (l'unicité de `id`
-- n'a jamais besoin d'être globale entre deux tables distinctes), juste pour
-- éviter la confusion si on l'inspecte plus tard.
--
-- Ordre important pour l'IDEMPOTENCE (ce fichier est rejoué en entier à
-- chaque exécution de db-apply-schema.mjs — voir ce script) : les colonnes
-- exclues sont retirées AVANT la copie des données, et la copie nomme
-- explicitement les colonnes gardées des deux côtés (INSERT comme SELECT) —
-- ainsi la requête reste valide que ce soit le tout premier passage (les
-- colonnes à exclure existent encore sur notices/exemplaires, simplement
-- jamais référencées) ou un rejeu ultérieur (colonnes déjà absentes des deux
-- côtés). Un premier essai avec `INSERT ... SELECT *` échouait au 2e passage
-- (colonnes déjà supprimées d'un côté mais pas de l'autre) — corrigé avant
-- publication. Par ailleurs `exemplaires` a 22 colonnes GENERATED ALWAYS AS
-- (booléens piège) : Postgres refuse toute valeur explicite pour elles, y
-- compris via `SELECT *` — encore une raison de lister les colonnes.
-- La copie proprement dite (DELETE des lignes d'origine une fois copiées)
-- est elle-même naturellement idempotente : plus aucune ligne reserve_marc
-- dans notices/exemplaires après le premier passage, donc rien à
-- recopier/supprimer aux passages suivants (WHERE ne matche plus rien).
-- ────────────────────────────────────────────────────────────────────────────

-- ── 1. Tables (structure identique à l'origine) ─────────────────────────────
CREATE TABLE IF NOT EXISTS notices_reserve (LIKE notices INCLUDING ALL);
CREATE TABLE IF NOT EXISTS exemplaires_reserve (LIKE exemplaires INCLUDING ALL);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'exemplaires_reserve_notice_id_fkey') THEN
    ALTER TABLE exemplaires_reserve ADD CONSTRAINT exemplaires_reserve_notice_id_fkey
      FOREIGN KEY (notice_id) REFERENCES notices_reserve(id);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'exemplaires_reserve_reliure_groupe_id_fkey') THEN
    ALTER TABLE exemplaires_reserve ADD CONSTRAINT exemplaires_reserve_reliure_groupe_id_fkey
      FOREIGN KEY (reliure_groupe_id) REFERENCES reliure_groupes(id);
  END IF;
END $$;

-- ── 2. Retrait des colonnes GESMARC/redondantes, AVANT la copie de données
--      (voir "ordre important" ci-dessus) ──────────────────────────────────
ALTER TABLE notices_reserve
  DROP COLUMN IF EXISTS source,
  DROP COLUMN IF EXISTS auteur_principal,
  DROP COLUMN IF EXISTS isbn,
  DROP COLUMN IF EXISTS issn;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'notices_reserve_source_notice_id_key') THEN
    ALTER TABLE notices_reserve ADD CONSTRAINT notices_reserve_source_notice_id_key UNIQUE (source_notice_id);
  END IF;
END $$;

ALTER TABLE exemplaires_reserve
  DROP COLUMN IF EXISTS source,
  DROP COLUMN IF EXISTS etat_code,
  DROP COLUMN IF EXISTS etat_libelle,
  DROP COLUMN IF EXISTS section_code,
  DROP COLUMN IF EXISTS section_libelle,
  DROP COLUMN IF EXISTS bibliotheque_code,
  DROP COLUMN IF EXISTS bibliotheque_libelle;

-- ── 3. Copie des données — colonnes explicites (210 sur notices, 39 sur
--      exemplaires hors les 22 GENERATED) des deux côtés, jamais `SELECT *`
--      ────────────────────────────────────────────────────────────────────
INSERT INTO notices_reserve (
  id, source_notice_id, leader, titre, editeur_nom, editeur_date, raw, created_at, updated_at,
  synced_at, "010$a", "010$b", "010$d", "010$z", "020$a", "020$b", "021$a", "021$b", "033$a", "035$5",
  "035$a", "035$z", "073$a", "100$a", "101$2", "101$a", "101$c", "102$a", "105$a", "106$a", "140$a",
  "141$a", "181$2", "181$6", "181$a", "181$b", "181$c", "182$2", "182$6", "182$a", "182$c", "183$2",
  "183$6", "183$a", "200$a", "200$b", "200$d", "200$e", "200$f", "200$g", "200$h", "200$i", "200$v",
  "205$a", "210$a", "210$b", "210$c", "210$d", "210$e", "210$f", "210$g", "210$h", "210$r", "210$s",
  "211$a", "214$a", "214$b", "214$c", "214$d", "214$r", "215$a", "215$c", "215$d", "215$e", "225$a",
  "225$e", "225$i", "225$v", "225$x", "300$a", "303$a", "305$a", "307$a", "310$a", "316$5", "316$a",
  "317$5", "317$a", "320$a", "321$a", "327$a", "330$2", "330$a", "345$a", "345$b", "410$3", "410$c",
  "410$d", "410$t", "410$v", "410$x", "454$t", "461$3", "461$t", "461$v", "464$a", "464$f", "464$t",
  "481$3", "481$t", "482$3", "482$5", "482$a", "482$b", "482$c", "482$t", "500$3", "500$a", "500$k",
  "500$m", "503$a", "503$j", "503$m", "503$n", "517$a", "600$2", "600$3", "600$a", "600$b", "600$c",
  "600$f", "600$x", "601$3", "601$a", "601$c", "601$x", "606$!", "606$2", "606$3", "606$a", "606$x",
  "606$y", "606$z", "607$2", "607$3", "607$a", "607$x", "607$z", "608$2", "608$3", "608$a", "620$3",
  "620$a", "620$d", "676$a", "676$v", "686$2", "686$a", "700$3", "700$4", "700$a", "700$b", "700$c",
  "700$f", "700$o", "701$3", "701$4", "701$a", "701$b", "701$c", "701$f", "701$o", "702$3", "702$4",
  "702$a", "702$b", "702$c", "702$d", "702$f", "702$o", "710$3", "710$4", "710$a", "710$c", "711$3",
  "711$4", "711$a", "712$3", "712$4", "712$a", "712$b", "712$c", "801$2", "801$a", "801$b", "801$c",
  "801$g", "801$h", "830$a", "856$u", "900$a", "901$a", "902$3", "902$a", "902$e", "917$a", "919$a",
  "940$a", "940$b", "940$s"
)
  SELECT
    id, source_notice_id, leader, titre, editeur_nom, editeur_date, raw, created_at, updated_at,
    synced_at, "010$a", "010$b", "010$d", "010$z", "020$a", "020$b", "021$a", "021$b", "033$a", "035$5",
    "035$a", "035$z", "073$a", "100$a", "101$2", "101$a", "101$c", "102$a", "105$a", "106$a", "140$a",
    "141$a", "181$2", "181$6", "181$a", "181$b", "181$c", "182$2", "182$6", "182$a", "182$c", "183$2",
    "183$6", "183$a", "200$a", "200$b", "200$d", "200$e", "200$f", "200$g", "200$h", "200$i", "200$v",
    "205$a", "210$a", "210$b", "210$c", "210$d", "210$e", "210$f", "210$g", "210$h", "210$r", "210$s",
    "211$a", "214$a", "214$b", "214$c", "214$d", "214$r", "215$a", "215$c", "215$d", "215$e", "225$a",
    "225$e", "225$i", "225$v", "225$x", "300$a", "303$a", "305$a", "307$a", "310$a", "316$5", "316$a",
    "317$5", "317$a", "320$a", "321$a", "327$a", "330$2", "330$a", "345$a", "345$b", "410$3", "410$c",
    "410$d", "410$t", "410$v", "410$x", "454$t", "461$3", "461$t", "461$v", "464$a", "464$f", "464$t",
    "481$3", "481$t", "482$3", "482$5", "482$a", "482$b", "482$c", "482$t", "500$3", "500$a", "500$k",
    "500$m", "503$a", "503$j", "503$m", "503$n", "517$a", "600$2", "600$3", "600$a", "600$b", "600$c",
    "600$f", "600$x", "601$3", "601$a", "601$c", "601$x", "606$!", "606$2", "606$3", "606$a", "606$x",
    "606$y", "606$z", "607$2", "607$3", "607$a", "607$x", "607$z", "608$2", "608$3", "608$a", "620$3",
    "620$a", "620$d", "676$a", "676$v", "686$2", "686$a", "700$3", "700$4", "700$a", "700$b", "700$c",
    "700$f", "700$o", "701$3", "701$4", "701$a", "701$b", "701$c", "701$f", "701$o", "702$3", "702$4",
    "702$a", "702$b", "702$c", "702$d", "702$f", "702$o", "710$3", "710$4", "710$a", "710$c", "711$3",
    "711$4", "711$a", "712$3", "712$4", "712$a", "712$b", "712$c", "801$2", "801$a", "801$b", "801$c",
    "801$g", "801$h", "830$a", "856$u", "900$a", "901$a", "902$3", "902$a", "902$e", "917$a", "919$a",
    "940$a", "940$b", "940$s"
  FROM notices WHERE source = 'reserve_marc'
  ON CONFLICT (source_notice_id) DO NOTHING;

INSERT INTO exemplaires_reserve (
  id, barcode, source_ref, type_document, notice_id, cote_1, cote_2, cote_3, cote_complete,
  piege_a_code, piege_b_code, piege_c_texte, piege_label, reliure_groupe_id, reserve_physique, raw,
  created_at, updated_at, synced_at, "202$a", "202$d", "316$a", "915$a", "915$b", "920$d", "920$e",
  "920$r", "920$s", "920$t", "920$u", "921$a", "921$b", "921$c", "930$b", "930$c", "930$d", "930$g",
  "930$h", "930$i"
)
  SELECT
    id, barcode, source_ref, type_document, notice_id, cote_1, cote_2, cote_3, cote_complete,
    piege_a_code, piege_b_code, piege_c_texte, piege_label, reliure_groupe_id, reserve_physique, raw,
    created_at, updated_at, synced_at, "202$a", "202$d", "316$a", "915$a", "915$b", "920$d", "920$e",
    "920$r", "920$s", "920$t", "920$u", "921$a", "921$b", "921$c", "930$b", "930$c", "930$d", "930$g",
    "930$h", "930$i"
  FROM exemplaires WHERE source = 'reserve_marc'
  ON CONFLICT (barcode) WHERE barcode IS NOT NULL DO NOTHING;

-- ── 4. Les lignes reserve_marc ne vivent plus que dans les tables ci-dessus
--      ────────────────────────────────────────────────────────────────────
DELETE FROM exemplaires WHERE source = 'reserve_marc';
DELETE FROM notices WHERE source = 'reserve_marc';

-- Resserre les CHECK pour qu'un futur script ne puisse plus, par erreur,
-- réinsérer du reserve_marc dans les tables partagées (noms de contrainte
-- vérifiés via pg_constraint, comme 0006_type_document_periodique.sql).
ALTER TABLE notices DROP CONSTRAINT IF EXISTS notices_source_check;
ALTER TABLE notices ADD CONSTRAINT notices_source_check
  CHECK (source IN ('bib_xml_minimal', 'excel_import'));

ALTER TABLE exemplaires DROP CONSTRAINT IF EXISTS exemplaires_source_check;
ALTER TABLE exemplaires ADD CONSTRAINT exemplaires_source_check
  CHECK (source IN ('bib_xml', 'excel_import'));

-- Stats à jour immédiatement (pas d'attente du prochain passage
-- d'autovacuum) : ANALYZE seul (pas VACUUM) fonctionne dans une transaction,
-- contrairement à VACUUM — nécessaire ici puisque db-apply-schema.mjs envoie
-- tout le fichier en une seule requête, donc une seule transaction implicite.
ANALYZE notices_reserve;
ANALYZE exemplaires_reserve;
