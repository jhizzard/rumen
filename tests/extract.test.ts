/**
 * Rumen v0.3 — extract.ts test suite.
 *
 * Every test wires a mock pg.Pool that records each query and returns canned
 * rows. We verify the ExtractResult shape + bind-arg contract without ever
 * touching Postgres.
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

/** SQL shape detection — the order is deterministic: candidates → jobs → N × content. */
function isCandidateQuery(sql: string) {
  return sql.includes('FROM memory_items') && sql.includes('GROUP BY m.source_session_id');
}
function isJobsQuery(sql: string) {
  return sql.includes('FROM rumen_jobs');
}
function isContentQuery(sql: string) {
  return sql.includes('FROM memory_items') && sql.includes('LIMIT 5');
}

test('extractSignals: builds 3 signals from 3 candidate rows (happy path)', async () => {
  const { pool, calls } = makeMockPool({
    responses: (call: QueryCall) => {
      if (isCandidateQuery(call.sql)) {
        return {
          rows: [
            {
              id: 's1',
              project: 'alpha',
              summary: null,
              created_at: '2026-04-14T00:00:00Z',
              event_count: 5,
            },
            {
              id: 's2',
              project: 'beta',
              summary: null,
              created_at: '2026-04-14T01:00:00Z',
              event_count: 4,
            },
            {
              id: 's3',
              project: 'gamma',
              summary: null,
              created_at: '2026-04-14T02:00:00Z',
              event_count: 6,
            },
          ],
        };
      }
      if (isJobsQuery(call.sql)) return { rows: [] };
      if (isContentQuery(call.sql)) {
        return { rows: [{ content: 'hello world from ' + String(call.params[0]) }] };
      }
      return { rows: [] };
    },
  });

  const result = await quiet(() => extractSignals(pool, DEFAULT_OPTS));
  assert.equal(result.signals.length, 3);
  assert.deepEqual(
    result.signals.map((s) => s.key),
    ['session:s1', 'session:s2', 'session:s3'],
  );
  // 1 candidate + 1 jobs + 3 content = 5 calls.
  assert.equal(calls.length, 5);
});

test('extractSignals: candidate query is called with [lookbackHours, fetchLimit, minEventCount] bind args', async () => {
  const { pool, calls } = makeMockPool({
    responses: (call: QueryCall) => {
      if (isCandidateQuery(call.sql)) return { rows: [] };
      return { rows: [] };
    },
  });
  await quiet(() => extractSignals(pool, DEFAULT_OPTS));
  const candidateCall = calls.find((c) => isCandidateQuery(c.sql));
  assert.ok(candidateCall, 'expected a candidate query');
  assert.deepEqual(candidateCall!.params, [
    '72', // lookbackHours as string
    40, // maxSessions * 4 fetchLimit
    3, // minEventCount
  ]);
});

test('extractSignals: rows with event_count < minEventCount are dropped into skippedTrivial', async () => {
  const { pool } = makeMockPool({
    responses: (call: QueryCall) => {
      if (isCandidateQuery(call.sql)) {
        return {
          rows: [
            {
              id: 'trivial-1',
              project: 'alpha',
              summary: null,
              created_at: '2026-04-14T00:00:00Z',
              event_count: 1,
            },
            {
              id: 'keep-1',
              project: 'alpha',
              summary: null,
              created_at: '2026-04-14T00:00:00Z',
              event_count: 5,
            },
          ],
        };
      }
      if (isJobsQuery(call.sql)) return { rows: [] };
      if (isContentQuery(call.sql)) return { rows: [{ content: 'ok' }] };
      return { rows: [] };
    },
  });

  const result = await quiet(() => extractSignals(pool, DEFAULT_OPTS));
  assert.deepEqual(result.skippedTrivial, ['trivial-1']);
  assert.equal(result.signals.length, 1);
  assert.equal(result.signals[0]!.session_id, 'keep-1');
});

test('extractSignals: sessions appearing in a prior done rumen_jobs row go into skippedAlreadyProcessed', async () => {
  const { pool } = makeMockPool({
    responses: (call: QueryCall) => {
      if (isCandidateQuery(call.sql)) {
        return {
          rows: [
            {
              id: 'old-sess',
              project: 'alpha',
              summary: null,
              created_at: '2026-04-14T00:00:00Z',
              event_count: 5,
            },
            {
              id: 'new-sess',
              project: 'alpha',
              summary: null,
              created_at: '2026-04-14T00:00:00Z',
              event_count: 5,
            },
          ],
        };
      }
      if (isJobsQuery(call.sql)) {
        return { rows: [{ session_id: 'old-sess' }] };
      }
      if (isContentQuery(call.sql)) return { rows: [{ content: 'ok' }] };
      return { rows: [] };
    },
  });

  const result = await quiet(() => extractSignals(pool, DEFAULT_OPTS));
  assert.deepEqual(result.skippedAlreadyProcessed, ['old-sess']);
  assert.equal(result.signals.length, 1);
  assert.equal(result.signals[0]!.session_id, 'new-sess');
});

test('extractSignals: fresh candidates exceeding maxSessions are truncated', async () => {
  const { pool } = makeMockPool({
    responses: (call: QueryCall) => {
      if (isCandidateQuery(call.sql)) {
        return {
          rows: Array.from({ length: 5 }, (_, i) => ({
            id: 'sess-' + i,
            project: 'alpha',
            summary: null,
            created_at: '2026-04-14T00:00:00Z',
            event_count: 5,
          })),
        };
      }
      if (isJobsQuery(call.sql)) return { rows: [] };
      if (isContentQuery(call.sql)) return { rows: [{ content: 'ok' }] };
      return { rows: [] };
    },
  });

  const result = await quiet(() =>
    extractSignals(pool, { ...DEFAULT_OPTS, maxSessions: 2 }),
  );
  assert.equal(result.signals.length, 2);
  assert.deepEqual(
    result.signals.map((s) => s.session_id),
    ['sess-0', 'sess-1'],
  );
});

test('extractSignals: sessions with empty memory_items are silently dropped by buildSignal', async () => {
  const { pool } = makeMockPool({
    responses: (call: QueryCall) => {
      if (isCandidateQuery(call.sql)) {
        return {
          rows: [
            {
              id: 'empty-sess',
              project: 'alpha',
              summary: null,
              created_at: '2026-04-14T00:00:00Z',
              event_count: 5,
            },
          ],
        };
      }
      if (isJobsQuery(call.sql)) return { rows: [] };
      if (isContentQuery(call.sql)) return { rows: [] }; // no content
      return { rows: [] };
    },
  });

  const result = await quiet(() => extractSignals(pool, DEFAULT_OPTS));
  assert.equal(result.signals.length, 0);
  assert.deepEqual(result.skippedTrivial, []);
  assert.deepEqual(result.skippedAlreadyProcessed, []);
});

test('extractSignals: signal.key is always "session:<source_session_id>" for all inputs', async () => {
  const ids = ['abc-123', 'foo-bar', '9a8b7c6d'];
  const { pool } = makeMockPool({
    responses: (call: QueryCall) => {
      if (isCandidateQuery(call.sql)) {
        return {
          rows: ids.map((id) => ({
            id,
            project: 'alpha',
            summary: null,
            created_at: '2026-04-14T00:00:00Z',
            event_count: 5,
          })),
        };
      }
      if (isJobsQuery(call.sql)) return { rows: [] };
      if (isContentQuery(call.sql)) return { rows: [{ content: 'ok' }] };
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

test('extractSignals: a buildSignal failure does not kill sibling signals', async () => {
  let contentCall = 0;
  const { pool } = makeMockPool({
    responses: (call: QueryCall) => {
      if (isCandidateQuery(call.sql)) {
        return {
          rows: [
            {
              id: 'bad',
              project: 'alpha',
              summary: null,
              created_at: '2026-04-14T00:00:00Z',
              event_count: 5,
            },
            {
              id: 'good',
              project: 'alpha',
              summary: null,
              created_at: '2026-04-14T00:00:00Z',
              event_count: 5,
            },
          ],
        };
      }
      if (isJobsQuery(call.sql)) return { rows: [] };
      if (isContentQuery(call.sql)) {
        contentCall += 1;
        if (contentCall === 1) return new Error('boom');
        return { rows: [{ content: 'still ok' }] };
      }
      return { rows: [] };
    },
  });

  const result = await quiet(() => extractSignals(pool, DEFAULT_OPTS));
  assert.equal(result.signals.length, 1);
  assert.equal(result.signals[0]!.session_id, 'good');
});
