# Rumen — Install

This is the install guide for deploying Rumen against your own Mnestra-compatible Postgres instance. If you're looking at the architecture, start with [README.md](README.md); this file assumes you've decided to install and want to finish in 20 minutes.

**Last verified:** 2026-04-15 against a production Supabase project (macOS 13, Supabase CLI v2.75, Node 18, Deno 2.7). Rumen v0.4.0.

---

## 🚨 READ THIS FIRST — Five gotchas that cost hours on first deploy

Every one of these cost real debugging time in at least one production install. Read them before you start, not after.

1. **Supabase's Connect modal has a hidden IPv4 toggle.** Under **Transaction pooler** there is a switch labeled **"Use IPv4 connection (Shared Pooler)"**. It is **OFF by default.** Leave it off and you get the *Dedicated Pooler* URL (`db.<ref>.supabase.co:6543`), which is **IPv6-only** since early 2024 and will fail with `Connection refused` from most networks unless you've bought the IPv4 add-on. **Toggle it ON**, then copy the URL — the host switches to `aws-0-<region>.pooler.supabase.com` and the user switches from `postgres` to `postgres.<project_ref>`. Never hand-build this URL.

2. **Supabase's password-reset field takes the LITERAL string.** It does not URL-decode your input. If you type `p%40ss` thinking that's `p@ss` encoded, your stored password is now the literal `p%40ss` and you will loop on auth failures. **Always type the raw password into the dashboard.** URL-encoding only happens when you hand-build a URI. Easiest escape hatch: **pick alphanumeric-only passwords** so no encoding is ever needed.

3. **Rumen uses `DATABASE_URL` ONLY — do NOT set `DIRECT_URL`.** Setting `DIRECT_URL` alongside the pooler user format throws *"Tenant or user not found"* from Supavisor. In your `.env`, set only `DATABASE_URL` to the Shared Pooler URI. Older Rumen docs recommended `DIRECT_URL` — that recommendation is wrong.

4. **Do NOT append `?pgbouncer=true` to the URL.** It is a Prisma-specific query parameter. libpq (psql) and node-postgres both reject it with `invalid URI query parameter: "pgbouncer"`. If an older doc or template tells you to add it, ignore that doc.

5. **macOS 13 cannot install Deno via Homebrew.** Brew's `deno` formula requires a full Xcode 15 install, not just Command Line Tools. Use Deno's official install script instead — it ships a prebuilt binary with zero build dependencies: `curl -fsSL https://deno.land/install.sh | sh`. Deno is required because Rumen runs as a Supabase Edge Function and `supabase functions deploy` uses the local Deno toolchain for bundling.

---

## Prerequisites

- **Node.js 18+** — for the `supabase` CLI and any local test runs
- **Deno 2+** — for Supabase Edge Function deploys (install via `curl -fsSL https://deno.land/install.sh | sh` on macOS 13, or `brew install deno` on macOS 14+)
- **Supabase CLI v2.75+** — `brew install supabase/tap/supabase`
- **A Supabase project** with the `vector` extension enabled. Free tier works; paid tier recommended for any real workload (see `#1` above on the IPv4 toggle)
- **A Mnestra-compatible schema** in that Supabase project. If you don't have one yet, install [Mnestra](https://github.com/jhizzard/mnestra) first — it provisions `memory_items`, `memory_sessions`, `memory_relationships`, and the `memory_hybrid_search` SQL function that Rumen reads from
- **An Anthropic API key** for Claude Haiku synthesis (`sk-ant-api03-...`). Rumen's v0.3 synthesize phase uses Haiku by default
- **A Supabase personal access token** — generate at https://supabase.com/dashboard/account/tokens, keep it in your shell environment as `SUPABASE_ACCESS_TOKEN`

---

## Step 1 — Install Deno (if missing)

```bash
which deno || curl -fsSL https://deno.land/install.sh | sh
```

Add to `~/.zshrc` (or equivalent):
```bash
export DENO_INSTALL="$HOME/.deno"
export PATH="$DENO_INSTALL/bin:$PATH"
```

Open a fresh shell and verify:
```bash
deno --version
```

**Do not use `brew install deno` on macOS 13** — see gotcha #5.

---

## Step 2 — Prepare your Supabase project

In the Supabase dashboard for your target project:

1. **Reset the database password.** Project Settings → Database → Reset database password. **Use an alphanumeric-only password** (gotcha #2). Wait for the "Password updated" toast confirmation.

2. **Grab the Shared Pooler URL.** Click the green **Connect** button at the top of the dashboard → **Transaction pooler** tab → **toggle ON "Use IPv4 connection (Shared Pooler)"** (gotcha #1). Type your raw password into the password input at the top of the modal — it live-substitutes into the displayed URL. Copy the whole URL.

3. **Enable `pg_cron` and `pg_net`.** Dashboard → Integrations (or "Database → Extensions" on older UIs) → enable `pg_cron`. Then in SQL Editor:
   ```sql
   create extension if not exists pg_net;
   ```
   Verify both:
   ```sql
   select extname, extversion from pg_extension where extname in ('pg_cron','pg_net');
   ```
   Should return two rows.

4. **Add the service_role key to Supabase Vault.** Settings → API → copy the **service_role** key (NOT the anon key). Then Database → Vault → New secret. Name: **`rumen_service_role_key`** (exact name — the pg_cron SQL reads it by this key). Secret: paste the service_role key. Save.

---

## Step 3 — Create `.env`

In whatever directory you keep Rumen's deploy config (e.g. `~/.rumen/` or a dedicated repo checkout):

```env
DATABASE_URL="<paste the Shared Pooler URL from Step 2 — with the real password, no pgbouncer param>"
ANTHROPIC_API_KEY=sk-ant-api03-...
```

That's it. Two keys. No `DIRECT_URL` (gotcha #3). No `?pgbouncer=true` (gotcha #4).

Sanity check the DB connection:
```bash
set -a; source .env; set +a
psql "$DATABASE_URL" -c "select 1"
```

Expect `(1 row)`. If you get `Connection refused`, you skipped the IPv4 toggle — go back to Step 2 item 2. If you get `Tenant or user not found`, you either have `DIRECT_URL` set or your pooler username is missing the `.<project_ref>` suffix. If you get `password authentication failed`, reset the password again (gotcha #2) and try alphanumeric-only.

---

## Step 4 — Apply Rumen's schema

Rumen v0.4.0's `001_rumen_tables.sql` is **self-healing** — it handles both cold installs and schema-drifted installs from earlier Rumen versions. Run it:

```bash
psql "$DATABASE_URL" -f migrations/001_rumen_tables.sql
```

Three tables get created (or updated): `rumen_jobs`, `rumen_insights`, `rumen_questions`.

---

## Step 5 — Deploy the Edge Function

If you're deploying standalone (without TermDeck), follow Rumen's own Edge Function template at `supabase/functions/rumen-tick/index.ts` in this repo.

If you're using TermDeck's `init-rumen` wizard (recommended — it automates every remaining step), jump to [TermDeck's Rumen wizard section](#using-termdecks-init-rumen-wizard) below.

Manual deploy:

```bash
supabase link --project-ref <your-project-ref>
supabase functions deploy rumen-tick --no-verify-jwt
supabase secrets set DATABASE_URL="$DATABASE_URL" ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY"
```

---

## Step 6 — Schedule the cron

Edit `migrations/002_pg_cron_schedule.sql` and replace the function URL placeholder with your project's actual Edge Function URL (`https://<project_ref>.supabase.co/functions/v1/rumen-tick`). Then:

```bash
psql "$DATABASE_URL" -f migrations/002_pg_cron_schedule.sql
```

Verify the schedule landed:
```sql
select jobname, schedule, active from cron.job where jobname like 'rumen%';
```

Should return a row with `active = true`.

---

## Step 7 — Test manually

Hit the function with a manual POST:
```bash
curl -X POST https://<project_ref>.supabase.co/functions/v1/rumen-tick \
  -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY"
```

Should return a JSON summary with `status: "done"`. If you have memory_items in your Mnestra store, `sessions_processed` and `insights_generated` will be non-zero.

Watch the first scheduled run:
```sql
select id, status, sessions_processed, insights_generated, started_at
from rumen_jobs
order by started_at desc nulls last
limit 5;
```

---

## Using TermDeck's init-rumen wizard

If you already use [TermDeck](https://github.com/jhizzard/termdeck), skip Steps 5-6 above and run:

```bash
termdeck init --rumen --yes
```

The wizard does steps 4-7 for you, including:
- Resolving the latest published `@jhizzard/rumen` version from npm at deploy time
- Applying `001_rumen_tables.sql` (self-healing)
- Staging the Edge Function source with the correct rumen version pinned
- Running `supabase functions deploy rumen-tick`
- Setting function secrets
- Applying the pg_cron schedule
- POSTing a manual test invocation and reporting the result

You still need to complete Steps 1–3 (Deno, Supabase project prep, `.env`) before running the wizard.

---

## Troubleshooting (beyond the five gotchas)

| Symptom | Fix |
|---|---|
| `could not connect to server ... Unix domain socket` | `$DATABASE_URL` isn't set in your shell. `echo "$DATABASE_URL"` to confirm; re-source `.env` with `set -a; source .env; set +a`. |
| `Connection refused` on `db.<ref>.supabase.co` | You have the Dedicated Pooler URL. Go back to the Connect modal and **toggle ON "Use IPv4 connection (Shared Pooler)"**. |
| `Tenant or user not found` | Either `DIRECT_URL` is set (unset it), or your username is `postgres` instead of `postgres.<project_ref>`. Copy the URL fresh from the dashboard after toggling IPv4. |
| `invalid URI query parameter: "pgbouncer"` | Strip `?pgbouncer=true` — it's Prisma-only. |
| `password authentication failed` | Password has unencoded specials, or the reset never saved. Reset to alphanumeric-only (gotcha #2). |
| `column "X" does not exist` on `rumen_jobs` | Old Rumen tables from a failed install. Rumen v0.4.0's migration 001 is self-healing — just re-run it. |
| `Could not find npm package '@jhizzard/rumen' matching 'X.Y.Z'` | The Edge Function source has a stale version pin. If you use the TermDeck wizard, it auto-resolves from npm. If you deploy manually, update the import line in `supabase/functions/rumen-tick/index.ts` to match the latest published version. |
| `function memory_hybrid_search(...) does not exist` | Your Mnestra schema is older than Rumen expects. Apply Mnestra migration 006 or later. |
| `column "similarity" does not exist` | You're on Rumen < 0.3.2. Upgrade to 0.4.0+. |
| Rumen runs but `sessions_processed=0` | No eligible sessions — either your lookback window is too narrow, or `memory_items.source_session_id` is NULL for most rows, or the sessions have fewer than `minEventCount` events. Check with: `SELECT source_session_id, COUNT(*) FROM memory_items GROUP BY 1 HAVING COUNT(*) >= 3 LIMIT 10;` |
| All matches fail the similarity threshold | Rumen's default `minSimilarity` in 0.4.0 is `0.01` — appropriate for the RRF+recency-decay scores Mnestra's `memory_hybrid_search` returns. If you're on 0.3.2 or earlier with a 0.7 default, upgrade. |

---

## Kickstart (process all historical memories at once)

After a successful deploy, run:

```bash
cd <your-rumen-checkout>
npm run kickstart
```

This widens the lookback window to 5 years and raises the per-run session cap to 200, processing every eligible session in your Mnestra store in one local invocation. Useful right after first-install to bootstrap `rumen_insights` from existing history instead of waiting for pg_cron to drain it over many hours.

The kickstart respects the same "already processed" idempotency as the scheduled runs, so re-running it is safe.

---

## License

MIT © Joshua Izzard. See [LICENSE](LICENSE).
