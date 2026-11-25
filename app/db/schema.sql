-- NLPmanager PostgreSQL Schema
-- 11 Core Dictionary Tables + 6 Service Tables = 17 total

-- Migrations (idempotent — safe to re-run on every startup)
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='keywords' AND column_name='alias') THEN
    ALTER TABLE keywords RENAME COLUMN alias TO keywords;
  END IF;
END $$;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name='xwords_cells') AND
     NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='xwords_cells' AND column_name='flags') THEN
    ALTER TABLE xwords_cells ADD COLUMN flags TEXT;
  END IF;
END $$;

-- Ensure created_at / updated_at exist on all entity tables (adds them if an older
-- installation is missing them) and backfill any NULLs with the current timestamp.
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['curnames','exactliteral','celldictionary','casdictionary',
                            'chemnames','keywords','userdict','objectnames','combnames','rsmap'] LOOP
    -- Skip tables that don't exist yet (fresh install)
    IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = LOWER(t)) THEN
      CONTINUE;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_name = LOWER(t) AND column_name = 'created_at'
    ) THEN
      EXECUTE format('ALTER TABLE %I ADD COLUMN created_at TIMESTAMPTZ DEFAULT NOW()', t);
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_name = LOWER(t) AND column_name = 'updated_at'
    ) THEN
      EXECUTE format('ALTER TABLE %I ADD COLUMN updated_at TIMESTAMPTZ DEFAULT NOW()', t);
    END IF;
    EXECUTE format('UPDATE %I SET created_at = NOW() WHERE created_at IS NULL', t);
    EXECUTE format('UPDATE %I SET updated_at = NOW() WHERE updated_at IS NULL', t);
  END LOOP;
END $$;

-- Add bdeleted (soft-delete flag) to all entity tables if missing
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['curnames','exactliteral','celldictionary','casdictionary',
                            'chemnames','keywords','userdict','objectnames','combnames','rsmap'] LOOP
    IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = LOWER(t)) THEN
      CONTINUE;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_name = LOWER(t) AND column_name = 'bdeleted'
    ) THEN
      EXECUTE format('ALTER TABLE %I ADD COLUMN bdeleted BOOLEAN NOT NULL DEFAULT FALSE', t);
    END IF;
  END LOOP;
END $$;

-- Add curated flag to all dictionary alias tables (marks rows added/edited via the UI)
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['curnames','exactliteral','celldictionary','casdictionary',
                            'chemnames','keywords','userdict','combnames','rsmap'] LOOP
    IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = LOWER(t)) THEN
      CONTINUE;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_name = LOWER(t) AND column_name = 'curated'
    ) THEN
      EXECUTE format('ALTER TABLE %I ADD COLUMN curated BOOLEAN NOT NULL DEFAULT FALSE', t);
    END IF;
  END LOOP;
END $$;

-- Drop the cartridges column from spelling and bracketstop: these tables are global
-- (exported to every cartridge by default) and do not need per-cartridge filtering.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='spelling' AND column_name='cartridges') THEN
    ALTER TABLE spelling DROP COLUMN cartridges;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='bracketstop' AND column_name='cartridges') THEN
    ALTER TABLE bracketstop DROP COLUMN cartridges;
  END IF;
END $$;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='xwords' AND column_name='alias') THEN
    DROP TABLE xwords; CREATE TABLE xwords (id SERIAL PRIMARY KEY, xword TEXT NOT NULL, cartridges TEXT[] DEFAULT '{}');
    CREATE INDEX IF NOT EXISTS idx_xwords_xword ON xwords(xword);
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='xwords_cells' AND column_name='alias') THEN
    DROP TABLE xwords_cells; CREATE TABLE xwords_cells (id SERIAL PRIMARY KEY, xword TEXT NOT NULL, cartridges TEXT[] DEFAULT '{}');
    CREATE INDEX IF NOT EXISTS idx_xwordscells_xword ON xwords_cells(xword);
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='xwords_cas' AND column_name='alias') THEN
    DROP TABLE xwords_cas; CREATE TABLE xwords_cas (id SERIAL PRIMARY KEY, xword TEXT NOT NULL, cartridges TEXT[] DEFAULT '{}');
    CREATE INDEX IF NOT EXISTS idx_xwordscas_xword ON xwords_cas(xword);
  END IF;
END $$;

-- Remove tokenized duplicates from curnames and celldictionary (keep oldest row per group),
-- then enforce uniqueness so future inserts with ON CONFLICT DO NOTHING are safe.

-- -- Core Dictionary Tables --
-- All core tables share: MedscanID (PK), Alias, Match, Tokenized, Cartridges, Organisms

CREATE TABLE IF NOT EXISTS curNames (
    id          SERIAL PRIMARY KEY,
    medscan_id  BIGINT NOT NULL,
    alias       TEXT NOT NULL,
    match       TEXT,
    tokenized   TEXT,
    normalized  TEXT,
    cartridges  TEXT[] DEFAULT '{}',   -- which cartridge folders receive this row on export
    organisms   TEXT[] DEFAULT '{}',   -- which organism prefixes receive this row on export
    bdeleted    BOOLEAN NOT NULL DEFAULT FALSE,
    curated     BOOLEAN NOT NULL DEFAULT FALSE,   -- row added / edited through the UI
    created_at  TIMESTAMPTZ DEFAULT NOW(),
    updated_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_curnames_medscanid       ON curNames(medscan_id);
CREATE INDEX IF NOT EXISTS idx_curnames_tokenized       ON curNames(tokenized);
CREATE INDEX IF NOT EXISTS idx_curnames_tokenized_lower ON curNames(LOWER(tokenized));  -- for LOWER(tokenized)=LOWER($1)
CREATE INDEX IF NOT EXISTS idx_curnames_alias_lower     ON curNames(LOWER(alias));      -- for case-insensitive browse
-- Partial indexes over active rows — conflict detection and re-tokenization
CREATE INDEX IF NOT EXISTS idx_curnames_tok_active       ON curNames(tokenized)        WHERE (bdeleted IS NULL OR bdeleted = FALSE);
CREATE INDEX IF NOT EXISTS idx_curnames_tok_lower_active ON curNames(LOWER(tokenized)) WHERE (bdeleted IS NULL OR bdeleted = FALSE);

CREATE TABLE IF NOT EXISTS combNames (
    id          SERIAL PRIMARY KEY,
    medscan_id  BIGINT NOT NULL,
    alias       TEXT NOT NULL,
    match       TEXT,
    tokenized   TEXT,
    normalized  TEXT,
    cartridges  TEXT[] DEFAULT '{}',   -- CellEffect.bin only
    organisms   TEXT[] DEFAULT '{}',
    curated     BOOLEAN NOT NULL DEFAULT FALSE,
    bdeleted    BOOLEAN NOT NULL DEFAULT FALSE,
    created_at  TIMESTAMPTZ DEFAULT NOW(),
    updated_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_combnames_medscanid       ON combNames(medscan_id);
CREATE INDEX IF NOT EXISTS idx_combnames_tokenized       ON combNames(tokenized);
CREATE INDEX IF NOT EXISTS idx_combnames_tokenized_lower ON combNames(LOWER(tokenized));
CREATE INDEX IF NOT EXISTS idx_combnames_alias_lower     ON combNames(LOWER(alias));
CREATE INDEX IF NOT EXISTS idx_combnames_tok_active       ON combNames(tokenized)        WHERE (bdeleted IS NULL OR bdeleted = FALSE);
CREATE INDEX IF NOT EXISTS idx_combnames_tok_lower_active ON combNames(LOWER(tokenized)) WHERE (bdeleted IS NULL OR bdeleted = FALSE);

CREATE TABLE IF NOT EXISTS ExactLiteral (
    id          SERIAL PRIMARY KEY,
    medscan_id  BIGINT NOT NULL,
    alias       TEXT NOT NULL,
    match       TEXT,
    tokenized   TEXT,
    cartridges  TEXT[] DEFAULT '{}',
    organisms   TEXT[] DEFAULT '{}',
    bdeleted    BOOLEAN NOT NULL DEFAULT FALSE,
    curated     BOOLEAN NOT NULL DEFAULT FALSE,   -- row added / edited through the UI
    created_at  TIMESTAMPTZ DEFAULT NOW(),
    updated_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_exactliteral_medscanid       ON ExactLiteral(medscan_id);
CREATE INDEX IF NOT EXISTS idx_exactliteral_tokenized       ON ExactLiteral(tokenized);
CREATE INDEX IF NOT EXISTS idx_exactliteral_tokenized_lower ON ExactLiteral(LOWER(tokenized));
CREATE INDEX IF NOT EXISTS idx_exactliteral_alias_lower     ON ExactLiteral(LOWER(alias));
-- Partial indexes over active rows only — used by conflict self-join (avoids scanning deleted rows)
CREATE INDEX IF NOT EXISTS idx_exactliteral_tok_active       ON ExactLiteral(tokenized)        WHERE (bdeleted IS NULL OR bdeleted = FALSE);
CREATE INDEX IF NOT EXISTS idx_exactliteral_tok_lower_active ON ExactLiteral(LOWER(tokenized)) WHERE (bdeleted IS NULL OR bdeleted = FALSE);
-- Index on match type — used to split literal-containing (l, la, lf…) vs non-literal conflict halves
CREATE INDEX IF NOT EXISTS idx_exactliteral_match            ON ExactLiteral(match);

CREATE TABLE IF NOT EXISTS keywords (
    id          SERIAL PRIMARY KEY,
    medscan_id  BIGINT NOT NULL,
    keywords    TEXT NOT NULL,
    match       TEXT,
    cartridges  TEXT[] DEFAULT '{}',
    organisms   TEXT[] DEFAULT '{}',
    bdeleted    BOOLEAN NOT NULL DEFAULT FALSE,
    curated     BOOLEAN NOT NULL DEFAULT FALSE,   -- row added / edited through the UI
    created_at  TIMESTAMPTZ DEFAULT NOW(),
    updated_at  TIMESTAMPTZ DEFAULT NOW()
);
-- Drop tokenized column from existing databases (keywords are used by Medscan as-is, no tokenization)
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='keywords' AND column_name='tokenized') THEN
    ALTER TABLE keywords DROP COLUMN tokenized;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_keywords_medscanid        ON keywords(medscan_id);
CREATE INDEX IF NOT EXISTS idx_keywords_keywords_lower   ON keywords(LOWER(keywords));  -- alias column is named 'keywords'

-- chemNames is a CAS tokenisation helper: exported to all cartridges/organisms by the NLP runner.
-- It has no cartridges or organisms columns — coverage is unconditional.
CREATE TABLE IF NOT EXISTS chemNames (
    id          SERIAL PRIMARY KEY,
    medscan_id  BIGINT NOT NULL,
    alias       TEXT NOT NULL,
    bdeleted    BOOLEAN NOT NULL DEFAULT FALSE,
    curated     BOOLEAN NOT NULL DEFAULT FALSE,   -- row added / edited through the UI
    created_at  TIMESTAMPTZ DEFAULT NOW(),
    updated_at  TIMESTAMPTZ DEFAULT NOW()
);
-- Drop legacy columns if they exist on older installations
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='chemnames' AND column_name='cartridges') THEN
    ALTER TABLE chemNames DROP COLUMN cartridges;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='chemnames' AND column_name='organisms') THEN
    ALTER TABLE chemNames DROP COLUMN organisms;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='chemnames' AND column_name='tokenized') THEN
    ALTER TABLE chemNames DROP COLUMN tokenized;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='chemnames' AND column_name='normalized') THEN
    ALTER TABLE chemNames DROP COLUMN normalized;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='chemnames' AND column_name='match') THEN
    ALTER TABLE chemNames DROP COLUMN match;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_chemnames_medscanid ON chemNames(medscan_id);

-- rsmap: SNP-to-protein mapping table.
-- Stores rsmap.tab from GeneticVariant.bin/gsdata/.
-- Conflict key = lower(protein_name || ' ' || hgvs_code).
CREATE TABLE IF NOT EXISTS rsmap (
    id            SERIAL PRIMARY KEY,
    medscan_id    BIGINT NOT NULL,
    protein_name  TEXT NOT NULL,
    hgvs_code     TEXT NOT NULL,
    urn           TEXT,
    normalized    TEXT,
    bdeleted      BOOLEAN NOT NULL DEFAULT FALSE,
    curated       BOOLEAN NOT NULL DEFAULT FALSE,
    created_at    TIMESTAMPTZ DEFAULT NOW(),
    updated_at    TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_rsmap_medscanid       ON rsmap(medscan_id);
CREATE INDEX IF NOT EXISTS idx_rsmap_protein_name    ON rsmap(protein_name);
CREATE INDEX IF NOT EXISTS idx_rsmap_normalized      ON rsmap(normalized) WHERE (bdeleted IS NULL OR bdeleted = FALSE);
CREATE UNIQUE INDEX IF NOT EXISTS rsmap_unique_key   ON rsmap(medscan_id, protein_name, hgvs_code);

CREATE TABLE IF NOT EXISTS xwords (
    id          SERIAL PRIMARY KEY,
    xword       TEXT NOT NULL,
    cartridges  TEXT[] DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_xwords_xword ON xwords(xword);

CREATE TABLE IF NOT EXISTS cellDictionary (
    id          SERIAL PRIMARY KEY,
    medscan_id  BIGINT NOT NULL,
    alias       TEXT NOT NULL,
    match       TEXT,
    tokenized   TEXT,
    normalized  TEXT,
    cartridges  TEXT[] DEFAULT '{}',
    organisms   TEXT[] DEFAULT '{}',
    bdeleted    BOOLEAN NOT NULL DEFAULT FALSE,
    curated     BOOLEAN NOT NULL DEFAULT FALSE,   -- row added / edited through the UI
    created_at  TIMESTAMPTZ DEFAULT NOW(),
    updated_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_celldict_medscanid       ON cellDictionary(medscan_id);
CREATE INDEX IF NOT EXISTS idx_celldict_tokenized       ON cellDictionary(tokenized);
CREATE INDEX IF NOT EXISTS idx_celldict_tokenized_lower ON cellDictionary(LOWER(tokenized));
CREATE INDEX IF NOT EXISTS idx_celldict_alias_lower     ON cellDictionary(LOWER(alias));
-- Partial indexes over active rows — conflict detection and re-tokenization
CREATE INDEX IF NOT EXISTS idx_celldict_tok_active       ON cellDictionary(tokenized)        WHERE (bdeleted IS NULL OR bdeleted = FALSE);
CREATE INDEX IF NOT EXISTS idx_celldict_tok_lower_active ON cellDictionary(LOWER(tokenized)) WHERE (bdeleted IS NULL OR bdeleted = FALSE);

CREATE TABLE IF NOT EXISTS xwords_cells (
    id          SERIAL PRIMARY KEY,
    xword       TEXT NOT NULL,
    flags       TEXT,
    cartridges  TEXT[] DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_xwordscells_xword ON xwords_cells(xword);

CREATE TABLE IF NOT EXISTS CASDictionary (
    id          SERIAL PRIMARY KEY,
    medscan_id  BIGINT NOT NULL,
    alias       TEXT NOT NULL,
    match       TEXT,
    tokenized   TEXT,
    normalized  TEXT,
    cartridges  TEXT[] DEFAULT '{}',
    organisms   TEXT[] DEFAULT '{}',
    bdeleted    BOOLEAN NOT NULL DEFAULT FALSE,
    curated     BOOLEAN NOT NULL DEFAULT FALSE,   -- row added / edited through the UI
    created_at  TIMESTAMPTZ DEFAULT NOW(),
    updated_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_casdict_medscanid       ON CASDictionary(medscan_id);
CREATE INDEX IF NOT EXISTS idx_casdict_tokenized       ON CASDictionary(tokenized);
CREATE INDEX IF NOT EXISTS idx_casdict_tokenized_lower ON CASDictionary(LOWER(tokenized));
CREATE INDEX IF NOT EXISTS idx_casdict_alias_lower     ON CASDictionary(LOWER(alias));
-- Partial index over active rows
CREATE INDEX IF NOT EXISTS idx_casdict_tok_active      ON CASDictionary(tokenized) WHERE (bdeleted IS NULL OR bdeleted = FALSE);

CREATE TABLE IF NOT EXISTS xwords_CAS (
    id          SERIAL PRIMARY KEY,
    xword       TEXT NOT NULL,
    cartridges  TEXT[] DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_xwordscas_xword ON xwords_CAS(xword);

CREATE TABLE IF NOT EXISTS UserDict (
    id          SERIAL PRIMARY KEY,
    medscan_id  BIGINT NOT NULL,
    alias       TEXT NOT NULL,
    match       TEXT,
    tokenized   TEXT,
    cartridges  TEXT[] DEFAULT '{}',
    organisms   TEXT[] DEFAULT '{}',
    bdeleted    BOOLEAN NOT NULL DEFAULT FALSE,
    curated     BOOLEAN NOT NULL DEFAULT FALSE,   -- row added / edited through the UI
    created_at  TIMESTAMPTZ DEFAULT NOW(),
    updated_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_userdict_medscanid       ON UserDict(medscan_id);
CREATE INDEX IF NOT EXISTS idx_userdict_tokenized       ON UserDict(tokenized);
CREATE INDEX IF NOT EXISTS idx_userdict_tokenized_lower ON UserDict(LOWER(tokenized));
CREATE INDEX IF NOT EXISTS idx_userdict_alias_lower     ON UserDict(LOWER(alias));
CREATE INDEX IF NOT EXISTS idx_userdict_tok_active      ON UserDict(tokenized) WHERE (bdeleted IS NULL OR bdeleted = FALSE);

CREATE TABLE IF NOT EXISTS ObjectNames (
    id          SERIAL PRIMARY KEY,
    medscan_id  BIGINT NOT NULL,
    name        TEXT NOT NULL,
    urn         TEXT,
    cartridges  TEXT[] DEFAULT '{}',
    organisms   TEXT[] DEFAULT '{}',
    bdeleted    BOOLEAN NOT NULL DEFAULT FALSE,
    created_at  TIMESTAMPTZ DEFAULT NOW(),
    updated_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_objectnames_medscanid      ON ObjectNames(medscan_id);
CREATE INDEX IF NOT EXISTS idx_objectnames_urn             ON ObjectNames(urn);              -- for URN uniqueness checks
CREATE INDEX IF NOT EXISTS idx_objectnames_name_lower      ON ObjectNames(LOWER(name));      -- for name search
CREATE INDEX IF NOT EXISTS idx_objectnames_medscanid_urn   ON ObjectNames(medscan_id, urn);  -- for GROUP BY medscan_id,urn in dedup + conflict queries

-- -- Service / xword tables --

-- xwords_comb: migrate from old schema (medscan_id/value) to current schema (xword/flags/cartridges)
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='xwords_comb' AND column_name='medscan_id') THEN
    DROP TABLE xwords_comb;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS xwords_comb (
    id          SERIAL PRIMARY KEY,
    xword       TEXT NOT NULL,
    flags       TEXT,
    cartridges  TEXT[] DEFAULT '{}'
);
-- Add flags column if an even older install is missing it
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='xwords_comb' AND column_name='flags') THEN
    ALTER TABLE xwords_comb ADD COLUMN flags TEXT;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_xwordscomb_xword ON xwords_comb(xword);

CREATE TABLE IF NOT EXISTS spelling (
    id          SERIAL PRIMARY KEY,
    canonical   TEXT NOT NULL,
    spellings   TEXT
);
CREATE INDEX IF NOT EXISTS idx_spelling_canonical ON spelling(canonical);

CREATE TABLE IF NOT EXISTS bracketstop (
    id          SERIAL PRIMARY KEY,
    word        TEXT NOT NULL,
    flag        TEXT,
    comment     TEXT
);
CREATE INDEX IF NOT EXISTS idx_bracketstop_word ON bracketstop(word);

CREATE TABLE IF NOT EXISTS ProteinClasses (
    id          SERIAL PRIMARY KEY,
    medscan_id  BIGINT NOT NULL,
    name        TEXT NOT NULL,
    class_value TEXT,
    cartridges  TEXT[] DEFAULT '{}',
    created_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_proteinclasses_medscanid ON ProteinClasses(medscan_id);

-- Ontology: protein classes (Receptors, Ligands, …) with the URN of every member. Imported from xfdata/ProteinClasses.tab;
-- medscan_id is the ID of the ObjectNames record with that URN (NULL if there is none). Deploy Dictionary writes class + URN to xfdata/Ontology.tab.
CREATE TABLE IF NOT EXISTS Ontology (
    id          SERIAL PRIMARY KEY,
    class       TEXT NOT NULL,
    urn         TEXT NOT NULL,
    medscan_id  BIGINT,
    organisms   TEXT[] DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_ontology_urn ON Ontology(urn);
CREATE INDEX IF NOT EXISTS idx_ontology_medscanid ON Ontology(medscan_id);
-- organisms was added later: the rows that exist when the column is added get 'Mammal' (once), new rows start empty
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'ontology' AND column_name = 'organisms') THEN
    ALTER TABLE Ontology ADD COLUMN organisms TEXT[] DEFAULT ARRAY['Mammal'];
    ALTER TABLE Ontology ALTER COLUMN organisms SET DEFAULT '{}';
  END IF;
END $$;

-- -- Entity Type Registry (lookup table) --
CREATE TABLE IF NOT EXISTS entity_types (
    id             SERIAL PRIMARY KEY,
    display_name   TEXT NOT NULL UNIQUE,
    rnef_node_type TEXT NOT NULL,
    range_start    BIGINT NOT NULL,
    range_end      BIGINT NOT NULL
);

INSERT INTO entity_types (display_name, rnef_node_type, range_start, range_end) VALUES
  ('Protein/Gene',          'Protein',          0,          999999),
  ('Small Molecules',       'SmallMol',         1000000,    1199999),
  ('Cell components',       'CellObject',       2000000,    2999999),
  ('Prot. Classes',         'Complex',          3000000,    3999999),
  ('Cell processes',        'CellProcesses',    4000000,    4999999),
  ('Virus',                 'Virus',            5000000,    5999999),
  ('Tissues',               'Tissue',           6000000,    6699999),
  ('Organs',                'Organ',            8000000,    8999999),
  ('Diseases',              'Diseases',         9000000,    9999999),
  ('Cell types',            'CellType',         10000000,   10999999),
  ('Cell lines',            'CellLineName',     11000000,   11999999),
  ('Protein Functional class', 'FunctionalClass', 12000000, 12999999),
  ('Treatment',             'Treatment',        13000000,   13999999),
  ('Clinical parameters',   'ClinicalParameter',15000000,   15999999),
  ('Genetic variation',     'GeneticVariant',   17000000,   17999999),
  ('Pathogen',              'Pathogen',         18000000,   18999999)
ON CONFLICT (display_name) DO NOTHING;

-- Unique indexes for ON CONFLICT upserts during dict:refresh.
-- Deduplicate any existing rows first so the index creation doesn't fail.
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['curnames','exactliteral','celldictionary','casdictionary','userdict','combnames'] LOOP
    IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = LOWER(t)) THEN CONTINUE; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE tablename = LOWER(t) AND indexname = LOWER(t) || '_unique_key') THEN
      EXECUTE format($q$
        DELETE FROM %I a USING %I b
        WHERE a.id > b.id AND a.medscan_id = b.medscan_id AND a.alias = b.alias
          AND COALESCE(a.match, '') = COALESCE(b.match, '')
      $q$, t, t);
    END IF;
  END LOOP;
  -- chemnames has no match column — deduplicate by (medscan_id, alias) only
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'chemnames') AND
     NOT EXISTS (SELECT 1 FROM pg_indexes WHERE tablename = 'chemnames' AND indexname = 'chemnames_unique_key') THEN
    DELETE FROM chemnames a USING chemnames b
    WHERE a.id > b.id AND a.medscan_id = b.medscan_id AND a.alias = b.alias;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'keywords') AND
     NOT EXISTS (SELECT 1 FROM pg_indexes WHERE tablename = 'keywords' AND indexname = 'keywords_unique_key') THEN
    DELETE FROM keywords a USING keywords b
    WHERE a.id > b.id AND a.medscan_id = b.medscan_id AND a.keywords = b.keywords
      AND COALESCE(a.match, '') = COALESCE(b.match, '');
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'objectnames') AND
     NOT EXISTS (SELECT 1 FROM pg_indexes WHERE tablename = 'objectnames' AND indexname = 'objectnames_unique_key') THEN
    DELETE FROM objectnames a USING objectnames b
    WHERE a.id > b.id AND a.medscan_id = b.medscan_id AND a.name = b.name
      AND COALESCE(a.urn, '') = COALESCE(b.urn, '');
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS curnames_unique_key       ON curnames(medscan_id, alias, (COALESCE(match, '')));
CREATE UNIQUE INDEX IF NOT EXISTS exactliteral_unique_key   ON exactliteral(medscan_id, alias, (COALESCE(match, '')));
CREATE UNIQUE INDEX IF NOT EXISTS celldictionary_unique_key ON celldictionary(medscan_id, alias, (COALESCE(match, '')));
CREATE UNIQUE INDEX IF NOT EXISTS casdictionary_unique_key  ON casdictionary(medscan_id, alias, (COALESCE(match, '')));
CREATE UNIQUE INDEX IF NOT EXISTS chemnames_unique_key      ON chemnames(medscan_id, alias);
CREATE UNIQUE INDEX IF NOT EXISTS keywords_unique_key       ON keywords(medscan_id, keywords, (COALESCE(match, '')));
CREATE UNIQUE INDEX IF NOT EXISTS userdict_unique_key       ON userdict(medscan_id, alias, (COALESCE(match, '')));
CREATE UNIQUE INDEX IF NOT EXISTS combnames_unique_key      ON combnames(medscan_id, alias, (COALESCE(match, '')));
CREATE UNIQUE INDEX IF NOT EXISTS objectnames_unique_key    ON objectnames(medscan_id, name, (COALESCE(urn, '')));

-- objectnames: add cartridges/organisms columns if they were missing from an older schema.
DO $$ BEGIN
  ALTER TABLE objectnames ADD COLUMN IF NOT EXISTS cartridges TEXT[] DEFAULT '{}';
  ALTER TABLE objectnames ADD COLUMN IF NOT EXISTS organisms  TEXT[] DEFAULT '{}';
END $$;

-- Phase-1 tokenizeAlias form (lowercase + strip punctuation + remove xwords; no stemming).
-- Contrast with Phase-2 normalizeTokenized (full stemming pipeline stored in `tokenized`).
-- Populated by Retokenize Aliases and dict:refresh.  Used for two-phase dup/conflict detection.
DO $$ BEGIN
  ALTER TABLE curnames       ADD COLUMN IF NOT EXISTS normalized TEXT;
  ALTER TABLE exactliteral   ADD COLUMN IF NOT EXISTS normalized TEXT;
  ALTER TABLE celldictionary ADD COLUMN IF NOT EXISTS normalized TEXT;
  ALTER TABLE casdictionary  ADD COLUMN IF NOT EXISTS normalized TEXT;
  -- chemnames has no normalized column: alias is already a single lowercase token
  ALTER TABLE userdict       ADD COLUMN IF NOT EXISTS normalized TEXT;
  ALTER TABLE combnames      ADD COLUMN IF NOT EXISTS normalized TEXT;
  ALTER TABLE rsmap         ADD COLUMN IF NOT EXISTS normalized TEXT;
END $$;

-- Partial indexes on normalized for active rows.
-- 'normalized' stores Phase-2 (stemmed+spelling-normalised) form.
-- Used by: Phase-2 self-join in findTableConflicts (equality), LOWER(normalized) in dup checks.
CREATE INDEX IF NOT EXISTS curnames_normalized_idx            ON curnames(normalized)        WHERE bdeleted IS NULL OR bdeleted = FALSE;
CREATE INDEX IF NOT EXISTS curnames_normalized_lower_idx      ON curnames(LOWER(normalized)) WHERE bdeleted IS NULL OR bdeleted = FALSE;
CREATE INDEX IF NOT EXISTS exactliteral_normalized_idx        ON exactliteral(normalized)    WHERE bdeleted IS NULL OR bdeleted = FALSE;
CREATE INDEX IF NOT EXISTS exactliteral_normalized_lower_idx  ON exactliteral(LOWER(normalized)) WHERE bdeleted IS NULL OR bdeleted = FALSE;
CREATE INDEX IF NOT EXISTS celldictionary_normalized_idx      ON celldictionary(normalized)  WHERE bdeleted IS NULL OR bdeleted = FALSE;
CREATE INDEX IF NOT EXISTS celldictionary_normalized_lower_idx ON celldictionary(LOWER(normalized)) WHERE bdeleted IS NULL OR bdeleted = FALSE;
CREATE INDEX IF NOT EXISTS casdictionary_normalized_idx       ON casdictionary(normalized)   WHERE bdeleted IS NULL OR bdeleted = FALSE;
CREATE INDEX IF NOT EXISTS casdictionary_normalized_lower_idx ON casdictionary(LOWER(normalized))  WHERE bdeleted IS NULL OR bdeleted = FALSE;
-- chemnames has no normalized column; indexes above are for other tables only
CREATE INDEX IF NOT EXISTS userdict_normalized_idx            ON userdict(normalized)         WHERE bdeleted IS NULL OR bdeleted = FALSE;
CREATE INDEX IF NOT EXISTS userdict_normalized_lower_idx      ON userdict(LOWER(normalized))  WHERE bdeleted IS NULL OR bdeleted = FALSE;
CREATE INDEX IF NOT EXISTS combnames_normalized_idx           ON combnames(normalized)        WHERE bdeleted IS NULL OR bdeleted = FALSE;
CREATE INDEX IF NOT EXISTS combnames_normalized_lower_idx     ON combnames(LOWER(normalized)) WHERE bdeleted IS NULL OR bdeleted = FALSE;
CREATE INDEX IF NOT EXISTS rsmap_normalized_idx       ON rsmap(normalized)        WHERE bdeleted IS NULL OR bdeleted = FALSE;
CREATE INDEX IF NOT EXISTS rsmap_normalized_lower_idx ON rsmap(LOWER(normalized)) WHERE bdeleted IS NULL OR bdeleted = FALSE;

-- ── One-time migration: swap tokenized ↔ normalized column data ───────────────
-- Before this migration: 'tokenized' stored Phase-2, 'normalized' stored Phase-1.
-- After this migration:  'tokenized' stores Phase-1, 'normalized' stores Phase-2.
-- Guarded by schema_migrations so it runs exactly once even if schema.sql is re-applied.
CREATE TABLE IF NOT EXISTS schema_migrations (
  id         TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE id = 'swap_tokenized_normalized_20260923') THEN
    UPDATE curnames       SET tokenized = normalized, normalized = tokenized WHERE normalized IS NOT NULL;
    UPDATE exactliteral   SET tokenized = normalized, normalized = tokenized WHERE normalized IS NOT NULL;
    UPDATE celldictionary SET tokenized = normalized, normalized = tokenized WHERE normalized IS NOT NULL;
    UPDATE casdictionary  SET tokenized = normalized, normalized = tokenized WHERE normalized IS NOT NULL;
    -- chemnames has no tokenized/normalized columns; swap skipped
    UPDATE userdict       SET tokenized = normalized, normalized = tokenized WHERE normalized IS NOT NULL;
    UPDATE combnames      SET tokenized = normalized, normalized = tokenized WHERE normalized IS NOT NULL;
    INSERT INTO schema_migrations (id) VALUES ('swap_tokenized_normalized_20260923');
  END IF;
END $$;

-- Populate rsmap.normalized from its two key columns (idempotent — runs on every startup).
UPDATE rsmap SET normalized = lower(protein_name || ' ' || hgvs_code)
WHERE normalized IS NULL OR normalized = '';

-- ── Lookup tables (small, fast) ────────────────────────────────────────────────
-- organisms_lookup: distinct organism values found across all alias tables.
-- Populated by db:migrate and rebuilt after db:restore.
-- Updated in real-time when the user adds a new organism in Edit Records.
CREATE TABLE IF NOT EXISTS organisms_lookup (
  name TEXT PRIMARY KEY
);

-- match_opts_lookup: distinct (table_name, match_value) pairs for the match dropdown in Edit Records.
-- Populated by db:migrate and rebuilt after db:restore.
CREATE TABLE IF NOT EXISTS match_opts_lookup (
  table_name  TEXT NOT NULL,
  match_value TEXT NOT NULL,
  PRIMARY KEY (table_name, match_value)
);

-- cartridges_lookup: distinct cartridge names found across all alias tables.
-- Populated by db:migrate and rebuilt after db:restore.
CREATE TABLE IF NOT EXISTS cartridges_lookup (
  name TEXT PRIMARY KEY
);

-- ── updated_at maintenance ─────────────────────────────────────────────────────
-- Every UPDATE of an entity row stamps updated_at = NOW(), whoever runs it (the app, the SQL tab, psql).
-- An UPDATE that sets updated_at itself (the app's own "updated_at = NOW()", or an import that keeps original dates) is left alone.
-- Created last because the tables must exist; idempotent (function replaced, trigger only added when missing).
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $fn$
BEGIN
  IF NEW.updated_at IS NOT DISTINCT FROM OLD.updated_at THEN
    NEW.updated_at := NOW();
  END IF;
  RETURN NEW;
END
$fn$ LANGUAGE plpgsql;

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['curnames','exactliteral','celldictionary','casdictionary',
                            'chemnames','keywords','userdict','objectnames','combnames','rsmap'] LOOP
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = LOWER(t) AND column_name = 'updated_at') THEN
      CONTINUE;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_set_updated_at' AND tgrelid = LOWER(t)::regclass) THEN
      EXECUTE format('CREATE TRIGGER trg_set_updated_at BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION set_updated_at()', t);
    END IF;
  END LOOP;
END $$;
