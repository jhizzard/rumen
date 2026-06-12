# Contributing to Rumen

Thanks for taking an interest. Rumen is small on purpose — please keep contributions focused and easy to review.

## Ground rules

1. **Rumen is non-destructive.** Rumen never modifies or deletes existing memory rows. Exactly three write surfaces outside `rumen_*` exist, each deliberate and documented (see `docs/MNESTRA-COMPATIBILITY.md` § What Rumen writes): the `memory_sessions.rumen_processed_at` idempotency stamp (Sprint 53), and the Sprint 76 promotion pass's INSERTs into `memory_items` plus status/metadata UPDATEs on `memory_inbox` rows it claimed. A PR that adds ANY other write path to a non-`rumen_*` table — or any UPDATE/DELETE touching existing memory content anywhere — will be rejected.
2. **No LLM calls in v0.1.** Synthesis, question generation, and any calls to Anthropic/OpenAI/etc. are reserved for v0.2+. A v0.1 PR that adds a model call will be rejected.
3. **Raw `pg` only, no ORMs.** See `docs/MNESTRA-COMPATIBILITY.md` for the reasoning.
4. **Deno-compatible Edge Function.** Anything in `supabase/functions/` must run under Deno without a bundler. Keep imports standard-library or `npm:` specifiers.

## Style

- TypeScript strict mode. `npx tsc --noEmit` must pass.
- Prefer small, composable functions over clever generics.
- No emojis in source or docs unless the user explicitly asks.
- Every `console.log` / `console.error` must use one of the `[rumen-*]` tags. See `README.md` for the table.

## Logging convention

Mirroring TermDeck's `[tag]` style:

- `[rumen]` — job lifecycle
- `[rumen-extract]` — extract phase
- `[rumen-relate]` — relate phase
- `[rumen-synthesize]` — reserved for v0.2
- `[rumen-question]` — reserved for v0.3
- `[rumen-surface]` — surface phase
- `[rumen-promote]` — memory_inbox promotion pass

Format: `console.error('[rumen-extract] failed for session ' + sessionId + ':', err);`

## Local development

```bash
npm install
npm run typecheck
npm run test:local     # runs scripts/test-locally.ts against a local Postgres
```

You will need a Postgres database with Mnestra's schema applied. See `docs/MNESTRA-COMPATIBILITY.md`.

## Pull requests

- Keep PRs small. One phase (Extract, Relate, or Surface) per PR is ideal.
- Include a short note in `CHANGELOG.md` under the `## [Unreleased]` header.
- If a PR changes SQL, include both the migration file and an explanation of the rollback plan.
- If a PR changes the Edge Function shape, update `README.md`'s deploy section.

## Filing issues

Please include:
- Which version of Rumen.
- Which phase (`[rumen-extract]` / `[rumen-relate]` / `[rumen-surface]`) the issue is in.
- The log output (redacted of any memory content that isn't yours to share).

## License

By contributing, you agree your work is released under the MIT license.
