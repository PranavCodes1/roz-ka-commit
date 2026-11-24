// Pure statistics over `daily_activity` rows. No DOM, no network — unit tested.
// activity row: { student_id, activity_date: 'YYYY-MM-DD', commit_count, points }
import { addDays, diffDays, startOfWeek, startOfMonth, addMonths, formatDay } from './dates.js';

export const FILTERS = {
  today: 'Today',
  week: 'This week',
  month: 'This month',
  all: 'All time',
};

/** Inclusive [from, to] for a leaderboard filter. `from` is null for all time. */
export function periodRange(filter, today) {
  switch (filter) {
    case 'today': return [today, today];
    case 'week': return [startOfWeek(today), today];
    case 'month': return [startOfMonth(today), today];
    case 'all': return [null, today];
    default: throw new Error(`Unknown filter: ${filter}`);
  }
}

const inRange = (day, [from, to]) => (from === null || day >= from) && day <= to;

/** Inactive calendar dates tolerated between active days in a streak. */
export const STREAK_GRACE_DAYS = 3;

/**
 * Grace-aware streaks from active dates (any order, duplicates allowed).
 * Missing dates never increase the count. A gap of at most `graceDays` missed
 * dates keeps active days in the same streak. The current streak stays alive
 * through today so a contributor can still return during the grace window.
 */
export function computeStreaks(days, today, graceDays = STREAK_GRACE_DAYS) {
  const sorted = [...new Set(days)].filter((d) => d <= today).sort();
  const maxActiveDateGap = graceDays + 1;
  let best = 0;
  let run = 0;
  for (let i = 0; i < sorted.length; i++) {
    run = i > 0 && diffDays(sorted[i], sorted[i - 1]) <= maxActiveDateGap ? run + 1 : 1;
    if (run > best) best = run;
  }
  let current = 0;
  const last = sorted[sorted.length - 1];
  if (last && diffDays(today, last) <= maxActiveDateGap) {
    current = 1;
    for (let i = sorted.length - 1; i > 0 && diffDays(sorted[i], sorted[i - 1]) <= maxActiveDateGap; i--) current++;
  }
  return { current, best };
}

function groupByStudent(activity) {
  const map = new Map();
  for (const row of activity) {
    if (!map.has(row.student_id)) map.set(row.student_id, []);
    map.get(row.student_id).push(row);
  }
  return map;
}

/**
 * One row per student with period totals plus all-time stats, sorted and ranked.
 * Order: points desc → active days desc → commits desc → name.
 * Dense ranking by points: equal points share a rank and the next rank follows on (1, 1, 2).
 */
export function buildLeaderboard(students, activity, filter, today) {
  const range = periodRange(filter, today);
  const byStudent = groupByStudent(activity);

  const rows = students.map((s) => {
    const rowsFor = (byStudent.get(s.id) || []).filter((r) => r.activity_date <= today);
    const period = rowsFor.filter((r) => inRange(r.activity_date, range));
    const activeRows = rowsFor.filter((r) => r.commit_count > 0);
    const streaks = computeStreaks(activeRows.map((r) => r.activity_date), today);
    return {
      student: s,
      points: sum(period, 'points'),
      commits: sum(period, 'commit_count'),
      activeDays: period.filter((r) => r.commit_count > 0).length,
      totalPoints: sum(rowsFor, 'points'),
      totalActiveDays: new Set(activeRows.map((r) => r.activity_date)).size,
      currentStreak: streaks.current,
      bestStreak: streaks.best,
      // display only (the bar in "Most consistent"): active days in the last 30 IST days
      activeLast30: activeRows.filter((r) => r.activity_date >= addDays(today, -29)).length,
    };
  });

  rows.sort((a, b) =>
    b.points - a.points ||
    b.activeDays - a.activeDays ||
    b.commits - a.commits ||
    a.student.name.localeCompare(b.student.name));

  rows.forEach((r, i) => {
    r.rank = i === 0 ? 1 : rows[i - 1].points === r.points ? rows[i - 1].rank : rows[i - 1].rank + 1;
  });
  return rows;
}

/** Active days in the current grace-aware streak needed for the Consistent tag. */
export const CONSISTENT_MIN_DAYS = 3;

/**
 * Consistent contributors have at least `minDays` active dates in their CURRENT streak.
 * Up to STREAK_GRACE_DAYS missed dates can fall between active dates; missed dates don't
 * increase the count. It doesn't depend on points or other contributors. The current
 * streak stays alive through the grace window and the current day. Longest first, then name.
 */
export function consistentContributors(rows, minDays = CONSISTENT_MIN_DAYS) {
  return rows
    .filter((r) => r.currentStreak >= minDays)
    .sort((a, b) => b.currentStreak - a.currentStreak || a.student.name.localeCompare(b.student.name));
}

/**
 * Lifetime active-day milestones. Keep thresholds in sync with rkc_milestones() in
 * supabase/schema.sql, which stores the announcements.
 */
export const MILESTONES = [
  { days: 5, emoji: '🔥', name: 'On Fire', note: 'Building a habit' },
  { days: 7, emoji: '⚡', name: 'Week Warrior', note: 'Seven active days' },
  { days: 14, emoji: '💪', name: 'Dedicated Coder', note: 'Fourteen active days' },
  { days: 21, emoji: '🏆', name: 'Habit Builder', note: 'Twenty-one active days' },
  { days: 30, emoji: '💎', name: 'Monthly Champion', note: 'Thirty active days' },
  { days: 50, emoji: '🚀', name: 'Code Explorer', note: 'Fifty active days' },
  { days: 75, emoji: '🌟', name: 'Code Enthusiast', note: 'Seventy-five active days' },
  { days: 100, emoji: '👑', name: 'Century Coder', note: 'One hundred active days' },
  { days: 150, emoji: '🥇', name: 'Elite Coder', note: 'One hundred fifty active days' },
  { days: 200, emoji: '🛡️', name: 'Code Guardian', note: 'Two hundred active days' },
  { days: 365, emoji: '🏅', name: 'Year-Round Coder', note: 'Three hundred sixty-five active days' },
];

/** The highest milestone reached by `activeDays`, or null. */
export function milestoneFor(activeDays) {
  let found = null;
  for (const m of MILESTONES) if (activeDays >= m.days) found = m;
  return found;
}

/** The milestone with exactly `days` days (for stored announcements), or null. */
export const milestoneByDays = (days) => MILESTONES.find((m) => m.days === days) || null;

/** A comeback requires activity to resume after the grace-aware streak has reset. */
export const COMEBACK = { minGap: STREAK_GRACE_DAYS + 1, minStreak: 1 };

/**
 * If the contributor's CURRENT grace-aware streak is at least `minStreak` active days
 * and began right after a break of at least `minGap` inactive dates, following
 * earlier activity, return { streak, gap, since, before }. Otherwise null.
 * (Someone who has never been active before the streak is a newcomer, not a comeback.)
 */
export function findComeback(days, today, { minGap = COMEBACK.minGap, minStreak = COMEBACK.minStreak } = {}) {
  const sorted = [...new Set(days)].filter((d) => d <= today).sort();
  const { current } = computeStreaks(sorted, today);
  if (current < minStreak) return null;
  const since = sorted[sorted.length - current]; // first day of the current streak
  const before = sorted[sorted.length - current - 1]; // last active day before the break
  if (!before) return null;
  const gap = diffDays(since, before) - 1; // inactive days in between
  return gap >= minGap ? { streak: current, gap, since, before } : null;
}

/**
 * Everyone currently on a comeback (each one a "comeback champ"), best first:
 * longest comeback streak, then longest break, then name.
 */
export function comebackChamps(students, activity, today, opts) {
  const byStudent = groupByStudent(activity);
  return students
    .map((s) => {
      const days = (byStudent.get(s.id) || []).filter((r) => r.commit_count > 0).map((r) => r.activity_date);
      const c = findComeback(days, today, opts);
      return c && { student: s, ...c };
    })
    .filter(Boolean)
    .sort((a, b) => b.streak - a.streak || b.gap - a.gap || a.student.name.localeCompare(b.student.name));
}

/** Headline numbers for today. */
export function todaySummary(students, activity, today) {
  const ids = new Set(students.map((s) => s.id));
  const todays = activity.filter((r) => r.activity_date === today && ids.has(r.student_id));
  return {
    totalStudents: students.length,
    activeToday: todays.filter((r) => r.commit_count > 0).length,
    commitsToday: sum(todays, 'commit_count'),
    pointsToday: sum(todays, 'points'),
  };
}

/**
 * Totals per week (Mon–Sun) or per calendar month, oldest first, ending with
 * the bucket that contains `today`.
 */
export function periodSeries(activity, today, unit, count = 12) {
  const buckets = [];
  if (unit === 'day') {
    for (let i = count - 1; i >= 0; i--) {
      const start = addDays(today, -i);
      buckets.push({ start, end: start, label: formatDay(start, { day: 'numeric', month: 'short' }) });
    }
  } else if (unit === 'week') {
    const thisWeek = startOfWeek(today);
    for (let i = count - 1; i >= 0; i--) {
      const start = addDays(thisWeek, -7 * i);
      buckets.push({ start, end: addDays(start, 6), label: formatDay(start, { day: 'numeric', month: 'short' }) });
    }
  } else if (unit === 'month') {
    const thisMonth = startOfMonth(today);
    for (let i = count - 1; i >= 0; i--) {
      const start = addMonths(thisMonth, -i);
      buckets.push({ start, end: addDays(addMonths(start, 1), -1), label: formatDay(start, { month: 'short', year: '2-digit' }) });
    }
  } else {
    throw new Error(`Unknown unit: ${unit}`);
  }
  for (const b of buckets) {
    const rows = activity.filter((r) => r.activity_date >= b.start && r.activity_date <= b.end && r.activity_date <= today);
    b.commits = sum(rows, 'commit_count');
    b.points = sum(rows, 'points');
    b.activeStudents = new Set(rows.filter((r) => r.commit_count > 0).map((r) => r.student_id)).size;
    b.activeDays = rows.filter((r) => r.commit_count > 0).length; // student-days
  }
  return buckets;
}

/** Map of day → value for a calendar. `value` picks what a cell measures. */
export function calendarValues(activity, value = 'students') {
  const map = new Map();
  for (const r of activity) {
    if (r.commit_count <= 0) continue;
    const add = value === 'commits' ? r.commit_count : 1;
    map.set(r.activity_date, (map.get(r.activity_date) || 0) + add);
  }
  return map;
}

function sum(rows, key) {
  let t = 0;
  for (const r of rows) t += Number(r[key]) || 0;
  return t;
}
