// Sprint 38 T2 — graph-inference Supabase Edge Function.
//
// Runs daily via pg_cron (see TermDeck migration 003_graph_inference_schedule.sql).
// Scans memory_items for pairs above GRAPH_INFERENCE_THRESHOLD cosine
// similarity, inserts/refreshes edges in memory_relationships, and
// optionally classifies edge types via Haiku 4.5.
//
// Coexists with the rag-system MCP-side ingest classifier — this cron
// fills cross-project edges and refreshes stale ingest-time edges that
// have NULL weight.  Per-edge inferred_by = 'cron-YYYY-MM-DD' for audit.
//
// Deno runtime, NOT Node.  Excluded from root tsconfig; canonical type
// check is `deno check` and `supabase functions deploy`.
//
// Deployment:
//   supabase functions deploy graph-inference
//   supabase secrets set DATABASE_URL="$DATABASE_URL"
//   # Optional, gates LLM classification of new edges:
//   supabase secrets set GRAPH_LLM_CLASSIFY=1 ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY"
//   # Optional tuning (defaults shown):
//   supabase secrets set GRAPH_INFERENCE_THRESHOLD=0.85
//   supabase secrets set GRAPH_INFERENCE_MAX_LLM_CALLS=200
//   supabase secrets set GRAPH_INFERENCE_MAX_PAIRS=5000
//   supabase secrets set GRAPH_INFERENCE_PER_ROW_K=8     # Sprint 42: HNSW LATERAL top-K width

// @ts-ignore  Deno std import resolved at runtime.
import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
// @ts-ignore  npm specifier resolved at runtime.
// Deno-friendly postgres client (postgres.js).  npm:pg@8.x has Node-native
// crypto/net deps that don't bundle in the Supabase Edge Runtime — caused
// BOOT_ERROR on first deploy 2026-04-27 ~19:35 ET.  postgres.js is pure JS,
// works in Deno without polyfills.
import postgres from 'npm:postgres@3.4.4';

// Minimal API surface we use, typed loosely so the @ts-ignore stays narrow.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Sql = any;

// @ts-ignore  Deno global available at runtime.
declare const Deno: { env: { get: (k: string) => string | undefined } };

const VALID_TYPES = new Set([
  'supersedes',
  'relates_to',
  'contradicts',
  'elaborates',
  'caused_by',
  'blocks',
  'inspired_by',
  'cross_project_link',
]);

const HAIKU_MODEL = 'claude-haiku-4-5-20251001';

interface InferenceSummary {
  ok: boolean;
  since: string | null;
  candidates_scanned: number;
  edges_inserted: number;
  edges_refreshed: number;
  llm_classifications: number;
  llm_failures: number;
  ms_total: number;
  error?: string;
}

function inferredByTag(now: Date): string {
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(now.getUTCDate()).padStart(2, '0');
  return `cron-${yyyy}-${mm}-${dd}`;
}

function parseFloatEnv(name: string, fallback: number): number {
  const raw = Deno.env.get(name);
  if (!raw) return fallback;
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseIntEnv(name: string, fallback: number): number {
  const raw = Deno.env.get(name);
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

interface CandidatePair {
  source_id: string;
  target_id: string;
  similarity: number;
  source_content: string;
  target_content: string;
  source_project: string | null;
  target_project: string | null;
}

async function fetchSince(sql: Sql): Promise<string | null> {
  const result = await sql.unsafe(
    `SELECT max(inferred_at) AS since FROM memory_relationships WHERE inferred_by ILIKE 'cron-%'`,
  );
  const row = result[0];
  if (!row || !row.since) return null;
  return new Date(row.since).toISOString();
}

async function fetchCandidatePairs(
  sql: Sql,
  threshold: number,
  since: string | null,
  maxPairs: number,
  perRowK: number,
): Promise<CandidatePair[]> {
  // Sprint 42 T1 rewrite — HNSW-accelerated pairwise self-join.
  //
  // The pre-Sprint 42 query (`m1 JOIN m2 ON m1.id < m2.id AND (m1.embedding
  // <=> m2.embedding) <= cutoff`) timed out at the 150s Edge Function
  // wall-clock on >5K memory_items because cosine-distance constraints in
  // a join's ON/WHERE clause cannot engage HNSW — they're post-join
  // filters, evaluated for every candidate pair (~3.5M for 5K rows).
  //
  // The fix: switch to a CROSS JOIN LATERAL with `ORDER BY m2.embedding
  // <=> m1.embedding LIMIT K` inside the lateral. HNSW serves the per-row
  // top-K query in ~2ms each, so the work is O(N log K) ≈ N × HNSW-lookup
  // rather than O(N²) cosine evaluations.
  //
  // Symmetry: each pair (A, B) may be found twice (once as A's neighbor
  // of B, once as B's neighbor of A). LEAST/GREATEST canonicalizes the
  // orientation; DISTINCT ON dedupes. This is more correct than filtering
  // `m1.id < nbr.id` outside the lateral, which would lose pairs where
  // only one direction's top-K contained the other.
  //
  // `since` filter: applied only to the outer m1. If m1 is old but m2
  // was recently updated, the pair is still found on the iteration where
  // m2 is the outer m1 (which IS recent). So filtering only m1 by `since`
  // is sufficient and saves ~99% of work in steady state.
  //
  // EXPLAIN ANALYZE on petvetbid corpus (5,822 active rows, 2026-04-28):
  // 13.5s cold start (since=NULL), HNSW correctly engaged, 718 raw
  // matches → 359 unique pairs at threshold 0.85.
  const result = await sql.unsafe(
    `
      SELECT DISTINCT ON (LEAST(m1.id, nbr.id), GREATEST(m1.id, nbr.id))
        LEAST(m1.id, nbr.id)    AS source_id,
        GREATEST(m1.id, nbr.id) AS target_id,
        1 - (m1.embedding <=> nbr.embedding) AS similarity,
        CASE WHEN m1.id < nbr.id THEN m1.content ELSE nbr.content END AS source_content,
        CASE WHEN m1.id < nbr.id THEN nbr.content ELSE m1.content END AS target_content,
        CASE WHEN m1.id < nbr.id THEN m1.project ELSE nbr.project END AS source_project,
        CASE WHEN m1.id < nbr.id THEN nbr.project ELSE m1.project END AS target_project
      FROM memory_items m1
      CROSS JOIN LATERAL (
        SELECT id, embedding, content, project, updated_at
        FROM memory_items m2
        WHERE m2.is_active = true
          AND m2.archived = false
          AND m2.superseded_by IS NULL
          AND m2.id <> m1.id
        ORDER BY m2.embedding <=> m1.embedding
        LIMIT $4
      ) nbr
      WHERE m1.is_active = true
        AND m1.archived = false
        AND m1.superseded_by IS NULL
        AND 1 - (m1.embedding <=> nbr.embedding) >= $1
        AND ($2::timestamptz IS NULL OR m1.updated_at > $2::timestamptz)
      ORDER BY LEAST(m1.id, nbr.id),
               GREATEST(m1.id, nbr.id),
               1 - (m1.embedding <=> nbr.embedding) DESC
      LIMIT $3
    `,
    [threshold, since, maxPairs, perRowK],
  );
  return result as unknown as CandidatePair[];
}

async function classifyPair(
  apiKey: string,
  pair: CandidatePair,
): Promise<string | null> {
  const prompt = `You are classifying the relationship between two memories from the same developer.

Memory A: ${pair.source_content}
Memory B: ${pair.target_content}

Classify their relationship as exactly ONE of:
- supersedes — A replaces B (B is older/wrong/outdated)
- relates_to — A and B are about the same topic/system
- contradicts — A and B claim conflicting facts
- elaborates — A provides more detail about something B mentions
- caused_by — A is a consequence of something described in B
- blocks — A's resolution depends on B
- inspired_by — A's idea originated from B
- cross_project_link — A and B are in different projects but reference shared infrastructure

Return ONLY the type token, no explanation.`;

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: HAIKU_MODEL,
      max_tokens: 32,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!response.ok) {
    return null;
  }

  const payload = await response.json();
  const block = payload?.content?.[0];
  if (!block || block.type !== 'text') return null;
  const token = String(block.text).trim().toLowerCase().split(/\s+/)[0];
  return VALID_TYPES.has(token) ? token : null;
}

async function upsertEdge(
  sql: Sql,
  pair: CandidatePair,
  relationshipType: string,
  inferredBy: string,
): Promise<'inserted' | 'refreshed' | 'skipped'> {
  const result = await sql.unsafe(
    `
      INSERT INTO memory_relationships (
        source_id, target_id, relationship_type, weight, inferred_at, inferred_by
      ) VALUES ($1, $2, $3, $4, now(), $5)
      ON CONFLICT (source_id, target_id, relationship_type) DO UPDATE
        SET weight       = EXCLUDED.weight,
            inferred_at  = EXCLUDED.inferred_at,
            inferred_by  = EXCLUDED.inferred_by
        WHERE memory_relationships.weight IS NULL
           OR memory_relationships.inferred_at IS NULL
           OR memory_relationships.inferred_at < now() - interval '7 days'
      RETURNING (xmax = 0) AS inserted
    `,
    [pair.source_id, pair.target_id, relationshipType, pair.similarity, inferredBy],
  );
  if (result.length === 0) return 'skipped';
  return result[0].inserted ? 'inserted' : 'refreshed';
}

function isMissingColumnError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const message = err.message.toLowerCase();
  return (
    message.includes('column') &&
    (message.includes('inferred_at') ||
      message.includes('inferred_by') ||
      message.includes('weight'))
  );
}

export async function runGraphInference(sql: Sql): Promise<InferenceSummary> {
  const start = Date.now();
  const summary: InferenceSummary = {
    ok: false,
    since: null,
    candidates_scanned: 0,
    edges_inserted: 0,
    edges_refreshed: 0,
    llm_classifications: 0,
    llm_failures: 0,
    ms_total: 0,
  };

  const threshold = parseFloatEnv('GRAPH_INFERENCE_THRESHOLD', 0.85);
  const maxPairs = parseIntEnv('GRAPH_INFERENCE_MAX_PAIRS', 5000);
  const maxLlmCalls = parseIntEnv('GRAPH_INFERENCE_MAX_LLM_CALLS', 200);
  // GRAPH_INFERENCE_PER_ROW_K — top-K HNSW lookup width for the LATERAL
  // self-join (Sprint 42 T1 rewrite). 8 is a recall/perf sweet spot at
  // threshold 0.85: it captures the high-similarity tail without paying
  // for many post-filter rejections. Raise to 12 if recall drops.
  const perRowK = parseIntEnv('GRAPH_INFERENCE_PER_ROW_K', 8);
  const llmEnabled = Deno.env.get('GRAPH_LLM_CLASSIFY') === '1';
  const apiKey = Deno.env.get('ANTHROPIC_API_KEY') ?? '';
  const inferredBy = inferredByTag(new Date());

  try {
    summary.since = await fetchSince(sql);
  } catch (err) {
    if (isMissingColumnError(err)) {
      summary.error = 'awaiting migration 009';
      summary.ms_total = Date.now() - start;
      return summary;
    }
    throw err;
  }

  const candidates = await fetchCandidatePairs(sql, threshold, summary.since, maxPairs, perRowK);
  summary.candidates_scanned = candidates.length;

  for (const pair of candidates) {
    let relationshipType = 'relates_to';
    let isNewEdge = false;

    try {
      const outcome = await upsertEdge(sql, pair, relationshipType, inferredBy);
      if (outcome === 'skipped') continue;
      isNewEdge = outcome === 'inserted';
      if (outcome === 'inserted') summary.edges_inserted++;
      if (outcome === 'refreshed') summary.edges_refreshed++;
    } catch (err) {
      if (isMissingColumnError(err)) {
        summary.error = 'awaiting migration 009';
        summary.ms_total = Date.now() - start;
        return summary;
      }
      throw err;
    }

    if (
      llmEnabled &&
      apiKey &&
      isNewEdge &&
      summary.llm_classifications + summary.llm_failures < maxLlmCalls
    ) {
      const classified = await classifyPair(apiKey, pair);
      if (classified && classified !== relationshipType) {
        try {
          await upsertEdge(sql, pair, classified, inferredBy);
          summary.llm_classifications++;
        } catch {
          summary.llm_failures++;
        }
      } else if (classified) {
        summary.llm_classifications++;
      } else {
        summary.llm_failures++;
      }
    }
  }

  summary.ok = true;
  summary.ms_total = Date.now() - start;
  return summary;
}

serve(async (_req: Request) => {
  // Supabase Edge Runtime auto-injects SUPABASE_DB_URL as a built-in env var.
  // Falling back to it removes one whole category of "where do I get the DB
  // connection string" from the install wizard. Brad surfaced this 2026-05-03
  // after hand-patching all four of his deployed copies.
  const url = Deno.env.get('DATABASE_URL') ?? Deno.env.get('SUPABASE_DB_URL');
  if (!url) {
    console.error('[graph-inference] DATABASE_URL / SUPABASE_DB_URL not set in Edge Function secrets');
    return new Response(
      JSON.stringify({ ok: false, error: 'DATABASE_URL not set' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } },
    );
  }

  const sql = postgres(url, { max: 4, prepare: false });

  try {
    console.log('[graph-inference] tick starting');
    const summary = await runGraphInference(sql);
    console.log(
      `[graph-inference] tick complete inserted=${summary.edges_inserted} refreshed=${summary.edges_refreshed} ms=${summary.ms_total}`,
    );
    return new Response(JSON.stringify(summary), {
      status: summary.ok ? 200 : 500,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[graph-inference] tick threw:', err);
    return new Response(
      JSON.stringify({ ok: false, error: message }),
      { status: 500, headers: { 'Content-Type': 'application/json' } },
    );
  } finally {
    try {
      await sql.end();
    } catch (err) {
      console.error('[graph-inference] sql.end() failed:', err);
    }
  }
});
