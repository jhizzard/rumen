-- Minimal Engram-compatible fixture for Rumen CI integration tests.
--
-- Creates the subset of the Engram schema Rumen v0.1 reads — memory_sessions,
-- memory_items, and the memory_hybrid_search() SQL function — and seeds two
-- sessions across two projects so extract → relate → synthesize → surface
-- produces at least one insight. Does not install pgvector: the vector column
-- is created as NUMERIC[] and memory_hybrid_search falls back to keyword-only
-- matching (query_embedding is passed as NULL by Rumen in v0.1 anyway).

BEGIN;

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Rumen casts its (NULL) embedding argument to `::vector` in relate.ts. The
-- real Engram deployment has pgvector installed; for CI we don't, so we
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
-- memory_sessions
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS memory_sessions (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project    TEXT,
  summary    TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

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
-- memory_hybrid_search — keyword-only fallback (query_embedding ignored).
--
-- Rumen v0.1 calls this with query_embedding = NULL, so we only need a
-- reasonable ILIKE-based ranking. Similarity is synthesized from position and
-- overlap so the fixture can clear Rumen's default 0.7 threshold.
-- The `vector` type does not exist here; we accept an untyped argument.
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS memory_hybrid_search(text, vector, int, text);

CREATE OR REPLACE FUNCTION memory_hybrid_search(
  query_text      TEXT,
  query_embedding vector,
  limit_count     INT,
  project_filter  TEXT
)
RETURNS TABLE (
  id          UUID,
  content     TEXT,
  source_type TEXT,
  project     TEXT,
  created_at  TIMESTAMPTZ,
  -- DOUBLE PRECISION, not NUMERIC: node-postgres returns NUMERIC as JS
  -- strings, and relate.ts filters out rows where `typeof similarity !==
  -- 'number'`, so a NUMERIC column silently drops every related memory
  -- and zero rumen_insights rows get written.
  similarity  DOUBLE PRECISION
)
LANGUAGE plpgsql
AS $$
DECLARE
  needle TEXT;
BEGIN
  needle := LOWER(COALESCE(query_text, ''));
  RETURN QUERY
    SELECT
      m.id,
      m.content,
      m.source_type,
      m.project,
      m.created_at,
      (
        CASE
          WHEN needle = '' THEN 0.80
          WHEN POSITION(SPLIT_PART(needle, ' ', 1) IN LOWER(m.content)) > 0 THEN 0.92
          WHEN POSITION(needle IN LOWER(m.content)) > 0 THEN 0.85
          ELSE 0.75
        END
      )::DOUBLE PRECISION AS similarity
    FROM memory_items m
    WHERE (project_filter IS NULL OR m.project = project_filter)
    ORDER BY similarity DESC, m.created_at DESC
    LIMIT limit_count;
END;
$$;

-- ---------------------------------------------------------------------------
-- Seed data: two sessions in two projects, CORS-related content so Rumen's
-- cross-project relate phase has something to chew on.
-- ---------------------------------------------------------------------------
INSERT INTO memory_sessions (id, project, summary, created_at) VALUES
  ('11111111-1111-1111-1111-111111111111', 'project-alpha',
   'Fixed CORS preflight by widening Access-Control-Allow-Headers',
   NOW() - INTERVAL '2 hours'),
  ('22222222-2222-2222-2222-222222222222', 'project-beta',
   'Added CORS middleware to express app for external api',
   NOW() - INTERVAL '1 day');

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
