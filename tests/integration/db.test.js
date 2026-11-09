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

test('points: first commit of a day = 10, more commits = 0 extra, duplicates ignored, timezone applied', async () => {
  const s = await addStudent('-pts');
  const rows = [
    commit(s, 1, '2026-10-31T20:00:00Z'), // 01:30 Nov 1 IST
    commit(s, 2, '2026-11-01T05:00:00Z'), // Nov 1 IST
    commit(s, 3, '2026-11-01T06:00:00Z'), // Nov 1 IST
    commit(s, 4, '2026-10-30T10:00:00Z'), // Oct 30 IST
    commit(s, 5, '2099-12-31T20:59:59Z'), // spoofed future: dropped by trigger
  ];
  const up = (r) => admin.from('commits').upsert(r, { onConflict: 'student_id,sha', ignoreDuplicates: true }).select('id');
  const first = await up(rows);
  assert.equal(first.error, null);
  assert.equal(first.data.length, 4);
  const again = await up([...rows, commit(s, 1, '2026-10-31T20:00:00Z')]); // re-sync: nothing new
  assert.equal(again.data.length, 0);

  assert.deepEqual((await activityOf(s.id)).map((r) => [r.activity_date, r.commit_count, r.points]),
    [['2026-10-30', 1, 10], ['2026-11-01', 3, 10]]);

  // one new commit on an existing day: count goes up, points stay at the 10 cap
  await up([commit(s, 6, '2026-11-01T07:00:00Z')]);
  const last = (await activityOf(s.id)).at(-1);
  assert.deepEqual([last.commit_count, last.points], [4, 10]);

  // admin maintenance function rebuilds the same result
  assert.equal((await admin.rpc('rkc_rebuild_daily_activity')).error, null);
  assert.deepEqual((await activityOf(s.id)).map((r) => [r.activity_date, r.commit_count, r.points]),
    [['2026-10-30', 1, 10], ['2026-11-01', 4, 10]]);
});

test('editing the GitHub username clears old history; deleting removes everything', async () => {
  const s = await addStudent('-edit');
  await admin.from('commits').insert(commit(s, 10, '2026-11-01T10:00:00Z'));
  await admin.from('students').update({ last_synced_at: new Date().toISOString() }).eq('id', s.id);
  assert.equal((await activityOf(s.id)).length, 1);

  // name-only edit keeps history
  await admin.from('students').update({ name: 'Renamed' }).eq('id', s.id);
  assert.equal((await activityOf(s.id)).length, 1);

  const { data } = await admin.from('students').update({ github_username: `rkc-${tag}-edit2` }).eq('id', s.id).select().single();
  assert.equal(data.last_synced_at, null);
  assert.equal((await activityOf(s.id)).length, 0);
  assert.equal((await anon.from('commits').select('id').eq('student_id', s.id)).data.length, 0);

  await admin.from('commits').insert(commit(s, 11, '2026-11-02T10:00:00Z'));
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
    const r1 = await syncStudent(s, { github, store, timeZone: 'Asia/Kolkata', backfillDays: 60 });
    console.log('  live sync:', r1);
    assert.equal(r1.inserted, r1.unique);

    const { data: commits } = await anon.from('commits').select('sha, commit_date').eq('student_id', s.id);
    const days = new Set(commits.map((c) => c.commit_date));
    const act = await activityOf(s.id);
    assert.equal(act.length, days.size);
    assert.equal(act.reduce((a, r) => a + r.points, 0), 10 * days.size);
    assert.equal(act.reduce((a, r) => a + r.commit_count, 0), commits.length);
    assert.ok(act.every((r) => r.points === 10));

    const r2 = await syncStudent({ ...s, last_synced_at: new Date().toISOString() }, { github, store, timeZone: 'Asia/Kolkata', backfillDays: 60 });
    assert.equal(r2.inserted, 0, 'second sync must not duplicate commits');
  } finally {
    await service.from('students').delete().eq('id', s.id);
  }
});
