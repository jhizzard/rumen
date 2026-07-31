// Rumen Sprint 83 (TermDeck T3) — graph-consolidation Supabase Edge Function.
//
// Thin wrapper only. The algorithm lives in `src/graph-consolidation.ts` in
// @jhizzard/rumen — same split as doctrine-scan, and for the same two reasons:
// the logic stays testable under Node/tsx (a Deno function importing
// `https://deno.land/...` cannot be imported by rumen's suite), and the npm:
// specifier freezes the package version at DEPLOY time so upgrading
// @jhizzard/rumen does nothing until this function is redeployed (the Sprint
// 66 Brad-Rumen-zero lesson).
//
// Sibling of graph-inference by design, NOT a step inside it: independent
// cadence, INDEPENDENT BUDGET, independent failure. A shared budget would let
// a heavy inference night silently starve consolidation, and the symptom —
// "the summaries stopped appearing" — would point at the wrong function.
//
// IMPORTANT: targets the Deno runtime, NOT Node. Excluded from the root
// tsconfig; the canonical check is `deno check` + `supabase functions deploy`.
//
// Deployment (ORCH at sprint close — deployable, NOT deployed from a lane):
//   supabase functions deploy graph-consolidation
//   supabase secrets set DATABASE_URL="$DATABASE_URL"
//   supabase secrets set ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY"
//   # Optional. Without it summaries are written with a NULL embedding: still
//   # full-text-recallable, invisible to vector search, and counted as
//   # `embeddings_unavailable` in the run summary rather than silently lost.
//   supabase secrets set OPENAI_API_KEY="$OPENAI_API_KEY"
//   # Optional tuning (defaults shown):
//   supabase secrets set GRAPH_CONSOLIDATION_MIN_SIZE=4
//   supabase secrets set GRAPH_CONSOLIDATION_MAX_SIZE=60
//   supabase secrets set GRAPH_CONSOLIDATION_MAX_LLM_CALLS=20
//   supabase secrets set GRAPH_CONSOLIDATION_BUDGET_MS=110000
//   # Detect + report, write nothing — the safe first run against a live corpus:
//   supabase secrets set GRAPH_CONSOLIDATION_DRY_RUN=1
//
// A missing ANTHROPIC_API_KEY is NOT a hard failure: community detection still
// runs and is reported, and phase 3 records why it wrote nothing.
//
// NOT SCHEDULED THIS SPRINT — cron-ready, ORCH's call at close. The line, when
// ratified, is 03:30 UTC: deliberately 30 minutes after graph-inference's
// 03:00, so it consolidates the edges just written rather than yesterday's.
//   select cron.schedule('graph-consolidation-tick', '30 3 * * *',
//     $$select net.http_post(
//         url := '<functions-url>/graph-consolidation',
//         headers := '{"Authorization": "Bearer <service-role-key>"}'::jsonb
//       )$$);

// @ts-ignore  Deno std import resolved at runtime.
import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
// @ts-ignore  npm specifier resolved at runtime. Version is stamped at
// publish/deploy time by ORCH at sprint close — must be the first version
// exporting runGraphConsolidation.
import { runGraphConsolidation, createPoolFromUrl } from 'npm:@jhizzard/rumen@0.10.0';
// @ts-ignore  npm specifier resolved at runtime.
import Anthropic from 'npm:@anthropic-ai/sdk@0.32.1';

// @ts-ignore  Deno global available at runtime.
declare const Deno: { env: { get: (k: string) => string | undefined } };

const EMBEDDING_MODEL = 'text-embedding-3-large';
const EMBEDDING_DIMENSIONS = 1536;

serve(async (_req: Request) => {
  const url = Deno.env.get('DATABASE_URL') ?? Deno.env.get('SUPABASE_DB_URL');
  if (!url) {
    console.error('[graph-consolidation] DATABASE_URL / SUPABASE_DB_URL not set in Edge Function secrets');
    return new Response(JSON.stringify({ ok: false, error: 'DATABASE_URL not set' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const pool = createPoolFromUrl(url);

  const anthropicKey = Deno.env.get('ANTHROPIC_API_KEY') ?? '';
  // The SDK defaults (10-minute timeout, 2 retries) are sized for interactive
  // servers, not a 150s execution wall — one stalled request would ride the
  // whole invocation into a platform 504.
  const anthropic = anthropicKey
    ? new Anthropic({ apiKey: anthropicKey, timeout: 30_000, maxRetries: 1 })
    : null;

  const openaiKey = Deno.env.get('OPENAI_API_KEY') ?? '';
  const embed = openaiKey
    ? async (text: string): Promise<number[] | null> => {
      try {
        const res = await fetch('https://api.openai.com/v1/embeddings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${openaiKey}` },
          body: JSON.stringify({ model: EMBEDDING_MODEL, input: text, dimensions: EMBEDDING_DIMENSIONS }),
        });
        if (!res.ok) return null;
        const data = await res.json();
        const vec = data?.data?.[0]?.embedding;
        return Array.isArray(vec) ? vec : null;
      } catch (_err) {
        return null;
      }
    }
    : null;

  const dryRun = /^(1|true|yes|on)$/i.test((Deno.env.get('GRAPH_CONSOLIDATION_DRY_RUN') ?? '').trim());

  // Watchdog: belt-and-suspenders alongside the pass's own wall-clock budget.
  // If anything upstream of that guard hangs (an unreachable pooler, a stalled
  // first query before the deadline is ever consulted), this race still
  // returns real JSON before the platform's 150s kill — the fix rumen-tick
  // shipped in v0.6.1 after days of silent 504s in the field.
  const watchdogMs = (() => {
    const raw = Deno.env.get('GRAPH_CONSOLIDATION_WATCHDOG_MS');
    const parsed = raw ? Number.parseInt(raw, 10) : NaN;
    return Number.isNaN(parsed) || parsed <= 0 ? 140_000 : parsed;
  })();
  let watchdogTimer: number | undefined;
  const watchdog = new Promise<never>((_, reject) => {
    watchdogTimer = setTimeout(
      () => reject(new Error(`graph-consolidation watchdog: pass exceeded ${watchdogMs}ms — failing gracefully before the platform 150s kill`)),
      watchdogMs,
    ) as unknown as number;
  });

  try {
    console.log(`[graph-consolidation] tick starting (dry_run=${dryRun})`);
    const summary = await Promise.race([
      runGraphConsolidation(pool, { anthropic, embed, dryRun }),
      watchdog,
    ]);
    console.log(
      `[graph-consolidation] tick complete edges=${summary.edges_scanned} communities=${summary.communities.qualifying}/${summary.communities.detected} written=${summary.summaries_written} unchanged=${summary.summaries_unchanged} ms=${summary.ms_total}`,
    );
    return new Response(JSON.stringify({ ok: summary.ok, summary }), {
      status: summary.ok ? 200 : 500,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[graph-consolidation] tick threw:', err);
    return new Response(JSON.stringify({ ok: false, error: message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  } finally {
    if (watchdogTimer !== undefined) clearTimeout(watchdogTimer);
    try {
      await pool.end();
    } catch (err) {
      console.error('[graph-consolidation] pool.end() failed:', err);
    }
  }
});
