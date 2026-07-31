-- Rumen Sprint 84 (TermDeck T3) — rumen-extract-sweep schedule.
--
-- Schedules the rumen-extract-sweep Supabase Edge Function (the write-time-
-- extraction backstop) via pg_cron + pg_net, the same pattern as
-- 002_pg_cron_schedule.sql / 005_pg_cron_doctrine_scan.sql.
--
-- Scheduled at 04:40 UTC. The 03:00–04:00 band is fully owned
-- (graph-inference 03:00, mnestra-recall-log-purge 03:17, doctrine-scan 03:30,
-- rumen-reinforce 03:45) and 04:00 is graph-consolidation's; 04:20 is the
-- inbox purge (engram migration 036). 04:40 sits clear of all of them.
--
-- Ordering note, and it is not arbitrary: the sweep runs AFTER
-- graph-consolidation rather than before it. Consolidation reads the entity
-- graph, so a sweep landing entities immediately before it would hand it a
-- half-built night's worth of structure — entities from a partial batch, with
-- the rest arriving tomorrow. Running after means consolidation always reads a
-- graph that has been stable since the previous sweep completed, and the
-- sweep's output is consumed a full day later, whole.
--
-- ── ON CADENCE AND BACKLOG ──────────────────────────────────────────────
--
-- One nightly pass is budget-capped (RUMEN_SWEEP_BUDGET_MS, default 110s under
-- the platform's 150s wall), so on a store with a large unswept backlog it
-- makes partial progress and the ledger keeps it. That is the intended steady
-- state, not a limitation to work around: new memories are always swept within
-- a day because selection is newest-first.
--
-- To drain a historical backlog faster, invoke the function by hand in a loop
-- — it is idempotent and budget-capped, so repeated invocation is safe and
-- each pass simply picks up where the last one stopped:
--   for i in $(seq 20); do
--     curl -s -X POST "https://<project-ref>.supabase.co/functions/v1/rumen-extract-sweep" \
--       -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" \
--       -H 'Content-Type: application/json' -d '{}' | jq -c '.summary';
--   done
-- Widen RUMEN_SWEEP_LOOKBACK_DAYS first if the backlog predates the window.
--
-- Prerequisites:
--   1. pg_cron + pg_net extensions enabled.
--   2. migrations/007_extraction_sweep_ledger.sql applied (the sweep skips
--      loudly without the ledger — there is no point scheduling it first).
--   3. engram migration 034 applied (upsert_memory_entities /
--      upsert_memory_edges + the two vocabulary tables).
--   4. The rumen-extract-sweep Edge Function deployed with a DATABASE_URL
--      secret and ANTHROPIC_API_KEY. Without the model key the pass still runs
--      and still writes the deterministic same_pattern_as edges — it just
--      extracts no entities, which is a degraded pass, not a failed one.
--   5. Replace <project-ref> below with your actual Supabase project ref.
--   6. Service-role key in Supabase Vault under 'rumen_service_role_key'
--      (reused from 002/003/005/006 — nothing new to provision).
--
-- Apply with (ORCH at sprint close — never from a lane):
--   psql "$DIRECT_URL" -f migrations/008_pg_cron_extract_sweep.sql

-- Remove any prior schedule with the same name so re-running is idempotent.
SELECT cron.unschedule('rumen-extract-sweep')
  WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'rumen-extract-sweep');

SELECT cron.schedule(
  'rumen-extract-sweep',
  '40 4 * * *',
  $$
    SELECT net.http_post(
      url     := 'https://<project-ref>.supabase.co/functions/v1/rumen-extract-sweep',
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'rumen_service_role_key')
      ),
      body    := '{}'::jsonb
    );
  $$
);

-- Verify:
-- SELECT jobname, schedule, active FROM cron.job WHERE jobname = 'rumen-extract-sweep';
--
-- Then watch it actually produce a graph (expect these to leave zero):
-- SELECT (SELECT count(*) FROM memory_entities)         AS entities,
--        (SELECT count(*) FROM memory_entity_mentions)  AS mentions,
--        (SELECT count(*) FROM rumen_extraction_sweep)  AS swept;
