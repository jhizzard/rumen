-- Rumen v0.1 schedule
-- Schedules the rumen-tick Supabase Edge Function to run every 15 minutes
-- via pg_cron + pg_net.
--
-- Before applying:
--   1. Enable the pg_cron extension in the Supabase dashboard:
--        Database -> Extensions -> pg_cron (toggle on)
--   2. Enable the pg_net extension the same way (needed for net.http_post).
--   3. Replace <project-ref> below with your actual Supabase project ref.
--   4. Replace <service-role-jwt> below with a service-role key stored in
--      Supabase Vault, NOT pasted inline. The SELECT below shows the Vault
--      pattern; delete the inline-key variant before running.
--
-- Apply with:
--   psql "$DIRECT_URL" -f migrations/002_pg_cron_schedule.sql

-- Remove any prior schedule with the same name so re-running is idempotent.
SELECT cron.unschedule('rumen-tick')
  WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'rumen-tick');

-- Schedule rumen-tick every 15 minutes.
-- The body is empty JSON; the Edge Function reads DATABASE_URL from its
-- own function secrets, not from the request body.
SELECT cron.schedule(
  'rumen-tick',
  '*/15 * * * *',
  $$
    SELECT net.http_post(
      url     := 'https://<project-ref>.supabase.co/functions/v1/rumen-tick',
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'rumen_service_role_key')
      ),
      body    := '{}'::jsonb
    );
  $$
);

-- Verify:
-- SELECT jobname, schedule, active FROM cron.job WHERE jobname = 'rumen-tick';
