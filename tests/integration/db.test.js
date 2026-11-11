// Integration tests against a real Supabase project (use a local or throwaway one!).
// They create and delete test users/students. Run: npm run test:db
//   needs SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY in .env
// Set RKC_LIVE_GITHUB=0 to skip the test that calls the real GitHub API.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from '@supabase/supabase-js';
import { GitHubClient } from '../../js/github.js';
import { syncStudent } from '../../js/sync.js';

const { SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY } = process.env;
const opts = { auth: { persistSession: false, autoRefreshToken: false } };
const service = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, opts);
const anon = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, opts);
const admin = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, opts);
const user = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, opts);

const tag = Date.now().toString(36);
const password = `Test-${tag}-pass!`;
const users = [];
const sha = (n) => (tag + n.toString(16)).padStart(40, '0').replace(/[^0-9a-f]/g, 'a');

before(async () => {
  for (const [name, client] of [['admin', admin], ['user', user]]) {
    const email = `rkc-${name}-${tag}@example.com`;
    const { data, error } = await service.auth.admin.createUser({ email, password, email_confirm: true });
    if (error) throw error;
    users.push(data.user.id);
    if (name === 'admin') {
      const { error: e } = await service.from('admins').insert({ user_id: data.user.id });
      if (e) throw e;
    }
    const { error: e2 } = await client.auth.signInWithPassword({ email, password });
    if (e2) throw e2;
  }
});

after(async () => {
  await service.from('students').delete().like('github_username', `rkc-${tag}%`);
  for (const id of users) await service.auth.admin.deleteUser(id);
});

const addStudent = async (suffix = '') => {
  const { data, error } = await admin.from('students')
    .insert({ name: 'Test Student', github_username: `rkc-${tag}${suffix}` }).select().single();
  if (error) throw error;
  return data;
};
const activityOf = async (id) => (await anon.from('daily_activity').select('*').eq('student_id', id).order('activity_date')).data;
const commit = (student, n, at) => ({ student_id: student.id, sha: sha(n), repo_full_name: 'x/y', message: 'm', committed_at: at });

test('is_admin() reports roles correctly', async () => {
  assert.equal((await admin.rpc('is_admin')).data, true);
  assert.equal((await user.rpc('is_admin')).data, false);
  assert.equal((await anon.rpc('is_admin')).data, false);
});

test('RLS: visitors and non-admin users can read but not write', async () => {
  assert.equal((await anon.from('students').select('id')).error, null);
  for (const client of [anon, user]) {
    const ins = await client.from('students').insert({ name: 'x', github_username: `rkc-${tag}-bad` }).select();
    assert.ok(ins.error, 'insert must be rejected');
  }
  const s = await addStudent('-rls');
  for (const client of [anon, user]) {
    await client.from('students').update({ name: 'hacked' }).eq('id', s.id);
    await client.from('students').delete().eq('id', s.id);
    const c = await client.from('commits').insert(commit(s, 1, new Date().toISOString()));
    assert.ok(c.error, 'commit insert must be rejected');
    const d = await client.from('daily_activity').insert({ student_id: s.id, activity_date: '2026-01-01', commit_count: 1, points: 10 });
    assert.ok(d.error, 'daily_activity insert must be rejected');
  }
  const still = (await anon.from('students').select('name').eq('id', s.id).single()).data;
  assert.equal(still.name, 'Test Student');
  // even admins cannot write daily_activity or grant admin rights through the API
  assert.ok((await admin.from('daily_activity').insert({ student_id: s.id, activity_date: '2026-01-01', commit_count: 1, points: 10 })).error);
  assert.ok((await admin.from('admins').insert({ user_id: users[1] })).error);
  assert.ok((await user.rpc('rkc_rebuild_daily_activity')).error);
});

test('constraints: duplicate usernames (any case) and invalid usernames are rejected', async () => {
  await addStudent('-dup');
  const dup = await admin.from('students').insert({ name: 'Again', github_username: `RKC-${tag}-DUP` });
  assert.equal(dup.error?.code, '23505');
  const bad = await admin.from('students').insert({ name: 'Bad', github_username: 'has space' });
  assert.equal(bad.error?.code, '23514');
});

// Commits are only stored from rkc_tracking_start() on (India time). The tests build
// dates relative to that start; run them against a database whose start date is at
// least 3 days in the past (on a local DB:  create or replace function
// public.rkc_tracking_start() returns date language sql immutable as $$ select date '2026-10-25' $$;).
let S = null;
const addDays = (d, n) => new Date(Date.parse(d + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
const at = (dayOffset, utcTime) => `${addDays(S, dayOffset)}T${utcTime}Z`;
const enoughHistory = () => S && addDays(S, 3) <= new Date().toISOString().slice(0, 10);

test('tracking start date is readable by everyone', async () => {
  const { data, error } = await anon.rpc('rkc_tracking_start');
  assert.equal(error, null);
  assert.match(data, /^\d{4}-\d{2}-\d{2}$/);
  S = data;
});

test('points: per active day (not per commit), duplicates ignored, timezone applied, nothing before the start date', async (t) => {
  if (!enoughHistory()) return t.skip(`tracking start ${S} is too recent for this test`);
  const s = await addStudent('-pts');
  const rows = [
    commit(s, 1, at(1, '20:00:00')), // 01:30 IST on S+2
    commit(s, 2, at(2, '05:00:00')), // S+2
    commit(s, 3, at(2, '06:00:00')), // S+2
    commit(s, 4, at(0, '10:00:00')), // S
    commit(s, 5, '2099-12-31T20:59:59Z'), // spoofed future: dropped by trigger
    commit(s, 7, at(-1, '18:00:00')), // 23:30 IST the day BEFORE the start: dropped
    commit(s, 8, at(-30, '10:00:00')), // a month before the start: dropped
  ];
  const up = (r) => admin.from('commits').upsert(r, { onConflict: 'student_id,sha', ignoreDuplicates: true }).select('id');
  const first = await up(rows);
  assert.equal(first.error, null);
  assert.equal(first.data.length, 4);
  const again = await up([...rows, commit(s, 1, at(1, '20:00:00'))]); // re-sync: nothing new
  assert.equal(again.data.length, 0);

  assert.deepEqual((await activityOf(s.id)).map((r) => [r.activity_date, r.commit_count, r.points]),
    [[S, 1, 10], [addDays(S, 2), 3, 10]]);

  // one new commit on an existing day: count goes up, points stay at 10 for that day
  await up([commit(s, 6, at(2, '07:00:00'))]);
  const last = (await activityOf(s.id)).at(-1);
  assert.deepEqual([last.commit_count, last.points], [4, 10]);

  // admin maintenance function rebuilds the same result
  assert.equal((await admin.rpc('rkc_rebuild_daily_activity')).error, null);
  assert.deepEqual((await activityOf(s.id)).map((r) => [r.activity_date, r.commit_count, r.points]),
    [[S, 1, 10], [addDays(S, 2), 4, 10]]);
});

test('editing the GitHub username clears old history; deleting removes everything', async () => {
  const s = await addStudent('-edit');
  await admin.from('commits').insert(commit(s, 10, at(0, '10:00:00')));
  await admin.from('students').update({ last_synced_at: new Date().toISOString() }).eq('id', s.id);
  assert.equal((await activityOf(s.id)).length, 1);

  // name-only edit keeps history
  await admin.from('students').update({ name: 'Renamed' }).eq('id', s.id);
  assert.equal((await activityOf(s.id)).length, 1);

  const { data } = await admin.from('students').update({ github_username: `rkc-${tag}-edit2` }).eq('id', s.id).select().single();
  assert.equal(data.last_synced_at, null);
  assert.equal((await activityOf(s.id)).length, 0);
  assert.equal((await anon.from('commits').select('id').eq('student_id', s.id)).data.length, 0);

  await admin.from('commits').insert(commit(s, 11, at(0, '11:00:00')));
  const del = await admin.from('students').delete().eq('id', s.id);
  assert.equal(del.error, null);
  assert.equal((await activityOf(s.id)).length, 0);
});

test('live GitHub sync stores real commits once and awards 10 points per active day', { skip: process.env.RKC_LIVE_GITHUB === '0' }, async () => {
  // A real, active public account; renamed in the DB so cleanup can find it.
  const { data: s, error } = await admin.from('students').insert({ name: 'Live', github_username: 'gaearon' }).select().single();
  if (error) throw error;
  try {
    const store = {
      async insertCommits(rows) {
        const { data, error: e } = await admin.from('commits').upsert(rows, { onConflict: 'student_id,sha', ignoreDuplicates: true }).select('id');
        if (e) throw e;
        return data.length;
      },
      async markSynced(id, at) { await admin.from('students').update({ last_synced_at: at }).eq('id', id); },
    };
    const github = new GitHubClient({ token: process.env.GITHUB_TOKEN || '' });
    const r1 = await syncStudent(s, { github, store, timeZone: 'Asia/Kolkata', backfillDays: 60, trackingStart: S });
    console.log('  live sync:', r1);
    assert.equal(r1.inserted, r1.unique);

    const { data: commits } = await anon.from('commits').select('sha, commit_date').eq('student_id', s.id);
    const days = new Set(commits.map((c) => c.commit_date));
    const act = await activityOf(s.id);
    assert.equal(act.length, days.size);
    assert.equal(act.reduce((a, r) => a + r.points, 0), 10 * days.size);
    assert.equal(act.reduce((a, r) => a + r.commit_count, 0), commits.length);
    assert.ok(act.every((r) => r.points === 10));
    assert.ok(commits.every((c) => c.commit_date >= S), 'no commits before the start date');

    const r2 = await syncStudent({ ...s, last_synced_at: new Date().toISOString() }, { github, store, timeZone: 'Asia/Kolkata', backfillDays: 60, trackingStart: S });
    assert.equal(r2.inserted, 0, 'second sync must not duplicate commits');
  } finally {
    await service.from('students').delete().eq('id', s.id);
  }
});

// ---------- private-repo contributions verified by an admin ----------
test('private repo contributions: visibility, permissions and validation', async (t) => {
  if (!enoughHistory()) return t.skip(`tracking start ${S} is too recent for this test`);
  const s = await addStudent('-priv');
  const entry = { student_id: s.id, activity_date: addDays(S, 1), commit_count: 3, repo_url: 'https://github.com/Rkc-Test/Secret-App.git/', note: 'checked 3 commits' };

  // only admins may add entries
  assert.ok((await anon.from('manual_contributions').insert(entry)).error);
  assert.ok((await user.from('manual_contributions').insert(entry)).error);
  assert.equal((await admin.from('manual_contributions').insert(entry)).error, null);

  // the link is normalised, and the same repo + day can't be added twice (any spelling)
  const dup = await admin.from('manual_contributions').insert({ ...entry, repo_url: 'https://github.com/rkc-test/secret-app' });
  assert.equal(dup.error?.code, '23505');

  // dates must be within the tracking period, links must be GitHub repo URLs
  assert.equal((await admin.from('manual_contributions').insert({ ...entry, activity_date: addDays(S, -1) })).error?.code, '23514');
  assert.equal((await admin.from('manual_contributions').insert({ ...entry, activity_date: '2099-01-01' })).error?.code, '23514');
  assert.equal((await admin.from('manual_contributions').insert({ ...entry, repo_url: 'https://evil.example/x' })).error?.code, '23514');

  // visitors see that private work exists, but not which repository or the note
  const pub = await anon.from('manual_contributions').select('id, student_id, activity_date, commit_count').eq('student_id', s.id);
  assert.equal(pub.error, null);
  assert.deepEqual(pub.data.map((r) => r.commit_count), [3]);
  assert.ok((await anon.from('manual_contributions').select('repo_url')).error, 'repo_url must be hidden from visitors');
  assert.ok((await anon.from('manual_contributions').select('note')).error, 'note must be hidden from visitors');
  assert.ok((await user.rpc('rkc_admin_manual_contributions')).error, 'non-admins cannot list details');
  const details = (await admin.rpc('rkc_admin_manual_contributions')).data.filter((r) => r.student_id === s.id);
  assert.deepEqual(details.map((r) => [r.repo_url, r.note]), [['https://github.com/rkc-test/secret-app', 'checked 3 commits']]);
});

test('private repo contributions: points per day combine with GitHub commits; deleting removes them', async (t) => {
  if (!enoughHistory()) return t.skip(`tracking start ${S} is too recent for this test`);
  const s = await addStudent('-priv2');
  const day = addDays(S, 2);
  const dayRow = async () => (await activityOf(s.id)).find((r) => r.activity_date === day);

  await admin.from('manual_contributions').insert({ student_id: s.id, activity_date: day, commit_count: 4, repo_url: 'https://github.com/a/private-one' });
  assert.deepEqual([(await dayRow()).commit_count, (await dayRow()).points], [4, 10]);

  // a public GitHub commit the same day: more commits, still 10 points
  await admin.from('commits').insert(commit(s, 900, at(2, '06:00:00')));
  assert.deepEqual([(await dayRow()).commit_count, (await dayRow()).points], [5, 10]);

  // a second private repo the same day: still 10 points
  await admin.from('manual_contributions').insert({ student_id: s.id, activity_date: day, commit_count: 2, repo_url: 'https://github.com/a/private-two' });
  assert.deepEqual([(await dayRow()).commit_count, (await dayRow()).points], [7, 10]);

  // rebuild gives the same totals
  assert.equal((await admin.rpc('rkc_rebuild_daily_activity')).error, null);
  assert.deepEqual([(await dayRow()).commit_count, (await dayRow()).points], [7, 10]);

  // removing the private entries leaves only the GitHub commit
  const ids = (await admin.rpc('rkc_admin_manual_contributions')).data.filter((r) => r.student_id === s.id).map((r) => r.id);
  assert.equal((await admin.from('manual_contributions').delete().in('id', ids)).error, null);
  assert.deepEqual([(await dayRow()).commit_count, (await dayRow()).points], [1, 10]);

  // a day with only private work disappears entirely when its entry is removed
  await admin.from('manual_contributions').insert({ student_id: s.id, activity_date: addDays(S, 1), commit_count: 1, repo_url: 'https://github.com/a/private-one' });
  assert.ok((await activityOf(s.id)).some((r) => r.activity_date === addDays(S, 1)));
  const [only] = (await admin.rpc('rkc_admin_manual_contributions')).data.filter((r) => r.student_id === s.id);
  await admin.from('manual_contributions').delete().eq('id', only.id);
  assert.ok(!(await activityOf(s.id)).some((r) => r.activity_date === addDays(S, 1)));

  // deleting the contributor removes everything without errors
  await admin.from('manual_contributions').insert({ student_id: s.id, activity_date: day, commit_count: 1, repo_url: 'https://github.com/a/private-three' });
  assert.equal((await admin.from('students').delete().eq('id', s.id)).error, null);
  assert.equal((await activityOf(s.id)).length, 0);
});
