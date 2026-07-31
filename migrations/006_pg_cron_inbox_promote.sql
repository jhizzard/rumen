-- Rumen Sprint 84 (TermDeck T3) — inbox-promote schedule, RESTORED + reconciled
--
-- ── WHY THIS EXISTS WHEN 003 ALREADY DID THIS ──────────────────────────
--
-- Two problems, one migration.
--
-- (1) The schedule was never applied. Activation Day (2026-07-30) deployed
--     the `inbox-promote` Edge Function and DELIBERATELY left its pg_cron
--     unscheduled — supervised/ratify-first mode, so a human adjudicated the
--     first proposals before a timer did. Ground-truthed rather than assumed:
--     no job under either name exists in `cron.job`, and no such job appears
--     anywhere in `cron.job_run_details` history. It is "never scheduled," not
--     "unscheduled by accident."
--
--     That gate has now been satisfied — a proposal ran the full loop and was
--     correctly rejected — and the drain has to be running for the promotion
--     dry-run statistics to accumulate at all. Nothing about the promoter's
--     semantics changes here: it stays in report/dry-run posture, and the
--     auto-promote flip remains a separate, human-gated decision.
--
-- (2) The job had two names. Migration 003 registers `rumen-inbox-promote`
--     at `*/15`; the activation runbook's Part A §A3 registers `inbox-promote`
--     at `*/10`. Two names for one job is a live hazard, not a cosmetic one:
--     apply both and the promoter double-fires against the same inbox, while
--     each artifact's `cron.unschedule` cleans up only its own name and leaves
--     the other running. 003 already shipped inside the published package
--     tarball (`files: ["dist","migrations",...]`), so it cannot be edited in
--     place — this migration supersedes it and collapses BOTH names to one.
--
-- ── THE CANONICAL REGISTRATION ─────────────────────────────────────────
--
--   jobname  `rumen-inbox-promote`  — matches the shipped migration and the
--            `rumen-*` prefix already used by rumen-tick and rumen-reinforce.
--   schedule `*/10 * * * *`         — the runbook's cadence. NOT `*/15`: that
--            is rumen-tick's, and a promoter sharing it would contend with the
--            tick on the same pooler on every single firing. At `*/10` they
--            coincide twice an hour instead of always.
--
-- Idempotent and safe to re-run: both names are unscheduled first, so
-- re-applying (or applying after 003, or after a hand-run of the runbook
-- snippet) converges on exactly one job.
--
-- Prerequisites (unchanged from 003):
--   1. pg_cron + pg_net extensions enabled.
--   2. engram migration 026 (memory_inbox) applied.
--   3. The inbox-promote Edge Function deployed with DATABASE_URL,
--      OPENAI_API_KEY and ANTHROPIC_API_KEY secrets set. Without the model
--      keys the promoter returns 503 and leaves the inbox untouched rather
--      than burning promotion attempts — a scheduled 503 loop is harmless but
--      pointless, so deploy first.
--   4. Replace <project-ref> below with your actual Supabase project ref.
--   5. Service-role key in Supabase Vault under 'rumen_service_role_key'
--      (reused from 002/003/005 — nothing new to provision).
--
-- Apply with (ORCH at sprint close — never from a lane):
--   psql "$DIRECT_URL" -f migrations/006_pg_cron_inbox_promote.sql

-- Collapse BOTH historical names before scheduling. The runbook's name is
-- dropped even though this repo never wrote it: an install that followed the
-- runbook by hand has it, and that install is exactly the one that would
-- otherwise end up double-firing.
do $$
begin
  if exists (select 1 from cron.job where jobname = 'inbox-promote') then
    perform cron.unschedule('inbox-promote');
    raise notice '[006] unscheduled legacy runbook job name: inbox-promote';
  end if;
  if exists (select 1 from cron.job where jobname = 'rumen-inbox-promote') then
    perform cron.unschedule('rumen-inbox-promote');
  end if;
end$$;

SELECT cron.schedule(
  'rumen-inbox-promote',
  '*/10 * * * *',
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

-- Receipt: hard-fail if the collapse left more than one promoter registered.
-- The whole point of this migration is that exactly one exists afterwards.
do $$
declare
  v_count int;
begin
  select count(*)::int into v_count
    from cron.job
   where jobname in ('inbox-promote', 'rumen-inbox-promote');

  raise notice '[006] inbox-promote registrations after collapse: % (expect 1)', v_count;

  if v_count <> 1 then
    raise exception '[006] COLLAPSE FAILED: % inbox-promote registrations present (expected exactly 1)', v_count;
  end if;
end$$;

-- Verify:
-- SELECT jobname, schedule, active FROM cron.job WHERE jobname LIKE '%inbox-promote%';
--   expect exactly one row: rumen-inbox-promote | */10 * * * * | t
--
-- Then watch the drain actually drain:
-- SELECT * FROM public.memory_inbox_health;   -- engram migration 036
