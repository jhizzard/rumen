-- Rumen Sprint 79 — doctrine-scan schema.
-- Non-destructive: creates two new tables under the rumen-owned namespace
-- (doctrine_registry, doctrine_jobs — named per the Sprint 79 DISPATCH-GUIDE,
-- not rumen_-prefixed, but exclusively written by rumen's doctrine-scan pass).
-- Does NOT modify or reference Mnestra's existing memory_items /
-- memory_sessions / memory_relationships tables.
--
-- doctrine-scan DETECTS and DRAFTS only (DB-side density clustering + Haiku
-- synthesis). It never writes memory_items — flow-back on ratification is
-- Sprint 79 T3's job (termdeck `doctrine ratify`, direct-INSERT). See
-- CONTRIBUTING.md ground rule 1.
--
-- Apply with:
--   psql "$DATABASE_URL" -f migrations/004_doctrine_registry.sql

BEGIN;

-- ---------------------------------------------------------------------------
-- doctrine_registry: one row per detected/drafted/ratified doctrine cluster.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS doctrine_registry (
  id                              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  status                          TEXT NOT NULL DEFAULT 'candidate'
    CHECK (status IN ('candidate', 'drafted', 'proposed', 'ratified', 'rejected', 'superseded')),
  title                           TEXT,
  doctrine_text                   TEXT,
  -- memory_items ids that make up this cluster at last (re)synthesis.
  cluster_member_ids              UUID[] NOT NULL DEFAULT '{}',
  -- md5(content) snapshot per member, same order as cluster_member_ids —
  -- lets a later scan detect hash-drift (underlying content changed) without
  -- assuming Mnestra's memory_items exposes its own content_hash column.
  member_content_hashes           TEXT[] NOT NULL DEFAULT '{}',
  -- Mean (then re-normalized) embedding of cluster_member_ids at last
  -- synthesis. Used for centroid-fingerprint dedup against future scans.
  centroid                        VECTOR(1536),
  -- Total times this cluster has been detected/reinforced across scans.
  occurrence_count                INTEGER NOT NULL DEFAULT 1 CHECK (occurrence_count >= 0),
  -- Subset of occurrence_count's reinforcements that landed AFTER status
  -- became 'ratified' (AMEND-13: reinforcement in a new project is scope
  -- expansion — append project, bump this counter, no flag).
  reinforced_after_ratification   INTEGER NOT NULL DEFAULT 0 CHECK (reinforced_after_ratification >= 0),
  projects                        TEXT[] NOT NULL DEFAULT '{}',
  origin                          TEXT NOT NULL DEFAULT 'doctrine-scan'
    CHECK (origin IN ('doctrine-scan', 'manual')),
  -- [{ "date": "YYYY-MM-DD", "gist": "<paraphrase, never a verbatim quote>" }, ...]
  evidence                        JSONB NOT NULL DEFAULT '[]',
  -- Shadow-mode only pre-ratification: logged as doctrine_hits, never
  -- injected into recall boosting until T3 ratifies this row.
  trigger_hints                   TEXT[] NOT NULL DEFAULT '{}',
  -- Populated when status = 'rejected' — kept (never deleted) so a
  -- re-detected cluster skips a repeat Haiku call (anti-rescan).
  rejection_reason                TEXT,
  -- Last time Haiku (re)synthesized this row. Hash-drift re-synthesis is
  -- capped at 1/row/30d against this column.
  synthesized_at                  TIMESTAMPTZ,
  created_at                      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Backfill columns for schema drift from earlier install attempts, same
-- rationale as migrations/001_rumen_tables.sql.
ALTER TABLE doctrine_registry
  ADD COLUMN IF NOT EXISTS status                        TEXT,
  ADD COLUMN IF NOT EXISTS title                          TEXT,
  ADD COLUMN IF NOT EXISTS doctrine_text                   TEXT,
  ADD COLUMN IF NOT EXISTS cluster_member_ids              UUID[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS member_content_hashes           TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS centroid                        VECTOR(1536),
  ADD COLUMN IF NOT EXISTS occurrence_count                INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS reinforced_after_ratification   INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS projects                        TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS origin                          TEXT NOT NULL DEFAULT 'doctrine-scan',
  ADD COLUMN IF NOT EXISTS evidence                        JSONB NOT NULL DEFAULT '[]',
  ADD COLUMN IF NOT EXISTS trigger_hints                   TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS rejection_reason                TEXT,
  ADD COLUMN IF NOT EXISTS synthesized_at                  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS created_at                      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS updated_at                      TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE INDEX IF NOT EXISTS idx_doctrine_registry_status
  ON doctrine_registry (status);

CREATE INDEX IF NOT EXISTS idx_doctrine_registry_updated_at
  ON doctrine_registry (updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_doctrine_registry_cluster_member_ids
  ON doctrine_registry USING GIN (cluster_member_ids);

CREATE INDEX IF NOT EXISTS idx_doctrine_registry_projects
  ON doctrine_registry USING GIN (projects);

-- No ANN index on centroid: this table is expected to stay small (tens to
-- low hundreds of rows — one per DISTINCT doctrine, not per memory), so a
-- sequential `ORDER BY centroid <=> $1 LIMIT 1` for centroid-fingerprint
-- dedup is cheap and avoids tuning ivfflat/hnsw list counts for a table
-- this size.

-- ---------------------------------------------------------------------------
-- doctrine_jobs: one row per doctrine-scan run. Shape reuses rumen_jobs
-- (migrations/001_rumen_tables.sql ~L15-26) with scan-specific counters
-- swapped in for the insight-cycle ones.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS doctrine_jobs (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  triggered_by          TEXT NOT NULL CHECK (triggered_by IN ('schedule', 'manual')),
  status                TEXT NOT NULL CHECK (status IN ('pending', 'running', 'done', 'failed')),
  pool_size             INTEGER NOT NULL DEFAULT 0,
  edge_count            INTEGER NOT NULL DEFAULT 0,
  components_scanned    INTEGER NOT NULL DEFAULT 0,
  -- { "<component size>": <count> } substrate-sanity histogram.
  component_histogram   JSONB NOT NULL DEFAULT '{}',
  clusters_qualified    INTEGER NOT NULL DEFAULT 0,
  clusters_split        INTEGER NOT NULL DEFAULT 0,
  candidates_drafted    INTEGER NOT NULL DEFAULT 0,
  candidates_reinforced INTEGER NOT NULL DEFAULT 0,
  llm_calls_made        INTEGER NOT NULL DEFAULT 0,
  -- Distinguishes a deliberate no-key skip (Phase B) from a genuine
  -- flatline (Phase A ran, found nothing) — e.g. 'no_api_key_phase_b_skipped'.
  note                  TEXT,
  error_message         TEXT,
  started_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at          TIMESTAMPTZ
);

ALTER TABLE doctrine_jobs
  ADD COLUMN IF NOT EXISTS triggered_by          TEXT,
  ADD COLUMN IF NOT EXISTS status                TEXT,
  ADD COLUMN IF NOT EXISTS pool_size             INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS edge_count            INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS components_scanned    INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS component_histogram   JSONB NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS clusters_qualified    INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS clusters_split        INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS candidates_drafted    INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS candidates_reinforced INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS llm_calls_made        INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS note                  TEXT,
  ADD COLUMN IF NOT EXISTS error_message         TEXT,
  ADD COLUMN IF NOT EXISTS started_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS completed_at          TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_doctrine_jobs_status
  ON doctrine_jobs (status);

CREATE INDEX IF NOT EXISTS idx_doctrine_jobs_started_at
  ON doctrine_jobs (started_at DESC);

-- ---------------------------------------------------------------------------
-- RLS gates (CLAUDE.md § Supabase RLS + privilege hygiene, gates 1/4/5).
-- Both tables are service-role-only: doctrine-scan runs as a scheduled Edge
-- Function over a service-role DATABASE_URL, and service_role bypasses RLS
-- entirely. No policy is added for anon/authenticated on either table, so
-- RLS enablement alone default-denies both roles — there is no PUBLIC
-- WITH CHECK(true) policy to avoid (gate 1) and no anon-writeable path to
-- close (gate 4) because zero policies exist.
--
-- Gates 2/3 (REVOKE EXECUTE FROM PUBLIC + SET search_path on every function)
-- are N/A this migration: doctrine-scan's clustering runs in TypeScript over
-- plain parameterized queries (matching src/promote.ts's Sprint 76
-- precedent), not a SECURITY DEFINER SQL function. No function is defined
-- here for gates 2/3 to apply to.
-- ---------------------------------------------------------------------------
ALTER TABLE doctrine_registry ENABLE ROW LEVEL SECURITY;
ALTER TABLE doctrine_jobs ENABLE ROW LEVEL SECURITY;

COMMIT;
