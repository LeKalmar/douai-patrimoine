-- 0002_livres_spolies.sql — Registre des livres spoliés
-- ────────────────────────────────────────────────────────────────────────────
-- Remplace data/livres-spolies.json (506 lignes, converti une fois depuis un
-- .ods, jamais reconstruit par un script npm) + livres-spolies-overrides.json
-- (état partagé R2, 7 champs éditables via livres-spolies.html) : les deux
-- fusionnés en une seule table, les 7 champs "override" devenant de simples
-- colonnes éditables en place plutôt qu'un patch séparé appliqué à la volée.
-- `origine`/`date_entree`/`date_sortie` n'existent que côté overrides
-- aujourd'hui (absents du .ods d'origine) — colonnes nullables ici.
--
-- Idempotent (CREATE TABLE IF NOT EXISTS), comme 0001_init.sql.
-- ────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS livres_spolies (
  id           integer PRIMARY KEY,      -- id du .ods d'origine, stable
  caisse       text,
  cote_bm      text,
  type         text,
  volumes      text,
  auteur       text,
  titre        text,
  lieu         text,
  editeur      text,
  date         text,
  trouve       boolean NOT NULL DEFAULT false,
  ex_libris    boolean NOT NULL DEFAULT false,
  possesseur   text,
  origine      text,                     -- champ ajouté côté overrides, absent du .ods
  date_entree  text,                     -- idem
  date_sortie  text,                     -- idem
  updated_at   timestamptz NOT NULL DEFAULT now()
);
