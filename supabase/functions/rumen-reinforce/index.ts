// Rumen Sprint 81 — rumen-reinforce Supabase Edge Function entry point.
//
// Runs ONE recall-feedback pass per invocation: reads recall telemetry
// (memory_items.recall_count/last_recalled_at denorm + memory_recall_log cited
// window, engram migrations 027/031) and writes a single bounded reinforcement
// weight per memory — memory_items.recall_boost — via the service-role
// set_recall_boost RPC (engram migration 032). See src/reinforce.ts in
// @jhizzard/rumen for the algorithm and the doctrine-clean write contract
// (recall_boost ONLY; never memory content).
//
// Sibling of rumen-tick / inbox-promote / doctrine-scan by design (NOT a step
// inside any of them): independent cadence, budget isolation, failure
// isolation. Same thin-wrapper pattern: the npm: specifier freezes the package
// version at DEPLOY time — upgrading @jhizzard/rumen does nothing until this
// function is redeployed (the Sprint 66 Brad-Rumen-zero lesson).
//
// IMPORTANT: This file targets the Deno runtime, NOT Node. It will not compile
// under the root tsconfig.json — it is intentionally excluded. A sibling
// tsconfig.json in this directory keeps the types sane for editors, but the
// canonical build target is Deno's own type checker (`deno check`) and
// Supabase's `supabase functions deploy`.
//
// Deployment (ORCH at sprint close — deployable, NOT deployed from a lane):
//   supabase functions deploy rumen-reinforce
//   supabase secrets set DATABASE_URL="$DATABASE_URL"   # Shared Pooler IPv4 URL
//   # Optional tuning (defaults shown):
//   supabase secrets set RUMEN_REINFORCE_WINDOW_DAYS=90
//   supabase secrets set RUMEN_REINFORCE_BATCH=500
//   supabase secrets set RUMEN_REINFORCE_MAX_BOOST=2.0
//   supabase secrets set RUMEN_REINFORCE_HALFLIFE_DAYS=30
//   supabase secrets set RUMEN_REINFORCE_ALPHA=0.5
//   supabase secrets set RUMEN_REINFORCE_DRY_RUN=1       # compute + log, no write
//
// No model key is required (reinforce makes no LLM calls). Requires engram
// migration 032 (recall_boost column + set_recall_boost RPC) to be applied.
//
// Triggered on a schedule by pg_cron — a schedule migration is a follow-on
// (ORCH/T3-owned, like the doctrine-scan cron); the function is safe to invoke
// manually meanwhile.

// @ts-ignore  Deno std import resolved at runtime.
import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
// @ts-ignore  npm specifier resolved at runtime. Version is stamped at
// publish/deploy time by ORCH at sprint close — must be >= 0.8.0, the first
// version exporting runRumenReinforce.
import { runRumenReinforce, createPoolFromUrl } from 'npm:@jhizzard/rumen@0.8.0';

// @ts-ignore  Deno global available at runtime.
declare const Deno: { env: { get: (k: string) => string | undefined } };

serve(async (_req: Request) => {
  // Same fallback as the sibling functions: Supabase auto-injects SUPABASE_DB_URL.
  const url = Deno.env.get('DATABASE_URL') ?? Deno.env.get('SUPABASE_DB_URL');
  if (!url) {
    console.error('[rumen-reinforce] DATABASE_URL / SUPABASE_DB_URL not set in Edge Function secrets');
    return new Response(
      JSON.stringify({ ok: false, error: 'DATABASE_URL not set' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } },
    );
  }

  const pool = createPoolFromUrl(url);

  // Watchdog: belt-and-suspenders alongside runRumenReinforce's own internal
  // wall-clock budget (RUMEN_REINFORCE_BUDGET_MS, default 110s). If anything
  // upstream of that guard hangs (an unreachable pooler, a stalled first query),
  // this race still returns a real JSON error before the platform's 150s kill —
  // the same fix rumen-tick shipped in v0.6.1 after 3+ days of silent 504s.
  const watchdogMs = (() => {
    const raw = Deno.env.get('RUMEN_REINFORCE_WATCHDOG_MS');
    const parsed = raw ? Number.parseInt(raw, 10) : NaN;
    return Number.isNaN(parsed) || parsed <= 0 ? 140_000 : parsed;
  })();
  let watchdogTimer: number | undefined;
  const watchdog = new Promise<never>((_, reject) => {
    watchdogTimer = setTimeout(
      () =>
        reject(
          new Error(
            'rumen-reinforce watchdog: pass exceeded ' +
              watchdogMs +
              'ms — failing gracefully before the platform 150s kill',
          ),
        ),
      watchdogMs,
    ) as unknown as number;
  });

  try {
    console.log('[rumen-reinforce] edge function pass starting');
    const summary = await Promise.race([runRumenReinforce(pool), watchdog]);
    console.log(
      '[rumen-reinforce] edge function pass complete status=' +
        summary.status +
        ' scanned=' +
        summary.candidates_scanned +
        ' written=' +
        summary.boosts_written +
        (summary.skipped_reason ? ' skipped=' + summary.skipped_reason : ''),
    );

    return new Response(
      JSON.stringify({ ok: summary.status === 'done', summary }),
      { status: summary.status === 'done' ? 200 : 500, headers: { 'Content-Type': 'application/json' } },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[rumen-reinforce] edge function pass threw:', err);
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
      console.error('[rumen-reinforce] pool.end() failed:', err);
    }
  }
});
