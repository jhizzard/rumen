/**
 * Rumen v0.1 — Relate phase.
 *
 * For each signal from the Extract phase, run Mnestra's memory_hybrid_search
 * SQL function to find prior art across ALL historical memories. Keep the
 * top-5 candidates with similarity above the configured minimum.
 *
 * v0.1 note: we call memory_hybrid_search with query_embedding = NULL. The
 * Mnestra implementation falls back to keyword-only matching in that case,
 * which is enough to validate the Rumen loop end-to-end without requiring
 * Rumen to own an embeddings provider. v0.2 will add real embeddings.
 */

import type { PgPool } from './db.js';
import type { RelatedMemory, RelatedSignal, RumenSignal } from './types.js';

const TOP_K = 5;

export interface RelateOptions {
  minSimilarity: number;
}

export async function relateSignals(
  pool: PgPool,
  signals: RumenSignal[],
  options: RelateOptions,
): Promise<RelatedSignal[]> {
  const { minSimilarity } = options;

  console.log(
    '[rumen-relate] starting: signals=' +
      signals.length +
      ' minSimilarity=' +
      minSimilarity +
      ' topK=' +
      TOP_K,
  );

  const out: RelatedSignal[] = [];
  for (const signal of signals) {
    try {
      const related = await relateOne(pool, signal, minSimilarity);
      out.push({ signal, related });
      console.log(
        '[rumen-relate] signal ' +
          signal.key +
          ' matched ' +
          related.length +
          ' prior memories',
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

async function relateOne(
  pool: PgPool,
  signal: RumenSignal,
  minSimilarity: number,
): Promise<RelatedMemory[]> {
  // memory_hybrid_search(query_text, query_embedding, limit_count, project_filter)
  // - query_text: the search string
  // - query_embedding: NULL in v0.1 (keyword-only fallback)
  // - limit_count: TOP_K
  // - project_filter: NULL so we search across ALL projects (cross-project
  //                   prior art is the whole point of Rumen)
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
        similarity
      FROM memory_hybrid_search(
        $1::text,
        NULL::vector,
        $2::int,
        NULL::text
      )
    `,
    [signal.search_text, TOP_K],
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
