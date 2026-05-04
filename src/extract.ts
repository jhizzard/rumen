/**
 * Rumen v0.5 — Extract phase.
 *
 * Sprint 53 (TermDeck v1.0.9) picker rewrite. Reads candidate sessions
 * directly from `memory_sessions` (one row per Claude Code session,
 * post-Sprint-51.6 bundled hook) instead of grouping `memory_items` by
 * source_session_id. The grouping pattern was correct for v0.3-era
 * payloads where each Claude turn produced one memory_items row, but
 * the Sprint 51.6 bundled hook collapsed each session to one
 * source_type='session_summary' row — breaking the GROUP BY threshold
 * filter and stranding insights flow at 0/tick for ~3 days on Joshua's
 * daily-driver project.
 *
 * Pivot:
 *   - SELECT FROM memory_sessions WHERE rumen_processed_at IS NULL …
 *   - Each row is its own candidate; no grouping.
 *   - buildSignal reads session.summary directly — no second roundtrip
 *     to fetch memory_items content.
 *   - Atomic stamp of memory_sessions.rumen_processed_at = now() lives
 *     in the orchestrator (index.ts), not here, so we don't double-emit
 *     on retry while still letting synthesize/surface roll back cleanly
 *     on failure.
 *
 * Schema target (Mnestra mig 017 + 018):
 *   - memory_sessions.id              uuid PK (the Rumen row key)
 *   - memory_sessions.session_id      text — Claude Code session UUID,
 *                                     written by the bundled hook;
 *                                     hook-internal, NOT used by Rumen
 *                                     (avoids the "1 non-UUID session_id
 *                                     out of 308" cast pitfall T4-CODEX
 *                                     surfaced in Sprint 53).
 *   - memory_sessions.project         text
 *   - memory_sessions.summary         text — bundled-hook session summary
 *   - memory_sessions.started_at      timestamptz
 *   - memory_sessions.ended_at        timestamptz (filter: NOT NULL)
 *   - memory_sessions.messages_count  int (replaces v0.3 event_count)
 *   - memory_sessions.rumen_processed_at  timestamptz (mig 018)
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
  /**
   * Every memory_sessions.id the SQL picker returned, regardless of whether
   * buildSignal accepted it. The orchestrator stamps these (not just
   * signal.session_id) so a row dropped by buildSignal (e.g. unexpected
   * empty/malformed summary that slipped past the SQL summary filter)
   * still gets `rumen_processed_at` stamped and won't infinite-loop on
   * subsequent ticks. T4-CODEX 17:25 ET pre-FIX audit catch.
   */
  pickedSessionIds: string[];
}

/**
 * Pull candidate sessions from Mnestra and build signals.
 *
 * The picker query is partial-index-backed (mig 018):
 * `memory_sessions_rumen_unprocessed_idx ON (started_at DESC) WHERE rumen_processed_at IS NULL`.
 * SQL pre-filters on rumen_processed_at IS NULL, ended_at IS NOT NULL,
 * lookback window, and messages_count threshold — there is no
 * post-fetch trivial/already-processed bucket to track.
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

  let candidates: MemorySession[];
  try {
    // SQL filters: rumen_processed_at IS NULL (pick only unseen rows),
    // ended_at IS NOT NULL (in-flight sessions excluded), lookback window,
    // messages_count threshold, and summary non-empty. The summary filter
    // is the cheap belt — the orchestrator's stamp-all-picked is the
    // suspenders against any remaining buildSignal dropouts.
    const res = await pool.query<MemorySession>(
      `
        SELECT
          s.id           AS id,
          s.project      AS project,
          s.summary      AS summary,
          s.started_at   AS created_at,
          COALESCE(s.messages_count, 0)::int AS event_count
        FROM memory_sessions s
        WHERE s.rumen_processed_at IS NULL
          AND s.ended_at IS NOT NULL
          AND s.started_at >= NOW() - ($1 || ' hours')::interval
          AND COALESCE(s.messages_count, 0) >= $3
          AND s.summary IS NOT NULL
          AND s.summary <> ''
        ORDER BY s.started_at DESC
        LIMIT $2
      `,
      [String(lookbackHours), maxSessions, minEventCount],
    );
    candidates = res.rows;
  } catch (err) {
    console.error('[rumen-extract] failed to fetch recent sessions:', err);
    throw err;
  }

  console.log('[rumen-extract] found ' + candidates.length + ' candidate sessions');

  // Picked IDs flow to the orchestrator BEFORE buildSignal filters — that
  // way every candidate (including any dropped here) gets stamped. Avoids
  // the infinite-loop class T4-CODEX called out: a row dropped by buildSignal
  // but never stamped re-picks every tick forever.
  const pickedSessionIds = candidates.map((c) => c.id);

  const signals: RumenSignal[] = [];
  for (const session of candidates) {
    try {
      const signal = buildSignal(session);
      if (signal) {
        signals.push(signal);
      }
    } catch (err) {
      console.error('[rumen-extract] failed for session ' + session.id + ':', err);
      // Do not rethrow — one bad session shouldn't kill the whole run.
    }
  }

  console.log('[rumen-extract] produced ' + signals.length + ' signals');

  return { signals, pickedSessionIds };
}

function buildSignal(session: MemorySession): RumenSignal | null {
  const summary = (session.summary ?? '').trim();
  if (summary.length === 0) {
    console.log('[rumen-extract] session ' + session.id + ' has no summary to search on');
    return null;
  }

  const searchText = summary.slice(0, 2000);
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
