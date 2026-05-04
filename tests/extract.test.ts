/**
 * Rumen v0.5 — extract.ts test suite.
 *
 * Sprint 53 picker rewrite tests. The picker now reads `memory_sessions`
 * directly (one row per session, post-Sprint-51.6 bundled hook) and uses
 * a single SELECT with `WHERE rumen_processed_at IS NULL` for idempotency.
 * No second roundtrip to memory_items, no rumen_jobs cross-check.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractSignals } from '../src/extract.ts';
import { makeMockPool, quiet, type QueryCall } from './helpers.ts';

const DEFAULT_OPTS = {
  lookbackHours: 72,
  maxSessions: 10,
  minEventCount: 3,
};

/** SQL shape detection — the rewritten picker is one SELECT against memory_sessions. */
function isCandidateQuery(sql: string) {
  return (
    sql.includes('FROM memory_sessions') &&
    sql.includes('rumen_processed_at IS NULL')
  );
}

test('extractSignals: builds 3 signals from 3 memory_sessions rows (happy path)', async () => {
  const { pool, calls } = makeMockPool({
    responses: (call: QueryCall) => {
      if (isCandidateQuery(call.sql)) {
        return {
          rows: [
            {
              id: '11111111-1111-1111-1111-111111111111',
              project: 'alpha',
              summary: 'session 1 summary text',
              created_at: '2026-04-14T00:00:00Z',
              event_count: 5,
            },
            {
              id: '22222222-2222-2222-2222-222222222222',
              project: 'beta',
              summary: 'session 2 summary text',
              created_at: '2026-04-14T01:00:00Z',
              event_count: 4,
            },
            {
              id: '33333333-3333-3333-3333-333333333333',
              project: 'gamma',
              summary: 'session 3 summary text',
              created_at: '2026-04-14T02:00:00Z',
              event_count: 6,
            },
          ],
        };
      }
      return { rows: [] };
    },
  });

  const result = await quiet(() => extractSignals(pool, DEFAULT_OPTS));
  assert.equal(result.signals.length, 3);
  assert.deepEqual(
    result.signals.map((s) => s.key),
    [
      'session:11111111-1111-1111-1111-111111111111',
      'session:22222222-2222-2222-2222-222222222222',
      'session:33333333-3333-3333-3333-333333333333',
    ],
  );
  // Single SELECT, no second roundtrip — picker is one query.
  assert.equal(calls.length, 1);
});

test('extractSignals: candidate query is called with [lookbackHours, maxSessions, minEventCount] bind args', async () => {
  const { pool, calls } = makeMockPool({
    responses: () => ({ rows: [] }),
  });
  await quiet(() => extractSignals(pool, DEFAULT_OPTS));
  const candidateCall = calls.find((c) => isCandidateQuery(c.sql));
  assert.ok(candidateCall, 'expected a candidate query');
  assert.deepEqual(candidateCall!.params, [
    '72', // lookbackHours as string
    10,   // maxSessions (no x4 headroom — SQL pre-filters)
    3,    // minEventCount
  ]);
});

test('extractSignals: candidate SQL filters rumen_processed_at IS NULL and ended_at IS NOT NULL', async () => {
  const { pool, calls } = makeMockPool({
    responses: () => ({ rows: [] }),
  });
  await quiet(() => extractSignals(pool, DEFAULT_OPTS));
  const candidateCall = calls.find((c) => c.sql.includes('FROM memory_sessions'));
  assert.ok(candidateCall, 'expected a candidate query');
  assert.match(candidateCall!.sql, /rumen_processed_at IS NULL/);
  assert.match(candidateCall!.sql, /ended_at IS NOT NULL/);
});

test('extractSignals: candidate SQL filters by messages_count >= minEventCount', async () => {
  const { pool, calls } = makeMockPool({
    responses: () => ({ rows: [] }),
  });
  await quiet(() => extractSignals(pool, DEFAULT_OPTS));
  const candidateCall = calls.find((c) => c.sql.includes('FROM memory_sessions'));
  assert.ok(candidateCall, 'expected a candidate query');
  assert.match(candidateCall!.sql, /messages_count[^<>]*>=/);
});

test('extractSignals: candidate SQL filters out empty/null summaries', async () => {
  // T4-CODEX 17:25 ET pre-FIX catch — empty summaries can't generate signals,
  // so they must be filtered at SQL or stamped, otherwise they re-pick forever.
  const { pool, calls } = makeMockPool({
    responses: () => ({ rows: [] }),
  });
  await quiet(() => extractSignals(pool, DEFAULT_OPTS));
  const candidateCall = calls.find((c) => c.sql.includes('FROM memory_sessions'));
  assert.ok(candidateCall, 'expected a candidate query');
  assert.match(candidateCall!.sql, /summary IS NOT NULL/);
  assert.match(candidateCall!.sql, /summary <> ''/);
});

test('extractSignals: pickedSessionIds includes ALL fetched candidates (signal-emitting AND dropped)', async () => {
  // T4-CODEX 17:25 ET — orchestrator stamps pickedSessionIds (not signal IDs)
  // so a buildSignal dropout still gets rumen_processed_at stamped and
  // doesn't infinite-loop.
  const { pool } = makeMockPool({
    responses: (call: QueryCall) => {
      if (isCandidateQuery(call.sql)) {
        return {
          rows: [
            {
              id: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
              project: 'alpha',
              summary: 'has summary',
              created_at: '2026-04-14T00:00:00Z',
              event_count: 5,
            },
            {
              id: 'dddddddd-dddd-dddd-dddd-dddddddddddd',
              project: 'alpha',
              summary: '', // empty — buildSignal will drop
              created_at: '2026-04-14T00:00:00Z',
              event_count: 5,
            },
          ],
        };
      }
      return { rows: [] };
    },
  });

  const result = await quiet(() => extractSignals(pool, DEFAULT_OPTS));
  assert.equal(result.signals.length, 1);
  assert.deepEqual(result.pickedSessionIds, [
    'cccccccc-cccc-cccc-cccc-cccccccccccc',
    'dddddddd-dddd-dddd-dddd-dddddddddddd',
  ]);
});

test('extractSignals: rows with empty summary are silently dropped by buildSignal', async () => {
  const { pool } = makeMockPool({
    responses: (call: QueryCall) => {
      if (isCandidateQuery(call.sql)) {
        return {
          rows: [
            {
              id: '44444444-4444-4444-4444-444444444444',
              project: 'alpha',
              summary: '',
              created_at: '2026-04-14T00:00:00Z',
              event_count: 5,
            },
            {
              id: '55555555-5555-5555-5555-555555555555',
              project: 'alpha',
              summary: 'has content',
              created_at: '2026-04-14T01:00:00Z',
              event_count: 5,
            },
          ],
        };
      }
      return { rows: [] };
    },
  });

  const result = await quiet(() => extractSignals(pool, DEFAULT_OPTS));
  assert.equal(result.signals.length, 1);
  assert.equal(result.signals[0]!.session_id, '55555555-5555-5555-5555-555555555555');
});

test('extractSignals: rows with null summary are silently dropped by buildSignal', async () => {
  const { pool } = makeMockPool({
    responses: (call: QueryCall) => {
      if (isCandidateQuery(call.sql)) {
        return {
          rows: [
            {
              id: '66666666-6666-6666-6666-666666666666',
              project: 'alpha',
              summary: null,
              created_at: '2026-04-14T00:00:00Z',
              event_count: 5,
            },
          ],
        };
      }
      return { rows: [] };
    },
  });

  const result = await quiet(() => extractSignals(pool, DEFAULT_OPTS));
  assert.equal(result.signals.length, 0);
});

test('extractSignals: signal.key is always "session:<memory_sessions.id>" for all rows', async () => {
  const ids = [
    '77777777-7777-7777-7777-777777777777',
    '88888888-8888-8888-8888-888888888888',
    '99999999-9999-9999-9999-999999999999',
  ];
  const { pool } = makeMockPool({
    responses: (call: QueryCall) => {
      if (isCandidateQuery(call.sql)) {
        return {
          rows: ids.map((id) => ({
            id,
            project: 'alpha',
            summary: 'a summary',
            created_at: '2026-04-14T00:00:00Z',
            event_count: 5,
          })),
        };
      }
      return { rows: [] };
    },
  });

  const result = await quiet(() => extractSignals(pool, DEFAULT_OPTS));
  assert.equal(result.signals.length, 3);
  assert.deepEqual(
    result.signals.map((s) => s.key),
    ids.map((id) => 'session:' + id),
  );
});

test('extractSignals: signal.search_text is the session summary directly (no second roundtrip)', async () => {
  const summary = 'this is the bundled-hook summary that becomes the search text';
  const { pool, calls } = makeMockPool({
    responses: (call: QueryCall) => {
      if (isCandidateQuery(call.sql)) {
        return {
          rows: [
            {
              id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
              project: 'alpha',
              summary,
              created_at: '2026-04-14T00:00:00Z',
              event_count: 5,
            },
          ],
        };
      }
      return { rows: [] };
    },
  });

  const result = await quiet(() => extractSignals(pool, DEFAULT_OPTS));
  assert.equal(result.signals.length, 1);
  assert.equal(result.signals[0]!.search_text, summary);
  // No second query — buildSignal is pure, doesn't touch the pool.
  assert.equal(calls.length, 1);
});

test('extractSignals: signal.search_text is truncated to 2000 chars on long summaries', async () => {
  const longSummary = 'x'.repeat(5000);
  const { pool } = makeMockPool({
    responses: (call: QueryCall) => {
      if (isCandidateQuery(call.sql)) {
        return {
          rows: [
            {
              id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
              project: 'alpha',
              summary: longSummary,
              created_at: '2026-04-14T00:00:00Z',
              event_count: 5,
            },
          ],
        };
      }
      return { rows: [] };
    },
  });

  const result = await quiet(() => extractSignals(pool, DEFAULT_OPTS));
  assert.equal(result.signals[0]!.search_text.length, 2000);
});

test('extractSignals: pool failure during candidate query bubbles up', async () => {
  const { pool } = makeMockPool({
    responses: (call: QueryCall) => {
      if (isCandidateQuery(call.sql)) {
        return new Error('pg connection refused');
      }
      return { rows: [] };
    },
  });

  await assert.rejects(
    () => quiet(() => extractSignals(pool, DEFAULT_OPTS)),
    /pg connection refused/,
  );
});
