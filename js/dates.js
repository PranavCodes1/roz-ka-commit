// Date helpers. Every "day" in RKC is a 'YYYY-MM-DD' string in the app timezone.
// Arithmetic is done on UTC midnights so DST never shifts a day.

const fmtCache = new Map();

/** 'YYYY-MM-DD' for the given instant in `timeZone`. */
export function dateInZone(instant, timeZone) {
  let fmt = fmtCache.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
    fmtCache.set(timeZone, fmt);
  }
  return fmt.format(new Date(instant));
}

export const todayIn = (timeZone, now = new Date()) => dateInZone(now, timeZone);

const toUTC = (day) => {
  const [y, m, d] = day.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
};
const fromUTC = (ms) => new Date(ms).toISOString().slice(0, 10);

export const addDays = (day, n) => fromUTC(toUTC(day) + n * 86400000);
export const diffDays = (a, b) => Math.round((toUTC(a) - toUTC(b)) / 86400000); // a - b
export const dayOfWeek = (day) => new Date(toUTC(day)).getUTCDay(); // 0 = Sunday

/** Monday of the ISO week containing `day`. */
export const startOfWeek = (day) => addDays(day, -((dayOfWeek(day) + 6) % 7));
export const startOfMonth = (day) => day.slice(0, 8) + '01';
export const addMonths = (day, n) => {
  const [y, m] = day.split('-').map(Number);
  return fromUTC(Date.UTC(y, m - 1 + n, 1));
};

/** Inclusive list of days from `from` to `to`. */
export function eachDay(from, to) {
  const out = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

export function formatDay(day, opts = { day: 'numeric', month: 'short', year: 'numeric' }) {
  return new Date(toUTC(day)).toLocaleDateString(undefined, { ...opts, timeZone: 'UTC' });
}
