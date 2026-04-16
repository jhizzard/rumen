/**
 * Rumen v0.3 — surface.ts test suite.
 *
 * Verifies the Surface phase is strictly non-destructive (INSERT only), that
 * a failing INSERT for one insight doesn't kill siblings, and that empty
 * input is a silent no-op.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { surfaceInsights } from '../src/surface.ts';
import type { Insight } from '../src/types.ts';
import {
  makeMockPool,
  makeRelatedMemory,
  makeRelatedSignal,
  quiet,
  type QueryCall,
} from './helpers.ts';

const ID_A = '11111111-1111-1111-1111-111111111111';
const ID_B = '22222222-2222-2222-2222-222222222222';
const ID_C = '33333333-3333-3333-3333-333333333333';
const JOB_ID = 'job-1';

function makeInsight(key: string, memoryId: string): Insight {
  return {
    source: makeRelatedSignal({
      key,
      related: [makeRelatedMemory({ id: memoryId })],
    }),
    insight_text: 'insight for ' + key,
    confidence: 0.5,
    source_memory_ids: [memoryId],
    synthesized: true,
  };
}

test('surfaceInsights: every query issued is a non-destructive INSERT (no UPDATE or DELETE)', async () => {
  const { pool, calls } = makeMockPool({
    responses: [
      { rows: [{ id: 'row-1' }] },
      { rows: [{ id: 'row-2' }] },
      { rows: [{ id: 'row-3' }] },
    ],
  });
  const insights = [
    makeInsight('session:a', ID_A),
    makeInsight('session:b', ID_B),
    makeInsight('session:c', ID_C),
  ];

  const result = await quiet(() =>
    surfaceInsights(pool, insights, { jobId: JOB_ID }),
  );
  assert.equal(result.insightsGenerated, 3);
  assert.equal(result.insightIds.length, 3);
  assert.equal(calls.length, 3);
  for (const call of calls) {
    assert.match(call.sql, /INSERT INTO rumen_insights/);
    assert.doesNotMatch(call.sql, /\bUPDATE\b/);
    assert.doesNotMatch(call.sql, /\bDELETE\b/);
  }
});

test('surfaceInsights: one failed INSERT does not stop the remaining inserts', async () => {
  let call = 0;
  const { pool, calls } = makeMockPool({
    responses: (_: QueryCall) => {
      call += 1;
      if (call === 2) return new Error('unique violation');
      return { rows: [{ id: 'row-' + call }] };
    },
  });
  const insights = [
    makeInsight('session:a', ID_A),
    makeInsight('session:b', ID_B), // this one throws
    makeInsight('session:c', ID_C),
  ];

  const result = await quiet(() =>
    surfaceInsights(pool, insights, { jobId: JOB_ID }),
  );
  assert.equal(result.insightsGenerated, 2);
  assert.deepEqual(result.insightIds, ['row-1', 'row-3']);
  assert.equal(calls.length, 3, 'all three inserts should have been attempted');
});

test('surfaceInsights: empty insights array is a silent no-op — zero queries', async () => {
  const { pool, calls } = makeMockPool({ responses: [] });
  const result = await quiet(() =>
    surfaceInsights(pool, [], { jobId: JOB_ID }),
  );
  assert.deepEqual(result, { insightsGenerated: 0, insightIds: [] });
  assert.equal(calls.length, 0);
});

test('surfaceInsights: insights with empty source_memory_ids are skipped (not inserted)', async () => {
  const { pool, calls } = makeMockPool({
    responses: [{ rows: [{ id: 'row-1' }] }],
  });
  const insights: Insight[] = [
    {
      source: makeRelatedSignal({
        key: 'session:empty',
        related: [makeRelatedMemory({ id: ID_A })],
      }),
      insight_text: 'nothing to cite',
      confidence: 0.0,
      source_memory_ids: [],
      synthesized: false,
    },
    makeInsight('session:ok', ID_B),
  ];
  const result = await quiet(() =>
    surfaceInsights(pool, insights, { jobId: JOB_ID }),
  );
  assert.equal(result.insightsGenerated, 1);
  assert.equal(calls.length, 1);
});

test('surfaceInsights: projects column is deduped from signal + related and passed as text[]', async () => {
  const { pool, calls } = makeMockPool({
    responses: [{ rows: [{ id: 'row-1' }] }],
  });
  const insights: Insight[] = [
    {
      source: makeRelatedSignal({
        key: 'session:a',
        project: 'alpha',
        related: [
          makeRelatedMemory({ id: ID_A, project: 'beta' }),
          makeRelatedMemory({ id: ID_B, project: 'beta' }),
          makeRelatedMemory({ id: ID_C, project: null }),
        ],
      }),
      insight_text: 'cross-project insight',
      confidence: 0.8,
      source_memory_ids: [ID_A, ID_B, ID_C],
      synthesized: true,
    },
  ];
  await quiet(() => surfaceInsights(pool, insights, { jobId: JOB_ID }));
  assert.equal(calls.length, 1);
  const params = calls[0]!.params;
  // [jobId, source_memory_ids, projects, insight_text, confidence]
  assert.equal(params[0], JOB_ID);
  assert.deepEqual(params[1], [ID_A, ID_B, ID_C]);
  // alpha (signal) + beta (dedup from two rows); null skipped.
  assert.deepEqual(params[2], ['alpha', 'beta']);
  assert.equal(params[3], 'cross-project insight');
  assert.equal(params[4], 0.8);
});
