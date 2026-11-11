import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GitHubClient } from '../js/github.js';
import { toCommitRows, syncWindow, syncStudent, syncAll } from '../js/sync.js';

const NOW = new Date('2026-11-09T06:00:00Z');
const sha = (n) => n.toString(16).padStart(40, '0');
const item = (n, date, login = 'asha', repo = 'asha/app') => ({
  sha: sha(n), html_url: `https://github.com/${repo}/commit/${sha(n)}`,
  commit: { author: { date }, message: `commit ${n}\n\nbody` },
  author: login ? { login } : null, repository: { full_name: repo },
});

function response(status, body, headers = {}) {
  const h = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v)]));
  return { ok: status >= 200 && status < 300, status, statusText: '', headers: { get: (k) => h.get(k.toLowerCase()) ?? null }, json: async () => body };
}

/** Fake fetch that serves queued responses and records URLs. */
function fakeFetch(queue) {
  const calls = [];
  const fn = async (url) => {
    calls.push(decodeURIComponent(url));
    const next = queue.shift();
    if (!next) throw new Error('unexpected request ' + url);
    if (next instanceof Error) throw next;
    return typeof next === 'function' ? next(url) : next;
  };
  fn.calls = calls;
  return fn;
}

const student = { id: 7, github_username: 'Asha', last_synced_at: null };

test('toCommitRows: dedupes forks, drops other authors, future and malformed commits', () => {
  const rows = toCommitRows([
    item(1, '2026-11-08T10:00:00+05:30'),
    item(1, '2026-11-08T10:00:00+05:30', 'asha', 'someone/fork'), // same sha in a fork
    item(2, '2026-11-07T10:00:00Z', 'mallory'), // different GitHub user
    item(3, '2026-11-07T10:00:00Z', null), // not linked to any account
    item(4, '2099-12-31T23:59:59+03:00'), // spoofed future date
    { sha: sha(5) }, // malformed
    item(6, '2026-11-09T06:30:00Z'), // 30 minutes "ahead": allowed (clock skew)
  ], student, NOW);
  assert.deepEqual(rows.map((r) => r.sha), [sha(1), sha(6)]);
  assert.equal(rows[0].student_id, 7);
  assert.equal(rows[0].message, 'commit 1');
  assert.equal(rows[0].committed_at, '2026-11-08T04:30:00.000Z');
  assert.equal(rows[0].repo_full_name, 'asha/app');
});

test('syncWindow: backfill on first sync, overlap afterwards, full re-scan on demand', () => {
  const opts = { timeZone: 'Asia/Kolkata', backfillDays: 90, overlapDays: 14, now: NOW };
  assert.deepEqual(syncWindow(student, opts), { from: '2026-08-11', to: '2026-11-10' });
  const synced = { ...student, last_synced_at: '2026-11-05T12:00:00Z' };
  assert.deepEqual(syncWindow(synced, opts), { from: '2026-10-21', to: '2026-11-10' });
  assert.deepEqual(syncWindow(synced, { ...opts, full: true }), { from: '2026-08-11', to: '2026-11-10' });
  // a long gap reaches back to the last sync, never skipping days
  const old = { ...student, last_synced_at: '2026-01-01T00:00:00Z' };
  assert.equal(syncWindow(old, opts).from, '2025-12-17');
});

test('searchCommits: builds the query and paginates', async () => {
  const page = (n, count) => response(200, { total_count: 150, items: Array.from({ length: count }, (_, i) => item(n * 1000 + i, '2026-11-01T00:00:00Z')) },
    { 'x-ratelimit-resource': 'search', 'x-ratelimit-remaining': 8, 'x-ratelimit-limit': 10, 'x-ratelimit-reset': 0 });
  const fetch = fakeFetch([page(1, 100), page(2, 50)]);
  const gh = new GitHubClient({ fetch, sleep: async () => {} });
  const items = await gh.searchCommits('asha', '2026-10-01', '2026-11-10');
  assert.equal(items.length, 150);
  assert.match(fetch.calls[0], /q=author:asha author-date:2026-10-01\.\.2026-11-10 merge:false/);
  assert.match(fetch.calls[0], /sort=author-date&order=desc&per_page=100&page=1/);
  assert.match(fetch.calls[1], /page=2/);
  assert.deepEqual(gh.limits.search, { limit: 10, remaining: 8, reset: 0 });
});

test('searchCommits: splits ranges with more than 1000 results', async () => {
  const big = response(200, { total_count: 1500, items: [] });
  const small = (n) => response(200, { total_count: 1, items: [item(n, '2026-10-01T00:00:00Z')] });
  const fetch = fakeFetch([big, small(1), small(2)]);
  const gh = new GitHubClient({ fetch, sleep: async () => {} });
  const items = await gh.searchCommits('asha', '2026-10-01', '2026-10-10');
  assert.equal(items.length, 2);
  assert.match(fetch.calls[1], /2026-10-01\.\.2026-10-05/);
  assert.match(fetch.calls[2], /2026-10-06\.\.2026-10-10/);
});

test('searchCommits: unknown/renamed user (GitHub ignores author:) is reported, not paged through', async () => {
  const everyone = response(200, { total_count: 5_000_000, items: [item(1, '2026-11-01T00:00:00Z', 'random1'), item(2, '2026-11-01T00:00:00Z', 'random2')] });
  const fetch = fakeFetch([everyone]);
  const gh = new GitHubClient({ fetch, sleep: async () => {} });
  await assert.rejects(gh.searchCommits('ghost-user', '2026-08-01', '2026-11-10'), (e) => e.code === 'not_found' && /not found/.test(e.message));
  assert.equal(fetch.calls.length, 1);
});

test('rate limit: waits for the reset and retries', async () => {
  let clock = 1_000_000;
  const waits = [];
  const fetch = fakeFetch([
    response(403, { message: 'API rate limit exceeded' }, { 'x-ratelimit-remaining': 0, 'x-ratelimit-reset': (clock + 30_000) / 1000, 'x-ratelimit-resource': 'search' }),
    response(200, { total_count: 0, items: [] }),
  ]);
  const gh = new GitHubClient({ fetch, now: () => clock, sleep: async (ms) => { waits.push(ms); clock += ms; } });
  await gh.searchCommits('asha', '2026-11-01', '2026-11-02');
  assert.equal(fetch.calls.length, 2);
  assert.equal(waits[0], 31_000);
});

test('rate limit: secondary limit honours Retry-After', async () => {
  const waits = [];
  const fetch = fakeFetch([response(429, { message: 'secondary rate limit' }, { 'retry-after': 5 }), response(200, { login: 'asha' })]);
  const gh = new GitHubClient({ fetch, now: () => 0, sleep: async (ms) => waits.push(ms) });
  assert.equal((await gh.getUser('asha')).login, 'asha');
  assert.deepEqual(waits, [6000]);
});

test('rate limit: gives up with a clear error when the reset is too far away', async () => {
  const fetch = fakeFetch([response(403, { message: 'API rate limit exceeded' }, { 'x-ratelimit-remaining': 0, 'x-ratelimit-reset': 3600 })]);
  const gh = new GitHubClient({ fetch, now: () => 0, sleep: async () => {} });
  await assert.rejects(gh.getUser('asha'), (e) => e.code === 'rate_limited' && /rate limit/.test(e.message));
});

test('errors: unknown user, network failure retries, server errors retry', async () => {
  const gh404 = new GitHubClient({ fetch: fakeFetch([response(404, { message: 'Not Found' })]) });
  await assert.rejects(gh404.getUser('nobody'), (e) => e.code === 'not_found');

  const gh422 = new GitHubClient({ fetch: fakeFetch([response(422, { message: 'Validation Failed' })]) });
  await assert.rejects(gh422.searchCommits('nobody', '2026-11-01', '2026-11-02'), (e) => e.code === 'not_found');

  const flaky = fakeFetch([new TypeError('Failed to fetch'), response(502, {}), response(200, { login: 'asha' })]);
  const gh = new GitHubClient({ fetch: flaky, sleep: async () => {} });
  assert.equal((await gh.getUser('asha')).login, 'asha');

  const down = new GitHubClient({ fetch: fakeFetch([1, 2, 3, 4].map(() => new TypeError('offline'))), sleep: async () => {} });
  await assert.rejects(down.getUser('asha'), (e) => e.code === 'network');
});

test('syncStudent stores rows via the store and marks the student synced', async () => {
  const stored = [];
  const store = {
    insertCommits: async (rows) => { stored.push(...rows); return rows.length; },
    markSynced: async (id, at) => stored.push({ synced: id, at }),
  };
  const fetch = fakeFetch([
    response(200, { total_count: 2, items: [item(1, '2026-11-08T00:00:00Z'), item(1, '2026-11-08T00:00:00Z', 'asha', 'x/fork')] }),
    response(200, []), // their own repos: none pushed recently
  ]);
  const r = await syncStudent(student, { github: new GitHubClient({ fetch }), store, timeZone: 'Asia/Kolkata', now: NOW });
  assert.deepEqual([r.fetched, r.unique, r.inserted], [2, 1, 1]);
  assert.deepEqual(stored.at(-1), { synced: 7, at: NOW.toISOString() });
});

test('syncAll continues after a per-student error but stops on rate limit', async () => {
  const store = { insertCommits: async (r) => r.length, markSynced: async () => {} };
  const fetch = fakeFetch([
    response(422, { message: 'Validation Failed' }), // student 1: unknown user
    response(200, { total_count: 0, items: [] }), // student 2: ok
    response(200, []), // student 2: own repos
    response(403, { message: 'API rate limit exceeded' }, { 'x-ratelimit-remaining': 0, 'x-ratelimit-reset': 99999999 }), // student 3
  ]);
  const gh = new GitHubClient({ fetch, now: () => 0, sleep: async () => {} });
  const list = [1, 2, 3, 4].map((id) => ({ id, github_username: `u${id}`, last_synced_at: null }));
  const results = await syncAll(list, { github: gh, store, timeZone: 'UTC', now: NOW });
  assert.deepEqual(results.map((r) => r.ok), [false, true, false]);
  assert.equal(results[2].error.code, 'rate_limited');
});

test('tracking start: window never reaches before the start date', () => {
  const opts = { timeZone: 'Asia/Kolkata', backfillDays: 90, overlapDays: 14, now: NOW, trackingStart: '2026-11-09' };
  // first sync: backfill clamped to the start date (minus the 1-day timezone pad)
  assert.deepEqual(syncWindow(student, opts), { from: '2026-11-08', to: '2026-11-10' });
  // later syncs and full re-scans are clamped too
  assert.equal(syncWindow({ ...student, last_synced_at: '2026-11-09T02:00:00Z' }, opts).from, '2026-11-08');
  assert.equal(syncWindow(student, { ...opts, full: true }).from, '2026-11-08');
  // once the start is far enough back, normal rules apply
  const later = { ...opts, now: new Date('2026-12-20T06:00:00Z') };
  assert.equal(syncWindow({ ...student, last_synced_at: '2026-12-19T06:00:00Z' }, later).from, '2026-12-04');
});

test('tracking start: commits from before the start date are not stored', async () => {
  const stored = [];
  const store = { insertCommits: async (rows) => { stored.push(...rows); return rows.length; }, markSynced: async () => {} };
  const fetch = fakeFetch([response(200, { total_count: 3, items: [
    item(1, '2026-11-08T18:00:00Z'), // 23:30 Nov 8 IST: before start
    item(2, '2026-11-08T19:00:00Z'), // 00:30 Nov 9 IST: counts
    item(3, '2026-11-09T05:00:00Z'), // Nov 9 IST: counts
  ] }), response(200, [])]);
  const r = await syncStudent(student, { github: new GitHubClient({ fetch }), store, timeZone: 'Asia/Kolkata', trackingStart: '2026-11-09', now: NOW });
  assert.deepEqual(stored.map((x) => x.sha), [sha(2), sha(3)]);
  assert.deepEqual([r.fetched, r.unique, r.inserted], [3, 2, 2]);
});


// ---------- commits in the contributor's own repositories ----------
const repoCommit = (n, date, login, parents = 1) => ({
  sha: sha(n), html_url: `https://github.com/x/c/${n}`,
  commit: { author: { date }, message: `own ${n}` },
  author: login ? { login } : null, parents: Array.from({ length: parents }, () => ({})),
});
const repo = (name, pushed, extra = {}) => ({ full_name: `Asha/${name}`, pushed_at: pushed, fork: false, private: false, ...extra });

test('own repos: lists recent, non-fork repos and skips merges, empty repos and old repos', async () => {
  const fetch = fakeFetch([
    response(200, [
      repo('app', '2026-11-08T10:00:00Z'),
      repo('forked', '2026-11-08T09:00:00Z', { fork: true }),
      repo('empty', '2026-11-08T08:00:00Z'),
      repo('old', '2026-10-01T00:00:00Z'), // not pushed in the window: not fetched
    ]),
    response(200, [repoCommit(1, '2026-11-08T05:00:00Z', null), repoCommit(2, '2026-11-08T06:00:00Z', 'asha', 2)]),
    response(409, { message: 'Git Repository is empty.' }),
  ]);
  const items = await new GitHubClient({ fetch, sleep: async () => {} }).listOwnRepoCommits('Asha', '2026-11-07', '2026-11-10');
  assert.deepEqual(items.map((i) => [i.sha, i.repository.full_name, i.ownRepo]), [[sha(1), 'Asha/app', true]]);
  assert.match(fetch.calls[0], /\/users\/Asha\/repos\?type=owner&sort=pushed/);
  assert.match(fetch.calls[1], /\/repos\/Asha\/app\/commits\?since=2026-11-07T00:00:00Z&until=2026-11-10T23:59:59Z/);
  assert.equal(fetch.calls.length, 3); // the fork and the old repo were never requested
});

test('own repos: unlinked commits count, commits linked to someone else do not', async () => {
  const stored = [];
  const store = { insertCommits: async (rows) => { stored.push(...rows); return rows.length; }, markSynced: async () => {} };
  const fetch = fakeFetch([
    response(200, { total_count: 1, items: [item(1, '2026-11-09T05:00:00Z')] }), // search: linked commit
    response(200, [repo('tracker', '2026-11-09T06:00:00Z')]),
    response(200, [
      repoCommit(1, '2026-11-09T05:00:00Z', 'asha'), // same commit as search: stored once
      repoCommit(2, '2026-11-09T06:00:00Z', null), // email not linked to any account: counts
      repoCommit(3, '2026-11-09T07:00:00Z', 'mallory'), // a collaborator's commit: never counts
    ]),
  ]);
  const r = await syncStudent(student, { github: new GitHubClient({ fetch }), store, timeZone: 'Asia/Kolkata', trackingStart: '2026-11-09', now: NOW });
  assert.deepEqual(stored.map((x) => [x.sha, x.repo_full_name]), [[sha(1), 'asha/app'], [sha(2), 'Asha/tracker']]);
  assert.equal(r.unique, 2);
});

test('toCommitRows: an unlinked commit only counts when it comes from their own repo', () => {
  const unlinkedFromSearch = { ...item(1, '2026-11-08T05:00:00Z', null) };
  const unlinkedOwn = { ...item(2, '2026-11-08T05:00:00Z', null), ownRepo: true };
  assert.deepEqual(toCommitRows([unlinkedFromSearch, unlinkedOwn], student, NOW).map((r) => r.sha), [sha(2)]);
});
