/**
 * Rumen v0.4 — relate.ts test suite.
 *
 * Keyword-only fallback mode is forced for every test by deleting
 * OPENAI_API_KEY before relateSignals runs, so no test ever touches the real
 * OpenAI embeddings endpoint. The hybrid-mode code path is covered
 * separately by T3's integration kickstart.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { relateSignals } from '../src/relate.ts';
import { normalize, NORMALIZE_VERSION } from '../src/confidence.ts';
import type { RumenSignal } from '../src/types.ts';
import { makeMockPool, quiet, type QueryCall } from './helpers.ts';

// Force keyword-only mode for the whole suite so generateEmbedding is never
// invoked and no real HTTP calls can leak out.
delete process.env['OPENAI_API_KEY'];

function sig(key: string, search = 'some text'): RumenSignal {
  return {
    key,
    session_id: key.replace('session:', ''),
    project: 'alpha',
    description: 'desc',
    search_text: search,
    event_count: 4,
  };
}

function isHybridSearchQuery(sql: string) {
  return sql.includes('memory_hybrid_search');
}

test('relateOne: caps the result set at top-5 even when memory_hybrid_search returns 10 rows', async () => {
  const { pool } = makeMockPool({
    responses: [
      {
        rows: Array.from({ length: 10 }, (_, i) => ({
          id: 'mem-' + i,
          content: 'content ' + i,
          source_type: 'session',
          project: 'alpha',
          created_at: '2026-04-01T00:00:00Z',
          similarity: 0.9 - i * 0.01,
        })),
      },
    ],
  });
  const out = await quiet(() =>
    relateSignals(pool, [sig('session:a')], { minSimilarity: 0.0 }),
  );
  assert.equal(out.length, 1);
  assert.equal(out[0]!.related.length, 5);
  // Sorted descending; top-5 are the highest-similarity rows.
  assert.equal(out[0]!.related[0]!.id, 'mem-0');
  assert.equal(out[0]!.related[4]!.id, 'mem-4');
});

test('relateOne: rows below minSimilarity are dropped before the top-K slice', async () => {
  const { pool } = makeMockPool({
    responses: [
      {
        rows: [
          {
            id: 'hi',
            content: 'a',
            source_type: 's',
            project: 'alpha',
            created_at: '2026-04-01T00:00:00Z',
            similarity: 0.85,
          },
          {
            id: 'mid',
            content: 'b',
            source_type: 's',
            project: 'alpha',
            created_at: '2026-04-01T00:00:00Z',
            similarity: 0.75,
          },
          {
            id: 'lo',
            content: 'c',
            source_type: 's',
            project: 'alpha',
            created_at: '2026-04-01T00:00:00Z',
            similarity: 0.2,
          },
        ],
      },
    ],
  });
  const out = await quiet(() =>
    relateSignals(pool, [sig('session:a')], { minSimilarity: 0.7 }),
  );
  assert.equal(out[0]!.related.length, 2);
  assert.deepEqual(
    out[0]!.related.map((r) => r.id),
    ['hi', 'mid'],
  );
});

test('relateSignals: a query failure for one signal is isolated — remaining signals still return related lists', async () => {
  let call = 0;
  const { pool } = makeMockPool({
    responses: (_: QueryCall) => {
      call += 1;
      if (call === 1) return new Error('first signal db error');
      return {
        rows: [
          {
            id: 'ok',
            content: 'ok',
            source_type: 's',
            project: 'alpha',
            created_at: '2026-04-01T00:00:00Z',
            similarity: 0.9,
          },
        ],
      };
    },
  });
  const out = await quiet(() =>
    relateSignals(
      pool,
      [sig('session:bad'), sig('session:good')],
      { minSimilarity: 0.5 },
    ),
  );
  assert.equal(out.length, 2);
  assert.equal(out[0]!.signal.key, 'session:bad');
  assert.deepEqual(out[0]!.related, []);
  assert.equal(out[1]!.signal.key, 'session:good');
  assert.equal(out[1]!.related.length, 1);
  assert.equal(out[1]!.related[0]!.id, 'ok');
});

test('relateOne: the query selects "score AS similarity" and the returned row preserves similarity', async () => {
  const { pool, calls } = makeMockPool({
    responses: [
      {
        rows: [
          {
            id: 'mem-1',
            content: 'match',
            source_type: 'session',
            project: 'alpha',
            created_at: '2026-04-01T00:00:00Z',
            similarity: 0.73,
          },
        ],
      },
    ],
  });
  const out = await quiet(() =>
    relateSignals(pool, [sig('session:a')], { minSimilarity: 0.5 }),
  );
  const hybridCall = calls.find((c) => isHybridSearchQuery(c.sql));
  assert.ok(hybridCall, 'expected a memory_hybrid_search call');
  assert.match(hybridCall!.sql, /score AS similarity/);
  assert.equal(out[0]!.related.length, 1);
  assert.equal(out[0]!.related[0]!.similarity, 0.73);
});

test('relateOne: rows with non-numeric similarity are silently dropped', async () => {
  const { pool } = makeMockPool({
    responses: [
      {
        rows: [
          {
            id: 'nan',
            content: 'a',
            source_type: 's',
            project: 'alpha',
            created_at: '2026-04-01T00:00:00Z',
            similarity: Number.NaN,
          },
          {
            id: 'valid',
            content: 'b',
            source_type: 's',
            project: 'alpha',
            created_at: '2026-04-01T00:00:00Z',
            similarity: 0.8,
          },
        ],
      },
    ],
  });
  const out = await quiet(() =>
    relateSignals(pool, [sig('session:a')], { minSimilarity: 0.5 }),
  );
  assert.equal(out[0]!.related.length, 1);
  assert.equal(out[0]!.related[0]!.id, 'valid');
});

// ---------------------------------------------------------------------------
// confidence.normalize — pure-function unit tests (T3, Sprint 26).
//
// Curve (see src/confidence.ts):
//   contextSize <= 1  → raw * 0.4
//   contextSize <  5  → raw * 0.7
//   contextSize < 15  → raw * 0.9
//   contextSize >= 15 → raw
// Non-finite raw → 0; raw outside [0,1] is clamped before scaling.
// ---------------------------------------------------------------------------

test('normalize: zero raw score → 0 regardless of context size', () => {
  assert.equal(normalize(0, 10), 0);
});

test('normalize: single-source context (size=1) caps at 0.4 ceiling', () => {
  // 0.5 * 0.4 = 0.2
  assert.equal(normalize(0.5, 1), 0.2);
});

test('normalize: small cluster (size<5) caps at 0.7 ceiling', () => {
  // 0.5 * 0.7 = 0.35
  assert.equal(normalize(0.5, 3), 0.35);
});

test('normalize: medium cluster (size<15) caps at 0.9 ceiling', () => {
  // 0.5 * 0.9 = 0.45
  assert.equal(normalize(0.5, 10), 0.45);
});

test('normalize: large cluster (size>=15) reaches full range', () => {
  assert.equal(normalize(0.5, 20), 0.5);
});

test('normalize: raw above 1 is clamped before scaling (1.5 @ size=10 → 0.9)', () => {
  assert.equal(normalize(1.5, 10), 0.9);
});

test('normalize: NaN raw → 0', () => {
  assert.equal(normalize(Number.NaN, 10), 0);
});

test('normalize: NORMALIZE_VERSION is exported and is an integer', () => {
  assert.equal(typeof NORMALIZE_VERSION, 'number');
  assert.ok(Number.isInteger(NORMALIZE_VERSION));
  assert.ok(NORMALIZE_VERSION >= 1);
});

test('relateSignals: keyword-only mode (no OPENAI_API_KEY) binds NULL for query_embedding and semantic_weight=0', async () => {
  const { pool, calls } = makeMockPool({
    responses: [{ rows: [] }],
  });
  await quiet(() =>
    relateSignals(pool, [sig('session:a', 'hello')], { minSimilarity: 0.5 }),
  );
  const hybridCall = calls.find((c) => isHybridSearchQuery(c.sql));
  assert.ok(hybridCall);
  // [search_text, vectorParam, TOP_K, fullTextWeight, semanticWeight]
  assert.equal(hybridCall!.params[0], 'hello');
  assert.equal(hybridCall!.params[1], null, 'vectorParam should be null in keyword-only mode');
  assert.equal(hybridCall!.params[2], 5);
  assert.equal(hybridCall!.params[3], 1.0);
  assert.equal(hybridCall!.params[4], 0.0);
});
