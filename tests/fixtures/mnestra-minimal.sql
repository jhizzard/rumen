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
-- memory_inbox — Sprint 76 quarantine table for web-chat proposals.
--
-- SOURCE OF TRUTH: engram migrations/026_memory_inbox.sql (Sprint 76 T1).
-- This fixture mirrors the COLUMNS, CHECKs, and indexes the promotion pass
-- (src/promote.ts) touches — keep it in lockstep whenever 026 changes. The
-- RLS gates, the memory_propose RPC, and the grant hygiene are deliberately
-- NOT mirrored: the CI fixture runs in a service/superuser context where
-- they would be untestable theater; T1's migration + tests own that surface.
--
-- The promotion pass claims pending rows (FOR UPDATE SKIP LOCKED), then
-- promotes (INSERT memory_items + status='promoted' + promoted_memory_id in
-- one transaction) or rejects (status='rejected' + rejection_reason). The
-- status-consistency CHECKs keep the audit trail honest.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS memory_inbox (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  source_agent       TEXT NOT NULL,
  project_hint       TEXT,
  text               TEXT NOT NULL,
  status             TEXT NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending', 'promoted', 'rejected')),
  promoted_memory_id UUID REFERENCES memory_items(id) ON DELETE SET NULL,
  rejection_reason   TEXT,
  metadata           JSONB NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT memory_inbox_promoted_consistency
    CHECK (promoted_memory_id IS NULL OR status = 'promoted'),
  CONSTRAINT memory_inbox_rejected_consistency
    CHECK (rejection_reason IS NULL OR status = 'rejected')
);

-- The promotion pass's claim scan (mirrors 026's partial pending index,
-- name and column per the landed migration).
CREATE INDEX IF NOT EXISTS memory_inbox_status_pending_idx
  ON memory_inbox (status)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS memory_inbox_created_at_idx
  ON memory_inbox (created_at DESC);

-- Per-connector accounting (rate-cap gate groups by source_agent).
CREATE INDEX IF NOT EXISTS memory_inbox_source_agent_idx
  ON memory_inbox (source_agent);

-- ---------------------------------------------------------------------------
-- match_memories — dedup-gate fixture stand-in.
--
-- Canonical signature (engram migration 001): match_memories(query_embedding
-- vector(1536), match_threshold float, match_count int, filter_project text)
-- RETURNS (id, content, source_type, category, project, metadata,
-- similarity). src/promote.ts calls it with the remember.ts thresholds
-- (0.88 / 0.95) for the duplicate / near-duplicate gates.
--
-- CI has no pgvector (`vector` is the NUMERIC[] domain above), so cosine
-- similarity is impossible. The stand-in is DETERMINISTIC instead: it reads
-- element 1 of the query embedding as the similarity it reports against
-- every memory_items row. A test that wants "0.97 duplicate" injects an
-- embedding starting [0.97, ...]; one that wants "no match" injects
-- [0.5, ...] (below the 0.88 threshold). NOTE: NUMERIC[] literals use
-- '{0.97,0.5}' array syntax here, NOT pgvector's '[...]' — unit tests mock
-- the pool anyway; this function exists for schema parity and any future
-- real-PG integration coverage. category is NULL (fixture memory_items has
-- no category column; the canonical table does).
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS
  match_memories(vector, double precision, int, text);

CREATE OR REPLACE FUNCTION match_memories(
  query_embedding vector,
  match_threshold DOUBLE PRECISION,
  match_count     INT,
  filter_project  TEXT DEFAULT NULL
)
RETURNS TABLE (
  id          UUID,
  content     TEXT,
  source_type TEXT,
  category    TEXT,
  project     TEXT,
  metadata    JSONB,
  similarity  DOUBLE PRECISION
)
LANGUAGE sql
STABLE
AS $$
  SELECT
    m.id,
    m.content,
    m.source_type,
    NULL::TEXT AS category,
    m.project,
    '{}'::JSONB AS metadata,
    ((query_embedding::NUMERIC[])[1])::DOUBLE PRECISION AS similarity
  FROM memory_items m
  WHERE (filter_project IS NULL OR m.project = filter_project)
    AND (query_embedding::NUMERIC[])[1] IS NOT NULL
    AND ((query_embedding::NUMERIC[])[1])::DOUBLE PRECISION >= match_threshold
  ORDER BY m.created_at DESC
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
