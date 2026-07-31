/**
 * Rumen Sprint 84 (TermDeck T3) — write-time-extraction backstop sweep.
 *
 * Mnestra extracts a memory's entities and typed edges AT WRITE TIME
 * (`extract_write.ts`, Sprint 83). That path is the right place for the work —
 * it is where the semantic context exists and it is cheapest there. It also
 * only covers writes that go through that one function, and most of them do
 * not:
 *
 *   1. SQL-direct captures. `ingest_capture(jsonb)` (engram migration 030) is
 *      called by the pre-compact hook and the periodic-capture timer. There is
 *      no TypeScript anywhere in that path, so there is nothing to hook.
 *   2. The promotion pass. `promote.ts` INSERTs the canonical row itself,
 *      inside the promote transaction; nothing there calls extraction.
 *   3. Any writer whose process never received `MNESTRA_EXTRACT_ENABLED=1`.
 *      A flag reaches a process or it does not, and "did this process inherit
 *      the right env" is not a property anyone can see from the database.
 *
 * The first two are structural and no environment change can fix them. So the
 * backstop is not a workaround for a misconfiguration — it is the only layer
 * that can be complete, because it selects on the STATE of `memory_items` and
 * never on who wrote the row. Whatever the write path was, a memory with no
 * extraction ledger entry gets swept.
 *
 * ── WHY A SIBLING FUNCTION AND NOT A PHASE INSIDE THE TICK ───────────────
 *
 * One model call per item against `runRumenJob`'s 110s whole-job budget would
 * starve extract/relate/synthesize, and the symptom would present as "insights
 * stopped" — pointing at the wrong function entirely. Same reasoning, same
 * conclusion as `reinforce.ts`, `doctrine-scan.ts` and `graph-consolidation.ts`:
 * independent cadence, budget isolation, failure isolation. Every knob is
 * namespaced `RUMEN_SWEEP_*`, disjoint from every sibling's.
 *
 * ── WHAT THIS MAY AND MAY NOT WRITE ─────────────────────────────────────
 *
 * MAY:     insert entities + mentions (via `upsert_memory_entities`); insert
 *          `same_pattern_as` edges (via `upsert_memory_edges`); insert/update
 *          rows in its own `rumen_extraction_sweep` ledger.
 * MAY NOT: touch any column of any `memory_items` row. Not content, not
 *          metadata, not embedding, not tombstone state.
 *
 * That second line is why the ledger is a separate rumen-owned table rather
 * than a stamp in `memory_items.metadata`. Stamping the item would need a third
 * amendment to Rumen's "never modifies existing memory rows" rule (see
 * `index.ts` header); a rumen-namespaced ledger needs none, and it doubles as
 * the sweep's telemetry surface.
 *
 * ── VOCABULARY IS READ, NEVER TRANSCRIBED ───────────────────────────────
 *
 * Predicates and entity types are read live from `memory_relationship_types` /
 * `memory_entity_types`, and validation is the RPCs' job — both are
 * drop-invalid server-side (034 §§4/5), which is precisely what makes a second
 * caller safe. Unlike `extract_write.ts` this module carries NO fallback copy
 * of either list. That is deliberate and is the one place the two writers
 * differ: a fallback exists there to survive a pre-034 database mid-upgrade,
 * but here an unreadable vocabulary table means the RPCs do not exist either,
 * so falling back would only produce a confident call into a missing function.
 * Unreadable vocabulary is a skip with a reason, not a guess.
 */

import type { PgPool } from './db.js';
import type { AnthropicLike } from './synthesize.js';

const HAIKU_MODEL = 'claude-haiku-4-5-20251001';

/** The provenance stamp on every edge this module writes. */
export const SWEEP_INFERRED_BY = 'extract:sweep@1';

/**
 * Consolidation summaries are excluded from the sweep. A summary is by
 * construction near-identical to the memories it summarizes, so extracting its
 * entities would hang it off the same entity nodes as its own members — which
 * is the self-amplification loop `graph-consolidation.ts` documents at length
 * and defends against on the other side. The defense only holds if every
 * writer respects it.
 */
export const EXCLUDED_SOURCE_TYPES = ['consolidation_summary'] as const;

// ── defaults ────────────────────────────────────────────────────────────────

/** How far back to look for unswept memories. */
const DEFAULT_LOOKBACK_DAYS = 30;
/** Items considered per invocation. The budget usually cuts in first. */
const DEFAULT_BATCH = 150;
/** Whole-pass wall clock, under the Edge Function's 150s kill. */
const DEFAULT_BUDGET_MS = 110_000;
/** Per-item ceiling on the model call. Mirrors extract_write's budget. */
const DEFAULT_ITEM_BUDGET_MS = 8_000;
/** In-flight items. The pool is max:2, so this overlaps model calls, not SQL. */
const DEFAULT_CONCURRENCY = 4;
/** An item that keeps failing stops being retried at this many attempts. */
const DEFAULT_MAX_ATTEMPTS = 3;
/** Below this there is no meaningful structure to extract. Mirrors extract_write. */
const DEFAULT_MIN_CONTENT_CHARS = 80;
/** Ceiling on content handed to the model — cost control, not correctness. */
const MAX_CONTENT_CHARS = 12_000;
/** Caps on what one memory may produce. A runaway response is a budget leak. */
const MAX_ENTITIES = 12;
const MAX_TRIPLES = 12;
const MAX_SAME_PATTERN_EDGES = 5;

// ── types ───────────────────────────────────────────────────────────────────

export interface SweepOptions {
  lookbackDays?: number;
  batch?: number;
  budgetMs?: number;
  itemBudgetMs?: number;
  concurrency?: number;
  maxAttempts?: number;
  minContentChars?: number;
  /** Compute and report; write nothing at all — not even ledger rows. */
  dryRun?: boolean;
}

export interface SweepDeps {
  /** Injected in tests so no HTTP happens. Absent → the real SDK client. */
  anthropic?: AnthropicLike;
  now?: () => number;
}

export interface SweepCapabilities {
  /** `rumen_extraction_sweep` exists (rumen migration 007). */
  ledger: boolean;
  /** `upsert_memory_entities` + `upsert_memory_edges` exist (engram 034). */
  rpcs: boolean;
  /** Both vocabulary tables readable and non-empty. */
  vocabulary: boolean;
  detail: string;
}

export interface SweepSummary {
  ok: boolean;
  dry_run: boolean;
  capabilities: SweepCapabilities;
  /** Candidates the selection query returned. */
  candidates: number;
  /** Items the pass actually finished (success or recorded error). */
  processed: number;
  succeeded: number;
  failed: number;
  /** Candidates left untouched because the wall clock ran out. */
  skipped_budget: number;
  entities_written: number;
  mentions_written: number;
  same_pattern_edges: number;
  /**
   * SR-7 telemetry. Entity-to-entity triples are extracted but have nowhere to
   * live — `memory_relationships` is memory-to-memory on both columns, and 034
   * ships no entity-edge table. Counted here, never persisted; writing them
   * into some other column to look complete would be worse than not storing
   * them. This number is the evidence for or against building that table.
   */
  triples_found: number;
  /** A small sample of those triples, for the same decision. */
  triples_sample: ExtractedTriple[];
  /** Reported, not swallowed: a steady stream means the vocabulary is too narrow. */
  dropped_entity_types: number;
  dropped_predicates: string[];
  elapsed_ms: number;
  skipped_reason?: string;
  /** Per-item failures, capped. Fail-open: these never abort the pass. */
  errors: Array<{ memory_id: string; error: string }>;
}

export interface ExtractedEntity {
  name: string;
  type: string;
  span?: string | null;
  confidence?: number | null;
}

export interface ExtractedTriple {
  subject: string;
  predicate: string;
  object: string;
}

interface Candidate {
  id: string;
  content: string;
  project: string;
  problem_class: string | null;
}

// ── env helpers ─────────────────────────────────────────────────────────────

function readIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function readBoolEnv(name: string): boolean {
  return process.env[name] === '1';
}

// ── vocabulary ──────────────────────────────────────────────────────────────

/**
 * Read the live vocabulary. Returns empty sets when the tables are missing or
 * empty; the caller treats that as "skip the model half," never as "use a
 * built-in list" — see the header.
 */
async function loadVocabulary(
  pool: PgPool,
): Promise<{ predicates: string[]; entityTypes: string[] }> {
  try {
    const [preds, types] = await Promise.all([
      pool.query('select type from public.memory_relationship_types'),
      pool.query('select entity_type from public.memory_entity_types'),
    ]);
    return {
      predicates: (preds.rows as Array<{ type: string }>)
        .map((r) => r.type)
        .filter((v) => typeof v === 'string' && v.length > 0),
      entityTypes: (types.rows as Array<{ entity_type: string }>)
        .map((r) => r.entity_type)
        .filter((v) => typeof v === 'string' && v.length > 0),
    };
  } catch {
    return { predicates: [], entityTypes: [] };
  }
}

// ── capability probe ────────────────────────────────────────────────────────

export async function probeSweepCapabilities(pool: PgPool): Promise<SweepCapabilities> {
  const caps: SweepCapabilities = {
    ledger: false,
    rpcs: false,
    vocabulary: false,
    detail: '',
  };
  const notes: string[] = [];

  try {
    const r = await pool.query(
      `select to_regclass('public.rumen_extraction_sweep') is not null as present`,
    );
    caps.ledger = Boolean((r.rows[0] as { present?: boolean } | undefined)?.present);
  } catch (err) {
    notes.push(`ledger probe failed: ${(err as Error).message}`);
  }
  if (!caps.ledger) notes.push('rumen_extraction_sweep missing (apply rumen migration 007)');

  try {
    const r = await pool.query(
      `select
         to_regprocedure('public.upsert_memory_entities(uuid,jsonb)') is not null as ent,
         to_regprocedure('public.upsert_memory_edges(jsonb)')         is not null as edg`,
    );
    const row = r.rows[0] as { ent?: boolean; edg?: boolean } | undefined;
    caps.rpcs = Boolean(row?.ent && row?.edg);
  } catch (err) {
    notes.push(`rpc probe failed: ${(err as Error).message}`);
  }
  if (!caps.rpcs) notes.push('upsert_memory_entities/upsert_memory_edges missing (apply engram migration 034)');

  const vocab = await loadVocabulary(pool);
  caps.vocabulary = vocab.predicates.length > 0 && vocab.entityTypes.length > 0;
  if (!caps.vocabulary) notes.push('memory_relationship_types/memory_entity_types unreadable or empty');

  caps.detail = notes.length > 0 ? notes.join('; ') : 'all surfaces present';
  return caps;
}

// ── selection ───────────────────────────────────────────────────────────────

/**
 * Unswept (or retryable-failed) memories, newest first.
 *
 * Newest-first rather than oldest-first on purpose: the recall value of an
 * extracted memory decays, so if the pass can only get through part of the
 * backlog on a given night, the part worth having is the recent part. The
 * ledger makes the ordering safe — nothing is ever swept twice regardless of
 * which end the pass starts from.
 */
export async function selectCandidates(
  pool: PgPool,
  opts: {
    lookbackDays: number;
    batch: number;
    maxAttempts: number;
    minContentChars: number;
  },
): Promise<Candidate[]> {
  const { rows } = await pool.query(
    `select m.id::text                                    as id,
            m.content                                     as content,
            coalesce(m.project, '')                       as project,
            m.metadata->'problem_signature'->>'class'     as problem_class
       from public.memory_items m
       left join public.rumen_extraction_sweep s on s.memory_id = m.id
      where m.is_active = true
        and m.archived  = false
        and m.created_at > now() - make_interval(days => $1::int)
        and not (m.source_type = any($2::text[]))
        and length(btrim(coalesce(m.content, ''))) >= $3::int
        and (
              s.memory_id is null
           or (s.status = 'error' and s.attempts < $4::int)
        )
      order by m.created_at desc
      limit $5::int`,
    [
      opts.lookbackDays,
      [...EXCLUDED_SOURCE_TYPES],
      opts.minContentChars,
      opts.maxAttempts,
      opts.batch,
    ],
  );
  return rows as Candidate[];
}

// ── model half ──────────────────────────────────────────────────────────────

function stripFence(text: string): string {
  let s = text.trim();
  if (s.startsWith('```')) {
    s = s.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
  }
  if (!s.startsWith('{')) {
    const start = s.indexOf('{');
    const end = s.lastIndexOf('}');
    if (start !== -1 && end !== -1) s = s.slice(start, end + 1);
  }
  return s;
}

/**
 * Parse the model's JSON into entities + triples. Shape-checks only — the
 * vocabulary is not policed here (that is the RPCs' job, server-side). A
 * malformed response yields empty arrays rather than throwing: the caller
 * treats "nothing extracted" as a legitimate outcome, and it is.
 */
export function parseExtraction(text: string): {
  entities: ExtractedEntity[];
  triples: ExtractedTriple[];
} {
  let parsed: { entities?: unknown; triples?: unknown };
  try {
    parsed = JSON.parse(stripFence(text)) as { entities?: unknown; triples?: unknown };
  } catch {
    return { entities: [], triples: [] };
  }

  const entities: ExtractedEntity[] = [];
  if (Array.isArray(parsed.entities)) {
    for (const raw of parsed.entities) {
      const e = raw as Record<string, unknown>;
      const name = typeof e['name'] === 'string' ? (e['name'] as string).trim() : '';
      const type = typeof e['type'] === 'string' ? (e['type'] as string).trim() : '';
      if (!name || !type) continue;
      entities.push({
        name,
        type,
        span: typeof e['span'] === 'string' ? (e['span'] as string).slice(0, 200) : null,
        confidence: typeof e['confidence'] === 'number' ? (e['confidence'] as number) : null,
      });
    }
  }

  const triples: ExtractedTriple[] = [];
  if (Array.isArray(parsed.triples)) {
    for (const raw of parsed.triples) {
      const t = raw as Record<string, unknown>;
      if (
        typeof t['subject'] === 'string' &&
        typeof t['predicate'] === 'string' &&
        typeof t['object'] === 'string'
      ) {
        triples.push({
          subject: (t['subject'] as string).trim(),
          predicate: (t['predicate'] as string).trim(),
          object: (t['object'] as string).trim(),
        });
      }
    }
  }

  return { entities, triples };
}

/**
 * The extraction prompt. Kept deliberately identical in intent to
 * `extract_write.ts`'s: two writers producing systematically different entity
 * surfaces for the same corpus would split canonical entities and make the
 * consolidation pass resolve a mess this layer created.
 */
export function buildPrompt(
  content: string,
  vocab: { predicates: string[]; entityTypes: string[] },
): string {
  return `Extract the named entities and the relationships between them from this developer memory.

type MUST be exactly one of: ${vocab.entityTypes.join(', ')}
predicate MUST be exactly one of: ${vocab.predicates.join(', ')}

Rules:
- Only entities the text actually names. Do not infer, do not generalize.
- name is the surface form exactly as written in the text.
- Both subject and object of a triple MUST be names present in your entities array.
- If nothing is clearly named, return empty arrays. Empty is a correct answer.
- Never emit a type or predicate outside the lists above.
- Do not extract secrets, tokens, or credentials as entities.

Return exactly: {"entities": [{"name": "...", "type": "...", "span": "...", "confidence": 0.0}], "triples": [{"subject": "...", "predicate": "...", "object": "..."}]}

Memory:
${content.slice(0, MAX_CONTENT_CHARS)}`;
}

// ── persistence ─────────────────────────────────────────────────────────────

async function writeEntities(
  pool: PgPool,
  memoryId: string,
  entities: ExtractedEntity[],
): Promise<{ created: number; linked: number; dropped: number }> {
  if (entities.length === 0) return { created: 0, linked: 0, dropped: 0 };
  const { rows } = await pool.query(
    'select public.upsert_memory_entities($1::uuid, $2::jsonb) as result',
    [
      memoryId,
      JSON.stringify(
        entities.map((e) => ({
          name: e.name.trim(),
          type: e.type.trim(),
          span: e.span ?? null,
          confidence: e.confidence ?? null,
        })),
      ),
    ],
  );
  const r = ((rows[0] as { result?: unknown } | undefined)?.result ?? {}) as {
    created?: number;
    linked?: number;
    dropped?: number;
  };
  return { created: r.created ?? 0, linked: r.linked ?? 0, dropped: r.dropped ?? 0 };
}

/**
 * The deterministic half: link this memory to earlier memories carrying the
 * same problem class. No model involved, so the edge that powers "you solved
 * this before" still lands when there is no API key, no budget, or a refusing
 * model — which is also why it runs FIRST, before the LLM call can consume the
 * item's budget.
 */
async function writeSamePatternEdges(
  pool: PgPool,
  memoryId: string,
  project: string,
  problemClass: string,
): Promise<{ accepted: number; droppedPredicates: string[] }> {
  const { rows: targets } = await pool.query(
    `select id::text as id
       from public.memory_items
      where project = $1
        and is_active = true
        and archived  = false
        and id <> $2::uuid
        and metadata->'problem_signature'->>'class' = $3
      limit $4::int`,
    [project, memoryId, problemClass, MAX_SAME_PATTERN_EDGES],
  );
  if (targets.length === 0) return { accepted: 0, droppedPredicates: [] };

  const edges = (targets as Array<{ id: string }>).map((t) => ({
    source_id: memoryId,
    target_id: t.id,
    predicate: 'same_pattern_as',
    weight: 0.9,
    inferred_by: SWEEP_INFERRED_BY,
  }));

  const { rows } = await pool.query(
    'select public.upsert_memory_edges($1::jsonb) as result',
    [JSON.stringify(edges)],
  );
  const r = ((rows[0] as { result?: unknown } | undefined)?.result ?? {}) as {
    accepted?: number;
    dropped_predicates?: string[];
  };
  return { accepted: r.accepted ?? 0, droppedPredicates: r.dropped_predicates ?? [] };
}

/**
 * Stamp the ledger. `attempts` increments on conflict so a repeatedly-failing
 * item retires itself after `maxAttempts` instead of consuming a slot every
 * night forever — fail-open per item, but not retry-forever.
 */
async function recordSweep(
  pool: PgPool,
  row: {
    memoryId: string;
    status: 'ok' | 'error';
    entities: number;
    mentions: number;
    edges: number;
    triples: number;
    error: string | null;
  },
): Promise<void> {
  await pool.query(
    `insert into public.rumen_extraction_sweep
       (memory_id, swept_at, status, attempts, entities_written,
        mentions_written, same_pattern_edges, triples_found, error)
     values ($1::uuid, now(), $2, 1, $3::int, $4::int, $5::int, $6::int, $7)
     on conflict (memory_id) do update
        set swept_at           = now(),
            status             = excluded.status,
            attempts           = public.rumen_extraction_sweep.attempts + 1,
            entities_written   = excluded.entities_written,
            mentions_written   = excluded.mentions_written,
            same_pattern_edges = excluded.same_pattern_edges,
            triples_found      = excluded.triples_found,
            error              = excluded.error`,
    [
      row.memoryId,
      row.status,
      row.entities,
      row.mentions,
      row.edges,
      row.triples,
      row.error,
    ],
  );
}

// ── orchestration ───────────────────────────────────────────────────────────

async function createAnthropic(): Promise<AnthropicLike | null> {
  if (!process.env['ANTHROPIC_API_KEY']) return null;
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  return new Anthropic({
    apiKey: process.env['ANTHROPIC_API_KEY'],
    // Sized for a 150s Edge Function wall, not an interactive server. The
    // per-item budget below is the real bound; this stops a stalled socket
    // from riding past it.
    timeout: readIntEnv('RUMEN_SWEEP_LLM_TIMEOUT_MS', DEFAULT_ITEM_BUDGET_MS),
    maxRetries: 0,
  }) as unknown as AnthropicLike;
}

/**
 * Sweep one item. NEVER throws — every failure becomes a recorded error, so a
 * poison item cannot abort the pass for the items behind it.
 */
async function sweepOne(
  pool: PgPool,
  item: Candidate,
  vocab: { predicates: string[]; entityTypes: string[] },
  anthropic: AnthropicLike | null,
  opts: { dryRun: boolean; itemBudgetMs: number },
  now: () => number,
): Promise<{
  ok: boolean;
  entities: number;
  mentions: number;
  edges: number;
  triples: ExtractedTriple[];
  droppedEntityTypes: number;
  droppedPredicates: string[];
  error: string | null;
}> {
  const startedAt = now();
  let entities = 0;
  let mentions = 0;
  let edges = 0;
  let droppedEntityTypes = 0;
  const droppedPredicates: string[] = [];
  let triples: ExtractedTriple[] = [];
  let error: string | null = null;

  try {
    // Deterministic half first — see writeSamePatternEdges.
    if (item.problem_class) {
      if (opts.dryRun) {
        const { rows } = await pool.query(
          `select count(*)::int as n
             from public.memory_items
            where project = $1 and is_active = true and archived = false
              and id <> $2::uuid
              and metadata->'problem_signature'->>'class' = $3`,
          [item.project, item.id, item.problem_class],
        );
        edges = Math.min(
          (rows[0] as { n?: number } | undefined)?.n ?? 0,
          MAX_SAME_PATTERN_EDGES,
        );
      } else {
        const res = await writeSamePatternEdges(
          pool,
          item.id,
          item.project,
          item.problem_class,
        );
        edges = res.accepted;
        droppedPredicates.push(...res.droppedPredicates);
      }
    }

    // Model half. A missing key is not an error — the deterministic half above
    // already ran and its result is worth recording on its own.
    if (anthropic && now() - startedAt < opts.itemBudgetMs) {
      const response = await anthropic.messages.create({
        model: process.env['RUMEN_SWEEP_MODEL'] || HAIKU_MODEL,
        max_tokens: 1024,
        system:
          'You are a JSON-only extraction system. Respond with a single valid JSON object and nothing else.',
        messages: [{ role: 'user', content: buildPrompt(item.content, vocab) }],
      });

      const text = response.content
        .filter((b) => b.type === 'text' && typeof b.text === 'string')
        .map((b) => b.text as string)
        .join('');
      const parsed = parseExtraction(text);

      // Cap only. Vocabulary enforcement belongs to the RPCs; filtering here
      // would be a second, drifting copy of a list this module is explicitly
      // told not to hold. The caps stay because a runaway response is a budget
      // leak whether or not every element is valid.
      triples = parsed.triples.slice(0, MAX_TRIPLES);
      const capped = parsed.entities.slice(0, MAX_ENTITIES);

      if (capped.length > 0 && !opts.dryRun) {
        const written = await writeEntities(pool, item.id, capped);
        entities = written.created;
        mentions = written.linked;
        droppedEntityTypes = written.dropped;
      } else if (capped.length > 0) {
        entities = capped.length;
      }
    }
  } catch (err) {
    error = (err as Error)?.message ?? String(err);
  }

  return {
    ok: error === null,
    entities,
    mentions,
    edges,
    triples,
    droppedEntityTypes,
    droppedPredicates,
    error,
  };
}

/**
 * Run one extraction-sweep pass.
 *
 * Fail-open at every level: a missing surface skips with a reason, a missing
 * model key still does the deterministic half, a poison item is recorded and
 * stepped over, and the wall clock ends the pass cleanly with partial progress
 * durable in the ledger. Nothing here can fail in a way that loses a memory,
 * because nothing here writes to `memory_items` at all.
 */
export async function runExtractionSweep(
  pool: PgPool,
  options: SweepOptions = {},
  deps: SweepDeps = {},
): Promise<SweepSummary> {
  const now = deps.now ?? (() => Date.now());
  const startedAt = now();
  const elapsed = () => now() - startedAt;

  const lookbackDays = options.lookbackDays ?? readIntEnv('RUMEN_SWEEP_LOOKBACK_DAYS', DEFAULT_LOOKBACK_DAYS);
  const batch = options.batch ?? readIntEnv('RUMEN_SWEEP_BATCH', DEFAULT_BATCH);
  const budgetMs = options.budgetMs ?? readIntEnv('RUMEN_SWEEP_BUDGET_MS', DEFAULT_BUDGET_MS);
  const itemBudgetMs = options.itemBudgetMs ?? readIntEnv('RUMEN_SWEEP_ITEM_BUDGET_MS', DEFAULT_ITEM_BUDGET_MS);
  const concurrency = options.concurrency ?? readIntEnv('RUMEN_SWEEP_CONCURRENCY', DEFAULT_CONCURRENCY);
  const maxAttempts = options.maxAttempts ?? readIntEnv('RUMEN_SWEEP_MAX_ATTEMPTS', DEFAULT_MAX_ATTEMPTS);
  const minContentChars = options.minContentChars ?? readIntEnv('RUMEN_SWEEP_MIN_CONTENT_CHARS', DEFAULT_MIN_CONTENT_CHARS);
  const dryRun = options.dryRun ?? readBoolEnv('RUMEN_SWEEP_DRY_RUN');

  const summary: SweepSummary = {
    ok: true,
    dry_run: dryRun,
    capabilities: { ledger: false, rpcs: false, vocabulary: false, detail: '' },
    candidates: 0,
    processed: 0,
    succeeded: 0,
    failed: 0,
    skipped_budget: 0,
    entities_written: 0,
    mentions_written: 0,
    same_pattern_edges: 0,
    triples_found: 0,
    triples_sample: [],
    dropped_entity_types: 0,
    dropped_predicates: [],
    elapsed_ms: 0,
    errors: [],
  };

  try {
    summary.capabilities = await probeSweepCapabilities(pool);

    // The ledger is the one hard requirement: without it there is no
    // idempotency, and a sweep that cannot remember what it swept would
    // re-extract the same items — and re-pay for them — on every run.
    if (!summary.capabilities.ledger || !summary.capabilities.rpcs) {
      summary.ok = false;
      summary.skipped_reason = summary.capabilities.detail;
      summary.elapsed_ms = elapsed();
      return summary;
    }

    const vocab = summary.capabilities.vocabulary
      ? await loadVocabulary(pool)
      : { predicates: [], entityTypes: [] };

    const candidates = await selectCandidates(pool, {
      lookbackDays,
      batch,
      maxAttempts,
      minContentChars,
    });
    summary.candidates = candidates.length;

    // Constructed only once there is work AND a vocabulary to constrain it.
    // No vocabulary → no model half, but the deterministic same_pattern_as
    // half still runs and is still worth the pass. Nothing left to sweep → no
    // client at all, so an empty run costs one SELECT and no SDK load.
    const anthropic =
      summary.capabilities.vocabulary && candidates.length > 0
        ? (deps.anthropic ?? (await createAnthropic()))
        : null;

    for (let i = 0; i < candidates.length; i += concurrency) {
      if (elapsed() >= budgetMs) {
        summary.skipped_budget = candidates.length - i;
        break;
      }
      const chunk = candidates.slice(i, i + concurrency);
      const results = await Promise.all(
        chunk.map((item) =>
          sweepOne(pool, item, vocab, anthropic, { dryRun, itemBudgetMs }, now),
        ),
      );

      for (let j = 0; j < chunk.length; j += 1) {
        const item = chunk[j] as Candidate;
        const r = results[j] as Awaited<ReturnType<typeof sweepOne>>;

        summary.processed += 1;
        summary.entities_written += r.entities;
        summary.mentions_written += r.mentions;
        summary.same_pattern_edges += r.edges;
        summary.triples_found += r.triples.length;
        summary.dropped_entity_types += r.droppedEntityTypes;
        for (const p of r.droppedPredicates) {
          if (!summary.dropped_predicates.includes(p)) summary.dropped_predicates.push(p);
        }
        if (summary.triples_sample.length < 10) {
          summary.triples_sample.push(...r.triples.slice(0, 10 - summary.triples_sample.length));
        }

        if (r.ok) summary.succeeded += 1;
        else {
          summary.failed += 1;
          if (summary.errors.length < 20) {
            summary.errors.push({ memory_id: item.id, error: r.error ?? 'unknown' });
          }
        }

        if (!dryRun) {
          try {
            await recordSweep(pool, {
              memoryId: item.id,
              status: r.ok ? 'ok' : 'error',
              entities: r.entities,
              mentions: r.mentions,
              edges: r.edges,
              triples: r.triples.length,
              error: r.error,
            });
          } catch (err) {
            // A ledger write that fails means this item will be re-selected
            // next run. Wasteful, never wrong — and far better than aborting
            // the pass over bookkeeping.
            if (summary.errors.length < 20) {
              summary.errors.push({
                memory_id: item.id,
                error: `ledger write failed: ${(err as Error).message}`,
              });
            }
          }
        }
      }
    }
  } catch (err) {
    summary.ok = false;
    summary.skipped_reason = `unexpected: ${(err as Error)?.message}`;
  }

  summary.elapsed_ms = elapsed();
  return summary;
}
