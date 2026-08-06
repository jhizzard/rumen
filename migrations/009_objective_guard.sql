-- Rumen Sprint 71 (TermDeck Deck B, B-T3) — anti-drift / objective-guard schema.
--
-- Creates FOUR new tables in the rumen-owned namespace:
--   rumen_objective_flags     — the operator's adjudication queue (contradiction
--                               + staleness). The ONLY output of this lane that
--                               a human is expected to read.
--   rumen_objective_coverage  — per-project drift reports (activity with zero
--                               tier-0 linkage).
--   rumen_objective_guard_jobs— one row per pass, per phase. Telemetry + the
--                               "did it run at all" answer.
--   rumen_objective_scan      — per-memory idempotency ledger for the
--                               contradiction scan (007's pattern, verbatim).
--
-- Does NOT modify, and does not depend on the existence of, ANY tier-0 table.
-- See "ON NOT REFERENCING THE OBJECTIVES TABLE" below — that is the load-bearing
-- decision in this file.
--
-- ── WHY FLAGS AND NEVER RESOLUTION ──────────────────────────────────────
--
-- The whole point of the Objective Tier is that objectives are mutable ONLY via
-- explicit ratification (PLANNING.md §Mission property 3). A job that "resolved"
-- a contradiction — by editing the objective, by archiving the offending memory,
-- or by silently deciding which one wins — would be exactly the unratified
-- mutation path the sprint exists to forbid, wearing a helpful hat.
--
-- So this lane's entire write surface is: append a flag, append a report,
-- append a job row, stamp a ledger. Every one of those is additive and
-- rumen-namespaced. A contradiction is SURFACED to the operator and then the
-- job's involvement ends. `status` on a flag moves only by human action
-- (or by ORCH tooling acting for one) — nothing in src/objective-guard.ts ever
-- writes anything other than 'open'.
--
-- Corollary worth stating because it is counter-intuitive: a flag is not a bug
-- report and finding one is not a failure. Sustained flagging on the same
-- objective usually means the objective has drifted from reality and wants
-- re-ratification — which is a decision, and decisions are the operator's.
--
-- ── ON NOT REFERENCING THE OBJECTIVES TABLE ─────────────────────────────
--
-- `objective_id` carries NO foreign key, deliberately, and this migration is
-- appliable against a database where tier-0 does not exist yet.
--
-- Engram migration 038 (B-T1) owns the objectives store. Its shape is now
-- frozen and known: `public.memory_objectives`, `id uuid` primary key, stable
-- across ratification (a superseded objective KEEPS its id and gains
-- `status='superseded'`; the replacement gets a new id and points back via
-- `supersedes`), and rows are never deleted. B-T1 explicitly offered an FK here
-- and called a plain column "equally fine and looser-coupled."
--
-- Looser-coupled is the choice, for two reasons that outlive the unknown:
--   1. An FK would couple a RUMEN migration to an ENGRAM migration's apply
--      ORDER across two repos. Today 009 applies cleanly against a database
--      with no tier-0 at all, and the jobs report a legible `unavailable` skip
--      until 038 lands. With an FK, applying 009 first is an error.
--   2. ON DELETE CASCADE would buy nothing against a table with a never-delete
--      guarantee, and integrity is not what these rows need: they are a work
--      queue, not a normalized model of the objective.
--
-- What replaces referential integrity is the snapshot: every flag stores
-- `objective_text` as it read at detection time. A flag therefore stays legible
-- after the objective it refers to is superseded — which is the common case,
-- since re-ratification is the expected RESOLUTION of a sustained flag. An FK
-- with ON DELETE CASCADE would have deleted precisely the evidence that
-- justified the change.
--
-- ── FIVE RLS/PRIVILEGE GATES (global CLAUDE.md § Supabase hygiene) ───────
--   GATE 1  RLS enabled on all four new tables, in this migration.
--   GATE 2  Zero policies: RLS on + no policy default-denies anon and
--           authenticated on every operation. service_role bypasses RLS and is
--           the only writer (these jobs run as scheduled Edge Functions over a
--           service-role DATABASE_URL).
--   GATE 3/4  N/A — no function is defined here. The jobs run in TypeScript
--           over plain parameterized queries (004/007's precedent), so there is
--           no SECURITY DEFINER surface and no search_path to pin.
--   GATE 5  anon/authenticated table grants revoked outright, so even a future
--           accidentally-permissive policy exposes nothing through the anon key.
--
-- Apply with (ORCH at sprint close — never from a lane):
--   psql "$DIRECT_URL" -f migrations/009_objective_guard.sql

BEGIN;

-- ---------------------------------------------------------------------------
-- rumen_objective_flags: the operator adjudication queue.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS rumen_objective_flags (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- 'contradiction' — a new decision/architecture/preference/bug_fix memory
  --                   semantically opposes one of its project's tier-0
  --                   objectives.
  -- 'staleness'     — a tier-0 objective is past the ratification-age
  --                   threshold. Objectives NEVER decay (seam §3); age produces
  --                   a review flag and nothing else.
  flag_type         TEXT NOT NULL
                    CHECK (flag_type IN ('contradiction', 'staleness')),

  project           TEXT NOT NULL,

  -- The tier-0 row this flag is about. No FK — see the header.
  objective_id      TEXT,
  -- Snapshot at detection time. Survives supersession of the objective, which
  -- is the expected outcome of a sustained flag.
  objective_text    TEXT NOT NULL,
  objective_rank    INTEGER,

  -- Contradiction flags only. FK to memory_items because a hard-deleted memory
  -- makes the flag meaningless (soft archive leaves it — correctly, the memory
  -- still exists and still contradicts).
  memory_id         UUID REFERENCES memory_items(id) ON DELETE CASCADE,
  -- A SHORT PARAPHRASE of the offending memory, never a verbatim quote —
  -- doctrine-scan's evidence rule, same reasoning: this row is read by a human
  -- in a queue, and duplicating raw memory content into a second table widens
  -- the redaction surface for nothing.
  memory_gist       TEXT,

  severity          TEXT NOT NULL DEFAULT 'medium'
                    CHECK (severity IN ('low', 'medium', 'high')),
  -- Why the detector believes this is a contradiction / why the objective is
  -- stale. The operator adjudicates from this line, so it is not optional.
  rationale         TEXT NOT NULL,

  -- Moves ONLY by human action. src/objective-guard.ts writes 'open' and never
  -- writes this column again — see the header.
  status            TEXT NOT NULL DEFAULT 'open'
                    CHECK (status IN ('open', 'acknowledged', 'dismissed', 'resolved')),

  detected_by       TEXT NOT NULL DEFAULT 'objective-guard@1',
  detected_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at       TIMESTAMPTZ,
  resolved_by       TEXT,
  resolution_note   TEXT,

  -- Idempotency. The scan is designed to be re-runnable and IS re-run nightly;
  -- without this it would re-flag the same pair every night and the queue would
  -- become unreadable within a week — which is the same failure as not flagging
  -- at all, since nobody reads a queue that cries wolf.
  --
  -- Shapes (src/objective-guard.ts owns these, keep in sync):
  --   contradiction:<memory_id>:<objective_id>
  --   staleness:<objective_id>:<ratified_at or 'never'>
  -- The staleness key embeds ratified_at so RE-RATIFYING an objective mints a
  -- new key: the flag legitimately returns once the fresh ratification itself
  -- ages out, rather than being permanently silenced by one dismissal.
  dedup_key         TEXT NOT NULL UNIQUE,

  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE rumen_objective_flags IS
  'Sprint 71 (B-T3): anti-drift adjudication queue. Rows are APPENDED by rumen '
  'objective-guard and resolved only by a human. Nothing in rumen ever '
  'auto-resolves a flag or mutates a tier-0 objective — ratification is the '
  'only mutation path (PLANNING.md Mission property 3).';

COMMENT ON COLUMN rumen_objective_flags.objective_id IS
  'public.memory_objectives.id (engram 038), stored as TEXT with no FK so this '
  'migration stays independent of 038''s apply order across repos. '
  'objective_text is the snapshot that keeps a flag legible after the objective '
  'it refers to is superseded — the expected resolution of a sustained flag.';

COMMENT ON COLUMN rumen_objective_flags.dedup_key IS
  'UNIQUE. Inserts are ON CONFLICT DO NOTHING, which is what makes a nightly '
  're-scan idempotent instead of queue-spamming.';

-- The queue read: "what is open, worst first, newest first".
CREATE INDEX IF NOT EXISTS idx_rumen_objective_flags_open
  ON rumen_objective_flags (project, severity, detected_at DESC)
  WHERE status = 'open';

-- "Is this objective flagging repeatedly" — the re-ratification signal.
CREATE INDEX IF NOT EXISTS idx_rumen_objective_flags_objective
  ON rumen_objective_flags (objective_id, detected_at DESC);

-- ---------------------------------------------------------------------------
-- rumen_objective_coverage: per-project drift reports.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS rumen_objective_coverage (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id             UUID,
  project            TEXT NOT NULL,

  window_days        INTEGER NOT NULL CHECK (window_days > 0),
  window_start       TIMESTAMPTZ NOT NULL,
  window_end         TIMESTAMPTZ NOT NULL,

  objective_count    INTEGER NOT NULL DEFAULT 0 CHECK (objective_count >= 0),
  memory_writes      INTEGER NOT NULL DEFAULT 0 CHECK (memory_writes  >= 0),
  linked_writes      INTEGER NOT NULL DEFAULT 0 CHECK (linked_writes  >= 0),
  -- linked_writes / memory_writes, NULL when the denominator is 0 or when
  -- linkage is undetermined (see linkage_source).
  coverage_ratio     NUMERIC(5,4) CHECK (coverage_ratio IS NULL OR (coverage_ratio >= 0 AND coverage_ratio <= 1)),

  -- 'edges'       — linkage read from memory_relationships.
  -- 'metadata'    — linkage read from memory_items.metadata->'objectives'.
  -- 'both'        — union of the two.
  -- 'unavailable' — no linkage substrate resolvable. `drift` is then NULL:
  --                 the report says "undetermined", never "drifting". A drift
  --                 signal manufactured out of a missing feature is worse than
  --                 no signal, because it trains the operator to ignore the
  --                 report.
  linkage_source     TEXT NOT NULL DEFAULT 'unavailable'
                     CHECK (linkage_source IN ('edges', 'metadata', 'both', 'unavailable')),

  -- TRUE = sustained activity, zero (or near-zero) tier-0 linkage.
  -- NULL = undetermined. Deliberately nullable; see linkage_source.
  drift              BOOLEAN,
  note               TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE rumen_objective_coverage IS
  'Sprint 71 (B-T3): one row per project per objective-coverage pass. drift IS '
  'NULL means undetermined (no linkage substrate), NOT "no drift" — the two are '
  'different answers and conflating them would launder a missing feature into a '
  'clean bill of health.';

CREATE INDEX IF NOT EXISTS idx_rumen_objective_coverage_project
  ON rumen_objective_coverage (project, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_rumen_objective_coverage_drift
  ON rumen_objective_coverage (created_at DESC)
  WHERE drift = TRUE;

-- ---------------------------------------------------------------------------
-- rumen_objective_guard_jobs: one row per phase per pass.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS rumen_objective_guard_jobs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  phase           TEXT NOT NULL
                  CHECK (phase IN ('contradiction_scan', 'coverage_report', 'staleness_scan')),
  triggered_by    TEXT NOT NULL DEFAULT 'manual'
                  CHECK (triggered_by IN ('schedule', 'manual')),
  status          TEXT NOT NULL DEFAULT 'running'
                  CHECK (status IN ('running', 'done', 'failed', 'skipped')),

  -- How tier-0 was resolved for this pass: 'rpc' | 'table' | 'marker' |
  -- 'unavailable'. Stored per-pass because it is the first thing to check when
  -- a pass reports nothing: "found no contradictions" and "could not find the
  -- objectives" look identical from the flag count alone.
  tier0_source    TEXT,
  objectives_seen INTEGER NOT NULL DEFAULT 0 CHECK (objectives_seen >= 0),
  candidates      INTEGER NOT NULL DEFAULT 0 CHECK (candidates      >= 0),
  processed       INTEGER NOT NULL DEFAULT 0 CHECK (processed       >= 0),
  flags_written   INTEGER NOT NULL DEFAULT 0 CHECK (flags_written   >= 0),
  reports_written INTEGER NOT NULL DEFAULT 0 CHECK (reports_written >= 0),
  llm_calls_made  INTEGER NOT NULL DEFAULT 0 CHECK (llm_calls_made  >= 0),

  stats           JSONB NOT NULL DEFAULT '{}',
  note            TEXT,
  error_message   TEXT,
  started_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at    TIMESTAMPTZ
);

COMMENT ON TABLE rumen_objective_guard_jobs IS
  'Sprint 71 (B-T3): objective-guard run ledger, one row per phase per pass. '
  'status=''skipped'' + tier0_source=''unavailable'' is the expected steady '
  'state until engram 038 is applied and the crons are activated.';

CREATE INDEX IF NOT EXISTS idx_rumen_objective_guard_jobs_recent
  ON rumen_objective_guard_jobs (phase, started_at DESC);

-- ---------------------------------------------------------------------------
-- rumen_objective_scan: per-memory idempotency ledger (007's pattern).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS rumen_objective_scan (
  -- PK, so the ON CONFLICT upsert IS the idempotency mechanism rather than a
  -- convention layered on top of one.
  memory_id       UUID PRIMARY KEY REFERENCES memory_items(id) ON DELETE CASCADE,
  scanned_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  status          TEXT NOT NULL DEFAULT 'ok' CHECK (status IN ('ok', 'error')),
  -- Retires a poison item after N tries instead of re-paying for it nightly,
  -- forever, while leaving it queryable as a cohort.
  attempts        INT NOT NULL DEFAULT 1 CHECK (attempts >= 0),
  flags_written   INT NOT NULL DEFAULT 0 CHECK (flags_written >= 0),
  -- The objectives-set fingerprint this memory was judged against. When the
  -- project's objectives are RE-RATIFIED the fingerprint changes, and the
  -- memory becomes eligible for re-judgement — which is the correct behavior:
  -- "does this contradict?" has a different answer against different
  -- objectives, and a pure memory_id ledger would freeze the first answer
  -- forever.
  objectives_hash TEXT,
  error           TEXT
);

COMMENT ON TABLE rumen_objective_scan IS
  'Sprint 71 (B-T3): contradiction-scan idempotency ledger. Safe to DROP — '
  'doing so resets the scan to "nothing scanned" and touches no memory. '
  'objectives_hash makes re-ratification (not time) the re-scan trigger.';

CREATE INDEX IF NOT EXISTS idx_rumen_objective_scan_error
  ON rumen_objective_scan (attempts, scanned_at DESC)
  WHERE status = 'error';

-- ---------------------------------------------------------------------------
-- Gates 1/2/5, all four tables.
-- ---------------------------------------------------------------------------
ALTER TABLE rumen_objective_flags      ENABLE ROW LEVEL SECURITY;  -- [GATE 1]
ALTER TABLE rumen_objective_coverage   ENABLE ROW LEVEL SECURITY;  -- [GATE 1]
ALTER TABLE rumen_objective_guard_jobs ENABLE ROW LEVEL SECURITY;  -- [GATE 1]
ALTER TABLE rumen_objective_scan       ENABLE ROW LEVEL SECURITY;  -- [GATE 1]

-- [GATE 2] Deliberately NO policies on any of the four.

-- [GATE 5] Strip the default privileges Supabase hands anon/authenticated on
-- new public tables (engram migration 026 / rumen 007 precedent).
REVOKE ALL ON TABLE rumen_objective_flags      FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE rumen_objective_coverage   FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE rumen_objective_guard_jobs FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE rumen_objective_scan       FROM PUBLIC, anon, authenticated;

GRANT ALL ON TABLE rumen_objective_flags      TO service_role;
GRANT ALL ON TABLE rumen_objective_coverage   TO service_role;
GRANT ALL ON TABLE rumen_objective_guard_jobs TO service_role;
GRANT ALL ON TABLE rumen_objective_scan       TO service_role;

COMMIT;

-- ---------------------------------------------------------------------------
-- Post-apply verification (ORCH):
--
--   select relname, relrowsecurity from pg_class
--    where relname like 'rumen_objective%';                   -- expect 4 rows, all t
--   select count(*) from pg_policies
--    where tablename like 'rumen_objective%';                 -- expect 0
--   select grantee, table_name, privilege_type
--     from information_schema.role_table_grants
--    where table_name like 'rumen_objective%'
--      and grantee in ('anon','authenticated');               -- expect 0 rows
--
-- The lane ships DARK. Until ORCH activates the cron (migration 010) AND
-- RUMEN_OBJECTIVE_GUARD_ENABLED=1 is set on the Edge Function, these tables
-- stay empty and that is the correct state, not a failure:
--   select phase, status, tier0_source, count(*)
--     from rumen_objective_guard_jobs group by 1,2,3;         -- expect 0 rows
--
-- Once live, the operator's queue is:
--   select detected_at, project, flag_type, severity, objective_text, rationale
--     from rumen_objective_flags where status = 'open'
--    order by severity desc, detected_at desc limit 50;
--
-- And the drift board:
--   select project, window_days, memory_writes, linked_writes,
--          coverage_ratio, linkage_source, drift
--     from rumen_objective_coverage
--    where created_at > now() - interval '7 days'
--    order by drift desc nulls last, memory_writes desc;
-- ---------------------------------------------------------------------------
