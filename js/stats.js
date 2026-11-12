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

/**
 * Streaks from a list of active days (any order, duplicates allowed).
 * The current streak stays alive until the end of today: if a student has
 * not committed yet today, a streak ending yesterday still counts.
 */
export function computeStreaks(days, today) {
  const sorted = [...new Set(days)].filter((d) => d <= today).sort();
  let best = 0;
  let run = 0;
  for (let i = 0; i < sorted.length; i++) {
    run = i > 0 && diffDays(sorted[i], sorted[i - 1]) === 1 ? run + 1 : 1;
    if (run > best) best = run;
  }
  let current = 0;
  const last = sorted[sorted.length - 1];
  if (last && diffDays(today, last) <= 1) {
    current = 1;
    for (let i = sorted.length - 1; i > 0 && diffDays(sorted[i], sorted[i - 1]) === 1; i--) current++;
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

/** Days active in the last `window` days (including today). */
export const CONSISTENCY_WINDOW = 30;

/**
 * One row per student with period totals plus all-time stats, sorted and ranked.
 * Order: points desc → active days desc → commits desc → name.
 * Dense ranking by points: equal points share a rank and the next rank follows on (1, 1, 2).
 */
export function buildLeaderboard(students, activity, filter, today) {
  const range = periodRange(filter, today);
  const consistencyFrom = addDays(today, -(CONSISTENCY_WINDOW - 1));
  const byStudent = groupByStudent(activity);

  const rows = students.map((s) => {
    const rowsFor = (byStudent.get(s.id) || []).filter((r) => r.activity_date <= today);
    const period = rowsFor.filter((r) => inRange(r.activity_date, range));
    const streaks = computeStreaks(rowsFor.map((r) => r.activity_date), today);
    return {
      student: s,
      points: sum(period, 'points'),
      commits: sum(period, 'commit_count'),
      activeDays: period.filter((r) => r.commit_count > 0).length,
      totalPoints: sum(rowsFor, 'points'),
      currentStreak: streaks.current,
      bestStreak: streaks.best,
      consistency: rowsFor.filter((r) => r.activity_date >= consistencyFrom && r.commit_count > 0).length,
      consistencyPoints: sum(rowsFor.filter((r) => r.activity_date >= consistencyFrom), 'points'),
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

/** A contributor needs at least this many active days in the window to be called consistent. */
export const CONSISTENT_MIN_DAYS = 3;

/**
 * The most consistent contributors: highest points in the last 30 days, with EVERY
 * contributor tied at that score included (not a fixed top 3). Empty until the leader
 * has at least CONSISTENT_MIN_DAYS active days. Ties are listed by current streak, then name.
 */
export function consistentLeaders(rows, minDays = CONSISTENT_MIN_DAYS) {
  const best = Math.max(0, ...rows.map((r) => r.consistencyPoints));
  return rows
    .filter((r) => best > 0 && r.consistencyPoints === best && r.consistency >= minDays)
    .sort((a, b) => b.currentStreak - a.currentStreak || a.student.name.localeCompare(b.student.name));
}

/** Comeback rules: a break of at least MIN_GAP days with no commits, then an active run of at least MIN_STREAK days. */
export const COMEBACK = { minGap: 2, minStreak: 3 };

/**
 * If the contributor's CURRENT streak (alive today or yesterday) is at least `minStreak`
 * days and began right after a break of at least `minGap` inactive days, following
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
  if (unit === 'week') {
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
