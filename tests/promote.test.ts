/**
 * Rumen Sprint 76 — promote.ts test suite (the memory_inbox promotion pass).
 *
 * Unit tests run against a STATEFUL fake inbox pool (no real pg): the fake
 * dispatches on SQL markers and mutates an in-memory row store with the same
 * claim / CAS semantics as the real SQL, so idempotency and double-run
 * behavior are exercised for real, not just call-shape-asserted. The one
 * thing a fake cannot prove — FOR UPDATE SKIP LOCKED disjointness under two
 * live connections — has an env-guarded real-Postgres test at the bottom
 * (auto-skips unless DATABASE_URL is set; CI's integration DB qualifies).
 *
 * The LLM + embedding clients are mocked per the existing idioms
 * (tests/helpers.ts makeMockAnthropic; embed fns are plain async stubs), so
 * no test ever touches OpenAI or Anthropic.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  promoteInbox,
  stripPrivate,
  REJECTION_REASONS,
  WEB_SOURCE_AGENTS,
} from '../src/promote.ts';
import type { PromoteDeps, PromoteOptions } from '../src/promote.ts';
import type { PgPool } from '../src/db.ts';
import { makeMockAnthropic, quiet, type QueryCall } from './helpers.ts';

// The pass must be drivable purely through the deps seam; make sure ambient
// env never leaks into a test (and the missing-key tests start clean).
delete process.env['OPENAI_API_KEY'];
delete process.env['ANTHROPIC_API_KEY'];
delete process.env['RUMEN_PROMOTE_BATCH'];
delete process.env['RUMEN_PROMOTE_RATE_CAP_24H'];
delete process.env['RUMEN_PROMOTE_MAX_ATTEMPTS'];
delete process.env['RUMEN_PROMOTE_CLAIM_LEASE_MINUTES'];

const KITCHEN_JSON =
  '{"verdict": "kitchen", "rationale": "transfers across projects", ' +
  '"suggested_source_type": "decision"}';
const RECIPE_JSON =
  '{"verdict": "recipe", "rationale": "names a file:line fixed in one sprint"}';

// ---------------------------------------------------------------------------
// Stateful fake inbox pool
// ---------------------------------------------------------------------------

interface FakeInboxRow {
  id: string;
  created_at: string;
  source_agent: string | null;
  project_hint: string | null;
  text: string | null;
  status: string;
  promoted_memory_id: string | null;
  rejection_reason: string | null;
  metadata: Record<string, any>;
}

interface FakeMatchRow {
  id: string;
  similarity: number;
}

interface FakeStore {
  inbox: FakeInboxRow[];
  /** Committed memory_items inserts: [content, embedding, source_type, project, metadataJson, source_agent]. */
  memoryItems: Array<{ id: string; params: unknown[] }>;
  calls: QueryCall[];
  txLog: string[];
  /** Rows match_memories returns (already ordered best-first). */
  matchRows: FakeMatchRow[] | ((params: unknown[]) => FakeMatchRow[]);
  /** Test hook: runs after a claim lands (simulate a competing pass). */
  afterClaim?: () => void;
}

function makeRow(overrides: Partial<FakeInboxRow> = {}): FakeInboxRow {
  return {
    id: overrides.id ?? 'inbox-' + Math.random().toString(36).slice(2, 10),
    created_at: overrides.created_at ?? new Date(Date.now() - 60_000).toISOString(),
    source_agent: overrides.source_agent ?? 'claude-web',
    project_hint: overrides.project_hint ?? 'alpha',
    text:
      overrides.text ??
      'Defense in depth for credential redaction needs caller-side and source-side layers.',
    status: overrides.status ?? 'pending',
    promoted_memory_id: overrides.promoted_memory_id ?? null,
    rejection_reason: overrides.rejection_reason ?? null,
    metadata: overrides.metadata ?? {},
  };
}

function makeStore(rows: FakeInboxRow[], matchRows: FakeStore['matchRows'] = []): FakeStore {
  return { inbox: rows, memoryItems: [], calls: [], txLog: [], matchRows };
}

function makeInboxPool(store: FakeStore): PgPool {
  let memSeq = 0;
  // Journal for the promote transaction so ROLLBACK really undoes work.
  let tx: { inserted: string[]; snapshots: Array<{ row: FakeInboxRow; before: FakeInboxRow }> } | null =
    null;

  const dispatch = async (sql: string, params: unknown[] = []): Promise<{ rows: unknown[] }> => {
    store.calls.push({ sql, params });

    if (sql === 'BEGIN') {
      store.txLog.push('BEGIN');
      tx = { inserted: [], snapshots: [] };
      return { rows: [] };
    }
    if (sql === 'COMMIT') {
      store.txLog.push('COMMIT');
      tx = null;
      return { rows: [] };
    }
    if (sql === 'ROLLBACK') {
      store.txLog.push('ROLLBACK');
      if (tx) {
        store.memoryItems = store.memoryItems.filter((m) => !tx!.inserted.includes(m.id));
        for (const snap of tx.snapshots) {
          Object.assign(snap.row, snap.before);
        }
      }
      tx = null;
      return { rows: [] };
    }

    if (sql.includes('FOR UPDATE SKIP LOCKED')) {
      const [batch, leaseMinutes, runId] = params as [number, number, string];
      const now = Date.now();
      const eligible = store.inbox
        .filter((r) => {
          if (r.status !== 'pending') return false;
          const claimedAt = r.metadata?.['rumen']?.['last_claimed_at'];
          if (typeof claimedAt !== 'string') return true;
          const t = Date.parse(claimedAt);
          return Number.isNaN(t) || now - t >= leaseMinutes * 60_000;
        })
        .sort((a, b) => a.created_at.localeCompare(b.created_at))
        .slice(0, batch);
      for (const r of eligible) {
        r.metadata = {
          ...r.metadata,
          rumen: {
            ...(r.metadata['rumen'] ?? {}),
            last_claimed_at: new Date().toISOString(),
            run_id: runId,
          },
        };
      }
      const copies = eligible.map((r) => structuredClone(r));
      if (store.afterClaim) store.afterClaim();
      return { rows: copies };
    }

    if (sql.includes('GROUP BY source_agent')) {
      const cutoff = Date.now() - 24 * 60 * 60 * 1000;
      const counts = new Map<string, number>();
      for (const r of store.inbox) {
        if (r.status !== 'promoted') continue;
        const at = r.metadata?.['rumen']?.['promoted_at'];
        if (typeof at !== 'string' || Date.parse(at) < cutoff) continue;
        counts.set(r.source_agent ?? '', (counts.get(r.source_agent ?? '') ?? 0) + 1);
      }
      return {
        rows: Array.from(counts.entries()).map(([source_agent, promoted_count]) => ({
          source_agent,
          promoted_count,
        })),
      };
    }

    if (sql.includes('FROM match_memories')) {
      const rows =
        typeof store.matchRows === 'function' ? store.matchRows(params) : store.matchRows;
      return { rows: rows.map((r) => ({ id: r.id, similarity: r.similarity })) };
    }

    if (sql.includes('INSERT INTO memory_items')) {
      memSeq += 1;
      const id = 'mem-' + memSeq;
      store.memoryItems.push({ id, params });
      if (tx) tx.inserted.push(id);
      return { rows: [{ id }] };
    }

    if (sql.includes('promoted_memory_id = $2')) {
      const [rowId, memId, runId] = params as [string, string, string];
      const row = store.inbox.find((r) => r.id === rowId);
      if (!row || row.status !== 'pending') return { rows: [] };
      if (tx) tx.snapshots.push({ row, before: structuredClone(row) });
      row.status = 'promoted';
      row.promoted_memory_id = memId;
      row.metadata = {
        ...row.metadata,
        rumen: {
          ...(row.metadata['rumen'] ?? {}),
          promoted_at: new Date().toISOString(),
          run_id: runId,
        },
      };
      return { rows: [{ id: rowId }] };
    }

    if (sql.includes("'attempts-exhausted'")) {
      const [rowId, maxAttempts, error, runId] = params as [string, number, string, string];
      const row = store.inbox.find((r) => r.id === rowId);
      if (!row || row.status !== 'pending') return { rows: [] };
      const attempts = Number(row.metadata?.['rumen']?.['attempts'] ?? 0) + 1;
      const exhausted = attempts >= maxAttempts;
      if (exhausted) {
        row.status = 'rejected';
        row.rejection_reason = 'attempts-exhausted';
      }
      row.metadata = {
        ...row.metadata,
        rumen: {
          ...(row.metadata['rumen'] ?? {}),
          attempts,
          last_error: String(error).slice(0, 500),
          last_failed_at: new Date().toISOString(),
          run_id: runId,
        },
      };
      return { rows: [{ status: row.status }] };
    }

    if (sql.includes('rejection_reason = $2')) {
      const [rowId, reason, detailJson, runId] = params as [string, string, string, string];
      const row = store.inbox.find((r) => r.id === rowId);
      if (!row || row.status !== 'pending') return { rows: [] };
      row.status = 'rejected';
      row.rejection_reason = reason;
      row.metadata = {
        ...row.metadata,
        rumen: {
          ...(row.metadata['rumen'] ?? {}),
          ...JSON.parse(detailJson),
          rejected_at: new Date().toISOString(),
          run_id: runId,
        },
      };
      return { rows: [{ id: rowId }] };
    }

    throw new Error('fake inbox pool: unrecognized SQL: ' + sql.slice(0, 120));
  };

  return {
    query: dispatch,
    connect: async () => ({ query: dispatch, release: () => {} }),
    end: async () => {},
  } as unknown as PgPool;
}

function makeDeps(
  overrides: {
    embed?: (text: string) => Promise<number[] | null>;
    anthropicText?: string | string[];
  } = {},
): PromoteDeps {
  const { client } = makeMockAnthropic(overrides.anthropicText ?? KITCHEN_JSON);
  return {
    generateEmbedding: overrides.embed ?? (async () => [0.1, 0.2, 0.3]),
    anthropic: client,
  };
}

async function run(
  store: FakeStore,
  deps: PromoteDeps = makeDeps(),
  options: PromoteOptions = {},
) {
  const pool = makeInboxPool(store);
  return quiet(() => promoteInbox(pool, options, deps));
}

// ---------------------------------------------------------------------------
// Promote path + provenance
// ---------------------------------------------------------------------------

test('clean kitchen-level proposal is promoted with full provenance', async () => {
  const row = makeRow({
    source_agent: 'claude-web',
    project_hint: 'alpha',
    metadata: { bridge: { client_id: 'web-1', client_name: 'claude.ai' } },
  });
  const store = makeStore([row]);

  const summary = await run(store);

  assert.equal(summary.claimed, 1);
  assert.equal(summary.promoted, 1);
  assert.equal(summary.rejected, 0);
  assert.equal(summary.skipped_reason, null);

  // Canonical insert: [content, embedding, source_type, project, metadataJson, source_agent]
  assert.equal(store.memoryItems.length, 1);
  const item = store.memoryItems[0]!;
  const [content, embedding, sourceType, project, metadataJson, sourceAgent] = item.params as [
    string,
    string,
    string,
    string,
    string,
    string,
  ];
  assert.equal(content, row.text);
  assert.equal(embedding, '[0.1,0.2,0.3]');
  assert.equal(sourceType, 'decision', 'known Haiku suggestion is accepted');
  assert.equal(project, 'alpha');
  assert.equal(sourceAgent, 'claude-web', 'source_agent preserved — never rewritten to a CLI value');

  const itemMeta = JSON.parse(metadataJson);
  assert.equal(itemMeta.inbox_id, row.id);
  assert.equal(itemMeta.promoted_by, 'rumen-promotion');
  assert.ok(typeof itemMeta.promoted_at === 'string');
  assert.equal(itemMeta.kitchen_rationale, 'transfers across projects');
  assert.equal(itemMeta.proposal_metadata.bridge.client_id, 'web-1', 'connector metadata passes through');

  // Inbox stamp, same transaction.
  assert.equal(row.status, 'promoted');
  assert.equal(row.promoted_memory_id, item.id);
  assert.ok(typeof row.metadata['rumen']['promoted_at'] === 'string');
  assert.deepEqual(store.txLog, ['BEGIN', 'COMMIT']);
});

test('source_agent is normalized (trim + lowercase) before the whitelist check', async () => {
  const row = makeRow({ source_agent: '  GROK-WEB ' });
  const store = makeStore([row]);

  const summary = await run(store);

  assert.equal(summary.promoted, 1);
  const [, , , , , sourceAgent] = store.memoryItems[0]!.params as string[];
  assert.equal(sourceAgent, 'grok-web');
});

test('unknown Haiku source_type suggestion falls back to fact', async () => {
  const row = makeRow({});
  const store = makeStore([row]);
  const deps = makeDeps({
    anthropicText:
      '{"verdict": "kitchen", "rationale": "ok", "suggested_source_type": "manifesto"}',
  });

  const summary = await run(store, deps);

  assert.equal(summary.promoted, 1);
  const [, , sourceType] = store.memoryItems[0]!.params as string[];
  assert.equal(sourceType, 'fact');
});

// ---------------------------------------------------------------------------
// Gate rejections — one per stable rejection_reason tag
// ---------------------------------------------------------------------------

test('gate 1: text over 4000 chars rejects as oversize', async () => {
  const row = makeRow({ text: 'a'.repeat(4001) });
  const store = makeStore([row]);

  const summary = await run(store);

  assert.equal(summary.rejected, 1);
  assert.equal(summary.by_reason['oversize'], 1);
  assert.equal(row.status, 'rejected');
  assert.equal(row.rejection_reason, 'oversize');
  assert.equal(row.metadata['rumen']['check'], 'text-over-4000');
  assert.equal(store.memoryItems.length, 0);
});

test('gate 1: whitespace-only text rejects as oversize with empty-after-redaction detail', async () => {
  const row = makeRow({ text: '   ' });
  const store = makeStore([row]);

  const summary = await run(store);

  assert.equal(summary.by_reason['oversize'], 1);
  assert.equal(row.metadata['rumen']['check'], 'empty-after-redaction');
});

test('gate 2: CLI source_agent rejects as invalid-source-agent (web never impersonates CLI)', async () => {
  const rows = [makeRow({ source_agent: 'grok' }), makeRow({ source_agent: 'claude' })];
  const store = makeStore(rows);

  const summary = await run(store);

  assert.equal(summary.rejected, 2);
  assert.equal(summary.by_reason['invalid-source-agent'], 2);
  for (const row of rows) {
    assert.equal(row.rejection_reason, 'invalid-source-agent');
  }
  assert.equal(store.memoryItems.length, 0);
});

test('gate 3: row over the 24h per-connector cap is DEFERRED — pending, no attempts, no rejection', async () => {
  const promoted = Array.from({ length: 50 }, (_, i) =>
    makeRow({
      id: 'old-' + i,
      status: 'promoted',
      promoted_memory_id: 'mem-old-' + i,
      metadata: { rumen: { promoted_at: new Date().toISOString() } },
    }),
  );
  const fiftyFirst = makeRow({ id: 'inbox-51st' });
  const store = makeStore([...promoted, fiftyFirst]);

  const summary = await run(store);

  assert.equal(summary.deferred, 1);
  assert.equal(summary.promoted, 0);
  assert.equal(summary.rejected, 0);
  assert.equal(fiftyFirst.status, 'pending', '51st same-connector row in 24h stays pending');
  assert.equal(fiftyFirst.rejection_reason, null);
  assert.equal(fiftyFirst.metadata['rumen']['attempts'], undefined, 'patience is not a crime');
});

test('gate 3: in-batch cap accounting — cap 2 over 3 clean rows promotes 2, defers 1', async () => {
  const rows = [
    makeRow({ id: 'r1', created_at: '2026-06-12T10:00:00Z' }),
    makeRow({ id: 'r2', created_at: '2026-06-12T10:01:00Z' }),
    makeRow({ id: 'r3', created_at: '2026-06-12T10:02:00Z' }),
  ];
  const store = makeStore(rows);

  const summary = await run(store, makeDeps(), { rateCap24h: 2 });

  assert.equal(summary.promoted, 2);
  assert.equal(summary.deferred, 1);
  assert.equal(rows[0]!.status, 'promoted');
  assert.equal(rows[1]!.status, 'promoted');
  assert.equal(rows[2]!.status, 'pending', 'FIFO: the newest row is the one deferred');
});

test('gate 4: similarity > 0.95 rejects as duplicate with the matched id stamped', async () => {
  const row = makeRow({});
  const store = makeStore([row], [{ id: 'canon-1', similarity: 0.97 }]);

  const summary = await run(store);

  assert.equal(summary.by_reason['duplicate'], 1);
  assert.equal(row.rejection_reason, 'duplicate');
  assert.equal(row.metadata['rumen']['matched_memory_id'], 'canon-1');
  assert.equal(row.metadata['rumen']['matched_similarity'], 0.97);
  assert.equal(store.memoryItems.length, 0);
});

test('gate 4: the 0.88–0.95 band rejects as near-duplicate and NEVER mutates the canonical row', async () => {
  const row = makeRow({});
  const store = makeStore([row], [{ id: 'canon-2', similarity: 0.91 }]);

  const summary = await run(store);

  assert.equal(summary.by_reason['near-duplicate'], 1);
  assert.equal(row.rejection_reason, 'near-duplicate');
  assert.equal(row.metadata['rumen']['matched_memory_id'], 'canon-2', 'recorded for a later human/UI merge');

  // The canonical store is untouched: no UPDATE memory_items (remember.ts's
  // in-place near-dup update is deliberately NOT reproduced for web content),
  // and no INSERT either.
  assert.ok(
    store.calls.every((c) => !/UPDATE\s+memory_items/i.test(c.sql)),
    'no UPDATE against memory_items, ever',
  );
  assert.equal(store.memoryItems.length, 0);
});

test('gate 4: similarity exactly 0.95 is near-duplicate (remember.ts uses strictly-greater for skip)', async () => {
  const row = makeRow({});
  const store = makeStore([row], [{ id: 'canon-3', similarity: 0.95 }]);

  const summary = await run(store);

  assert.equal(summary.by_reason['near-duplicate'], 1);
});

test('gate 5: recipe verdict rejects as recipe-level with the rationale stored', async () => {
  const row = makeRow({ text: 'Fixed bug X in file Y line 42 during sprint 12.' });
  const store = makeStore([row]);

  const summary = await run(store, makeDeps({ anthropicText: RECIPE_JSON }));

  assert.equal(summary.by_reason['recipe-level'], 1);
  assert.equal(row.rejection_reason, 'recipe-level');
  assert.equal(row.metadata['rumen']['kitchen_rationale'], 'names a file:line fixed in one sprint');
  assert.equal(store.memoryItems.length, 0);
});

// ---------------------------------------------------------------------------
// Fail-soft / fail-closed
// ---------------------------------------------------------------------------

test('gate 5 fails CLOSED: unparseable LLM verdict leaves the row pending with one attempt burned', async () => {
  const row = makeRow({});
  const store = makeStore([row]);

  const summary = await run(store, makeDeps({ anthropicText: 'sorry, no JSON today' }));

  assert.equal(summary.failed, 1);
  assert.equal(summary.promoted, 0, 'never auto-promote on classifier failure');
  assert.equal(row.status, 'pending');
  assert.equal(row.metadata['rumen']['attempts'], 1);
  assert.equal(store.memoryItems.length, 0);
});

test('embed failure is isolated per row: the bad row stays pending, the batch continues', async () => {
  const bad = makeRow({ id: 'bad', text: 'embed me not', created_at: '2026-06-12T10:00:00Z' });
  const good = makeRow({ id: 'good', created_at: '2026-06-12T10:01:00Z' });
  const store = makeStore([bad, good]);
  const deps = makeDeps({
    embed: async (text) => (text === 'embed me not' ? null : [0.1, 0.2, 0.3]),
  });

  const summary = await run(store, deps);

  assert.equal(summary.failed, 1);
  assert.equal(summary.promoted, 1);
  assert.equal(bad.status, 'pending');
  assert.equal(bad.metadata['rumen']['attempts'], 1);
  assert.equal(bad.metadata['rumen']['last_error'], 'embedding-unavailable');
  assert.equal(good.status, 'promoted');
});

test('a row crossing max attempts rejects as attempts-exhausted', async () => {
  const row = makeRow({ metadata: { rumen: { attempts: 4 } } });
  const store = makeStore([row]);
  const deps = makeDeps({ embed: async () => null });

  const summary = await run(store, deps);

  assert.equal(summary.rejected, 1);
  assert.equal(summary.by_reason['attempts-exhausted'], 1);
  assert.equal(row.status, 'rejected');
  assert.equal(row.rejection_reason, 'attempts-exhausted');
  assert.equal(row.metadata['rumen']['attempts'], 5);
});

test('missing OPENAI_API_KEY skips the pass entirely — zero claims, zero mutations', async () => {
  const store = makeStore([makeRow({})]);
  const pool = makeInboxPool(store);

  const summary = await quiet(() => promoteInbox(pool));

  assert.equal(summary.skipped_reason, 'missing-openai-key');
  assert.equal(summary.claimed, 0);
  assert.equal(store.calls.length, 0, 'no SQL issued at all');
  assert.equal(store.inbox[0]!.status, 'pending');
});

test('missing ANTHROPIC_API_KEY (with OpenAI present) also skips the pass', async () => {
  process.env['OPENAI_API_KEY'] = 'test-openai-key';
  try {
    const store = makeStore([makeRow({})]);
    const pool = makeInboxPool(store);

    const summary = await quiet(() => promoteInbox(pool));

    assert.equal(summary.skipped_reason, 'missing-anthropic-key');
    assert.equal(store.calls.length, 0);
  } finally {
    delete process.env['OPENAI_API_KEY'];
  }
});

// ---------------------------------------------------------------------------
// Idempotency, claim shape, CAS race
// ---------------------------------------------------------------------------

test('idempotency: a second run over the same processed inbox is a no-op', async () => {
  const rows = [
    makeRow({ id: 'clean', created_at: '2026-06-12T10:00:00Z' }),
    makeRow({ id: 'cli', source_agent: 'grok', created_at: '2026-06-12T10:01:00Z' }),
    makeRow({ id: 'big', text: 'b'.repeat(4001), created_at: '2026-06-12T10:02:00Z' }),
  ];
  const store = makeStore(rows);

  const first = await run(store);
  assert.equal(first.claimed, 3);
  assert.equal(first.promoted, 1);
  assert.equal(first.rejected, 2);

  const statusesAfterFirst = rows.map((r) => r.status + ':' + (r.rejection_reason ?? ''));
  const itemCountAfterFirst = store.memoryItems.length;

  const second = await run(store);
  assert.equal(second.claimed, 0, 'second run claims nothing');
  assert.equal(second.promoted, 0);
  assert.equal(second.rejected, 0);
  assert.equal(store.memoryItems.length, itemCountAfterFirst, 'no double insert');
  assert.deepEqual(
    rows.map((r) => r.status + ':' + (r.rejection_reason ?? '')),
    statusesAfterFirst,
    'no status churn',
  );
});

test('claim statement shape: SKIP LOCKED, FIFO order, batch limit, lease filter', async () => {
  const store = makeStore([makeRow({})]);
  await run(store);

  const claim = store.calls.find((c) => c.sql.includes('FOR UPDATE SKIP LOCKED'));
  assert.ok(claim, 'expected a claim call');
  assert.match(claim!.sql, /ORDER BY created_at ASC/);
  assert.match(claim!.sql, /LIMIT \$1/);
  assert.match(claim!.sql, /last_claimed_at/);
  assert.match(claim!.sql, /status = 'pending'/);
  assert.equal(claim!.params[0], 25, 'default batch size');
  assert.equal(claim!.params[1], 10, 'default lease minutes');
});

test('a fresh claim stamp inside the lease window blocks immediate re-claim', async () => {
  // A row that fails (stays pending) is NOT re-claimable by an immediately
  // following pass — its lease must expire first.
  const row = makeRow({});
  const store = makeStore([row]);
  const failingDeps = makeDeps({ embed: async () => null });

  const first = await run(store, failingDeps);
  assert.equal(first.failed, 1);
  assert.equal(row.status, 'pending');

  const second = await run(store, failingDeps);
  assert.equal(second.claimed, 0, 'leased row is skipped by the next pass');
  assert.equal(row.metadata['rumen']['attempts'], 1, 'no second attempt burned inside the lease');
});

test('CAS race: a row terminalized between claim and promote rolls the insert back (lost-race)', async () => {
  const row = makeRow({});
  const store = makeStore([row]);
  // Simulate a competing pass finishing the row right after our claim lands.
  store.afterClaim = () => {
    row.status = 'rejected';
    row.rejection_reason = 'recipe-level';
  };

  const summary = await run(store);

  assert.equal(summary.lost_race, 1);
  assert.equal(summary.promoted, 0);
  assert.equal(store.memoryItems.length, 0, 'memory_items insert rolled back');
  assert.ok(store.txLog.includes('ROLLBACK'));
  assert.equal(row.rejection_reason, 'recipe-level', 'the competing outcome stands');
});

// ---------------------------------------------------------------------------
// Vocabulary + redaction unit checks
// ---------------------------------------------------------------------------

test('exported rejection_reason vocabulary is exactly the audited six (rate-capped is defer-only)', () => {
  assert.deepEqual(
    [...REJECTION_REASONS],
    ['oversize', 'invalid-source-agent', 'duplicate', 'near-duplicate', 'recipe-level', 'attempts-exhausted'],
  );
  assert.deepEqual(
    [...WEB_SOURCE_AGENTS],
    ['claude-web', 'chatgpt-web', 'grok-web', 'gemini-web'],
  );
});

test('stripPrivate: closed block redacts, unclosed is literal, nesting collapses (engram parity)', () => {
  assert.deepEqual(stripPrivate('keep <private>secret</private> this'), {
    text: 'keep [redacted] this',
    hadPrivate: true,
  });
  assert.deepEqual(stripPrivate('typo <private> rest stays'), {
    text: 'typo <private> rest stays',
    hadPrivate: false,
  });
  assert.deepEqual(
    stripPrivate('a <PRIVATE data-x="1">outer <private>inner</private> tail</private> z'),
    { text: 'a [redacted] z', hadPrivate: true },
  );
  assert.deepEqual(stripPrivate('no tags at all'), { text: 'no tags at all', hadPrivate: false });
});

test('private blocks are stripped before embedding and storage', async () => {
  const row = makeRow({
    text: 'Pooler URLs need pgbouncer=true. <private>pw: hunter2</private> Applies everywhere.',
  });
  const store = makeStore([row]);
  const seenByEmbed: string[] = [];
  const deps = makeDeps({
    embed: async (text) => {
      seenByEmbed.push(text);
      return [0.1, 0.2, 0.3];
    },
  });

  const summary = await run(store, deps);

  assert.equal(summary.promoted, 1);
  assert.ok(!seenByEmbed[0]!.includes('hunter2'), 'private content never reaches the embedder');
  const [content, , , , metadataJson] = store.memoryItems[0]!.params as string[];
  assert.ok(!content.includes('hunter2'));
  assert.ok(content.includes('[redacted]'));
  assert.equal(JSON.parse(metadataJson).had_private_content, true);
});

test('insane project_hint falls back to global', async () => {
  const rows = [
    makeRow({ id: 'p1', project_hint: '   ', created_at: '2026-06-12T10:00:00Z' }),
    makeRow({ id: 'p2', project_hint: 'x'.repeat(129), created_at: '2026-06-12T10:01:00Z' }),
  ];
  const store = makeStore(rows);

  const summary = await run(store);

  assert.equal(summary.promoted, 2);
  for (const item of store.memoryItems) {
    assert.equal(item.params[3], 'global');
  }
});

// ---------------------------------------------------------------------------
// Real-Postgres SKIP LOCKED disjointness — the one claim-semantics property
// the fake cannot prove. Uses the claim statement from
// src/promote.ts::claimBatch (table name parameterized) — keep in lockstep.
//
// SAFETY (incident-derived, 2026-06-12): this test runs ONLY when
// RUMEN_TEST_DATABASE_URL is EXPLICITLY set — never off ambient DATABASE_URL,
// which on dev machines routinely points at a live daily-driver project.
// It also creates its OWN uniquely-named scratch table and drops it in
// finally, so even a mis-pointed RUMEN_TEST_DATABASE_URL can never touch a
// real memory_inbox or leave a stray RLS-less table behind.
// ---------------------------------------------------------------------------

const TEST_DB_URL = process.env['RUMEN_TEST_DATABASE_URL'];

test(
  'real PG: two concurrent claims never take the same row (FOR UPDATE SKIP LOCKED)',
  { skip: !TEST_DB_URL ? 'RUMEN_TEST_DATABASE_URL not set (explicit opt-in)' : false },
  async () => {
    const { default: pg } = await import('pg');
    const table = 'rumen_skiplocked_test_' + Date.now() + '_' + process.pid;
    const poolA = new pg.Pool({ connectionString: TEST_DB_URL, max: 1 });
    const poolB = new pg.Pool({ connectionString: TEST_DB_URL, max: 1 });

    // src/promote.ts::claimBatch verbatim, with the scratch table name in
    // place of memory_inbox (identifier built from [a-z0-9_] only).
    const CLAIM_SQL = `
      UPDATE ${table}
      SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
        'rumen',
        COALESCE(metadata -> 'rumen', '{}'::jsonb) || jsonb_build_object(
          'last_claimed_at', NOW(),
          'run_id', $3::text
        )
      )
      WHERE id IN (
        SELECT id
        FROM ${table}
        WHERE status = 'pending'
          AND (
            metadata #>> '{rumen,last_claimed_at}' IS NULL
            OR (metadata #>> '{rumen,last_claimed_at}')::timestamptz
               < NOW() - make_interval(mins => $2::int)
          )
        ORDER BY created_at ASC
        LIMIT $1::int
        FOR UPDATE SKIP LOCKED
      )
      RETURNING id
    `;

    try {
      await poolA.query(`
        CREATE TABLE ${table} (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          source_agent TEXT NOT NULL,
          project_hint TEXT,
          text TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending',
          promoted_memory_id UUID,
          rejection_reason TEXT,
          metadata JSONB NOT NULL DEFAULT '{}'::jsonb
        )
      `);
      for (let i = 0; i < 10; i++) {
        await poolA.query(
          `INSERT INTO ${table} (source_agent, text) VALUES ('claude-web', $1)`,
          ['row ' + i],
        );
      }

      const [a, b] = await Promise.all([
        poolA.query(CLAIM_SQL, [5, 10, 'run-a']),
        poolB.query(CLAIM_SQL, [5, 10, 'run-b']),
      ]);

      const idsA = a.rows.map((r: { id: string }) => r.id);
      const idsB = b.rows.map((r: { id: string }) => r.id);
      const overlap = idsA.filter((id: string) => idsB.includes(id));

      assert.equal(overlap.length, 0, 'claims must be disjoint');
      assert.equal(idsA.length + idsB.length, 10, 'every row claimed exactly once');
    } finally {
      try {
        await poolA.query(`DROP TABLE IF EXISTS ${table}`);
      } catch {
        /* best-effort cleanup */
      }
      await poolA.end();
      await poolB.end();
    }
  },
);
