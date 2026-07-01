// Rumen v0.1 Supabase Edge Function entry point.
//
// IMPORTANT: This file targets the Deno runtime, NOT Node. It will not
// compile under the root tsconfig.json — it is intentionally excluded.
// A sibling tsconfig.json in this directory keeps the types sane for
// editors, but the canonical build target is Deno's own type checker
// (`deno check`) and Supabase's `supabase functions deploy`.
//
// Dependencies are pulled via `npm:` specifiers, which Supabase Edge
// Functions support natively.
//
// Deployment:
//   supabase functions deploy rumen-tick
//   supabase secrets set DATABASE_URL="$DATABASE_URL"
//
// Triggered on a schedule by pg_cron — see migrations/002_pg_cron_schedule.sql.
//
// This function runs one Rumen job per invocation and returns a JSON summary.

// @ts-ignore  Deno std import resolved at runtime.
import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
// @ts-ignore  npm specifier resolved at runtime.
import { runRumenJob, createPoolFromUrl } from 'npm:@jhizzard/rumen@0.6.1';

// @ts-ignore  Deno global available at runtime.
declare const Deno: { env: { get: (k: string) => string | undefined } };

serve(async (_req: Request) => {
  // Supabase Edge Runtime auto-injects SUPABASE_DB_URL as a built-in env var.
  // Falling back to it removes one whole category of "where do I get the DB
  // connection string" from the install wizard. Brad surfaced this 2026-05-03
  // after hand-patching all four of his deployed copies.
  const url = Deno.env.get('DATABASE_URL') ?? Deno.env.get('SUPABASE_DB_URL');
  if (!url) {
    console.error('[rumen] DATABASE_URL / SUPABASE_DB_URL not set in Edge Function secrets');
    return new Response(
      JSON.stringify({
        ok: false,
        error: 'DATABASE_URL not set',
      }),
      {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      },
    );
  }

  const pool = createPoolFromUrl(url);

  // Watchdog: Supabase kills Edge Functions at 150s with an opaque 504.
  // runRumenJob has its own internal ~110s degradation budget (v0.6.1), but
  // if anything upstream of that hangs (e.g. an unreachable pooler on an old
  // package version), this race guarantees a real JSON error response before
  // the platform wall. Belt and suspenders.
  const watchdogMs = (() => {
    const raw = Deno.env.get('RUMEN_TICK_WATCHDOG_MS');
    const parsed = raw ? Number.parseInt(raw, 10) : NaN;
    return Number.isNaN(parsed) || parsed <= 0 ? 140_000 : parsed;
  })();
  let watchdogTimer: number | undefined;
  const watchdog = new Promise<never>((_, reject) => {
    watchdogTimer = setTimeout(
      () =>
        reject(
          new Error(
            'rumen-tick watchdog: job exceeded ' +
              watchdogMs +
              'ms — failing gracefully before the platform 150s kill',
          ),
        ),
      watchdogMs,
    ) as unknown as number;
  });

  try {
    console.log('[rumen] edge function tick starting');
    const summary = await Promise.race([
      runRumenJob(pool, {
        triggeredBy: 'schedule',
      }),
      watchdog,
    ]);
    console.log(
      '[rumen] edge function tick complete job_id=' +
        summary.job_id +
        ' status=' +
        summary.status,
    );

    return new Response(
      JSON.stringify({
        ok: summary.status === 'done',
        summary,
      }),
      {
        status: summary.status === 'done' ? 200 : 500,
        headers: { 'Content-Type': 'application/json' },
      },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[rumen] edge function tick threw:', err);
    return new Response(
      JSON.stringify({ ok: false, error: message }),
      {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      },
    );
  } finally {
    if (watchdogTimer !== undefined) {
      clearTimeout(watchdogTimer);
    }
    try {
      await pool.end();
    } catch (err) {
      console.error('[rumen] pool.end() failed:', err);
    }
  }
});
