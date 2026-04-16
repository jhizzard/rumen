-- Rumen schema — self-healing migration.
-- Non-destructive: creates three new tables under the rumen_ namespace and
-- brings any pre-existing tables (from partial prior installs) up to the
-- current shape via ALTER TABLE ADD COLUMN IF NOT EXISTS.
-- Does NOT modify or reference Mnestra's existing memory_items / memory_sessions tables.
--
-- Apply with:
--   psql "$DATABASE_URL" -f migrations/001_rumen_tables.sql

BEGIN;

-- ---------------------------------------------------------------------------
-- rumen_jobs: one row per Rumen tick. Tracks what was processed.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS rumen_jobs (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  triggered_by          TEXT NOT NULL CHECK (triggered_by IN ('schedule', 'session_end', 'manual')),
  status                TEXT NOT NULL CHECK (status IN ('pending', 'running', 'done', 'failed')),
  sessions_processed    INTEGER NOT NULL DEFAULT 0,
  insights_generated    INTEGER NOT NULL DEFAULT 0,
  questions_generated   INTEGER NOT NULL DEFAULT 0,
  error_message         TEXT,
  source_session_ids    UUID[] NOT NULL DEFAULT '{}',
  started_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at          TIMESTAMPTZ
);

-- Backfill columns for schema drift from earlier install attempts.
-- CREATE TABLE IF NOT EXISTS is a no-op on existing tables, so without this
-- block the subsequent CREATE INDEX statements would fail on columns that
-- never got added.
ALTER TABLE rumen_jobs
  ADD COLUMN IF NOT EXISTS triggered_by         TEXT,
  ADD COLUMN IF NOT EXISTS status               TEXT,
  ADD COLUMN IF NOT EXISTS sessions_processed   INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS insights_generated   INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS questions_generated  INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS error_message        TEXT,
  ADD COLUMN IF NOT EXISTS source_session_ids   UUID[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS started_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS completed_at         TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_rumen_jobs_status
  ON rumen_jobs (status);

CREATE INDEX IF NOT EXISTS idx_rumen_jobs_started_at
  ON rumen_jobs (started_at DESC);

-- GIN index so we can cheaply check "has this session already been processed?"
CREATE INDEX IF NOT EXISTS idx_rumen_jobs_source_session_ids
  ON rumen_jobs USING GIN (source_session_ids);

-- ---------------------------------------------------------------------------
-- rumen_insights: synthesized cross-project findings.
-- v0.1 writes placeholder insight_text; v0.2 will add LLM synthesis.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS rumen_insights (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id                UUID NOT NULL REFERENCES rumen_jobs(id) ON DELETE CASCADE,
  source_memory_ids     UUID[] NOT NULL DEFAULT '{}',
  projects              TEXT[] NOT NULL DEFAULT '{}',
  insight_text          TEXT NOT NULL,
  confidence            NUMERIC(4, 3) NOT NULL DEFAULT 0.000
    CHECK (confidence >= 0.0 AND confidence <= 1.0),
  acted_upon            BOOLEAN NOT NULL DEFAULT FALSE,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE rumen_insights
  ADD COLUMN IF NOT EXISTS job_id               UUID,
  ADD COLUMN IF NOT EXISTS source_memory_ids    UUID[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS projects             TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS insight_text         TEXT,
  ADD COLUMN IF NOT EXISTS confidence           NUMERIC(4, 3) NOT NULL DEFAULT 0.000,
  ADD COLUMN IF NOT EXISTS acted_upon           BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE INDEX IF NOT EXISTS idx_rumen_insights_job_id
  ON rumen_insights (job_id);

CREATE INDEX IF NOT EXISTS idx_rumen_insights_created_at
  ON rumen_insights (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_rumen_insights_projects
  ON rumen_insights USING GIN (projects);

CREATE INDEX IF NOT EXISTS idx_rumen_insights_source_memory_ids
  ON rumen_insights USING GIN (source_memory_ids);

-- ---------------------------------------------------------------------------
-- rumen_questions: follow-up questions Rumen wants to ask the developer.
-- Reserved for v0.3. The table is created in v0.1 so the schema is stable,
-- but v0.1 never writes to it.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS rumen_questions (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id                UUID NOT NULL REFERENCES rumen_jobs(id) ON DELETE CASCADE,
  session_id            UUID,
  question              TEXT NOT NULL,
  context               TEXT,
  asked_at              TIMESTAMPTZ,
  answered_at           TIMESTAMPTZ,
  answer                TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE rumen_questions
  ADD COLUMN IF NOT EXISTS job_id               UUID,
  ADD COLUMN IF NOT EXISTS session_id           UUID,
  ADD COLUMN IF NOT EXISTS question             TEXT,
  ADD COLUMN IF NOT EXISTS context              TEXT,
  ADD COLUMN IF NOT EXISTS asked_at             TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS answered_at          TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS answer               TEXT,
  ADD COLUMN IF NOT EXISTS created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE INDEX IF NOT EXISTS idx_rumen_questions_job_id
  ON rumen_questions (job_id);

CREATE INDEX IF NOT EXISTS idx_rumen_questions_session_id
  ON rumen_questions (session_id);

CREATE INDEX IF NOT EXISTS idx_rumen_questions_unanswered
  ON rumen_questions (created_at DESC)
  WHERE answered_at IS NULL;

COMMIT;
