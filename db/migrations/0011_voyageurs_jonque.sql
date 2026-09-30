-- 0011_voyageurs_jonque.sql — Moyen de transport « jonque » (exposition « Voyageurs douaisiens »)
-- ────────────────────────────────────────────────────────────────────────────
-- Ajoute 'jonque' aux valeurs permises de expo_voyageurs.etapes.mode. Côté
-- page (js/voyageurs.js) : icône images/voyageurs/transports/jonque.svg,
-- zoom automatique 7 (MODE_ZOOM) et lecture deux fois plus lente qu'en
-- bateau (MODE_PACE).
--
-- La contrainte d'origine (0009, CHECK en ligne, nommée etapes_mode_check
-- par Postgres) est remplacée plutôt que modifiée : Postgres ne permet pas
-- d'éditer un CHECK. Idempotent (DROP … IF EXISTS puis ADD).
-- ────────────────────────────────────────────────────────────────────────────

ALTER TABLE expo_voyageurs.etapes DROP CONSTRAINT IF EXISTS etapes_mode_check;
ALTER TABLE expo_voyageurs.etapes ADD CONSTRAINT etapes_mode_check
  CHECK (mode IN ('bateau', 'jonque', 'pied', 'attelage', 'civiere'));

COMMENT ON COLUMN expo_voyageurs.etapes.mode IS
  'Moyen de transport du tronçon QUI PART de ce point : bateau, jonque, pied, attelage, civiere. NULL = inchangé depuis l''étape précédente.';
