// Optional: sync every student from the command line or a scheduled GitHub Action.
// Uses the same logic as the admin page's "Refresh all" button.
//
// Needs (env vars or .env — never commit real values):
//   SUPABASE_URL                 https://<ref>.supabase.co
//   SUPABASE_SERVICE_ROLE_KEY    service_role / sb_secret_… key (server-side ONLY)
//   GITHUB_TOKEN                 optional; in GitHub Actions the built-in token works
//
// Run: npm run sync      (or: node scripts/sync.js)
import { CONFIG } from '../js/config.js';
import { GitHubClient } from '../js/github.js';
import { syncAll } from '../js/sync.js';

const url = process.env.SUPABASE_URL?.replace(/\/$/, '');
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (see .env.example).');
  process.exit(1);
}

async function rest(path, { method = 'GET', body, prefer } = {}) {
  const headers = { apikey: key, 'Content-Type': 'application/json' };
  if (key.split('.').length === 3) headers.Authorization = `Bearer ${key}`; // legacy JWT keys
  if (prefer) headers.Prefer = prefer;
  const res = await fetch(`${url}/rest/v1/${path}`, { method, headers, body: body && JSON.stringify(body) });
  const text = await res.text();
  if (!res.ok) throw new Error(`Supabase ${method} ${path} failed: ${res.status} ${text}`);
  return text ? JSON.parse(text) : null;
}

const store = {
  async insertCommits(rows) {
    let inserted = 0;
    for (let i = 0; i < rows.length; i += 500) {
      const data = await rest('commits?on_conflict=student_id,sha&select=id', {
        method: 'POST', body: rows.slice(i, i + 500), prefer: 'resolution=ignore-duplicates,return=representation',
      });
      inserted += data.length;
    }
    return inserted;
  },
  async markSynced(id, at) {
    await rest(`students?id=eq.${id}`, { method: 'PATCH', body: { last_synced_at: at }, prefer: 'return=minimal' });
  },
};

const students = await rest('students?select=id,name,github_username,last_synced_at&order=last_synced_at.asc.nullsfirst');
console.log(`Syncing ${students.length} contributors (timezone ${CONFIG.TIMEZONE})`);

const github = new GitHubClient({
  token: process.env.GITHUB_TOKEN || '',
  maxWaitMs: 5 * 60_000,
  onWait: (ms, reason) => console.log(`  ${reason}: waiting ${Math.ceil(ms / 1000)}s`),
});

const results = await syncAll(students, {
  github, store, timeZone: CONFIG.TIMEZONE, backfillDays: CONFIG.BACKFILL_DAYS, overlapDays: CONFIG.SYNC_OVERLAP_DAYS,
}, (r) => console.log(r.ok
  ? `  ✓ @${r.student.github_username}: ${r.unique} commits in ${r.from}..${r.to}, ${r.inserted} new`
  : `  ✗ @${r.student.github_username}: ${r.error.message}`));

const failed = results.filter((r) => !r.ok).length + (students.length - results.length);
console.log(`Done. ${results.length - failed} ok, ${failed} failed/skipped.`);
process.exit(failed && failed === students.length ? 1 : 0);
