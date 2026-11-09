-- =====================================================================
-- Roz Ka Commit (RKC) — Supabase schema
-- "Aaj ka commit, kal ki progress."
--
-- Run this whole file once in Supabase → SQL Editor → New query → Run.
-- It is idempotent: re-running it is safe and will not delete data.
--
-- Points rules (enforced here, in the database, not in the browser):
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
    new.last_synced_at := null;
  end if;
  return new;
end $$;

drop trigger if exists students_before_update on public.students;
create trigger students_before_update
  before update on public.students
  for each row execute function public.rkc_students_before_update();

-- Maintenance: rebuild daily_activity from commits (e.g. after changing
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
  delete from public.daily_activity where true;
  insert into public.daily_activity (student_id, activity_date, commit_count, points)
  select student_id, commit_date, count(*), public.rkc_daily_points(count(*)::int)
    from public.commits group by student_id, commit_date;
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

-- Table privileges (defence in depth on top of RLS)
revoke all on public.admins, public.students, public.commits, public.daily_activity from anon, authenticated;
grant select on public.students, public.commits, public.daily_activity to anon, authenticated;
grant select on public.admins to authenticated;
grant insert, update, delete on public.students to authenticated;
grant insert, delete on public.commits to authenticated;

revoke all on function public.rkc_rebuild_daily_activity() from public, anon;
grant execute on function public.rkc_rebuild_daily_activity() to authenticated;
grant execute on function public.is_admin() to anon, authenticated;

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
