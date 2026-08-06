-- Rumen Sprint 71 (TermDeck Deck B, B-T3) — rumen-objective-guard schedule.
--
-- Schedules the rumen-objective-guard Supabase Edge Function (contradiction
-- scan + objective-coverage report + objective-staleness flags) via pg_cron +
-- pg_net, the same pattern as 002 / 005 / 006 / 008.
--
-- ── THIS SHIPS DARK. THE UNSCHEDULE-THEN-DEACTIVATE IS THE POINT ────────
--
-- The job is registered and then IMMEDIATELY set active = false. Applying this
-- migration therefore changes nothing about what runs tonight — it only makes
-- activation a one-line UPDATE at the operator gate instead of an unreviewed
-- migration under time pressure later.
--
-- There are two independent switches and both must be thrown:
--   1. this cron row              →  UPDATE cron.job SET active = true ...
--   2. RUMEN_OBJECTIVE_GUARD_ENABLED=1 on the Edge Function
-- Either one alone is a no-op, deliberately. The contradiction scan makes
-- semantic judgements that land in a human review queue, and a queue that
-- starts filling before anyone has read a sample of its output is a queue that
-- gets closed unread — after which the feature exists and does nothing, which
-- is worse than not shipping it, because now everyone believes drift is being
-- watched.
--
-- Recommended activation order (ORCH, at the operator gate):
--   a. Deploy the function with RUMEN_OBJECTIVE_GUARD_ENABLED unset. Invoke it
--      by hand: it returns a `skipped` summary and proves the plumbing.
--   b. Set RUMEN_OBJECTIVE_DRY_RUN=1 and RUMEN_OBJECTIVE_GUARD_ENABLED=1, then
--      invoke by hand. It computes everything and writes NOTHING; read the
--      summary and judge the would-be flags.
--   c. Drop RUMEN_OBJECTIVE_DRY_RUN, invoke by hand once, read
--      rumen_objective_flags.
--   d. Only then activate the cron row.
--
-- ── SLOT: 05:00 UTC ─────────────────────────────────────────────────────
--
-- The 03:00–04:40 band is fully owned: graph-inference 03:00,
-- mnestra-recall-log-purge 03:17, doctrine-scan 03:30, rumen-reinforce 03:45,
-- graph-consolidation 04:00, inbox purge 04:20 (engram 036), extract-sweep
-- 04:40. 05:00 sits clear of all of them.
--
-- Ordering is not arbitrary: this runs LAST. The coverage report counts linkage
-- between the window's memories and tier-0 objectives, and extract-sweep
-- (04:40) is what creates a large share of the night's edges. Running before it
-- would measure coverage against a half-built graph and report drift that the
-- next twenty minutes was about to disprove — a false drift signal is the one
-- output this lane must not produce, since the whole point is that an operator
-- can trust a flag.
--
-- Prerequisites:
--   1. pg_cron + pg_net extensions enabled.
--   2. migrations/009_objective_guard.sql applied (the four rumen_objective_*
--      tables). Without them every phase fails at its first write.
--   3. engram migration 038 applied (the tier-0 objectives store). Without it
--      every phase reports status='skipped', tier0_source='unavailable' — which
--      is a correct, legible no-op, not a failure. The guard is deliberately
--      appliable and deployable BEFORE 038 lands.
--   4. The rumen-objective-guard Edge Function deployed with a DATABASE_URL
--      secret. ANTHROPIC_API_KEY is required for the contradiction scan only;
--      without it that phase skips (and deliberately does NOT stamp its ledger,
--      so nothing is silently marked judged) while coverage + staleness still
--      run, since neither uses a model.
--   5. Replace <project-ref> below with your actual Supabase project ref.
--   6. Service-role key in Supabase Vault under 'rumen_service_role_key'
--      (reused from 002/003/005/006/008 — nothing new to provision).
--
-- Apply with (ORCH at sprint close — never from a lane):
--   psql "$DIRECT_URL" -f migrations/010_pg_cron_objective_guard.sql

-- Remove any prior schedule with the same name so re-running is idempotent.
SELECT cron.unschedule('rumen-objective-guard')
  WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'rumen-objective-guard');

SELECT cron.schedule(
  'rumen-objective-guard',
  '0 5 * * *',
  $$
    SELECT net.http_post(
      url     := 'https://<project-ref>.supabase.co/functions/v1/rumen-objective-guard',
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'rumen_service_role_key')
      ),
      body    := '{}'::jsonb
    );
  $$
);

-- ── DARK ────────────────────────────────────────────────────────────────
-- Registered above, disabled here, in the same transaction-less script the
-- operator applies. cron.schedule() has no `active` parameter, so this UPDATE
-- is the only way to register a job without arming it.
UPDATE cron.job SET active = false WHERE jobname = 'rumen-objective-guard';

-- Verify it is present AND dark (expect exactly one row, active = f):
-- SELECT jobname, schedule, active FROM cron.job WHERE jobname = 'rumen-objective-guard';

-- ---------------------------------------------------------------------------
-- ACTIVATION (operator gate — NOT part of applying this migration):
--
--   UPDATE cron.job SET active = true WHERE jobname = 'rumen-objective-guard';
--
-- DEACTIVATION (instant kill switch, no migration, no redeploy):
--
--   UPDATE cron.job SET active = false WHERE jobname = 'rumen-objective-guard';
--
-- Post-activation, the three things worth watching:
--
--   -- 1. Did each phase actually run, and did it find the objectives?
--   SELECT phase, status, tier0_source, objectives_seen, candidates,
--          flags_written, reports_written, llm_calls_made, note, started_at
--     FROM rumen_objective_guard_jobs
--    ORDER BY started_at DESC LIMIT 12;
--
--   -- 2. The operator's queue. If this is empty AND tier0_source above says
--   --    'unavailable', the guard is not finding tier-0 — that is a wiring
--   --    problem, not a clean bill of health.
--   SELECT detected_at, project, flag_type, severity, objective_text, rationale
--     FROM rumen_objective_flags
--    WHERE status = 'open'
--    ORDER BY severity DESC, detected_at DESC LIMIT 50;
--
--   -- 3. The drift board. drift IS NULL means undetermined, NOT "no drift".
--   SELECT project, memory_writes, linked_writes, coverage_ratio,
--          linkage_source, drift, note
--     FROM rumen_objective_coverage
--    WHERE created_at > now() - interval '7 days'
--    ORDER BY drift DESC NULLS LAST, memory_writes DESC;
-- ---------------------------------------------------------------------------
