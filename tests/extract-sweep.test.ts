/**
 * Rumen Sprint 84 — extract-sweep.ts test suite (the write-time-extraction
 * backstop).
 *
 * Everything is offline: the pool is the makeMockPool seam (dispatch on SQL
 * marker) and the model is makeMockAnthropic. Nothing here touches a database
 * or the network.
 *
 * The properties worth pinning are the ones a future change could break
 * silently:
 *   - IDEMPOTENCY: the selection query joins the ledger and only takes unswept
 *     rows (or retryable failures under the attempt cap), and every processed
 *     item gets a ledger row.
 *   - BUDGET: the pass stops at the wall clock and reports what it skipped
 *     rather than running long and being killed by the platform.
 *   - FAIL-OPEN PER ITEM: a poison item is recorded and stepped over; the items
 *     behind it still get swept.
 *   - THE WRITE CONTRACT: no statement this module emits may touch
 *     memory_items. That is asserted against what the pool actually received,
 *     not against the source — the same technique graph-consolidation uses for
 *     its owned-row predicate.
 *   - DRY-RUN: writes nothing at all, not even ledger rows.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  runExtractionSweep,
  probeSweepCapabilities,
  parseExtraction,
  buildPrompt,
  SWEEP_INFERRED_BY,
  type SweepSummary,
} from '../src/extract-sweep.ts';
import { makeMockPool, makeMockAnthropic, type QueryCall } from './helpers.ts';

// The sweep reads a handful of env knobs; ambient env must never leak into a
// test's batch/budget/dry-run.
for (const k of [
  'RUMEN_SWEEP_LOOKBACK_DAYS',
  'RUMEN_SWEEP_BATCH',
  'RUMEN_SWEEP_BUDGET_MS',
  'RUMEN_SWEEP_ITEM_BUDGET_MS',
  'RUMEN_SWEEP_CONCURRENCY',
  'RUMEN_SWEEP_MAX_ATTEMPTS',
  'RUMEN_SWEEP_MIN_CONTENT_CHARS',
  'RUMEN_SWEEP_DRY_RUN',
  'RUMEN_SWEEP_MODEL',
]) {
  delete process.env[k];
}

// Every test that wants a model injects one through deps.anthropic. Clearing
// the key here means a test that forgets to can never reach the real SDK — it
// gets the documented no-key degradation instead of a network client.
delete process.env['ANTHROPIC_API_KEY'];

/**
 * The capability probe's SQL literally contains both RPC names
 * (`to_regprocedure('public.upsert_memory_entities(uuid,jsonb)')`), so a bare
 * substring match finds the PROBE rather than a write. Match the invocation
 * form — this is the difference between "the sweep asked whether the RPC
 * exists" and "the sweep called it".
 */
function isRpcCall(sql: string, fn: string): boolean {
  return sql.includes(`select public.${fn}(`);
}

const ID_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const ID_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const ID_C = 'cccccccc-cccc-cccc-cccc-cccccccccccc';

const GOOD_JSON = JSON.stringify({
  entities: [
    { name: 'recall_log.ts', type: 'file', span: 'in recall_log.ts', confidence: 0.9 },
    { name: 'mnestra', type: 'project' },
  ],
  triples: [{ subject: 'recall_log.ts', predicate: 'part_of', object: 'mnestra' }],
});

/** Long enough to clear the 80-char minimum content gate. */
const CONTENT = 'x'.repeat(200);

function candidate(id: string, problemClass: string | null = null) {
  return { id, content: CONTENT, project: 'termdeck', problem_class: problemClass };
}

/**
 * A pool that answers by SQL marker rather than call order, so a test does not
 * break when an unrelated query is added.
 */
function poolFor(opts: {
  candidates?: Array<ReturnType<typeof candidate>>;
  ledgerPresent?: boolean;
  rpcsPresent?: boolean;
  vocabulary?: boolean;
  samePatternTargets?: string[];
  entityResult?: { created: number; linked: number; dropped: number };
  edgeResult?: { accepted: number; dropped_predicates?: string[] };
  failOn?: (call: QueryCall) => boolean;
}) {
  const {
    candidates = [],
    ledgerPresent = true,
    rpcsPresent = true,
    vocabulary = true,
    samePatternTargets = [],
    entityResult = { created: 2, linked: 2, dropped: 0 },
    edgeResult = { accepted: 1, dropped_predicates: [] },
    failOn,
  } = opts;

  return makeMockPool({
    responses: (call) => {
      const sql = call.sql;
      if (failOn?.(call)) return new Error('boom');

      if (sql.includes("to_regclass('public.rumen_extraction_sweep')")) {
        return { rows: [{ present: ledgerPresent }] };
      }
      if (sql.includes('to_regprocedure')) {
        return { rows: [{ ent: rpcsPresent, edg: rpcsPresent }] };
      }
      if (sql.includes('memory_relationship_types')) {
        return { rows: vocabulary ? [{ type: 'same_pattern_as' }, { type: 'part_of' }] : [] };
      }
      if (sql.includes('memory_entity_types')) {
        return { rows: vocabulary ? [{ entity_type: 'file' }, { entity_type: 'project' }] : [] };
      }
      if (sql.includes('rumen_extraction_sweep s on s.memory_id')) {
        return { rows: candidates };
      }
      if (sql.includes("problem_signature'->>'class'") && sql.includes('count(*)')) {
        return { rows: [{ n: samePatternTargets.length }] };
      }
      if (sql.includes("problem_signature'->>'class'")) {
        return { rows: samePatternTargets.map((id) => ({ id })) };
      }
      if (isRpcCall(sql, 'upsert_memory_entities')) {
        return { rows: [{ result: entityResult }] };
      }
      if (isRpcCall(sql, 'upsert_memory_edges')) {
        return { rows: [{ result: edgeResult }] };
      }
      if (sql.includes('insert into public.rumen_extraction_sweep')) {
        return { rows: [] };
      }
      return { rows: [] };
    },
  });
}

// ── parseExtraction (pure) ──────────────────────────────────────────────────

test('parseExtraction reads a clean object', () => {
  const { entities, triples } = parseExtraction(GOOD_JSON);
  assert.equal(entities.length, 2);
  assert.equal(entities[0]?.name, 'recall_log.ts');
  assert.equal(entities[0]?.type, 'file');
  assert.equal(triples.length, 1);
  assert.equal(triples[0]?.predicate, 'part_of');
});

test('parseExtraction strips a ```json fence and leading prose', () => {
  const fenced = '```json\n' + GOOD_JSON + '\n```';
  assert.equal(parseExtraction(fenced).entities.length, 2);
  assert.equal(parseExtraction('Here you go:\n' + GOOD_JSON).entities.length, 2);
});

test('parseExtraction returns empty arrays on garbage rather than throwing', () => {
  for (const bad of ['', 'not json', '{"entities":', '{"entities": "nope"}']) {
    const r = parseExtraction(bad);
    assert.deepEqual(r.entities, []);
    assert.deepEqual(r.triples, []);
  }
});

test('parseExtraction drops entries missing name or type but keeps the rest', () => {
  const mixed = JSON.stringify({
    entities: [{ name: 'a', type: 'file' }, { name: 'b' }, { type: 'project' }, { name: '  ', type: 'file' }],
    triples: [{ subject: 'a', predicate: 'part_of' }],
  });
  const r = parseExtraction(mixed);
  assert.equal(r.entities.length, 1);
  assert.equal(r.entities[0]?.name, 'a');
  // A triple missing `object` is not a triple.
  assert.equal(r.triples.length, 0);
});

test('parseExtraction does not police the vocabulary — that is the RPC job', () => {
  // A hallucinated type must survive parsing and be dropped SERVER-side, so the
  // RPC's `dropped` counter is the single place out-of-vocabulary shows up.
  const r = parseExtraction(
    JSON.stringify({ entities: [{ name: 'x', type: 'not_a_real_type' }], triples: [] }),
  );
  assert.equal(r.entities.length, 1);
  assert.equal(r.entities[0]?.type, 'not_a_real_type');
});

// ── buildPrompt (pure) ──────────────────────────────────────────────────────

test('buildPrompt injects the live vocabulary and caps content length', () => {
  const prompt = buildPrompt('y'.repeat(50_000), {
    predicates: ['part_of', 'fixed_by'],
    entityTypes: ['file', 'symbol'],
  });
  assert.match(prompt, /type MUST be exactly one of: file, symbol/);
  assert.match(prompt, /predicate MUST be exactly one of: part_of, fixed_by/);
  assert.ok(prompt.length < 20_000, 'content must be truncated, not sent whole');
  assert.match(prompt, /Do not extract secrets, tokens, or credentials/);
});

// ── capability probing ──────────────────────────────────────────────────────

test('probeSweepCapabilities reports each missing surface by name', async () => {
  const { pool } = poolFor({ ledgerPresent: false, rpcsPresent: false, vocabulary: false });
  const caps = await probeSweepCapabilities(pool);
  assert.equal(caps.ledger, false);
  assert.equal(caps.rpcs, false);
  assert.equal(caps.vocabulary, false);
  assert.match(caps.detail, /rumen migration 007/);
  assert.match(caps.detail, /engram migration 034/);
});

test('a missing ledger skips the pass rather than sweeping without idempotency', async () => {
  const { pool, calls } = poolFor({ ledgerPresent: false, candidates: [candidate(ID_A)] });
  const s = await runExtractionSweep(pool, {}, { anthropic: makeMockAnthropic(GOOD_JSON).client });
  assert.equal(s.ok, false);
  assert.match(s.skipped_reason ?? '', /rumen_extraction_sweep missing/);
  assert.equal(s.processed, 0);
  // Nothing was selected, so nothing could have been extracted or paid for.
  assert.ok(!calls.some((c) => isRpcCall(c.sql, 'upsert_memory_entities')));
});

test('a missing RPC pair skips the pass', async () => {
  const { pool } = poolFor({ rpcsPresent: false, candidates: [candidate(ID_A)] });
  const s = await runExtractionSweep(pool, {}, { anthropic: makeMockAnthropic(GOOD_JSON).client });
  assert.equal(s.ok, false);
  assert.match(s.skipped_reason ?? '', /upsert_memory_entities/);
});

// ── the write contract ──────────────────────────────────────────────────────

test('no statement the sweep emits mutates memory_items', async () => {
  const { pool, calls } = poolFor({
    candidates: [candidate(ID_A, 'flaky-test'), candidate(ID_B)],
    samePatternTargets: [ID_C],
  });
  await runExtractionSweep(pool, {}, { anthropic: makeMockAnthropic(GOOD_JSON).client });

  // Asserted against what the pool actually received, not against the source.
  for (const { sql } of calls) {
    const normalized = sql.toLowerCase();
    assert.ok(
      !/\b(update|delete\s+from|insert\s+into)\s+(public\.)?memory_items\b/.test(normalized),
      `sweep emitted a mutating statement against memory_items: ${sql}`,
    );
  }
  // And it did emit its own writes, so the assertion above is not vacuous.
  assert.ok(calls.some((c) => c.sql.includes('insert into public.rumen_extraction_sweep')));
});

test('consolidation summaries are excluded from selection (anti-amplification)', async () => {
  const { pool, calls } = poolFor({ candidates: [] });
  await runExtractionSweep(pool, {}, { anthropic: makeMockAnthropic(GOOD_JSON).client });
  const select = calls.find((c) => c.sql.includes('rumen_extraction_sweep s on s.memory_id'));
  assert.ok(select, 'selection query must run');
  assert.match(select.sql, /not \(m\.source_type = any/);
  assert.deepEqual(select.params[1], ['consolidation_summary']);
});

// ── idempotency ─────────────────────────────────────────────────────────────

test('selection joins the ledger and only takes unswept or retryable rows', async () => {
  const { pool, calls } = poolFor({ candidates: [] });
  await runExtractionSweep(pool, { maxAttempts: 3, lookbackDays: 30, batch: 150 });
  const select = calls.find((c) => c.sql.includes('rumen_extraction_sweep s on s.memory_id'));
  assert.ok(select);
  assert.match(select.sql, /left join public\.rumen_extraction_sweep/);
  assert.match(select.sql, /s\.memory_id is null/);
  assert.match(select.sql, /s\.status = 'error' and s\.attempts < \$4/);
  assert.equal(select.params[3], 3, 'the attempt cap must reach the query');
  assert.match(select.sql, /order by m\.created_at desc/);
});

test('every processed item lands exactly one ledger upsert', async () => {
  const { pool, calls } = poolFor({ candidates: [candidate(ID_A), candidate(ID_B)] });
  const s = await runExtractionSweep(pool, {}, { anthropic: makeMockAnthropic(GOOD_JSON).client });
  assert.equal(s.processed, 2);
  const ledgerWrites = calls.filter((c) => c.sql.includes('insert into public.rumen_extraction_sweep'));
  assert.equal(ledgerWrites.length, 2);
  assert.deepEqual(
    ledgerWrites.map((c) => c.params[0]).sort(),
    [ID_A, ID_B].sort(),
  );
  // The upsert must increment attempts on conflict, or a failing item is
  // retried forever.
  assert.match(ledgerWrites[0]!.sql, /attempts\s+=\s+public\.rumen_extraction_sweep\.attempts \+ 1/);
});

// ── budget ──────────────────────────────────────────────────────────────────

test('the pass stops at the wall clock and reports what it skipped', async () => {
  const many = Array.from({ length: 12 }, (_, i) =>
    candidate(`${i}`.padStart(8, '0') + '-0000-0000-0000-000000000000'),
  );
  const { pool } = poolFor({ candidates: many });

  // Clock jumps past the budget once the first chunk is done.
  let t = 0;
  const now = () => {
    t += 30_000;
    return t;
  };

  const s = await runExtractionSweep(
    pool,
    { budgetMs: 60_000, concurrency: 4 },
    { anthropic: makeMockAnthropic(GOOD_JSON).client, now },
  );
  assert.ok(s.skipped_budget > 0, 'must report the untouched remainder');
  assert.ok(s.processed < many.length, 'must not process the whole batch');
  assert.equal(s.processed + s.skipped_budget, many.length);
});

// ── fail-open per item ──────────────────────────────────────────────────────

test('a poison item is recorded as an error and the pass continues', async () => {
  let first = true;
  const anthropic = {
    messages: {
      create: async () => {
        if (first) {
          first = false;
          throw new Error('model refused');
        }
        return { content: [{ type: 'text', text: GOOD_JSON }] };
      },
    },
  };
  const { pool, calls } = poolFor({ candidates: [candidate(ID_A), candidate(ID_B)] });
  const s = await runExtractionSweep(
    pool,
    { concurrency: 1 },
    { anthropic: anthropic as never },
  );

  assert.equal(s.processed, 2, 'the item behind the failure must still be swept');
  assert.equal(s.failed, 1);
  assert.equal(s.succeeded, 1);
  assert.equal(s.errors.length, 1);
  assert.match(s.errors[0]!.error, /model refused/);

  // The failure is durable — a ledger row with status='error', not a silent skip.
  const errorWrite = calls.find(
    (c) => c.sql.includes('insert into public.rumen_extraction_sweep') && c.params[1] === 'error',
  );
  assert.ok(errorWrite, 'a failed item must still get a ledger row');
});

test('a ledger write failure degrades to re-selection, never aborts the pass', async () => {
  const { pool } = poolFor({
    candidates: [candidate(ID_A), candidate(ID_B)],
    failOn: (c) => c.sql.includes('insert into public.rumen_extraction_sweep'),
  });
  const s = await runExtractionSweep(pool, {}, { anthropic: makeMockAnthropic(GOOD_JSON).client });
  assert.equal(s.ok, true, 'bookkeeping failure must not fail the pass');
  assert.equal(s.processed, 2);
  assert.ok(s.errors.some((e) => /ledger write failed/.test(e.error)));
});

// ── degraded but useful: no model key ───────────────────────────────────────

test('with no model the deterministic same_pattern_as half still runs', async () => {
  const { pool, calls } = poolFor({
    candidates: [candidate(ID_A, 'flaky-test')],
    samePatternTargets: [ID_B, ID_C],
    edgeResult: { accepted: 2, dropped_predicates: [] },
  });
  // deps.anthropic absent AND no key in env (cleared at module load) → the
  // model half is skipped.
  const s = await runExtractionSweep(pool, {});
  assert.equal(s.ok, true);
  assert.equal(s.same_pattern_edges, 2, 'the no-model edge must still land');
  assert.equal(s.entities_written, 0);

  const edgeCall = calls.find((c) => isRpcCall(c.sql, 'upsert_memory_edges'));
  assert.ok(edgeCall);
  const edges = JSON.parse(edgeCall.params[0] as string) as Array<Record<string, unknown>>;
  assert.equal(edges.length, 2);
  assert.equal(edges[0]?.predicate, 'same_pattern_as');
  assert.equal(edges[0]?.inferred_by, SWEEP_INFERRED_BY);
});

test('an item with no problem_signature emits no same_pattern lookup at all', async () => {
  const { pool, calls } = poolFor({ candidates: [candidate(ID_A, null)] });
  await runExtractionSweep(pool, {}, { anthropic: makeMockAnthropic(GOOD_JSON).client });
  assert.ok(!calls.some((c) => isRpcCall(c.sql, 'upsert_memory_edges')));
});

// ── dry run ─────────────────────────────────────────────────────────────────

test('dry run writes nothing at all — not entities, not edges, not the ledger', async () => {
  const { pool, calls } = poolFor({
    candidates: [candidate(ID_A, 'flaky-test'), candidate(ID_B)],
    samePatternTargets: [ID_C],
  });
  const s = await runExtractionSweep(
    pool,
    { dryRun: true },
    { anthropic: makeMockAnthropic(GOOD_JSON).client },
  );

  assert.equal(s.dry_run, true);
  assert.equal(s.processed, 2);
  for (const { sql } of calls) {
    assert.ok(!isRpcCall(sql, 'upsert_memory_entities'), 'dry run must not write entities');
    assert.ok(!isRpcCall(sql, 'upsert_memory_edges'), 'dry run must not write edges');
    assert.ok(!sql.includes('insert into public.rumen_extraction_sweep'), 'dry run must not write the ledger');
  }
  // It still reports what it WOULD have done, or the dry run is useless.
  assert.ok(s.entities_written > 0);
  assert.ok(s.same_pattern_edges > 0);
});

// ── SR-7 telemetry ──────────────────────────────────────────────────────────

test('triples are counted and sampled but never persisted', async () => {
  const { pool, calls } = poolFor({ candidates: [candidate(ID_A)] });
  const s: SweepSummary = await runExtractionSweep(
    pool,
    {},
    { anthropic: makeMockAnthropic(GOOD_JSON).client },
  );
  assert.equal(s.triples_found, 1);
  assert.equal(s.triples_sample[0]?.predicate, 'part_of');

  // The only edge write path is same_pattern_as; a triple must never reach it.
  const edgeCalls = calls.filter((c) => isRpcCall(c.sql, 'upsert_memory_edges'));
  for (const c of edgeCalls) {
    const edges = JSON.parse(c.params[0] as string) as Array<{ predicate: string }>;
    for (const e of edges) assert.equal(e.predicate, 'same_pattern_as');
  }
});

test('server-dropped entity types are surfaced, not swallowed', async () => {
  const { pool } = poolFor({
    candidates: [candidate(ID_A)],
    entityResult: { created: 1, linked: 1, dropped: 3 },
  });
  const s = await runExtractionSweep(pool, {}, { anthropic: makeMockAnthropic(GOOD_JSON).client });
  assert.equal(s.dropped_entity_types, 3);
});

// ── no vocabulary → no guessing ─────────────────────────────────────────────

test('an unreadable vocabulary skips the model half instead of falling back to a hardcoded list', async () => {
  const { pool, calls } = poolFor({
    candidates: [candidate(ID_A, 'flaky-test')],
    samePatternTargets: [ID_B],
    vocabulary: false,
  });
  const anthropic = makeMockAnthropic(GOOD_JSON);
  const s = await runExtractionSweep(pool, {}, { anthropic: anthropic.client });

  assert.equal(anthropic.callCount(), 0, 'no model call without a live vocabulary');
  assert.equal(s.entities_written, 0);
  // The deterministic half is unaffected — it needs no vocabulary.
  assert.equal(s.same_pattern_edges, 1);
  assert.ok(!calls.some((c) => isRpcCall(c.sql, 'upsert_memory_entities')));
});
