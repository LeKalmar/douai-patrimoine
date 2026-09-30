-- 0010_voyageurs_zoom.sql — Zoom forcé par étape (exposition « Voyageurs douaisiens »)
-- ────────────────────────────────────────────────────────────────────────────
-- Par défaut, js/voyageurs.js règle le zoom de la caméra d'après le moyen de
-- transport (MODE_ZOOM). Certaines étapes se déroulent dans un espace trop
-- restreint pour ce zoom automatique (quelques rues, un port) : `zoom` permet
-- de l'imposer. La caméra s'en approche progressivement quand le voyageur
-- arrive à l'étape et s'en éloigne quand il repart (voir cameraZoom() dans
-- js/voyageurs.js).
--
-- Plafond 13 : c'est le zoom maximal de la carte publique (MAX_ZOOM dans
-- js/voyageurs.js). La contrainte est posée à part, et non dans ADD COLUMN,
-- pour pouvoir la resserrer sur une base où la colonne existait déjà (elle
-- a d'abord été créée avec un plafond de 14).
--
-- Idempotent (IF NOT EXISTS / DROP … IF EXISTS), comme les autres migrations.
-- ────────────────────────────────────────────────────────────────────────────

ALTER TABLE expo_voyageurs.etapes ADD COLUMN IF NOT EXISTS zoom double precision;

ALTER TABLE expo_voyageurs.etapes DROP CONSTRAINT IF EXISTS etapes_zoom_check;
UPDATE expo_voyageurs.etapes SET zoom = 13 WHERE zoom > 13;
ALTER TABLE expo_voyageurs.etapes ADD CONSTRAINT etapes_zoom_check CHECK (zoom BETWEEN 1 AND 13);

COMMENT ON COLUMN expo_voyageurs.etapes.zoom IS
  'Niveau de zoom imposé à la caméra à cette étape (1 = globe entier, 13 = quelques rues ; '
  'OpenStreetMap remplace le fond vectoriel à partir de 10). NULL = automatique, d''après le moyen de transport.';
