// Rumen Sprint 84 — rumen-extract-sweep Supabase Edge Function entry point.
//
// Runs ONE write-time-extraction backstop pass per invocation: finds memories
// that never had their entities and typed edges extracted, extracts them, and
// persists through engram migration 034's drop-invalid RPCs
// (upsert_memory_entities / upsert_memory_edges). See src/extract-sweep.ts in
// @jhizzard/rumen for why the backstop is necessary at all — the short version
// is that write-time extraction only covers writes that go through one
// TypeScript function, and the SQL-direct capture path (ingest_capture) and
// the promotion path both structurally cannot.
//
// It writes NOTHING to memory_items. Entities, mentions, same_pattern_as edges
// and its own rumen_extraction_sweep ledger are the entire write surface.
//
// Sibling of rumen-tick / inbox-promote / doctrine-scan / rumen-reinforce /
// graph-consolidation by design (NOT a step inside any of them): one model call
// per item against the tick's 110s whole-job budget would starve the insight
// phases, and the symptom would present as "insights stopped" — pointing at the
// wrong function. Same thin-wrapper pattern as its siblings: the npm: specifier
// freezes the package version at DEPLOY time, so upgrading @jhizzard/rumen does
// nothing until this function is redeployed (the Sprint 66 Brad-Rumen-zero
// lesson).
//
// IMPORTANT: This file targets the Deno runtime, NOT Node. It will not compile
// under the root tsconfig.json — it is intentionally excluded. The sibling
// tsconfig.json in this directory keeps the types sane for editors; the
// canonical build target is Deno's own type checker and `supabase functions
// deploy`.
//
// Deployment (ORCH at sprint close — deployable, NOT deployed from a lane):
//   supabase functions deploy rumen-extract-sweep
//   supabase secrets set DATABASE_URL="$DATABASE_URL"       # Shared Pooler IPv4 URL
//   supabase secrets set ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY"
//   # Optional tuning (defaults shown):
//   supabase secrets set RUMEN_SWEEP_LOOKBACK_DAYS=30
//   supabase secrets set RUMEN_SWEEP_BATCH=150
//   supabase secrets set RUMEN_SWEEP_BUDGET_MS=110000
//   supabase secrets set RUMEN_SWEEP_ITEM_BUDGET_MS=8000
//   supabase secrets set RUMEN_SWEEP_CONCURRENCY=4
//   supabase secrets set RUMEN_SWEEP_MAX_ATTEMPTS=3
//   supabase secrets set RUMEN_SWEEP_DRY_RUN=1              # report only, no writes
//
// ANTHROPIC_API_KEY is OPTIONAL but strongly recommended: without it the pass
// still runs and still writes the deterministic same_pattern_as edges (no model
// involved), it just extracts no entities. That is a degraded pass, not a
// failed one, and it reports as such.
//
// Requires rumen migration 007 (rumen_extraction_sweep ledger) and engram
// migration 034 (the RPCs + vocabulary tables). Without either, the pass skips
// loudly with a capability reason rather than half-working.
//
// Triggered on a schedule by pg_cron — migrations/008_pg_cron_extract_sweep.sql
// (04:40 UTC, deliberately AFTER graph-consolidation so consolidation always
// reads a graph that has been stable since the previous sweep). The function is
// safe to invoke manually meanwhile, and repeated manual invocation is the
// supported way to drain a historical backlog.

// @ts-ignore  Deno std import resolved at runtime.
import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
// @ts-ignore  npm specifier resolved at runtime. Version is stamped at
// publish/deploy time by ORCH at sprint close — must be >= the first version
// exporting runExtractionSweep.
import { runExtractionSweep, createPoolFromUrl } from 'npm:@jhizzard/rumen@0.11.0';

// @ts-ignore  Deno global available at runtime.
declare const Deno: { env: { get: (k: string) => string | undefined } };

serve(async (_req: Request) => {
  // Same fallback as the sibling functions: Supabase auto-injects SUPABASE_DB_URL.
  const url = Deno.env.get('DATABASE_URL') ?? Deno.env.get('SUPABASE_DB_URL');
  if (!url) {
    console.error('[rumen-extract-sweep] DATABASE_URL / SUPABASE_DB_URL not set in Edge Function secrets');
    return new Response(
      JSON.stringify({ ok: false, error: 'DATABASE_URL not set' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } },
    );
  }

  const pool = createPoolFromUrl(url);

  // Watchdog: belt-and-suspenders alongside runExtractionSweep's own internal
  // wall-clock budget (RUMEN_SWEEP_BUDGET_MS, default 110s). If anything
  // upstream of that guard hangs (an unreachable pooler, a stalled first
  // query), this race still returns a real JSON error before the platform's
  // 150s kill — the same fix rumen-tick shipped in v0.6.1 after 3+ days of
  // silent 504s.
  const watchdogMs = (() => {
    const raw = Deno.env.get('RUMEN_SWEEP_WATCHDOG_MS');
    const parsed = raw ? Number.parseInt(raw, 10) : NaN;
    return Number.isNaN(parsed) || parsed <= 0 ? 140_000 : parsed;
  })();
  let watchdogTimer: number | undefined;
  const watchdog = new Promise<never>((_, reject) => {
    watchdogTimer = setTimeout(
      () =>
        reject(
          new Error(
            'rumen-extract-sweep watchdog: pass exceeded ' +
              watchdogMs +
              'ms — failing gracefully before the platform 150s kill',
          ),
        ),
      watchdogMs,
    ) as unknown as number;
  });

  try {
    console.log('[rumen-extract-sweep] edge function pass starting');
    const summary = await Promise.race([runExtractionSweep(pool), watchdog]);
    console.log(
      '[rumen-extract-sweep] edge function pass complete ok=' +
        summary.ok +
        ' candidates=' +
        summary.candidates +
        ' processed=' +
        summary.processed +
        ' entities=' +
        summary.entities_written +
        ' edges=' +
        summary.same_pattern_edges +
        ' triples=' +
        summary.triples_found +
        ' failed=' +
        summary.failed +
        (summary.skipped_budget ? ' skipped_budget=' + summary.skipped_budget : '') +
        (summary.skipped_reason ? ' skipped=' + summary.skipped_reason : ''),
    );

    // A capability skip is a 500 so a silent no-op cannot look like a healthy
    // pass in the cron history — the Sprint 66 lesson that a job returning 200
    // while doing nothing is the hardest kind of outage to notice.
    return new Response(
      JSON.stringify({ ok: summary.ok, summary }),
      { status: summary.ok ? 200 : 500, headers: { 'Content-Type': 'application/json' } },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[rumen-extract-sweep] edge function pass threw:', err);
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
      console.error('[rumen-extract-sweep] pool.end() failed:', err);
    }
  }
});
