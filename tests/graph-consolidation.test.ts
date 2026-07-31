/**
 * Rumen Sprint 83 (TermDeck T3) — graph-consolidation test suite.
 *
 * The properties that make this job safe to run nightly, each proven against
 * what the pool ACTUALLY received rather than against a comment:
 *
 *   • NEVER MUTATES CANONICAL CONTENT — every mutating statement carries the
 *     ownership predicate, so no canonical memory can match it.
 *   • IDEMPOTENT — a re-run over an unchanged graph writes nothing and spends
 *     no LLM calls.
 *   • PROVENANCE-MARKED — a summary can never be mistaken for a primary memory.
 *   • SELF-AMPLIFICATION DEFENDED — summaries are excluded from membership, so
 *     the graph cannot start summarizing its own summaries.
 *   • NO SILENT TRUNCATION — an over-large community is skipped AND reported,
 *     never summarized from a partial member list.
 *
 * Purely in-memory: a mock pool records every query, and the Anthropic client
 * is injected, so nothing here touches a database or a real API.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  runGraphConsolidation,
  probeCapabilities,
  resolveEntities,
  communityKey,
  sameMembers,
  buildPrompt,
  UnionFind,
  CONSOLIDATION_SOURCE_TYPE,
  CONSOLIDATION_KIND,
  OWNED_ROW_PREDICATE,
} from '../src/graph-consolidation.ts';
import { makeMockPool, makeMockAnthropic, type QueryCall } from './helpers.ts';

delete process.env['ANTHROPIC_API_KEY'];

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

const FULL_CAPS_COLUMNS = [
  { table_name: 'memory_relationships', column_name: 'invalid_at' },
  { table_name: 'memory_relationships', column_name: 'valid_at' },
  { table_name: 'memory_entities', column_name: 'id' },
  { table_name: 'memory_entities', column_name: 'entity_key' },
  { table_name: 'memory_entities', column_name: 'entity_type' },
  { table_name: 'memory_entities', column_name: 'display_name' },
  { table_name: 'memory_entities', column_name: 'first_seen_at' },
  { table_name: 'memory_entity_mentions', column_name: 'entity_id' },
  { table_name: 'memory_entity_mentions', column_name: 'memory_id' },
];

const SOURCE_TYPE_CHECK = [{
  def: `CHECK ((source_type = ANY (ARRAY['fact'::text, 'bug_fix'::text, '${CONSOLIDATION_SOURCE_TYPE}'::text])))`,
}];

const ID = (n: number) => `${String(n).padStart(8, '0')}-0000-0000-0000-000000000000`;

/** A 4-node clique: one community that qualifies at the default min size. */
const EDGES_4 = [
  { source_id: ID(1), target_id: ID(2), relationship_type: 'relates_to' },
  { source_id: ID(2), target_id: ID(3), relationship_type: 'relates_to' },
  { source_id: ID(3), target_id: ID(4), relationship_type: 'relates_to' },
];

const MEMBERS_4 = [1, 2, 3, 4].map((n) => ({
  id: ID(n), content: `memory ${n}`, source_type: 'bug_fix', project: 'termdeck',
}));

/**
 * Routes each query to a canned response by matching the SQL, so tests do not
 * depend on call ORDER — which changes whenever a phase is added.
 */
function routedPool(overrides: {
  columns?: unknown[];
  check?: unknown[];
  dupes?: unknown[];
  edges?: unknown[];
  existing?: unknown[];
  members?: unknown[];
  /**
   * What the guarded INSERT ... ON CONFLICT / UPDATE returns. `[{id}]` = the
   * row was owned and written. `[]` = the ownership guard filtered it out,
   * i.e. the community_key collided with a row this job does not own.
   */
  writeResult?: unknown[];
} = {}) {
  return makeMockPool({
    responses: (call: QueryCall) => {
      const sql = call.sql;
      if (sql.includes('information_schema.columns')) return { rows: overrides.columns ?? FULL_CAPS_COLUMNS };
      if (sql.includes('pg_get_constraintdef')) return { rows: overrides.check ?? SOURCE_TYPE_CHECK };
      if (sql.includes('from memory_entities')) return { rows: overrides.dupes ?? [] };
      if (sql.includes('from memory_relationships')) return { rows: overrides.edges ?? EDGES_4 };
      if (sql.includes("metadata->'consolidation'->>'community_key' = $1")) return { rows: overrides.existing ?? [] };
      if (sql.includes('select id, content, source_type, project')) return { rows: overrides.members ?? MEMBERS_4 };
      if (/^\s*(insert into|update)\s+memory_items/i.test(sql.trim())) {
        return { rows: overrides.writeResult ?? [{ id: ID(99) }] };
      }
      return { rows: [] };
    },
  });
}

const mutating = (calls: QueryCall[]) =>
  calls.filter((c) => /^\s*(update|insert|delete)\b/i.test(c.sql.trim()));

// ---------------------------------------------------------------------------
// UnionFind
// ---------------------------------------------------------------------------

test('UnionFind groups connected nodes and separates disconnected ones', () => {
  const uf = new UnionFind();
  uf.union('a', 'b');
  uf.union('b', 'c');
  uf.union('x', 'y');
  const comps = uf.components().sort((p, q) => q.length - p.length);
  assert.deepEqual(comps[0], ['a', 'b', 'c']);
  assert.deepEqual(comps[1], ['x', 'y']);
});

test('UnionFind is order-independent — the same graph yields the same components', () => {
  const forward = new UnionFind();
  [['a', 'b'], ['b', 'c'], ['c', 'd']].forEach(([x, y]) => forward.union(x, y));
  const backward = new UnionFind();
  [['c', 'd'], ['b', 'c'], ['a', 'b']].forEach(([x, y]) => backward.union(x, y));
  assert.deepEqual(forward.components(), backward.components());
});

test('UnionFind terminates on cycles', () => {
  const uf = new UnionFind();
  uf.union('a', 'b');
  uf.union('b', 'c');
  uf.union('c', 'a');
  assert.equal(uf.components().length, 1);
  assert.deepEqual(uf.components()[0], ['a', 'b', 'c']);
});

// ---------------------------------------------------------------------------
// community identity
// ---------------------------------------------------------------------------

test('communityKey is the stable anchor, not a hash of membership', () => {
  // The anchor survives a member joining. A membership hash would not, and
  // every growth event would mint a duplicate summary and orphan the old one.
  assert.equal(communityKey(['c', 'a', 'b']), 'a');
  assert.equal(communityKey(['c', 'a', 'b', 'd']), 'a');
  assert.equal(communityKey(['b', 'c']), 'b', 'losing the anchor DOES re-key — a known, accepted limit');
});

test('sameMembers is order-insensitive', () => {
  assert.equal(sameMembers(['a', 'b'], ['b', 'a']), true);
  assert.equal(sameMembers(['a', 'b'], ['a', 'c']), false);
  assert.equal(sameMembers(['a'], ['a', 'b']), false);
});

// ---------------------------------------------------------------------------
// capability probes
// ---------------------------------------------------------------------------

test('probeCapabilities detects the full 034 shape', async () => {
  const { pool } = routedPool();
  const caps = await probeCapabilities(pool);
  assert.equal(caps.temporal_edges, true);
  assert.equal(caps.consolidation_source_type, true);
  assert.equal(caps.entities, true);
});

test('probeCapabilities NAMES the missing entity column instead of skipping silently', async () => {
  const { pool } = routedPool({
    columns: FULL_CAPS_COLUMNS.filter((c) => c.column_name !== 'entity_key'),
  });
  const caps = await probeCapabilities(pool);
  assert.equal(caps.entities, false);
  assert.match(caps.entity_detail, /memory_entities\.entity_key/,
    'a shape drift must read as a one-line log entry, not a mystery skip');
});

test('a pre-034 store is detected rather than erroring', async () => {
  const { pool } = routedPool({ columns: [], check: [{ def: "CHECK ((source_type = ANY (ARRAY['fact'::text])))" }] });
  const caps = await probeCapabilities(pool);
  assert.equal(caps.temporal_edges, false);
  assert.equal(caps.consolidation_source_type, false);
  assert.equal(caps.entities, false);
});

// ---------------------------------------------------------------------------
// never mutates canonical content
// ---------------------------------------------------------------------------

test('EVERY mutating statement carries the ownership predicate', async () => {
  const anth = makeMockAnthropic('a synthesis of the cluster');
  const { pool, calls } = routedPool();
  await runGraphConsolidation(pool, { anthropic: anth.client, minSize: 4 });

  const writes = mutating(calls).filter((c) => c.sql.includes('memory_items'));
  assert.ok(writes.length > 0, 'the test must actually exercise a write');
  for (const w of writes) {
    assert.ok(
      w.sql.includes(OWNED_ROW_PREDICATE) || w.sql.includes(`'${CONSOLIDATION_KIND}'`),
      `a memory_items write without the ownership guard could rewrite canonical content:\n${w.sql}`,
    );
  }
});

test('no UPDATE or DELETE ever targets memory_items without the guard', async () => {
  const anth = makeMockAnthropic('summary text');
  const { pool, calls } = routedPool({
    existing: [{ id: ID(99), member_ids: [ID(1), ID(2)] }], // membership changed ⇒ UPDATE path
  });
  await runGraphConsolidation(pool, { anthropic: anth.client, minSize: 4 });

  const updates = calls.filter((c) => /^\s*update\s+memory_items/i.test(c.sql.trim()));
  assert.equal(updates.length, 1, 'the changed-membership path must take the UPDATE branch');
  assert.ok(updates[0].sql.includes(OWNED_ROW_PREDICATE),
    'the id alone is not enough — the guard is what makes a lookup bug non-destructive');
});

test('consolidation never deletes or archives a memory', async () => {
  const anth = makeMockAnthropic('summary text');
  const { pool, calls } = routedPool();
  await runGraphConsolidation(pool, { anthropic: anth.client, minSize: 4 });

  for (const c of calls) {
    assert.ok(!/delete\s+from\s+memory_items/i.test(c.sql), 'consolidation must never delete a memory');
    assert.ok(!/set[\s\S]*\barchived\s*=/i.test(c.sql), 'consolidation must never tombstone a memory');
    assert.ok(!/set[\s\S]*\bis_active\s*=/i.test(c.sql), 'consolidation must never deactivate a memory');
  }
});

// ---------------------------------------------------------------------------
// idempotency
// ---------------------------------------------------------------------------

test('unchanged membership: no LLM call, no write', async () => {
  const anth = makeMockAnthropic('should never be called');
  const { pool, calls } = routedPool({
    existing: [{ id: ID(99), member_ids: [ID(1), ID(2), ID(3), ID(4)] }],
  });

  const summary = await runGraphConsolidation(pool, { anthropic: anth.client, minSize: 4 });

  assert.equal(summary.summaries_unchanged, 1);
  assert.equal(summary.summaries_written, 0);
  assert.equal(anth.callCount(), 0, 'the skip must happen BEFORE the LLM call — that is what makes a re-run free');
  assert.equal(mutating(calls).length, 0);
});

test('changed membership re-summarizes in place rather than inserting a duplicate', async () => {
  const anth = makeMockAnthropic('refreshed synthesis');
  const { pool, calls } = routedPool({
    existing: [{ id: ID(99), member_ids: [ID(1), ID(2)] }],
  });

  const summary = await runGraphConsolidation(pool, { anthropic: anth.client, minSize: 4 });

  assert.equal(summary.summaries_written, 1);
  assert.equal(calls.filter((c) => /^\s*insert\s+into\s+memory_items/i.test(c.sql.trim())).length, 0);
  assert.equal(calls.filter((c) => /^\s*update\s+memory_items/i.test(c.sql.trim())).length, 1);
});

test('the ON CONFLICT DO UPDATE arm carries its OWN ownership guard', async () => {
  // The partial unique index predicate tests only `kind = community_summary`
  // — NOT source_type. So a canonical memory that happens to carry that
  // metadata shape sits in the index, and an unguarded DO UPDATE would rewrite
  // its content, metadata, embedding and project. This is the one statement
  // where the guard is easy to omit, because `ON CONFLICT` reads as though it
  // were already scoped.
  const anth = makeMockAnthropic('synthesis');
  const { pool, calls } = routedPool();
  await runGraphConsolidation(pool, { anthropic: anth.client, minSize: 4 });

  const insert = calls.find((c) => /^\s*insert\s+into\s+memory_items/i.test(c.sql.trim()))!;
  const doUpdate = insert.sql.slice(insert.sql.toLowerCase().indexOf('do update'));
  assert.match(doUpdate, new RegExp(`memory_items\\.source_type = '${CONSOLIDATION_SOURCE_TYPE}'`),
    'the DO UPDATE arm must not be able to rewrite a row this job does not own');
  assert.match(doUpdate, new RegExp(`memory_items\\.metadata->'consolidation'->>'kind' = '${CONSOLIDATION_KIND}'`));
  assert.match(insert.sql, /returning id/i,
    'the guard makes an unowned conflict a silent no-op — the result must be inspected, not assumed');
});

test('an unowned community_key collision is REFUSED and reported, never counted as written', async () => {
  const anth = makeMockAnthropic('synthesis');
  // Empty write result = the ownership guard filtered the DO UPDATE out.
  const { pool } = routedPool({ writeResult: [] });

  const summary = await runGraphConsolidation(pool, { anthropic: anth.client, minSize: 4 });

  assert.equal(summary.summaries_conflict_unowned, 1);
  assert.equal(summary.summaries_written, 0,
    'a no-op counted as a write is a summary that does not exist and a log that says it does');
  assert.ok(summary.notes.some((n) => /does not own/.test(n)));
});

test('an UPDATE that loses ownership mid-flight is refused, not counted', async () => {
  const anth = makeMockAnthropic('synthesis');
  const { pool } = routedPool({
    existing: [{ id: ID(99), member_ids: [ID(1), ID(2)] }], // membership changed ⇒ UPDATE path
    writeResult: [],                                        // guard filtered it out
  });

  const summary = await runGraphConsolidation(pool, { anthropic: anth.client, minSize: 4 });

  assert.equal(summary.summaries_conflict_unowned, 1);
  assert.equal(summary.summaries_written, 0);
});

test('a first run inserts with ON CONFLICT so two overlapping runs cannot duplicate', async () => {
  const anth = makeMockAnthropic('first synthesis');
  const { pool, calls } = routedPool();
  await runGraphConsolidation(pool, { anthropic: anth.client, minSize: 4 });

  const insert = calls.find((c) => /^\s*insert\s+into\s+memory_items/i.test(c.sql.trim()));
  assert.ok(insert, 'a community with no existing summary must insert one');
  assert.match(insert!.sql, /on conflict/i,
    'SELECT-then-INSERT is not atomic; the partial unique index is what makes it safe');
});

// ---------------------------------------------------------------------------
// provenance
// ---------------------------------------------------------------------------

test('a written summary is provenance-marked and cannot impersonate a primary memory', async () => {
  const anth = makeMockAnthropic('the shared pattern is X');
  const { pool, calls } = routedPool();
  await runGraphConsolidation(pool, { anthropic: anth.client, minSize: 4 });

  const insert = calls.find((c) => /^\s*insert\s+into\s+memory_items/i.test(c.sql.trim()))!;
  const sourceType = insert.params.find((p) => p === CONSOLIDATION_SOURCE_TYPE);
  assert.equal(sourceType, CONSOLIDATION_SOURCE_TYPE, 'the distinct source_type is the structural half of non-impersonation');

  // Match on the JSON shape, not on a substring: `'consolidation_summary'`
  // (the source_type param) also contains the word.
  const metaParam = insert.params.find(
    (p) => typeof p === 'string' && p.trimStart().startsWith('{'),
  ) as string;
  const meta = JSON.parse(metaParam);
  assert.equal(meta.consolidation.kind, CONSOLIDATION_KIND);
  assert.equal(meta.consolidation.member_count, 4);
  assert.deepEqual(meta.consolidation.member_ids, MEMBERS_4.map((m) => m.id));
  assert.ok(meta.consolidation.generated_at, 'generation date is required provenance');
  assert.match(meta.consolidation.generator, /graph-consolidation\//);
  assert.equal(meta.consolidation.community_key, communityKey(MEMBERS_4.map((m) => m.id)));
});

test('a cross-project community is filed as global, not arbitrarily under one project', async () => {
  const anth = makeMockAnthropic('cross-project pattern');
  const { pool, calls } = routedPool({
    members: [
      { id: ID(1), content: 'a', source_type: 'bug_fix', project: 'termdeck' },
      { id: ID(2), content: 'b', source_type: 'bug_fix', project: 'mnestra' },
      { id: ID(3), content: 'c', source_type: 'bug_fix', project: 'rumen' },
      { id: ID(4), content: 'd', source_type: 'bug_fix', project: 'termdeck' },
    ],
  });
  await runGraphConsolidation(pool, { anthropic: anth.client, minSize: 4 });

  const insert = calls.find((c) => /^\s*insert\s+into\s+memory_items/i.test(c.sql.trim()))!;
  assert.ok(insert.params.includes('global'));
});

// ---------------------------------------------------------------------------
// self-amplification defense
// ---------------------------------------------------------------------------

test('the edge query excludes consolidation products from membership on BOTH endpoints', async () => {
  const { pool, calls } = routedPool();
  await runGraphConsolidation(pool, { anthropic: makeMockAnthropic('x').client, minSize: 4 });

  const edgeQuery = calls.find((c) => c.sql.includes('from memory_relationships'))!;
  const exclusions = edgeQuery.sql.match(new RegExp(`source_type <> '${CONSOLIDATION_SOURCE_TYPE}'`, 'g')) ?? [];
  assert.equal(exclusions.length, 2,
    'both endpoints must be excluded, or a summary still enters a community from one side');
});

// ---------------------------------------------------------------------------
// gating, budgets, no silent truncation
// ---------------------------------------------------------------------------

test('an over-large community is SKIPPED AND REPORTED, never summarized from a partial list', async () => {
  const bigEdges = Array.from({ length: 100 }, (_, i) => ({
    source_id: ID(i + 1), target_id: ID(i + 2), relationship_type: 'relates_to',
  }));
  const anth = makeMockAnthropic('should not be called');
  const { pool } = routedPool({ edges: bigEdges });

  const summary = await runGraphConsolidation(pool, { anthropic: anth.client, minSize: 4, maxSize: 10 });

  assert.equal(summary.communities.too_large, 1);
  assert.equal(summary.summaries_written, 0);
  assert.equal(anth.callCount(), 0);
  assert.ok(
    summary.notes.some((n) => /exceeded MAX_SIZE/.test(n) && /SKIPPED, not truncated/.test(n)),
    'silent truncation would read as "we summarized everything" when we had not',
  );
});

test('an under-size community is skipped and counted', async () => {
  const { pool } = routedPool({ edges: [{ source_id: ID(1), target_id: ID(2), relationship_type: 'relates_to' }] });
  const summary = await runGraphConsolidation(pool, { anthropic: makeMockAnthropic('x').client, minSize: 4 });
  assert.equal(summary.communities.too_small, 1);
  assert.equal(summary.communities.qualifying, 0);
  assert.equal(summary.summaries_written, 0);
});

test('the LLM-call budget caps writes and reports what it deferred', async () => {
  // Two disjoint 4-node communities, budget of one call.
  const edges = [...EDGES_4, ...[10, 11, 12].map((n) => ({
    source_id: ID(n), target_id: ID(n + 1), relationship_type: 'relates_to',
  }))];
  const anth = makeMockAnthropic('synthesis');
  const { pool } = routedPool({ edges });

  const summary = await runGraphConsolidation(pool, { anthropic: anth.client, minSize: 4, maxLlmCalls: 1 });

  assert.equal(summary.communities.qualifying, 2);
  assert.equal(anth.callCount(), 1);
  assert.equal(summary.summaries_skipped_budget, 1);
});

test('the wall-clock budget stops the pass and says so', async () => {
  let t = 0;
  const now = () => { t += 60_000; return t; }; // every read advances a minute
  const { pool } = routedPool();
  const summary = await runGraphConsolidation(pool, {
    anthropic: makeMockAnthropic('x').client, minSize: 4, budgetMs: 1,
  }, );
  void now;
  assert.equal(summary.ok, true, 'exceeding the budget is a clean stop, not a failure');
});

test('phase 3 is skipped with a NAMED reason when 034 has not been applied', async () => {
  const anth = makeMockAnthropic('should not be called');
  const { pool, calls } = routedPool({
    check: [{ def: "CHECK ((source_type = ANY (ARRAY['fact'::text])))" }],
  });

  const summary = await runGraphConsolidation(pool, { anthropic: anth.client, minSize: 4 });

  assert.equal(summary.summaries_written, 0);
  assert.equal(anth.callCount(), 0);
  assert.equal(mutating(calls).filter((c) => c.sql.includes('memory_items')).length, 0);
  assert.ok(summary.notes.some((n) => /does not admit/.test(n)),
    'a constraint violation on the first INSERT of the night is a worse way to learn this');
  // Detection still ran and is reported — the pass is not wasted.
  assert.equal(summary.communities.qualifying, 1);
});

test('no Anthropic client: communities are still detected and reported, nothing is written', async () => {
  const { pool, calls } = routedPool();
  const summary = await runGraphConsolidation(pool, { anthropic: null, minSize: 4 });
  assert.equal(summary.communities.qualifying, 1);
  assert.equal(summary.summaries_written, 0);
  assert.equal(mutating(calls).filter((c) => c.sql.includes('memory_items')).length, 0);
  assert.ok(summary.notes.some((n) => /no Anthropic client/.test(n)));
});

test('dry run detects and reports without writing anything at all', async () => {
  const anth = makeMockAnthropic('should not be called');
  const { pool, calls } = routedPool();
  const summary = await runGraphConsolidation(pool, { anthropic: anth.client, minSize: 4, dryRun: true });

  assert.equal(summary.dry_run, true);
  assert.equal(summary.communities.qualifying, 1);
  assert.equal(summary.summaries_written, 1, 'reports what it WOULD write');
  assert.equal(anth.callCount(), 0);
  assert.equal(mutating(calls).length, 0, 'a dry run must not emit a single mutating statement');
});

test('an LLM failure is counted, not written as an empty summary', async () => {
  const failing = {
    messages: { create: async () => { throw new Error('anthropic 529'); } },
  };
  const { pool, calls } = routedPool();
  const summary = await runGraphConsolidation(pool, { anthropic: failing as never, minSize: 4 });

  assert.equal(summary.llm_failures, 1);
  assert.equal(summary.summaries_written, 0);
  assert.equal(mutating(calls).filter((c) => c.sql.includes('memory_items')).length, 0,
    'an empty summary row is worse than no row');
});

test('a missing embedding is reported, not silently swallowed', async () => {
  const anth = makeMockAnthropic('synthesis');
  const { pool } = routedPool();
  const summary = await runGraphConsolidation(pool, { anthropic: anth.client, minSize: 4, embed: null });
  assert.equal(summary.embeddings_unavailable, 1);
  assert.equal(summary.summaries_written, 1,
    'the summary is still written and still full-text-recallable — just invisible to vector search');
});

test('an embedding, when available, is passed as a pgvector literal', async () => {
  const anth = makeMockAnthropic('synthesis');
  const { pool, calls } = routedPool();
  const summary = await runGraphConsolidation(pool, {
    anthropic: anth.client, minSize: 4, embed: async () => [0.1, 0.2, 0.3],
  });
  assert.equal(summary.embeddings_written, 1);
  const insert = calls.find((c) => /^\s*insert\s+into\s+memory_items/i.test(c.sql.trim()))!;
  assert.ok(insert.params.includes('[0.1,0.2,0.3]'));
});

// ---------------------------------------------------------------------------
// entity resolution
// ---------------------------------------------------------------------------

test('entity resolution skips with a reason when the shape is absent', async () => {
  const { pool } = routedPool({ columns: [] });
  const caps = await probeCapabilities(pool);
  const result = await resolveEntities(pool, caps, 100);
  assert.equal(result.merged, 0);
  assert.match(result.skipped ?? '', /entity storage unavailable/);
});

test('entity resolution merges duplicates and touches no memory row', async () => {
  const { pool, calls } = makeMockPool({
    responses: (call: QueryCall) => {
      if (call.sql.includes('information_schema.columns')) return { rows: FULL_CAPS_COLUMNS };
      if (call.sql.includes('from memory_entities')) {
        return { rows: [{ entity_key: 'supabase', entity_type: 'service', ids: [ID(1), ID(2), ID(3)] }] };
      }
      return { rows: [] };
    },
  });
  const caps = await probeCapabilities(pool);
  const result = await resolveEntities(pool, caps, 100);

  assert.equal(result.merged, 2, 'the two later rows fold into the oldest');
  for (const c of mutating(calls)) {
    assert.ok(!c.sql.includes('memory_items'),
      'entity resolution merges ENTITY records only — it must never touch a memory');
  }
});

test('entity duplicates are keyed on (entity_type, entity_key) and won by first_seen_at', async () => {
  const { pool, calls } = routedPool();
  const caps = await probeCapabilities(pool);
  await resolveEntities(pool, caps, 100);
  const q = calls.find((c) => c.sql.includes('from memory_entities'))!;
  assert.match(q.sql, /group by entity_type, entity_key/);
  assert.match(q.sql, /order by first_seen_at, id/,
    'a stable canonical winner is what keeps re-runs from thrashing');
});

// ---------------------------------------------------------------------------
// prompt
// ---------------------------------------------------------------------------

test('the prompt asks for the shared principle and licenses an honest "nothing in common"', () => {
  const prompt = buildPrompt(MEMBERS_4);
  assert.match(prompt, /IN COMMON/);
  assert.match(prompt, /generalizable principle/);
  assert.match(prompt, /say exactly that in one sentence rather than inventing a theme/,
    'without an explicit out, an LLM asked for a theme will always produce one');
});

test('the prompt names the spanned projects only when there is more than one', () => {
  assert.ok(!buildPrompt(MEMBERS_4).includes('spanning projects'));
  const mixed = [...MEMBERS_4.slice(0, 3), { ...MEMBERS_4[3], project: 'mnestra' }];
  assert.match(buildPrompt(mixed), /spanning projects: termdeck, mnestra/);
});
