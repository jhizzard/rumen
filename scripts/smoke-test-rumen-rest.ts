/**
 * Smoke test for the Rumen pipeline against a hosted Supabase project,
 * hitting only the REST API (no direct Postgres connection required).
 *
 * Complements `scripts/test-locally.ts`, which drives the full Rumen job
 * against a local/dockerized Postgres using `pg`. Use this script when
 * you only have a SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (for example
 * against production) and want a quick end-to-end sanity check that
 * Extract → Relate → Surface writes rows to `rumen_jobs`/`rumen_insights`.
 *
 * Uses a simple cross-project heuristic instead of the real synthesize
 * phase, so it is not a substitute for the full pipeline. Writes a real
 * `rumen_jobs` row tagged `triggered_by=test-rest` — do not run it
 * against production unless you're okay with that side effect.
 *
 * Usage: npx tsx scripts/smoke-test-rumen-rest.ts
 * Env:   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (via .env or shell)
 */

import 'dotenv/config';

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('[rumen] Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env');
  process.exit(1);
}

const headers = {
  'apikey': SUPABASE_KEY,
  'Authorization': `Bearer ${SUPABASE_KEY}`,
  'Content-Type': 'application/json',
  'Prefer': 'return=representation',
};

async function supabaseGet(table: string, params: string = '') {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${params}`, { headers });
  if (!res.ok) throw new Error(`GET ${table} failed: ${res.status} ${await res.text()}`);
  return res.json();
}

async function supabaseInsert(table: string, row: Record<string, unknown>) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(row),
  });
  if (!res.ok) throw new Error(`INSERT ${table} failed: ${res.status} ${await res.text()}`);
  return res.json();
}

async function main() {
  console.log('[rumen] === Rumen REST API Integration Test ===\n');

  // Phase 1: EXTRACT — find recent memories
  console.log('[rumen-extract] Fetching recent memories...');
  const recent = await supabaseGet(
    'memory_items',
    'select=id,content,source_type,project,created_at&order=created_at.desc&limit=20&is_active=eq.true'
  );
  console.log(`[rumen-extract] Found ${recent.length} recent memories`);

  if (recent.length === 0) {
    console.log('[rumen] No memories to process. Done.');
    return;
  }

  // Group by project
  const byProject: Record<string, number> = {};
  for (const m of recent) {
    byProject[m.project || 'global'] = (byProject[m.project || 'global'] || 0) + 1;
  }
  console.log('[rumen-extract] Projects:', JSON.stringify(byProject));

  // Phase 2: RELATE — for each unique source_type, find similar historical patterns
  console.log('\n[rumen-relate] Looking for cross-project patterns...');

  const sourceTypes = [...new Set(recent.map((m: any) => m.source_type))];
  const insights: { text: string; sourceIds: string[]; projects: string[] }[] = [];

  for (const st of sourceTypes) {
    const memoriesOfType = recent.filter((m: any) => m.source_type === st);
    const projects = [...new Set(memoriesOfType.map((m: any) => m.project))];

    if (projects.length > 1) {
      // Cross-project pattern found
      const text = `Pattern: "${st}" memories appear across ${projects.length} projects (${projects.join(', ')}). Most recent: "${memoriesOfType[0].content.substring(0, 100)}..."`;
      insights.push({
        text,
        sourceIds: memoriesOfType.map((m: any) => m.id),
        projects,
      });
      console.log(`[rumen-relate] Found cross-project "${st}" across: ${projects.join(', ')}`);
    }
  }

  // Phase 3: SURFACE — write a job + insights to Rumen tables
  console.log('\n[rumen-surface] Writing results...');

  // Create the job
  const [job] = await supabaseInsert('rumen_jobs', {
    triggered_by: 'test-rest',
    status: 'done',
    sessions_processed: recent.length,
    insights_generated: insights.length,
    questions_generated: 0,
    started_at: new Date().toISOString(),
    completed_at: new Date().toISOString(),
  });
  console.log(`[rumen-surface] Job created: ${job.id}`);

  // Write insights
  for (const insight of insights) {
    const [row] = await supabaseInsert('rumen_insights', {
      job_id: job.id,
      source_memory_ids: insight.sourceIds,
      projects: insight.projects,
      insight_text: insight.text,
      confidence: 0.7,
    });
    console.log(`[rumen-surface] Insight created: ${row.id}`);
    console.log(`  ${insight.text.substring(0, 120)}...`);
  }

  // Summary
  console.log('\n[rumen] === Test Complete ===');
  console.log(`  Memories scanned: ${recent.length}`);
  console.log(`  Projects found: ${Object.keys(byProject).length}`);
  console.log(`  Cross-project insights: ${insights.length}`);
  console.log(`  Job ID: ${job.id}`);

  // Verify by reading back
  const jobs = await supabaseGet('rumen_jobs', 'select=id,status,insights_generated&order=created_at.desc&limit=1');
  const insightRows = await supabaseGet('rumen_insights', `select=id,insight_text&job_id=eq.${job.id}`);
  console.log(`\n[rumen] Verification: ${jobs.length} job(s), ${insightRows.length} insight(s) in database`);
}

main().catch(err => {
  console.error('[rumen] test failed:', err.message);
  process.exit(1);
});
