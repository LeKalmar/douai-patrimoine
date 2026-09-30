-- 0012_voyageurs_inconnu.sql — Moyen de transport « inconnu » (exposition « Voyageurs douaisiens »)
-- ────────────────────────────────────────────────────────────────────────────
-- Ajoute 'inconnu' aux valeurs permises de expo_voyageurs.etapes.mode, pour
-- un tronçon dont les sources ne disent pas comment le voyageur s'est
-- déplacé. Côté page (js/voyageurs.js) : icône d'oiseau en « V »
-- (images/voyageurs/transports/inconnu.svg), zoom automatique 4, lecture à
-- vitesse normale.
--
-- Même remplacement de contrainte que 0011 (Postgres ne permet pas d'éditer
-- un CHECK). Idempotent.
-- ────────────────────────────────────────────────────────────────────────────

ALTER TABLE expo_voyageurs.etapes DROP CONSTRAINT IF EXISTS etapes_mode_check;
ALTER TABLE expo_voyageurs.etapes ADD CONSTRAINT etapes_mode_check
  CHECK (mode IN ('bateau', 'jonque', 'pied', 'attelage', 'civiere', 'inconnu'));

COMMENT ON COLUMN expo_voyageurs.etapes.mode IS
  'Moyen de transport du tronçon QUI PART de ce point : bateau, jonque, pied, attelage, civiere, inconnu. NULL = inchangé depuis l''étape précédente.';
