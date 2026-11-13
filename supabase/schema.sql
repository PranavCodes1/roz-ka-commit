-- =====================================================================
-- Roz Ka Commit (RKC) — Supabase schema
-- "Aaj ka commit, kal ki progress."
--
-- Run this whole file once in Supabase → SQL Editor → New query → Run.
-- It is idempotent: re-running it is safe and will not delete data.
--
-- Points rules (enforced here, in the database, not in the browser):
--   * only commits made on/after rkc_tracking_start() count (see Settings)
--   * points are per DAY, not per commit:
--   * verified private-repo work (manual_contributions) counts like commits
--   * first qualifying commit of a day  -> 10 points
--   * more commits on the same day      -> 0 extra points
--   * no commits                        -> 0 points (no row)
--   * a day can never exceed 10 points (CHECK constraint)
-- =====================================================================

-- ---------------------------------------------------------------------
-- Settings
-- ---------------------------------------------------------------------
-- The timezone that decides which calendar day a commit belongs to.
-- Keep this in sync with TIMEZONE in js/config.js.
create or replace function public.rkc_timezone()
returns text language sql immutable as $$ select 'Asia/Kolkata'::text $$;

-- The day tracking and points start (in rkc_timezone()). Commits dated
-- earlier are never stored, so they earn no points and start no streaks.
-- The website reads this value, so it only needs changing here.
create or replace function public.rkc_tracking_start()
returns date language sql immutable as $$ select date '2026-11-09' $$;

-- Points awarded for a day with `commit_count` qualifying commits.
create or replace function public.rkc_daily_points(commit_count integer)
returns smallint language sql immutable as $$
  select (case when commit_count > 0 then 10 else 0 end)::smallint
$$;

-- ---------------------------------------------------------------------
-- Admins: Supabase Auth users allowed to manage students and sync.
-- Add rows from the SQL editor only (see README). No API can write here.
-- ---------------------------------------------------------------------
create table if not exists public.admins (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);

create or replace function public.is_admin()
returns boolean
language sql stable security definer
set search_path = public
as $$
  select exists (select 1 from public.admins where user_id = auth.uid())
$$;

-- ---------------------------------------------------------------------
-- students
-- ---------------------------------------------------------------------
create table if not exists public.students (
  id              bigint generated always as identity primary key,
  name            text not null check (char_length(btrim(name)) between 1 and 100),
  github_username text not null check (github_username ~ '^[A-Za-z0-9-]{1,39}$'),
  github_id       bigint unique,
  avatar_url      text,
  last_synced_at  timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- GitHub usernames are case-insensitive: one student per GitHub account.
create unique index if not exists students_github_username_lower_key
  on public.students (lower(github_username));

-- ---------------------------------------------------------------------
-- commits: one row per real GitHub commit per student.
-- The same SHA can appear in several repositories (forks); it counts once.
-- ---------------------------------------------------------------------
create table if not exists public.commits (
  id             bigint generated always as identity primary key,
  student_id     bigint not null references public.students (id) on delete cascade,
  sha            text   not null check (sha ~ '^[0-9a-f]{40}$'),
  repo_full_name text   not null,
  message        text,
  html_url       text,
  committed_at   timestamptz not null,           -- git author date
  commit_date    date   not null,                -- day in rkc_timezone(), set by trigger
  created_at     timestamptz not null default now(),
  constraint commits_student_sha_key unique (student_id, sha)
);

create index if not exists commits_commit_date_idx on public.commits (commit_date);
create index if not exists commits_student_committed_idx on public.commits (student_id, committed_at desc);

-- ---------------------------------------------------------------------
-- daily_activity: one row per student per active day (derived from commits).
-- ---------------------------------------------------------------------
create table if not exists public.daily_activity (
  student_id    bigint   not null references public.students (id) on delete cascade,
  activity_date date     not null,
  commit_count  integer  not null default 0 check (commit_count >= 0),
  points        smallint not null default 0 check (points between 0 and 10),
  updated_at    timestamptz not null default now(),
  primary key (student_id, activity_date)
);

create index if not exists daily_activity_date_idx on public.daily_activity (activity_date);

-- ---------------------------------------------------------------------
-- Triggers
-- ---------------------------------------------------------------------

-- Before a commit is stored: compute its local day and drop impossible
-- future-dated commits (git dates can be spoofed, e.g. "2099-12-31").
create or replace function public.rkc_commits_before_insert()
returns trigger language plpgsql
set search_path = public
as $$
begin
  if new.committed_at > now() + interval '1 hour' then
    return null;  -- silently skip the row
  end if;
  new.commit_date := (new.committed_at at time zone public.rkc_timezone())::date;
  if new.commit_date < public.rkc_tracking_start() then
    return null;  -- before tracking started: not stored, earns nothing
  end if;
  new.message := left(new.message, 500);
  return new;
end $$;

drop trigger if exists commits_before_insert on public.commits;
create trigger commits_before_insert
  before insert on public.commits
  for each row execute function public.rkc_commits_before_insert();

-- After a commit is stored (duplicates never get here because the insert
-- uses ON CONFLICT DO NOTHING): bump that day's activity and points.
create or replace function public.rkc_commits_after_insert()
returns trigger language plpgsql security definer
set search_path = public
as $$
begin
  insert into public.daily_activity (student_id, activity_date, commit_count, points)
  values (new.student_id, new.commit_date, 1, public.rkc_daily_points(1))
  on conflict (student_id, activity_date) do update
     set commit_count = daily_activity.commit_count + 1,
         points       = public.rkc_daily_points(daily_activity.commit_count + 1),
         updated_at   = now();
  return null;
end $$;

drop trigger if exists commits_after_insert on public.commits;
create trigger commits_after_insert
  after insert on public.commits
  for each row execute function public.rkc_commits_after_insert();

-- After a commit is deleted: decrement, and remove days that drop to 0.
create or replace function public.rkc_commits_after_delete()
returns trigger language plpgsql security definer
set search_path = public
as $$
begin
  update public.daily_activity
     set commit_count = commit_count - 1,
         points       = public.rkc_daily_points(commit_count - 1),
         updated_at   = now()
   where student_id = old.student_id and activity_date = old.commit_date;
  delete from public.daily_activity
   where student_id = old.student_id and activity_date = old.commit_date and commit_count <= 0;
  return null;
end $$;

drop trigger if exists commits_after_delete on public.commits;
create trigger commits_after_delete
  after delete on public.commits
  for each row execute function public.rkc_commits_after_delete();

-- When a student's GitHub username changes, their old history no longer
-- belongs to them: clear it so the next sync rebuilds it from GitHub.
create or replace function public.rkc_students_before_update()
returns trigger language plpgsql security definer
set search_path = public
as $$
begin
  new.updated_at := now();
  if lower(new.github_username) <> lower(old.github_username) then
    delete from public.commits where student_id = old.id;
    delete from public.milestone_announcements where student_id = old.id;
    new.last_synced_at := null;
  end if;
  return new;
end $$;

drop trigger if exists students_before_update on public.students;
create trigger students_before_update
  before update on public.students
  for each row execute function public.rkc_students_before_update();

-- ---------------------------------------------------------------------
-- manual_contributions: work in PRIVATE repositories, verified by an admin.
-- The contributor shares the private repo with the admin on GitHub; the admin
-- checks the commits there and records them here. They count for that day
-- exactly like commits (10 points per active day). RKC itself never needs
-- access to private repositories.
-- repo_url and note are visible to admins only (column privileges below).
-- ---------------------------------------------------------------------
create table if not exists public.manual_contributions (
  id            bigint  generated always as identity primary key,
  student_id    bigint  not null references public.students (id) on delete cascade,
  activity_date date    not null,
  commit_count  integer not null check (commit_count between 1 and 100),
  repo_url      text    not null check (repo_url ~ '^https://github\.com/[a-z0-9-]+/[a-z0-9._-]+$'),
  note          text    check (char_length(note) <= 300),
  added_by      uuid    default auth.uid() references auth.users (id) on delete set null,
  created_at    timestamptz not null default now(),
  constraint manual_contributions_once_per_day unique (student_id, repo_url, activity_date)
);

create index if not exists manual_contributions_day_idx on public.manual_contributions (student_id, activity_date);

-- Recompute one day from both sources (GitHub commits + verified private work).
create or replace function public.rkc_refresh_day(p_student bigint, p_day date)
returns void language plpgsql security definer
set search_path = public
as $$
declare total integer;
begin
  if not exists (select 1 from public.students where id = p_student) then
    return;  -- the contributor is being deleted
  end if;
  select (select count(*) from public.commits where student_id = p_student and commit_date = p_day)
       + coalesce((select sum(commit_count) from public.manual_contributions
                    where student_id = p_student and activity_date = p_day), 0)
    into total;
  if total <= 0 then
    delete from public.daily_activity where student_id = p_student and activity_date = p_day;
  else
    insert into public.daily_activity (student_id, activity_date, commit_count, points)
    values (p_student, p_day, total, public.rkc_daily_points(total))
    on conflict (student_id, activity_date) do update
       set commit_count = excluded.commit_count,
           points       = excluded.points,
           updated_at   = now();
  end if;
end $$;

-- Normalise the link and keep dates within the tracking period.
create or replace function public.rkc_manual_before_write()
returns trigger language plpgsql
set search_path = public
as $$
begin
  -- strip trailing slashes first, then ".git" (so ".../repo.git/" becomes ".../repo")
  new.repo_url := lower(regexp_replace(regexp_replace(btrim(new.repo_url), '/+$', ''), '\.git$', ''));
  new.note := nullif(btrim(new.note), '');
  if new.activity_date < public.rkc_tracking_start() then
    raise exception 'The date is before points started (%).', public.rkc_tracking_start() using errcode = '23514';
  end if;
  if new.activity_date > (now() at time zone public.rkc_timezone())::date then
    raise exception 'The date is in the future.' using errcode = '23514';
  end if;
  return new;
end $$;

drop trigger if exists manual_contributions_before_write on public.manual_contributions;
create trigger manual_contributions_before_write
  before insert or update on public.manual_contributions
  for each row execute function public.rkc_manual_before_write();

create or replace function public.rkc_manual_after_write()
returns trigger language plpgsql security definer
set search_path = public
as $$
begin
  if tg_op in ('UPDATE', 'DELETE') then
    perform public.rkc_refresh_day(old.student_id, old.activity_date);
  end if;
  if tg_op in ('INSERT', 'UPDATE') then
    perform public.rkc_refresh_day(new.student_id, new.activity_date);
  end if;
  return null;
end $$;

drop trigger if exists manual_contributions_after_write on public.manual_contributions;
create trigger manual_contributions_after_write
  after insert or update or delete on public.manual_contributions
  for each row execute function public.rkc_manual_after_write();

-- Admin view of all private-repo entries, including the admin-only columns.
create or replace function public.rkc_admin_manual_contributions()
returns table (id bigint, student_id bigint, activity_date date, commit_count integer,
               repo_url text, note text, created_at timestamptz)
language plpgsql stable security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'admin only' using errcode = '42501';
  end if;
  return query
    select m.id, m.student_id, m.activity_date, m.commit_count, m.repo_url, m.note, m.created_at
      from public.manual_contributions m
     order by m.activity_date desc, m.id desc;
end $$;

-- ---------------------------------------------------------------------
-- Consistency milestones: public announcements when a contributor's streak
-- (consecutive IST days with activity) reaches 5, 7, 14, … 365 days.
-- Generated here in the database whenever a day's activity is recorded (hourly
-- sync, manual refresh, private-repo entry), so it works for every path.
-- Each milestone is announced once per streak.
-- Keep the list in sync with MILESTONES in js/stats.js.
-- ---------------------------------------------------------------------
create or replace function public.rkc_milestones()
returns integer[] language sql immutable as $$
  select array[5, 7, 14, 21, 30, 50, 75, 100, 150, 200, 365]
$$;

create table if not exists public.milestone_announcements (
  id             bigint  generated always as identity primary key,
  student_id     bigint  not null references public.students (id) on delete cascade,
  milestone_days integer not null check (milestone_days > 0),
  streak_start   date    not null,   -- first day of the streak that reached it
  achieved_on    date    not null,   -- the IST day the streak reached milestone_days
  created_at     timestamptz not null default now(),
  constraint milestone_announcements_once unique (student_id, milestone_days, streak_start)
);

create index if not exists milestone_announcements_recent_idx
  on public.milestone_announcements (achieved_on desc, id desc);

-- Store announcements for every milestone reached by any of the contributor's streaks
-- that isn't announced yet. A milestone already announced inside the same streak
-- (e.g. before two streaks were joined by a late-synced day) isn't repeated.
create or replace function public.rkc_refresh_milestones(p_student bigint)
returns integer language plpgsql security definer
set search_path = public
as $$
declare n integer;
begin
  with days as (
    select activity_date as d from public.daily_activity
     where student_id = p_student and commit_count > 0
  ), runs as (
    select min(d) as s, max(d) as e
      from (select d, d - (row_number() over (order by d))::int as grp from days) x
     group by grp
  )
  insert into public.milestone_announcements (student_id, milestone_days, streak_start, achieved_on)
  select p_student, m, r.s, r.s + (m - 1)
    from runs r
    cross join unnest(public.rkc_milestones()) as m
   where r.e - r.s + 1 >= m
     and not exists (
       select 1 from public.milestone_announcements a
        where a.student_id = p_student and a.milestone_days = m
          and a.achieved_on between r.s and r.e)
  on conflict do nothing;
  get diagnostics n = row_count;
  return n;
end $$;

-- Runs at the END of the transaction that added a day, so a sync that stores many days
-- at once (e.g. a new contributor's history) is evaluated on the complete data and gets
-- the right achieved_on dates.
create or replace function public.rkc_daily_activity_milestones()
returns trigger language plpgsql security definer
set search_path = public
as $$
begin
  if exists (select 1 from public.students where id = new.student_id) then
    perform public.rkc_refresh_milestones(new.student_id);
  end if;
  return null;
end $$;

drop trigger if exists daily_activity_milestones on public.daily_activity;
create constraint trigger daily_activity_milestones
  after insert on public.daily_activity
  deferrable initially deferred
  for each row execute function public.rkc_daily_activity_milestones();

-- Maintenance: rebuild daily_activity from commits + private-repo entries (e.g. after changing
-- rkc_timezone()). Admin only.  Usage:  select public.rkc_rebuild_daily_activity();
create or replace function public.rkc_rebuild_daily_activity()
returns integer language plpgsql security definer
set search_path = public
as $$
declare n integer;
begin
  -- current_user is the function owner here (security definer), so check the
  -- caller instead: an admin JWT, the service role, or the SQL editor (postgres).
  if not (public.is_admin() or coalesce(auth.role(), '') = 'service_role' or session_user = 'postgres') then
    raise exception 'admin only';
  end if;
  update public.commits
     set commit_date = (committed_at at time zone public.rkc_timezone())::date
   where commit_date <> (committed_at at time zone public.rkc_timezone())::date;
  delete from public.commits where commit_date < public.rkc_tracking_start();
  delete from public.manual_contributions where activity_date < public.rkc_tracking_start();
  delete from public.daily_activity where true;
  insert into public.daily_activity (student_id, activity_date, commit_count, points)
  select student_id, day, sum(cnt), public.rkc_daily_points(sum(cnt)::int)
    from (select student_id, commit_date as day, count(*)::int as cnt from public.commits group by 1, 2
          union all
          select student_id, activity_date, sum(commit_count)::int from public.manual_contributions group by 1, 2) x
   group by student_id, day;
  get diagnostics n = row_count;
  return n;
end $$;

-- ---------------------------------------------------------------------
-- Row Level Security
--   * everyone (anon) may READ students, commits, daily_activity
--   * only admins may WRITE students and commits
--   * nobody writes daily_activity directly (only the triggers above)
--   * admins table is not writable through the API at all
-- ---------------------------------------------------------------------
alter table public.admins         enable row level security;
alter table public.students       enable row level security;
alter table public.commits        enable row level security;
alter table public.daily_activity enable row level security;
alter table public.manual_contributions enable row level security;
alter table public.milestone_announcements enable row level security;

-- Table privileges (defence in depth on top of RLS)
revoke all on public.admins, public.students, public.commits, public.daily_activity from anon, authenticated;
grant select on public.students, public.commits, public.daily_activity to anon, authenticated;
grant select on public.admins to authenticated;
grant insert, update, delete on public.students to authenticated;
grant insert, delete on public.commits to authenticated;

revoke all on function public.rkc_rebuild_daily_activity() from public, anon;
grant execute on function public.rkc_rebuild_daily_activity() to authenticated;
grant execute on function public.is_admin() to anon, authenticated;
grant execute on function public.rkc_tracking_start() to anon, authenticated;

-- milestone_announcements: public read; written only by the database itself.
revoke all on public.milestone_announcements from anon, authenticated;
grant select on public.milestone_announcements to anon, authenticated;
grant execute on function public.rkc_milestones() to anon, authenticated;
revoke all on function public.rkc_refresh_milestones(bigint) from public, anon, authenticated;

-- manual_contributions: everyone sees that private work exists (date, count);
-- only admins see which repository and the note (via rkc_admin_manual_contributions()).
revoke all on public.manual_contributions from anon, authenticated;
grant select (id, student_id, activity_date, commit_count, created_at) on public.manual_contributions to anon, authenticated;
grant insert (student_id, activity_date, commit_count, repo_url, note) on public.manual_contributions to authenticated;
grant update (activity_date, commit_count, repo_url, note) on public.manual_contributions to authenticated;
grant delete on public.manual_contributions to authenticated;
revoke all on function public.rkc_admin_manual_contributions() from public, anon;
grant execute on function public.rkc_admin_manual_contributions() to authenticated;
revoke all on function public.rkc_refresh_day(bigint, date) from public, anon, authenticated;

-- service_role = the server-side secret key used by the scheduled sync
-- (scripts/sync.js / GitHub Actions). It bypasses RLS but still needs table
-- privileges, which newer Supabase projects no longer grant automatically.
grant usage on schema public to service_role;
grant select, insert, update, delete on public.students, public.commits, public.daily_activity, public.admins, public.manual_contributions, public.milestone_announcements to service_role;
grant execute on function public.rkc_tracking_start(), public.is_admin(), public.rkc_rebuild_daily_activity() to service_role;

-- admins
drop policy if exists "admins: read own row" on public.admins;
create policy "admins: read own row" on public.admins
  for select to authenticated using (user_id = auth.uid());

-- students
drop policy if exists "students: public read" on public.students;
create policy "students: public read" on public.students
  for select to anon, authenticated using (true);

drop policy if exists "students: admin insert" on public.students;
create policy "students: admin insert" on public.students
  for insert to authenticated with check (public.is_admin());

drop policy if exists "students: admin update" on public.students;
create policy "students: admin update" on public.students
  for update to authenticated using (public.is_admin()) with check (public.is_admin());

drop policy if exists "students: admin delete" on public.students;
create policy "students: admin delete" on public.students
  for delete to authenticated using (public.is_admin());

-- commits
drop policy if exists "commits: public read" on public.commits;
create policy "commits: public read" on public.commits
  for select to anon, authenticated using (true);

drop policy if exists "commits: admin insert" on public.commits;
create policy "commits: admin insert" on public.commits
  for insert to authenticated with check (public.is_admin());

drop policy if exists "commits: admin delete" on public.commits;
create policy "commits: admin delete" on public.commits
  for delete to authenticated using (public.is_admin());

-- daily_activity
drop policy if exists "daily_activity: public read" on public.daily_activity;
create policy "daily_activity: public read" on public.daily_activity
  for select to anon, authenticated using (true);

-- milestone_announcements
drop policy if exists "milestone_announcements: public read" on public.milestone_announcements;
create policy "milestone_announcements: public read" on public.milestone_announcements
  for select to anon, authenticated using (true);

-- manual_contributions
drop policy if exists "manual_contributions: public read" on public.manual_contributions;
create policy "manual_contributions: public read" on public.manual_contributions
  for select to anon, authenticated using (true);

drop policy if exists "manual_contributions: admin insert" on public.manual_contributions;
create policy "manual_contributions: admin insert" on public.manual_contributions
  for insert to authenticated with check (public.is_admin());

drop policy if exists "manual_contributions: admin update" on public.manual_contributions;
create policy "manual_contributions: admin update" on public.manual_contributions
  for update to authenticated using (public.is_admin()) with check (public.is_admin());

drop policy if exists "manual_contributions: admin delete" on public.manual_contributions;
create policy "manual_contributions: admin delete" on public.manual_contributions
  for delete to authenticated using (public.is_admin());

-- ---------------------------------------------------------------------
-- One-time cleanup: remove commits from before the tracking start date
-- (e.g. from an earlier backfill). Their points disappear with them via
-- the delete trigger. Safe to re-run; does nothing once clean.
-- ---------------------------------------------------------------------
delete from public.commits where commit_date < public.rkc_tracking_start();
delete from public.manual_contributions where activity_date < public.rkc_tracking_start();

-- Announce milestones already reached in existing data (safe to re-run: nothing is repeated).
select public.rkc_refresh_milestones(id) from public.students;
