// Small DOM helpers shared by the dashboard and admin pages.
import { addDays, eachDay, startOfWeek, formatDay } from './dates.js';

export const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const $ = (sel, root = document) => root.querySelector(sel);

export const ghUrl = (username) => `https://github.com/${encodeURIComponent(username)}`;

export function avatar(student, size = 32) {
  const src = student.avatar_url || `https://github.com/${encodeURIComponent(student.github_username)}.png?size=${size * 2}`;
  return `<img src="${esc(src)}" alt="" width="${size}" height="${size}" class="rounded-circle avatar" loading="lazy">`;
}

export function loadingHtml(text = 'Loading…') {
  return `<div class="state-box"><div class="spinner-border spinner-border-sm me-2" role="status"></div>${esc(text)}</div>`;
}

export function emptyHtml(text, icon = 'bi-inbox') {
  return `<div class="state-box text-body-secondary"><i class="bi ${icon} fs-4 d-block mb-2"></i>${text}</div>`;
}

export function errorHtml(text) {
  return `<div class="alert alert-danger mb-0" role="alert"><i class="bi bi-exclamation-triangle me-2"></i>${esc(text)}</div>`;
}

export function relativeTime(iso) {
  if (!iso) return 'never';
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}

/** Friendly message for Supabase / GitHub / network errors. */
export function errMsg(err) {
  if (!err) return 'Unknown error';
  if (err.code === '23505') return 'That GitHub username is already registered.';
  if (err.code === '42501') return 'Permission denied. Are you signed in as an admin?';
  if (err.code === '23514') return 'Invalid value (check the name and GitHub username).';
  if (err.message === 'Failed to fetch') return 'Network error — check your connection and Supabase URL.';
  return err.message || String(err);
}

/**
 * GitHub-style contribution calendar, Monday-first weeks as columns.
 * values: Map(day -> number); level(v) -> 0..4; label(v) -> tooltip text.
 */
export function calendarHtml(values, { from, to, level, label }) {
  const start = startOfWeek(from);
  const weeks = [];
  for (let w = start; w <= to; w = addDays(w, 7)) weeks.push(w);
  let lastMonth = '';
  const cols = weeks.map((weekStart) => {
    const month = weekStart.slice(0, 7);
    const showMonth = month !== lastMonth;
    lastMonth = month;
    const cells = eachDay(weekStart, addDays(weekStart, 6)).map((d) => {
      if (d < from || d > to) return '<div class="cal-cell cal-out"></div>';
      const v = values.get(d) || 0;
      return `<div class="cal-cell cal-l${level(v)}" title="${esc(formatDay(d))}: ${esc(label(v))}"></div>`;
    }).join('');
    const m = showMonth ? formatDay(weekStart, { month: 'short' }) : '';
    return `<div class="cal-week"><div class="cal-month">${m}</div>${cells}</div>`;
  }).join('');
  const days = ['Mon', '', 'Wed', '', 'Fri', '', ''].map((d) => `<div class="cal-dow">${d}</div>`).join('');
  const legend = [0, 1, 2, 3, 4].map((l) => `<div class="cal-cell cal-l${l}"></div>`).join('');
  return `<div class="cal-scroll"><div class="cal"><div class="cal-week cal-labels"><div class="cal-month"></div>${days}</div>${cols}</div></div>
    <div class="cal-legend small text-body-secondary">Less ${legend} More</div>`;
}
