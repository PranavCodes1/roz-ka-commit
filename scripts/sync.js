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

const inActions = process.env.GITHUB_ACTIONS === 'true';

/** Print a setup error (as an annotation on the GitHub Actions run page) and stop. Never prints the key. */
function fail(title, message) {
  if (inActions) console.log(`::error title=${title}::${message.replace(/\r?\n/g, ' ')}`);
  console.error(`${title}: ${message}`);
  process.exit(1);
}

// Copy-pasted secrets often carry a trailing newline, spaces or quotes; strip them.
const clean = (v) => (v || '').trim().replace(/^["']|["']$/g, '').trim();
const url = clean(process.env.SUPABASE_URL).replace(/\/+$/, '').replace(/\/rest\/v1$/, '');
const key = clean(process.env.SUPABASE_SERVICE_ROLE_KEY);
if (!url || !key) fail('Missing settings', 'Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (see .env.example / README → Automatic sync).');

// Catch the common mix-ups before talking to Supabase.
if (/\s|=/.test(url) || !/^https?:\/\/[^/]+$/.test(url)) {
  fail('SUPABASE_URL looks wrong', 'It should be only the project URL, like https://abcdefghijkl.supabase.co (no "SUPABASE_URL=", spaces or extra lines).');
}
if (/\s|=/.test(key.replace(/=+$/, ''))) {
  fail('SUPABASE_SERVICE_ROLE_KEY looks wrong', 'It contains spaces, extra lines or "=". Paste only the key itself (sb_secret_…), with nothing before or after it.');
}
if (key.startsWith('sb_publishable_')) {
  fail('Wrong Supabase key', 'SUPABASE_SERVICE_ROLE_KEY is the publishable key. Use a SECRET key: Supabase → Project Settings → API Keys → Secret keys (sb_secret_…).');
}
if (key.split('.').length === 3) {
  let role = '';
  try { role = JSON.parse(Buffer.from(key.split('.')[1], 'base64url').toString()).role; } catch { /* not a JWT */ }
  if (role && role !== 'service_role') {
    fail('Wrong Supabase key', `SUPABASE_SERVICE_ROLE_KEY is the "${role}" key. Use the service_role key or a secret key (sb_secret_…).`);
  }
} else if (!key.startsWith('sb_secret_')) {
  fail('SUPABASE_SERVICE_ROLE_KEY looks wrong', 'It is not a Supabase secret key. Secret keys start with "sb_secret_" (Supabase → Project Settings → API Keys → Secret keys).');
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

/** Turn a failed first request into a clear explanation. */
function explain(err) {
  const m = err.message || '';
  if (/\b404\b|PGRST202/.test(m)) return ['Database not set up', 'rkc_tracking_start() is missing: re-run supabase/schema.sql in the Supabase SQL Editor.'];
  if (/\b401\b|Invalid API key|invalid.*key/i.test(m)) return ['Supabase rejected the key', 'SUPABASE_SERVICE_ROLE_KEY was not accepted. Copy a secret key again from Supabase → Project Settings → API Keys → Secret keys, and make sure it belongs to this project.'];
  if (/42501|permission denied/i.test(m)) return ['Key has no write access', 'The key works but cannot write. Use a SECRET key (sb_secret_…), not the publishable/anon key.'];
  return ['Could not reach Supabase', `Check SUPABASE_URL (${url}). ${err.cause?.message || m}`.slice(0, 400)];
}

let trackingStart;
let students;
try {
  trackingStart = await rest('rpc/rkc_tracking_start', { method: 'POST', body: {} });
  students = await rest('students?select=id,name,github_username,last_synced_at&order=last_synced_at.asc.nullsfirst');
  // Prove the key can write before syncing anyone (a no-op update matching no rows).
  await rest('students?id=eq.-1', { method: 'PATCH', body: { name: 'x' }, prefer: 'return=minimal' });
} catch (err) {
  fail(...explain(err));
}
console.log(`Syncing ${students.length} contributors (timezone ${CONFIG.TIMEZONE}, counting from ${trackingStart})`);

const github = new GitHubClient({
  token: process.env.GITHUB_TOKEN || '',
  maxWaitMs: 5 * 60_000,
  onWait: (ms, reason) => console.log(`  ${reason}: waiting ${Math.ceil(ms / 1000)}s`),
});

const results = await syncAll(students, {
  github, store, timeZone: CONFIG.TIMEZONE, trackingStart, backfillDays: CONFIG.BACKFILL_DAYS, overlapDays: CONFIG.SYNC_OVERLAP_DAYS,
}, (r) => console.log(r.ok
  ? `  ✓ @${r.student.github_username}: ${r.unique} commits in ${r.from}..${r.to}, ${r.inserted} new`
  : `  ✗ @${r.student.github_username}: ${r.error.message}`));

const failed = results.filter((r) => !r.ok).length + (students.length - results.length);

// In GitHub Actions, surface per-contributor problems as warnings on the run page
// (the run itself only fails when nothing could be synced).
if (inActions) {
  for (const r of results.filter((x) => !x.ok)) {
    console.log(`::warning title=Sync failed for @${r.student.github_username}::${r.error.message.replace(/\r?\n/g, ' ')}`);
  }
  if (students.length > results.length) {
    console.log(`::warning title=Sync stopped early::${students.length - results.length} contributor(s) skipped because of the GitHub rate limit; the next run will catch up.`);
  }
}
console.log(`Done. ${results.length - failed} ok, ${failed} failed/skipped.`);
process.exit(failed && failed === students.length ? 1 : 0);
