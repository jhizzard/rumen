# Installer Pitfalls — pointer

The canonical synthesis of every install/upgrade incident across the TermDeck + Mnestra + Rumen stack lives in TermDeck:

**`~/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/docs/INSTALLER-PITFALLS.md`**

Read it before any work that touches:
- Rumen migrations (`packages/server/src/setup/rumen-migrations/00*.sql` in TermDeck)
- The `rumen-tick` or `graph-inference-tick` cron jobs
- The `graph-inference` Edge Function (bundled from this repo into `@jhizzard/termdeck/packages/server/src/setup/rumen/functions/graph-inference/`)
- `init-rumen.js::applySchedule` and the templating module
- Anything that gets bundled into `@jhizzard/termdeck-stack` or invoked from `termdeck init --rumen`

Rumen-specific items in the ledger (as of 2026-05-02):
- #6  v0.6.4 init --rumen broke after init --mnestra succeeded (Class C composite)
- #11 rag.enabled wizard-vs-runtime asymmetry — overnight crash on legacy table writes (Class F)
- #13 Schema-vs-package drift — graph-inference Edge Function never deployed, vault key never created, `graph-inference-tick` cron (TermDeck migration 003) never applied on existing installs. Symptom: `rumen-tick` runs 6 days with `sessions_processed=0, insights_generated=0`, looks healthy, isn't (Class A + I) — **OPEN, P0**

Symptom-side fix tracked for `mnestra doctor`: warn when `rumen-tick` runs N consecutive cycles with all-zero counts. The silent no-op pattern is what hid Brad's drift gap for ~6 days.

The Mnestra memory store also has the synthesis indexed — `memory_recall(query="installer pitfalls")` from any project surfaces the headline + pointer.
