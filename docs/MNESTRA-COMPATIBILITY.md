# Mnestra compatibility contract (Rumen v0.1)

Rumen v0.1 is **tightly coupled** to the schema exposed by [Mnestra](https://github.com/jhizzard/mnestra). Future Rumen versions may abstract this behind an adapter layer, but v0.1 reads Mnestra's tables and calls Mnestra's SQL functions directly. If your memory store does not follow the Mnestra schema, Rumen v0.1 will not work.

This document is the frozen contract for v0.1. Any change here is a breaking change and requires a minor version bump.

## Why coupled?

See the Podium lessons referenced in the RUMEN pre-deployment checklist: Rumen is intentionally small (~200 LOC in v0.1) and uses raw `pg` rather than Prisma. Introducing an adapter layer would roughly double the surface area for no v0.1 benefit. Mnestra is the first and currently only consumer, so we couple now and abstract later if a second memory store needs to plug in.

## Required tables

### `memory_items`

| Column        | Type              | Required | Used by Rumen |
|---|---|---|---|
| `id`          | `uuid`            | yes      | Rumen stores these in `rumen_insights.source_memory_ids`. |
| `content`     | `text`            | yes      | Rumen falls back to concatenated content when a session has no summary. |
| `source_type` | `text`            | yes      | Returned in relate results; reserved for v0.2 weighting. |
| `project`     | `text` (nullable) | yes      | Written to `rumen_insights.projects[]`. |
| `created_at`  | `timestamptz`     | yes      | Used for lookback filtering indirectly via session join. |
| `session_id`  | `uuid` (nullable) | yes      | Join key from `memory_items` back to `memory_sessions`. |
| `embedding`   | `vector(1536)`    | yes (for v0.2) | v0.1 does NOT read embeddings directly; it calls `memory_hybrid_search` which does. |

v0.1 never writes to `memory_items`. Rumen is strictly a reader of Mnestra's memory tables.

### `memory_sessions`

| Column        | Type              | Required | Used by Rumen |
|---|---|---|---|
| `id`          | `uuid`            | yes      | Stored in `rumen_jobs.source_session_ids`. |
| `project`     | `text` (nullable) | yes      | Copied into signal metadata. |
| `summary`     | `text` (nullable) | yes      | v0.1's primary search text. |
| `created_at`  | `timestamptz`     | yes      | Lookback filter (last 72 hours by default). |

v0.1 never writes to `memory_sessions`.

## Required SQL function

### `memory_hybrid_search`

Signature expected by Rumen v0.1:

```sql
memory_hybrid_search(
  query_text      text,
  query_embedding vector(1536),
  limit_count     int,
  project_filter  text
) RETURNS TABLE (
  id          uuid,
  content     text,
  source_type text,
  project     text,
  created_at  timestamptz,
  similarity  numeric
)
```

- Rumen calls this with `query_embedding := NULL` in v0.1. Mnestra's implementation must fall back to keyword-only (tsvector) matching when the embedding argument is NULL. v0.2 will start passing a real embedding.
- Rumen passes `project_filter := NULL` to search across all projects. Cross-project prior art is the core value Rumen delivers.
- `similarity` is expected in the range `[0, 1]`. Rumen thresholds at `0.7` by default.

If your Mnestra fork returns additional columns, Rumen will ignore them — the column list above is the minimum.

## What Rumen writes

Rumen's default posture: it writes to its own tables — `rumen_jobs`, `rumen_insights`, `rumen_questions`, and, as of Sprint 79, `doctrine_registry` / `doctrine_jobs` (named per the doctrine-scan DISPATCH-GUIDE, not `rumen_`-prefixed, but exclusively written by Rumen's own doctrine-scan pass and part of the same non-destructive safe zone) — and **never modifies or deletes existing memory content**. Exactly four write surfaces outside Rumen's own tables exist, each deliberate, narrow, and documented:

1. **`memory_sessions.rumen_processed_at` stamp** (v0.5 / Sprint 53, `src/index.ts::stampSessionsProcessed`) — the insight cycle's idempotency guard. Sets one timestamp column on sessions the picker consumed; touches no content fields.
2. **`memory_items` INSERTs by the promotion pass** (v0.6 / Sprint 76, `src/promote.ts`) — promoting quarantined web-chat proposals from `memory_inbox` (engram migration 026) into canonical memory, reproducing `remember.ts` canonical-write semantics (text-embedding-3-large @ 1536, `match_memories` dedup at 0.88/0.95). New rows only. The near-duplicate band (0.88–0.95) REJECTS the proposal rather than updating the canonical near-dup — deliberately tighter than `remember.ts`: web-originated content must never mutate a canonical row.
3. **`memory_inbox` status/metadata UPDATEs by the promotion pass** (same sprint) — claim stamps, `status` transitions (`pending` → `promoted`/`rejected`), `promoted_memory_id`, `rejection_reason`, and attempt counters, only on rows the pass claimed. Inbox rows are never deleted; they are the audit trail.
4. **`memory_items.recall_boost` writes by the reinforce pass** (Sprint 81, `src/reinforce.ts`) — the recall-feedback loop. Writes ONE bounded reinforcement weight per recently-recalled memory to `recall_boost` (a dedicated column added by engram migration 032, analogous to `doctrine_registry.occurrence_count`), and does so ONLY through the service-role `set_recall_boost(jsonb)` RPC — never a raw `UPDATE memory_items`. The weight is clamped to `[1.0, 2.0]`; `1.0` is a strict no-op multiplier, so a never-recalled memory is untouched (this honors the pruning moratorium). It NEVER touches content, embedding, source_type, project, or any other column, and NEVER inserts or deletes a row. The reinforcement signal is derived from recall telemetry (`recall_count` / `last_recalled_at` denorm + the `cited` flag in `memory_recall_log`), which Rumen only reads.

The core safety rule stands: **Rumen never modifies existing memory CONTENT.** No raw `UPDATE` or `DELETE` is ever issued against `memory_items` from Rumen's code; the only mutation of an existing `memory_items` row is the column-scoped `recall_boost` write in surface 4, delegated to an RPC that can touch nothing else. No write path outside the four above may be added. Every PR to Rumen must preserve this. See `CONTRIBUTING.md` ground rule 1.

## Breaking the contract

If Mnestra renames a column or changes a signature:

- **Rename a column in `memory_items` or `memory_sessions`** → Rumen v0.1 `extract.ts` must be updated; bump Rumen minor.
- **Change `memory_hybrid_search` signature** → Rumen v0.1 `relate.ts` must be updated; bump Rumen minor.
- **Remove a required column** → Rumen cannot run until fixed; treat as major.

## Forward path

v0.5+ is the likely home for an adapter abstraction: `RumenMemoryStore` interface with `fetchRecentSessions`, `searchRelated`, etc. Until then, if you need to run Rumen on top of a non-Mnestra store, fork `extract.ts` and `relate.ts` rather than trying to configure around them.
