/**
 * Rumen Sprint 71 (B-T3) — objective-guard tests.
 *
 * Everything is in-memory: mock pg.Pool, mock Anthropic, injected clock and
 * injected tier-0 accessor. No database, no API key, no knowledge of which
 * shape engram migration 038 eventually lands as.
 *
 * The load-bearing fences here, in order of what would hurt most if it broke:
 *   1. the module never writes to a memory_* table (the flag-never-resolve rule);
 *   2. a model verdict naming an objective it was not shown is discarded;
 *   3. no API key skips WITHOUT stamping the ledger (else those memories would
 *      be silently marked judged and never re-judged once a key arrived);
 *   4. undetermined coverage reports drift = null, never drift = true;
 *   5. every linkage predicate references $3, or the undetermined path — the
 *      one that runs on every store until 038 lands — would be the only path
 *      that throws on bind.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  assessStaleness,
  buildContradictionPrompt,
  buildLinkagePredicate,
  computeProjectCoverage,
  contradictionDedupKey,
  fetchAllObjectives,
  fetchObjectivesFrom,
  groupByProject,
  listObjectiveProjects,
  normalizeObjective,
  objectiveKey,
  objectivesFingerprint,
  parseContradictions,
  probeLinkageSource,
  resolveTier0Source,
  runContradictionScan,
  runObjectiveCoverageReport,
  runObjectiveGuard,
  runObjectiveStalenessScan,
  selectContradictionCandidates,
  sortObjectives,
  stalenessDedupKey,
  type Tier0Objective,
  type Tier0Resolution,
} from '../src/objective-guard.ts';
import { makeMockAnthropic, makeMockPool, quiet, type QueryCall } from './helpers.ts';

// ── fixtures ────────────────────────────────────────────────────────────────

function makeObjective(overrides: Partial<Tier0Objective> = {}): Tier0Objective {
  return {
    id: overrides.id !== undefined ? overrides.id : 'obj-1',
    project: overrides.project ?? 'termdeck',
    rank: overrides.rank !== undefined ? overrides.rank : 1,
    text: overrides.text ?? 'TermDeck ships with no build step: zero TypeScript on the client.',
    status: overrides.status !== undefined ? overrides.status : 'active',
    ratified_by: overrides.ratified_by !== undefined ? overrides.ratified_by : 'operator',
    ratified_at: overrides.ratified_at !== undefined ? overrides.ratified_at : '2026-08-01T00:00:00Z',
    supersedes: overrides.supersedes !== undefined ? overrides.supersedes : null,
  };
}

const RPC_RESOLUTION: Tier0Resolution = {
  kind: 'rpc',
  name: 'objective_list',
  detail: 'rpc public.objective_list(text)',
};

const CANDIDATE_ROW = {
  id: '11111111-1111-1111-1111-111111111111',
  project: 'termdeck',
  content:
    'Decision: migrate the TermDeck client to TypeScript with a Vite build step so we get ' +
    'type safety in the browser bundle.',
  source_type: 'decision',
  created_at: '2026-08-04T12:00:00Z',
};

const CONTRADICTION_JSON = JSON.stringify({
  contradictions: [
    {
      objective_id: 'obj-1',
      severity: 'high',
      rationale:
        'The memory decides to introduce a TypeScript build step for the client, which is ' +
        'the exact thing the objective rules out.',
      gist: 'Proposes a TS + Vite build for the client.',
    },
  ],
});

/**
 * A responder that branches on SQL rather than call order — the phases issue a
 * different number of queries depending on which branch they take, and an
 * order-indexed fixture would silently drift the moment one changes.
 */
function sqlResponder(handlers: Array<[RegExp, { rows: unknown[] } | Error]>) {
  return (call: QueryCall) => {
    for (const [pattern, result] of handlers) {
      if (pattern.test(call.sql)) return result;
    }
    return { rows: [] };
  };
}

const JOB_INSERT = /insert into public\.rumen_objective_guard_jobs/i;
const CANDIDATE_SELECT = /from public\.memory_items m\s+left join public\.rumen_objective_scan/i;
const FLAG_INSERT = /insert into public\.rumen_objective_flags/i;
const SCAN_LEDGER = /insert into public\.rumen_objective_scan/i;
const COVERAGE_INSERT = /insert into public\.rumen_objective_coverage/i;

/** No write of any kind against a Mnestra-owned table. */
function assertNoMemoryWrites(calls: QueryCall[]): void {
  for (const call of calls) {
    const sql = call.sql.toLowerCase();
    assert.ok(
      !/insert\s+into\s+public\.memory_/.test(sql),
      `objective-guard must never INSERT into a memory_* table: ${call.sql.slice(0, 120)}`,
    );
    assert.ok(
      !/update\s+public\.memory_/.test(sql),
      `objective-guard must never UPDATE a memory_* table: ${call.sql.slice(0, 120)}`,
    );
    assert.ok(
      !/delete\s+from\s+public\.memory_/.test(sql),
      `objective-guard must never DELETE from a memory_* table: ${call.sql.slice(0, 120)}`,
    );
  }
}

// ── tier-0 accessor ─────────────────────────────────────────────────────────

test('resolveTier0Source prefers the rpc arm, then table, then marker', async () => {
  const rpc = await resolveTier0Source(
    makeMockPool({ responses: [{ rows: [{ rpc: true, tbl: true, marker: true }] }] }).pool,
  );
  assert.equal(rpc.kind, 'rpc');
  assert.equal(rpc.name, 'objective_list');

  const table = await resolveTier0Source(
    makeMockPool({ responses: [{ rows: [{ rpc: false, tbl: true, marker: true }] }] }).pool,
  );
  assert.equal(table.kind, 'table');
  assert.equal(table.name, 'memory_objectives');

  const prior = process.env['RUMEN_TIER0_MARKER_COLUMN'];
  process.env['RUMEN_TIER0_MARKER_COLUMN'] = 'tier';
  try {
    const marker = await resolveTier0Source(
      makeMockPool({ responses: [{ rows: [{ rpc: false, tbl: false, marker: true }] }] }).pool,
    );
    assert.equal(marker.kind, 'marker');
    assert.equal(marker.name, 'tier');
  } finally {
    if (prior === undefined) delete process.env['RUMEN_TIER0_MARKER_COLUMN'];
    else process.env['RUMEN_TIER0_MARKER_COLUMN'] = prior;
  }
});

test('the marker arm is OPT-IN: with no env set it is never probed and never latched', async () => {
  const prior = process.env['RUMEN_TIER0_MARKER_COLUMN'];
  delete process.env['RUMEN_TIER0_MARKER_COLUMN'];
  try {
    // The database says a `tier` column exists. Without the opt-in we must NOT
    // read ordinary memory_items rows as objectives — B-T1's 038 put objectives
    // in their own table and said not to resolve them through memory_items.
    const { pool, calls } = makeMockPool({
      responses: [{ rows: [{ rpc: false, tbl: false, marker: true }] }],
    });
    const resolution = await resolveTier0Source(pool);
    assert.equal(resolution.kind, 'unavailable');
    assert.equal(calls[0]!.params[2], '', 'an empty column name can never match');
  } finally {
    if (prior !== undefined) process.env['RUMEN_TIER0_MARKER_COLUMN'] = prior;
  }
});

test('resolveTier0Source reports unavailable (not an error) when 038 is absent', async () => {
  const none = await resolveTier0Source(
    makeMockPool({ responses: [{ rows: [{ rpc: false, tbl: false, marker: false }] }] }).pool,
  );
  assert.equal(none.kind, 'unavailable');
  assert.match(none.detail, /engram migration 038/);

  const broken = await quiet(() =>
    resolveTier0Source(makeMockPool({ responses: [new Error('relation missing')] }).pool),
  );
  assert.equal(broken.kind, 'unavailable');
  assert.match(broken.detail, /probe failed/);
});

test('fetchObjectivesFrom refuses an identifier that is not a plain lowercase name', async () => {
  const { pool, calls } = makeMockPool({ responses: [{ rows: [] }] });
  const rows = await fetchObjectivesFrom(
    pool,
    { kind: 'table', name: 'memory_objectives; drop table x', detail: '' },
    null,
  );
  assert.deepEqual(rows, []);
  assert.equal(calls.length, 0, 'a rejected identifier must never reach the database');
});

test('the table arm selects B-T1\'s frozen `content` column, never `text`', async () => {
  const { pool, calls } = makeMockPool({
    responses: [
      {
        rows: [
          {
            id: '9f1d0c2e-0000-4000-8000-000000000001',
            project: 'termdeck',
            rank: 1,
            text: 'No build step on the client.',
            status: 'active',
            ratified_by: 'operator',
            ratified_at: '2026-08-01T00:00:00Z',
            supersedes: null,
          },
        ],
      },
    ],
  });

  const rows = await fetchObjectivesFrom(
    pool,
    { kind: 'table', name: 'memory_objectives', detail: 'table public.memory_objectives' },
    'termdeck',
  );

  const sql = calls[0]!.sql;
  // B-T1 froze the prose column as `content`, explicitly NOT `text`. Selecting
  // `"text"` errors with column-not-found, the catch returns [], and every job
  // reads "no objectives" — a silent total no-op on a store full of them.
  assert.match(sql, /content\s+as text/, 'table arm must select content as text');
  assert.ok(!/"text"\s+as text/.test(sql), 'the pre-038 `"text"` select must not come back');
  assert.match(sql, /from public\.memory_objectives/);
  assert.match(sql, /coalesce\(status, 'active'\) = 'active'/, "B-T1's status contract");
  assert.equal(calls[0]!.params[0], 'termdeck');
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.text, 'No build step on the client.');
  assert.equal(rows[0]?.id, '9f1d0c2e-0000-4000-8000-000000000001');
});

test('the table arm prose column is overridable for a differently-shaped store', async () => {
  const prior = process.env['RUMEN_TIER0_TEXT_COLUMN'];
  process.env['RUMEN_TIER0_TEXT_COLUMN'] = 'body';
  try {
    const { pool, calls } = makeMockPool({ responses: [{ rows: [] }] });
    await fetchObjectivesFrom(pool, { kind: 'table', name: 'memory_objectives', detail: '' }, null);
    assert.match(calls[0]!.sql, /body\s+as text/);
  } finally {
    if (prior === undefined) delete process.env['RUMEN_TIER0_TEXT_COLUMN'];
    else process.env['RUMEN_TIER0_TEXT_COLUMN'] = prior;
  }
});

test('fetchObjectivesFrom normalizes the marker arm, where rank arrives as metadata text', async () => {
  const { pool } = makeMockPool({
    responses: [
      {
        rows: [
          { id: 'a', project: 'rumen', rank: '2', text: 'Second thing', status: 'active' },
          { id: 'b', project: 'rumen', rank: '1', text: 'First thing', status: 'active' },
          { id: 'c', project: 'rumen', rank: null, text: '   ', status: 'active' },
        ],
      },
    ],
  });
  const rows = await fetchObjectivesFrom(pool, { kind: 'marker', name: 'tier', detail: '' }, null);
  assert.equal(rows.length, 2, 'the blank-text row is dropped, not defaulted');
  assert.deepEqual(rows.map((r) => r.text), ['First thing', 'Second thing']);
  assert.equal(rows[0]?.rank, 1);
});

test('fetchObjectivesFrom degrades to empty on a read error rather than throwing', async () => {
  const { pool } = makeMockPool({ responses: [new Error('permission denied')] });
  const rows = await quiet(() => fetchObjectivesFrom(pool, RPC_RESOLUTION, 'termdeck'));
  assert.deepEqual(rows, []);
});

const PROJECT_ENUM = /select distinct project/i;
const RPC_CALL = /from public\.objective_list\(\$1::text\)/i;
const TABLE_READ = /from public\.memory_objectives/i;

test('fetchAllObjectives fans the rpc arm out per project instead of calling objective_list(null)', async () => {
  const { pool, calls } = makeMockPool({
    responses: sqlResponder([
      [PROJECT_ENUM, { rows: [{ project: 'termdeck' }, { project: 'rumen' }] }],
      [
        RPC_CALL,
        {
          rows: [
            { id: 'o1', project: 'termdeck', rank: 1, text: 'first', status: 'active' },
          ],
        },
      ],
    ]),
  });

  const rows = await fetchAllObjectives(pool, RPC_RESOLUTION);

  const rpcCalls = calls.filter((c) => RPC_CALL.test(c.sql));
  assert.equal(rpcCalls.length, 2, 'one RPC call per project with active objectives');
  assert.deepEqual(rpcCalls.map((c) => c.params[0]).sort(), ['rumen', 'termdeck']);
  // The regression this whole function exists for: B-T1 made objective_list(null)
  // return zero rows on purpose, so an all-projects read through it is a silent
  // no-op on a store full of objectives.
  assert.ok(
    !rpcCalls.some((c) => c.params[0] === null),
    'objective_list must never be called with a null project on the all-projects path',
  );
  assert.equal(rows.length, 2);
});

test('fetchAllObjectives falls back to a direct table read when project enumeration fails', async () => {
  const { pool, calls } = makeMockPool({
    responses: sqlResponder([
      [PROJECT_ENUM, new Error('permission denied for table memory_objectives')],
      [TABLE_READ, { rows: [{ id: 'o1', project: 'termdeck', rank: 1, text: 'kept', status: 'active' }] }],
    ]),
  });

  const rows = await quiet(() => fetchAllObjectives(pool, RPC_RESOLUTION));
  assert.equal(rows.length, 1, 'a grant anomaly must not read as "no objectives"');
  const tableCall = calls.find((c) => TABLE_READ.test(c.sql) && !PROJECT_ENUM.test(c.sql));
  assert.ok(tableCall, 'the fallback reads the objectives table directly');
  assert.match(tableCall!.sql, /content\s+as text/);
  assert.equal(calls.filter((c) => RPC_CALL.test(c.sql)).length, 0);
});

test('fetchAllObjectives returns empty without any RPC call when no project has objectives', async () => {
  const { pool, calls } = makeMockPool({
    responses: sqlResponder([[PROJECT_ENUM, { rows: [] }]]),
  });
  assert.deepEqual(await fetchAllObjectives(pool, RPC_RESOLUTION), []);
  assert.equal(calls.filter((c) => RPC_CALL.test(c.sql)).length, 0);
});

test('fetchAllObjectives on the table arm is a single unfiltered read', async () => {
  const { pool, calls } = makeMockPool({
    responses: sqlResponder([
      [TABLE_READ, { rows: [{ id: 'o1', project: 'termdeck', rank: 1, text: 'x', status: 'active' }] }],
    ]),
  });
  const rows = await fetchAllObjectives(pool, {
    kind: 'table',
    name: 'memory_objectives',
    detail: '',
  });
  assert.equal(rows.length, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.params[0], null, 'null here means "no project filter", which the table arm honours');
});

test('listObjectiveProjects distinguishes "none" from "could not read"', async () => {
  const empty = makeMockPool({ responses: [{ rows: [] }] });
  assert.deepEqual(await listObjectiveProjects(empty.pool, 'memory_objectives'), []);

  const broken = makeMockPool({ responses: [new Error('relation does not exist')] });
  assert.equal(await listObjectiveProjects(broken.pool, 'memory_objectives'), null);

  const unsafe = makeMockPool({ responses: [] });
  assert.equal(await listObjectiveProjects(unsafe.pool, 'bad; drop table x'), null);
  assert.equal(unsafe.calls.length, 0);
});

test('a job on the rpc arm reaches objectives through the fan-out, not objective_list(null)', async () => {
  const { pool, calls } = makeMockPool({
    responses: sqlResponder([
      [JOB_INSERT, { rows: [{ id: 'job-r' }] }],
      [PROJECT_ENUM, { rows: [{ project: 'termdeck' }] }],
      [
        RPC_CALL,
        {
          rows: [
            {
              id: 'obj-1',
              project: 'termdeck',
              rank: 1,
              text: 'No build step on the client.',
              status: 'active',
              ratified_at: '2025-01-01T00:00:00Z',
            },
          ],
        },
      ],
      [FLAG_INSERT, { rows: [{ id: 'flag-r' }] }],
    ]),
  });

  const summary = await quiet(() =>
    runObjectiveStalenessScan(
      pool,
      { enabled: true, dryRun: false, stalenessDays: 180 },
      { resolution: RPC_RESOLUTION, now: () => NOW_MS },
    ),
  );

  assert.equal(summary.status, 'done', 'not "skipped: no tier-0 objectives"');
  assert.equal(summary.objectives_seen, 1);
  assert.equal(summary.flags_written, 1);
  assert.equal(calls.filter((c) => RPC_CALL.test(c.sql)).length, 1);
});

test('normalizeObjective drops unreadable text and coerces a string rank', () => {
  assert.equal(normalizeObjective({ id: 'x', text: '' }), null);
  assert.equal(normalizeObjective(null), null);
  const o = normalizeObjective({ id: 'x', text: ' keep ', rank: '4' }, 'fallback');
  assert.equal(o?.text, 'keep');
  assert.equal(o?.rank, 4);
  assert.equal(o?.project, 'fallback');
});

test('sortObjectives pins by rank ascending with nulls last', () => {
  const sorted = sortObjectives([
    makeObjective({ id: 'c', rank: null, text: 'unranked' }),
    makeObjective({ id: 'b', rank: 3, text: 'third' }),
    makeObjective({ id: 'a', rank: 1, text: 'first' }),
  ]);
  assert.deepEqual(sorted.map((o) => o.id), ['a', 'b', 'c']);
});

test('objectivesFingerprint is order-independent but changes on re-ratification', () => {
  const a = makeObjective({ id: 'a', text: 'alpha' });
  const b = makeObjective({ id: 'b', text: 'beta' });
  assert.equal(objectivesFingerprint([a, b]), objectivesFingerprint([b, a]));

  const reratified = { ...a, ratified_at: '2026-09-01T00:00:00Z' };
  assert.notEqual(
    objectivesFingerprint([a, b]),
    objectivesFingerprint([reratified, b]),
    're-ratifying an objective must make its project re-judgeable',
  );
  assert.notEqual(
    objectivesFingerprint([a, b]),
    objectivesFingerprint([a]),
    'removing an objective must also change the fingerprint',
  );
});

test('objectiveKey keeps id-less objectives distinct instead of collapsing them', () => {
  assert.equal(objectiveKey(makeObjective({ id: 'obj-9' })), 'obj-9');
  const one = objectiveKey(makeObjective({ id: null, text: 'never ship on a Friday' }));
  const two = objectiveKey(makeObjective({ id: null, text: 'always run gitleaks' }));
  assert.notEqual(one, two);
  assert.match(one, /^text:[0-9a-f]{8}$/);
});

test('groupByProject drops objectives with no project rather than bucketing them together', () => {
  const grouped = groupByProject([
    makeObjective({ id: 'a', project: 'termdeck' }),
    makeObjective({ id: 'b', project: 'rumen' }),
    makeObjective({ id: 'c', project: '' }),
  ]);
  assert.deepEqual([...grouped.keys()].sort(), ['rumen', 'termdeck']);
});

// ── contradiction parsing ───────────────────────────────────────────────────

test('parseContradictions accepts a fenced verdict and preserves severity', () => {
  const out = parseContradictions('```json\n' + CONTRADICTION_JSON + '\n```', new Set(['obj-1']));
  assert.equal(out.length, 1);
  assert.equal(out[0]?.objective_id, 'obj-1');
  assert.equal(out[0]?.severity, 'high');
  assert.match(out[0]?.rationale ?? '', /build step/);
});

test('parseContradictions discards a flag naming an objective the model was not shown', () => {
  const hallucinated = JSON.stringify({
    contradictions: [{ objective_id: 'obj-does-not-exist', severity: 'high', rationale: 'x' }],
  });
  assert.deepEqual(parseContradictions(hallucinated, new Set(['obj-1'])), []);
});

test('parseContradictions drops a flag with no rationale — an unadjudicatable flag is not a flag', () => {
  const empty = JSON.stringify({
    contradictions: [{ objective_id: 'obj-1', severity: 'high', rationale: '   ' }],
  });
  assert.deepEqual(parseContradictions(empty, new Set(['obj-1'])), []);
});

test('parseContradictions dedups per objective, caps per memory, and defaults severity', () => {
  const many = JSON.stringify({
    contradictions: [
      { objective_id: 'o1', severity: 'nonsense', rationale: 'a' },
      { objective_id: 'o1', severity: 'high', rationale: 'duplicate' },
      { objective_id: 'o2', rationale: 'b' },
      { objective_id: 'o3', severity: 'low', rationale: 'c' },
      { objective_id: 'o4', severity: 'low', rationale: 'd' },
    ],
  });
  const out = parseContradictions(many, new Set(['o1', 'o2', 'o3', 'o4']));
  assert.equal(out.length, 3, 'MAX_FLAGS_PER_MEMORY');
  assert.deepEqual(out.map((v) => v.objective_id), ['o1', 'o2', 'o3']);
  assert.equal(out[0]?.severity, 'medium', 'an unrecognized severity falls back to medium');
});

test('parseContradictions treats unparseable output as no contradiction, not as an error', () => {
  assert.deepEqual(parseContradictions('I think maybe?', new Set(['obj-1'])), []);
  assert.deepEqual(parseContradictions('', new Set(['obj-1'])), []);
});

test('buildContradictionPrompt shows every objective by its key and never leaks a raw id-less collision', () => {
  const prompt = buildContradictionPrompt(
    { content: 'some memory', source_type: 'decision', created_at: '2026-08-04T12:00:00Z' },
    [makeObjective({ id: 'obj-1' }), makeObjective({ id: null, text: 'other rule' })],
  );
  assert.match(prompt, /objective_id: obj-1/);
  assert.match(prompt, /objective_id: text:[0-9a-f]{8}/);
  assert.match(prompt, /2026-08-04/);
});

test('dedup keys are stable and encode the re-flag trigger', () => {
  assert.equal(contradictionDedupKey('mem-1', 'obj-1'), 'contradiction:mem-1:obj-1');
  assert.equal(
    stalenessDedupKey('obj-1', '2026-01-01T00:00:00Z'),
    'staleness:obj-1:2026-01-01T00:00:00Z',
  );
  assert.notEqual(
    stalenessDedupKey('obj-1', '2026-01-01T00:00:00Z'),
    stalenessDedupKey('obj-1', '2026-08-01T00:00:00Z'),
    're-ratification must mint a new key so a dismissal is not permanent',
  );
  assert.equal(stalenessDedupKey('obj-1', null), 'staleness:obj-1:never');
});

// ── candidate selection ─────────────────────────────────────────────────────

test('selectContradictionCandidates scopes to judged source types and passes project:hash pairs', async () => {
  const { pool, calls } = makeMockPool({ responses: [{ rows: [CANDIDATE_ROW] }] });
  const rows = await selectContradictionCandidates(pool, {
    projects: ['termdeck'],
    projectHashPairs: ['termdeck:fnv1a:deadbeef:2'],
    lookbackDays: 14,
    batch: 60,
    maxAttempts: 3,
    minContentChars: 80,
  });
  assert.equal(rows.length, 1);
  const call = calls[0]!;
  assert.match(call.sql, /source_type = any\(\$2::text\[\]\)/);
  assert.deepEqual(call.params[1], ['decision', 'architecture', 'preference', 'bug_fix']);
  assert.deepEqual(call.params[5], ['termdeck:fnv1a:deadbeef:2']);
  assert.match(call.sql, /superseded_by is null/);
});

test('selectContradictionCandidates short-circuits with no projects', async () => {
  const { pool, calls } = makeMockPool({ responses: [] });
  const rows = await selectContradictionCandidates(pool, {
    projects: [],
    projectHashPairs: [],
    lookbackDays: 14,
    batch: 60,
    maxAttempts: 3,
    minContentChars: 80,
  });
  assert.deepEqual(rows, []);
  assert.equal(calls.length, 0);
});

// ── phase 1: contradiction scan ─────────────────────────────────────────────

test('contradiction scan writes a FLAG on a fixture contradiction and stamps the ledger', async () => {
  const { pool, calls } = makeMockPool({
    responses: sqlResponder([
      [JOB_INSERT, { rows: [{ id: 'job-1' }] }],
      [CANDIDATE_SELECT, { rows: [CANDIDATE_ROW] }],
      [FLAG_INSERT, { rows: [{ id: 'flag-1' }] }],
    ]),
  });
  const anthropic = makeMockAnthropic(CONTRADICTION_JSON);

  const summary = await quiet(() =>
    runContradictionScan(
      pool,
      { enabled: true, dryRun: false },
      {
        resolution: RPC_RESOLUTION,
        anthropic: anthropic.client,
        fetchObjectives: async () => [makeObjective({ id: 'obj-1' })],
      },
    ),
  );

  assert.equal(summary.status, 'done');
  assert.equal(summary.tier0_source, 'rpc');
  assert.equal(summary.objectives_seen, 1);
  assert.equal(summary.candidates, 1);
  assert.equal(summary.processed, 1);
  assert.equal(summary.flags_written, 1);
  assert.equal(summary.llm_calls_made, 1);
  assert.deepEqual(summary.errors, []);

  const flagInsert = calls.find((c) => FLAG_INSERT.test(c.sql));
  assert.ok(flagInsert, 'a contradiction flag row must be inserted');
  assert.match(flagInsert!.sql, /on conflict \(dedup_key\) do nothing/i);
  assert.equal(flagInsert!.params[0], 'contradiction');
  assert.equal(flagInsert!.params[1], 'termdeck');
  assert.equal(flagInsert!.params[2], 'obj-1');
  assert.equal(flagInsert!.params[5], CANDIDATE_ROW.id);
  assert.equal(flagInsert!.params[7], 'high');
  assert.equal(flagInsert!.params[10], `contradiction:${CANDIDATE_ROW.id}:obj-1`);

  const ledger = calls.find((c) => SCAN_LEDGER.test(c.sql));
  assert.ok(ledger, 'the scan ledger must be stamped after a real judgement');
  assert.equal(ledger!.params[1], 'ok');
  assert.equal(ledger!.params[2], 1);
  assert.match(String(ledger!.params[3]), /^fnv1a:/);

  assertNoMemoryWrites(calls);
});

test('contradiction scan writes NO flag when the model finds nothing, but still stamps the ledger', async () => {
  const { pool, calls } = makeMockPool({
    responses: sqlResponder([
      [JOB_INSERT, { rows: [{ id: 'job-1' }] }],
      [CANDIDATE_SELECT, { rows: [CANDIDATE_ROW] }],
    ]),
  });
  const anthropic = makeMockAnthropic('{"contradictions": []}');

  const summary = await quiet(() =>
    runContradictionScan(
      pool,
      { enabled: true, dryRun: false },
      {
        resolution: RPC_RESOLUTION,
        anthropic: anthropic.client,
        fetchObjectives: async () => [makeObjective({ id: 'obj-1' })],
      },
    ),
  );

  assert.equal(summary.flags_written, 0);
  assert.equal(summary.processed, 1);
  assert.equal(calls.filter((c) => FLAG_INSERT.test(c.sql)).length, 0);
  assert.ok(calls.some((c) => SCAN_LEDGER.test(c.sql)));
  assertNoMemoryWrites(calls);
});

test('contradiction scan with no API key skips WITHOUT stamping the ledger', async () => {
  const priorKey = process.env['ANTHROPIC_API_KEY'];
  delete process.env['ANTHROPIC_API_KEY'];
  try {
    const { pool, calls } = makeMockPool({
      responses: sqlResponder([
        [JOB_INSERT, { rows: [{ id: 'job-1' }] }],
        [CANDIDATE_SELECT, { rows: [CANDIDATE_ROW] }],
      ]),
    });
    const summary = await quiet(() =>
      runContradictionScan(
        pool,
        { enabled: true, dryRun: false },
        {
          resolution: RPC_RESOLUTION,
          fetchObjectives: async () => [makeObjective({ id: 'obj-1' })],
        },
      ),
    );
    assert.equal(summary.status, 'skipped');
    assert.match(summary.note ?? '', /no_api_key/);
    assert.equal(
      calls.filter((c) => SCAN_LEDGER.test(c.sql)).length,
      0,
      'stamping here would silently mark these memories judged forever',
    );
  } finally {
    if (priorKey !== undefined) process.env['ANTHROPIC_API_KEY'] = priorKey;
  }
});

test('contradiction scan skips when no project has objectives', async () => {
  const { pool, calls } = makeMockPool({
    responses: sqlResponder([[JOB_INSERT, { rows: [{ id: 'job-1' }] }]]),
  });
  const summary = await quiet(() =>
    runContradictionScan(
      pool,
      { enabled: true, dryRun: false },
      { resolution: RPC_RESOLUTION, fetchObjectives: async () => [] },
    ),
  );
  assert.equal(summary.status, 'skipped');
  assert.match(summary.note ?? '', /no tier-0 objectives/);
  assert.equal(calls.filter((c) => CANDIDATE_SELECT.test(c.sql)).length, 0);
});

test('contradiction scan skips when tier-0 is unresolvable and no accessor is injected', async () => {
  const { pool } = makeMockPool({
    responses: sqlResponder([[JOB_INSERT, { rows: [{ id: 'job-1' }] }]]),
  });
  const summary = await quiet(() =>
    runContradictionScan(
      pool,
      { enabled: true, dryRun: false },
      { resolution: { kind: 'unavailable', name: null, detail: 'no tier-0 surface' } },
    ),
  );
  assert.equal(summary.status, 'skipped');
  assert.equal(summary.tier0_source, 'unavailable');
});

test('contradiction scan dry-run computes flags but writes nothing at all', async () => {
  const { pool, calls } = makeMockPool({
    responses: sqlResponder([[CANDIDATE_SELECT, { rows: [CANDIDATE_ROW] }]]),
  });
  const anthropic = makeMockAnthropic(CONTRADICTION_JSON);
  const summary = await quiet(() =>
    runContradictionScan(
      pool,
      { enabled: true, dryRun: true },
      {
        resolution: RPC_RESOLUTION,
        anthropic: anthropic.client,
        fetchObjectives: async () => [makeObjective({ id: 'obj-1' })],
      },
    ),
  );
  assert.equal(summary.flags_written, 1);
  assert.equal(calls.filter((c) => FLAG_INSERT.test(c.sql)).length, 0);
  assert.equal(calls.filter((c) => SCAN_LEDGER.test(c.sql)).length, 0);
  assert.equal(calls.filter((c) => JOB_INSERT.test(c.sql)).length, 0);
});

test('a model failure on one item is recorded and never aborts the pass', async () => {
  const { pool, calls } = makeMockPool({
    responses: sqlResponder([
      [JOB_INSERT, { rows: [{ id: 'job-1' }] }],
      [CANDIDATE_SELECT, { rows: [CANDIDATE_ROW] }],
    ]),
  });
  const exploding = {
    messages: {
      create: async () => {
        throw new Error('429 overloaded');
      },
    },
  } as never;

  const summary = await quiet(() =>
    runContradictionScan(
      pool,
      { enabled: true, dryRun: false },
      {
        resolution: RPC_RESOLUTION,
        anthropic: exploding,
        fetchObjectives: async () => [makeObjective({ id: 'obj-1' })],
      },
    ),
  );
  assert.equal(summary.status, 'done');
  assert.equal(summary.processed, 1);
  assert.equal(summary.flags_written, 0);
  assert.equal(summary.errors.length, 1);
  assert.match(summary.errors[0]?.error ?? '', /429/);

  const ledger = calls.find((c) => SCAN_LEDGER.test(c.sql));
  assert.equal(ledger!.params[1], 'error', 'a failed item is retryable, not silently done');
});

// ── phase 2: coverage report ────────────────────────────────────────────────

test('every linkage predicate references $3 so the bind never mismatches', () => {
  for (const source of ['edges', 'metadata', 'both', 'unavailable'] as const) {
    assert.match(
      buildLinkagePredicate(source),
      /\$3::text\[\]/,
      `${source} predicate must mention $3`,
    );
  }
  assert.match(buildLinkagePredicate('unavailable'), /^\(false and/);
});

test('probeLinkageSource reports both / edges / metadata / unavailable', async () => {
  const cases: Array<[{ edges: boolean; meta: boolean }, string]> = [
    [{ edges: true, meta: true }, 'both'],
    [{ edges: true, meta: false }, 'edges'],
    [{ edges: false, meta: true }, 'metadata'],
    [{ edges: false, meta: false }, 'unavailable'],
  ];
  for (const [row, expected] of cases) {
    const { pool } = makeMockPool({ responses: [{ rows: [row] }] });
    assert.equal(await probeLinkageSource(pool), expected);
  }
});

test('computeProjectCoverage calls drift on sustained activity with zero linkage', async () => {
  const { pool } = makeMockPool({ responses: [{ rows: [{ writes: 40, linked: 0 }] }] });
  const row = await computeProjectCoverage(pool, {
    project: 'termdeck',
    objectiveIds: ['obj-1', 'obj-2'],
    objectiveCount: 2,
    windowDays: 7,
    minWrites: 20,
    linkage: 'both',
  });
  assert.equal(row.drift, true);
  assert.equal(row.coverage_ratio, 0);
  assert.match(row.note, /zero linked/);
});

test('computeProjectCoverage refuses to call drift on a small sample', async () => {
  const { pool } = makeMockPool({ responses: [{ rows: [{ writes: 3, linked: 0 }] }] });
  const row = await computeProjectCoverage(pool, {
    project: 'termdeck',
    objectiveIds: ['obj-1'],
    objectiveCount: 1,
    windowDays: 7,
    minWrites: 20,
    linkage: 'edges',
  });
  assert.equal(row.drift, false);
  assert.match(row.note, /below min_writes/);
});

test('computeProjectCoverage reports UNDETERMINED, never drift, with no linkage substrate', async () => {
  const { pool } = makeMockPool({ responses: [{ rows: [{ writes: 500, linked: 0 }] }] });
  const row = await computeProjectCoverage(pool, {
    project: 'termdeck',
    objectiveIds: ['obj-1'],
    objectiveCount: 1,
    windowDays: 7,
    minWrites: 20,
    linkage: 'unavailable',
  });
  assert.equal(row.drift, null, 'a missing feature must never be laundered into a drift claim');
  assert.equal(row.coverage_ratio, null);
  assert.match(row.note, /undetermined/);
});

test('computeProjectCoverage is undetermined when objectives carry no ids to link against', async () => {
  const { pool } = makeMockPool({ responses: [{ rows: [{ writes: 500, linked: 0 }] }] });
  const row = await computeProjectCoverage(pool, {
    project: 'termdeck',
    objectiveIds: [],
    objectiveCount: 3,
    windowDays: 7,
    minWrites: 20,
    linkage: 'both',
  });
  assert.equal(row.drift, null);
  assert.match(row.note, /no ids/);
});

test('coverage report writes one row per project with objectives', async () => {
  const { pool, calls } = makeMockPool({
    responses: sqlResponder([
      [JOB_INSERT, { rows: [{ id: 'job-2' }] }],
      [/to_regclass\('public\.memory_relationships'\)/, { rows: [{ edges: true, meta: true }] }],
      [/count\(\*\)::int as writes/, { rows: [{ writes: 40, linked: 0 }] }],
    ]),
  });

  const summary = await quiet(() =>
    runObjectiveCoverageReport(
      pool,
      { enabled: true, dryRun: false },
      {
        resolution: RPC_RESOLUTION,
        fetchObjectives: async () => [
          makeObjective({ id: 'obj-1', project: 'termdeck' }),
          makeObjective({ id: 'obj-2', project: 'rumen' }),
        ],
      },
    ),
  );

  assert.equal(summary.status, 'done');
  assert.equal(summary.candidates, 2);
  assert.equal(summary.reports_written, 2);

  const inserts = calls.filter((c) => COVERAGE_INSERT.test(c.sql));
  assert.equal(inserts.length, 2);
  assert.equal(inserts[0]!.params[7], 'both', 'linkage_source is recorded per report');
  assert.equal(inserts[0]!.params[8], true, 'drift');
  assertNoMemoryWrites(calls);
});

// ── phase 3: staleness ──────────────────────────────────────────────────────

const NOW_MS = Date.parse('2026-08-05T00:00:00Z');

test('assessStaleness escalates with age and stays quiet under the threshold', () => {
  const fresh = assessStaleness(makeObjective({ ratified_at: '2026-07-01T00:00:00Z' }), {
    thresholdDays: 180,
    flagUnratified: false,
    nowMs: NOW_MS,
  });
  assert.equal(fresh.stale, false);

  const stale = assessStaleness(makeObjective({ ratified_at: '2025-12-01T00:00:00Z' }), {
    thresholdDays: 180,
    flagUnratified: false,
    nowMs: NOW_MS,
  });
  assert.equal(stale.stale, true);
  assert.equal(stale.severity, 'medium');
  assert.match(stale.rationale, /No automatic change/);

  const ancient = assessStaleness(makeObjective({ ratified_at: '2024-01-01T00:00:00Z' }), {
    thresholdDays: 180,
    flagUnratified: false,
    nowMs: NOW_MS,
  });
  assert.equal(ancient.severity, 'high');
});

test('assessStaleness leaves never-ratified objectives alone unless explicitly asked', () => {
  const off = assessStaleness(makeObjective({ ratified_at: null }), {
    thresholdDays: 180,
    flagUnratified: false,
    nowMs: NOW_MS,
  });
  assert.equal(off.stale, false, 'default OFF — the marker arm would otherwise flag everything');

  const on = assessStaleness(makeObjective({ ratified_at: null }), {
    thresholdDays: 180,
    flagUnratified: true,
    nowMs: NOW_MS,
  });
  assert.equal(on.stale, true);
  assert.equal(on.severity, 'high');
  assert.equal(on.ageDays, null);

  const garbage = assessStaleness(makeObjective({ ratified_at: 'not-a-date' }), {
    thresholdDays: 180,
    flagUnratified: false,
    nowMs: NOW_MS,
  });
  assert.equal(garbage.stale, false);
});

test('staleness scan flags only the aged objective, with a ratification-scoped dedup key', async () => {
  const { pool, calls } = makeMockPool({
    responses: sqlResponder([
      [JOB_INSERT, { rows: [{ id: 'job-3' }] }],
      [FLAG_INSERT, { rows: [{ id: 'flag-2' }] }],
    ]),
  });

  const summary = await quiet(() =>
    runObjectiveStalenessScan(
      pool,
      { enabled: true, dryRun: false, stalenessDays: 180 },
      {
        resolution: RPC_RESOLUTION,
        now: () => NOW_MS,
        fetchObjectives: async () => [
          makeObjective({ id: 'fresh', ratified_at: '2026-07-20T00:00:00Z' }),
          makeObjective({ id: 'aged', ratified_at: '2025-01-01T00:00:00Z' }),
        ],
      },
    ),
  );

  assert.equal(summary.status, 'done');
  assert.equal(summary.processed, 2);
  assert.equal(summary.flags_written, 1);

  const inserts = calls.filter((c) => FLAG_INSERT.test(c.sql));
  assert.equal(inserts.length, 1);
  assert.equal(inserts[0]!.params[0], 'staleness');
  assert.equal(inserts[0]!.params[2], 'aged');
  assert.equal(inserts[0]!.params[5], null, 'a staleness flag has no offending memory');
  assert.equal(inserts[0]!.params[10], 'staleness:aged:2025-01-01T00:00:00Z');
  assertNoMemoryWrites(calls);
});

test('a flag insert failure is recorded per objective and does not abort the scan', async () => {
  const { pool } = makeMockPool({
    responses: sqlResponder([
      [JOB_INSERT, { rows: [{ id: 'job-3' }] }],
      [FLAG_INSERT, new Error('unique violation on something else')],
    ]),
  });
  const summary = await quiet(() =>
    runObjectiveStalenessScan(
      pool,
      { enabled: true, dryRun: false, stalenessDays: 180 },
      {
        resolution: RPC_RESOLUTION,
        now: () => NOW_MS,
        fetchObjectives: async () => [
          makeObjective({ id: 'aged-1', ratified_at: '2025-01-01T00:00:00Z' }),
          makeObjective({ id: 'aged-2', ratified_at: '2025-01-02T00:00:00Z' }),
        ],
      },
    ),
  );
  assert.equal(summary.status, 'done');
  assert.equal(summary.processed, 2);
  assert.equal(summary.flags_written, 0);
  assert.equal(summary.errors.length, 2);
});

// ── the dark gate ───────────────────────────────────────────────────────────

test('every entry point is dark by default and touches the database not at all', async () => {
  const prior = process.env['RUMEN_OBJECTIVE_GUARD_ENABLED'];
  delete process.env['RUMEN_OBJECTIVE_GUARD_ENABLED'];
  try {
    const { pool, calls } = makeMockPool({ responses: [] });
    const summary = await quiet(() => runObjectiveGuard(pool));
    assert.equal(summary.enabled, false);
    assert.deepEqual(summary.phases, []);
    assert.match(summary.note ?? '', /RUMEN_OBJECTIVE_GUARD_ENABLED/);

    for (const phase of [runContradictionScan, runObjectiveCoverageReport, runObjectiveStalenessScan]) {
      const s = await quiet(() => phase(pool));
      assert.equal(s.status, 'skipped');
      assert.match(s.note ?? '', /dark by default/);
    }
    assert.equal(calls.length, 0, 'a dark pass must not issue a single query');
  } finally {
    if (prior !== undefined) process.env['RUMEN_OBJECTIVE_GUARD_ENABLED'] = prior;
  }
});

test('the env switch alone activates the guard', async () => {
  const prior = process.env['RUMEN_OBJECTIVE_GUARD_ENABLED'];
  process.env['RUMEN_OBJECTIVE_GUARD_ENABLED'] = '1';
  try {
    const { pool } = makeMockPool({
      responses: sqlResponder([[JOB_INSERT, { rows: [{ id: 'job-x' }] }]]),
    });
    const summary = await quiet(() =>
      runObjectiveGuard(
        pool,
        { dryRun: false },
        { resolution: RPC_RESOLUTION, fetchObjectives: async () => [] },
      ),
    );
    assert.equal(summary.enabled, true);
    assert.equal(summary.phases.length, 3);
    assert.ok(summary.phases.every((p) => p.status === 'skipped'));
  } finally {
    if (prior === undefined) delete process.env['RUMEN_OBJECTIVE_GUARD_ENABLED'];
    else process.env['RUMEN_OBJECTIVE_GUARD_ENABLED'] = prior;
  }
});

test('options.enabled = false wins over the env switch (kill switch for a caller)', async () => {
  const prior = process.env['RUMEN_OBJECTIVE_GUARD_ENABLED'];
  process.env['RUMEN_OBJECTIVE_GUARD_ENABLED'] = '1';
  try {
    const { pool, calls } = makeMockPool({ responses: [] });
    const summary = await quiet(() => runObjectiveGuard(pool, { enabled: false }));
    assert.equal(summary.enabled, false);
    assert.equal(calls.length, 0);
  } finally {
    if (prior === undefined) delete process.env['RUMEN_OBJECTIVE_GUARD_ENABLED'];
    else process.env['RUMEN_OBJECTIVE_GUARD_ENABLED'] = prior;
  }
});

// ── whole-pass ──────────────────────────────────────────────────────────────

test('runObjectiveGuard runs all three phases against one latched resolution', async () => {
  const { pool, calls } = makeMockPool({
    responses: sqlResponder([
      [JOB_INSERT, { rows: [{ id: 'job-n' }] }],
      [CANDIDATE_SELECT, { rows: [CANDIDATE_ROW] }],
      [FLAG_INSERT, { rows: [{ id: 'flag-n' }] }],
      [/to_regclass\('public\.memory_relationships'\)/, { rows: [{ edges: true, meta: true }] }],
      [/count\(\*\)::int as writes/, { rows: [{ writes: 40, linked: 2 }] }],
    ]),
  });
  const anthropic = makeMockAnthropic(CONTRADICTION_JSON);

  const summary = await quiet(() =>
    runObjectiveGuard(
      pool,
      { enabled: true, dryRun: false, stalenessDays: 180 },
      {
        resolution: RPC_RESOLUTION,
        anthropic: anthropic.client,
        now: () => NOW_MS,
        fetchObjectives: async () => [
          makeObjective({ id: 'obj-1', ratified_at: '2025-01-01T00:00:00Z' }),
        ],
      },
    ),
  );

  assert.equal(summary.ok, true);
  assert.equal(summary.tier0_source, 'rpc');
  assert.deepEqual(
    summary.phases.map((p) => p.phase),
    ['contradiction_scan', 'coverage_report', 'staleness_scan'],
  );
  assert.equal(summary.phases[0]?.flags_written, 1, 'contradiction flag');
  assert.equal(summary.phases[1]?.reports_written, 1, 'coverage report');
  assert.equal(summary.phases[2]?.flags_written, 1, 'staleness flag');

  // No tier-0 probe: the resolution was latched once and shared by all three.
  assert.equal(calls.filter((c) => /to_regprocedure/.test(c.sql)).length, 0);
  assertNoMemoryWrites(calls);
});

test('a failing phase is recorded and the remaining phases still run', async () => {
  const { pool } = makeMockPool({
    responses: sqlResponder([
      [JOB_INSERT, { rows: [{ id: 'job-f' }] }],
      [CANDIDATE_SELECT, new Error('candidate select blew up')],
      [/to_regclass\('public\.memory_relationships'\)/, { rows: [{ edges: false, meta: false }] }],
      [/count\(\*\)::int as writes/, { rows: [{ writes: 0, linked: 0 }] }],
    ]),
  });

  const summary = await quiet(() =>
    runObjectiveGuard(
      pool,
      { enabled: true, dryRun: false },
      {
        resolution: RPC_RESOLUTION,
        now: () => NOW_MS,
        anthropic: makeMockAnthropic('{"contradictions": []}').client,
        fetchObjectives: async () => [makeObjective({ id: 'obj-1' })],
      },
    ),
  );

  assert.equal(summary.ok, false);
  assert.equal(summary.phases[0]?.status, 'failed');
  assert.match(summary.phases[0]?.error_message ?? '', /blew up/);
  assert.equal(summary.phases[1]?.status, 'done', 'coverage still runs');
  assert.equal(summary.phases[2]?.status, 'done', 'staleness still runs');
});
