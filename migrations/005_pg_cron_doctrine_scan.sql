-- Rumen Sprint 79 — doctrine-scan schedule
-- Schedules the doctrine-scan Supabase Edge Function to run daily via
-- pg_cron + pg_net, exactly the rumen-tick / inbox-promote pattern from
-- 002_pg_cron_schedule.sql / 003_pg_cron_inbox_promote.sql.
--
-- Scheduled at 03:30 UTC, after graph-inference's 03:00 UTC run (migration
-- 003_graph_inference_schedule.sql, bundled in termdeck's setup dir) — the
-- density clustering consumes graph-inference's memory_relationships edges,
-- so it needs that day's edges to have already landed.
--
-- Prerequisites:
--   1. pg_cron extension enabled (Database -> Extensions -> pg_cron).
--   2. pg_net extension enabled (needed for net.http_post).
--   3. migrations/004_doctrine_registry.sql applied (doctrine_registry /
--      doctrine_jobs tables) — the function no-ops loudly without them.
--   4. The doctrine-scan Edge Function deployed with a DATABASE_URL secret
--      and, optionally, ANTHROPIC_API_KEY (Phase A detection runs without
--      it; Phase B synthesis parks candidates at status='candidate' with a
--      doctrine_jobs.note until a key is available — never a hard skip).
--   5. Replace <project-ref> below with your actual Supabase project ref.
--   6. The service-role key stored in Supabase Vault under
--      'rumen_service_role_key' — reused from 002/003; if rumen-tick or
--      inbox-promote is already scheduled, there is nothing new to provision.
--
-- Apply with (ORCH at sprint close — never from a lane):
--   psql "$DIRECT_URL" -f migrations/005_pg_cron_doctrine_scan.sql

-- Remove any prior schedule with the same name so re-running is idempotent.
SELECT cron.unschedule('doctrine-scan')
  WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'doctrine-scan');

-- Schedule doctrine-scan daily at 03:30 UTC.
-- The body is empty JSON; the Edge Function reads its configuration from
-- its own function secrets, not from the request body.
SELECT cron.schedule(
  'doctrine-scan',
  '30 3 * * *',
  $$
    SELECT net.http_post(
      url     := 'https://<project-ref>.supabase.co/functions/v1/doctrine-scan',
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'rumen_service_role_key')
      ),
      body    := '{}'::jsonb
    );
  $$
);

-- Verify:
-- SELECT jobname, schedule, active FROM cron.job WHERE jobname = 'doctrine-scan';
