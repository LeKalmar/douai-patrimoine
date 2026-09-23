-- 0008_reserve_non_catalogues.sql — Déplace les pièces non cataloguées
-- (Manuscrits/Robaut/Objets, csv/inventaire.csv, source='excel_import',
-- source_ref LIKE 'csv-row-%') vers notices_reserve/exemplaires_reserve
-- ────────────────────────────────────────────────────────────────────────────
-- Suite de 0007_split_reserve_tables.sql (même raisonnement : ~10 090 lignes
-- mêlées physiquement aux ~285 000 lignes bib_xml dans les tables partagées).
-- Demande explicite de l'équipe (2026-09-23) : ces ~10 090 pièces, bien que
-- "créées artificiellement" en forme UNIMARC depuis un CSV plutôt qu'issues
-- d'un vrai export Syracuse, doivent vivre dans les mêmes tables compactes
-- que la réserve reserve_marc plutôt que dans les tables partagées de 300 000
-- lignes — même bénéfice de localité physique que 0007, et surtout : un seul
-- endroit à lire pour scripts/lib/export-inventaire.mjs au lieu de deux
-- fetches séparés côté page (voir js/inventaire-page.js).
--
-- IMPORTANT — ne PAS confondre avec les fonds Cartes (source_ref LIKE
-- 'fonds-car-%') et Périodiques (source_ref LIKE 'fonds-periodiques%') : ces
-- deux-là RESTENT dans les tables partagées (notices/exemplaires) — non
-- demandés par l'équipe, volume négligeable (425 + 182 lignes) au regard du
-- problème de fond (la réserve et les pièces non cataloguées, ~25 700
-- lignes à elles deux, sont le vrai contenu de "l'inventaire public" au sens
-- où l'entend inventaire.html).
--
-- Distinction reserve_marc / non-catalogues DANS exemplaires_reserve, une
-- fois mélangées : par construction, exclusive et déjà fiable sans nouvelle
-- colonne — barcode toujours NON NULL pour reserve_marc (995$f), toujours
-- NULL pour les non-catalogues (jamais eu de code-barre, voir CLAUDE.md) ;
-- source_ref c'est l'inverse (NULL pour reserve_marc, "csv-row-N" pour les
-- non-catalogues). scripts/lib/export-inventaire.mjs s'appuie là-dessus.
--
-- `exemplaires_reserve.raw`, pour ces lignes, n'est PAS un flatten() MARC
-- comme pour reserve_marc : c'est déjà la forme finale exacte du
-- enregistrement (voir db-migrate-non-catalogues.mjs / l'ancien
-- scripts/lib/export-non-catalogues.mjs) — aucune notice à joindre pour la
-- reconstruire, exportInventaire() la relit telle quelle.
--
-- `notices_reserve` gagne une ligne minimale par pièce (barcode NULL sur
-- exemplaires_reserve exige quand même `notice_id NOT NULL`) mais son
-- contenu n'est jamais relu (même situation qu'avant cette migration) —
-- pas de titre/raw MARC dessus, juste ce qu'il faut pour satisfaire la FK.
--
-- Même remarque d'idempotence que 0007 : la contrainte UNIQUE(source_ref)
-- ajoutée ci-dessous a été perdue quand `source` a été retiré de
-- exemplaires_reserve dans 0007 (l'ancien index uq_exemplaires_source_ref
-- portait sur (source, source_ref), recopié par LIKE puis supprimé avec la
-- colonne `source`) — nécessaire pour un ON CONFLICT (source_ref) idempotent.
-- ────────────────────────────────────────────────────────────────────────────

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'exemplaires_reserve_source_ref_key') THEN
    ALTER TABLE exemplaires_reserve ADD CONSTRAINT exemplaires_reserve_source_ref_key
      UNIQUE (source_ref);
  END IF;
END $$;

-- ── Copie des données (colonnes explicites, même raison qu'en 0007 :
--    idempotence à travers les DROP COLUMN plus bas, et exemplaires a des
--    colonnes GENERATED qui refusent toute valeur explicite) ───────────────
INSERT INTO notices_reserve (id, source_notice_id, titre, raw, created_at, updated_at, synced_at)
  SELECT id, source_notice_id, titre, raw, created_at, updated_at, synced_at
  FROM notices WHERE source = 'excel_import' AND source_notice_id LIKE 'csv-row-%'
  ON CONFLICT (source_notice_id) DO NOTHING;

INSERT INTO exemplaires_reserve (
  id, barcode, source_ref, type_document, notice_id, cote_1, cote_2, cote_3, cote_complete,
  piege_a_code, piege_b_code, piege_c_texte, piege_label, reliure_groupe_id, reserve_physique, raw,
  created_at, updated_at, synced_at
)
  SELECT
    id, barcode, source_ref, type_document, notice_id, cote_1, cote_2, cote_3, cote_complete,
    piege_a_code, piege_b_code, piege_c_texte, piege_label, reliure_groupe_id, reserve_physique, raw,
    created_at, updated_at, synced_at
  FROM exemplaires WHERE source = 'excel_import' AND source_ref LIKE 'csv-row-%'
  ON CONFLICT (source_ref) DO NOTHING;

-- ── Les lignes non-catalogues ne vivent plus que dans les tables ci-dessus
--    ─────────────────────────────────────────────────────────────────────
DELETE FROM exemplaires WHERE source = 'excel_import' AND source_ref LIKE 'csv-row-%';
DELETE FROM notices WHERE source = 'excel_import' AND source_notice_id LIKE 'csv-row-%';

ANALYZE notices_reserve;
ANALYZE exemplaires_reserve;
