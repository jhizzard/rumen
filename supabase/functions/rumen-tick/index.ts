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
import { runRumenJob, createPoolFromUrl } from 'npm:@jhizzard/rumen@0.1.0';

// @ts-ignore  Deno global available at runtime.
declare const Deno: { env: { get: (k: string) => string | undefined } };

serve(async (_req: Request) => {
  const url = Deno.env.get('DATABASE_URL');
  if (!url) {
    console.error('[rumen] DATABASE_URL not set in Edge Function secrets');
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

  try {
    console.log('[rumen] edge function tick starting');
    const summary = await runRumenJob(pool, {
      triggeredBy: 'schedule',
    });
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
    try {
      await pool.end();
    } catch (err) {
      console.error('[rumen] pool.end() failed:', err);
    }
  }
});
