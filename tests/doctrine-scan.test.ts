/**
 * Rumen Sprint 79 — doctrine-scan.ts test suite.
 *
 * Pure math/graph helpers are tested in isolation with small hand-computed
 * vectors (identical vectors -> cosine 1, orthogonal -> cosine 0) so
 * expected values never depend on floating-point approximation. The
 * orchestration tests force ANTHROPIC_API_KEY unset except where a mock
 * client is explicitly injected, so no test ever touches the real Anthropic
 * endpoint.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseVectorLiteral,
  cosineSimilarity,
  meanPairwiseSimilarity,
  computeCentroid,
  findConnectedComponents,
  splitIncoherentComponent,
  qualifiesStructurally,
  validateVerdict,
  runDoctrineScan,
} from '../src/doctrine-scan.ts';
import { makeMockPool, makeMockAnthropic, quiet, type QueryCall } from './helpers.ts';

delete process.env['ANTHROPIC_API_KEY'];

// ---------------------------------------------------------------------------
// parseVectorLiteral / cosineSimilarity / meanPairwiseSimilarity / computeCentroid
// ---------------------------------------------------------------------------

test('parseVectorLiteral: round-trips a bracketed literal into numbers', () => {
  assert.deepEqual(parseVectorLiteral('[0.1,-0.2,0.3]'), [0.1, -0.2, 0.3]);
});

test('parseVectorLiteral: empty brackets return an empty array', () => {
  assert.deepEqual(parseVectorLiteral('[]'), []);
});

test('cosineSimilarity: identical vectors are 1', () => {
  assert.equal(cosineSimilarity([1, 0], [1, 0]), 1);
});

test('cosineSimilarity: orthogonal vectors are 0', () => {
  assert.equal(cosineSimilarity([1, 0], [0, 1]), 0);
});

test('cosineSimilarity: opposite vectors are -1', () => {
  assert.equal(cosineSimilarity([1, 0], [-1, 0]), -1);
});

test('cosineSimilarity: a zero vector returns 0 rather than NaN', () => {
  assert.equal(cosineSimilarity([0, 0], [1, 0]), 0);
});

test('meanPairwiseSimilarity: fewer than 2 vectors is trivially coherent (1)', () => {
  assert.equal(meanPairwiseSimilarity([]), 1);
  assert.equal(meanPairwiseSimilarity([[1, 0]]), 1);
});

test('meanPairwiseSimilarity: three identical vectors average to 1', () => {
  assert.equal(meanPairwiseSimilarity([[1, 0], [1, 0], [1, 0]]), 1);
});

test('meanPairwiseSimilarity: mixed similar/orthogonal averages correctly', () => {
  // pairs: AB=1, AC=0, BC=0 -> mean = 1/3
  const mean = meanPairwiseSimilarity([[1, 0], [1, 0], [0, 1]]);
  assert.ok(Math.abs(mean - 1 / 3) < 1e-9);
});

test('computeCentroid: mean of identical vectors is the same unit vector', () => {
  const centroid = computeCentroid([[1, 0], [1, 0]]);
  assert.ok(Math.abs(centroid[0]! - 1) < 1e-9);
  assert.ok(Math.abs(centroid[1]! - 0) < 1e-9);
});

test('computeCentroid: is re-normalized to unit length', () => {
  const centroid = computeCentroid([[3, 4], [3, 4]]); // mean = [3,4], norm 5
  const norm = Math.sqrt(centroid.reduce((acc, x) => acc + x * x, 0));
  assert.ok(Math.abs(norm - 1) < 1e-9);
  assert.ok(Math.abs(centroid[0]! - 0.6) < 1e-9);
  assert.ok(Math.abs(centroid[1]! - 0.8) < 1e-9);
});

test('computeCentroid: empty input returns empty array (no NaN/throw)', () => {
  assert.deepEqual(computeCentroid([]), []);
});

// ---------------------------------------------------------------------------
// findConnectedComponents
// ---------------------------------------------------------------------------

test('findConnectedComponents: two disjoint chains stay separate', () => {
  const components = findConnectedComponents(
    ['a', 'b', 'c', 'd', 'e'],
    [
      { source_id: 'a', target_id: 'b' },
      { source_id: 'b', target_id: 'c' },
      { source_id: 'd', target_id: 'e' },
    ],
  );
  const sorted = components.map((c) => [...c].sort()).sort((x, y) => x[0]!.localeCompare(y[0]!));
  assert.deepEqual(sorted, [['a', 'b', 'c'], ['d', 'e']]);
});

test('findConnectedComponents: isolated node with no edges is its own singleton component', () => {
  const components = findConnectedComponents(['a', 'b'], []);
  const sorted = components.map((c) => [...c].sort());
  assert.deepEqual(sorted.sort(), [['a'], ['b']]);
});

test('findConnectedComponents: edges referencing an unknown id are ignored, not throw', () => {
  const components = findConnectedComponents(
    ['a', 'b'],
    [{ source_id: 'a', target_id: 'ghost' }],
  );
  assert.equal(components.length, 2);
});

// ---------------------------------------------------------------------------
// splitIncoherentComponent
// ---------------------------------------------------------------------------

test('splitIncoherentComponent: cuts the weakest edge and keeps the coherent remainder', () => {
  // a, b, c are identical (mean pairwise 1); d is orthogonal to all three but
  // structurally chained on via a weak c-d edge. Whole-component mean
  // pairwise is 0.5 (< 0.85), so it must split.
  const embeddingById = new Map<string, number[]>([
    ['a', [1, 0]],
    ['b', [1, 0]],
    ['c', [1, 0]],
    ['d', [0, 1]],
  ]);
  const edges = [
    { source_id: 'a', target_id: 'b', weight: 0.99 },
    { source_id: 'b', target_id: 'c', weight: 0.99 },
    { source_id: 'c', target_id: 'd', weight: 0.5 },
  ];
  const result = splitIncoherentComponent(['a', 'b', 'c', 'd'], edges, embeddingById);
  assert.equal(result.length, 1);
  assert.deepEqual([...result[0]!].sort(), ['a', 'b', 'c']);
});

test('splitIncoherentComponent: an already-coherent component is returned unsplit', () => {
  const embeddingById = new Map<string, number[]>([
    ['a', [1, 0]],
    ['b', [1, 0]],
    ['c', [1, 0]],
  ]);
  const edges = [
    { source_id: 'a', target_id: 'b', weight: 0.9 },
    { source_id: 'b', target_id: 'c', weight: 0.9 },
  ];
  const result = splitIncoherentComponent(['a', 'b', 'c'], edges, embeddingById);
  assert.equal(result.length, 1);
  assert.deepEqual([...result[0]!].sort(), ['a', 'b', 'c']);
});

test('splitIncoherentComponent: a component with no internal edges to cut is dropped, not looped forever', () => {
  const embeddingById = new Map<string, number[]>([
    ['a', [1, 0]],
    ['b', [0, 1]],
    ['c', [1, 1]],
  ]);
  const result = splitIncoherentComponent(['a', 'b', 'c'], [], embeddingById);
  assert.deepEqual(result, []);
});

// ---------------------------------------------------------------------------
// qualifiesStructurally
// ---------------------------------------------------------------------------

test('qualifiesStructurally: fewer than 3 members never qualifies', () => {
  assert.equal(
    qualifiesStructurally([
      { project: 'alpha', created_at: '2026-01-01' },
      { project: 'beta', created_at: '2026-01-01' },
    ]),
    false,
  );
});

test('qualifiesStructurally: 3 members, same project, same day fails both gates', () => {
  const members = Array.from({ length: 3 }, () => ({ project: 'alpha', created_at: '2026-01-01T00:00:00Z' }));
  assert.equal(qualifiesStructurally(members), false);
});

test('qualifiesStructurally: 3 members spanning 2 projects passes on project-span alone', () => {
  const members = [
    { project: 'alpha', created_at: '2026-01-01T00:00:00Z' },
    { project: 'alpha', created_at: '2026-01-01T00:00:00Z' },
    { project: 'beta', created_at: '2026-01-01T00:00:00Z' },
  ];
  assert.equal(qualifiesStructurally(members), true);
});

test('qualifiesStructurally: 3 members, one project, >=21 day spread passes on date-spread alone', () => {
  const members = [
    { project: 'alpha', created_at: '2026-01-01T00:00:00Z' },
    { project: 'alpha', created_at: '2026-01-10T00:00:00Z' },
    { project: 'alpha', created_at: '2026-01-25T00:00:00Z' },
  ];
  assert.equal(qualifiesStructurally(members), true);
});

test('qualifiesStructurally: 3 members, one project, 20 day spread (just under) fails', () => {
  const members = [
    { project: 'alpha', created_at: '2026-01-01T00:00:00Z' },
    { project: 'alpha', created_at: '2026-01-10T00:00:00Z' },
    { project: 'alpha', created_at: '2026-01-20T00:00:00Z' },
  ];
  assert.equal(qualifiesStructurally(members), false);
});

// ---------------------------------------------------------------------------
// validateVerdict
// ---------------------------------------------------------------------------

test('validateVerdict: valid kitchen verdict parses and trims/caps fields', () => {
  const validIds = new Set(['m1']);
  const raw = {
    coherent: true,
    verdict: 'kitchen',
    title: '  A short title  ',
    doctrine_text: '  The general lesson.  ',
    evidence: [{ date: '2026-01-01', gist: '  paraphrased gist  ' }, { date: '2026-02-02', gist: '' }],
    trigger_hints: Array.from({ length: 12 }, (_, i) => 'hint' + i),
    rationale: 'because',
  };
  const verdict = validateVerdict(raw, validIds);
  assert.ok(verdict);
  assert.equal(verdict!.coherent, true);
  assert.equal(verdict!.verdict, 'kitchen');
  assert.equal(verdict!.title, 'A short title');
  assert.equal(verdict!.doctrine_text, 'The general lesson.');
  // the empty-gist entry is dropped
  assert.equal(verdict!.evidence.length, 1);
  assert.equal(verdict!.evidence[0]!.gist, 'paraphrased gist');
  // trigger_hints capped at 8
  assert.equal(verdict!.trigger_hints.length, 8);
});

test('validateVerdict: valid recipe verdict parses with null synthesis fields', () => {
  const verdict = validateVerdict(
    { coherent: true, verdict: 'recipe', rationale: 'too specific' },
    new Set(['m1']),
  );
  assert.ok(verdict);
  assert.equal(verdict!.verdict, 'recipe');
  assert.equal(verdict!.title, null);
  assert.equal(verdict!.doctrine_text, null);
});

test('validateVerdict: valid incoherent verdict returns a clean partition', () => {
  const validIds = new Set(['a', 'b', 'c', 'd']);
  const verdict = validateVerdict(
    { coherent: false, groups: [['a', 'b'], ['c', 'd']], rationale: 'two unrelated topics' },
    validIds,
  );
  assert.ok(verdict);
  assert.equal(verdict!.coherent, false);
  assert.deepEqual(verdict!.groups, [['a', 'b'], ['c', 'd']]);
});

test('validateVerdict: rejects a partition that omits an id', () => {
  const validIds = new Set(['a', 'b', 'c']);
  const verdict = validateVerdict({ coherent: false, groups: [['a'], ['b']] }, validIds);
  assert.equal(verdict, null);
});

test('validateVerdict: rejects a partition where an id appears in two groups', () => {
  const validIds = new Set(['a', 'b']);
  const verdict = validateVerdict({ coherent: false, groups: [['a', 'b'], ['a']] }, validIds);
  assert.equal(verdict, null);
});

test('validateVerdict: rejects a single-group "partition"', () => {
  const validIds = new Set(['a', 'b']);
  const verdict = validateVerdict({ coherent: false, groups: [['a', 'b']] }, validIds);
  assert.equal(verdict, null);
});

test('validateVerdict: missing coherent field is rejected', () => {
  assert.equal(validateVerdict({ verdict: 'kitchen' }, new Set(['m1'])), null);
});

test('validateVerdict: coherent kitchen missing doctrine_text is rejected', () => {
  const raw = { coherent: true, verdict: 'kitchen', title: 'x' };
  assert.equal(validateVerdict(raw, new Set(['m1'])), null);
});

test('validateVerdict: non-object input is rejected', () => {
  assert.equal(validateVerdict('not json', new Set(['m1'])), null);
  assert.equal(validateVerdict(null, new Set(['m1'])), null);
});

// ---------------------------------------------------------------------------
// runDoctrineScan — orchestration against a mock pool
// ---------------------------------------------------------------------------

function isSql(call: QueryCall, needle: string): boolean {
  return call.sql.includes(needle);
}

const NODE_A = {
  id: 'm1',
  project: 'alpha',
  created_at: '2026-01-01T00:00:00Z',
  content: 'lesson one',
  content_hash: 'h1',
  embedding: '[1,0]',
};
const NODE_B = {
  id: 'm2',
  project: 'alpha',
  created_at: '2026-01-01T00:00:00Z',
  content: 'lesson two',
  content_hash: 'h2',
  embedding: '[1,0]',
};
const NODE_C = {
  id: 'm3',
  project: 'beta',
  created_at: '2026-01-01T00:00:00Z',
  content: 'lesson three',
  content_hash: 'h3',
  embedding: '[1,0]',
};

test('runDoctrineScan: no cluster-eligible edges completes cleanly with zeroed counters', async () => {
  const { pool } = makeMockPool({
    responses: (call) => {
      if (isSql(call, 'INSERT INTO doctrine_jobs')) return { rows: [{ id: 'job-1', started_at: 'now' }] };
      if (isSql(call, 'AS pool_size')) return { rows: [{ pool_size: 42 }] };
      if (isSql(call, 'memory_relationships')) return { rows: [] };
      if (isSql(call, 'UPDATE doctrine_jobs')) {
        return {
          rows: [
            {
              id: 'job-1', status: 'done', pool_size: 42, edge_count: 0, components_scanned: 0,
              clusters_qualified: 0, clusters_split: 0, candidates_drafted: 0,
              candidates_reinforced: 0, llm_calls_made: 0, note: null, error_message: null,
              started_at: 'now', completed_at: 'now',
            },
          ],
        };
      }
      throw new Error('unexpected query: ' + call.sql);
    },
  });
  const summary = await quiet(() => runDoctrineScan(pool));
  assert.equal(summary.status, 'done');
  assert.equal(summary.edge_count, 0);
  assert.equal(summary.candidates_drafted, 0);
});

test('runDoctrineScan: no API key — Phase A drafts a placeholder candidate, Phase B is skipped', async () => {
  const { pool, calls } = makeMockPool({
    responses: (call) => {
      if (isSql(call, 'INSERT INTO doctrine_jobs')) return { rows: [{ id: 'job-1', started_at: 'now' }] };
      if (isSql(call, 'AS pool_size')) return { rows: [{ pool_size: 3 }] };
      if (isSql(call, 'memory_relationships')) {
        return {
          rows: [
            { source_id: 'm1', target_id: 'm2', weight: 0.9 },
            { source_id: 'm2', target_id: 'm3', weight: 0.9 },
          ],
        };
      }
      if (isSql(call, 'embedding::text')) return { rows: [NODE_A, NODE_B, NODE_C] };
      if (isSql(call, 'ORDER BY centroid')) return { rows: [] }; // no existing doctrine rows
      if (isSql(call, 'INSERT INTO doctrine_registry')) return { rows: [{ id: 'doc-1', status: 'candidate' }] };
      if (isSql(call, 'UPDATE doctrine_jobs')) {
        return {
          rows: [
            {
              id: 'job-1', status: 'done', pool_size: 3, edge_count: 2, components_scanned: 1,
              clusters_qualified: 1, clusters_split: 0, candidates_drafted: 1,
              candidates_reinforced: 0, llm_calls_made: 0, note: 'no_api_key_phase_b_skipped',
              error_message: null, started_at: 'now', completed_at: 'now',
            },
          ],
        };
      }
      throw new Error('unexpected query: ' + call.sql);
    },
  });
  const summary = await quiet(() => runDoctrineScan(pool));
  assert.equal(summary.candidates_drafted, 1);
  assert.equal(summary.llm_calls_made, 0);
  assert.equal(summary.note, 'no_api_key_phase_b_skipped');
  assert.ok(!calls.some((c) => isSql(c, "status = 'drafted'")));
});

test('runDoctrineScan: with a key, a new qualifying cluster is synthesized to drafted', async () => {
  const { client } = makeMockAnthropic(
    JSON.stringify({
      coherent: true,
      verdict: 'kitchen',
      title: 'Always cap wall-clock budgets',
      doctrine_text: 'Any loop that can make N external calls needs a wall-clock deadline, not just a call-count cap.',
      evidence: [{ date: '2026-07-01', gist: 'a tick job rode the platform kill for days before this was added' }],
      trigger_hints: ['wall-clock budget', 'edge function timeout'],
      rationale: 'clear recurring pattern across 3 sessions',
    }),
  );
  const { pool, calls } = makeMockPool({
    responses: (call) => {
      if (isSql(call, 'INSERT INTO doctrine_jobs')) return { rows: [{ id: 'job-1', started_at: 'now' }] };
      if (isSql(call, 'AS pool_size')) return { rows: [{ pool_size: 3 }] };
      if (isSql(call, 'memory_relationships')) {
        return {
          rows: [
            { source_id: 'm1', target_id: 'm2', weight: 0.9 },
            { source_id: 'm2', target_id: 'm3', weight: 0.9 },
          ],
        };
      }
      if (isSql(call, 'embedding::text')) return { rows: [NODE_A, NODE_B, NODE_C] };
      if (isSql(call, 'ORDER BY centroid')) return { rows: [] };
      if (isSql(call, 'INSERT INTO doctrine_registry')) return { rows: [{ id: 'doc-1', status: 'candidate' }] };
      if (isSql(call, "status = 'drafted'")) return { rows: [] };
      if (isSql(call, 'UPDATE doctrine_jobs')) {
        return {
          rows: [
            {
              id: 'job-1', status: 'done', pool_size: 3, edge_count: 2, components_scanned: 1,
              clusters_qualified: 1, clusters_split: 0, candidates_drafted: 1,
              candidates_reinforced: 0, llm_calls_made: 1, note: null,
              error_message: null, started_at: 'now', completed_at: 'now',
            },
          ],
        };
      }
      throw new Error('unexpected query: ' + call.sql);
    },
  });
  const summary = await quiet(() => runDoctrineScan(pool, {}, { anthropic: client }));
  assert.equal(summary.llm_calls_made, 1);
  const draftCall = calls.find((c) => isSql(c, "status = 'drafted'"));
  assert.ok(draftCall);
  assert.ok(draftCall!.params.includes('Always cap wall-clock budgets'));
});

test('runDoctrineScan: a centroid-fingerprint match reinforces the existing row instead of inserting', async () => {
  const { pool, calls } = makeMockPool({
    responses: (call) => {
      if (isSql(call, 'INSERT INTO doctrine_jobs')) return { rows: [{ id: 'job-1', started_at: 'now' }] };
      if (isSql(call, 'AS pool_size')) return { rows: [{ pool_size: 3 }] };
      if (isSql(call, 'memory_relationships')) {
        return {
          rows: [
            { source_id: 'm1', target_id: 'm2', weight: 0.9 },
            { source_id: 'm2', target_id: 'm3', weight: 0.9 },
          ],
        };
      }
      if (isSql(call, 'embedding::text')) return { rows: [NODE_A, NODE_B, NODE_C] };
      if (isSql(call, 'ORDER BY centroid')) {
        // Existing row's centroid is identical to [1,0] (the new group's
        // centroid too, since all three nodes embed to [1,0]) -> cosine 1,
        // comfortably over the 0.9 dedup threshold.
        return {
          rows: [
            {
              id: 'existing-doc', status: 'drafted', cluster_member_ids: ['m0'],
              member_content_hashes: ['h0'], projects: ['gamma'], occurrence_count: 2,
              doctrine_text: 'already drafted text', synthesized_at: new Date().toISOString(),
              centroid: '[1,0]',
            },
          ],
        };
      }
      if (isSql(call, 'occurrence_count = occurrence_count + 1')) return { rows: [] };
      if (isSql(call, 'UPDATE doctrine_jobs')) {
        return {
          rows: [
            {
              id: 'job-1', status: 'done', pool_size: 3, edge_count: 2, components_scanned: 1,
              clusters_qualified: 1, clusters_split: 0, candidates_drafted: 0,
              candidates_reinforced: 1, llm_calls_made: 0, note: null,
              error_message: null, started_at: 'now', completed_at: 'now',
            },
          ],
        };
      }
      throw new Error('unexpected query: ' + call.sql);
    },
  });
  const summary = await quiet(() => runDoctrineScan(pool));
  assert.equal(summary.candidates_reinforced, 1);
  assert.equal(summary.candidates_drafted, 0);
  assert.ok(!calls.some((c) => isSql(c, 'INSERT INTO doctrine_registry')));
  // recently synthesized + membership didn't grow (m0 stays, m1/m2/m3 are
  // new though — membership DID grow here, but doctrine_text/status is
  // 'drafted' not ratified so re-synthesis would only fire with a key
  // present; this test forces no key, so no draft/reject call should occur.
  assert.ok(!calls.some((c) => isSql(c, "status = 'drafted'")));
});

test('runDoctrineScan: reinforcing an already-ratified row bumps reinforced_after_ratification', async () => {
  const { pool, calls } = makeMockPool({
    responses: (call) => {
      if (isSql(call, 'INSERT INTO doctrine_jobs')) return { rows: [{ id: 'job-1', started_at: 'now' }] };
      if (isSql(call, 'AS pool_size')) return { rows: [{ pool_size: 3 }] };
      if (isSql(call, 'memory_relationships')) {
        return {
          rows: [
            { source_id: 'm1', target_id: 'm2', weight: 0.9 },
            { source_id: 'm2', target_id: 'm3', weight: 0.9 },
          ],
        };
      }
      if (isSql(call, 'embedding::text')) return { rows: [NODE_A, NODE_B, NODE_C] };
      if (isSql(call, 'ORDER BY centroid')) {
        return {
          rows: [
            {
              id: 'ratified-doc', status: 'ratified', cluster_member_ids: ['m0'],
              member_content_hashes: ['h0'], projects: ['gamma'], occurrence_count: 5,
              doctrine_text: 'ratified text', synthesized_at: new Date().toISOString(),
              centroid: '[1,0]',
            },
          ],
        };
      }
      if (isSql(call, 'occurrence_count = occurrence_count + 1')) return { rows: [] };
      if (isSql(call, 'UPDATE doctrine_jobs')) {
        return {
          rows: [
            {
              id: 'job-1', status: 'done', pool_size: 3, edge_count: 2, components_scanned: 1,
              clusters_qualified: 1, clusters_split: 0, candidates_drafted: 0,
              candidates_reinforced: 1, llm_calls_made: 0, note: null,
              error_message: null, started_at: 'now', completed_at: 'now',
            },
          ],
        };
      }
      throw new Error('unexpected query: ' + call.sql);
    },
  });
  await quiet(() => runDoctrineScan(pool));
  const reinforceCall = calls.find((c) => isSql(c, 'occurrence_count = occurrence_count + 1'));
  assert.ok(reinforceCall);
  // bumpReinforcedAfterRatification is the 6th bound param ($6, index 5)
  assert.equal(reinforceCall!.params[5], true);
  // T2 never touches status/doctrine_text on a ratified row.
  assert.ok(!calls.some((c) => isSql(c, "status = 'drafted'") || isSql(c, "status = 'rejected'")));
});

test('runDoctrineScan: LLM budget cap leaves the second candidate at plain "candidate"', async () => {
  const { client, callCount } = makeMockAnthropic(
    JSON.stringify({
      coherent: true,
      verdict: 'kitchen',
      title: 't',
      doctrine_text: 'd',
      evidence: [],
      trigger_hints: [],
      rationale: 'r',
    }),
  );
  let insertCount = 0;
  const nodeSetA = [NODE_A, NODE_B, NODE_C];
  const nodeSetB = [
    { ...NODE_A, id: 'n1' },
    { ...NODE_B, id: 'n2' },
    { ...NODE_C, id: 'n3' },
  ];
  const { pool } = makeMockPool({
    responses: (call) => {
      if (isSql(call, 'INSERT INTO doctrine_jobs')) return { rows: [{ id: 'job-1', started_at: 'now' }] };
      if (isSql(call, 'AS pool_size')) return { rows: [{ pool_size: 6 }] };
      if (isSql(call, 'memory_relationships')) {
        // Two disjoint triangles -> two independent components.
        return {
          rows: [
            { source_id: 'm1', target_id: 'm2', weight: 0.9 },
            { source_id: 'm2', target_id: 'm3', weight: 0.9 },
            { source_id: 'n1', target_id: 'n2', weight: 0.9 },
            { source_id: 'n2', target_id: 'n3', weight: 0.9 },
          ],
        };
      }
      if (isSql(call, 'embedding::text')) return { rows: [...nodeSetA, ...nodeSetB] };
      if (isSql(call, 'ORDER BY centroid')) return { rows: [] };
      if (isSql(call, 'INSERT INTO doctrine_registry')) {
        insertCount += 1;
        return { rows: [{ id: 'doc-' + insertCount, status: 'candidate' }] };
      }
      if (isSql(call, "status = 'drafted'")) return { rows: [] };
      if (isSql(call, 'UPDATE doctrine_jobs')) {
        return {
          rows: [
            {
              id: 'job-1', status: 'done', pool_size: 6, edge_count: 4, components_scanned: 2,
              clusters_qualified: 2, clusters_split: 0, candidates_drafted: 2,
              candidates_reinforced: 0, llm_calls_made: 1, note: 'llm_budget_exhausted_this_scan',
              error_message: null, started_at: 'now', completed_at: 'now',
            },
          ],
        };
      }
      throw new Error('unexpected query: ' + call.sql);
    },
  });
  const summary = await quiet(() => runDoctrineScan(pool, { maxLlmCalls: 1 }, { anthropic: client }));
  assert.equal(summary.candidates_drafted, 2);
  assert.equal(summary.llm_calls_made, 1);
  assert.equal(callCount(), 1);
  assert.equal(summary.note, 'llm_budget_exhausted_this_scan');
});

test('runDoctrineScan: a claim-level failure marks the job failed rather than throwing', async () => {
  const { pool } = makeMockPool({
    responses: (call) => {
      if (isSql(call, 'INSERT INTO doctrine_jobs')) return { rows: [{ id: 'job-1', started_at: 'now' }] };
      if (isSql(call, 'AS pool_size')) return new Error('connection reset');
      if (isSql(call, 'UPDATE doctrine_jobs')) {
        return {
          rows: [
            {
              id: 'job-1', status: 'failed', pool_size: 0, edge_count: 0, components_scanned: 0,
              clusters_qualified: 0, clusters_split: 0, candidates_drafted: 0,
              candidates_reinforced: 0, llm_calls_made: 0, note: null,
              error_message: 'connection reset', started_at: 'now', completed_at: 'now',
            },
          ],
        };
      }
      throw new Error('unexpected query: ' + call.sql);
    },
  });
  const summary = await quiet(() => runDoctrineScan(pool));
  assert.equal(summary.status, 'failed');
  assert.equal(summary.error_message, 'connection reset');
});
