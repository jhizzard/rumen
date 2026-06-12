// Rumen Sprint 76 — inbox-promote Supabase Edge Function entry point.
//
// Drains Mnestra's memory_inbox quarantine: web-chat proposals (written via
// the bridge's memory_propose channel into engram migration 026's table) are
// promoted to canonical memory_items or rejected with an audit trail. One
// promotion pass per invocation; see src/promote.ts in @jhizzard/rumen for
// the gate sequence (caps -> source whitelist -> rate cap -> dedup ->
// kitchen-vs-recipe) and the doctrine amendment notes.
//
// Sibling of rumen-tick by design (NOT a step inside it): budget isolation
// (the tick already spends its wall-clock on the insight cycle), independent
// cadence, and failure isolation. Same thin-wrapper pattern: the npm:
// specifier freezes the package version at DEPLOY time — upgrading
// @jhizzard/rumen does nothing until this function is redeployed (the
// Sprint 66 Brad-Rumen-zero lesson).
//
// IMPORTANT: This file targets the Deno runtime, NOT Node. It will not
// compile under the root tsconfig.json — it is intentionally excluded.
// A sibling tsconfig.json in this directory keeps the types sane for
// editors, but the canonical build target is Deno's own type checker
// (`deno check`) and Supabase's `supabase functions deploy`.
//
// Deployment (ORCH at sprint close — deployable, NOT deployed from a lane):
//   supabase functions deploy inbox-promote
//   supabase secrets set DATABASE_URL="$DATABASE_URL"          # Shared Pooler IPv4 URL
//   supabase secrets set OPENAI_API_KEY="$OPENAI_API_KEY"      # dedup-gate embeddings (3-large@1536)
//   supabase secrets set ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" # kitchen-vs-recipe Haiku gate
//   # Optional tuning (defaults shown):
//   supabase secrets set RUMEN_PROMOTE_BATCH=25
//   supabase secrets set RUMEN_PROMOTE_RATE_CAP_24H=50
//   supabase secrets set RUMEN_PROMOTE_MAX_ATTEMPTS=5
//   supabase secrets set RUMEN_PROMOTE_CLAIM_LEASE_MINUTES=10
//
// Both model keys are REQUIRED: without them the pass skips (HTTP 503 below)
// rather than claiming rows it cannot gate — config absence must not burn
// promotion attempts across the inbox.
//
// Triggered on a schedule by pg_cron — see migrations/003_pg_cron_inbox_promote.sql.

// @ts-ignore  Deno std import resolved at runtime.
import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
// @ts-ignore  npm specifier resolved at runtime. Version is stamped at
// publish/deploy time by ORCH at sprint close — must be >= 0.6.0, the first
// version exporting promoteInbox.
import { promoteInbox, createPoolFromUrl } from 'npm:@jhizzard/rumen@0.6.0';

// @ts-ignore  Deno global available at runtime.
declare const Deno: { env: { get: (k: string) => string | undefined } };

serve(async (_req: Request) => {
  // Same fallback as rumen-tick: Supabase auto-injects SUPABASE_DB_URL.
  const url = Deno.env.get('DATABASE_URL') ?? Deno.env.get('SUPABASE_DB_URL');
  if (!url) {
    console.error('[rumen-promote] DATABASE_URL / SUPABASE_DB_URL not set in Edge Function secrets');
    return new Response(
      JSON.stringify({ ok: false, error: 'DATABASE_URL not set' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } },
    );
  }

  const pool = createPoolFromUrl(url);

  try {
    console.log('[rumen-promote] edge function pass starting');
    const summary = await promoteInbox(pool);

    if (summary.skipped_reason) {
      // Config-level skip (missing model key, rate-accounting failure):
      // surface as a non-200 so pg_cron/operator dashboards notice, but the
      // inbox is untouched and simply drains on a later pass.
      console.error('[rumen-promote] pass skipped: ' + summary.skipped_reason);
      return new Response(
        JSON.stringify({ ok: false, skipped: summary.skipped_reason, summary }),
        { status: 503, headers: { 'Content-Type': 'application/json' } },
      );
    }

    console.log(
      '[rumen-promote] edge function pass complete claimed=' +
        summary.claimed +
        ' promoted=' +
        summary.promoted +
        ' rejected=' +
        summary.rejected,
    );
    // Row-level failures are fail-soft by design — the pass itself succeeded.
    return new Response(
      JSON.stringify({ ok: true, summary }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[rumen-promote] edge function pass threw:', err);
    return new Response(
      JSON.stringify({ ok: false, error: message }),
      { status: 500, headers: { 'Content-Type': 'application/json' } },
    );
  } finally {
    try {
      await pool.end();
    } catch (err) {
      console.error('[rumen-promote] pool.end() failed:', err);
    }
  }
});
