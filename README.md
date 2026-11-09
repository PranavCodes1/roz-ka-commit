# Roz Ka Commit (RKC)

> **Aaj ka commit, kal ki progress.**

RKC tracks the daily GitHub commits of a group of people (students, teammates, a coding club…) and turns them into points, streaks and a leaderboard.
It is a plain static website (HTML + CSS + JavaScript + Bootstrap 5 + Chart.js) that talks directly to
**Supabase** (Postgres + Auth + Row Level Security) and the **public GitHub REST API**. There is no backend server.
It is built to be hosted for free on **GitHub Pages**.

- **Public dashboard** (`index.html`): today's numbers, leaderboard (today / week / month / all time),
  current and best streaks, the most consistent contributors, a contribution calendar, and weekly/monthly charts.
  Click a contributor to see their own calendar and recent commits.
- **Admin page** (`admin.html`): sign in, add/edit/remove contributors, and **Refresh from GitHub** (all contributors or one).

## Points rules

Points are given **per day, not per commit**, and only for commits made on or after the
**tracking start date** (`rkc_tracking_start()` in `supabase/schema.sql`, currently **9 Nov 2026**).
Older commits are never stored, so they give no points, streaks or calendar activity.

| Situation | Points |
|---|---|
| First qualifying commit of a day | **10** |
| More commits the same day | 0 extra |
| No commits that day | 0 |
| Maximum per contributor per day | **10** |

A *qualifying commit* is a real, non-merge commit, authored by the contributor's GitHub account, in a public repository,
found by GitHub's commit search. Days are counted in the configured timezone (default **Asia/Kolkata**) using the
commit's author date. Points are calculated **in the database** by triggers (`supabase/schema.sql`), not in the browser,
and a `CHECK` constraint makes more than 10 points per day impossible. All history is kept in `daily_activity`.

**Streaks:** the current streak counts consecutive days with a commit. It ends today, or yesterday if the contributor has not
committed yet today (the streak survives until the day is over). The best streak is the longest run ever.
**Most consistent** means the most active days in the last 30 days (ties: current streak, then best streak).

## Project structure

```
index.html            public dashboard + leaderboard
admin.html            admin sign-in, contributor management, GitHub sync
css/styles.css        small styling layer over Bootstrap
js/config.js          ← your Supabase URL + public anon key, timezone, sync settings
js/db.js              Supabase client + queries
js/github.js          GitHub REST client (rate-limit handling, retries)
js/sync.js            GitHub → Supabase sync logic (shared by the admin page and scripts/sync.js)
js/stats.js           leaderboard, streaks, weekly/monthly series (pure functions)
js/dates.js           timezone-safe date helpers
js/dashboard.js, js/admin.js, js/ui.js, js/theme.js   page code
supabase/schema.sql   tables, constraints, triggers, RLS policies — run once in Supabase
scripts/sync.js       optional: sync from the command line / a scheduled GitHub Action
.github/workflows/sync.yml   optional daily scheduled sync (off until you add secrets)
tests/                unit tests (no setup) and integration tests (need a Supabase project)
```

## Setup (about 10 minutes)

### 1. Create the Supabase project (free)
1. Sign up at [supabase.com](https://supabase.com) and create a new project (Free plan).
2. Open **SQL Editor → New query**, paste the whole of [`supabase/schema.sql`](supabase/schema.sql) and click **Run**.
   It is safe to run again later. It creates:
   - `students`: one row per contributor (table keeps its original name); GitHub username unique (case-insensitive)
   - `commits`: one row per commit per contributor, `UNIQUE (student_id, sha)` so re-syncs never duplicate
   - `daily_activity`: `PRIMARY KEY (student_id, activity_date)`, commit count + points per day
   - `admins`: which Supabase Auth users are administrators
   - triggers that maintain `daily_activity`, and the Row Level Security policies

### 2. Create the admin account
1. **Authentication → Users → Add user → Create new user**: enter your email and a strong password,
   and tick *Auto Confirm User*.
2. Make that user an admin. In the SQL editor run:
   ```sql
   insert into public.admins (user_id)
   select id from auth.users where email = 'you@example.com';
   ```
3. Recommended: **Authentication → Sign In / Providers → Email**: turn off *Allow new users to sign up*.
   (Even if someone signs up, they are not in `admins` and RLS blocks every write. Turning sign-ups off just keeps the user list clean.)

### 3. Configure the website
Open **Project Settings → API Keys** (or **Data API**) and copy the **Project URL** and the **anon / publishable** key.
Put them in [`js/config.js`](js/config.js):

```js
SUPABASE_URL: 'https://abcdefghijkl.supabase.co',
SUPABASE_ANON_KEY: 'sb_publishable_…   (or the legacy eyJ… anon key)',
TIMEZONE: 'Asia/Kolkata',   // must match rkc_timezone() in schema.sql
```

> The anon/publishable key is **meant to be public**. It can only do what the RLS policies allow:
> read the dashboard data. **Never** put the `service_role` / `sb_secret_…` key in `js/config.js`;
> the app detects that and refuses to start.

### 4. Run locally
Any static file server works (ES modules don't load from `file://`):
```bash
python3 -m http.server 8080      # then open http://localhost:8080
```

### 5. Deploy to GitHub Pages (free)
1. Push this folder to a GitHub repository.
2. **Settings → Pages → Build and deployment → Source: Deploy from a branch**, branch `main`, folder `/ (root)`.
3. Your site is at `https://<you>.github.io/<repo>/`. The admin page is `…/admin.html`.
4. In Supabase **Authentication → URL Configuration**, set the Site URL to your Pages URL.

## Using it

1. Open `admin.html`, sign in.
2. **Add contributor**: name + GitHub username. The username is checked against GitHub (the canonical spelling and avatar are saved),
   and the contributor's last `BACKFILL_DAYS` (default 90) days are synced right away.
3. **Refresh all from GitHub** fetches new commits for everyone. Each contributor has their own refresh button too.
   Refreshing is always safe: duplicates are ignored by the database.
4. Edit a contributor's name freely. Changing their **GitHub username** deletes their old commits/points
   (they belonged to another account) and re-syncs from the new account.
5. Removing a contributor deletes their commits and points (cascade).

The dashboard's **Refresh** button reloads the latest data from Supabase. Fetching from GitHub needs admin
rights, because only admins may write commits.

## How GitHub synchronisation works

- RKC uses the **commit search API**:
  `GET /search/commits?q=author:<user> author-date:<from>..<to> merge:false&sort=author-date`.
  It returns real commits with their SHA, author date, repository and message. Nothing is ever generated or estimated.
- Nothing before the tracking start date is ever fetched or stored.
- **First sync** of a contributor: the last `BACKFILL_DAYS` days (but never before the start date).
  **Later syncs**: from `SYNC_OVERLAP_DAYS` (default 14) days before the previous sync up to today, so commits made earlier but
  pushed later are still picked up. After a long gap it simply reaches back further, so no day is skipped.
  Tick **Full re-scan** to re-fetch the whole backfill window.
- Results are filtered to commits whose GitHub author is that contributor, de-duplicated by SHA (the same commit in a fork counts once),
  and inserted with `ON CONFLICT DO NOTHING`. Database triggers then update `daily_activity`.
- Commits dated more than an hour in the future are rejected, in the browser and again by a database trigger.
  Git dates can be faked; people really do push "2099" commits.
- Search returns at most 1000 results per query, so busy date ranges are automatically split in half until each fits.

### Optional: automatic daily sync
`.github/workflows/sync.yml` runs `scripts/sync.js` every day at 23:30 IST, so points are recorded even if nobody clicks Refresh.
To enable it, add repository secrets **`SUPABASE_URL`** and **`SUPABASE_SERVICE_ROLE_KEY`**
(Settings → Secrets and variables → Actions). The service key lives only in GitHub's encrypted secret store, never in the website.
You can also run it yourself: copy `.env.example` to `.env`, fill it in, and run `npm run sync`.

## GitHub API limitations (please read)

| Limit | Effect in RKC |
|---|---|
| Search API: **10 requests/min** without a token, **30/min** with one | Each contributor needs ≥ 1 request per sync. RKC reads the `X-RateLimit-*` headers and **waits automatically** (shown in the admin page) when the per-minute quota is used up. You can paste a GitHub token (fine-grained, **no permissions needed**) on the admin page to triple the speed. It is stored only in your browser. |
| Core API: 60 requests/hour without a token | Used only to verify usernames when adding/editing contributors. If unavailable, the contributor is saved with a warning. |
| Secondary rate limits / `Retry-After` | Honoured automatically; temporary 5xx and network errors are retried with backoff. A rate limit that would take more than 90 s stops the run with a clear message; just refresh again later. |
| Only **public repositories** and commits on the **default branch** are searchable | Commits on feature branches count once merged into the default branch (by their original author date). Private-repo commits are invisible to RKC. |
| Commits must be **linked to the GitHub account** | The commit email must be one of the contributor's verified GitHub emails, as for the GitHub contribution graph. |
| Commits that exist only in forks may not be indexed by search | Ask contributors to commit to their own repositories. |
| Search indexing is not instant | New pushes can take a few minutes (occasionally longer) to appear. The 14-day overlap re-checks them on later syncs. |
| Max 1000 results per query | Handled by splitting the date range. |
| Git author dates can be set to anything | Future dates are rejected. Back-dated commits in the past cannot be detected by any public API and are counted on the date they claim. |

## Security model

- The browser only ever has the **public anon/publishable key**.
- **Row Level Security** is enabled on every table:
  - anyone can `SELECT` contributors (`students`), commits and daily activity (that's the public dashboard);
  - `INSERT/UPDATE/DELETE` on `students` and `INSERT/DELETE` on `commits` require `public.is_admin()`, i.e. the signed-in user is in `admins`;
  - nobody can write `daily_activity` directly; only the `SECURITY DEFINER` triggers do;
  - `admins` cannot be modified through the API at all (SQL editor only).
- Table privileges are also revoked/granted explicitly as a second layer.
- Admin sign-in uses Supabase Auth (email + password). Hiding the admin UI is only cosmetic; the database enforces the rules.
- The optional GitHub token is stored only in the admin's browser (session storage, or local storage if "remember" is ticked)
  and is only sent to `api.github.com`.

## Tests

```bash
npm test          # unit tests: points/leaderboard/streaks/series, GitHub client, rate limits, sync logic (no setup)

npm install       # integration tests need @supabase/supabase-js
cp .env.example .env   # point it at a THROWAWAY or local Supabase project (they create & delete test data)
npm run test:db   # RLS, constraints, duplicate handling, points triggers, username change, cascade, live GitHub sync
```

To run Supabase locally for the integration tests: `npx supabase init && npx supabase start`, then apply the schema with
`psql postgresql://postgres:postgres@127.0.0.1:54322/postgres -f supabase/schema.sql` and use the printed URL/keys.

## Changing the start date
Edit the date in `rkc_tracking_start()` in `supabase/schema.sql` and run the whole file again in the SQL Editor.
Commits from before the new date are deleted (with their points) by the cleanup at the end of the file.
If you move the date *earlier*, tick **Full re-scan** on the admin page and refresh, so older commits are fetched.

## Changing the timezone
Edit `TIMEZONE` in `js/config.js` **and** `rkc_timezone()` in `supabase/schema.sql` (re-run that function definition), then run
`select public.rkc_rebuild_daily_activity();` in the SQL editor to recompute every day.

## Free-tier notes
Supabase Free pauses projects after a week without activity. Opening the dashboard (or the daily scheduled sync) counts as activity.
Storage use is tiny: one short row per commit.
