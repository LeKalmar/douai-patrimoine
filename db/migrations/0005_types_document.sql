-- 0005_types_document.sql — Référentiel des codes « Type de document » (920$t)
-- ────────────────────────────────────────────────────────────────────────────
-- Reflète scripts/lib/type-document-labels.mjs (TYPE_DOCUMENT_LABELS) — même
-- patron que la table `langues` de 0004_langues.sql pour 101$a : la table JS
-- reste la source utilisée à l'exécution (typeDocumentLabelOf(), appelée dans
-- scripts/lib/reserve-index.mjs et scripts/lib/export-inventaire.mjs pour
-- peupler le champ dérivé "_typeDocument" de data/inventaire.json), cette
-- table SQL n'est qu'un miroir consultable directement en base — la colonne
-- littérale exemplaires."920$t" (voir 0003_marc_literal_fields.sql) porte
-- déjà le code brut, sans jointure obligatoire vers cette table.
--
-- Ne pas confondre avec exemplaires.type_document (0001_init.sql) : cette
-- colonne-là est le point d'extension prévu pour les futurs imports Excel de
-- collections non cataloguées (imprime/manuscrit/carte/autre), sans rapport
-- avec le code Syracuse 920$t couvert ici.
--
-- Un code rencontré dans "920$t" mais absent d'ici reste visible tel quel
-- côté JS (jamais masqué, voir typeDocumentLabelOf()) — pas de contrainte de
-- clé étrangère depuis exemplaires."920$t" vers cette table.
--
-- Idempotent (CREATE TABLE IF NOT EXISTS, INSERT ... ON CONFLICT DO NOTHING),
-- comme 0001_init.sql/0002_livres_spolies.sql/0003_marc_literal_fields.sql/
-- 0004_langues.sql.

CREATE TABLE IF NOT EXISTS types_document (
  code     text NOT NULL PRIMARY KEY,
  libelle  text NOT NULL
);

INSERT INTO types_document (code, libelle) VALUES
  ('LIV',   'Livre'),
  ('REV',   'Revue'),
  ('LAN',   'Livre ancien'),
  ('DVF',   'DVD Fiction'),
  ('LCD',   'Livre CD'),
  ('LIVA',  'Livre Artiste'),
  ('CD',    'Disque compact'),
  ('VIN',   'Vinyles'),
  ('EXP',   'Outil d''animation'),
  ('LCA',   'Livre cassette'),
  ('LDV',   'Livre DVD'),
  ('DVD',   'DVD'),
  ('CAR',   'Carte'),
  ('PER',   'Périodique'),
  ('LCR',   'Livre CDROM'),
  ('VHS',   'Vidéo Fiction'),
  ('OBJ',   'Objets'),
  ('CDR',   'Cédérom'),
  ('JEU',   'Jeu de société'),
  ('DVD12', 'DVD - interdit au moins de 12 ans'),
  ('LIS',   'Liseuse')
ON CONFLICT (code) DO NOTHING;
