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

Rumen **only** writes to its own tables (`rumen_jobs`, `rumen_insights`, `rumen_questions`). It never INSERTs, UPDATEs, or DELETEs any row in `memory_items` or `memory_sessions`.

This is the core safety rule and every PR to Rumen must preserve it. See `CONTRIBUTING.md`.

## Breaking the contract

If Mnestra renames a column or changes a signature:

- **Rename a column in `memory_items` or `memory_sessions`** → Rumen v0.1 `extract.ts` must be updated; bump Rumen minor.
- **Change `memory_hybrid_search` signature** → Rumen v0.1 `relate.ts` must be updated; bump Rumen minor.
- **Remove a required column** → Rumen cannot run until fixed; treat as major.

## Forward path

v0.5+ is the likely home for an adapter abstraction: `RumenMemoryStore` interface with `fetchRecentSessions`, `searchRelated`, etc. Until then, if you need to run Rumen on top of a non-Mnestra store, fork `extract.ts` and `relate.ts` rather than trying to configure around them.
