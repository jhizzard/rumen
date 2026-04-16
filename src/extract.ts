/**
 * Rumen v0.3 — Extract phase.
 *
 * Pulls recent sessions out of Mnestra's memory_items table by grouping on
 * source_session_id. Prior versions joined to memory_sessions on its UUID
 * primary key, but in rag-system's actual schema memory_items.source_session_id
 * references a separate ID space (the Claude Code session identifier) and
 * never matches memory_sessions.id. Grouping memory_items directly is both
 * correct and simpler — the session grouping is the source_session_id value
 * itself, and memory_sessions is ignored by Rumen.
 *
 * v0.3 still emits one signal per session. v0.4 will add multiple signals per
 * session via LLM extraction.
 */

import type { PgPool } from './db.js';
import type { MemorySession, RumenSignal } from './types.js';

export interface ExtractOptions {
  lookbackHours: number;
  maxSessions: number;
  minEventCount: number;
}

export interface ExtractResult {
  signals: RumenSignal[];
  /** Session IDs that were skipped because they already appear in a rumen_jobs row. */
  skippedAlreadyProcessed: string[];
  /** Session IDs that were skipped because they had fewer than minEventCount events. */
  skippedTrivial: string[];
}

/**
 * Pull candidate sessions from Mnestra, filter them, and build signals.
 */
export async function extractSignals(
  pool: PgPool,
  options: ExtractOptions,
): Promise<ExtractResult> {
  const { lookbackHours, maxSessions, minEventCount } = options;

  console.log(
    '[rumen-extract] starting: lookbackHours=' +
      lookbackHours +
      ' maxSessions=' +
      maxSessions +
      ' minEventCount=' +
      minEventCount,
  );

  // 1. Group memory_items by source_session_id, filter to sessions whose
  //    earliest item falls inside the lookback window, and keep those with
  //    enough events to be worth processing. We fetch a little more than
  //    maxSessions so we have headroom after the "already processed" filter.
  let candidates: MemorySession[];
  try {
    const fetchLimit = maxSessions * 4;
    const res = await pool.query<MemorySession>(
      `
        SELECT
          m.source_session_id                AS id,
          (ARRAY_AGG(m.project))[1]          AS project,
          NULL::text                         AS summary,
          MIN(m.created_at)                  AS created_at,
          COUNT(*)::int                      AS event_count
        FROM memory_items m
        WHERE m.source_session_id IS NOT NULL
          AND m.is_active = TRUE
        GROUP BY m.source_session_id
        HAVING COUNT(*) >= $3
           AND MIN(m.created_at) >= NOW() - ($1 || ' hours')::interval
        ORDER BY MIN(m.created_at) DESC
        LIMIT $2
      `,
      [String(lookbackHours), fetchLimit, minEventCount],
    );
    candidates = res.rows;
  } catch (err) {
    console.error('[rumen-extract] failed to fetch recent sessions:', err);
    throw err;
  }

  console.log('[rumen-extract] found ' + candidates.length + ' candidate sessions');

  // 2. Drop trivial sessions.
  const skippedTrivial: string[] = [];
  const nonTrivial: MemorySession[] = [];
  for (const s of candidates) {
    if (s.event_count < minEventCount) {
      skippedTrivial.push(s.id);
      continue;
    }
    nonTrivial.push(s);
  }
  if (skippedTrivial.length > 0) {
    console.log(
      '[rumen-extract] skipped ' +
        skippedTrivial.length +
        ' trivial sessions (<' +
        minEventCount +
        ' events)',
    );
  }

  // 3. Drop sessions that already appear in a completed rumen_jobs row.
  //    We check source_session_ids via GIN-backed array containment.
  const skippedAlreadyProcessed: string[] = [];
  const fresh: MemorySession[] = [];
  if (nonTrivial.length > 0) {
    let alreadyProcessedIds: Set<string>;
    try {
      const res = await pool.query<{ session_id: string }>(
        `
          SELECT DISTINCT unnest(source_session_ids) AS session_id
          FROM rumen_jobs
          WHERE status = 'done'
            AND source_session_ids && $1::uuid[]
        `,
        [nonTrivial.map((s) => s.id)],
      );
      alreadyProcessedIds = new Set(res.rows.map((r) => r.session_id));
    } catch (err) {
      console.error('[rumen-extract] failed to check prior rumen_jobs:', err);
      throw err;
    }

    for (const s of nonTrivial) {
      if (alreadyProcessedIds.has(s.id)) {
        skippedAlreadyProcessed.push(s.id);
        continue;
      }
      fresh.push(s);
    }
  }
  if (skippedAlreadyProcessed.length > 0) {
    console.log(
      '[rumen-extract] skipped ' +
        skippedAlreadyProcessed.length +
        ' sessions already processed by a prior job',
    );
  }

  // 4. Cap at maxSessions.
  const chosen = fresh.slice(0, maxSessions);
  if (chosen.length < fresh.length) {
    console.log(
      '[rumen-extract] capped at ' +
        maxSessions +
        ' sessions (had ' +
        fresh.length +
        ' fresh candidates)',
    );
  }

  // 5. Build one signal per chosen session. v0.1 uses session summary as the
  //    search text; if the summary is empty, fall back to a content rollup
  //    from the session's memory_items.
  const signals: RumenSignal[] = [];
  for (const session of chosen) {
    try {
      const signal = await buildSignal(pool, session);
      if (signal) {
        signals.push(signal);
      }
    } catch (err) {
      console.error('[rumen-extract] failed for session ' + session.id + ':', err);
      // Do not rethrow — one bad session shouldn't kill the whole run.
    }
  }

  console.log('[rumen-extract] produced ' + signals.length + ' signals');

  return {
    signals,
    skippedAlreadyProcessed,
    skippedTrivial,
  };
}

async function buildSignal(
  pool: PgPool,
  session: MemorySession,
): Promise<RumenSignal | null> {
  // In v0.3 there is no per-session summary column — Rumen treats
  // memory_items.source_session_id as the session key directly, so we always
  // build the search text from a content rollup of the session's items.
  const res = await pool.query<{ content: string }>(
    `
      SELECT content
      FROM memory_items
      WHERE source_session_id = $1
        AND is_active = TRUE
      ORDER BY created_at ASC
      LIMIT 5
    `,
    [session.id],
  );
  const searchText = res.rows
    .map((r) => r.content)
    .join('\n')
    .slice(0, 2000)
    .trim();

  if (searchText.length === 0) {
    // Nothing to relate against. Skip.
    console.log('[rumen-extract] session ' + session.id + ' has no content to search on');
    return null;
  }

  const description =
    searchText.slice(0, 240) ||
    'Session ' + session.id + ' in ' + (session.project ?? 'unknown project');

  return {
    key: 'session:' + session.id,
    session_id: session.id,
    project: session.project,
    description,
    search_text: searchText,
    event_count: session.event_count,
  };
}
