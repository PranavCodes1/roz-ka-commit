import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeStreaks, buildLeaderboard, consistentContributors, findComeback, comebackChamps, todaySummary, periodSeries, periodRange, calendarValues } from '../js/stats.js';
import { addDays, startOfWeek, dateInZone, todayIn, diffDays, addMonths } from '../js/dates.js';

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
  assert.deepEqual(today.map((r) => [r.student.id, r.points, r.commits, r.rank]), [[1, 10, 7, 1], [2, 10, 1, 1], [3, 0, 0, 2]]); // dense: 1, 1, 2

  const week = buildLeaderboard(students, activity, 'week', T); // week = Mon Nov 9 only
  assert.equal(week.find((r) => r.student.id === 2).points, 10);

  const all = buildLeaderboard(students, activity, 'all', T);
  assert.deepEqual(all.map((r) => [r.student.id, r.points]), [[2, 30], [1, 10], [3, 10]]);
  assert.deepEqual(all.map((r) => r.rank), [1, 2, 2]); // ties share a rank
  const bilal = all[0];
  assert.equal(bilal.currentStreak, 2);
  assert.equal(bilal.totalPoints, 30);
});

test('leaderboard: dense ranking (ties share a rank, no gaps)', () => {
  const five = [1, 2, 3, 4, 5].map((id) => ({ id, name: `P${id}`, github_username: `p${id}` }));
  const activity = [
    act(1, T), act(1, day(-1)), act(1, day(-2)), // 30
    act(2, T), act(2, day(-1)), act(2, day(-2)), // 30
    act(3, T), act(3, day(-1)),                  // 20
    act(4, T), act(4, day(-1)),                  // 20
  ];                                             // 5: 0
  const rows = buildLeaderboard(five, activity, 'all', T);
  assert.deepEqual(rows.map((r) => [r.points, r.rank]), [[30, 1], [30, 1], [20, 2], [20, 2], [0, 3]]);
  // everyone tied (e.g. nobody has committed yet) -> all rank 1
  assert.deepEqual(buildLeaderboard(five, [], 'all', T).map((r) => r.rank), [1, 1, 1, 1, 1]);
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

test('findComeback: a break of 2+ days, then committing again (one day is enough)', () => {
  const at = (...offsets) => offsets.map((o) => day(o));
  // active, 3-day break (-6,-5,-4), back for 4 days (-3..0)
  assert.deepEqual(findComeback(at(-8, -7, -3, -2, -1, 0), T), { streak: 4, gap: 3, since: day(-3), before: day(-7) });
  // streak alive until yesterday still counts
  assert.equal(findComeback(at(-6, -3, -2, -1), T).streak, 3);
  // only a 1-day break: not a comeback
  assert.equal(findComeback(at(-5, -3, -2, -1, 0), T), null);
  // a single day back after the break is already a comeback (today or yesterday)
  assert.deepEqual(findComeback(at(-6, 0), T), { streak: 1, gap: 5, since: day(0), before: day(-6) });
  assert.deepEqual(findComeback(at(-6, -1), T), { streak: 1, gap: 4, since: day(-1), before: day(-6) }); // back yesterday
  // streak already broken (last commit 2 days ago): no
  assert.equal(findComeback(at(-9, -4, -3, -2), T), null);
  // a newcomer with no earlier activity is not a comeback
  assert.equal(findComeback(at(-2, -1, 0), T), null);
  // the comeback ends once they miss a whole day again
  assert.equal(findComeback(at(-6, -2), T), null);
  // thresholds are adjustable
  assert.equal(findComeback(at(-6, 0), T, { minGap: 2, minStreak: 3 }), null);
  assert.equal(findComeback(at(-5, -1, 0), T, { minGap: 2, minStreak: 2 }).gap, 3);
});

test('comebackChamps: everyone back after a break, longest comeback first, then longest break', () => {
  const four = [1, 2, 3, 4].map((id) => ({ id, name: `P${id}`, github_username: `p${id}` }));
  const days = (id, offsets) => offsets.map((o) => act(id, day(o)));
  const activity = [
    ...days(1, [-10, -4, -3, -2, -1, 0]), // back 5 days after 5-day break
    ...days(2, [-12, -6, -5, -4, -3, -2, -1, 0]), // back 7 days after 5-day break -> champ
    ...days(3, [-9, -3, -2, -1, 0]), // back 4 days after 5-day break
    ...days(4, [0, -1, -2, -3]), // newcomer: not listed
  ];
  const list = comebackChamps(four, activity, T);
  assert.deepEqual(list.map((c) => [c.student.id, c.streak, c.gap]), [[2, 7, 5], [1, 5, 5], [3, 4, 5]]);
  // a longer break ranks higher when the comeback streak is equal
  const two = comebackChamps(four, [...days(1, [-6, -2, -1, 0]), ...days(2, [-9, -2, -1, 0])], T);
  assert.deepEqual(two.map((c) => [c.student.id, c.gap]), [[2, 6], [1, 3]]);
  assert.deepEqual(comebackChamps(four, [], T), []);
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


// ---------- Consistent = 3+ consecutive IST days with a commit ----------
const crew = ['A', 'B', 'C'].map((name, i) => ({ id: i + 1, name, github_username: name.toLowerCase() }));
const on = (id, ...dates) => dates.map((d) => ({ student_id: id, activity_date: d, commit_count: 1, points: 10 }));
const consistent = (activity, today) =>
  consistentContributors(buildLeaderboard(crew, activity, 'all', today)).map((r) => [r.student.name, r.currentStreak]);

test('Consistent: earned after 3 consecutive days, independent of points or others', () => {
  assert.deepEqual(consistent(on(1, '2026-11-11', '2026-11-12'), '2026-11-12'), []); // 2 days: not yet
  assert.deepEqual(consistent(on(1, '2026-11-10', '2026-11-11', '2026-11-12'), '2026-11-12'), [['A', 3]]);
  // B has far more points (many old days) but no current streak: not consistent; A is, with fewer points
  const activity = [...on(1, '2026-11-10', '2026-11-11', '2026-11-12'),
    ...on(2, '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05', '2026-11-12')];
  assert.deepEqual(consistent(activity, '2026-11-12'), [['A', 3]]);
  // everyone with a long enough streak gets it; longest streak first
  const two = [...on(1, '2026-11-10', '2026-11-11', '2026-11-12'), ...on(3, '2026-11-08', '2026-11-09', '2026-11-10', '2026-11-11', '2026-11-12')];
  assert.deepEqual(consistent(two, '2026-11-12'), [['C', 5], ['A', 3]]);
});

test('Consistent: kept for the whole current day before that day\'s commit', () => {
  const streak = on(1, '2026-11-10', '2026-11-11', '2026-11-12'); // nothing yet on 13 Nov
  assert.deepEqual(consistent(streak, '2026-11-13'), [['A', 3]]); // all of 13 Nov, until 11:59 PM IST
  assert.deepEqual(consistent([...streak, ...on(1, '2026-11-13')], '2026-11-13'), [['A', 4]]); // committed: continues
});

test('Consistent: a single missed day breaks the streak at midnight IST', () => {
  const streak = on(1, '2026-11-10', '2026-11-11', '2026-11-12'); // missed 13 Nov
  assert.deepEqual(consistent(streak, '2026-11-14'), []);
  // coming back starts a new streak: Consistent again after 3 more consecutive days
  const back = [...streak, ...on(1, '2026-11-14', '2026-11-15')];
  assert.deepEqual(consistent(back, '2026-11-15'), []);
  assert.deepEqual(consistent([...back, ...on(1, '2026-11-16')], '2026-11-16'), [['A', 3]]);
});

test('Consistent: the IST clock decides the day at midnight', () => {
  const streak = on(1, '2026-11-10', '2026-11-11', '2026-11-12', '2026-11-13'); // last commit 13 Nov
  const at = (iso) => consistent(streak, todayIn('Asia/Kolkata', new Date(iso)));
  assert.deepEqual(at('2026-11-14T18:29:00Z'), [['A', 4]]); // 23:59 IST 14 Nov: still has the day to commit
  assert.deepEqual(at('2026-11-14T18:31:00Z'), []); // 00:01 IST 15 Nov: 14 Nov was missed
});

test('Consistent: points are unchanged by the new rule', () => {
  const [row] = buildLeaderboard(crew, on(1, '2026-11-10', '2026-11-11', '2026-11-12'), 'all', '2026-11-12');
  assert.deepEqual([row.points, row.activeDays, row.currentStreak, row.bestStreak, row.activeLast30], [30, 3, 3, 3, 3]);
  // the bar counts active days in the last 30 only
  const [old] = buildLeaderboard(crew, on(1, '2026-10-01', '2026-11-12'), 'all', '2026-11-12');
  assert.equal(old.activeLast30, 1);
});
