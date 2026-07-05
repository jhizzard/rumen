// Rumen Sprint 79 — doctrine-scan Supabase Edge Function entry point.
//
// DB-side density clustering over the curated memory pool (decision /
// architecture / preference / bug_fix) -> Haiku synthesis ->
// doctrine_registry staging rows. Detect + draft ONLY — this pass never
// writes memory_items; ratification and the memory_items flow-back are
// Sprint 79 T3's job (termdeck `doctrine ratify`). See
// src/doctrine-scan.ts in @jhizzard/rumen for the full algorithm.
//
// Sibling of rumen-tick and inbox-promote by design (NOT a step inside
// either): independent cadence, budget isolation, failure isolation. Same
// thin-wrapper pattern: the npm: specifier freezes the package version at
// DEPLOY time — upgrading @jhizzard/rumen does nothing until this function
// is redeployed (the Sprint 66 Brad-Rumen-zero lesson).
//
// IMPORTANT: This file targets the Deno runtime, NOT Node. It will not
// compile under the root tsconfig.json — it is intentionally excluded.
// A sibling tsconfig.json in this directory keeps the types sane for
// editors, but the canonical build target is Deno's own type checker
// (`deno check`) and Supabase's `supabase functions deploy`.
//
// Deployment (ORCH at sprint close — deployable, NOT deployed from a lane):
//   supabase functions deploy doctrine-scan
//   supabase secrets set DATABASE_URL="$DATABASE_URL"           # Shared Pooler IPv4 URL
//   supabase secrets set ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" # Phase B synthesis; Phase A detection runs without it
//   # Optional tuning (defaults shown):
//   supabase secrets set DOCTRINE_SCAN_MAX_LLM_CALLS=10
//   supabase secrets set DOCTRINE_SCAN_BUDGET_MS=110000
//   supabase secrets set RUMEN_LLM_TIMEOUT_MS=30000
//
// Missing ANTHROPIC_API_KEY is NOT a skip (unlike inbox-promote's two
// required keys): Phase A detection is valuable on its own and always
// runs; new candidates simply park at status='candidate' with
// doctrine_jobs.note='no_api_key_phase_b_skipped' until a key is available.
//
// Triggered on a schedule by pg_cron — see the doctrine-scan cron migration
// (HANDOFF-REQUEST to T3: packages/cli/src/init-rumen.js's
// SCHEDULE_MIGRATIONS table only matches 002/003 today; a new matcher entry
// is a termdeck-owned edit).

// @ts-ignore  Deno std import resolved at runtime.
import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
// @ts-ignore  npm specifier resolved at runtime. Version is stamped at
// publish/deploy time by ORCH at sprint close — must be >= 0.7.0, the first
// version exporting runDoctrineScan.
import { runDoctrineScan, createPoolFromUrl } from 'npm:@jhizzard/rumen@0.7.0';

// @ts-ignore  Deno global available at runtime.
declare const Deno: { env: { get: (k: string) => string | undefined } };

serve(async (_req: Request) => {
  // Same fallback as rumen-tick / inbox-promote: Supabase auto-injects
  // SUPABASE_DB_URL.
  const url = Deno.env.get('DATABASE_URL') ?? Deno.env.get('SUPABASE_DB_URL');
  if (!url) {
    console.error('[rumen-doctrine-scan] DATABASE_URL / SUPABASE_DB_URL not set in Edge Function secrets');
    return new Response(
      JSON.stringify({ ok: false, error: 'DATABASE_URL not set' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } },
    );
  }

  const pool = createPoolFromUrl(url);

  // Watchdog: belt-and-suspenders alongside runDoctrineScan's own internal
  // wall-clock budget (DOCTRINE_SCAN_BUDGET_MS, default 110s). If anything
  // upstream of that guard hangs (an unreachable pooler, a stalled first
  // query before the deadline check is ever consulted), this race still
  // returns a real JSON error before the platform's 150s kill — the same
  // fix rumen-tick shipped in v0.6.1 after 3+ days of silent 504s in the
  // field.
  const watchdogMs = (() => {
    const raw = Deno.env.get('DOCTRINE_SCAN_WATCHDOG_MS');
    const parsed = raw ? Number.parseInt(raw, 10) : NaN;
    return Number.isNaN(parsed) || parsed <= 0 ? 140_000 : parsed;
  })();
  let watchdogTimer: number | undefined;
  const watchdog = new Promise<never>((_, reject) => {
    watchdogTimer = setTimeout(
      () =>
        reject(
          new Error(
            'doctrine-scan watchdog: scan exceeded ' +
              watchdogMs +
              'ms — failing gracefully before the platform 150s kill',
          ),
        ),
      watchdogMs,
    ) as unknown as number;
  });

  try {
    console.log('[rumen-doctrine-scan] edge function scan starting');
    const summary = await Promise.race([
      runDoctrineScan(pool, { triggeredBy: 'schedule' }),
      watchdog,
    ]);
    console.log(
      '[rumen-doctrine-scan] edge function scan complete job_id=' +
        summary.job_id +
        ' status=' +
        summary.status +
        ' drafted=' +
        summary.candidates_drafted +
        ' reinforced=' +
        summary.candidates_reinforced,
    );

    return new Response(
      JSON.stringify({ ok: summary.status === 'done', summary }),
      { status: summary.status === 'done' ? 200 : 500, headers: { 'Content-Type': 'application/json' } },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[rumen-doctrine-scan] edge function scan threw:', err);
    return new Response(
      JSON.stringify({ ok: false, error: message }),
      { status: 500, headers: { 'Content-Type': 'application/json' } },
    );
  } finally {
    if (watchdogTimer !== undefined) {
      clearTimeout(watchdogTimer);
    }
    try {
      await pool.end();
    } catch (err) {
      console.error('[rumen-doctrine-scan] pool.end() failed:', err);
    }
  }
});
