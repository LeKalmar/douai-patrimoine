-- 0004_langues.sql — Référentiel des codes de langue UNIMARC (101$a)
-- ────────────────────────────────────────────────────────────────────────────
-- Reflète scripts/lib/langue-labels.mjs (LANGUE_LABELS) — même patron que la
-- table `pieges` de 0001_init.sql pour les codes 921$a/921$b : la table JS
-- reste la source utilisée à l'exécution (langueLabelOf(), appelée dans
-- scripts/lib/reserve-index.mjs et scripts/lib/export-inventaire.mjs pour
-- peupler le champ dérivé "_langue" de data/inventaire.json), cette table SQL
-- n'est qu'un miroir consultable directement en base. Un code rencontré dans
-- "101$a" mais absent d'ici reste visible tel quel côté JS (jamais masqué,
-- voir langueLabelOf()) — pas de contrainte de clé étrangère depuis
-- notices."101$a" vers cette table.
--
-- Idempotent (CREATE TABLE IF NOT EXISTS, INSERT ... ON CONFLICT DO NOTHING),
-- comme 0001_init.sql/0002_livres_spolies.sql/0003_marc_literal_fields.sql.

CREATE TABLE IF NOT EXISTS langues (
  code     text NOT NULL PRIMARY KEY,
  libelle  text NOT NULL
);

INSERT INTO langues (code, libelle) VALUES
  ('fre',     'Français'),
  ('fro',     'Ancien français (842-ca. 1400)'),
  ('frm',     'Moyen français (ca. 1400-1600)'),
  ('lat',     'Latin'),
  ('grc',     'Grec ancien (jusqu''à 1453)'),
  ('gre',     'Grec moderne (après 1453)'),
  ('eng',     'Anglais'),
  ('ang',     'Vieil anglais (ca. 450-1100)'),
  ('enm',     'Moyen anglais (1100-1500)'),
  ('ger',     'Allemand'),
  ('gmh',     'Moyen haut-allemand (ca. 1050-1500)'),
  ('dut',     'Néerlandais'),
  ('dum',     'Moyen néerlandais (ca. 1050-1350)'),
  ('ita',     'Italien'),
  ('spa',     'Espagnol'),
  ('por',     'Portugais'),
  ('cze',     'Tchèque'),
  ('pol',     'Polonais'),
  ('slo',     'Slovaque'),
  ('hun',     'Hongrois'),
  ('hrv',     'Croate'),
  ('nor',     'Norvégien'),
  ('dan',     'Danois'),
  ('rus',     'Russe'),
  ('kor',     'Coréen'),
  ('chi',     'Chinois'),
  ('jpn',     'Japonais'),
  ('ara',     'Arabe'),
  ('arc',     'Araméen'),
  ('sam',     'Araméen samaritain'),
  ('syr',     'Syriaque'),
  ('heb',     'Hébreu'),
  ('per',     'Persan'),
  ('arm',     'Arménien'),
  ('ben',     'Bengali'),
  ('wln',     'Wallon'),
  ('kab',     'Kabyle'),
  ('oci',     'Occitan (après 1500)'),
  ('roa',     'Langues romanes (autres)'),
  ('mul',     'Plusieurs langues'),
  ('mis',     'Langue non codée'),
  ('und',     'Indéterminée'),
  ('xxx',     'Indéterminée'),
  ('inconnu', 'Indéterminée')
ON CONFLICT (code) DO NOTHING;
