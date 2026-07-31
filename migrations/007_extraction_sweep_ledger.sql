-- Rumen Sprint 84 (TermDeck T3) — extraction-sweep ledger.
--
-- Creates ONE new table in the rumen-owned namespace: rumen_extraction_sweep,
-- the idempotency ledger for the write-time-extraction backstop
-- (src/extract-sweep.ts). Does NOT modify or reference any Mnestra table's
-- structure; the FK to memory_items is a pointer, not a mutation.
--
-- ── WHY A SEPARATE LEDGER RATHER THAN A STAMP ON THE MEMORY ─────────────
--
-- The obvious design is `memory_items.metadata->>'extracted_at'`. It is also
-- the wrong one here: writing it would be Rumen modifying an existing memory
-- row, which requires amending a doctrine that currently has exactly two
-- narrow, documented exceptions (src/index.ts header; CONTRIBUTING.md ground
-- rule 1). Bookkeeping is not worth a third exception — the whole value of
-- that rule is that it is boring to check.
--
-- A rumen-namespaced ledger costs one LEFT JOIN in the selection query, needs
-- no doctrine change, and is strictly more useful: it carries attempt counts,
-- per-item error text and per-item yield, none of which would have fit in a
-- timestamp stamp anyway. It is also droppable — deleting this table resets
-- the sweep to "nothing swept yet" without touching a single memory.
--
-- ── WHAT `attempts` IS FOR ──────────────────────────────────────────────
--
-- Fail-open per item means a poison memory (unparseable content, an entity the
-- model chokes on) never aborts a pass. Without a counter it would instead be
-- re-selected and re-paid-for on every run, forever. `attempts` retires it
-- after N tries while leaving the row visible, so a systematic failure shows
-- up as a queryable cohort rather than as a slow leak in the model bill.
--
-- ── FIVE RLS/PRIVILEGE GATES ────────────────────────────────────────────
--   GATE 1  RLS enabled on the new table, in this migration.
--   GATE 2  Zero policies: with RLS on and no policy, anon and authenticated
--           are denied everything; service_role bypasses RLS by design and is
--           the only writer (the sweep runs as a scheduled Edge Function over
--           a service-role DATABASE_URL).
--   GATE 3/4  N/A — no function is defined here. The sweep runs in TypeScript
--           over plain parameterized queries (004's precedent), and the two
--           SECURITY DEFINER RPCs it calls are engram 034's, already gated
--           there.
--   GATE 5  Table grants for anon/authenticated revoked outright, so even a
--           future accidentally-permissive policy would expose nothing through
--           the anon key.
--
-- Apply with (ORCH at sprint close — never from a lane):
--   psql "$DIRECT_URL" -f migrations/007_extraction_sweep_ledger.sql

BEGIN;

-- ---------------------------------------------------------------------------
-- rumen_extraction_sweep: one row per memory the sweep has considered.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS rumen_extraction_sweep (
  -- The memory this row accounts for. PRIMARY KEY, so the ON CONFLICT upsert
  -- in the sweep is the idempotency mechanism itself rather than a convention
  -- layered on top of one.
  --
  -- ON DELETE CASCADE: if the memory is hard-deleted the ledger row is
  -- meaningless. (Note that ordinary forgetting is a soft archive, which
  -- leaves the row — correctly, since the memory still exists.)
  memory_id           UUID PRIMARY KEY
                      REFERENCES memory_items(id) ON DELETE CASCADE,

  swept_at            TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- 'ok'    — the pass completed for this item (possibly extracting nothing,
  --           which is a legitimate and common outcome for short or
  --           structure-free memories).
  -- 'error' — the pass failed for this item; see `error`. Re-selected while
  --           attempts < the runner's max.
  status              TEXT NOT NULL DEFAULT 'ok'
                      CHECK (status IN ('ok', 'error')),

  attempts            INT NOT NULL DEFAULT 1 CHECK (attempts >= 0),

  -- Per-item yield. Cheap to keep, and the only way to answer "is the sweep
  -- actually producing a graph or just marking things done" without re-running
  -- it.
  entities_written    INT NOT NULL DEFAULT 0 CHECK (entities_written    >= 0),
  mentions_written    INT NOT NULL DEFAULT 0 CHECK (mentions_written    >= 0),
  same_pattern_edges  INT NOT NULL DEFAULT 0 CHECK (same_pattern_edges  >= 0),

  -- SR-7 telemetry. Entity-to-entity triples are extracted but deliberately
  -- NOT persisted: memory_relationships is memory-to-memory on both columns
  -- and engram 034 ships no entity-edge table, so a triple like
  -- "recall_log.ts —part_of→ mnestra" has nowhere to live. Counting them here
  -- is what makes the decision to build (or not build) that table evidential
  -- rather than a guess.
  triples_found       INT NOT NULL DEFAULT 0 CHECK (triples_found       >= 0),

  error               TEXT
);

COMMENT ON TABLE rumen_extraction_sweep IS
  'Sprint 84: idempotency ledger for the write-time-extraction backstop sweep '
  '(rumen src/extract-sweep.ts). One row per memory considered. Rumen-owned: '
  'exists so the sweep never has to stamp memory_items, which would require a '
  'third amendment to "Rumen never modifies existing memory rows". Safe to '
  'DROP — doing so resets the sweep to "nothing swept" and touches no memory.';

COMMENT ON COLUMN rumen_extraction_sweep.attempts IS
  'Incremented on every re-sweep. The runner re-selects error rows only while '
  'attempts < RUMEN_SWEEP_MAX_ATTEMPTS, so a permanently-failing item retires '
  'itself instead of being re-paid-for every run.';

COMMENT ON COLUMN rumen_extraction_sweep.triples_found IS
  'Entity-to-entity triples EXTRACTED but not persisted (nowhere to store them '
  'pre-SR-7). Telemetry for the SR-7 build/skip decision.';

-- The selection query's LEFT JOIN is on the PK, which covers the common path.
-- This partial index serves the retry arm (status='error' AND attempts < n)
-- and the "what is failing" cohort query, both of which scan by status.
CREATE INDEX IF NOT EXISTS idx_rumen_extraction_sweep_error
  ON rumen_extraction_sweep (attempts, swept_at DESC)
  WHERE status = 'error';

-- Yield reporting over a window ("did last night's sweep produce anything").
CREATE INDEX IF NOT EXISTS idx_rumen_extraction_sweep_swept_at
  ON rumen_extraction_sweep (swept_at DESC);

-- ---------------------------------------------------------------------------
-- Gates 1/2/5.
-- ---------------------------------------------------------------------------
ALTER TABLE rumen_extraction_sweep ENABLE ROW LEVEL SECURITY;  -- [GATE 1]

-- [GATE 2] Deliberately NO policies: RLS on + zero policies default-denies
-- anon and authenticated on every operation. service_role bypasses RLS.

-- [GATE 5] Strip the table-level grants Supabase's default privileges hand
-- anon/authenticated on new public tables (engram migration 026's precedent).
REVOKE ALL ON TABLE rumen_extraction_sweep FROM PUBLIC, anon, authenticated;
GRANT  ALL ON TABLE rumen_extraction_sweep TO service_role;

COMMIT;

-- ---------------------------------------------------------------------------
-- Post-apply verification (ORCH):
--
--   select relrowsecurity from pg_class
--    where relname = 'rumen_extraction_sweep';                 -- expect t
--   select count(*) from pg_policies
--    where tablename = 'rumen_extraction_sweep';               -- expect 0
--   select grantee, privilege_type from information_schema.role_table_grants
--    where table_name = 'rumen_extraction_sweep'
--      and grantee in ('anon','authenticated');                -- expect 0 rows
--
-- Sweep yield, once the function is deployed and scheduled:
--   select count(*)                       as swept,
--          count(*) filter (where status = 'error')  as failed,
--          sum(entities_written)          as entities,
--          sum(same_pattern_edges)        as edges,
--          sum(triples_found)             as triples_for_sr7
--     from rumen_extraction_sweep;
--
-- Backlog remaining inside the lookback window:
--   select count(*) from memory_items m
--    left join rumen_extraction_sweep s on s.memory_id = m.id
--    where m.is_active and not m.archived
--      and m.created_at > now() - interval '30 days'
--      and s.memory_id is null;
-- ---------------------------------------------------------------------------
