import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeStreaks, buildLeaderboard, mostConsistent, todaySummary, periodSeries, periodRange, calendarValues } from '../js/stats.js';
import { addDays, startOfWeek, dateInZone, diffDays, addMonths } from '../js/dates.js';

const T = '2026-11-09'; // a Monday
const day = (n) => addDays(T, n);
const act = (student_id, activity_date, commit_count = 1) => ({ student_id, activity_date, commit_count, points: commit_count > 0 ? 10 : 0 });

test('dates: timezone day boundaries and week start', () => {
  // 20:00 UTC on Nov 8 is 01:30 Nov 9 in India
  assert.equal(dateInZone('2026-11-08T20:00:00Z', 'Asia/Kolkata'), '2026-11-09');
  assert.equal(dateInZone('2026-11-08T20:00:00Z', 'UTC'), '2026-11-08');
  assert.equal(startOfWeek('2026-11-09'), '2026-11-09'); // Monday
  assert.equal(startOfWeek('2026-11-15'), '2026-11-09'); // Sunday
  assert.equal(diffDays('2026-03-01', '2026-02-28'), 1);
  assert.equal(addMonths('2026-01-01', -1), '2025-12-01');
});

test('streaks: current streak survives until the day ends', () => {
  assert.deepEqual(computeStreaks([], T), { current: 0, best: 0 });
  assert.deepEqual(computeStreaks([T, day(-1), day(-2)], T), { current: 3, best: 3 });
  // nothing today yet, but yesterday + day before: streak still alive
  assert.deepEqual(computeStreaks([day(-1), day(-2)], T), { current: 2, best: 2 });
  // last commit 2 days ago: streak broken
  assert.deepEqual(computeStreaks([day(-2), day(-3)], T), { current: 0, best: 2 });
  // best streak in the past is kept
  assert.deepEqual(computeStreaks([day(-10), day(-9), day(-8), day(-7), T], T), { current: 1, best: 4 });
  // duplicates and unsorted input
  assert.deepEqual(computeStreaks([T, T, day(-1)], T), { current: 2, best: 2 });
  // future days are ignored
  assert.deepEqual(computeStreaks([day(1)], T), { current: 0, best: 0 });
});

const students = [
  { id: 1, name: 'Asha', github_username: 'asha' },
  { id: 2, name: 'Bilal', github_username: 'bilal' },
  { id: 3, name: 'Chen', github_username: 'chen' },
];

test('leaderboard: points per period, 10 per active day regardless of commit count', () => {
  const activity = [
    act(1, T, 7), // 7 commits today: still 10 points
    act(2, T, 1),
    act(2, day(-1), 3),
    act(2, day(-40), 1),
    act(3, day(-20), 2),
  ];
  const today = buildLeaderboard(students, activity, 'today', T);
  assert.deepEqual(today.map((r) => [r.student.id, r.points, r.commits, r.rank]), [[1, 10, 7, 1], [2, 10, 1, 1], [3, 0, 0, 3]]);

  const week = buildLeaderboard(students, activity, 'week', T); // week = Mon Nov 9 only
  assert.equal(week.find((r) => r.student.id === 2).points, 10);

  const all = buildLeaderboard(students, activity, 'all', T);
  assert.deepEqual(all.map((r) => [r.student.id, r.points]), [[2, 30], [1, 10], [3, 10]]);
  assert.deepEqual(all.map((r) => r.rank), [1, 2, 2]); // ties share a rank
  const bilal = all[0];
  assert.equal(bilal.currentStreak, 2);
  assert.equal(bilal.totalPoints, 30);
  assert.equal(bilal.consistency, 2); // day -40 is outside the 30-day window
});

test('leaderboard: no student exceeds 10 points per day', () => {
  const activity = Array.from({ length: 30 }, (_, i) => act(1, day(-i), 50));
  const [r] = buildLeaderboard([students[0]], activity, 'all', T);
  assert.equal(r.points, 300);
  assert.equal(r.activeDays, 30);
});

test('periodRange', () => {
  assert.deepEqual(periodRange('today', T), [T, T]);
  assert.deepEqual(periodRange('week', '2026-11-12'), ['2026-11-09', '2026-11-12']);
  assert.deepEqual(periodRange('month', T), ['2026-11-01', T]);
  assert.deepEqual(periodRange('all', T), [null, T]);
});

test('mostConsistent ranks by active days in last 30 days, skips inactive', () => {
  const activity = [act(1, T), act(1, day(-1)), act(2, day(-5)), act(2, day(-6)), act(2, day(-7))];
  const top = mostConsistent(buildLeaderboard(students, activity, 'all', T));
  assert.deepEqual(top.map((r) => r.student.id), [2, 1]);
});

test('todaySummary ignores rows of removed students', () => {
  const activity = [act(1, T, 3), act(2, T, 1), act(3, day(-1)), act(99, T, 5)];
  assert.deepEqual(todaySummary(students, activity, T), { totalStudents: 3, activeToday: 2, commitsToday: 4, pointsToday: 20 });
});

test('periodSeries weekly and monthly buckets', () => {
  const activity = [act(1, T, 2), act(2, day(-1), 1), act(1, day(-8), 4), act(1, '2026-10-15', 1)];
  const w = periodSeries(activity, T, 'week', 3);
  assert.deepEqual(w.map((b) => b.start), [addDays(startOfWeek(T), -14), addDays(startOfWeek(T), -7), startOfWeek(T)]);
  // day(-8) = Sun Nov 1 belongs to the week of Oct 26
  assert.deepEqual(w.map((b) => [b.commits, b.points, b.activeStudents]), [[4, 10, 1], [1, 10, 1], [2, 10, 1]]);
  const m = periodSeries(activity, T, 'month', 2);
  assert.deepEqual(m.map((b) => [b.start, b.end, b.points]), [['2026-10-01', '2026-10-31', 10], ['2026-11-01', '2026-11-30', 30]]);
});

test('calendarValues', () => {
  const activity = [act(1, T, 2), act(2, T, 5), act(1, day(-1), 1)];
  assert.equal(calendarValues(activity, 'students').get(T), 2);
  assert.equal(calendarValues(activity, 'commits').get(T), 7);
});
