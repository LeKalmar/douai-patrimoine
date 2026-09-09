-- 0001_init.sql — Base "inventaire des collections"
-- ────────────────────────────────────────────────────────────────────────────
-- Schéma initial : notices/exemplaires de la réserve patrimoniale (MARC-XML,
-- data/xml/notices.xml + exemplaires.xml) et de xml/bib.xml (export complet
-- de la bibliothèque, format GESMARC), dédoublonnés par code-barre. Voir
-- CLAUDE.md et le plan de migration pour le détail des sources.
--
-- Idempotent : chaque instruction peut être rejouée sans erreur
-- (CREATE TABLE IF NOT EXISTS, INSERT ... ON CONFLICT DO NOTHING pour le
-- référentiel `pieges`). Appliqué par scripts/db-apply-schema.mjs (pas de
-- dépendance au binaire psql, absent de certains environnements de dev).
-- ────────────────────────────────────────────────────────────────────────────

-- ── Référentiel des codes "Piège" Syracuse (MARC 921$a/921$b) ──────────────
-- Reflète scripts/lib/piege-labels.mjs (PIEGE_A_LABELS/PIEGE_B_LABELS), lui
-- même la même table que "Piège 921$a (Code)"/"Piège 921$b (Code)" de
-- xml/bib.xml. Un code rencontré en migration mais absent d'ici reste visible
-- dans exemplaires.piege_a_code/piege_b_code (jamais masqué) — juste sans
-- colonne booléenne dédiée tant qu'il n'a pas été ajouté ici.
CREATE TABLE IF NOT EXISTS pieges (
  code_type  char(1) NOT NULL CHECK (code_type IN ('a', 'b')),
  code       text    NOT NULL,
  libelle    text    NOT NULL,
  PRIMARY KEY (code_type, code)
);

INSERT INTO pieges (code_type, code, libelle) VALUES
  ('a', '1',    'Exclu du prêt temporairement'),
  ('a', '2',    'Exclu DEFINITIVEMENT du prêt'),
  ('a', '3',    'Magasin'),
  ('a', '4',    'Non réservable'),
  ('b', '2',    'en réserve'),
  ('b', '3',    'perdu'),
  ('b', '4',    'pilon'),
  ('b', '7',    'Equipement'),
  ('b', '8',    'Réserve Patrimoniale'),
  ('b', '9',    'Voir banque de prêt'),
  ('b', '10',   'Réserve Saint Exupery'),
  ('b', 'BRAD', 'Braderie'),
  ('b', 'CSP',  'Consultation sur place'),
  ('b', 'EXC',  'Exclu de la recherche portail'),
  ('b', 'MAG',  'En magasin'),
  ('b', 'PAD',  'Prêt à Domicile'),
  ('b', 'PER',  'Perdu'),
  ('b', 'PIL',  'Pilon'),
  ('b', 'QUAR', 'Quarantaine'),
  ('b', 'RAP',  '3 rappels envoyés'),
  ('b', 'REP',  'En réparation'),
  ('b', 'TRA',  'En traitement')
ON CONFLICT (code_type, code) DO NOTHING;

-- ── Notices bibliographiques ────────────────────────────────────────────────
-- Une ligne par notice. Pour un exemplaire bib.xml sans vraie notice MARC
-- (GESMARC dénormalise titre/auteur sur l'exemplaire), une notice minimale
-- 1:1 est créée (source = 'bib_xml_minimal', source_notice_id = code-barre)
-- pour que exemplaires.notice_id reste toujours NOT NULL et que toute requête
-- puisse joindre de la même façon quelle que soit la provenance.
CREATE TABLE IF NOT EXISTS notices (
  id                 bigserial PRIMARY KEY,
  source             text NOT NULL CHECK (source IN ('reserve_marc', 'bib_xml_minimal', 'excel_import')),
  source_notice_id   text NOT NULL,
  leader             text,             -- reserve_marc uniquement (leader MARC)
  titre              text,             -- 200$a / "Titre"
  titre_complement   text,             -- 200$e
  editeur_nom        text,             -- 210$c / "Editeur"
  editeur_lieu       text,             -- 210$a (reserve_marc uniquement — absent de bib.xml)
  editeur_date       text,             -- 210$d / "Publié le" (nullable — absent de bib.xml pour l'instant)
  collation_desc     text,             -- 215$a (reserve_marc uniquement) — nommé "_desc" : "collation" est un mot réservé Postgres
  dimensions         text,             -- 215$d (reserve_marc uniquement)
  langue             text,             -- 101$a
  pays               text,             -- 102$a
  isbn               text,
  issn               text,
  notes              text,             -- 300$a
  auteur_principal   text,             -- bib_xml_minimal SEULEMENT (texte plat "Auteur", non structuré) ;
                                        -- pour reserve_marc, voir notice_contributeurs.
  raw                jsonb NOT NULL DEFAULT '{}'::jsonb,
                                        -- flatten() complet de la notice MARC, sans whitelist (capture tout,
                                        -- au-delà des tags que garde data/inventaire.json aujourd'hui).
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  synced_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source, source_notice_id)
);
CREATE INDEX IF NOT EXISTS idx_notices_titre ON notices (titre);

-- ── Contributeurs (auteurs, MARC 700/701/702) ───────────────────────────────
-- Champs répétables aujourd'hui joints par '§' dans data/inventaire.json —
-- ici une vraie table de jonction, pour permettre de vraies requêtes
-- ("tous les documents d'un même auteur").
CREATE TABLE IF NOT EXISTS contributeurs (
  id           bigserial PRIMARY KEY,
  syracuse_id  text UNIQUE,       -- 700$3/701$3/702$3 ("ARCHI...") — absent une bonne partie du temps
  nom          text,
  prenom       text,
  dates        text,              -- $f, ex. "1958-...."
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_contributeurs_nom ON contributeurs (nom);
-- Un contributeur sans syracuse_id (~23% des cas, 700$3/701$3/702$3 absent)
-- n'a pas d'autre identifiant naturel que (nom, prenom, dates) — le script de
-- migration y stocke '' plutôt que NULL pour ces trois colonnes dans ce cas
-- précis (NULL <> NULL empêcherait tout ON CONFLICT de dédoublonner), pour
-- qu'un réimport après nouvel export Syracuse retombe sur la même ligne au
-- lieu d'en créer une nouvelle à chaque fois.
CREATE UNIQUE INDEX IF NOT EXISTS uq_contributeurs_natural ON contributeurs (nom, prenom, dates) WHERE syracuse_id IS NULL;

CREATE TABLE IF NOT EXISTS notice_contributeurs (
  notice_id        bigint   NOT NULL REFERENCES notices(id) ON DELETE CASCADE,
  role_tag         smallint NOT NULL CHECK (role_tag IN (700, 701, 702)),
  rang             smallint NOT NULL,   -- position dans la séquence répétable ('§'), ordre MARC préservé
  contributeur_id  bigint   NOT NULL REFERENCES contributeurs(id),
  fonction_code    text,    -- $4, ex. "651"
  qualif           text,    -- $c
  PRIMARY KEY (notice_id, role_tag, rang)
);
CREATE INDEX IF NOT EXISTS idx_notice_contributeurs_contributeur ON notice_contributeurs (contributeur_id);

-- ── Groupes de reliure (MARC $481/$482) ─────────────────────────────────────
-- Remplace le tableau `_relies` dénormalisé de data/inventaire.json.
-- group_key = sha256 des codes-barres du groupe triés, calculé côté script
-- (node:crypto) — stable d'un run à l'autre malgré l'id bigserial, pour
-- qu'un réimport après nouvel export Syracuse retombe sur le même groupe.
CREATE TABLE IF NOT EXISTS reliure_groupes (
  id         bigserial PRIMARY KEY,
  group_key  text UNIQUE NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ── Exemplaires ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS exemplaires (
  id             bigserial PRIMARY KEY,
  barcode        text,        -- NULL toléré (futurs imports Excel sans code-barre)
  source         text NOT NULL CHECK (source IN ('reserve_marc', 'bib_xml', 'excel_import')),
  source_ref     text,        -- clé naturelle alternative quand barcode est NULL (futurs imports)
  type_document  text NOT NULL DEFAULT 'imprime'
                   CHECK (type_document IN ('imprime', 'manuscrit', 'carte', 'autre')),
  notice_id      bigint NOT NULL REFERENCES notices(id),

  cote_1         text,        -- 930$g / "Cote n° 1"
  cote_2         text,        -- 930$h / "Cote n° 2"
  cote_3         text,        -- 930$i / "Cote n° 3"
  cote_complete  text,        -- cote_1/2/3 joints par un espace, calculé côté script à l'insertion

  piege_a_code   text,        -- 921$a brut / "Piège 921$a (Code)"
  piege_b_code   text,        -- 921$b brut / "Piège 921$b (Code)"
  piege_c_texte  text,        -- 921$c libre (rare, jamais perdu)
  piege_label    text,        -- libellé prêt à afficher (piegeLabelOf() pour reserve_marc,
                               -- champ "Pièges" déjà concaténé repris tel quel pour bib_xml)

  -- Une colonne par code CONNU de la table `pieges` ci-dessus. Nommage par
  -- CODE, jamais par libellé : deux codes distincts peuvent partager un sens
  -- proche (piege_b_code='3' et piege_b_code='PER' valent tous deux "perdu")
  -- et ne doivent jamais être fusionnés. GENERATED : ne jamais les lister
  -- dans un INSERT/UPDATE, Postgres les recalcule seul depuis
  -- piege_a_code/piege_b_code.
  piege_a_1_exclu_temp            boolean GENERATED ALWAYS AS (piege_a_code = '1')    STORED,
  piege_a_2_exclu_def             boolean GENERATED ALWAYS AS (piege_a_code = '2')    STORED,
  piege_a_3_magasin               boolean GENERATED ALWAYS AS (piege_a_code = '3')    STORED,
  piege_a_4_non_reservable        boolean GENERATED ALWAYS AS (piege_a_code = '4')    STORED,
  piege_b_2_en_reserve            boolean GENERATED ALWAYS AS (piege_b_code = '2')    STORED,
  piege_b_3_perdu                 boolean GENERATED ALWAYS AS (piege_b_code = '3')    STORED,
  piege_b_4_pilon                 boolean GENERATED ALWAYS AS (piege_b_code = '4')    STORED,
  piege_b_7_equipement            boolean GENERATED ALWAYS AS (piege_b_code = '7')    STORED,
  piege_b_8_reserve_patrimoniale  boolean GENERATED ALWAYS AS (piege_b_code = '8')    STORED,
  piege_b_9_voir_pret             boolean GENERATED ALWAYS AS (piege_b_code = '9')    STORED,
  piege_b_10_reserve_st_exupery   boolean GENERATED ALWAYS AS (piege_b_code = '10')   STORED,
  piege_b_brad_braderie           boolean GENERATED ALWAYS AS (piege_b_code = 'BRAD') STORED,
  piege_b_csp_consult_sur_place   boolean GENERATED ALWAYS AS (piege_b_code = 'CSP')  STORED,
  piege_b_exc_hors_recherche      boolean GENERATED ALWAYS AS (piege_b_code = 'EXC')  STORED,
  piege_b_mag_en_magasin          boolean GENERATED ALWAYS AS (piege_b_code = 'MAG')  STORED,
  piege_b_pad_pret_domicile       boolean GENERATED ALWAYS AS (piege_b_code = 'PAD')  STORED,
  piege_b_per_perdu               boolean GENERATED ALWAYS AS (piege_b_code = 'PER')  STORED,
  piege_b_pil_pilon               boolean GENERATED ALWAYS AS (piege_b_code = 'PIL')  STORED,
  piege_b_quar_quarantaine        boolean GENERATED ALWAYS AS (piege_b_code = 'QUAR') STORED,
  piege_b_rap_rappels             boolean GENERATED ALWAYS AS (piege_b_code = 'RAP')  STORED,
  piege_b_rep_reparation          boolean GENERATED ALWAYS AS (piege_b_code = 'REP')  STORED,
  piege_b_tra_en_traitement       boolean GENERATED ALWAYS AS (piege_b_code = 'TRA')  STORED,

  reliure_groupe_id    bigint REFERENCES reliure_groupes(id),

  reserve_physique     text CHECK (reserve_physique IN ('patrimoniale', 'douaisienne')), -- reserve_marc uniquement
  date_entree          text,   -- 920$d (reserve_marc)

  etat_code            text,   -- "Etat (Code)" (bib_xml)
  etat_libelle         text,   -- "Etat (Libellé)" (bib_xml)
  section_code         text,   -- "Section (Code)" (bib_xml)
  section_libelle      text,   -- "Section (Libellé)" (bib_xml, ~70 valeurs)
  bibliotheque_code    text,   -- "Bibliothèque (Code)" (bib_xml)
  bibliotheque_libelle text,   -- "Bibliothèque (Libellé)" (bib_xml)

  raw                  jsonb NOT NULL DEFAULT '{}'::jsonb, -- flatten()/parseGesmarcItem() complet, sans whitelist

  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  synced_at            timestamptz NOT NULL DEFAULT now()
);

-- lien_num (URL vignette), _isMagasin, _fondsLabel, _coteDigitRun : dérivés,
-- volontairement PAS stockés — recalculés à l'export JSON / dans l'API,
-- même logique que la colonne dérivée `lien_num` du format columnar existant
-- (js/columnar.js).

CREATE UNIQUE INDEX IF NOT EXISTS uq_exemplaires_barcode    ON exemplaires (barcode)            WHERE barcode IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_exemplaires_source_ref ON exemplaires (source, source_ref) WHERE source_ref IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_exemplaires_notice           ON exemplaires (notice_id);
CREATE INDEX IF NOT EXISTS idx_exemplaires_source           ON exemplaires (source);
CREATE INDEX IF NOT EXISTS idx_exemplaires_cote1            ON exemplaires (cote_1);
CREATE INDEX IF NOT EXISTS idx_exemplaires_reliure_groupe   ON exemplaires (reliure_groupe_id);
CREATE INDEX IF NOT EXISTS idx_exemplaires_pil       ON exemplaires (piege_b_pil_pilon)     WHERE piege_b_pil_pilon;
CREATE INDEX IF NOT EXISTS idx_exemplaires_brad      ON exemplaires (piege_b_brad_braderie) WHERE piege_b_brad_braderie;
CREATE INDEX IF NOT EXISTS idx_exemplaires_exclu_def ON exemplaires (piege_a_2_exclu_def)   WHERE piege_a_2_exclu_def;
