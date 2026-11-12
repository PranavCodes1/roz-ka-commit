// Public dashboard + leaderboard. Read-only: works for any visitor.
import { CONFIG } from './config.js';
import { configError, loadStudents, loadActivity, loadRecentCommits, loadTrackingStart, loadPrivateContributions, loadAllPrivateDays } from './db.js';
import { todayIn, addDays, formatDay, startOfWeek, startOfMonth } from './dates.js';
import { buildLeaderboard, consistentLeaders, comebackChamps, CONSISTENT_MIN_DAYS, todaySummary, periodSeries, calendarValues, computeStreaks, periodRange, FILTERS } from './stats.js';
import { $, esc, avatar, ghUrl, loadingHtml, emptyHtml, errorHtml, relativeTime, errMsg, calendarHtml } from './ui.js';

const state = { students: [], activity: [], privateRows: [], filter: 'all', unit: 'week', chart: null, loaded: false };
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
    const [students, activity, start, privateRows] = await Promise.all([loadStudents(), loadActivity(), loadTrackingStart(), loadAllPrivateDays()]);
    state.privateRows = privateRows;
    const startText = start ? formatDay(start) : '—';
    $('#startChip').textContent = startText;
    $('#startFoot').textContent = startText;
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
  $('#statActive').innerHTML = `${s.activeToday}${s.totalStudents ? `<span class="stat-of"> / ${s.totalStudents}</span>` : ''}`;
  $('#statCommits').textContent = s.commitsToday;
  $('#statPoints').textContent = s.pointsToday;

  const synced = state.students.map((x) => x.last_synced_at).filter(Boolean).sort().at(-1);
  $('#lastSynced').textContent = `Last synced ${relativeTime(synced)}`;

  renderLeaderboard(t);
  renderPeriodSummary(t);
  renderCalendar(t);
  renderChart(t);
}

function renderLeaderboard(t) {
  const el = $('#leaderboard');
  if (!state.students.length) {
    el.innerHTML = emptyHtml('No contributors yet. An admin can add contributors on the <a href="admin.html">Admin</a> page.', 'bi-people');
    $('#consistent').innerHTML = emptyHtml('Nothing to show yet.');
    $('#comebackCard').classList.add('d-none');
    return;
  }
  const rows = buildLeaderboard(state.students, state.activity, state.filter, t);
  const [pFrom, pTo] = periodRange(state.filter, t);
  const hasPrivate = new Set(state.privateRows
    .filter((p) => (pFrom === null || p.activity_date >= pFrom) && p.activity_date <= pTo)
    .map((p) => p.student_id));
  // Consistent = highest points in the last 30 days; every tie is included.
  const top = consistentLeaders(buildLeaderboard(state.students, state.activity, 'all', t));
  const topIds = new Set(top.map((r) => r.student.id));
  // Comeback champs: back on a streak after a break.
  const comebacks = comebackChamps(state.students, state.activity, t);
  const champIds = new Set(comebacks.map((c) => c.student.id)); // everyone back after a break is a champ

  // Gold/silver/bronze tint for ranks 1-3, but only for contributors who have points.
  const medal = (rank, points) => `<span class="rank${rank <= 3 && points > 0 ? ` rank-${rank}` : ''}">${rank}</span>`;
  const body = rows.map((r) => `
    <tr data-student="${r.student.id}" tabindex="0" role="button">
      <td class="text-center">${medal(r.rank, r.points)}</td>
      <td>
        <div class="d-flex align-items-center gap-2">
          ${avatar(r.student)}
          <div class="min-w-0">
            <div class="fw-semibold text-truncate">${esc(r.student.name)}
              ${hasPrivate.has(r.student.id) ? '<i class="bi bi-lock text-body-secondary ms-1" title="Includes commits in a private repository, verified by an admin"></i>' : ''}
              ${topIds.has(r.student.id) ? `<span class="tag-consistent ms-1" title="Highest points in the last 30 days (${top[0].consistencyPoints})">Consistent</span>` : ''}
              ${champIds.has(r.student.id) ? '<span class="tag-consistent tag-comeback ms-1" title="Back on a streak after a break">Comeback champ</span>' : ''}</div>
            <a class="handle" href="${ghUrl(r.student.github_username)}" target="_blank" rel="noopener"
               onclick="event.stopPropagation()">@${esc(r.student.github_username)} </a>
          </div>
        </div>
      </td>
      <td class="text-end num pts">${r.points}</td>
      <td class="text-end num d-none d-sm-table-cell">${r.commits}</td>
      <td class="text-end num d-none d-md-table-cell">${r.activeDays}</td>
      <td class="text-end num">${r.currentStreak ? `${r.currentStreak}<span class="unit">d</span>` : '–'}</td>
      <td class="text-end num d-none d-md-table-cell">${r.bestStreak ? `${r.bestStreak}<span class="unit">d</span>` : '–'}</td>
    </tr>`).join('');

  el.innerHTML = `
    <div class="table-responsive">
      <table class="table table-hover align-middle mb-0 leaderboard">
        <thead><tr>
          <th class="text-center">#</th><th>Contributor</th>
          <th class="text-end">Points</th>
          <th class="text-end d-none d-sm-table-cell">Commits</th>
          <th class="text-end d-none d-md-table-cell">Active days</th>
          <th class="text-end" title="Consecutive days with a commit">Streak</th>
          <th class="text-end d-none d-md-table-cell">Best</th>
        </tr></thead>
        <tbody>${body}</tbody>
      </table>
    </div>
    <div class="px-3 py-2 table-caption">${esc(FILTERS[state.filter])} · ${periodLabel(t)}</div>`;

  el.querySelectorAll('tr[data-student]').forEach((tr) => {
    const open = () => openStudent(Number(tr.dataset.student));
    tr.addEventListener('click', open);
    tr.addEventListener('keydown', (e) => { if (e.key === 'Enter') open(); });
  });

  $('#consistent').innerHTML = top.length
    ? `<p class="small text-body-secondary mb-3">${top.length === 1 ? 'Highest' : `${top.length} contributors tied on the highest`} points in the last 30 days: <span class="fw-semibold text-body num">${top[0].consistencyPoints} pts</span></p>
      <ol class="list-unstyled mb-0 d-flex flex-column gap-3">${top.map((r) => `
        <li class="d-flex align-items-center gap-2">
          ${avatar(r.student, 36)}
          <div class="flex-grow-1 min-w-0">
            <div class="fw-semibold text-truncate">${esc(r.student.name)}</div>
            <div class="d-flex align-items-center gap-2 mt-1">
              <div class="progress consistency-bar flex-grow-1" role="progressbar" aria-label="Active days in the last 30" aria-valuenow="${r.consistency}" aria-valuemin="0" aria-valuemax="30">
                <div class="progress-bar" style="width:${Math.round((r.consistency / 30) * 100)}%"></div>
              </div>
              <span class="small num">${r.consistency}/30</span>
            </div>
            <div class="small text-body-secondary">Streak ${r.currentStreak}d · best ${r.bestStreak}d</div>
          </div>
        </li>`).join('')}</ol>`
    : emptyHtml(`Shown once the leader has at least ${CONSISTENT_MIN_DAYS} active days in the last 30.`);

  // Only shown when someone is on a comeback: it's there to celebrate, never to point out gaps.
  $('#comebackCard').classList.toggle('d-none', comebacks.length === 0);
  $('#comeback').innerHTML = `<ol class="list-unstyled mb-0 d-flex flex-column gap-3">${comebacks.map((c) => `
    <li class="d-flex align-items-center gap-2">
      ${avatar(c.student, 36)}
      <div class="flex-grow-1 min-w-0">
        <div class="fw-semibold text-truncate">${esc(c.student.name)}
          <span class="tag-consistent tag-comeback ms-1">Comeback champ</span></div>
      </div>
    </li>`).join('')}</ol>`;
}

function periodLabel(t) {
  const [from] = { today: [t], week: [startOfWeek(t)], month: [startOfMonth(t)], all: [null] }[state.filter];
  return from ? (from === t ? formatDay(t) : `${formatDay(from)} – ${formatDay(t)}`) : `up to ${formatDay(t)}`;
}

function renderPeriodSummary(t) {
  const week = periodSeries(state.activity, t, 'week', 2);
  const month = periodSeries(state.activity, t, 'month', 2);
  const row = (label, cur, prev) => {
    const delta = prev ? cur.points - prev.points : 0;
    const d = delta === 0 ? '' : `<span class="delta ${delta > 0 ? 'up' : 'down'}">${delta > 0 ? '+' : '−'}${Math.abs(delta)}</span>`;
    return `<tr><th scope="row" class="fw-normal">${label}</th>
      <td class="text-end num"><span class="fw-semibold">${cur.points}</span>${d}</td>
      <td class="text-end num">${cur.commits}</td>
      <td class="text-end num">${cur.activeStudents}</td></tr>`;
  };
  $('#periodSummary').innerHTML = `
    <table class="table mb-0 align-middle summary-table">
      <thead><tr><th>Period</th><th class="text-end">Points</th><th class="text-end">Commits</th><th class="text-end">Active</th></tr></thead>
      <tbody>
        ${row('This week', week[1], week[0])}
        ${row('Last week', week[0])}
        ${row('This month', month[1], month[0])}
        ${row('Last month', month[0])}
      </tbody>
    </table>
    <div class="px-3 py-2 table-caption">Change shown against the previous period.</div>`;
}

function renderCalendar(t) {
  const n = state.students.length;
  if (!n) { $('#calendar').innerHTML = emptyHtml('No activity yet.'); return; }
  const values = calendarValues(state.activity, 'students');
  $('#calendar').innerHTML = calendarHtml(values, {
    from: addDays(t, -364), to: t,
    level: (v) => (v === 0 ? 0 : Math.min(4, Math.ceil((v / n) * 4))),
    label: (v) => `${v} of ${n} contributor${n === 1 ? '' : 's'} active`,
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

  const text = cssVar('--app-muted');
  Chart.defaults.font.family = cssVar('--app-font');
  const grid = cssVar('--bs-border-color');
  const data = {
    labels: series.map((b) => b.label),
    datasets: [
      { type: 'bar', label: 'Points', data: series.map((b) => b.points), backgroundColor: cssVar('--app-accent'), borderRadius: 3, maxBarThickness: 36, yAxisID: 'y' },
      { type: 'line', label: 'Commits', data: series.map((b) => b.commits), borderColor: cssVar('--app-series-2'), backgroundColor: cssVar('--app-series-2'), borderWidth: 2, pointRadius: 2, tension: 0.25, yAxisID: 'y1' },
    ],
  };
  const options = {
    responsive: true, maintainAspectRatio: false, animation: false,
    interaction: { mode: 'index', intersect: false },
    plugins: {
      legend: { align: 'end', labels: { color: text, boxWidth: 10, boxHeight: 10 } },
      tooltip: { callbacks: { afterBody: (items) => `Active contributors: ${series[items[0].dataIndex].activeStudents}` } },
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
      ${[['Total points', total], ['Commits', commits], ['Active days', rows.length], ['Current streak', `${streaks.current}d`], ['Best streak', `${streaks.best}d`]]
        .map(([k, v]) => `<div class="col-4 col-sm"><div class="metric"><b>${v}</b><span>${k}</span></div></div>`).join('')}
    </div>
    <h3 class="subhead">Contribution calendar</h3>
    <div class="mb-3">${calendarHtml(calendarValues(rows, 'commits'), {
      from: addDays(t, -364), to: t,
      level: (v) => (v === 0 ? 0 : v === 1 ? 1 : v <= 3 ? 2 : v <= 6 ? 3 : 4),
      label: (v) => `${v} commit${v === 1 ? '' : 's'}`,
    })}</div>
    <div id="privateWork"></div>
    <h3 class="subhead">Recent commits</h3>
    <div id="recentCommits">${loadingHtml()}</div>`;
  bootstrap.Modal.getOrCreateInstance($('#studentModal')).show();

  loadPrivateContributions(id).then((items) => {
    if (!items.length) return;
    const total = items.reduce((a, r) => a + r.commit_count, 0);
    $('#privateWork').innerHTML = `
      <h3 class="subhead">Private repository contributions <span class="text-body-secondary fw-normal">· ${total} commit${total === 1 ? '' : 's'}</span></h3>
      <ul class="list-group list-group-flush small mb-3">${items.map((r) => `
        <li class="list-group-item px-0 d-flex gap-2 align-items-center">
          <i class="bi bi-lock text-body-secondary"></i>
          <div class="flex-grow-1">${r.commit_count} commit${r.commit_count === 1 ? '' : 's'} in a private repository</div>
          <span class="tag-consistent" title="An admin checked these commits in the private repository">verified by admin</span>
          <span class="text-body-secondary text-nowrap">${esc(formatDay(r.activity_date))}</span>
        </li>`).join('')}</ul>`;
  });

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
