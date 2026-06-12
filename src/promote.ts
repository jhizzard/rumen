/**
 * Rumen v0.6 — Promotion pass (Sprint 76 "Memory Inbox").
 *
 * Web-chat surfaces (claude.ai / ChatGPT / Grok / Gemini) write PROPOSALS into
 * Mnestra's `memory_inbox` table (engram migration 026) via the bridge's
 * `memory_propose` channel. Pending rows are invisible to every recall path.
 * This pass is the customs check: it drains the inbox asynchronously and
 * either PROMOTES a proposal into `memory_items` (canonical-path semantics,
 * provenance preserved) or REJECTS it with an audit trail. Policy:
 * "CLIs write canonical; web chats write proposals."
 *
 * DOCTRINE AMENDMENT (deliberate, narrow — Sprint 76): Rumen's v0.x
 * non-destructive rule said "only INSERT into rumen_* tables". This pass
 *   - INSERTs new rows into `memory_items` (the whole point of promotion), and
 *   - UPDATEs ONLY `memory_inbox` status/metadata fields on rows it claimed.
 * It still NEVER modifies or deletes existing memory rows — no UPDATE or
 * DELETE ever targets `memory_items`, `memory_sessions` (beyond the
 * Sprint 53 `rumen_processed_at` stamp owned by index.ts), or any other
 * Mnestra table. See docs/MNESTRA-COMPATIBILITY.md § What Rumen writes.
 *
 * Canonical-write semantics reproduced from engram `src/remember.ts`
 * (edge functions cannot reach the localhost webhook, so the semantics are
 * reproduced here directly):
 *   - embed with text-embedding-3-large @ dimensions:1536 (relate.ts path);
 *   - dedup via `match_memories(query_embedding, 0.88, 3, filter_project)`;
 *   - top similarity > 0.95  → content already canonical → reject 'duplicate';
 *   - any other match ≥ 0.88 → reject 'near-duplicate'. remember.ts updates
 *     the near-dup in place; this pass DELIBERATELY does not — web-originated
 *     content must never mutate a canonical row. The matched id is recorded
 *     in metadata for a later human/UI merge.
 *   - `<private>…</private>` blocks are stripped BEFORE any embedding or
 *     storage (ported from engram src/privacy.ts), same order as remember.ts.
 *
 * Further deliberate divergences from remember.ts (fail-closed posture):
 *   - a `match_memories` RPC error leaves the row pending (+1 attempt)
 *     instead of falling through to INSERT — the customs check must not
 *     fail open on its dedup gate;
 *   - text empty after redaction rejects as 'oversize' (detail in
 *     metadata.rumen.check) instead of a silent 'skipped' — inbox rows need
 *     a terminal audit state.
 *
 * Concurrency / idempotency:
 *   - claim is one single-statement UPDATE … WHERE id IN (SELECT … FOR
 *     UPDATE SKIP LOCKED) RETURNING * — statement-level atomic, safe under
 *     simultaneous passes;
 *   - a claim lease (metadata.rumen.last_claimed_at, default 10 min) keeps
 *     overlapping passes off rows another pass is still processing;
 *   - correctness does NOT rest on the lease: every terminal write is a
 *     compare-and-set (WHERE id = $1 AND status = 'pending'), and the
 *     promote CAS rides the SAME transaction as the memory_items INSERT —
 *     0 rows updated → ROLLBACK, the insert vanishes. Exactly-once
 *     promotion, and a crash never yields a promoted memory with a pending
 *     inbox row nor the reverse.
 *   - expensive calls (embedding, Haiku) run OUTSIDE any transaction —
 *     transaction-mode pgbouncer friendly, no idle-in-transaction exposure.
 *
 * Fail-soft, per row: error paths increment metadata.rumen.attempts and
 * leave the row pending; attempts ≥ RUMEN_PROMOTE_MAX_ATTEMPTS reject as
 * 'attempts-exhausted'. The pass never throws on row-level failures.
 * Missing OPENAI_API_KEY / ANTHROPIC_API_KEY skips the pass entirely
 * (zero claims) — config absence must not burn attempts across the inbox.
 */

import Anthropic from '@anthropic-ai/sdk';

import type { PgPool } from './db.js';
import { withClient } from './db.js';
import { generateEmbedding, formatVectorLiteral } from './relate.js';
import { tryParseInsight } from './synthesize.js';
import type { AnthropicLike, AnthropicMessageResponse } from './synthesize.js';

/** The four web-surface trust-domain values — the ONLY promotable agents. */
export const WEB_SOURCE_AGENTS = [
  'claude-web',
  'chatgpt-web',
  'grok-web',
  'gemini-web',
] as const;

/**
 * Stable rejection_reason vocabulary. Auditors and any future inbox UI key
 * off these exact strings — extend, never rename. Note 'rate-capped' is
 * deliberately ABSENT: over-cap rows are deferred (stay pending), never
 * rejected. Being patient is not a crime.
 */
export const REJECTION_REASONS = [
  'oversize',
  'invalid-source-agent',
  'duplicate',
  'near-duplicate',
  'recipe-level',
  'attempts-exhausted',
] as const;
export type RejectionReason = (typeof REJECTION_REASONS)[number];

/** Mnestra SourceType union (engram src/types.ts). Haiku may suggest one;
 *  anything outside this set falls back to 'fact'. */
const KNOWN_SOURCE_TYPES = new Set([
  'fact',
  'decision',
  'preference',
  'bug_fix',
  'architecture',
  'code_context',
]);

// Same thresholds as engram remember.ts — the canonical dedup contract.
const DEDUP_SIMILARITY_THRESHOLD = 0.88;
const DEDUP_EXACT_SKIP_THRESHOLD = 0.95;
const DEDUP_MATCH_COUNT = 3;

// T1's binding caps (engram migration 026 / memory_propose RPC). Re-checked
// here because the DB-side pass is the only gate a future writer can't
// bypass. Belt-and-suspenders, not redundancy theater.
const MAX_TEXT_CHARS = 4000;
const MAX_PROJECT_HINT_CHARS = 128;
const MAX_METADATA_SERIALIZED_CHARS = 8192;

const DEFAULT_BATCH = 25;
const DEFAULT_RATE_CAP_24H = 50;
const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_CLAIM_LEASE_MINUTES = 10;

const DEFAULT_KITCHEN_MODEL = 'claude-haiku-4-5-20251001';
const KITCHEN_MAX_TOKENS = 250;

const KITCHEN_SYSTEM_PROMPT =
  'You are the promotion gate for a developer memory store. Web-chat surfaces ' +
  'propose memories; you classify each proposal as KITCHEN-level (a durable, ' +
  'transferable principle worth canonical storage) or RECIPE-level (a ' +
  'moment-bound specific that belongs in git history, not long-term memory). ' +
  'Apply these four tests: ' +
  '(1) Would it still be true if the codebase were rewritten? yes leans kitchen. ' +
  '(2) Would it apply to a different project? yes leans kitchen. ' +
  '(3) Could the user grep their git log to find it? yes leans recipe. ' +
  '(4) Does it name a specific file:line or version number? yes leans recipe. ' +
  'Respond with a single JSON object and no prose outside it, exactly: ' +
  '{"verdict": "kitchen" | "recipe", "rationale": "<one short line>", ' +
  '"suggested_source_type": "fact" | "decision" | "preference"}. ' +
  'suggested_source_type is optional — include it only when confident.';

export interface PromoteOptions {
  /** Rows claimed per run. Default RUMEN_PROMOTE_BATCH env, then 25. */
  batchSize?: number;
  /** Max promotions per source_agent per 24 h. Default RUMEN_PROMOTE_RATE_CAP_24H env, then 50. */
  rateCap24h?: number;
  /** Failures before a row rejects as attempts-exhausted. Default RUMEN_PROMOTE_MAX_ATTEMPTS env, then 5. */
  maxAttempts?: number;
  /** Minutes a claim stamp keeps other passes off a row. Default RUMEN_PROMOTE_CLAIM_LEASE_MINUTES env, then 10. */
  claimLeaseMinutes?: number;
}

export interface PromoteDeps {
  /** Override the embedding generator (tests bypass the OpenAI call). */
  generateEmbedding?: (text: string) => Promise<number[] | null>;
  /** Override the Anthropic client (tests inject a fake). */
  anthropic?: AnthropicLike;
}

/** Subset of an engram migration-026 memory_inbox row the pass consumes. */
export interface MemoryInboxRow {
  id: string;
  created_at: string;
  source_agent: string | null;
  project_hint: string | null;
  text: string | null;
  status: string;
  metadata: Record<string, unknown> | null;
}

export interface PromoteSummary {
  claimed: number;
  promoted: number;
  rejected: number;
  /** Rate-capped rows left pending for a later pass (no attempts burned). */
  deferred: number;
  /** Row-level failures left pending with attempts incremented. */
  failed: number;
  /** Rows another pass terminalized between our claim and our CAS write. */
  lost_race: number;
  by_reason: Record<string, number>;
  /** Set when the pass ran zero rows for a config-level reason. */
  skipped_reason: string | null;
}

type RowOutcome =
  | { kind: 'promoted'; sourceAgent: string }
  | { kind: 'rejected'; reason: RejectionReason }
  | { kind: 'deferred' }
  | { kind: 'failed'; error: string }
  | { kind: 'lost-race' };

/**
 * Run one promotion pass: claim up to batchSize pending inbox rows, walk
 * the gate sequence per row, promote or reject each, return a summary.
 * Never throws on row-level failures; throws only on claim-level
 * infrastructure errors (connection dead, table missing).
 */
export async function promoteInbox(
  pool: PgPool,
  options: PromoteOptions = {},
  deps: PromoteDeps = {},
): Promise<PromoteSummary> {
  const batchSize = options.batchSize ?? readIntEnv('RUMEN_PROMOTE_BATCH', DEFAULT_BATCH);
  const rateCap24h =
    options.rateCap24h ?? readIntEnv('RUMEN_PROMOTE_RATE_CAP_24H', DEFAULT_RATE_CAP_24H);
  const maxAttempts =
    options.maxAttempts ?? readIntEnv('RUMEN_PROMOTE_MAX_ATTEMPTS', DEFAULT_MAX_ATTEMPTS);
  const claimLeaseMinutes =
    options.claimLeaseMinutes ??
    readIntEnv('RUMEN_PROMOTE_CLAIM_LEASE_MINUTES', DEFAULT_CLAIM_LEASE_MINUTES);

  const summary: PromoteSummary = {
    claimed: 0,
    promoted: 0,
    rejected: 0,
    deferred: 0,
    failed: 0,
    lost_race: 0,
    by_reason: {},
    skipped_reason: null,
  };

  // Precondition: BOTH model surfaces must be reachable before we claim a
  // single row. Config absence is not a row failure — claiming without keys
  // would burn metadata.rumen.attempts across the whole inbox and
  // mass-reject it as attempts-exhausted within maxAttempts passes.
  const openaiKey = process.env['OPENAI_API_KEY'] ?? '';
  const anthropicKey = process.env['ANTHROPIC_API_KEY'] ?? '';
  if (!deps.generateEmbedding && openaiKey.length === 0) {
    console.warn(
      '[rumen-promote] OPENAI_API_KEY not set — skipping pass (dedup gate needs real ' +
        'embeddings; keyword-only is not acceptable for canonical writes). Inbox rows stay pending.',
    );
    summary.skipped_reason = 'missing-openai-key';
    return summary;
  }
  if (!deps.anthropic && anthropicKey.length === 0) {
    console.warn(
      '[rumen-promote] ANTHROPIC_API_KEY not set — skipping pass (kitchen-vs-recipe gate ' +
        'fails closed without a classifier). Inbox rows stay pending.',
    );
    summary.skipped_reason = 'missing-anthropic-key';
    return summary;
  }

  const runId = globalThis.crypto.randomUUID();
  console.log(
    '[rumen-promote] starting run ' +
      runId +
      ': batch=' +
      batchSize +
      ' rateCap24h=' +
      rateCap24h +
      ' maxAttempts=' +
      maxAttempts +
      ' leaseMinutes=' +
      claimLeaseMinutes,
  );

  const claimed = await claimBatch(pool, batchSize, claimLeaseMinutes, runId);
  summary.claimed = claimed.length;
  if (claimed.length === 0) {
    console.log('[rumen-promote] run ' + runId + ': inbox empty (or all leased) — nothing to do');
    return summary;
  }

  // Durable per-connector accounting: promotions stamped by ANY pass in the
  // trailing 24 h window. If this read fails we abort BEFORE processing —
  // a rate gate must not fail open. Claimed rows keep their lease and are
  // re-claimed after it expires; no attempts are burned.
  let promotedInWindow: Map<string, number>;
  try {
    promotedInWindow = await fetchPromotedCounts(pool);
  } catch (err) {
    console.error('[rumen-promote] run ' + runId + ': rate-cap accounting query failed:', err);
    summary.skipped_reason = 'rate-accounting-failed';
    return summary;
  }

  const embed =
    deps.generateEmbedding ?? ((text: string) => generateEmbedding(text, openaiKey));
  // Lazy so a batch that rejects every row on cheap gates never builds a client.
  let anthropic: AnthropicLike | null = deps.anthropic ?? null;
  const getAnthropic = (): AnthropicLike => {
    if (!anthropic) {
      anthropic = new Anthropic({ apiKey: anthropicKey }) as unknown as AnthropicLike;
    }
    return anthropic;
  };

  for (const row of claimed) {
    let outcome: RowOutcome;
    try {
      outcome = await processRow(pool, row, {
        rateCap24h,
        promotedInWindow,
        embed,
        getAnthropic,
        runId,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      outcome = { kind: 'failed', error: message };
    }

    switch (outcome.kind) {
      case 'promoted':
        summary.promoted += 1;
        promotedInWindow.set(
          outcome.sourceAgent,
          (promotedInWindow.get(outcome.sourceAgent) ?? 0) + 1,
        );
        break;
      case 'rejected':
        summary.rejected += 1;
        summary.by_reason[outcome.reason] = (summary.by_reason[outcome.reason] ?? 0) + 1;
        break;
      case 'deferred':
        summary.deferred += 1;
        break;
      case 'lost-race':
        summary.lost_race += 1;
        break;
      case 'failed': {
        console.error(
          '[rumen-promote] row ' + row.id + ' failed (stays pending): ' + outcome.error,
        );
        const exhausted = await markFailure(pool, row.id, maxAttempts, outcome.error, runId);
        if (exhausted) {
          summary.rejected += 1;
          summary.by_reason['attempts-exhausted'] =
            (summary.by_reason['attempts-exhausted'] ?? 0) + 1;
        } else {
          summary.failed += 1;
        }
        break;
      }
    }
  }

  console.log(
    '[rumen-promote] run ' +
      runId +
      ' complete: claimed=' +
      summary.claimed +
      ' promoted=' +
      summary.promoted +
      ' rejected=' +
      summary.rejected +
      ' deferred=' +
      summary.deferred +
      ' failed=' +
      summary.failed +
      ' lostRace=' +
      summary.lost_race +
      ' byReason=' +
      JSON.stringify(summary.by_reason),
  );

  return summary;
}

interface ProcessContext {
  rateCap24h: number;
  promotedInWindow: Map<string, number>;
  embed: (text: string) => Promise<number[] | null>;
  getAnthropic: () => AnthropicLike;
  runId: string;
}

/**
 * Gate sequence for one claimed row, cheap → expensive. First failure
 * rejects with that gate's reason; rate-cap defers instead of rejecting.
 */
async function processRow(
  pool: PgPool,
  row: MemoryInboxRow,
  ctx: ProcessContext,
): Promise<RowOutcome> {
  // Gate 0 — privacy redaction BEFORE caps/embedding/storage, mirroring
  // remember.ts order: private content never reaches OpenAI, Anthropic,
  // or the canonical row.
  const { text: redacted, hadPrivate } = stripPrivate(String(row.text ?? ''));
  const content = redacted.trim();

  // Gate 1 — caps re-check ('oversize'); detail in metadata.rumen.check.
  if (content.length === 0) {
    return reject(pool, row, 'oversize', { check: 'empty-after-redaction' }, ctx.runId);
  }
  if (content.length > MAX_TEXT_CHARS) {
    return reject(
      pool,
      row,
      'oversize',
      { check: 'text-over-' + MAX_TEXT_CHARS, length: content.length },
      ctx.runId,
    );
  }
  const metadataSerialized = JSON.stringify(row.metadata ?? {});
  if (metadataSerialized.length > MAX_METADATA_SERIALIZED_CHARS) {
    return reject(
      pool,
      row,
      'oversize',
      { check: 'metadata-over-' + MAX_METADATA_SERIALIZED_CHARS, length: metadataSerialized.length },
      ctx.runId,
    );
  }

  // Gate 2 — source whitelist re-check ('invalid-source-agent'). Web
  // surfaces may never impersonate a CLI trust domain; CLI values and
  // unknowns are rejected even though T1's RPC already enforces this.
  const sourceAgent = String(row.source_agent ?? '').trim().toLowerCase();
  if (!(WEB_SOURCE_AGENTS as readonly string[]).includes(sourceAgent)) {
    return reject(
      pool,
      row,
      'invalid-source-agent',
      { source_agent_seen: String(row.source_agent ?? '').slice(0, 80) },
      ctx.runId,
    );
  }

  // Gate 3 — per-connector rate cap: DEFER, don't reject. No DB write at
  // all (the claim stamp already happened); no attempts burned. The row is
  // re-claimable after the lease expires.
  const usedInWindow = ctx.promotedInWindow.get(sourceAgent) ?? 0;
  if (usedInWindow >= ctx.rateCap24h) {
    console.log(
      '[rumen-promote] row ' +
        row.id +
        ' deferred: ' +
        sourceAgent +
        ' at 24h cap (' +
        usedInWindow +
        '/' +
        ctx.rateCap24h +
        ')',
    );
    return { kind: 'deferred' };
  }

  // Gate 4 — dedup vs canonical, remember.ts thresholds. Embed failure is
  // a row failure (pending + attempt), never a keyword fallback.
  const embedding = await ctx.embed(content);
  if (!embedding) {
    return { kind: 'failed', error: 'embedding-unavailable' };
  }
  const embeddingLiteral = formatVectorLiteral(embedding);
  const project = resolveProject(row.project_hint);

  const matches = await pool.query<{ id: string; similarity: unknown }>(
    `
      SELECT id, similarity
      FROM match_memories($1::vector, $2::double precision, $3::int, $4::text)
    `,
    [embeddingLiteral, DEDUP_SIMILARITY_THRESHOLD, DEDUP_MATCH_COUNT, project],
  );
  const top = matches.rows[0];
  if (top) {
    const similarity = Number(top.similarity);
    if (!Number.isFinite(similarity)) {
      return { kind: 'failed', error: 'match_memories returned non-numeric similarity' };
    }
    const detail = {
      matched_memory_id: top.id,
      matched_similarity: Math.round(similarity * 1000) / 1000,
    };
    if (similarity > DEDUP_EXACT_SKIP_THRESHOLD) {
      return reject(pool, row, 'duplicate', detail, ctx.runId);
    }
    // 0.88–0.95 band: remember.ts updates the canonical near-dup in place.
    // This pass NEVER does — web content must not mutate canonical rows.
    // The matched id is recorded so a human/UI can merge later.
    return reject(pool, row, 'near-duplicate', detail, ctx.runId);
  }

  // Gate 5 — kitchen-vs-recipe via Haiku. Fails CLOSED: recipe rejects;
  // unparseable / errored / unknown verdicts leave the row pending with an
  // attempt burned. Never auto-promote on classifier failure.
  const verdict = await classifyKitchenVsRecipe(ctx.getAnthropic(), content, project, sourceAgent);
  if (!verdict) {
    return { kind: 'failed', error: 'kitchen-verdict-unparseable' };
  }
  if (verdict.verdict === 'recipe') {
    return reject(
      pool,
      row,
      'recipe-level',
      { kitchen_rationale: verdict.rationale },
      ctx.runId,
    );
  }

  const sourceType =
    verdict.suggested_source_type && KNOWN_SOURCE_TYPES.has(verdict.suggested_source_type)
      ? verdict.suggested_source_type
      : 'fact';

  return promoteRow(pool, row, {
    content,
    embeddingLiteral,
    sourceType,
    project,
    sourceAgent,
    kitchenRationale: verdict.rationale,
    hadPrivate,
    runId: ctx.runId,
  });
}

/**
 * Claim a batch: one single-statement UPDATE (its own transaction).
 * FOR UPDATE SKIP LOCKED guards simultaneous passes; the lease filter
 * guards overlapping passes. Oldest first — FIFO, no starvation.
 */
async function claimBatch(
  pool: PgPool,
  batchSize: number,
  leaseMinutes: number,
  runId: string,
): Promise<MemoryInboxRow[]> {
  const res = await pool.query<MemoryInboxRow>(
    `
      UPDATE memory_inbox
      SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
        'rumen',
        COALESCE(metadata -> 'rumen', '{}'::jsonb) || jsonb_build_object(
          'last_claimed_at', NOW(),
          'run_id', $3::text
        )
      )
      WHERE id IN (
        SELECT id
        FROM memory_inbox
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
      RETURNING id, created_at, source_agent, project_hint, text, status, metadata
    `,
    [batchSize, leaseMinutes, runId],
  );
  return res.rows;
}

/** Promotions stamped by any pass in the trailing 24 h, per source_agent. */
async function fetchPromotedCounts(pool: PgPool): Promise<Map<string, number>> {
  const res = await pool.query<{ source_agent: string; promoted_count: number }>(
    `
      SELECT source_agent, COUNT(*)::int AS promoted_count
      FROM memory_inbox
      WHERE status = 'promoted'
        AND (metadata #>> '{rumen,promoted_at}') IS NOT NULL
        AND (metadata #>> '{rumen,promoted_at}')::timestamptz >= NOW() - INTERVAL '24 hours'
      GROUP BY source_agent
    `,
  );
  const out = new Map<string, number>();
  for (const r of res.rows) {
    out.set(r.source_agent, Number(r.promoted_count) || 0);
  }
  return out;
}

interface PromotePayload {
  content: string;
  embeddingLiteral: string;
  sourceType: string;
  project: string;
  sourceAgent: string;
  kitchenRationale: string;
  hadPrivate: boolean;
  runId: string;
}

/**
 * Atomic promote: INSERT into memory_items and CAS-stamp the inbox row in
 * ONE transaction on ONE pooled client (transaction-mode pgbouncer pins the
 * tx to a single server connection). CAS misses → ROLLBACK, insert vanishes.
 */
async function promoteRow(
  pool: PgPool,
  row: MemoryInboxRow,
  payload: PromotePayload,
): Promise<RowOutcome> {
  // Canonical-row provenance: the *-web source_agent rides through UNCHANGED
  // (provenance is the point — a promoted-then-regretted row stays
  // attributable and filterable forever). Connector metadata (incl. the
  // bridge's spoof-proof client stamp) passes through under
  // proposal_metadata; this pass's own bookkeeping (metadata.rumen) stays
  // on the inbox row, which is the audit trail.
  const proposalMetadata: Record<string, unknown> = { ...(row.metadata ?? {}) };
  delete proposalMetadata['rumen'];
  const itemMetadata: Record<string, unknown> = {
    inbox_id: row.id,
    promoted_by: 'rumen-promotion',
    promoted_at: new Date().toISOString(),
    kitchen_rationale: payload.kitchenRationale,
    proposal_metadata: proposalMetadata,
  };
  if (payload.hadPrivate) itemMetadata['had_private_content'] = true;

  return withClient(pool, async (client) => {
    await client.query('BEGIN');
    try {
      const ins = await client.query<{ id: string }>(
        `
          INSERT INTO memory_items
            (content, embedding, source_type, category, project, metadata, source_agent)
          VALUES ($1, $2::vector, $3, NULL, $4, $5::jsonb, $6)
          RETURNING id
        `,
        [
          payload.content,
          payload.embeddingLiteral,
          payload.sourceType,
          payload.project,
          JSON.stringify(itemMetadata),
          payload.sourceAgent,
        ],
      );
      const inserted = ins.rows[0];
      if (!inserted) {
        throw new Error('memory_items insert returned no id');
      }

      const upd = await client.query<{ id: string }>(
        `
          UPDATE memory_inbox
          SET status = 'promoted',
              promoted_memory_id = $2,
              metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
                'rumen',
                COALESCE(metadata -> 'rumen', '{}'::jsonb) || jsonb_build_object(
                  'promoted_at', NOW(),
                  'run_id', $3::text
                )
              )
          WHERE id = $1 AND status = 'pending'
          RETURNING id
        `,
        [row.id, inserted.id, payload.runId],
      );
      if (upd.rows.length === 0) {
        // Another pass terminalized this row after our claim (lease-expiry
        // race). Roll the insert back — their outcome stands, not ours.
        await client.query('ROLLBACK');
        console.warn('[rumen-promote] row ' + row.id + ' lost CAS race — insert rolled back');
        return { kind: 'lost-race' };
      }

      await client.query('COMMIT');
      console.log(
        '[rumen-promote] row ' +
          row.id +
          ' promoted -> memory_items ' +
          inserted.id +
          ' (agent=' +
          payload.sourceAgent +
          ' project=' +
          payload.project +
          ' source_type=' +
          payload.sourceType +
          ')',
      );
      return { kind: 'promoted', sourceAgent: payload.sourceAgent };
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackErr) {
        console.error('[rumen-promote] ROLLBACK failed for row ' + row.id + ':', rollbackErr);
      }
      throw err;
    }
  });
}

/** Terminal reject with CAS guard; detail lands under metadata.rumen. */
async function reject(
  pool: PgPool,
  row: MemoryInboxRow,
  reason: RejectionReason,
  detail: Record<string, unknown>,
  runId: string,
): Promise<RowOutcome> {
  const res = await pool.query<{ id: string }>(
    `
      UPDATE memory_inbox
      SET status = 'rejected',
          rejection_reason = $2,
          metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
            'rumen',
            COALESCE(metadata -> 'rumen', '{}'::jsonb) || $3::jsonb || jsonb_build_object(
              'rejected_at', NOW(),
              'run_id', $4::text
            )
          )
      WHERE id = $1 AND status = 'pending'
      RETURNING id
    `,
    [row.id, reason, JSON.stringify(detail), runId],
  );
  if (res.rows.length === 0) {
    console.warn('[rumen-promote] row ' + row.id + ' lost CAS race on reject');
    return { kind: 'lost-race' };
  }
  console.log('[rumen-promote] row ' + row.id + ' rejected: ' + reason);
  return { kind: 'rejected', reason };
}

/**
 * Row failure: attempts += 1 (computed in SQL — no read-modify-write race);
 * crossing maxAttempts flips the row to rejected/'attempts-exhausted' in the
 * same statement. Returns true when the row was exhausted-rejected.
 */
async function markFailure(
  pool: PgPool,
  rowId: string,
  maxAttempts: number,
  error: string,
  runId: string,
): Promise<boolean> {
  try {
    const res = await pool.query<{ status: string }>(
      `
        UPDATE memory_inbox
        SET status = CASE
              WHEN COALESCE((metadata #>> '{rumen,attempts}')::int, 0) + 1 >= $2::int
              THEN 'rejected' ELSE status END,
            rejection_reason = CASE
              WHEN COALESCE((metadata #>> '{rumen,attempts}')::int, 0) + 1 >= $2::int
              THEN 'attempts-exhausted' ELSE rejection_reason END,
            metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
              'rumen',
              COALESCE(metadata -> 'rumen', '{}'::jsonb) || jsonb_build_object(
                'attempts', COALESCE((metadata #>> '{rumen,attempts}')::int, 0) + 1,
                'last_error', LEFT($3::text, 500),
                'last_failed_at', NOW(),
                'run_id', $4::text
              )
            )
        WHERE id = $1 AND status = 'pending'
        RETURNING status
      `,
      [rowId, maxAttempts, error, runId],
    );
    const updated = res.rows[0];
    if (updated && updated.status === 'rejected') {
      console.warn('[rumen-promote] row ' + rowId + ' rejected: attempts-exhausted');
      return true;
    }
    return false;
  } catch (err) {
    // Even the failure-bookkeeping write can fail (connection blip). Log and
    // move on — the row stays pending and the lease expires naturally.
    console.error('[rumen-promote] failed to record failure for row ' + rowId + ':', err);
    return false;
  }
}

interface KitchenVerdict {
  verdict: 'kitchen' | 'recipe';
  rationale: string;
  suggested_source_type: string | null;
}

/**
 * One Haiku call per row (batch size bounds the budget). Reuses
 * synthesize.ts's tolerant three-pass JSON parser. Returns null on any
 * parse/shape failure — callers treat that as a row failure (fail closed).
 */
async function classifyKitchenVsRecipe(
  client: AnthropicLike,
  content: string,
  project: string,
  sourceAgent: string,
): Promise<KitchenVerdict | null> {
  const userPrompt =
    'Proposal from ' +
    sourceAgent +
    ' (claimed project: ' +
    project +
    '):\n\n' +
    content +
    '\n\nReturn the JSON verdict now.';

  const response = await client.messages.create({
    model: process.env['RUMEN_SYNTH_MODEL'] ?? DEFAULT_KITCHEN_MODEL,
    max_tokens: KITCHEN_MAX_TOKENS,
    system: KITCHEN_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userPrompt }],
  });

  const text = extractText(response);
  const parsed = tryParseInsight(text);
  if (typeof parsed !== 'object' || parsed === null) {
    console.warn('[rumen-promote] kitchen verdict unparseable: ' + text.slice(0, 120));
    return null;
  }
  const obj = parsed as {
    verdict?: unknown;
    rationale?: unknown;
    suggested_source_type?: unknown;
  };
  if (obj.verdict !== 'kitchen' && obj.verdict !== 'recipe') {
    console.warn('[rumen-promote] kitchen verdict missing/unknown — failing closed');
    return null;
  }
  return {
    verdict: obj.verdict,
    rationale:
      typeof obj.rationale === 'string' ? obj.rationale.trim().slice(0, 500) : '',
    suggested_source_type:
      typeof obj.suggested_source_type === 'string'
        ? obj.suggested_source_type.trim().toLowerCase()
        : null,
  };
}

/** project_hint is advisory (T1 contract): sane → used, else 'global'. */
function resolveProject(hint: string | null | undefined): string {
  if (typeof hint !== 'string') return 'global';
  const trimmed = hint.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_PROJECT_HINT_CHARS) return 'global';
  return trimmed;
}

function extractText(response: AnthropicMessageResponse): string {
  const parts: string[] = [];
  for (const block of response.content) {
    if (block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text);
    }
  }
  return parts.join('');
}

// ---------------------------------------------------------------------------
// <private>…</private> redaction — ported from engram src/privacy.ts so the
// promote path honors the same guarantee as remember.ts: private content is
// never embedded, stored, or sent to any downstream LLM. Semantics:
//   - a closed block becomes '[redacted]'; tags match case-insensitively,
//     span newlines, tolerate attributes on the opening tag;
//   - nested <private> blocks collapse into the single outer block;
//   - an UNCLOSED <private> is preserved verbatim (a typo must not silently
//     swallow the remainder of a valid memory).
// Keep in lockstep with engram src/privacy.ts if its semantics ever change.
// ---------------------------------------------------------------------------

const OPEN_TAG = /<private\b[^>]*>/gi;
const CLOSE_TAG = /<\/private\s*>/gi;

export interface StripPrivateResult {
  text: string;
  hadPrivate: boolean;
}

export function stripPrivate(text: string): StripPrivateResult {
  if (!text || text.indexOf('<') === -1) {
    return { text, hadPrivate: false };
  }

  let hadPrivate = false;
  let out = '';
  let i = 0;

  while (i < text.length) {
    OPEN_TAG.lastIndex = i;
    const open = OPEN_TAG.exec(text);
    if (!open) {
      out += text.slice(i);
      break;
    }

    out += text.slice(i, open.index);

    let depth = 1;
    let cursor = open.index + open[0].length;

    while (depth > 0 && cursor < text.length) {
      OPEN_TAG.lastIndex = cursor;
      CLOSE_TAG.lastIndex = cursor;
      const nextOpen = OPEN_TAG.exec(text);
      const nextClose = CLOSE_TAG.exec(text);

      if (!nextClose) {
        out += text.slice(open.index);
        return { text: out, hadPrivate };
      }

      if (nextOpen && nextOpen.index < nextClose.index) {
        depth++;
        cursor = nextOpen.index + nextOpen[0].length;
      } else {
        depth--;
        cursor = nextClose.index + nextClose[0].length;
      }
    }

    if (depth > 0) {
      // Ran off the end without closing — preserve verbatim.
      out += text.slice(open.index);
      return { text: out, hadPrivate };
    }

    out += '[redacted]';
    hadPrivate = true;
    i = cursor;
  }

  return { text: out, hadPrivate };
}

function readIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed <= 0) {
    console.error(
      '[rumen-promote] ' +
        name +
        '=' +
        raw +
        ' is not a positive integer; using default ' +
        fallback,
    );
    return fallback;
  }
  return parsed;
}
