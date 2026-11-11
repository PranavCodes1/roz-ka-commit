// Admin page: sign in, manage students, sync GitHub activity.
// Every write is checked again by Supabase Row Level Security; hiding the UI is not the security boundary.
import { CONFIG } from './config.js';
import { supabase, configError, loadStudents, loadActivity, loadTrackingStart, syncStore } from './db.js';
import { formatDay } from './dates.js';
import { GitHubClient, normalizeToken } from './github.js';
import { syncStudent, syncAll } from './sync.js';
import { $, esc, avatar, ghUrl, loadingHtml, emptyHtml, errorHtml, relativeTime, errMsg } from './ui.js';

const USERNAME_RE = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;
const TOKEN_KEY = 'rkc-github-token';
const state = { students: [], totals: new Map(), syncing: false };

const show = (id) => ['#authView', '#notAdminView', '#adminView'].forEach((v) => $(v).classList.toggle('d-none', v !== id));
const msg = (kind, text) => `<div class="alert alert-${kind} py-2 small">${esc(text)}</div>`;

// ---------- token storage (this browser only; never sent anywhere but api.github.com) ----------
function readToken() {
  try { return sessionStorage.getItem(TOKEN_KEY) || localStorage.getItem(TOKEN_KEY) || ''; } catch { return ''; }
}
function saveToken() {
  const token = normalizeToken($('#ghToken').value);
  $('#ghToken').value = token;
  try {
    sessionStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(TOKEN_KEY);
    if (token) ($('#rememberToken').checked ? localStorage : sessionStorage).setItem(TOKEN_KEY, token);
  } catch { /* storage unavailable: token lives only in the input */ }
  return token;
}
function forgetToken() {
  $('#ghToken').value = '';
  try { sessionStorage.removeItem(TOKEN_KEY); localStorage.removeItem(TOKEN_KEY); } catch { /* ignore */ }
}
let tokenWarned = false;
function github(onWait) {
  tokenWarned = false;
  return new GitHubClient({
    token: saveToken(),
    onWait,
    // An invalid optional token must never block a sync: drop it and carry on without it.
    onTokenRejected: () => {
      forgetToken();
      if (tokenWarned) return;
      tokenWarned = true;
      $('#tokenNote').innerHTML = msg('warning', 'GitHub rejected the token in this field (invalid, expired, or a password your browser filled in). It has been removed; syncing continues without a token. Paste a valid token (github_pat_…) only if you need faster manual refreshes.');
    },
  });
}

// ---------- auth ----------
async function route(session) {
  $('#bootState').innerHTML = '';
  if (!session) {
    $('#signOutBtn').classList.add('d-none');
    $('#whoami').textContent = 'Manage contributors and sync GitHub activity.';
    show('#authView');
    return;
  }
  $('#signOutBtn').classList.remove('d-none');
  $('#whoami').textContent = `Signed in as ${session.user.email}`;
  const { data: isAdmin, error } = await supabase.rpc('is_admin');
  if (error) {
    $('#pageAlert').innerHTML = errorHtml('Could not check admin status: ' + errMsg(error));
    return;
  }
  if (!isAdmin) {
    $('#myUserId').textContent = session.user.id;
    show('#notAdminView');
    return;
  }
  show('#adminView');
  const start = await loadTrackingStart();
  $('#trackingStart').textContent = start ? formatDay(start) : 'unknown';
  $('#trackingStartNote').textContent = start ? formatDay(start) : 'the start date';
  if (!start) {
    $('#pageAlert').innerHTML = errorHtml('The database is missing rkc_tracking_start(). Re-run supabase/schema.sql in the Supabase SQL Editor, otherwise commits from before the start date would be counted.');
  }
  await refreshStudents();
}

$('#loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('#loginBtn');
  btn.disabled = true;
  $('#loginError').innerHTML = '';
  const { error } = await supabase.auth.signInWithPassword({ email: $('#email').value.trim(), password: $('#password').value });
  btn.disabled = false;
  if (error) $('#loginError').innerHTML = msg('danger', error.message);
  else $('#password').value = '';
});

$('#signOutBtn').addEventListener('click', () => supabase.auth.signOut());

// ---------- students ----------
async function refreshStudents() {
  if (!state.students.length) $('#studentTable').innerHTML = loadingHtml();
  try {
    const [students, activity] = await Promise.all([loadStudents(), loadActivity()]);
    state.students = students;
    state.totals = new Map();
    for (const r of activity) {
      const t = state.totals.get(r.student_id) || { points: 0, commits: 0 };
      t.points += r.points;
      t.commits += r.commit_count;
      state.totals.set(r.student_id, t);
    }
    renderStudents();
  } catch (err) {
    $('#studentTable').innerHTML = `<div class="p-3">${errorHtml('Could not load contributors: ' + errMsg(err))}</div>`;
  }
}

function renderStudents() {
  $('#studentCount').textContent = state.students.length;
  if (!state.students.length) {
    $('#studentTable').innerHTML = emptyHtml('No contributors yet. Add the first one using the form.', 'bi-person-plus');
    return;
  }
  const rows = state.students.map((s) => {
    const t = state.totals.get(s.id) || { points: 0, commits: 0 };
    return `<tr>
      <td><div class="d-flex align-items-center gap-2">${avatar(s)}
        <div class="min-w-0"><div class="fw-semibold text-truncate">${esc(s.name)}</div>
        <a class="handle" href="${ghUrl(s.github_username)}" target="_blank" rel="noopener">@${esc(s.github_username)}</a></div></div></td>
      <td class="text-end">${t.points}<div class="small text-body-secondary">${t.commits} commits</div></td>
      <td class="small text-body-secondary d-none d-sm-table-cell" title="${esc(s.last_synced_at || '')}">${relativeTime(s.last_synced_at)}</td>
      <td class="text-end text-nowrap">
        <button class="btn btn-sm btn-outline-secondary" data-act="sync" data-id="${s.id}" title="Refresh from GitHub"><i class="bi bi-arrow-clockwise"></i></button>
        <button class="btn btn-sm btn-outline-secondary" data-act="edit" data-id="${s.id}" title="Edit"><i class="bi bi-pencil"></i></button>
        <button class="btn btn-sm btn-outline-danger" data-act="delete" data-id="${s.id}" title="Remove"><i class="bi bi-trash"></i></button>
      </td></tr>`;
  }).join('');
  $('#studentTable').innerHTML = `<div class="table-responsive"><table class="table align-middle mb-0">
    <thead><tr><th>Contributor</th><th class="text-end">Points</th><th class="d-none d-sm-table-cell">Synced</th><th></th></tr></thead>
    <tbody>${rows}</tbody></table></div>`;
}

$('#studentTable').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-act]');
  if (!b) return;
  const s = state.students.find((x) => x.id === Number(b.dataset.id));
  if (!s) return;
  if (b.dataset.act === 'sync') runSync([s]);
  if (b.dataset.act === 'edit') openEdit(s);
  if (b.dataset.act === 'delete') openDelete(s);
});

/** Look the username up on GitHub. Returns profile fields, or null if GitHub could not be reached. */
async function verifyGitHubUser(username) {
  try {
    const u = await github().getUser(username);
    if (u.type && u.type !== 'User') throw Object.assign(new Error(`@${u.login} is an ${u.type.toLowerCase()}, not a personal account.`), { fatal: true });
    return { github_username: u.login, github_id: u.id, avatar_url: u.avatar_url };
  } catch (err) {
    if (err.fatal) throw err;
    if (err.code === 'not_found') throw new Error(`GitHub user @${username} does not exist.`);
    return null; // rate limit / network: allow saving without verification
  }
}

$('#addForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = $('#addName').value.trim();
  const username = $('#addUser').value.trim().replace(/^@/, '');
  const out = $('#addMsg');
  if (!name) { out.innerHTML = msg('danger', 'Name is required.'); return; }
  if (!USERNAME_RE.test(username)) { out.innerHTML = msg('danger', 'That is not a valid GitHub username.'); return; }
  $('#addBtn').disabled = true;
  out.innerHTML = loadingHtml('Checking GitHub…');
  try {
    const profile = await verifyGitHubUser(username);
    const row = { name, github_username: username, ...(profile || {}) };
    const { data, error } = await supabase.from('students').insert(row).select().single();
    if (error) throw error;
    out.innerHTML = msg(profile ? 'success' : 'warning',
      `Added ${data.name} (@${data.github_username}).` + (profile ? '' : ' GitHub could not be reached to verify the username — check it is correct.'));
    $('#addForm').reset();
    await refreshStudents();
    runSync([data]);
  } catch (err) {
    out.innerHTML = msg('danger', errMsg(err));
  } finally {
    $('#addBtn').disabled = false;
  }
});

// edit
const editModal = () => bootstrap.Modal.getOrCreateInstance($('#editModal'));
function openEdit(s) {
  $('#editId').value = s.id;
  $('#editName').value = s.name;
  $('#editUser').value = s.github_username;
  $('#editUser').dataset.original = s.github_username;
  $('#editUserWarn').classList.add('d-none');
  $('#editMsg').innerHTML = '';
  $('#editSave').disabled = true;
  editModal().show();
}
$('#editUser').addEventListener('input', (e) => {
  $('#editUserWarn').classList.toggle('d-none', e.target.value.trim().toLowerCase() === e.target.dataset.original.toLowerCase());
});
$('#editForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const id = Number($('#editId').value);
  const name = $('#editName').value.trim();
  const username = $('#editUser').value.trim().replace(/^@/, '');
  const changed = username.toLowerCase() !== $('#editUser').dataset.original.toLowerCase();
  if (!name) { $('#editMsg').innerHTML = msg('danger', 'Name is required.'); return; }
  if (!USERNAME_RE.test(username)) { $('#editMsg').innerHTML = msg('danger', 'That is not a valid GitHub username.'); return; }
  $('#editSave').disabled = true;
  try {
    let patch = { name };
    if (changed) {
      $('#editMsg').innerHTML = loadingHtml('Checking GitHub…');
      const profile = await verifyGitHubUser(username);
      patch = {
        name,
        github_username: profile?.github_username || username,
        github_id: profile?.github_id ?? null,
        avatar_url: profile?.avatar_url ?? null,
      };
    }
    const { data, error } = await supabase.from('students').update(patch).eq('id', id).select().single();
    if (error) throw error;
    editModal().hide();
    await refreshStudents();
    if (changed) runSync([data]);
  } catch (err) {
    $('#editMsg').innerHTML = msg('danger', errMsg(err));
  } finally {
    $('#editSave').disabled = false;
  }
});

// delete
const deleteModal = () => bootstrap.Modal.getOrCreateInstance($('#deleteModal'));
let deleting = null;
function openDelete(s) {
  deleting = s;
  $('#deleteName').textContent = `${s.name} (@${s.github_username})`;
  $('#deleteMsg').innerHTML = '';
  $('#deleteConfirm').disabled = true; // enabled once the dialog has finished opening
  deleteModal().show();
}
// Bootstrap ignores hide() while a modal is still animating open, so the action
// buttons only become clickable after 'shown'.
$('#deleteModal').addEventListener('shown.bs.modal', () => { $('#deleteConfirm').disabled = false; });
$('#editModal').addEventListener('shown.bs.modal', () => { $('#editSave').disabled = false; });
$('#deleteConfirm').addEventListener('click', async () => {
  if (!deleting) return;
  $('#deleteConfirm').disabled = true;
  const { error } = await supabase.from('students').delete().eq('id', deleting.id);
  $('#deleteConfirm').disabled = false;
  if (error) { $('#deleteMsg').innerHTML = msg('danger', errMsg(error)); return; }
  deleteModal().hide();
  deleting = null;
  await refreshStudents();
});

// ---------- sync ----------
function log(html) {
  const li = document.createElement('li');
  li.innerHTML = html;
  $('#syncLog').prepend(li);
}

async function runSync(students) {
  if (state.syncing) { $('#syncStatus').innerHTML = '<span class="text-warning">A sync is already running.</span>'; return; }
  if (!students.length) { $('#syncStatus').textContent = 'No contributors to sync.'; return; }
  const trackingStart = await loadTrackingStart();
  if (!trackingStart) {
    $('#syncStatus').innerHTML = '<span class="text-danger">Sync blocked: re-run supabase/schema.sql first (missing tracking start date).</span>';
    return;
  }
  state.syncing = true;
  document.querySelectorAll('#syncAllBtn, button[data-act="sync"]').forEach((b) => (b.disabled = true));
  const bar = $('#syncProgress');
  bar.classList.remove('d-none');
  bar.firstElementChild.style.width = '0%';
  let done = 0;
  let added = 0;
  const gh = github((ms, reason) => {
    $('#syncStatus').innerHTML = `<span class="text-warning"><i class="bi bi-hourglass-split"></i> ${esc(reason)} — waiting ${Math.ceil(ms / 1000)} s…</span>`;
  });
  const opts = {
    trackingStart,
    github: gh, store: syncStore, timeZone: CONFIG.TIMEZONE,
    backfillDays: CONFIG.BACKFILL_DAYS, overlapDays: CONFIG.SYNC_OVERLAP_DAYS, full: $('#fullResync').checked,
  };
  $('#syncStatus').textContent = `Syncing ${students.length} contributor${students.length === 1 ? '' : 's'}…`;

  const results = await syncAll(students, opts, (r) => {
    done++;
    bar.firstElementChild.style.width = `${Math.round((done / students.length) * 100)}%`;
    const who = `@${esc(r.student.github_username)}`;
    if (r.ok) {
      added += r.inserted;
      log(`<i class="bi bi-check-circle text-success"></i> ${who}: ${r.unique} commits found (${r.from} → ${r.to}), <strong>${r.inserted} new</strong>`);
      $('#syncStatus').textContent = `Synced ${done} of ${students.length}…`;
    } else {
      log(`<i class="bi bi-x-circle text-danger"></i> ${who}: ${esc(errMsg(r.error))}`);
    }
  });

  const failed = results.filter((r) => !r.ok);
  const skipped = students.length - results.length;
  const limit = gh.limits.search;
  $('#syncStatus').innerHTML =
    `<span class="${failed.length ? 'text-warning' : 'text-success'}">Done: ${results.length - failed.length} synced, ${failed.length} failed` +
    `${skipped ? `, ${skipped} skipped (rate limit — try again shortly)` : ''}. ${added} new commits stored.</span>` +
    (limit ? ` <span class="text-body-secondary">Search quota left: ${limit.remaining}/${limit.limit}.</span>` : '');
  state.syncing = false;
  document.querySelectorAll('#syncAllBtn, button[data-act="sync"]').forEach((b) => (b.disabled = false));
  await refreshStudents();
}

$('#syncAllBtn').addEventListener('click', () => runSync(state.students));

// ---------- boot ----------
$('#ghToken').value = readToken();
try { $('#rememberToken').checked = !!localStorage.getItem(TOKEN_KEY); } catch { /* ignore */ }

if (configError) {
  $('#pageAlert').innerHTML = errorHtml(configError);
} else {
  $('#bootState').innerHTML = loadingHtml('Checking session…');
  supabase.auth.onAuthStateChange((event, session) => {
    if (event === 'INITIAL_SESSION' || event === 'SIGNED_IN' || event === 'SIGNED_OUT') {
      // Defer: supabase-js recommends not awaiting other calls inside this callback.
      setTimeout(() => route(session), 0);
    }
  });
}
