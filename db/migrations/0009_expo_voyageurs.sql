-- 0009_expo_voyageurs.sql — Exposition « Voyageurs douaisiens »
-- ────────────────────────────────────────────────────────────────────────────
-- Schéma dédié `expo_voyageurs`, volontairement séparé du schéma `public`
-- (catalogue, réserve, magasins…) : ces tables ne concernent que
-- l'exposition voyageurs.html et n'ont aucune jointure avec le reste. Un
-- schéma à part se sauvegarde, se vide ou se supprime d'un bloc
-- (`DROP SCHEMA expo_voyageurs CASCADE`) sans risque pour le catalogue.
--
-- Servi en JSON par scripts/lib/export-voyageurs.mjs sous
-- /data/voyageurs.json (forme attendue par js/voyageurs.js). Premier
-- remplissage : `npm run db:seed:voyageurs` (depuis data/voyageurs.json).
--
-- Les COMMENT ON … ci-dessous documentent chaque colonne directement dans la
-- base : ils s'affichent dans pgAdmin/DBeaver au moment de saisir les
-- données.
--
-- Idempotent (IF NOT EXISTS), comme les autres migrations : rejoué en entier
-- à chaque `npm run db:apply-schema`.
-- ────────────────────────────────────────────────────────────────────────────

CREATE SCHEMA IF NOT EXISTS expo_voyageurs;
COMMENT ON SCHEMA expo_voyageurs IS
  'Exposition « Voyageurs douaisiens » (voyageurs.html) — indépendant du catalogue.';

-- ── Voyageurs ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS expo_voyageurs.voyageurs (
  id          text PRIMARY KEY CHECK (id ~ '^[a-z0-9-]+$'),
  nom         text NOT NULL,
  vie         text,
  lien_douai  text,
  portrait    text,
  couleur     text NOT NULL DEFAULT '#B4213C' CHECK (couleur ~ '^#[0-9A-Fa-f]{6}$'),
  resume      text,
  ordre       integer NOT NULL DEFAULT 0,
  publie      boolean NOT NULL DEFAULT true,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE  expo_voyageurs.voyageurs IS 'Une ligne par personnage de l''exposition.';
COMMENT ON COLUMN expo_voyageurs.voyageurs.id IS 'Identifiant court, minuscules et tirets (ex. trigault) — apparaît dans l''URL.';
COMMENT ON COLUMN expo_voyageurs.voyageurs.vie IS 'Texte libre, ex. « Douai, 1577 — Hangzhou, 1628 ».';
COMMENT ON COLUMN expo_voyageurs.voyageurs.lien_douai IS 'Lien avec Douai, ex. « Né à Douai », « Séjourne à Douai en 1870 ».';
COMMENT ON COLUMN expo_voyageurs.voyageurs.portrait IS 'Chemin de l''image depuis la racine du site (ex. images/auteurs/Nicolas Trigault.jpg), ou NULL.';
COMMENT ON COLUMN expo_voyageurs.voyageurs.couleur IS 'Couleur du tracé, format #RRGGBB.';
COMMENT ON COLUMN expo_voyageurs.voyageurs.ordre IS 'Ordre d''affichage dans la liste (croissant).';
COMMENT ON COLUMN expo_voyageurs.voyageurs.publie IS 'false = brouillon de recherche, absent de la page publique.';

-- ── Écrits laissés par chaque voyageur ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS expo_voyageurs.ecrits (
  voyageur_id text NOT NULL REFERENCES expo_voyageurs.voyageurs(id) ON DELETE CASCADE ON UPDATE CASCADE,
  ordre       integer NOT NULL,
  titre       text NOT NULL,
  annee       text,
  cote        text,
  PRIMARY KEY (voyageur_id, ordre)
);
COMMENT ON TABLE  expo_voyageurs.ecrits IS 'Récits, lettres, ouvrages laissés par un voyageur.';
COMMENT ON COLUMN expo_voyageurs.ecrits.annee IS 'Texte libre (ex. 1615, 1880-1891).';
COMMENT ON COLUMN expo_voyageurs.ecrits.cote IS 'Cote dans les collections de Douai, si l''ouvrage y est conservé (lien futur vers l''inventaire).';

-- ── Voyages ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS expo_voyageurs.voyages (
  id          text PRIMARY KEY CHECK (id ~ '^[a-z0-9-]+$'),
  voyageur_id text NOT NULL REFERENCES expo_voyageurs.voyageurs(id) ON DELETE CASCADE ON UPDATE CASCADE,
  titre       text NOT NULL,
  sous_titre  text,
  ordre       integer NOT NULL DEFAULT 0,
  publie      boolean NOT NULL DEFAULT true,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS voyages_voyageur_idx ON expo_voyageurs.voyages (voyageur_id, ordre);
COMMENT ON TABLE  expo_voyageurs.voyages IS 'Un voyage (tracé animable) d''un voyageur ; un voyageur peut en avoir plusieurs.';
COMMENT ON COLUMN expo_voyageurs.voyages.id IS 'Identifiant court (ex. trigault-1618) — sert d''ancre dans l''URL : voyageurs.html#trigault-1618.';
COMMENT ON COLUMN expo_voyageurs.voyages.sous_titre IS 'Ex. « Lisbonne → Goa → Macao, 1618-1619 ».';

-- ── Étapes d'un voyage (points du tracé) ───────────────────────────────────
CREATE TABLE IF NOT EXISTS expo_voyageurs.etapes (
  voyage_id      text NOT NULL REFERENCES expo_voyageurs.voyages(id) ON DELETE CASCADE ON UPDATE CASCADE,
  ordre          integer NOT NULL,
  lieu           text,
  lng            double precision NOT NULL CHECK (lng BETWEEN -180 AND 180),
  lat            double precision NOT NULL CHECK (lat BETWEEN -90 AND 90),
  date_arrivee   text CHECK (date_arrivee ~ '^\d{4}(-\d{2}(-\d{2})?)?$'),
  date_depart    text CHECK (date_depart  ~ '^\d{4}(-\d{2}(-\d{2})?)?$'),
  date_approx    boolean NOT NULL DEFAULT false,
  mode           text CHECK (mode IN ('bateau', 'pied', 'attelage', 'civiere')),
  arret_titre    text,
  arret_texte    text,
  arret_citation text,
  arret_source   text,
  PRIMARY KEY (voyage_id, ordre),
  CHECK (date_depart IS NULL OR date_arrivee IS NOT NULL),
  CHECK (arret_titre IS NOT NULL OR (arret_texte IS NULL AND arret_citation IS NULL AND arret_source IS NULL))
);
COMMENT ON TABLE  expo_voyageurs.etapes IS
  'Points successifs du tracé. Sans arret_titre, un point n''est qu''un point de passage (faire passer le tracé par la mer). '
  'Entre deux points, le tracé suit le plus court chemin sur le globe.';
COMMENT ON COLUMN expo_voyageurs.etapes.ordre IS 'Position dans le voyage (croissant). Laisser des trous (10, 20, 30…) facilite les insertions.';
COMMENT ON COLUMN expo_voyageurs.etapes.lng IS 'Longitude en degrés décimaux (négative à l''ouest de Greenwich).';
COMMENT ON COLUMN expo_voyageurs.etapes.lat IS 'Latitude en degrés décimaux (négative au sud de l''équateur).';
COMMENT ON COLUMN expo_voyageurs.etapes.date_arrivee IS
  'AAAA, AAAA-MM ou AAAA-MM-JJ. Facultatif : un point sans date reçoit une date estimée d''après la distance (affichée « ≈ »). '
  'Au moins une étape du voyage doit être datée.';
COMMENT ON COLUMN expo_voyageurs.etapes.date_depart IS 'Si le voyageur séjourne sur place : date de départ (le compteur de jours avance pendant la halte).';
COMMENT ON COLUMN expo_voyageurs.etapes.date_approx IS 'true si la date est une estimation (affichée précédée de « ≈ »).';
COMMENT ON COLUMN expo_voyageurs.etapes.mode IS
  'Moyen de transport du tronçon QUI PART de ce point : bateau, pied, attelage, civiere. NULL = inchangé depuis l''étape précédente.';
COMMENT ON COLUMN expo_voyageurs.etapes.arret_titre IS 'Renseigné = arrêt raconté : la lecture s''y met en pause et affiche le récit.';
COMMENT ON COLUMN expo_voyageurs.etapes.arret_citation IS 'Extrait du récit de voyage, cité tel quel.';
COMMENT ON COLUMN expo_voyageurs.etapes.arret_source IS 'Référence de la citation ou de l''information (ouvrage, page, cote).';

-- ── Sources d'un voyage ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS expo_voyageurs.sources (
  voyage_id  text NOT NULL REFERENCES expo_voyageurs.voyages(id) ON DELETE CASCADE ON UPDATE CASCADE,
  ordre      integer NOT NULL,
  reference  text NOT NULL,
  PRIMARY KEY (voyage_id, ordre)
);
COMMENT ON TABLE expo_voyageurs.sources IS 'Bibliographie d''un voyage, affichée sous la liste des étapes.';
