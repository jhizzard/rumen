-- Minimal Mnestra-compatible fixture for Rumen CI integration tests.
--
-- Creates the subset of the Mnestra schema Rumen reads — memory_sessions,
-- memory_items, and the memory_hybrid_search() SQL function — and seeds two
-- sessions across two projects so extract → relate → synthesize → surface
-- produces at least one insight. Does not install pgvector: the vector column
-- is created as NUMERIC[] and memory_hybrid_search falls back to keyword-only
-- matching (query_embedding is passed as NULL by Rumen anyway).
--
-- memory_sessions mirrors the v0.5 Mnestra schema (engram migrations 001 + 017
-- + 018). The Sprint 53 picker rewrite (src/extract.ts) reads sessions
-- directly from memory_sessions, filtering on started_at / ended_at /
-- messages_count / rumen_processed_at. The pre-v0.5 fixture only had
-- id/project/summary/created_at, so the picker failed CI with
-- "column s.started_at does not exist" — keep this table in lockstep with
-- src/extract.ts whenever the picker query changes.

BEGIN;

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Rumen casts its (NULL) embedding argument to `::vector` in relate.ts. The
-- real Mnestra deployment has pgvector installed; for CI we don't, so we
-- alias `vector` to NUMERIC[] as a DOMAIN so the cast parses. Rumen never
-- reads embedding values through this path, it only passes NULL.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'vector') THEN
    EXECUTE 'CREATE DOMAIN vector AS NUMERIC[]';
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- memory_sessions — v0.5 schema (Mnestra migrations 001 + 017 + 018).
-- The extract picker (src/extract.ts) reads started_at, ended_at,
-- messages_count and rumen_processed_at directly off this table; the stamp
-- step (src/index.ts) updates rumen_processed_at. summary_embedding and the
-- HNSW index from mig 017 are omitted — Rumen never reads the embedding and
-- this fixture has no pgvector.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS memory_sessions (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id         TEXT,
  project            TEXT,
  summary            TEXT,
  started_at         TIMESTAMPTZ,
  ended_at           TIMESTAMPTZ,
  messages_count     INTEGER DEFAULT 0,
  rumen_processed_at TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Picker hot-path index (engram mig 018): unprocessed sessions by recency.
CREATE INDEX IF NOT EXISTS memory_sessions_rumen_unprocessed_idx
  ON memory_sessions (started_at DESC NULLS LAST)
  WHERE rumen_processed_at IS NULL;

-- ---------------------------------------------------------------------------
-- memory_items
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS memory_items (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id  UUID REFERENCES memory_sessions(id) ON DELETE CASCADE,
  content     TEXT NOT NULL,
  source_type TEXT NOT NULL DEFAULT 'note',
  project     TEXT,
  -- Rumen v0.1 never reads this column directly. Stored as a cheap NUMERIC[]
  -- so the CI fixture does not need the pgvector extension installed.
  embedding   NUMERIC[],
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_memory_items_session_id
  ON memory_items (session_id);

CREATE INDEX IF NOT EXISTS idx_memory_items_project
  ON memory_items (project);

-- ---------------------------------------------------------------------------
-- memory_hybrid_search — keyword-only fixture stand-in.
--
-- Canonical 8-arg Mnestra signature (Sprint 51.9 / rumen Sprint 54). The v0.5
-- relate phase (src/relate.ts → relateOne) calls memory_hybrid_search with
--   (query_text, query_embedding, match_count, full_text_weight,
--    semantic_weight, rrf_k, filter_project, filter_source_type)
-- and reads back a `score` column. The pre-Sprint-54 fixture defined the old
-- 4-arg (text, vector, int, text) → `similarity` shape, so relate failed CI
-- with "function memory_hybrid_search(...) does not exist". Keep this
-- signature in lockstep with src/relate.ts whenever the call changes.
--
-- Body stays keyword-only: CI has no pgvector, and the integration-test job
-- sets no OPENAI_API_KEY, so relate.ts passes query_embedding = NULL and runs
-- keyword-only — the embedding-weighted args (full_text_weight /
-- semantic_weight / rrf_k) are accepted for signature parity but unused here.
-- score is synthesized from keyword overlap so the two seeded sessions clear
-- Rumen's minSimilarity floor.
--
-- score is DOUBLE PRECISION, not NUMERIC: node-postgres returns NUMERIC as JS
-- strings, and relate.ts drops any row where `typeof similarity !== 'number'`
-- — a NUMERIC column would silently strand every related memory and write
-- zero rumen_insights rows.
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS memory_hybrid_search(text, vector, int, text);
DROP FUNCTION IF EXISTS
  memory_hybrid_search(text, vector, int, double precision, double precision, int, text, text);

CREATE OR REPLACE FUNCTION memory_hybrid_search(
  query_text         TEXT,
  query_embedding    vector,
  match_count        INT,
  full_text_weight   DOUBLE PRECISION,
  semantic_weight    DOUBLE PRECISION,
  rrf_k              INT,
  filter_project     TEXT,
  filter_source_type TEXT
)
RETURNS TABLE (
  id          UUID,
  content     TEXT,
  source_type TEXT,
  project     TEXT,
  created_at  TIMESTAMPTZ,
  score       DOUBLE PRECISION
)
LANGUAGE sql
STABLE
AS $$
  SELECT
    m.id,
    m.content,
    m.source_type,
    m.project,
    m.created_at,
    (
      CASE
        WHEN COALESCE(query_text, '') = '' THEN 0.80
        WHEN POSITION(LOWER(SPLIT_PART(query_text, ' ', 1)) IN LOWER(m.content)) > 0 THEN 0.92
        WHEN POSITION(LOWER(query_text) IN LOWER(m.content)) > 0 THEN 0.85
        ELSE 0.75
      END
    )::DOUBLE PRECISION AS score
  FROM memory_items m
  WHERE (filter_project IS NULL OR m.project = filter_project)
    AND (filter_source_type IS NULL OR m.source_type = filter_source_type)
  ORDER BY score DESC, m.created_at DESC
  LIMIT match_count;
$$;

-- ---------------------------------------------------------------------------
-- Seed data: two sessions in two projects, CORS-related content so Rumen's
-- cross-project relate phase has something to chew on.
-- ---------------------------------------------------------------------------
INSERT INTO memory_sessions
  (id, session_id, project, summary, started_at, ended_at, messages_count) VALUES
  ('11111111-1111-1111-1111-111111111111', 'sess-alpha-0001', 'project-alpha',
   'Fixed CORS preflight by widening Access-Control-Allow-Headers',
   NOW() - INTERVAL '2 hours' - INTERVAL '20 minutes',
   NOW() - INTERVAL '2 hours', 7),
  ('22222222-2222-2222-2222-222222222222', 'sess-beta-0001', 'project-beta',
   'Added CORS middleware to express app for external api',
   NOW() - INTERVAL '1 day' - INTERVAL '35 minutes',
   NOW() - INTERVAL '1 day', 9);

INSERT INTO memory_items (session_id, content, source_type, project, created_at) VALUES
  ('11111111-1111-1111-1111-111111111111',
   'CORS preflight failing with missing Access-Control-Allow-Headers',
   'error', 'project-alpha', NOW() - INTERVAL '2 hours'),
  ('11111111-1111-1111-1111-111111111111',
   'Widened allowed headers list to include X-Request-Id',
   'edit', 'project-alpha', NOW() - INTERVAL '2 hours'),
  ('11111111-1111-1111-1111-111111111111',
   'Preflight now returns 204 with correct CORS headers',
   'note', 'project-alpha', NOW() - INTERVAL '2 hours'),
  ('22222222-2222-2222-2222-222222222222',
   'Enabled CORS middleware in express with allow list',
   'edit', 'project-beta', NOW() - INTERVAL '1 day'),
  ('22222222-2222-2222-2222-222222222222',
   'CORS error from external api when credentials: include',
   'error', 'project-beta', NOW() - INTERVAL '1 day'),
  ('22222222-2222-2222-2222-222222222222',
   'Allowed origin list updated to include staging domain',
   'note', 'project-beta', NOW() - INTERVAL '1 day');

COMMIT;
