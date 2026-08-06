// Rumen Sprint 71 (TermDeck Deck B, B-T3) — rumen-objective-guard Edge Function.
//
// Runs ONE anti-drift pass per invocation, three phases against one latched
// tier-0 resolution:
//   1. contradiction scan  — new decisions vs the project's tier-0 objectives;
//                            semantic opposition raises a FLAG.
//   2. coverage report     — sustained activity with zero tier-0 linkage.
//   3. staleness scan      — objectives past a ratification-age threshold.
//
// It FLAGS and never resolves. Objectives are mutable only via explicit
// ratification, so this function's entire write surface is the four
// rumen-owned tables from migration 009. It issues no UPDATE, INSERT or DELETE
// against memory_items, memory_sessions, memory_relationships, or the tier-0
// store — see src/objective-guard.ts's header for why that boundary is the
// whole design and not a precaution.
//
// DARK BY DEFAULT. Two independent switches, BOTH required:
//   1. RUMEN_OBJECTIVE_GUARD_ENABLED=1 in this function's secrets
//   2. the pg_cron row activated (migration 010 registers it active = false)
// With neither thrown, invoking this returns 200 and a `skipped` summary. That
// is the shipped state for Sprint 71; ORCH activates at the operator gate.
//
// It is SAFE and useful to deploy before engram migration 038 exists: with no
// tier-0 store the phases report status='skipped', tier0_source='unavailable',
// which is a legible no-op rather than a failure — and is exactly how you prove
// the plumbing before there is anything to guard.
//
// Sibling of rumen-tick / inbox-promote / doctrine-scan / rumen-reinforce /
// graph-consolidation / rumen-extract-sweep by design, NOT a phase inside any
// of them: one model call per candidate against the tick's 110s whole-job
// budget would starve the insight phases and the symptom would present as
// "insights stopped", pointing at the wrong function entirely. Every knob is
// namespaced RUMEN_OBJECTIVE_*, disjoint from every sibling's.
//
// IMPORTANT: This file targets the Deno runtime, NOT Node. It will not compile
// under the root tsconfig.json — it is intentionally excluded. The sibling
// tsconfig.json in this directory keeps the types sane for editors; the
// canonical build target is Deno's own type checker and `supabase functions
// deploy`.
//
// Deployment (ORCH at sprint close — deployable, NOT deployed from a lane):
//   supabase functions deploy rumen-objective-guard
//   supabase secrets set DATABASE_URL="$DATABASE_URL"       # Shared Pooler IPv4 URL
//   supabase secrets set ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY"
//   # Activation (operator gate — deliberately NOT set at deploy time):
//   supabase secrets set RUMEN_OBJECTIVE_GUARD_ENABLED=1
//   # Recommended first live run — computes everything, writes nothing:
//   supabase secrets set RUMEN_OBJECTIVE_DRY_RUN=1
//   # Optional tuning (defaults shown):
//   supabase secrets set RUMEN_OBJECTIVE_LOOKBACK_DAYS=14
//   supabase secrets set RUMEN_OBJECTIVE_BATCH=60
//   supabase secrets set RUMEN_OBJECTIVE_BUDGET_MS=110000
//   supabase secrets set RUMEN_OBJECTIVE_CONCURRENCY=3
//   supabase secrets set RUMEN_OBJECTIVE_MAX_LLM_CALLS=40
//   supabase secrets set RUMEN_OBJECTIVE_COVERAGE_WINDOW_DAYS=7
//   supabase secrets set RUMEN_OBJECTIVE_COVERAGE_MIN_WRITES=20
//   supabase secrets set RUMEN_OBJECTIVE_STALENESS_DAYS=180
//   supabase secrets set RUMEN_OBJECTIVE_FLAG_UNRATIFIED=1   # noisy; see module header
//   # Tier-0 accessor overrides — one of these is the single change needed when
//   # engram 038 posts its final marker:
//   supabase secrets set RUMEN_TIER0_RPC=objective_list
//   supabase secrets set RUMEN_TIER0_TABLE=memory_objectives
//   supabase secrets set RUMEN_TIER0_MARKER_COLUMN=tier
//
// Triggered on a schedule by pg_cron — migrations/010_pg_cron_objective_guard.sql
// (05:00 UTC, deliberately AFTER extract-sweep so coverage is never measured
// against a half-built night's graph). Safe to invoke manually meanwhile;
// every phase is idempotent (flag inserts are ON CONFLICT DO NOTHING on a
// dedup key, and the contradiction ledger re-judges only when a project's
// objective SET changes).

// @ts-ignore  Deno std import resolved at runtime.
import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
// @ts-ignore  npm specifier resolved at runtime. Version is stamped at
// publish/deploy time by ORCH at sprint close — must be >= the first version
// exporting runObjectiveGuard.
import { runObjectiveGuard, createPoolFromUrl } from 'npm:@jhizzard/rumen@0.11.1';

// @ts-ignore  Deno global available at runtime.
declare const Deno: { env: { get: (k: string) => string | undefined } };

serve(async (_req: Request) => {
  // Same fallback as the sibling functions: Supabase auto-injects SUPABASE_DB_URL.
  const url = Deno.env.get('DATABASE_URL') ?? Deno.env.get('SUPABASE_DB_URL');
  if (!url) {
    console.error('[rumen-objective-guard] DATABASE_URL / SUPABASE_DB_URL not set in Edge Function secrets');
    return new Response(
      JSON.stringify({ ok: false, error: 'DATABASE_URL not set' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } },
    );
  }

  const pool = createPoolFromUrl(url);

  // Watchdog: belt-and-suspenders alongside runObjectiveGuard's own internal
  // wall-clock budget (RUMEN_OBJECTIVE_BUDGET_MS, default 110s). If anything
  // upstream of that guard hangs (an unreachable pooler, a stalled first
  // query), this race still returns a real JSON error before the platform's
  // 150s kill — the same fix rumen-tick shipped in v0.6.1 after 3+ days of
  // silent 504s.
  const watchdogMs = (() => {
    const raw = Deno.env.get('RUMEN_OBJECTIVE_WATCHDOG_MS');
    const parsed = raw ? Number.parseInt(raw, 10) : NaN;
    return Number.isNaN(parsed) || parsed <= 0 ? 140_000 : parsed;
  })();
  let watchdogTimer: number | undefined;
  const watchdog = new Promise<never>((_, reject) => {
    watchdogTimer = setTimeout(
      () =>
        reject(
          new Error(
            'rumen-objective-guard watchdog: pass exceeded ' +
              watchdogMs +
              'ms — failing gracefully before the platform 150s kill',
          ),
        ),
      watchdogMs,
    ) as unknown as number;
  });

  try {
    console.log('[rumen-objective-guard] edge function pass starting');
    const summary = await Promise.race([
      runObjectiveGuard(pool, { triggeredBy: 'schedule' }),
      watchdog,
    ]);
    console.log(
      '[rumen-objective-guard] edge function pass complete ok=' +
        summary.ok +
        ' enabled=' +
        summary.enabled +
        ' tier0=' +
        summary.tier0_source +
        ' phases=' +
        summary.phases.map((p) => p.phase + ':' + p.status).join(',') +
        ' flags=' +
        summary.phases.reduce((n, p) => n + p.flags_written, 0) +
        ' reports=' +
        summary.phases.reduce((n, p) => n + p.reports_written, 0) +
        ' llmCalls=' +
        summary.phases.reduce((n, p) => n + p.llm_calls_made, 0) +
        (summary.note ? ' note=' + summary.note : ''),
    );

    // 200 for a DARK pass, unlike the sweep's capability-skip-is-a-500 rule.
    // Being off is the shipped, intended state here, and a nightly 500 in the
    // cron history for "working as designed" is how a real 500 later gets
    // ignored. A phase that genuinely FAILED still flips summary.ok false and
    // still 500s.
    return new Response(
      JSON.stringify({ ok: summary.ok, summary }),
      { status: summary.ok ? 200 : 500, headers: { 'Content-Type': 'application/json' } },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[rumen-objective-guard] edge function pass threw:', err);
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
      console.error('[rumen-objective-guard] pool.end() failed:', err);
    }
  }
});
