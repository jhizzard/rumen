/**
 * Rumen v0.4 — Relate phase.
 *
 * For each signal from the Extract phase, generate an OpenAI embedding and run
 * Mnestra's memory_hybrid_search to find prior art across ALL historical
 * memories. Keep the top-5 candidates with similarity above the configured
 * minimum.
 *
 * v0.4 upgrade: instead of calling memory_hybrid_search with query_embedding
 * = NULL::vector (keyword-only), we now generate a 1536-d embedding via
 * OpenAI text-embedding-3-large (matching Mnestra's memory_items.embedding
 * column) and run a true hybrid search (full_text_weight 0.4, semantic_weight
 * 0.6). Falls back to keyword-only gracefully when OPENAI_API_KEY is missing
 * or the embeddings endpoint is unreachable.
 */

import type { PgPool } from './db.js';
import type { RelatedMemory, RelatedSignal, RumenSignal } from './types.js';

const TOP_K = 5;
const EMBEDDING_MODEL = 'text-embedding-3-large';
const EMBEDDING_DIMS = 1536;
const EMBEDDING_TIMEOUT_MS = 10_000;
const EMBEDDING_MAX_INPUT_CHARS = 8000;

// Hybrid weights when an embedding is available. Semantic-dominant for
// conceptual retrieval; keyword still contributes for exact technical terms.
const HYBRID_SEMANTIC_WEIGHT = 0.6;
const HYBRID_FULL_TEXT_WEIGHT = 0.4;
// Fallback weights (keyword-only) when no embedding is available.
const KEYWORD_ONLY_SEMANTIC_WEIGHT = 0.0;
const KEYWORD_ONLY_FULL_TEXT_WEIGHT = 1.0;

export interface RelateOptions {
  minSimilarity: number;
}

export async function relateSignals(
  pool: PgPool,
  signals: RumenSignal[],
  options: RelateOptions,
): Promise<RelatedSignal[]> {
  const { minSimilarity } = options;
  const apiKey = process.env['OPENAI_API_KEY'];

  if (!apiKey) {
    console.warn(
      '[rumen-relate] OPENAI_API_KEY not set — running in keyword-only fallback mode. ' +
        'Cross-project conceptual retrieval will be limited to exact keyword overlap. ' +
        'Set OPENAI_API_KEY to enable semantic+keyword hybrid search.',
    );
  }

  console.log(
    '[rumen-relate] starting: signals=' +
      signals.length +
      ' minSimilarity=' +
      minSimilarity +
      ' topK=' +
      TOP_K +
      ' mode=' +
      (apiKey ? 'hybrid' : 'keyword-only'),
  );

  const out: RelatedSignal[] = [];
  for (const signal of signals) {
    try {
      const embedding = apiKey
        ? await generateEmbedding(signal.search_text, apiKey)
        : null;
      const related = await relateOne(pool, signal, minSimilarity, embedding);
      out.push({ signal, related });
      console.log(
        '[rumen-relate] signal ' +
          signal.key +
          ' matched ' +
          related.length +
          ' prior memories (embedding=' +
          (embedding ? 'yes' : 'no') +
          ')',
      );
    } catch (err) {
      console.error('[rumen-relate] failed for signal ' + signal.key + ':', err);
      out.push({ signal, related: [] });
    }
  }

  const total = out.reduce((acc, r) => acc + r.related.length, 0);
  console.log('[rumen-relate] produced ' + total + ' related memories across all signals');

  return out;
}

/**
 * Generate a 1536-dimensional embedding via OpenAI's text-embedding-3-large
 * model. Returns null on any failure (timeout, non-2xx, malformed response,
 * network error). Per-signal error tolerance: the caller continues with
 * keyword-only matching for this signal while other signals proceed normally.
 */
async function generateEmbedding(
  text: string,
  apiKey: string,
): Promise<number[] | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), EMBEDDING_TIMEOUT_MS);
  try {
    const res = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: EMBEDDING_MODEL,
        input: text.slice(0, EMBEDDING_MAX_INPUT_CHARS),
        dimensions: EMBEDDING_DIMS,
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      console.warn(
        '[rumen-relate] embedding fetch failed: status=' +
          res.status +
          ' — falling back to keyword-only for this signal',
      );
      return null;
    }
    const json = (await res.json()) as {
      data?: Array<{ embedding?: unknown }>;
    };
    const embedding = json?.data?.[0]?.embedding;
    if (!Array.isArray(embedding) || embedding.length !== EMBEDDING_DIMS) {
      console.warn(
        '[rumen-relate] embedding response malformed (expected ' +
          EMBEDDING_DIMS +
          '-d array) — falling back to keyword-only for this signal',
      );
      return null;
    }
    return embedding as number[];
  } catch (err) {
    const reason =
      err instanceof Error && err.name === 'AbortError'
        ? 'timeout after ' + EMBEDDING_TIMEOUT_MS + 'ms'
        : err instanceof Error
          ? err.message
          : String(err);
    console.warn(
      '[rumen-relate] embedding call threw: ' +
        reason +
        ' — falling back to keyword-only for this signal',
    );
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

// pgvector literal: '[0.1,0.2,...]' cast via $N::vector. The driver binds it
// as text and Postgres handles the cast.
function formatVectorLiteral(embedding: number[]): string {
  return '[' + embedding.join(',') + ']';
}

async function relateOne(
  pool: PgPool,
  signal: RumenSignal,
  minSimilarity: number,
  embedding: number[] | null,
): Promise<RelatedMemory[]> {
  // Mnestra's CANONICAL memory_hybrid_search signature (post-Sprint-51.9 /
  // mig 002's do$$ drop-prelude):
  //   query_text          text
  //   query_embedding     vector
  //   match_count         integer
  //   full_text_weight    double precision
  //   semantic_weight     double precision
  //   rrf_k               integer
  //   filter_project      text
  //   filter_source_type  text
  //
  // Sprint 54 (rumen 0.5.1) — this lane was the OTHER side of the
  // Sprint 51.9 fix. Sprint 51.9 dropped a 10-arg drift overload
  // (extra `recency_weight` + `decay_days` from the rag-system writer's
  // pre-canonical bootstrap) from the DB via mig 002's do$$ guard. But
  // rumen's relate.ts was still calling the 10-arg shape — every call
  // errored, every signal ended up with `related = []`, every tick
  // emitted 0 insights even though the picker rewrite (Sprint 53)
  // correctly found candidates. Symptom on the daily-driver project
  // post-Sprint-53 manual rumen-tick:
  //   sessions_processed: 7  ← Sprint 53 picker working
  //   insights_generated: 0  ← THIS bug
  // Fix: drop the trailing recency_weight + decay_days args. Rumen
  // doesn't need recency weighting — its purpose is cross-project
  // prior art, not "what's recent." Pure similarity is the right
  // ranking for that.
  const vectorParam = embedding ? formatVectorLiteral(embedding) : null;
  const fullTextWeight = embedding
    ? HYBRID_FULL_TEXT_WEIGHT
    : KEYWORD_ONLY_FULL_TEXT_WEIGHT;
  const semanticWeight = embedding
    ? HYBRID_SEMANTIC_WEIGHT
    : KEYWORD_ONLY_SEMANTIC_WEIGHT;

  const res = await pool.query<{
    id: string;
    content: string;
    source_type: string;
    project: string | null;
    created_at: string;
    similarity: number;
  }>(
    `
      SELECT
        id,
        content,
        source_type,
        project,
        created_at,
        score AS similarity
      FROM memory_hybrid_search(
        $1::text,
        $2::vector,
        $3::int,
        $4::double precision,
        $5::double precision,
        60,
        NULL::text,
        NULL::text
      )
    `,
    [signal.search_text, vectorParam, TOP_K, fullTextWeight, semanticWeight],
  );

  // Filter by similarity, exclude the source session's own items so we
  // don't recommend a memory to itself.
  const filtered: RelatedMemory[] = [];
  for (const row of res.rows) {
    if (typeof row.similarity !== 'number' || Number.isNaN(row.similarity)) {
      continue;
    }
    if (row.similarity < minSimilarity) {
      continue;
    }
    filtered.push({
      id: row.id,
      content: row.content,
      source_type: row.source_type,
      project: row.project,
      created_at: row.created_at,
      similarity: row.similarity,
    });
  }

  // Top-5 only, even if more cleared the threshold.
  filtered.sort((a, b) => b.similarity - a.similarity);
  return filtered.slice(0, TOP_K);
}
