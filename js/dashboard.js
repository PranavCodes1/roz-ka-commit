// Public dashboard + leaderboard. Read-only: works for any visitor.
import { CONFIG } from './config.js';
import { configError, loadStudents, loadActivity, loadRecentCommits } from './db.js';
import { todayIn, addDays, formatDay, startOfWeek, startOfMonth } from './dates.js';
import { buildLeaderboard, mostConsistent, todaySummary, periodSeries, calendarValues, computeStreaks, FILTERS } from './stats.js';
import { $, esc, avatar, ghUrl, loadingHtml, emptyHtml, errorHtml, relativeTime, errMsg, calendarHtml } from './ui.js';

const state = { students: [], activity: [], filter: 'all', unit: 'week', chart: null, loaded: false };
const today = () => todayIn(CONFIG.TIMEZONE);

$('#tzName').textContent = CONFIG.TIMEZONE;

async function load() {
  const btn = $('#refreshBtn');
  btn.disabled = true;
  if (!state.loaded) {
    for (const id of ['#leaderboard', '#consistent', '#periodSummary', '#calendar']) $(id).innerHTML = loadingHtml();
  }
  $('#pageAlert').innerHTML = '';
  try {
    const [students, activity] = await Promise.all([loadStudents(), loadActivity()]);
    state.students = students;
    state.activity = activity;
    state.loaded = true;
    render();
  } catch (err) {
    console.error(err);
    $('#pageAlert').innerHTML = `<div class="mb-4">${errorHtml('Could not load data: ' + errMsg(err))}</div>`;
    if (!state.loaded) for (const id of ['#leaderboard', '#consistent', '#periodSummary', '#calendar']) $(id).innerHTML = '';
  } finally {
    btn.disabled = false;
  }
}

function render() {
  const t = today();
  const s = todaySummary(state.students, state.activity, t);
  $('#statStudents').textContent = s.totalStudents;
  $('#statActive').textContent = `${s.activeToday}${s.totalStudents ? ` / ${s.totalStudents}` : ''}`;
  $('#statCommits').textContent = s.commitsToday;
  $('#statPoints').textContent = s.pointsToday;

  const synced = state.students.map((x) => x.last_synced_at).filter(Boolean).sort().at(-1);
  $('#lastSynced').textContent = `GitHub synced ${relativeTime(synced)}`;

  renderLeaderboard(t);
  renderPeriodSummary(t);
  renderCalendar(t);
  renderChart(t);
}

function renderLeaderboard(t) {
  const el = $('#leaderboard');
  if (!state.students.length) {
    el.innerHTML = emptyHtml('No students yet. An admin can add students on the <a href="admin.html">Admin</a> page.', 'bi-people');
    $('#consistent').innerHTML = emptyHtml('Nothing to show yet.');
    return;
  }
  const rows = buildLeaderboard(state.students, state.activity, state.filter, t);
  const top = mostConsistent(buildLeaderboard(state.students, state.activity, 'all', t));
  // The gem marks the most consistent student(s): highest active-day count, ties included.
  const topIds = new Set(top.filter((r) => r.consistency === top[0].consistency).map((r) => r.student.id));

  const medal = (rank) => (rank <= 3 ? `<span class="rank rank-${rank}">${rank}</span>` : `<span class="rank">${rank}</span>`);
  const body = rows.map((r) => `
    <tr data-student="${r.student.id}" class="${topIds.has(r.student.id) ? 'consistent-row' : ''}" tabindex="0" role="button">
      <td class="text-center">${medal(r.rank)}</td>
      <td>
        <div class="d-flex align-items-center gap-2">
          ${avatar(r.student)}
          <div class="min-w-0">
            <div class="fw-semibold text-truncate">${esc(r.student.name)}
              ${topIds.has(r.student.id) ? '<i class="bi bi-gem text-info ms-1" title="Most consistent"></i>' : ''}</div>
            <a class="small font-monospace link-secondary" href="${ghUrl(r.student.github_username)}" target="_blank" rel="noopener"
               onclick="event.stopPropagation()">@${esc(r.student.github_username)} <i class="bi bi-box-arrow-up-right"></i></a>
          </div>
        </div>
      </td>
      <td class="text-end fw-bold">${r.points}</td>
      <td class="text-end d-none d-sm-table-cell">${r.commits}</td>
      <td class="text-end d-none d-md-table-cell">${r.activeDays}</td>
      <td class="text-end">${r.currentStreak ? `<i class="bi bi-fire text-warning"></i> ${r.currentStreak}` : '0'}</td>
      <td class="text-end d-none d-md-table-cell">${r.bestStreak}</td>
    </tr>`).join('');

  el.innerHTML = `
    <div class="table-responsive">
      <table class="table table-hover align-middle mb-0 leaderboard">
        <thead><tr>
          <th class="text-center">#</th><th>Student</th>
          <th class="text-end">Points</th>
          <th class="text-end d-none d-sm-table-cell">Commits</th>
          <th class="text-end d-none d-md-table-cell">Active days</th>
          <th class="text-end" title="Consecutive days with a commit">Streak</th>
          <th class="text-end d-none d-md-table-cell">Best</th>
        </tr></thead>
        <tbody>${body}</tbody>
      </table>
    </div>
    <div class="px-3 py-2 small text-body-secondary border-top">${esc(FILTERS[state.filter])} · ${periodLabel(t)}</div>`;

  el.querySelectorAll('tr[data-student]').forEach((tr) => {
    const open = () => openStudent(Number(tr.dataset.student));
    tr.addEventListener('click', open);
    tr.addEventListener('keydown', (e) => { if (e.key === 'Enter') open(); });
  });

  $('#consistent').innerHTML = top.length
    ? `<ol class="list-unstyled mb-0 d-flex flex-column gap-3">${top.map((r) => `
        <li class="d-flex align-items-center gap-2">
          ${avatar(r.student, 36)}
          <div class="flex-grow-1 min-w-0">
            <div class="fw-semibold text-truncate">${esc(r.student.name)}</div>
            <div class="small text-body-secondary">${r.consistency}/30 days · streak ${r.currentStreak} · best ${r.bestStreak}</div>
          </div>
        </li>`).join('')}</ol>`
    : emptyHtml('No commits in the last 30 days yet.');
}

function periodLabel(t) {
  const [from] = { today: [t], week: [startOfWeek(t)], month: [startOfMonth(t)], all: [null] }[state.filter];
  return from ? (from === t ? formatDay(t) : `${formatDay(from)} – ${formatDay(t)}`) : `up to ${formatDay(t)}`;
}

function renderPeriodSummary(t) {
  const week = periodSeries(state.activity, t, 'week', 2);
  const month = periodSeries(state.activity, t, 'month', 2);
  const row = (label, cur, prev) => {
    const delta = cur.points - prev.points;
    const d = delta === 0 ? '' : `<span class="small ${delta > 0 ? 'text-success' : 'text-danger'}">${delta > 0 ? '▲' : '▼'} ${Math.abs(delta)}</span>`;
    return `<tr><th class="fw-normal text-body-secondary">${label}</th>
      <td class="text-end"><span class="fw-semibold">${cur.points}</span> pts ${d}</td>
      <td class="text-end">${cur.commits} commits</td>
      <td class="text-end">${cur.activeStudents} active</td></tr>`;
  };
  $('#periodSummary').innerHTML = `
    <table class="table table-sm mb-0 small align-middle">
      <tbody>
        ${row('This week', week[1], week[0])}
        ${row('Last week', week[0], { points: week[0].points })}
        ${row('This month', month[1], month[0])}
        ${row('Last month', month[0], { points: month[0].points })}
      </tbody>
    </table>`;
}

function renderCalendar(t) {
  const n = state.students.length;
  if (!n) { $('#calendar').innerHTML = emptyHtml('No activity yet.'); return; }
  const values = calendarValues(state.activity, 'students');
  $('#calendar').innerHTML = calendarHtml(values, {
    from: addDays(t, -364), to: t,
    level: (v) => (v === 0 ? 0 : Math.min(4, Math.ceil((v / n) * 4))),
    label: (v) => `${v} of ${n} student${n === 1 ? '' : 's'} active`,
  });
}

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function renderChart(t) {
  const series = periodSeries(state.activity, t, state.unit, 12);
  const hasData = series.some((b) => b.commits > 0);
  $('#chartState').innerHTML = hasData ? '' : emptyHtml('No commits recorded in this range yet.', 'bi-bar-chart');
  $('#chart').parentElement.classList.toggle('d-none', !hasData);
  if (!hasData || typeof Chart === 'undefined') return;

  const text = cssVar('--bs-secondary-color');
  const grid = cssVar('--bs-border-color');
  const data = {
    labels: series.map((b) => b.label),
    datasets: [
      { type: 'bar', label: 'Points', data: series.map((b) => b.points), backgroundColor: cssVar('--rkc-green'), borderRadius: 3, yAxisID: 'y' },
      { type: 'line', label: 'Commits', data: series.map((b) => b.commits), borderColor: cssVar('--rkc-blue'), backgroundColor: cssVar('--rkc-blue'), tension: 0.25, yAxisID: 'y1' },
    ],
  };
  const options = {
    responsive: true, maintainAspectRatio: false, animation: false,
    interaction: { mode: 'index', intersect: false },
    plugins: {
      legend: { labels: { color: text } },
      tooltip: { callbacks: { afterBody: (items) => `Active students: ${series[items[0].dataIndex].activeStudents}` } },
    },
    scales: {
      x: { ticks: { color: text }, grid: { display: false } },
      y: { beginAtZero: true, position: 'left', title: { display: true, text: 'Points', color: text }, ticks: { color: text, precision: 0 }, grid: { color: grid } },
      y1: { beginAtZero: true, position: 'right', title: { display: true, text: 'Commits', color: text }, ticks: { color: text, precision: 0 }, grid: { display: false } },
    },
  };
  if (state.chart) state.chart.destroy();
  state.chart = new Chart($('#chart'), { data, options });
}

async function openStudent(id) {
  const s = state.students.find((x) => x.id === id);
  if (!s) return;
  const t = today();
  const rows = state.activity.filter((r) => r.student_id === id);
  const streaks = computeStreaks(rows.map((r) => r.activity_date), t);
  const total = rows.reduce((a, r) => a + r.points, 0);
  const commits = rows.reduce((a, r) => a + r.commit_count, 0);

  $('#studentModalTitle').innerHTML = `${avatar(s, 28)} <span class="ms-2">${esc(s.name)}</span>`;
  $('#studentModalBody').innerHTML = `
    <p class="mb-3"><a href="${ghUrl(s.github_username)}" target="_blank" rel="noopener" class="font-monospace">github.com/${esc(s.github_username)}</a>
      <span class="small text-body-secondary ms-2">synced ${relativeTime(s.last_synced_at)}</span></p>
    <div class="row g-2 mb-3 text-center">
      ${[['Total points', total], ['Commits', commits], ['Active days', rows.length], ['Current streak', streaks.current], ['Best streak', streaks.best]]
        .map(([k, v]) => `<div class="col"><div class="border rounded py-2"><div class="fs-5 fw-bold">${v}</div><div class="small text-body-secondary">${k}</div></div></div>`).join('')}
    </div>
    <h3 class="h6">Contribution calendar</h3>
    <div class="mb-3">${calendarHtml(calendarValues(rows, 'commits'), {
      from: addDays(t, -364), to: t,
      level: (v) => (v === 0 ? 0 : v === 1 ? 1 : v <= 3 ? 2 : v <= 6 ? 3 : 4),
      label: (v) => `${v} commit${v === 1 ? '' : 's'}`,
    })}</div>
    <h3 class="h6">Recent commits</h3>
    <div id="recentCommits">${loadingHtml()}</div>`;
  bootstrap.Modal.getOrCreateInstance($('#studentModal')).show();

  try {
    const list = await loadRecentCommits(id);
    $('#recentCommits').innerHTML = list.length
      ? `<ul class="list-group list-group-flush small">${list.map((c) => `
          <li class="list-group-item px-0 d-flex gap-2">
            <a class="font-monospace" href="${esc(c.html_url || '#')}" target="_blank" rel="noopener">${esc(c.sha.slice(0, 7))}</a>
            <div class="min-w-0 flex-grow-1"><div class="text-truncate">${esc(c.message || '(no message)')}</div>
              <div class="text-body-secondary">${esc(c.repo_full_name)} · ${esc(formatDay(c.commit_date))}</div></div>
          </li>`).join('')}</ul>`
      : emptyHtml('No commits synced yet.');
  } catch (err) {
    $('#recentCommits').innerHTML = errorHtml(errMsg(err));
  }
}

// Wire up controls
$('#filterGroup').addEventListener('click', (e) => {
  const b = e.target.closest('[data-filter]');
  if (!b) return;
  state.filter = b.dataset.filter;
  $('#filterGroup').querySelectorAll('button').forEach((x) => x.classList.toggle('active', x === b));
  if (state.loaded) renderLeaderboard(today());
});
$('#chartGroup').addEventListener('click', (e) => {
  const b = e.target.closest('[data-unit]');
  if (!b) return;
  state.unit = b.dataset.unit;
  $('#chartGroup').querySelectorAll('button').forEach((x) => x.classList.toggle('active', x === b));
  if (state.loaded) renderChart(today());
});
document.addEventListener('rkc-theme', () => state.loaded && renderChart(today()));
$('#refreshBtn').addEventListener('click', load);

if (configError) {
  $('#pageAlert').innerHTML = `<div class="mb-4">${errorHtml(configError)}</div>`;
  $('#refreshBtn').disabled = true;
  for (const id of ['#leaderboard', '#consistent', '#periodSummary', '#calendar']) $(id).innerHTML = emptyHtml('Waiting for configuration.');
  $('#chartState').innerHTML = '';
  $('#chart').parentElement.classList.add('d-none');
} else {
  load();
}
