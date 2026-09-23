-- 0006_type_document_periodique.sql — Ajoute 'periodique' au CHECK de
-- exemplaires.type_document
-- ────────────────────────────────────────────────────────────────────────────
-- exemplaires.type_document (0001_init.sql) est le point d'extension prévu
-- pour les imports Excel de collections non cataloguées — jusqu'ici
-- ('imprime', 'manuscrit', 'carte', 'autre'). Le fonds Périodiques (voir
-- scripts/db-migrate-fonds-periodiques.mjs, csv/periodiques.csv) est un
-- registre au niveau TITRE (périodicité, dates de première/dernière
-- parution, imprimeur…), assez distinct des trois catégories existantes
-- pour mériter la sienne plutôt que retomber dans 'autre'.
--
-- Idempotent : DROP CONSTRAINT IF EXISTS puis ADD CONSTRAINT à l'identique,
-- rejouable sans erreur (même patron que les autres migrations du dossier).
-- Nom de contrainte vérifié via pg_constraint (auto-généré par Postgres,
-- jamais nommé explicitement dans 0001_init.sql).

ALTER TABLE exemplaires DROP CONSTRAINT IF EXISTS exemplaires_type_document_check;
ALTER TABLE exemplaires ADD CONSTRAINT exemplaires_type_document_check
  CHECK (type_document IN ('imprime', 'manuscrit', 'carte', 'periodique', 'autre'));
