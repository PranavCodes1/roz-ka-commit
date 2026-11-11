// GitHub → Supabase synchronisation. Storage is injected so the same logic runs in
// the admin page (supabase-js) and in the optional scheduled script (REST + fetch).
//
// store = {
//   insertCommits(rows) -> Promise<number>   // inserts, ignoring duplicates; returns # new rows
//   markSynced(studentId, isoTimestamp) -> Promise<void>
// }
import { addDays, dateInZone, todayIn } from './dates.js';

/**
 * Convert GitHub commit items into `commits` rows for one contributor. A commit counts if
 *  - GitHub links it to this contributor's account (search results and own repos), or
 *  - it is in a repository the contributor owns (`ownRepo`) and its email isn't linked
 *    to ANY GitHub account (author: null) — only the owner (or people they invite) can
 *    push there. Commits linked to a different account never count.
 */
export function toCommitRows(items, student, now = new Date()) {
  const login = student.github_username.toLowerCase();
  const latest = now.getTime() + 60 * 60 * 1000; // ignore commits dated in the future
  const seen = new Set();
  const rows = [];
  for (const item of items) {
    if (!item?.sha || !item.commit?.author?.date) continue;
    const linkedTo = (item.author?.login || '').toLowerCase();
    const unlinkedInOwnRepo = item.ownRepo === true && !item.author;
    if (linkedTo !== login && !unlinkedInOwnRepo) continue;
    if (seen.has(item.sha)) continue; // same commit in a fork
    const committedAt = new Date(item.commit.author.date);
    if (Number.isNaN(committedAt.getTime()) || committedAt.getTime() > latest) continue;
    seen.add(item.sha);
    rows.push({
      student_id: student.id,
      sha: item.sha,
      repo_full_name: item.repository?.full_name || 'unknown',
      message: (item.commit.message || '').split('\n')[0].slice(0, 500),
      html_url: item.html_url || null,
      committed_at: committedAt.toISOString(),
    });
  }
  return rows;
}

/**
 * Which author-date window to fetch. Never earlier than `trackingStart` (the day
 * points started). First sync: the last `backfillDays` days.
 * Later syncs: from `overlapDays` before the previous sync, so commits that were
 * pushed (and indexed by GitHub) a few days after they were authored are still found.
 */
export function syncWindow(student, { timeZone, backfillDays, overlapDays, trackingStart = null, full = false, now = new Date() }) {
  const today = todayIn(timeZone, now);
  let backfillFrom = addDays(today, -(backfillDays - 1));
  if (trackingStart && backfillFrom < trackingStart) backfillFrom = trackingStart;
  // After a long gap this reaches further back than the backfill window, which is
  // what we want: nothing between two syncs is ever skipped.
  let from = !full && student.last_synced_at
    ? addDays(dateInZone(student.last_synced_at, timeZone), -overlapDays)
    : backfillFrom;
  if (trackingStart && from < trackingStart) from = trackingStart; // nothing before tracking started
  // GitHub compares author dates in UTC; pad by a day each side for timezone skew.
  return { from: addDays(from, -1), to: addDays(today, 1) };
}

export async function syncStudent(student, { github, store, timeZone, backfillDays = 90, overlapDays = 14, trackingStart = null, full = false, now = new Date(), onPage }) {
  const { from, to } = syncWindow(student, { timeZone, backfillDays, overlapDays, trackingStart, full, now });
  // 1) commits linked to the account, anywhere public; 2) commits in their own repos,
  // including ones whose email isn't linked to GitHub. Duplicates are merged by SHA.
  const items = [
    ...await github.searchCommits(student.github_username, from, to, onPage),
    ...await github.listOwnRepoCommits(student.github_username, from, to),
  ];
  // The window is padded a day for timezone skew; drop anything before the start
  // date here too (the database enforces the same rule).
  const rows = toCommitRows(items, student, now)
    .filter((r) => !trackingStart || dateInZone(r.committed_at, timeZone) >= trackingStart);
  const inserted = rows.length ? await store.insertCommits(rows) : 0;
  await store.markSynced(student.id, now.toISOString());
  return { from, to, fetched: items.length, unique: rows.length, inserted };
}

/**
 * Sync students one after another. A rate-limit error stops the run (every later
 * request would fail too); any other error is recorded and the run continues.
 */
export async function syncAll(students, opts, onResult = () => {}) {
  const results = [];
  for (const student of students) {
    try {
      const r = await syncStudent(student, opts);
      results.push({ student, ok: true, ...r });
      onResult(results.at(-1));
    } catch (error) {
      results.push({ student, ok: false, error });
      onResult(results.at(-1));
      if (error.code === 'rate_limited') break;
    }
  }
  return results;
}
