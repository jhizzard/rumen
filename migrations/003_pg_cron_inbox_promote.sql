-- Rumen Sprint 76 — inbox-promote schedule
-- Schedules the inbox-promote Supabase Edge Function (the memory_inbox
-- promotion pass) to run every 15 minutes via pg_cron + pg_net, exactly the
-- rumen-tick pattern from 002_pg_cron_schedule.sql.
--
-- The promotion pass is the async customs check behind the Sprint 76 policy
-- "CLIs write canonical; web chats write proposals": a proposal becomes
-- recallable on THIS cadence, or never (rejected). The latency is the
-- accepted design — do not tighten the schedule to fake synchrony.
--
-- Prerequisites (same as 002 — already satisfied on any install that runs
-- rumen-tick):
--   1. pg_cron extension enabled (Database -> Extensions -> pg_cron).
--   2. pg_net extension enabled (needed for net.http_post).
--   3. engram migration 026 (memory_inbox) applied — the function no-ops
--      loudly without the table, but there is no point scheduling it first.
--   4. The inbox-promote Edge Function deployed with DATABASE_URL,
--      OPENAI_API_KEY, and ANTHROPIC_API_KEY secrets set (see the function
--      header for the full list).
--   5. Replace <project-ref> below with your actual Supabase project ref.
--   6. The service-role key stored in Supabase Vault under
--      'rumen_service_role_key' — reused from 002; if rumen-tick is already
--      scheduled, there is nothing new to provision.
--
-- Apply with (ORCH at sprint close — never from a lane):
--   psql "$DIRECT_URL" -f migrations/003_pg_cron_inbox_promote.sql

-- Remove any prior schedule with the same name so re-running is idempotent.
SELECT cron.unschedule('rumen-inbox-promote')
  WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'rumen-inbox-promote');

-- Schedule inbox-promote every 15 minutes.
-- The body is empty JSON; the Edge Function reads its configuration from
-- its own function secrets, not from the request body.
SELECT cron.schedule(
  'rumen-inbox-promote',
  '*/15 * * * *',
  $$
    SELECT net.http_post(
      url     := 'https://<project-ref>.supabase.co/functions/v1/inbox-promote',
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'rumen_service_role_key')
      ),
      body    := '{}'::jsonb
    );
  $$
);

-- Verify:
-- SELECT jobname, schedule, active FROM cron.job WHERE jobname = 'rumen-inbox-promote';
