/**
 * Rumen v0.1 — Extract phase.
 *
 * Pulls recent session memories out of Mnemos's memory_sessions + memory_items
 * tables, filters trivial sessions, skips sessions already processed by a
 * previous Rumen job, and returns structured signals for the Relate phase.
 *
 * v0.1 is deliberately simple: one signal per session, built from the session
 * summary + a short rollup of its memory_items. v0.2 will produce multiple
 * signals per session via LLM extraction.
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
 * Pull candidate sessions from Mnemos, filter them, and build signals.
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

  // 1. Pull recent sessions with their event counts. We deliberately fetch a
  //    little more than maxSessions so we have headroom after filtering.
  let candidates: MemorySession[];
  try {
    const fetchLimit = maxSessions * 4;
    const res = await pool.query<MemorySession>(
      `
        SELECT
          s.id,
          s.project,
          s.summary,
          s.created_at,
          COALESCE(COUNT(m.id), 0)::int AS event_count
        FROM memory_sessions s
        LEFT JOIN memory_items m ON m.session_id = s.id
        WHERE s.created_at >= NOW() - ($1 || ' hours')::interval
        GROUP BY s.id
        ORDER BY s.created_at DESC
        LIMIT $2
      `,
      [String(lookbackHours), fetchLimit],
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
  let searchText = (session.summary ?? '').trim();

  if (searchText.length === 0) {
    // Fall back to first ~5 memory_items of the session, concatenated.
    const res = await pool.query<{ content: string }>(
      `
        SELECT content
        FROM memory_items
        WHERE session_id = $1
        ORDER BY created_at ASC
        LIMIT 5
      `,
      [session.id],
    );
    searchText = res.rows
      .map((r) => r.content)
      .join('\n')
      .slice(0, 2000)
      .trim();
  }

  if (searchText.length === 0) {
    // Nothing to relate against. Skip.
    console.log('[rumen-extract] session ' + session.id + ' has no content to search on');
    return null;
  }

  const description =
    (session.summary ?? '').trim().slice(0, 240) ||
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
