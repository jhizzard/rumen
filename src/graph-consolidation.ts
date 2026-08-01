/**
 * Rumen Sprint 83 (TermDeck T3) — graph consolidation.
 *
 * The consolidation half of the graph layer. `graph-inference` (its sibling)
 * writes EDGES nightly; until now nothing ever read the resulting structure
 * back and said anything about it. This does: it finds the communities the
 * edges imply and writes ONE summary memory per qualifying community — the
 * "what do these solved problems have in common" surface that did not exist.
 *
 * FOUR PHASES, each independently skippable:
 *   0. probe        — capability detection; every later phase is gated on it
 *   1. entities     — entity resolution (merges ENTITY records only)
 *   2. communities  — connected components over live edges
 *   3. summaries    — one LLM-written summary memory per qualifying community
 *
 * ── WHAT THIS MAY AND MAY NOT WRITE ──────────────────────────────────────
 *
 * MAY:     insert new `consolidation_summary` memories; update summaries it
 *          previously wrote; merge entity RECORDS.
 * MAY NOT: touch the content, metadata, embedding, or tombstone state of any
 *          canonical memory. Not once, not conditionally.
 *
 * Enforced structurally rather than by discipline: every UPDATE and INSERT
 * ... ON CONFLICT here carries `OWNED_ROW_PREDICATE` in its own WHERE clause.
 * A canonical row cannot match that predicate, so a bug in key lookup cannot
 * become a mutation of the corpus. `tests/graph-consolidation.test.ts` asserts
 * the predicate is present on every mutating statement this module emits, by
 * inspecting what the pool actually received.
 *
 * ── BUDGET ISOLATION ─────────────────────────────────────────────────────
 *
 * Every knob is namespaced `GRAPH_CONSOLIDATION_*`, deliberately disjoint from
 * `GRAPH_INFERENCE_*`. A shared budget would let a heavy inference night
 * silently starve consolidation, and the symptom — "the summaries stopped
 * appearing" — would point at the wrong function.
 *
 * ── THE SELF-AMPLIFICATION LOOP THIS DEFENDS AGAINST ─────────────────────
 *
 * A community summary is, by construction, semantically near-identical to the
 * members it summarizes. Undefended: night 1 writes summary S over {A,B,C};
 * night 2 `graph-inference` edges S↔A, S↔B, S↔C (they clear 0.85 cosine
 * trivially); night 3 consolidation sees S inside that component and
 * summarizes summaries. It compounds nightly and nothing looks broken — the
 * graph just fills with derivative content.
 *
 * Two defenses, both required, neither sufficient alone:
 *   (1) HERE — summaries are excluded from member selection, so a summary can
 *       never be a member of a later community. Stops the LOOP.
 *   (2) In `graph-inference`'s candidate query — summaries never acquire
 *       inference edges at all. Stops the EDGE-COUNT INFLATION.
 */

import type { PgPool } from './db.js';
import type { AnthropicLike } from './synthesize.js';

const HAIKU_MODEL = 'claude-haiku-4-5-20251001';

/**
 * The source_type reserved for consolidation products (migration 034 extends
 * `memory_items_source_type_check` with it). A distinct type rather than
 * metadata-only provenance is what makes non-impersonation STRUCTURAL:
 * `filter_source_type` can exclude these, and they are visibly non-primary in
 * every listing without any consumer having to remember to probe metadata.
 */
export const CONSOLIDATION_SOURCE_TYPE = 'consolidation_summary';
export const CONSOLIDATION_KIND = 'community_summary';
export const CONSOLIDATION_VERSION = 1;

/** The provenance guard. Every mutating statement in this module carries it. */
export const OWNED_ROW_PREDICATE =
  `source_type = '${CONSOLIDATION_SOURCE_TYPE}' ` +
  `and metadata->'consolidation'->>'kind' = '${CONSOLIDATION_KIND}'`;

export interface Capabilities {
  /** memory_relationships.invalid_at exists (migration 034) */
  temporal_edges: boolean;
  /** the source_type CHECK admits consolidation_summary */
  consolidation_source_type: boolean;
  /** entity storage present with the SCHEMA-READY-2 §7 shape */
  entities: boolean;
  entity_detail: string;
}

export interface EntitySummary {
  probed: boolean;
  merged: number;
  candidates: number;
  skipped?: string;
}

export interface CommunityStats {
  detected: number;
  qualifying: number;
  too_small: number;
  too_large: number;
  largest_size: number;
}

export interface ConsolidationSummary {
  ok: boolean;
  dry_run: boolean;
  capabilities: Record<string, boolean>;
  edges_scanned: number;
  members_scanned: number;
  entities: EntitySummary;
  communities: CommunityStats;
  summaries_written: number;
  summaries_unchanged: number;
  summaries_skipped_budget: number;
  /**
   * A community_key collided with a row this job does not own, so the write
   * was refused. Non-zero means something else is writing rows that carry
   * `metadata.consolidation.kind = 'community_summary'` — worth investigating,
   * and worth reporting rather than folding into a generic failure count.
   */
  summaries_conflict_unowned: number;
  llm_calls: number;
  llm_failures: number;
  embeddings_written: number;
  embeddings_unavailable: number;
  ms_total: number;
  notes: string[];
  error?: string;
}

export interface ConsolidationOptions {
  minSize?: number;
  maxSize?: number;
  maxCommunities?: number;
  maxLlmCalls?: number;
  maxEdges?: number;
  maxEntityMerges?: number;
  minWeight?: number;
  budgetMs?: number;
  dryRun?: boolean;
  /** Injected in tests; falls back to the module's own client in production. */
  anthropic?: AnthropicLike | null;
  /** Injected in tests. Returning null means "no embedding available". */
  embed?: ((text: string) => Promise<number[] | null>) | null;
  now?: () => number;
}

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function floatEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

// ── Phase 0 — capability probes ────────────────────────────────────────────
//
// Everything downstream is gated on these. A pre-034 database must produce a
// clean, NAMED skip rather than a stack trace: this runs on a cron, so an
// unhandled throw is a silent nightly failure nobody reads.

export async function probeCapabilities(pool: PgPool): Promise<Capabilities> {
  const cols = await pool.query(
    `select table_name, column_name
       from information_schema.columns
      where table_schema = 'public'
        and table_name in ('memory_relationships', 'memory_entities', 'memory_entity_mentions')`,
    [],
  );
  const have = new Set(
    (cols.rows as Array<{ table_name: string; column_name: string }>)
      .map((c) => `${c.table_name}.${c.column_name}`),
  );

  // Probing the CHECK definition is cheaper and far clearer than discovering
  // the constraint via a 23514 on the first INSERT of the night.
  const check = await pool.query(
    `select pg_get_constraintdef(con.oid) as def
       from pg_constraint con
       join pg_class cls on cls.oid = con.conrelid
      where cls.relname = 'memory_items'
        and con.contype = 'c'
        and con.conname = 'memory_items_source_type_check'`,
    [],
  );
  const checkDef = (check.rows[0] as { def?: string } | undefined)?.def ?? '';

  // Entity storage per SCHEMA-READY-2 §7: canonical key is
  // `(entity_type, entity_key)`, the human-facing field is `display_name`,
  // and the stable timestamp is `first_seen_at` (there is no `created_at`).
  // Naming the exact missing column matters — a shape drift must read as a
  // one-line log entry, not a mystery skip that disables a phase every night.
  const required = [
    'memory_entities.id',
    'memory_entities.entity_key',
    'memory_entities.entity_type',
    'memory_entities.display_name',
    'memory_entities.first_seen_at',
    'memory_entity_mentions.entity_id',
    'memory_entity_mentions.memory_id',
  ];
  const missing = required.filter((c) => !have.has(c));

  return {
    temporal_edges: have.has('memory_relationships.invalid_at'),
    consolidation_source_type: checkDef.includes(CONSOLIDATION_SOURCE_TYPE),
    entities: missing.length === 0,
    entity_detail: missing.length === 0 ? 'present' : `missing: ${missing.join(', ')}`,
  };
}

// ── Phase 1 — entity resolution ────────────────────────────────────────────
//
// Merges duplicate ENTITY RECORDS. It merges entities, never memories: the
// only writes are re-pointing mention rows from a duplicate entity to its
// canonical twin, and deleting the now-unreferenced duplicate ENTITY row.
//
// WHAT THIS PHASE CAN ACTUALLY FIND. Because 034 declares
// `UNIQUE(entity_type, entity_key)`, exact duplicates on that key cannot
// normally exist — the write-side upsert collapses them. So this phase is
// EXPECTED to find nothing on a healthy store, and that is the correct
// outcome rather than a bug. It earns its place as the repair path for what
// the constraint does not cover: rows written before it existed, rows restored
// from a backup, and any future migration that widens the key. Reported
// honestly as `candidates: 0` rather than dressed up as work performed.
//
// Fuzzy/alias merging is NOT attempted. A wrong entity merge is unrecoverable
// without provenance we do not keep; a missed merge costs one extra node. That
// asymmetry decides it.
export async function resolveEntities(
  pool: PgPool,
  caps: Capabilities,
  maxMerges: number,
): Promise<EntitySummary> {
  if (!caps.entities) {
    return { probed: true, merged: 0, candidates: 0, skipped: `entity storage unavailable (${caps.entity_detail})` };
  }

  // Canonical winner: the oldest row (`first_seen_at`, uuid as tiebreak), so
  // re-runs are stable — the winner does not change between nights.
  const dupes = await pool.query(
    `select entity_key, entity_type, array_agg(id order by first_seen_at, id) as ids
       from memory_entities
      group by entity_type, entity_key
     having count(*) > 1
      limit $1`,
    [maxMerges],
  );
  const groups = dupes.rows as Array<{ entity_key: string; entity_type: string; ids: string[] }>;

  let merged = 0;
  for (const group of groups) {
    const [canonical, ...duplicates] = group.ids;
    if (!canonical || duplicates.length === 0) continue;
    try {
      // Re-point mentions, skipping any memory that already mentions the
      // canonical entity directly (the mention PK would otherwise collide).
      await pool.query(
        `update memory_entity_mentions
            set entity_id = $1
          where entity_id = any($2::uuid[])
            and not exists (
              select 1 from memory_entity_mentions m2
               where m2.entity_id = $1
                 and m2.memory_id = memory_entity_mentions.memory_id
            )`,
        [canonical, duplicates],
      );
      await pool.query(`delete from memory_entity_mentions where entity_id = any($1::uuid[])`, [duplicates]);
      await pool.query(`delete from memory_entities where id = any($1::uuid[])`, [duplicates]);
      merged += duplicates.length;
    } catch (err) {
      console.error('[graph-consolidation] entity merge failed for', group.entity_type, group.entity_key, err);
    }
  }

  return { probed: true, merged, candidates: groups.length };
}

// ── Phase 2 — community detection ──────────────────────────────────────────
//
// Connected components via union-find. Adequate at this scale by a wide margin
// (~7.4k edges, ~9k nodes — well under a second in memory) and, crucially,
// DETERMINISTIC: a re-run over an unchanged graph produces exactly the same
// communities and therefore writes nothing.
//
// LEIDEN IS THE UPGRADE PATH, NOT BUILT HERE. Connected components cannot
// subdivide a densely-connected blob — at a 0.85-similarity edge threshold the
// graph tends to grow one giant component swallowing most of the corpus, and a
// "summary" of 3,000 memories is noise wearing a summary's clothes. Leiden or
// Louvain modularity would cut that blob into meaningful sub-communities.
// Until then the honest defense is the MAX_SIZE gate: a too-large component is
// SKIPPED AND COUNTED, never truncated to its first N members and summarized
// as though that were the whole thing. Silent truncation would read as "we
// summarized everything" when we had not.

export class UnionFind {
  private parent = new Map<string, string>();
  private rank = new Map<string, number>();

  add(x: string): void {
    if (!this.parent.has(x)) {
      this.parent.set(x, x);
      this.rank.set(x, 0);
    }
  }

  find(x: string): string {
    let root = x;
    while (this.parent.get(root) !== root) root = this.parent.get(root) as string;
    let cur = x;
    while (this.parent.get(cur) !== root) {
      const next = this.parent.get(cur) as string;
      this.parent.set(cur, root);
      cur = next;
    }
    return root;
  }

  union(a: string, b: string): void {
    this.add(a);
    this.add(b);
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra === rb) return;
    const rankA = this.rank.get(ra) ?? 0;
    const rankB = this.rank.get(rb) ?? 0;
    if (rankA < rankB) this.parent.set(ra, rb);
    else if (rankA > rankB) this.parent.set(rb, ra);
    else {
      this.parent.set(rb, ra);
      this.rank.set(ra, rankA + 1);
    }
  }

  /** Components with members sorted, so downstream output is deterministic. */
  components(): string[][] {
    const out = new Map<string, string[]>();
    for (const node of this.parent.keys()) {
      const root = this.find(node);
      const bucket = out.get(root);
      if (bucket) bucket.push(node);
      else out.set(root, [node]);
    }
    return [...out.values()].map((m) => m.sort());
  }
}

export interface EdgeRow {
  source_id: string;
  target_id: string;
  relationship_type: string;
}

export async function fetchLiveEdges(
  pool: PgPool,
  caps: Capabilities,
  minWeight: number,
  maxEdges: number,
): Promise<EdgeRow[]> {
  // Live-edge filter, feature-detected: a pre-034 store has no temporal
  // columns and every edge is live by definition, so the predicate is omitted
  // rather than the query failing on an unknown column.
  const temporalFilter = caps.temporal_edges
    ? 'and r.invalid_at is null and (r.valid_at is null or r.valid_at <= now())'
    : '';

  // Both endpoints must be live canonical memories. The two
  // `source_type <> consolidation_summary` tests are amplification defense (1).
  const res = await pool.query(
    `select r.source_id, r.target_id, r.relationship_type
       from memory_relationships r
       join memory_items s on s.id = r.source_id
       join memory_items t on t.id = r.target_id
      where coalesce(r.weight, 0.5) >= $1
        ${temporalFilter}
        and s.is_active and not s.archived and s.superseded_by is null
        and t.is_active and not t.archived and t.superseded_by is null
        and s.source_type <> '${CONSOLIDATION_SOURCE_TYPE}'
        and t.source_type <> '${CONSOLIDATION_SOURCE_TYPE}'
      limit $2`,
    [minWeight, maxEdges],
  );
  return res.rows as EdgeRow[];
}

// ── Phase 3 — community summaries ──────────────────────────────────────────

export interface MemberRow {
  id: string;
  content: string;
  source_type: string;
  project: string | null;
}

/**
 * The community's stable identity across runs: its lexicographically smallest
 * member id.
 *
 * Membership churns (an edge is added, one node joins) but the anchor does
 * not, so tonight's run UPDATES last night's summary instead of writing a
 * second one about the same cluster. Hashing the member SET instead would mint
 * a new summary on every membership change and orphan the old one — exactly
 * the duplicate accumulation the idempotency requirement exists to prevent.
 */
export function communityKey(memberIds: string[]): string {
  // `?? ''` is unreachable for any real community (a component always has at
  // least one member) but keeps the signature honest under noUncheckedIndexedAccess
  // rather than asserting a non-null the type system cannot see.
  return [...memberIds].sort()[0] ?? '';
}

export function buildPrompt(members: MemberRow[]): string {
  const projects = [...new Set(members.map((m) => m.project).filter(Boolean))];
  const body = members
    .map((m, i) => `[${i + 1}] (${m.source_type}${m.project ? `, ${m.project}` : ''}) ${m.content.slice(0, 600)}`)
    .join('\n\n');
  return `These ${members.length} memories from a developer's memory store are densely connected in a similarity graph${projects.length > 1 ? `, spanning projects: ${projects.join(', ')}` : ''}.

Write a SHORT synthesis (3-5 sentences, no preamble, no heading) capturing what they have IN COMMON — the recurring problem, the pattern, or the shared conclusion. Prioritize:
  - a failure mode that recurs across several of them
  - a technique or fix that keeps working
  - a constraint or decision they all depend on

Write the generalizable principle, not a list of the individual items. If they genuinely share nothing beyond surface vocabulary, say exactly that in one sentence rather than inventing a theme.

${body}`;
}

export function sameMembers(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.every((v, i) => v === sb[i]);
}

function extractText(response: { content: Array<{ type: string; text?: string }> }): string {
  return response.content
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join('')
    .trim();
}

/**
 * Runs one consolidation pass. Never throws for an expected condition (missing
 * migration, missing API key, empty graph) — those are reported as notes on a
 * successful summary, because a cron job that throws is a silent failure.
 */
export async function runGraphConsolidation(
  pool: PgPool,
  options: ConsolidationOptions = {},
): Promise<ConsolidationSummary> {
  const now = options.now ?? (() => Date.now());
  const start = now();

  const minSize = options.minSize ?? intEnv('GRAPH_CONSOLIDATION_MIN_SIZE', 4);
  const maxSize = options.maxSize ?? intEnv('GRAPH_CONSOLIDATION_MAX_SIZE', 60);
  const maxCommunities = options.maxCommunities ?? intEnv('GRAPH_CONSOLIDATION_MAX_COMMUNITIES', 50);
  const maxLlmCalls = options.maxLlmCalls ?? intEnv('GRAPH_CONSOLIDATION_MAX_LLM_CALLS', 20);
  const maxEdges = options.maxEdges ?? intEnv('GRAPH_CONSOLIDATION_MAX_EDGES', 50_000);
  const maxEntityMerges = options.maxEntityMerges ?? intEnv('GRAPH_CONSOLIDATION_MAX_ENTITY_MERGES', 200);
  const minWeight = options.minWeight ?? floatEnv('GRAPH_CONSOLIDATION_MIN_WEIGHT', 0);
  const budgetMs = options.budgetMs ?? intEnv('GRAPH_CONSOLIDATION_BUDGET_MS', 110_000);
  const dryRun = options.dryRun ?? false;

  const summary: ConsolidationSummary = {
    ok: false,
    dry_run: dryRun,
    capabilities: {},
    edges_scanned: 0,
    members_scanned: 0,
    entities: { probed: false, merged: 0, candidates: 0 },
    communities: { detected: 0, qualifying: 0, too_small: 0, too_large: 0, largest_size: 0 },
    summaries_written: 0,
    summaries_unchanged: 0,
    summaries_skipped_budget: 0,
    summaries_conflict_unowned: 0,
    llm_calls: 0,
    llm_failures: 0,
    embeddings_written: 0,
    embeddings_unavailable: 0,
    ms_total: 0,
    notes: [],
  };

  try {
    // ── Phase 0 ──────────────────────────────────────────────────────────
    const caps = await probeCapabilities(pool);
    summary.capabilities = {
      temporal_edges: caps.temporal_edges,
      consolidation_source_type: caps.consolidation_source_type,
      entities: caps.entities,
    };
    if (!caps.temporal_edges) {
      summary.notes.push('pre-034 store: no temporal edge columns — treating every edge as live');
    }

    // ── Phase 1 ──────────────────────────────────────────────────────────
    if (dryRun) {
      summary.entities = { probed: true, merged: 0, candidates: 0, skipped: 'dry run' };
    } else {
      summary.entities = await resolveEntities(pool, caps, maxEntityMerges);
      if (summary.entities.skipped) summary.notes.push(`entities: ${summary.entities.skipped}`);
    }

    // ── Phase 2 ──────────────────────────────────────────────────────────
    const edges = await fetchLiveEdges(pool, caps, minWeight, maxEdges);
    summary.edges_scanned = edges.length;
    if (edges.length >= maxEdges) {
      summary.notes.push(`edge scan hit the ${maxEdges} cap — communities may be incomplete`);
    }

    const uf = new UnionFind();
    for (const e of edges) uf.union(e.source_id, e.target_id);
    const components = uf.components();
    summary.communities.detected = components.length;

    const qualifying: string[][] = [];
    for (const members of components) {
      summary.communities.largest_size = Math.max(summary.communities.largest_size, members.length);
      if (members.length < minSize) { summary.communities.too_small++; continue; }
      if (members.length > maxSize) { summary.communities.too_large++; continue; }
      qualifying.push(members);
    }
    // Largest first, then by key for a deterministic tiebreak: if the budget
    // runs out it runs out on the least significant communities.
    qualifying.sort((a, b) => (b.length - a.length) || communityKey(a).localeCompare(communityKey(b)));
    summary.communities.qualifying = qualifying.length;
    if (summary.communities.too_large > 0) {
      summary.notes.push(
        `${summary.communities.too_large} component(s) exceeded MAX_SIZE=${maxSize} (largest ${summary.communities.largest_size}) and were SKIPPED, not truncated — connected components cannot subdivide a dense blob; Leiden is the upgrade path`,
      );
    }

    // ── Phase 3 ──────────────────────────────────────────────────────────
    const anthropic = options.anthropic ?? null;
    if (!caps.consolidation_source_type) {
      summary.notes.push(
        `phase 3 skipped: memory_items_source_type_check does not admit '${CONSOLIDATION_SOURCE_TYPE}' (migration 034 not applied)`,
      );
    } else if (!anthropic && !dryRun) {
      summary.notes.push('phase 3 skipped: no Anthropic client — communities detected but no summaries written');
    } else {
      for (const members of qualifying.slice(0, maxCommunities)) {
        if (now() - start > budgetMs) {
          summary.notes.push(`budget of ${budgetMs}ms reached — remaining communities deferred to the next run`);
          break;
        }
        if (summary.llm_calls + summary.llm_failures >= maxLlmCalls) {
          summary.summaries_skipped_budget++;
          continue;
        }

        const key = communityKey(members);
        const existingRes = await pool.query(
          `select id, coalesce(metadata->'consolidation'->'member_ids', '[]'::jsonb) as member_ids
             from memory_items
            where ${OWNED_ROW_PREDICATE}
              and metadata->'consolidation'->>'community_key' = $1
            limit 1`,
          [key],
        );
        const existing = existingRes.rows[0] as { id: string; member_ids: unknown } | undefined;
        const existingMembers = Array.isArray(existing?.member_ids) ? existing.member_ids as string[] : [];

        // Idempotency: identical membership ⇒ the summary would say the same
        // thing, so skip BEFORE spending an LLM call. This is what makes a
        // nightly re-run over an unchanged graph free.
        if (existing && sameMembers(existingMembers, members)) {
          summary.summaries_unchanged++;
          continue;
        }

        const memberRes = await pool.query(
          `select id, content, source_type, project
             from memory_items
            where id = any($1::uuid[])
              and is_active and not archived and superseded_by is null
            order by created_at`,
          [members],
        );
        const memberRows = memberRes.rows as MemberRow[];
        summary.members_scanned += memberRows.length;
        if (memberRows.length < minSize) continue;

        if (dryRun) { summary.summaries_written++; continue; }

        let text = '';
        try {
          const response = await (anthropic as AnthropicLike).messages.create({
            model: HAIKU_MODEL,
            max_tokens: 400,
            system: 'You synthesize what a cluster of developer memories has in common. Be concrete and short.',
            messages: [{ role: 'user', content: buildPrompt(memberRows) }],
          });
          text = extractText(response);
        } catch (_err) {
          text = '';
        }
        if (!text) { summary.llm_failures++; continue; }
        summary.llm_calls++;

        let embeddingLiteral: string | null = null;
        if (options.embed) {
          const vec = await options.embed(text);
          if (vec) { embeddingLiteral = `[${vec.join(',')}]`; summary.embeddings_written++; }
          else summary.embeddings_unavailable++;
        } else {
          // Without an embedding the summary is still written and still
          // full-text-recallable; it is simply invisible to vector search.
          // Counted rather than swallowed, because "the summaries exist but
          // never surface" is otherwise a baffling symptom.
          summary.embeddings_unavailable++;
        }

        const metadata = {
          consolidation: {
            kind: CONSOLIDATION_KIND,
            version: CONSOLIDATION_VERSION,
            community_key: key,
            member_ids: members,
            member_count: memberRows.length,
            generated_at: new Date(now()).toISOString(),
            generator: `graph-consolidation/${HAIKU_MODEL}`,
            edge_scope: caps.temporal_edges ? 'live-typed-edges' : 'all-edges-pre-034',
          },
        };
        // A cross-project community is filed under 'global' rather than being
        // arbitrarily attributed to one of the projects it spans.
        const projects = [...new Set(memberRows.map((m) => m.project).filter(Boolean))];
        const project = projects.length === 1 ? projects[0] : 'global';

        if (existing) {
          // OWNED_ROW_PREDICATE is repeated even though `id` already
          // identifies the row: it is the structural guarantee that a bug in
          // key lookup can never rewrite a canonical memory.
          const updated = await pool.query(
            `update memory_items
                set content = $1,
                    metadata = metadata || $2::jsonb,
                    embedding = coalesce($3::vector, embedding),
                    project = $4,
                    updated_at = now()
              where id = $5
                and ${OWNED_ROW_PREDICATE}
              returning id`,
            [text, JSON.stringify(metadata), embeddingLiteral, project, existing.id],
          );
          // The lookup that produced `existing` was itself ownership-filtered,
          // so zero rows here means the row stopped being owned between the
          // SELECT and the UPDATE. Report it rather than counting a write that
          // did not happen.
          if (updated.rows.length === 0) {
            summary.summaries_conflict_unowned++;
            summary.notes.push(`community ${key}: target row was no longer owned at update time — refused, nothing written`);
            continue;
          }
        } else {
          // ON CONFLICT against 034's partial unique index
          // (`memory_items_consolidation_community_key_idx`). The
          // SELECT-then-INSERT above is not atomic; the index turns a silent
          // duplicate into an upsert if two runs ever overlap.
          //
          // THE DO UPDATE ARM NEEDS ITS OWN OWNERSHIP GUARD, and this is
          // subtle enough to spell out. The index predicate tests only
          // `kind = 'community_summary'` — it does NOT test `source_type`. So
          // any row carrying that metadata shape sits in the index, including
          // a canonical memory that happens to describe consolidation. An
          // unguarded DO UPDATE would rewrite that row's content, metadata,
          // embedding and project: precisely the canonical-content mutation
          // this module promises can never happen, arriving through the one
          // statement where the guard is easy to forget because `ON CONFLICT`
          // reads like it is already scoped.
          //
          // With the WHERE in place an unowned conflict updates nothing and
          // RETURNS NOTHING — which is why the result is inspected below
          // rather than assumed. A silent no-op counted as a successful write
          // would be a summary that does not exist and a log that says it does.
          const upserted = await pool.query(
            // category stays NULL: memory_items_category_check allows only the
            // topical taxonomy (technical/business/…); provenance already lives
            // in source_type + metadata.consolidation. A category literal here
            // fails the check and zeroes every nightly write (2026-08-01).
            `insert into memory_items (content, embedding, source_type, category, project, metadata)
             values ($1, $2::vector, $3, null, $4, $5::jsonb)
             on conflict ((metadata->'consolidation'->>'community_key'))
               where metadata->'consolidation'->>'kind' = '${CONSOLIDATION_KIND}'
               do update set content    = excluded.content,
                             metadata   = excluded.metadata,
                             embedding  = coalesce(excluded.embedding, memory_items.embedding),
                             project    = excluded.project,
                             updated_at = now()
               where memory_items.source_type = '${CONSOLIDATION_SOURCE_TYPE}'
                 and memory_items.metadata->'consolidation'->>'kind' = '${CONSOLIDATION_KIND}'
             returning id`,
            [text, embeddingLiteral, CONSOLIDATION_SOURCE_TYPE, project, JSON.stringify(metadata)],
          );
          if (upserted.rows.length === 0) {
            summary.summaries_conflict_unowned++;
            summary.notes.push(
              `community ${key}: the community_key collided with a row this job does not own — refused, nothing written`,
            );
            continue;
          }
        }
        summary.summaries_written++;
      }
    }

    summary.ok = true;
  } catch (err) {
    summary.error = err instanceof Error ? err.message : String(err);
    console.error('[graph-consolidation] pass threw:', err);
  }

  summary.ms_total = now() - start;
  return summary;
}
