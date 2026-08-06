/**
 * Rumen Sprint 71 (TermDeck Deck B, B-T3) — objective-guard: three anti-drift
 * jobs over the Objective Tier.
 *
 *   1. Contradiction scan   — a new decision/architecture/preference/bug_fix
 *                             memory that semantically OPPOSES one of its
 *                             project's tier-0 objectives raises a FLAG.
 *   2. Objective-coverage   — sustained project activity with zero tier-0
 *                             linkage is a drift signal, written as a report.
 *   3. Objective staleness  — a tier-0 objective past a ratification-age
 *                             threshold raises a review FLAG.
 *
 * ── THE ONE RULE THIS MODULE EXISTS TO OBEY ─────────────────────────────
 *
 * FLAG, NEVER RESOLVE. Tier-0 objectives are mutable ONLY through explicit
 * operator ratification. That is the entire enforcement property the Objective
 * Tier is built on, and the most plausible way to lose it is not an attacker —
 * it is a well-meaning background job that "reconciles" a contradiction at 5am
 * because it looked obvious. A job that edited an objective, archived the
 * offending memory, or picked a winner would be an unratified mutation path
 * wearing a helpful hat.
 *
 * So the entire write surface of this module is four rumen-owned tables
 * (migration 009): append a flag, append a report, append a job row, stamp a
 * ledger. It writes `status = 'open'` on a flag exactly once and never writes
 * that column again. It never issues an UPDATE, INSERT or DELETE against
 * `memory_items`, `memory_sessions`, `memory_relationships`, or any tier-0
 * store — not even a metadata stamp. (Rumen's standing "never modifies existing
 * memory rows" rule, `src/index.ts` header / CONTRIBUTING.md ground rule 1;
 * this module needs no amendment to it, which is the point.)
 *
 * ── DARK BY DEFAULT ─────────────────────────────────────────────────────
 *
 * Every entry point is gated on `RUMEN_OBJECTIVE_GUARD_ENABLED=1` and returns a
 * `skipped` summary otherwise, and migration 010 registers the cron and then
 * immediately deactivates it. Two independent switches, because the failure
 * mode of a semantic-judgement job going live before anyone has looked at its
 * output is a flag queue nobody trusts — and an untrusted queue is
 * indistinguishable from no queue. ORCH turns both on at the operator gate.
 *
 * ── THE TIER-0 ACCESSOR IS PLUGGABLE, AND WHY ───────────────────────────
 *
 * Engram migration 038 (B-T1) owns the objectives store; it had not posted its
 * marker when this was written. Rather than block, `resolveTier0Source()`
 * probes three arms in order and LATCHES the verdict for the pass:
 *
 *   1. rpc     — `public.objective_list(p_project text)`, name overridable via
 *                `RUMEN_TIER0_RPC`. Same function, same arg name B-T2 calls on
 *                the termdeck side, so both halves of the sprint read tier 0
 *                through one surface.
 *   2. table   — `RUMEN_TIER0_TABLE` (default `memory_objectives`), prose column
 *                `content` (NOT `text`), filtered to `status='active'`.
 *   3. marker  — a tier marker column on `memory_items`, OPT-IN ONLY
 *                (`RUMEN_TIER0_MARKER_COLUMN`; no default). 038 put objectives
 *                in their own table and B-T1's seam note says not to resolve
 *                them through `memory_items` — probing that by default risks
 *                reading ordinary memories AS objectives on a store that never
 *                had 038.
 *
 * All-projects reads go through `fetchAllObjectives()`, NOT
 * `fetchObjectivesFrom(…, null)` — on the rpc arm the latter returns nothing by
 * design, which would make this whole lane a silent no-op. See that function.
 *
 * Unresolvable is a first-class outcome, not an error: all three jobs then
 * report `skipped` with `tier0_source: 'unavailable'`. That distinction is
 * carried all the way into the job ledger on purpose — "found no
 * contradictions" and "could not find the objectives" produce an identical flag
 * count of zero, and telling them apart six weeks later from the flag table
 * alone is impossible.
 *
 * Everything is injectable (`deps.fetchObjectives`, `deps.anthropic`,
 * `deps.now`), so the jobs are testable end-to-end without a database, an API
 * key, or knowledge of which arm 038 eventually lands as.
 *
 * ── PRECISION OVER RECALL, DELIBERATELY ─────────────────────────────────
 *
 * The contradiction scan asks a cheap model a genuinely hard question. Its
 * prompt is written to return EMPTY when unsure, and every flag costs a human
 * an adjudication. A missed contradiction shows up again on the next
 * contradicting memory; a stream of false flags trains the operator to close
 * the queue unread, and that failure is not self-correcting.
 */

import type { PgPool } from './db.js';
import type { AnthropicLike } from './synthesize.js';

const HAIKU_MODEL = 'claude-haiku-4-5-20251001';

/** Provenance stamp on every row this module writes. */
export const GUARD_DETECTED_BY = 'objective-guard@1';

/**
 * The source types worth judging against objectives — the same curated pool
 * `doctrine-scan.ts` uses. A `session_summary` or a raw capture is a record of
 * what happened, not a claim about what should happen, and only a claim can
 * contradict an objective.
 */
export const JUDGED_SOURCE_TYPES = [
  'decision',
  'architecture',
  'preference',
  'bug_fix',
] as const;

// ── defaults ────────────────────────────────────────────────────────────────

const DEFAULT_LOOKBACK_DAYS = 14;
const DEFAULT_BATCH = 60;
/** Whole-pass wall clock, under the Edge Function's 150s kill. */
const DEFAULT_BUDGET_MS = 110_000;
const DEFAULT_ITEM_BUDGET_MS = 8_000;
const DEFAULT_CONCURRENCY = 3;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_MIN_CONTENT_CHARS = 80;
/** Hard ceiling on model calls per contradiction pass. */
const DEFAULT_MAX_LLM_CALLS = 40;
/** A single memory cannot contradict more than this many objectives usefully. */
const MAX_FLAGS_PER_MEMORY = 3;
/** Cost control on content handed to the model. */
const MAX_CONTENT_CHARS = 6_000;
/** Objectives are short by construction; this only guards a pathological row. */
const MAX_OBJECTIVE_CHARS = 1_000;

const DEFAULT_COVERAGE_WINDOW_DAYS = 7;
/** Below this, "no linkage" is a small sample, not a drift signal. */
const DEFAULT_COVERAGE_MIN_WRITES = 20;

const DEFAULT_STALENESS_DAYS = 180;

/** Identifiers reach SQL by interpolation, so they are whitelisted, not escaped. */
const SAFE_IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/;

// The frozen B-T1 seam (engram migration 038). Each is one env override away
// from a differently-shaped store, but these ARE the contract.
const TIER0_RPC_DEFAULT = 'objective_list';
const TIER0_TABLE_DEFAULT = 'memory_objectives';
/** The objective prose column. `content`, NOT `text` — see the table arm. */
const TIER0_TEXT_COLUMN_DEFAULT = 'content';

// ── types ───────────────────────────────────────────────────────────────────

/**
 * Byte-compatible with the normalized row shape B-T2 froze for the termdeck
 * injection surfaces (STATUS.md, B-T2 SCHEMA-READY). Both halves of the sprint
 * agreeing on what an objective IS matters more than either shape's details.
 */
export interface Tier0Objective {
  id: string | null;
  project: string;
  rank: number | null;
  text: string;
  status: string | null;
  ratified_by: string | null;
  ratified_at: string | null;
  supersedes: string | null;
}

export type Tier0SourceKind = 'rpc' | 'table' | 'marker' | 'unavailable';

export interface Tier0Resolution {
  kind: Tier0SourceKind;
  /** The rpc / table / column name actually resolved, for the job ledger. */
  name: string | null;
  detail: string;
}

export type GuardPhase = 'contradiction_scan' | 'coverage_report' | 'staleness_scan';

export interface PhaseSummary {
  phase: GuardPhase;
  status: 'done' | 'failed' | 'skipped';
  tier0_source: Tier0SourceKind;
  objectives_seen: number;
  candidates: number;
  processed: number;
  flags_written: number;
  reports_written: number;
  llm_calls_made: number;
  skipped_budget: number;
  note: string | null;
  error_message: string | null;
  elapsed_ms: number;
  /** Per-item failures, capped. Fail-open: these never abort a pass. */
  errors: Array<{ id: string; error: string }>;
}

export interface ObjectiveGuardSummary {
  ok: boolean;
  enabled: boolean;
  tier0_source: Tier0SourceKind;
  phases: PhaseSummary[];
  elapsed_ms: number;
  note: string | null;
}

export interface GuardOptions {
  /** Force-run regardless of RUMEN_OBJECTIVE_GUARD_ENABLED (ORCH / tests). */
  enabled?: boolean;
  triggeredBy?: 'schedule' | 'manual';
  lookbackDays?: number;
  batch?: number;
  budgetMs?: number;
  itemBudgetMs?: number;
  concurrency?: number;
  maxAttempts?: number;
  minContentChars?: number;
  maxLlmCalls?: number;
  coverageWindowDays?: number;
  coverageMinWrites?: number;
  stalenessDays?: number;
  /** Flag objectives that carry no ratified_at at all. Default OFF — see below. */
  flagUnratified?: boolean;
  /** Compute and report; write nothing at all — not even ledger rows. */
  dryRun?: boolean;
}

export interface GuardDeps {
  anthropic?: AnthropicLike;
  now?: () => number;
  /** Swap the whole accessor out. Tests use this; so can a future 038 shape. */
  fetchObjectives?: (project: string | null) => Promise<Tier0Objective[]>;
  /** Pre-resolved source, so the three phases share one probe. */
  resolution?: Tier0Resolution;
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

function readIdentEnv(name: string, fallback: string): string {
  const raw = (process.env[name] ?? '').trim();
  if (raw.length === 0) return fallback;
  if (!SAFE_IDENTIFIER.test(raw)) {
    console.error(
      `[rumen-objective-guard] ${name}=${raw} is not a plain lowercase identifier; using ${fallback}`,
    );
    return fallback;
  }
  return raw;
}

// ── tier-0 accessor ─────────────────────────────────────────────────────────

/**
 * Probe the three arms in one round trip and latch the verdict.
 *
 * Order is rpc → table → marker, most-specific first: an `objective_list`
 * function is an intentional read API and whatever it returns is authoritative,
 * whereas a table or a marker column is raw storage that a future migration
 * could reshape underneath us.
 */
export async function resolveTier0Source(pool: PgPool): Promise<Tier0Resolution> {
  const rpcName = readIdentEnv('RUMEN_TIER0_RPC', TIER0_RPC_DEFAULT);
  const tableName = readIdentEnv('RUMEN_TIER0_TABLE', TIER0_TABLE_DEFAULT);
  // OPT-IN, and deliberately so. B-T1's 038 puts objectives in their own table
  // and says plainly: do not resolve objectives through `memory_items`, there
  // is nothing there to join to. A marker arm that probed by DEFAULT would, on
  // a store where 038 is absent but some unrelated `tier` column exists on
  // memory_items, silently read ordinary memories AS OBJECTIVES and judge every
  // new decision against them. An empty name never matches a column, so the
  // default configuration cannot reach that arm at all.
  const markerColumn = (process.env['RUMEN_TIER0_MARKER_COLUMN'] ?? '').trim();
  const markerOptIn = markerColumn.length > 0 && SAFE_IDENTIFIER.test(markerColumn);

  try {
    const { rows } = await pool.query(
      `select to_regprocedure($1) is not null as rpc,
              to_regclass($2)     is not null as tbl,
              exists (
                select 1 from information_schema.columns
                 where table_schema = 'public'
                   and table_name   = 'memory_items'
                   and column_name  = $3
              ) as marker`,
      [`public.${rpcName}(text)`, `public.${tableName}`, markerOptIn ? markerColumn : ''],
    );
    const row = (rows[0] ?? {}) as { rpc?: boolean; tbl?: boolean; marker?: boolean };
    if (row.rpc) {
      return { kind: 'rpc', name: rpcName, detail: `rpc public.${rpcName}(text)` };
    }
    if (row.tbl) {
      return { kind: 'table', name: tableName, detail: `table public.${tableName}` };
    }
    if (markerOptIn && row.marker) {
      return {
        kind: 'marker',
        name: markerColumn,
        detail: `marker memory_items.${markerColumn} = 0 (opt-in)`,
      };
    }
    return {
      kind: 'unavailable',
      name: null,
      detail:
        `no tier-0 surface: public.${rpcName}(text) and public.${tableName} are ` +
        'absent (apply engram migration 038)' +
        (markerOptIn ? `; opt-in marker memory_items.${markerColumn} also absent` : ''),
    };
  } catch (err) {
    return {
      kind: 'unavailable',
      name: null,
      detail: `tier-0 probe failed: ${(err as Error).message}`,
    };
  }
}

/**
 * Coerce whatever the resolved arm returned into the frozen shape. A row
 * without usable text is dropped rather than defaulted: an objective whose text
 * we cannot read cannot be judged against, and inventing a placeholder would
 * put an empty string in front of a model and ask it to reason about it.
 */
export function normalizeObjective(raw: unknown, fallbackProject = ''): Tier0Objective | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;

  const text = typeof r['text'] === 'string' ? r['text'].trim() : '';
  if (text.length === 0) return null;

  const rawRank = r['rank'];
  let rank: number | null = null;
  if (typeof rawRank === 'number' && Number.isFinite(rawRank)) rank = rawRank;
  else if (typeof rawRank === 'string') {
    const parsed = Number.parseInt(rawRank, 10);
    if (Number.isFinite(parsed)) rank = parsed;
  }

  const str = (v: unknown): string | null =>
    typeof v === 'string' && v.length > 0 ? v : null;

  const project = typeof r['project'] === 'string' && r['project'].length > 0
    ? r['project']
    : fallbackProject;

  return {
    id: str(r['id']),
    project,
    rank,
    text: text.slice(0, MAX_OBJECTIVE_CHARS),
    status: str(r['status']),
    ratified_by: str(r['ratified_by']),
    ratified_at: str(r['ratified_at']),
    supersedes: str(r['supersedes']),
  };
}

/** Rank ascending is the pin order; nulls last, then stable by text. */
export function sortObjectives(objectives: Tier0Objective[]): Tier0Objective[] {
  return [...objectives].sort((a, b) => {
    if (a.rank === null && b.rank === null) return a.text.localeCompare(b.text);
    if (a.rank === null) return 1;
    if (b.rank === null) return -1;
    if (a.rank !== b.rank) return a.rank - b.rank;
    return a.text.localeCompare(b.text);
  });
}

/**
 * Read tier-0 through the latched arm, for ONE project.
 *
 * `project === null` means "no project filter" — correct for the table and
 * marker arms, but on the rpc arm B-T1's `objective_list(null)` deliberately
 * returns zero rows. Call `fetchAllObjectives()` for the all-projects read
 * instead of passing null here; this function is the per-arm primitive.
 *
 * Identifiers are interpolated (pg has no parameter form for them) and are
 * therefore whitelisted by SAFE_IDENTIFIER at read time, never escaped.
 */
export async function fetchObjectivesFrom(
  pool: PgPool,
  resolution: Tier0Resolution,
  project: string | null,
): Promise<Tier0Objective[]> {
  if (resolution.kind === 'unavailable' || !resolution.name) return [];
  if (!SAFE_IDENTIFIER.test(resolution.name)) return [];

  try {
    if (resolution.kind === 'rpc') {
      const { rows } = await pool.query(
        `select * from public.${resolution.name}($1::text)`,
        [project],
      );
      return sortObjectives(
        rows.map((r) => normalizeObjective(r, project ?? '')).filter(isObjective),
      );
    }

    if (resolution.kind === 'table') {
      // `content`, NOT `text` — B-T1 froze the prose column as `content` in 038
      // (`text` is a Postgres type name and reads badly in raw SQL; `content`
      // also matches memory_items' own naming). Against the frozen shape a
      // `"text"` select errors with column-not-found, the catch below returns
      // [], and every anti-drift job then reads "no objectives" — a silent,
      // total no-op indistinguishable from a healthy store with nothing to
      // flag. Overridable for a differently-shaped store; the DEFAULT is the
      // frozen contract.
      const textColumn = readIdentEnv('RUMEN_TIER0_TEXT_COLUMN', TIER0_TEXT_COLUMN_DEFAULT);
      const { rows } = await pool.query(
        `select id::text                    as id,
                coalesce(project, '')       as project,
                "rank"                      as rank,
                ${textColumn}               as text,
                status                      as status,
                ratified_by                 as ratified_by,
                ratified_at::text           as ratified_at,
                supersedes::text            as supersedes
           from public.${resolution.name}
          where ($1::text is null or project = $1::text)
            and coalesce(status, 'active') = 'active'`,
        [project],
      );
      return sortObjectives(
        rows.map((r) => normalizeObjective(r, project ?? '')).filter(isObjective),
      );
    }

    // marker arm: objectives are memory_items rows at tier 0. rank/ratification
    // live in metadata, read as TEXT and parsed in JS — a `(metadata->>'rank')::int`
    // cast would abort the whole query on one malformed row.
    const { rows } = await pool.query(
      `select m.id::text                            as id,
              coalesce(m.project, '')               as project,
              m.metadata->>'rank'                   as rank,
              m.content                             as text,
              coalesce(m.metadata->>'status', 'active') as status,
              m.metadata->>'ratified_by'            as ratified_by,
              m.metadata->>'ratified_at'            as ratified_at,
              m.metadata->>'supersedes'             as supersedes
         from public.memory_items m
        where m."${resolution.name}" = 0
          and m.is_active = true
          and m.archived  = false
          and m.superseded_by is null
          and ($1::text is null or m.project = $1::text)`,
      [project],
    );
    return sortObjectives(
      rows.map((r) => normalizeObjective(r, project ?? '')).filter(isObjective),
    );
  } catch (err) {
    console.error(
      `[rumen-objective-guard] tier-0 read failed (${resolution.detail}): ${(err as Error).message}`,
    );
    return [];
  }
}

function isObjective(o: Tier0Objective | null): o is Tier0Objective {
  return o !== null;
}

/**
 * Distinct projects that currently have active objectives. `null` means the
 * enumeration itself failed (table absent, no grant) — distinct from `[]`,
 * which means the store genuinely has none. The caller has to tell those apart
 * or it will report "no objectives" for a permissions problem.
 */
export async function listObjectiveProjects(
  pool: PgPool,
  tableName: string,
): Promise<string[] | null> {
  if (!SAFE_IDENTIFIER.test(tableName)) return null;
  try {
    const { rows } = await pool.query(
      `select distinct project
         from public.${tableName}
        where coalesce(status, 'active') = 'active'
          and project is not null
          and project <> ''`,
    );
    return (rows as Array<{ project?: string }>)
      .map((r) => r.project ?? '')
      .filter((p) => p.length > 0);
  } catch {
    return null;
  }
}

/**
 * Every project's objectives — what all three jobs actually need, since each
 * judges a memory against ITS OWN project's tier-0.
 *
 * ── WHY THIS IS NOT JUST fetchObjectivesFrom(pool, resolution, null) ─────
 *
 * On the rpc arm it would return NOTHING, silently. B-T1 made
 * `objective_list(null)` return zero rows deliberately (038 smoke group 7):
 * tier 0 is per-project, and handing ONE agent 36 projects' binding
 * constraints — interleaved, since the sort is rank-ascending across the whole
 * table — is worse than handing it none. That is exactly right for an
 * injection surface, and exactly wrong for this module, which is not injecting
 * anything: it needs the whole set so it can group by project and judge each
 * memory against its own.
 *
 * The failure that reasoning prevents is the quiet one. With the rpc arm
 * latched (the FIRST arm probed, so the default on any store with 038),
 * `fetch(null)` would return `[]`, all three phases would report
 * `skipped: no tier-0 objectives in any project`, and the ledger would show a
 * healthy nightly run finding nothing — on a store full of objectives. Nothing
 * errors, nothing retries, and the anti-drift lane is a no-op forever.
 *
 * So: enumerate the projects, then fan out one RPC call each. If enumeration is
 * impossible, fall back to reading the table directly (038 always ships both,
 * so a readable RPC with an unreadable table is a grant anomaly, not a shape we
 * need to support) — and if THAT fails too, return empty, which the caller
 * reports as a skip rather than as a clean pass.
 */
export async function fetchAllObjectives(
  pool: PgPool,
  resolution: Tier0Resolution,
): Promise<Tier0Objective[]> {
  if (resolution.kind === 'unavailable') return [];
  if (resolution.kind !== 'rpc') return fetchObjectivesFrom(pool, resolution, null);

  const tableName = readIdentEnv('RUMEN_TIER0_TABLE', TIER0_TABLE_DEFAULT);
  const tableResolution: Tier0Resolution = {
    kind: 'table',
    name: tableName,
    detail: `table public.${tableName} (all-projects read behind the rpc arm)`,
  };

  const projects = await listObjectiveProjects(pool, tableName);
  if (projects === null) {
    console.warn(
      '[rumen-objective-guard] could not enumerate objective projects; ' +
        'reading the objectives table directly for the all-projects pass',
    );
    return fetchObjectivesFrom(pool, tableResolution, null);
  }
  if (projects.length === 0) return [];

  const out: Tier0Objective[] = [];
  for (const project of projects) {
    out.push(...(await fetchObjectivesFrom(pool, resolution, project)));
  }
  return sortObjectives(out);
}

export function groupByProject(objectives: Tier0Objective[]): Map<string, Tier0Objective[]> {
  const out = new Map<string, Tier0Objective[]>();
  for (const o of objectives) {
    if (o.project.length === 0) continue;
    const arr = out.get(o.project);
    if (arr) arr.push(o);
    else out.set(o.project, [o]);
  }
  return out;
}

/**
 * Stable fingerprint of a project's objective SET.
 *
 * This is what makes re-ratification — not the calendar — the trigger for
 * re-judging a memory. A ledger keyed on memory_id alone would freeze the first
 * verdict forever, and "does this contradict?" has a different answer against a
 * different set of objectives. FNV-1a: non-cryptographic on purpose, this
 * detects change, it does not authenticate anything.
 */
export function objectivesFingerprint(objectives: Tier0Objective[]): string {
  const parts = objectives
    .map((o) => `${o.id ?? ''}|${o.ratified_at ?? ''}|${o.rank ?? ''}|${o.text}`)
    .sort();
  return `fnv1a:${fnv1aHex(parts.join('|'))}:${objectives.length}`;
}

function fnv1aHex(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/**
 * The handle an objective is known by in prompts, verdict validation and dedup
 * keys.
 *
 * Normally that is its store id. When the resolved arm hands back objectives
 * with no id -- possible on the marker arm, and possible again if 038's shape
 * differs from what was guessed here -- falling back to a shared literal like
 * 'unidentified' would collapse EVERY id-less objective in a project onto one
 * key: the model's verdicts become unattributable, and one dedup key suppresses
 * the flags for all of them. A content hash keeps them distinct, and is stable
 * across runs for exactly as long as the text is.
 */
export function objectiveKey(objective: Tier0Objective): string {
  if (objective.id && objective.id.length > 0) return objective.id;
  return `text:${fnv1aHex(objective.project + '|' + objective.text)}`;
}

// ── flag writing (the only human-facing output) ──────────────────────────────

export interface FlagRow {
  flagType: 'contradiction' | 'staleness';
  project: string;
  objectiveId: string | null;
  objectiveText: string;
  objectiveRank: number | null;
  memoryId: string | null;
  memoryGist: string | null;
  severity: 'low' | 'medium' | 'high';
  rationale: string;
  dedupKey: string;
}

export function contradictionDedupKey(memoryId: string, objectiveId: string): string {
  return `contradiction:${memoryId}:${objectiveId}`;
}

/**
 * The ratified_at in the key is load-bearing: re-ratifying an objective mints a
 * fresh key, so a dismissed staleness flag legitimately returns once the NEW
 * ratification ages out, instead of one dismissal silencing that objective for
 * the rest of the store's life.
 */
export function stalenessDedupKey(objectiveId: string, ratifiedAt: string | null): string {
  return `staleness:${objectiveId}:${ratifiedAt ?? 'never'}`;
}

/** Returns the number of rows actually inserted (0 = already flagged). */
async function insertFlag(pool: PgPool, flag: FlagRow): Promise<number> {
  const { rows } = await pool.query(
    `insert into public.rumen_objective_flags
       (flag_type, project, objective_id, objective_text, objective_rank,
        memory_id, memory_gist, severity, rationale, detected_by, dedup_key)
     values ($1, $2, $3, $4, $5::int, $6::uuid, $7, $8, $9, $10, $11)
     on conflict (dedup_key) do nothing
     returning id`,
    [
      flag.flagType,
      flag.project,
      flag.objectiveId,
      flag.objectiveText,
      flag.objectiveRank,
      flag.memoryId,
      flag.memoryGist,
      flag.severity,
      flag.rationale,
      GUARD_DETECTED_BY,
      flag.dedupKey,
    ],
  );
  return rows.length;
}

// ── job ledger ──────────────────────────────────────────────────────────────

async function createJob(
  pool: PgPool,
  phase: GuardPhase,
  triggeredBy: 'schedule' | 'manual',
): Promise<string | null> {
  try {
    const { rows } = await pool.query(
      `insert into public.rumen_objective_guard_jobs (phase, triggered_by, status)
       values ($1, $2, 'running') returning id::text as id`,
      [phase, triggeredBy],
    );
    return ((rows[0] as { id?: string } | undefined)?.id) ?? null;
  } catch (err) {
    // Telemetry must never be the reason a pass does not run.
    console.error(`[rumen-objective-guard] job row insert failed: ${(err as Error).message}`);
    return null;
  }
}

async function completeJob(pool: PgPool, jobId: string | null, s: PhaseSummary): Promise<void> {
  if (!jobId) return;
  try {
    await pool.query(
      `update public.rumen_objective_guard_jobs
          set status = $2, tier0_source = $3, objectives_seen = $4, candidates = $5,
              processed = $6, flags_written = $7, reports_written = $8,
              llm_calls_made = $9, stats = $10::jsonb, note = $11,
              error_message = $12, completed_at = now()
        where id = $1::uuid`,
      [
        jobId,
        s.status,
        s.tier0_source,
        s.objectives_seen,
        s.candidates,
        s.processed,
        s.flags_written,
        s.reports_written,
        s.llm_calls_made,
        JSON.stringify({
          skipped_budget: s.skipped_budget,
          elapsed_ms: s.elapsed_ms,
          errors: s.errors.slice(0, 20),
        }),
        s.note,
        s.error_message,
      ],
    );
  } catch (err) {
    console.error(`[rumen-objective-guard] job row update failed: ${(err as Error).message}`);
  }
}

function emptyPhase(phase: GuardPhase): PhaseSummary {
  return {
    phase,
    status: 'done',
    tier0_source: 'unavailable',
    objectives_seen: 0,
    candidates: 0,
    processed: 0,
    flags_written: 0,
    reports_written: 0,
    llm_calls_made: 0,
    skipped_budget: 0,
    note: null,
    error_message: null,
    elapsed_ms: 0,
    errors: [],
  };
}

// ── phase 1: contradiction scan ─────────────────────────────────────────────

export interface ContradictionCandidate {
  id: string;
  project: string;
  content: string;
  source_type: string;
  created_at: string;
}

/**
 * Unjudged (or re-judgeable) memories in projects that HAVE objectives, newest
 * first. A row is re-selected when its project's objective set has changed
 * since it was judged — see objectivesFingerprint.
 */
export async function selectContradictionCandidates(
  pool: PgPool,
  opts: {
    projects: string[];
    /** One `project:fingerprint` string per project, the CURRENT state. */
    projectHashPairs: string[];
    lookbackDays: number;
    batch: number;
    maxAttempts: number;
    minContentChars: number;
  },
): Promise<ContradictionCandidate[]> {
  if (opts.projects.length === 0) return [];
  const { rows } = await pool.query(
    `select m.id::text              as id,
            coalesce(m.project, '') as project,
            m.content               as content,
            m.source_type           as source_type,
            m.created_at::text      as created_at
       from public.memory_items m
       left join public.rumen_objective_scan s on s.memory_id = m.id
      where m.is_active = true
        and m.archived  = false
        and m.superseded_by is null
        and m.project     = any($1::text[])
        and m.source_type = any($2::text[])
        and m.created_at > now() - make_interval(days => $3::int)
        and length(btrim(coalesce(m.content, ''))) >= $4::int
        and (
              s.memory_id is null
           or (s.status = 'error' and s.attempts < $5::int)
           or (coalesce(m.project, '') || ':' || coalesce(s.objectives_hash, ''))
                <> all($6::text[])
        )
      order by m.created_at desc
      limit $7::int`,
    [
      opts.projects,
      [...JUDGED_SOURCE_TYPES],
      opts.lookbackDays,
      opts.minContentChars,
      opts.maxAttempts,
      opts.projectHashPairs,
      opts.batch,
    ],
  );
  return rows as ContradictionCandidate[];
}

export interface ContradictionVerdict {
  objective_id: string;
  severity: 'low' | 'medium' | 'high';
  rationale: string;
  gist: string | null;
}

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
 * Parse + validate the model's verdict. Every field is policed against the
 * objectives actually shown to it: a flag naming an objective that was not in
 * the prompt is a hallucination, and hallucinated flags are the specific thing
 * that would make the operator stop reading the queue.
 *
 * Unparseable is EMPTY, never an error — "the model said something weird" is
 * not evidence of a contradiction, and treating it as a failure would retry it
 * and pay for it three times.
 */
export function parseContradictions(text: string, validIds: Set<string>): ContradictionVerdict[] {
  let parsed: { contradictions?: unknown };
  try {
    parsed = JSON.parse(stripFence(text)) as { contradictions?: unknown };
  } catch {
    return [];
  }
  if (!Array.isArray(parsed.contradictions)) return [];

  const out: ContradictionVerdict[] = [];
  const seen = new Set<string>();
  for (const raw of parsed.contradictions) {
    if (typeof raw !== 'object' || raw === null) continue;
    const r = raw as Record<string, unknown>;
    const objectiveId = typeof r['objective_id'] === 'string' ? r['objective_id'].trim() : '';
    if (!validIds.has(objectiveId) || seen.has(objectiveId)) continue;

    const rationale = typeof r['rationale'] === 'string' ? r['rationale'].trim().slice(0, 800) : '';
    // A flag with no stated reason is unadjudicatable, so it is not a flag.
    if (rationale.length === 0) continue;

    const rawSeverity = typeof r['severity'] === 'string' ? r['severity'].trim().toLowerCase() : '';
    const severity: 'low' | 'medium' | 'high' =
      rawSeverity === 'high' || rawSeverity === 'low' ? rawSeverity : 'medium';

    seen.add(objectiveId);
    out.push({
      objective_id: objectiveId,
      severity,
      rationale,
      gist: typeof r['gist'] === 'string' ? r['gist'].trim().slice(0, 300) : null,
    });
    if (out.length >= MAX_FLAGS_PER_MEMORY) break;
  }
  return out;
}

export function buildContradictionPrompt(
  memory: { content: string; source_type: string; created_at: string },
  objectives: Tier0Objective[],
): string {
  const lines: string[] = [];
  lines.push("This project's tier-0 OBJECTIVES (what the project is for, what must never happen):");
  lines.push('');
  for (const o of objectives) {
    lines.push(`- objective_id: ${objectiveKey(o)}`);
    lines.push(`  ${o.text}`);
  }
  lines.push('');
  lines.push(`A new ${memory.source_type} memory was recorded on ${memory.created_at.slice(0, 10)}:`);
  lines.push('');
  lines.push(memory.content.slice(0, MAX_CONTENT_CHARS));
  lines.push('');
  lines.push('Which objectives, if any, does this memory CONTRADICT? Return the JSON object now.');
  return lines.join('\n');
}

const CONTRADICTION_SYSTEM_PROMPT =
  'You judge whether a developer memory CONTRADICTS a project objective. You are a filter ' +
  'for a human review queue, so a false positive costs a person real time and a stream of ' +
  'them makes the queue worthless. Default to reporting nothing.\n' +
  'A CONTRADICTION means the memory asserts, decides, or establishes something that cannot ' +
  'be true at the same time as the objective — it does the thing the objective forbids, ' +
  'abandons the thing the objective requires, or commits to a direction the objective rules ' +
  'out.\n' +
  'These are NOT contradictions: being about a different topic; elaborating, refining, or ' +
  'adding detail to an objective; describing a problem, a bug, or a past failure; ' +
  'a temporary workaround explicitly marked as such; anything you are unsure about.\n' +
  'For each genuine contradiction give: the objective_id (exactly as shown, never invented), ' +
  'a severity, and a rationale naming the specific claim in the memory and the specific part ' +
  'of the objective it opposes. Also give a gist: a SHORT PARAPHRASE of the memory, never a ' +
  'verbatim quote. Do not propose a resolution — a human decides that.\n' +
  'Respond with a single JSON object and no prose outside it:\n' +
  '{"contradictions": [{"objective_id": "...", "severity": "low|medium|high", ' +
  '"rationale": "...", "gist": "..."}]}\n' +
  'If nothing genuinely contradicts, return {"contradictions": []}. That is the common and ' +
  'correct answer.';

async function createAnthropic(): Promise<AnthropicLike | null> {
  if (!process.env['ANTHROPIC_API_KEY']) return null;
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  return new Anthropic({
    apiKey: process.env['ANTHROPIC_API_KEY'],
    timeout: readIntEnv('RUMEN_OBJECTIVE_LLM_TIMEOUT_MS', DEFAULT_ITEM_BUDGET_MS),
    maxRetries: 0,
  }) as unknown as AnthropicLike;
}

/** Judge one memory. NEVER throws — a poison item is recorded and stepped over. */
async function judgeOne(
  item: ContradictionCandidate,
  objectives: Tier0Objective[],
  anthropic: AnthropicLike,
): Promise<{ ok: boolean; verdicts: ContradictionVerdict[]; error: string | null }> {
  try {
    const validIds = new Set(objectives.map(objectiveKey));
    const response = await anthropic.messages.create({
      model: process.env['RUMEN_OBJECTIVE_MODEL'] || HAIKU_MODEL,
      max_tokens: 900,
      system: CONTRADICTION_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: buildContradictionPrompt(item, objectives) }],
    });
    const text = response.content
      .filter((b) => b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text as string)
      .join('');
    return { ok: true, verdicts: parseContradictions(text, validIds), error: null };
  } catch (err) {
    return { ok: false, verdicts: [], error: (err as Error)?.message ?? String(err) };
  }
}

async function recordScan(
  pool: PgPool,
  row: {
    memoryId: string;
    status: 'ok' | 'error';
    flagsWritten: number;
    objectivesHash: string;
    error: string | null;
  },
): Promise<void> {
  await pool.query(
    `insert into public.rumen_objective_scan
       (memory_id, scanned_at, status, attempts, flags_written, objectives_hash, error)
     values ($1::uuid, now(), $2, 1, $3::int, $4, $5)
     on conflict (memory_id) do update
        set scanned_at      = now(),
            status          = excluded.status,
            attempts        = public.rumen_objective_scan.attempts + 1,
            flags_written   = excluded.flags_written,
            objectives_hash = excluded.objectives_hash,
            error           = excluded.error`,
    [row.memoryId, row.status, row.flagsWritten, row.objectivesHash, row.error],
  );
}

export async function runContradictionScan(
  pool: PgPool,
  options: GuardOptions = {},
  deps: GuardDeps = {},
): Promise<PhaseSummary> {
  const now = deps.now ?? (() => Date.now());
  const startedAt = now();
  const elapsed = () => now() - startedAt;
  const s = emptyPhase('contradiction_scan');

  const gate = guardGate(options);
  if (!gate.enabled) {
    s.status = 'skipped';
    s.note = gate.note;
    s.elapsed_ms = elapsed();
    return s;
  }

  const triggeredBy = options.triggeredBy ?? 'manual';
  const dryRun = options.dryRun ?? readBoolEnv('RUMEN_OBJECTIVE_DRY_RUN');
  const lookbackDays = options.lookbackDays ?? readIntEnv('RUMEN_OBJECTIVE_LOOKBACK_DAYS', DEFAULT_LOOKBACK_DAYS);
  const batch = options.batch ?? readIntEnv('RUMEN_OBJECTIVE_BATCH', DEFAULT_BATCH);
  const budgetMs = options.budgetMs ?? readIntEnv('RUMEN_OBJECTIVE_BUDGET_MS', DEFAULT_BUDGET_MS);
  const concurrency = options.concurrency ?? readIntEnv('RUMEN_OBJECTIVE_CONCURRENCY', DEFAULT_CONCURRENCY);
  const maxAttempts = options.maxAttempts ?? readIntEnv('RUMEN_OBJECTIVE_MAX_ATTEMPTS', DEFAULT_MAX_ATTEMPTS);
  const minContentChars = options.minContentChars ?? readIntEnv('RUMEN_OBJECTIVE_MIN_CONTENT_CHARS', DEFAULT_MIN_CONTENT_CHARS);
  const maxLlmCalls = options.maxLlmCalls ?? readIntEnv('RUMEN_OBJECTIVE_MAX_LLM_CALLS', DEFAULT_MAX_LLM_CALLS);

  const jobId = dryRun ? null : await createJob(pool, 'contradiction_scan', triggeredBy);

  try {
    const resolution = deps.resolution ?? (await resolveTier0Source(pool));
    s.tier0_source = resolution.kind;
    if (resolution.kind === 'unavailable' && !deps.fetchObjectives) {
      s.status = 'skipped';
      s.note = resolution.detail;
      s.elapsed_ms = elapsed();
      await completeJob(pool, jobId, s);
      return s;
    }

    const fetch =
      deps.fetchObjectives ??
      ((p: string | null) =>
        p === null ? fetchAllObjectives(pool, resolution) : fetchObjectivesFrom(pool, resolution, p));
    const all = await fetch(null);
    s.objectives_seen = all.length;
    const byProject = groupByProject(all);
    if (byProject.size === 0) {
      s.status = 'skipped';
      s.note = 'no tier-0 objectives in any project — nothing to contradict';
      s.elapsed_ms = elapsed();
      await completeJob(pool, jobId, s);
      return s;
    }

    const hashByProject = new Map<string, string>();
    for (const [project, objectives] of byProject) {
      hashByProject.set(project, objectivesFingerprint(objectives));
    }

    const candidates = await selectContradictionCandidates(pool, {
      projects: [...byProject.keys()],
      projectHashPairs: [...hashByProject].map(([p, h]) => `${p}:${h}`),
      lookbackDays,
      batch,
      maxAttempts,
      minContentChars,
    });
    s.candidates = candidates.length;
    if (candidates.length === 0) {
      s.note = 'no unjudged memories in window';
      s.elapsed_ms = elapsed();
      await completeJob(pool, jobId, s);
      return s;
    }

    const anthropic = deps.anthropic ?? (await createAnthropic());
    if (!anthropic) {
      // Unlike the extraction sweep there is no deterministic half here: a
      // contradiction is a semantic judgement or it is nothing. Skip WITHOUT
      // stamping the ledger — nothing was judged, so nothing may be marked as
      // judged, or these memories would be silently skipped forever once a key
      // does arrive.
      s.status = 'skipped';
      s.note = 'no_api_key — contradiction scan is model-only, ledger deliberately not stamped';
      s.elapsed_ms = elapsed();
      await completeJob(pool, jobId, s);
      return s;
    }

    for (let i = 0; i < candidates.length; i += concurrency) {
      if (elapsed() >= budgetMs || s.llm_calls_made >= maxLlmCalls) {
        s.skipped_budget = candidates.length - i;
        s.note = elapsed() >= budgetMs ? 'wall_clock_budget_exhausted' : 'llm_budget_exhausted';
        break;
      }
      const chunk = candidates.slice(i, i + concurrency);
      const results = await Promise.all(
        chunk.map((item) => {
          s.llm_calls_made += 1;
          return judgeOne(item, byProject.get(item.project) ?? [], anthropic);
        }),
      );

      for (let j = 0; j < chunk.length; j += 1) {
        const item = chunk[j] as ContradictionCandidate;
        const r = results[j] as Awaited<ReturnType<typeof judgeOne>>;
        s.processed += 1;

        const objectives = byProject.get(item.project) ?? [];
        const byId = new Map(objectives.map((o) => [objectiveKey(o), o]));
        let written = 0;

        if (!dryRun) {
          for (const v of r.verdicts) {
            const objective = byId.get(v.objective_id);
            if (!objective) continue;
            try {
              written += await insertFlag(pool, {
                flagType: 'contradiction',
                project: item.project,
                objectiveId: objective.id,
                objectiveText: objective.text,
                objectiveRank: objective.rank,
                memoryId: item.id,
                memoryGist: v.gist,
                severity: v.severity,
                rationale: v.rationale,
                dedupKey: contradictionDedupKey(item.id, objectiveKey(objective)),
              });
            } catch (err) {
              if (s.errors.length < 20) {
                s.errors.push({ id: item.id, error: `flag insert failed: ${(err as Error).message}` });
              }
            }
          }
        } else {
          written = r.verdicts.length;
        }

        s.flags_written += written;
        if (!r.ok) {
          if (s.errors.length < 20) s.errors.push({ id: item.id, error: r.error ?? 'unknown' });
        }

        if (!dryRun) {
          try {
            await recordScan(pool, {
              memoryId: item.id,
              status: r.ok ? 'ok' : 'error',
              flagsWritten: written,
              objectivesHash: hashByProject.get(item.project) ?? '',
              error: r.error,
            });
          } catch (err) {
            // Re-judged next run. Wasteful, never wrong — and far better than
            // aborting a pass over bookkeeping.
            if (s.errors.length < 20) {
              s.errors.push({ id: item.id, error: `ledger write failed: ${(err as Error).message}` });
            }
          }
        }
      }
    }
  } catch (err) {
    s.status = 'failed';
    s.error_message = (err as Error)?.message ?? String(err);
  }

  s.elapsed_ms = elapsed();
  await completeJob(pool, jobId, s);
  return s;
}

// ── phase 2: objective-coverage report ──────────────────────────────────────

export type LinkageSource = 'edges' | 'metadata' | 'both' | 'unavailable';

export async function probeLinkageSource(pool: PgPool): Promise<LinkageSource> {
  try {
    const { rows } = await pool.query(
      `select to_regclass('public.memory_relationships') is not null as edges,
              exists (
                select 1 from information_schema.columns
                 where table_schema = 'public'
                   and table_name   = 'memory_items'
                   and column_name  = 'metadata'
              ) as meta`,
    );
    const row = (rows[0] ?? {}) as { edges?: boolean; meta?: boolean };
    if (row.edges && row.meta) return 'both';
    if (row.edges) return 'edges';
    if (row.meta) return 'metadata';
    return 'unavailable';
  } catch {
    return 'unavailable';
  }
}

/**
 * The linkage predicate, composed from whatever substrate exists.
 *
 * `unavailable` yields `false`, which makes `linked` zero — and that is exactly
 * why the caller reports `drift: null` in that case rather than `drift: true`.
 * Zero linkage because there is nowhere to record linkage is not drift, and a
 * report that says otherwise launders a missing feature into an accusation.
 */
export function buildLinkagePredicate(source: LinkageSource): string {
  const edges = `exists (
      select 1 from public.memory_relationships r
       where (r.source_id = m.id and r.target_id::text = any($3::text[]))
          or (r.target_id = m.id and r.source_id::text = any($3::text[]))
    )`;
  const meta = `exists (
      select 1 from jsonb_array_elements_text(
        case when jsonb_typeof(m.metadata->'objectives') = 'array'
             then m.metadata->'objectives' else '[]'::jsonb end
      ) as o(v)
      where o.v = any($3::text[])
    )`;
  if (source === 'both') return `(${edges} or ${meta})`;
  if (source === 'edges') return edges;
  if (source === 'metadata') return meta;
  // Constant-false, but it must still MENTION $3 or Postgres rejects the bind
  // ("bind message supplies 3 parameters, but prepared statement requires 2")
  // and the undetermined path — the one that runs on every store until 038
  // lands — would be the only path that throws.
  return '(false and $3::text[] is not null)';
}

export interface CoverageRow {
  project: string;
  objective_count: number;
  memory_writes: number;
  linked_writes: number;
  coverage_ratio: number | null;
  linkage_source: LinkageSource;
  drift: boolean | null;
  note: string;
}

export async function computeProjectCoverage(
  pool: PgPool,
  opts: {
    project: string;
    objectiveIds: string[];
    objectiveCount: number;
    windowDays: number;
    minWrites: number;
    linkage: LinkageSource;
  },
): Promise<CoverageRow> {
  const { rows } = await pool.query(
    `select count(*)::int as writes,
            count(*) filter (where ${buildLinkagePredicate(opts.linkage)})::int as linked
       from public.memory_items m
      where m.project    = $1::text
        and m.is_active  = true
        and m.archived   = false
        and m.created_at > now() - make_interval(days => $2::int)`,
    [opts.project, opts.windowDays, opts.objectiveIds],
  );
  const row = (rows[0] ?? {}) as { writes?: number; linked?: number };
  const writes = row.writes ?? 0;
  const linked = row.linked ?? 0;

  const determined = opts.linkage !== 'unavailable' && opts.objectiveIds.length > 0;
  const ratio = determined && writes > 0 ? Number((linked / writes).toFixed(4)) : null;

  let drift: boolean | null = null;
  let note: string;
  if (!determined) {
    note =
      opts.linkage === 'unavailable'
        ? 'undetermined: no linkage substrate (memory_relationships / metadata.objectives absent)'
        : 'undetermined: objectives carry no ids to link against';
  } else if (writes < opts.minWrites) {
    drift = false;
    note = `below min_writes (${writes} < ${opts.minWrites}) — too small a sample to call drift`;
  } else if (linked === 0) {
    drift = true;
    note = `${writes} writes in window, zero linked to any of ${opts.objectiveCount} objectives`;
  } else {
    drift = false;
    note = `${linked}/${writes} writes linked to tier-0`;
  }

  return {
    project: opts.project,
    objective_count: opts.objectiveCount,
    memory_writes: writes,
    linked_writes: linked,
    coverage_ratio: ratio,
    linkage_source: opts.linkage,
    drift,
    note,
  };
}

export async function runObjectiveCoverageReport(
  pool: PgPool,
  options: GuardOptions = {},
  deps: GuardDeps = {},
): Promise<PhaseSummary> {
  const now = deps.now ?? (() => Date.now());
  const startedAt = now();
  const elapsed = () => now() - startedAt;
  const s = emptyPhase('coverage_report');

  const gate = guardGate(options);
  if (!gate.enabled) {
    s.status = 'skipped';
    s.note = gate.note;
    s.elapsed_ms = elapsed();
    return s;
  }

  const triggeredBy = options.triggeredBy ?? 'manual';
  const dryRun = options.dryRun ?? readBoolEnv('RUMEN_OBJECTIVE_DRY_RUN');
  const windowDays = options.coverageWindowDays ?? readIntEnv('RUMEN_OBJECTIVE_COVERAGE_WINDOW_DAYS', DEFAULT_COVERAGE_WINDOW_DAYS);
  const minWrites = options.coverageMinWrites ?? readIntEnv('RUMEN_OBJECTIVE_COVERAGE_MIN_WRITES', DEFAULT_COVERAGE_MIN_WRITES);

  const jobId = dryRun ? null : await createJob(pool, 'coverage_report', triggeredBy);

  try {
    const resolution = deps.resolution ?? (await resolveTier0Source(pool));
    s.tier0_source = resolution.kind;
    if (resolution.kind === 'unavailable' && !deps.fetchObjectives) {
      s.status = 'skipped';
      s.note = resolution.detail;
      s.elapsed_ms = elapsed();
      await completeJob(pool, jobId, s);
      return s;
    }

    const fetch =
      deps.fetchObjectives ??
      ((p: string | null) =>
        p === null ? fetchAllObjectives(pool, resolution) : fetchObjectivesFrom(pool, resolution, p));
    const all = await fetch(null);
    s.objectives_seen = all.length;
    const byProject = groupByProject(all);
    if (byProject.size === 0) {
      s.status = 'skipped';
      s.note = 'no tier-0 objectives in any project — coverage is undefined, not zero';
      s.elapsed_ms = elapsed();
      await completeJob(pool, jobId, s);
      return s;
    }

    const linkage = await probeLinkageSource(pool);
    s.candidates = byProject.size;

    for (const [project, objectives] of byProject) {
      const objectiveIds = objectives.map((o) => o.id).filter((id): id is string => !!id);
      let row: CoverageRow;
      try {
        row = await computeProjectCoverage(pool, {
          project,
          objectiveIds,
          objectiveCount: objectives.length,
          windowDays,
          minWrites,
          linkage,
        });
      } catch (err) {
        if (s.errors.length < 20) s.errors.push({ id: project, error: (err as Error).message });
        continue;
      }
      s.processed += 1;

      if (dryRun) {
        s.reports_written += 1;
        continue;
      }
      try {
        await pool.query(
          `insert into public.rumen_objective_coverage
             (job_id, project, window_days, window_start, window_end, objective_count,
              memory_writes, linked_writes, coverage_ratio, linkage_source, drift, note)
           values ($1::uuid, $2, $3::int, now() - make_interval(days => $3::int), now(),
                   $4::int, $5::int, $6::int, $7::numeric, $8, $9::boolean, $10)`,
          [
            jobId,
            row.project,
            windowDays,
            row.objective_count,
            row.memory_writes,
            row.linked_writes,
            row.coverage_ratio,
            row.linkage_source,
            row.drift,
            row.note,
          ],
        );
        s.reports_written += 1;
      } catch (err) {
        if (s.errors.length < 20) {
          s.errors.push({ id: project, error: `report insert failed: ${(err as Error).message}` });
        }
      }
    }

    if (linkage === 'unavailable') {
      s.note = 'linkage substrate unavailable — every report is undetermined (drift = null)';
    }
  } catch (err) {
    s.status = 'failed';
    s.error_message = (err as Error)?.message ?? String(err);
  }

  s.elapsed_ms = elapsed();
  await completeJob(pool, jobId, s);
  return s;
}

// ── phase 3: objective staleness ────────────────────────────────────────────

export interface StalenessAssessment {
  stale: boolean;
  ageDays: number | null;
  severity: 'low' | 'medium' | 'high';
  rationale: string;
}

/**
 * Age-only, and flags ONLY. Objectives never decay (seam §3) — the passage of
 * time is not evidence that an objective is wrong, it is evidence that nobody
 * has looked at it lately, and those are different claims. The flag says the
 * second one.
 */
export function assessStaleness(
  objective: Tier0Objective,
  opts: { thresholdDays: number; flagUnratified: boolean; nowMs: number },
): StalenessAssessment {
  const parsed = objective.ratified_at ? Date.parse(objective.ratified_at) : Number.NaN;

  if (!Number.isFinite(parsed)) {
    // Default OFF: on the marker arm ratified_at lives in metadata and is
    // commonly absent, so flagging it unconditionally would flag every
    // objective in the store on the first run — the exact queue-flood that
    // makes a review queue worthless.
    if (!opts.flagUnratified) {
      return { stale: false, ageDays: null, severity: 'low', rationale: '' };
    }
    return {
      stale: true,
      ageDays: null,
      severity: 'high',
      rationale:
        'Objective carries no ratification timestamp. Tier-0 rows are supposed to be ' +
        'mutable only via explicit ratification, so an objective with no recorded ' +
        'ratification cannot be shown to have been through that gate at all.',
    };
  }

  const ageDays = Math.floor((opts.nowMs - parsed) / (24 * 60 * 60 * 1000));
  if (ageDays < opts.thresholdDays) {
    return { stale: false, ageDays, severity: 'low', rationale: '' };
  }
  return {
    stale: true,
    ageDays,
    severity: ageDays >= opts.thresholdDays * 2 ? 'high' : 'medium',
    rationale:
      `Last ratified ${ageDays} days ago (threshold ${opts.thresholdDays}). Review whether ` +
      'this still states the project\'s current position; re-ratify it or supersede it. ' +
      'No automatic change has been or will be made.',
  };
}

export async function runObjectiveStalenessScan(
  pool: PgPool,
  options: GuardOptions = {},
  deps: GuardDeps = {},
): Promise<PhaseSummary> {
  const now = deps.now ?? (() => Date.now());
  const startedAt = now();
  const elapsed = () => now() - startedAt;
  const s = emptyPhase('staleness_scan');

  const gate = guardGate(options);
  if (!gate.enabled) {
    s.status = 'skipped';
    s.note = gate.note;
    s.elapsed_ms = elapsed();
    return s;
  }

  const triggeredBy = options.triggeredBy ?? 'manual';
  const dryRun = options.dryRun ?? readBoolEnv('RUMEN_OBJECTIVE_DRY_RUN');
  const thresholdDays = options.stalenessDays ?? readIntEnv('RUMEN_OBJECTIVE_STALENESS_DAYS', DEFAULT_STALENESS_DAYS);
  const flagUnratified = options.flagUnratified ?? readBoolEnv('RUMEN_OBJECTIVE_FLAG_UNRATIFIED');

  const jobId = dryRun ? null : await createJob(pool, 'staleness_scan', triggeredBy);

  try {
    const resolution = deps.resolution ?? (await resolveTier0Source(pool));
    s.tier0_source = resolution.kind;
    if (resolution.kind === 'unavailable' && !deps.fetchObjectives) {
      s.status = 'skipped';
      s.note = resolution.detail;
      s.elapsed_ms = elapsed();
      await completeJob(pool, jobId, s);
      return s;
    }

    const fetch =
      deps.fetchObjectives ??
      ((p: string | null) =>
        p === null ? fetchAllObjectives(pool, resolution) : fetchObjectivesFrom(pool, resolution, p));
    const all = await fetch(null);
    s.objectives_seen = all.length;
    s.candidates = all.length;
    if (all.length === 0) {
      // Same shape as the other two phases on purpose: "no objectives" is a
      // skip with a reason, not a clean pass over an empty set. The two read
      // identically in the ledger otherwise.
      s.status = 'skipped';
      s.note = 'no tier-0 objectives in any project — nothing to review';
      s.elapsed_ms = elapsed();
      await completeJob(pool, jobId, s);
      return s;
    }

    const nowMs = now();
    for (const objective of all) {
      const assessment = assessStaleness(objective, { thresholdDays, flagUnratified, nowMs });
      s.processed += 1;
      if (!assessment.stale) continue;

      if (dryRun) {
        s.flags_written += 1;
        continue;
      }
      try {
        s.flags_written += await insertFlag(pool, {
          flagType: 'staleness',
          project: objective.project,
          objectiveId: objective.id,
          objectiveText: objective.text,
          objectiveRank: objective.rank,
          memoryId: null,
          memoryGist: null,
          severity: assessment.severity,
          rationale: assessment.rationale,
          dedupKey: stalenessDedupKey(objectiveKey(objective), objective.ratified_at),
        });
      } catch (err) {
        if (s.errors.length < 20) {
          s.errors.push({
            id: objective.id ?? objective.text.slice(0, 40),
            error: `flag insert failed: ${(err as Error).message}`,
          });
        }
      }
    }
  } catch (err) {
    s.status = 'failed';
    s.error_message = (err as Error)?.message ?? String(err);
  }

  s.elapsed_ms = elapsed();
  await completeJob(pool, jobId, s);
  return s;
}

// ── entry point ─────────────────────────────────────────────────────────────

function guardGate(options: GuardOptions): { enabled: boolean; note: string } {
  if (options.enabled === true) return { enabled: true, note: '' };
  if (options.enabled === false) {
    return { enabled: false, note: 'disabled by caller (options.enabled = false)' };
  }
  if (readBoolEnv('RUMEN_OBJECTIVE_GUARD_ENABLED')) return { enabled: true, note: '' };
  return {
    enabled: false,
    note: 'dark by default — set RUMEN_OBJECTIVE_GUARD_ENABLED=1 to activate (Sprint 71 ships this lane OFF)',
  };
}

/**
 * Run all three phases against one latched tier-0 resolution.
 *
 * Order is deliberate: contradiction first (it is the only phase that spends
 * model tokens, so it gets the wall clock while there is still some), then
 * coverage, then staleness — the last two are pure SQL/arithmetic and finish in
 * milliseconds even on a large store. A phase that fails is recorded and the
 * next one still runs; there is no dependency between them beyond the shared
 * accessor.
 */
export async function runObjectiveGuard(
  pool: PgPool,
  options: GuardOptions = {},
  deps: GuardDeps = {},
): Promise<ObjectiveGuardSummary> {
  const now = deps.now ?? (() => Date.now());
  const startedAt = now();

  const gate = guardGate(options);
  if (!gate.enabled) {
    return {
      ok: true,
      enabled: false,
      tier0_source: 'unavailable',
      phases: [],
      elapsed_ms: now() - startedAt,
      note: gate.note,
    };
  }

  const resolution = deps.resolution ?? (await resolveTier0Source(pool));
  const sharedDeps: GuardDeps = { ...deps, resolution };
  const opts: GuardOptions = { ...options, enabled: true };

  console.log(
    `[rumen-objective-guard] starting: tier0=${resolution.kind} (${resolution.detail}) ` +
      `triggeredBy=${options.triggeredBy ?? 'manual'} dryRun=${opts.dryRun ?? readBoolEnv('RUMEN_OBJECTIVE_DRY_RUN')}`,
  );

  const phases: PhaseSummary[] = [];
  phases.push(await runContradictionScan(pool, opts, sharedDeps));
  phases.push(await runObjectiveCoverageReport(pool, opts, sharedDeps));
  phases.push(await runObjectiveStalenessScan(pool, opts, sharedDeps));

  const summary: ObjectiveGuardSummary = {
    ok: phases.every((p) => p.status !== 'failed'),
    enabled: true,
    tier0_source: resolution.kind,
    phases,
    elapsed_ms: now() - startedAt,
    note: resolution.kind === 'unavailable' ? resolution.detail : null,
  };

  console.log(
    `[rumen-objective-guard] complete: flags=${phases.reduce((n, p) => n + p.flags_written, 0)} ` +
      `reports=${phases.reduce((n, p) => n + p.reports_written, 0)} ` +
      `llmCalls=${phases.reduce((n, p) => n + p.llm_calls_made, 0)} ok=${summary.ok}`,
  );

  return summary;
}
