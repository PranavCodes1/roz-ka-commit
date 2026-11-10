# Roz Ka Commit (RKC)

> **Aaj ka commit, kal ki progress.**

RKC tracks the daily GitHub commits of a group of people (students, teammates, a coding club…) and turns them into
points, streaks and a leaderboard.

- **Dashboard (public):** https://pranavcodes1.github.io/roz-ka-commit/
- **Admin:** https://pranavcodes1.github.io/roz-ka-commit/admin.html

It is a plain static website (HTML + CSS + JavaScript, Bootstrap 5, Chart.js) that talks directly to **Supabase**
(Postgres + Auth + Row Level Security) and the **public GitHub REST API**. There is no backend server.
It is hosted for free on **GitHub Pages**, and a **GitHub Actions** job syncs commits from GitHub **every hour**.

| Part | What it does |
|---|---|
| Dashboard (`index.html`) | Today's numbers, leaderboard (today / week / month / all time), current and best streaks, most consistent contributors, contribution calendar, weekly/monthly chart. Click a contributor for their own calendar and recent commits. |
| Admin (`admin.html`) | Sign in, add / edit / remove contributors, **Refresh all from GitHub** (or one contributor). |
| Hourly sync (`.github/workflows/sync.yml`) | Fetches new commits for everyone, every hour, without anyone clicking Refresh. |

## Points rules

Points are given **per active day, not per commit**, and only for commits made on or after the
**tracking start date**: **9 Nov 2026** (`rkc_tracking_start()` in `supabase/schema.sql`).
Commits from before that date are never stored, so they give no points, streaks or calendar activity.

| Situation | Points |
|---|---|
| First qualifying commit of a day | **10** |
| More commits the same day | 0 extra |
| No commits that day | 0 |
| Maximum per contributor per day | **10** |

- A **qualifying commit** is a real, non-merge commit, authored by the contributor's GitHub account, in a public repository,
  found by GitHub's commit search.
- **Days** are counted in **India time** (`Asia/Kolkata`) using the commit's author date: a commit at 00:30 IST counts for
  that day, one at 23:30 IST for the day before.
- **Where it's enforced:** points are calculated **in the database** by triggers, not in the browser. A `CHECK` constraint makes
  more than 10 points per day impossible. All history is kept in `daily_activity`.
- **Streaks:** the current streak counts consecutive days with a commit. It survives until the end of today, so a streak
  ending yesterday still counts if you haven't committed yet today. The best streak is the longest run ever.
- **Most consistent:** the panel lists the 3 contributors with the most active days in the last 30 (ties: current streak,
  then best streak). The **Consistent** label in the leaderboard marks whoever has the most active days, once that is at
  least **3**.

## Project structure

```
index.html                  public dashboard + leaderboard
admin.html                  admin sign-in, contributor management, manual GitHub sync
css/styles.css              theme on top of Bootstrap (light/dark, follows the system setting)
js/config.js                ← Supabase URL + public (publishable) key, timezone, sync settings
js/db.js                    Supabase client + queries
js/github.js                GitHub REST client (rate-limit handling, retries)
js/sync.js                  GitHub → Supabase sync logic (shared by the admin page and scripts/sync.js)
js/stats.js                 leaderboard, streaks, weekly/monthly series (pure functions)
js/dates.js                 timezone-safe date helpers
js/dashboard.js, js/admin.js, js/ui.js, js/theme.js   page code
supabase/schema.sql         tables, constraints, triggers, RLS policies, grants (safe to re-run)
scripts/sync.js             the sync used by GitHub Actions (or run locally: npm run sync)
.github/workflows/sync.yml  hourly automatic sync
tests/                      unit tests (no setup) and integration tests (need a Supabase project)
```

## Setup from scratch (about 15 minutes)

### 1. Supabase project (free)
1. Sign up at [supabase.com](https://supabase.com) and create a project on the Free plan (region: Mumbai for India).
2. **SQL Editor → New query**, paste the whole of [`supabase/schema.sql`](supabase/schema.sql) and click **Run**.
   It creates:
   - `students`: one row per contributor (the table keeps its original name). GitHub username unique, case-insensitive.
   - `commits`: one row per commit per contributor, `UNIQUE (student_id, sha)` so re-syncs never duplicate.
   - `daily_activity`: `PRIMARY KEY (student_id, activity_date)`, commit count + points per day.
   - `admins`: which Supabase Auth users are administrators.
   - triggers, Row Level Security policies and the table grants each role needs.

### 2. Admin account
1. **Authentication → Users → Add user → Create new user**: your email and a strong password, tick *Auto Confirm User*.
2. Make that user an admin (SQL Editor):
   ```sql
   insert into public.admins (user_id)
   select id from auth.users where email = 'you@example.com';
   ```
3. Recommended: **Authentication → Sign In / Providers → Email**: turn off *Allow new users to sign up*.
   (Anyone who signs up still can't change anything, since they aren't in `admins`; this just keeps the user list clean.)

### 3. Website configuration
From **Project Settings → API Keys**, copy the **Project URL** and the **publishable** key (`sb_publishable_…`, or the
legacy `eyJ…` anon key) into [`js/config.js`](js/config.js):

```js
SUPABASE_URL: 'https://abcdefghijkl.supabase.co',
SUPABASE_ANON_KEY: 'sb_publishable_…',
TIMEZONE: 'Asia/Kolkata',   // must match rkc_timezone() in schema.sql
```

> The publishable key is **meant to be public**: Row Level Security only lets it read the dashboard data.
> **Never** put a secret key (`sb_secret_…` / `service_role`) in `js/config.js`; the site detects that and refuses to start.

### 4. GitHub Pages (free)
1. Push the repository to GitHub.
2. **Settings → Pages → Build and deployment → Deploy from a branch**, branch `main`, folder `/ (root)`.
3. The site appears at `https://<user>.github.io/<repo>/` a minute after each push.
4. In Supabase **Authentication → URL Configuration**, set the Site URL to that address.

To try it locally instead: `python3 -m http.server 8080` and open http://localhost:8080 (ES modules don't load from `file://`).

### 5. Hourly automatic sync (GitHub Actions)
1. **Supabase → Project Settings → API Keys → Secret keys → Add new secret key.** Name it `github-actions` and copy it
   (`sb_secret_…`). A dedicated key can be revoked on its own later.
2. **GitHub repo → Settings → Secrets and variables → Actions → Secrets tab → New repository secret.** Add **two separate**
   secrets, each holding only the bare value (no `NAME=`, quotes or extra lines):

   | Name (exactly) | Value |
   |---|---|
   | `SUPABASE_URL` | `https://abcdefghijkl.supabase.co` |
   | `SUPABASE_SERVICE_ROLE_KEY` | the secret key from step 1 |

3. **Actions → Sync GitHub activity → Run workflow.** After ~30 s the run should be green, and its summary page lists
   the commits found and stored per contributor. From then on it runs by itself every hour.

## Daily use

- **Add a contributor** (admin page): name + GitHub username. The username is checked against GitHub (correct spelling
  and avatar are saved), and their commits since the start date are synced right away.
- **Refresh all from GitHub** updates everyone immediately; each contributor also has their own refresh button.
  Refreshing is always safe, because duplicates are ignored by the database. Normally you don't need it: the hourly sync does it.
- **Edit** a name freely. Changing a **GitHub username** deletes that contributor's old commits and points (they belonged
  to another account) and re-syncs from the new one.
- **Remove** a contributor to delete them with all their commits and points.
- The dashboard's **Refresh** button just reloads the latest data from Supabase.

## How the sync works

- **Source:** the GitHub **commit search API**,
  `GET /search/commits?q=author:<user> author-date:<from>..<to> merge:false`. It returns real commits with SHA, author date,
  repository and message; nothing is generated or estimated.
- **Window:**
  - It never looks before the start date.
  - A first sync covers up to `BACKFILL_DAYS` (default 90).
  - Later syncs re-check `SYNC_OVERLAP_DAYS` (default 14) before the previous sync, so commits authored earlier but
    pushed later are still found, and nothing between two syncs is skipped.
- **Filtering:** results are limited to commits whose GitHub author is that contributor. They are de-duplicated by SHA (the
  same commit in a fork counts once) and inserted with `ON CONFLICT DO NOTHING`; triggers then update `daily_activity`.
- **Safeguards:**
  - Commits dated in the future (people really push "2099" commits) are rejected, in the code and again in the database.
  - A deleted or renamed GitHub account is reported as "user not found", not silently ignored.
  - Search returns at most 1000 results per query, so busy date ranges are split automatically.

### Schedule and limits
- **Timing:** the workflow runs **every hour at :17** (GitHub cron is UTC). One run is at 23:47 IST, just before each day
  ends. GitHub can start runs a few minutes late at busy times; nothing is lost, thanks to the 14-day re-check.
- **Overlap:** runs never overlap, and each takes about 30 seconds.
- **Pause after inactivity:** GitHub pauses scheduled workflows in a public repository after **60 days without any
  repository activity**. It emails you first; click *Enable workflow* in the Actions tab (or push anything) to resume.
- **Running it yourself:** the same sync works locally. Copy `.env.example` to `.env`, fill it in, and run `npm run sync`.

### Troubleshooting the automatic sync
Failed runs are emailed to you. Open the run: the reason is shown in a red box at the top.

| Message on the run page | Fix |
|---|---|
| **SUPABASE_URL missing** / **SUPABASE_SERVICE_ROLE_KEY missing** | The secret isn't where Actions can read it. It must be a **repository secret** under Settings → Secrets and variables → **Actions** (not Environments, Codespaces or Dependabot), named exactly as above, one secret per value. |
| **Key saved as a Variable** | It was added on the Variables tab, where it's visible in plain text. Delete it, create a new secret key in Supabase (delete the old one), add it on the **Secrets** tab. |
| **Wrong Supabase key** / **…looks wrong** | Use a **secret** key (`sb_secret_…`), not the publishable key, and paste only the key. |
| **Supabase rejected the key** | The key is invalid or from another project. Copy a fresh secret key. |
| **Key has no write access** | Re-run `supabase/schema.sql` in the SQL Editor (it grants the sync's role access to the tables). |
| **Could not reach Supabase** | Check `SUPABASE_URL` is just `https://<project-ref>.supabase.co`. |
| **Database not set up** | Run `supabase/schema.sql`. |
| Yellow **Sync failed for @user** warning | That GitHub account was renamed or deleted. Edit the contributor's username on the admin page. |

## Free plan usage

Everything runs on free tiers.

| Service | Usage | Free limit |
|---|---|---|
| GitHub Actions (hourly sync) | ~24 runs/day × ~30 s | **Unlimited** minutes for public repositories (2,000 min/month if the repo were private) |
| GitHub search API | ~1 request per contributor per run | 30 requests/minute with the Actions token |
| Supabase | a few small requests per run; one short row per commit | No API request cap; 500 MB database |
| GitHub Pages | static files | Free for public repositories |

Supabase pauses free projects after 7 days without activity; the hourly sync keeps the project active.

## GitHub API limitations

| Limit | Effect in RKC |
|---|---|
| Search API: **10 requests/min** without a token, **30/min** with one | Each contributor needs ≥ 1 request per sync. RKC reads the `X-RateLimit-*` headers and **waits automatically**. The hourly sync uses the Actions token. On the admin page you can paste a GitHub token (fine-grained, **no permissions needed**, kept only in your browser) to make manual refreshes faster. |
| Core API: 60 requests/hour without a token | Only used to verify usernames when adding/editing contributors. |
| Secondary rate limits / `Retry-After` | Honoured automatically; temporary 5xx and network errors are retried. |
| Only **public repositories** and the **default branch** are searchable | Feature-branch commits count once merged (by their original author date). Private-repo commits are invisible to RKC. |
| Commits must be **linked to the GitHub account** | The commit email must be one of the contributor's verified GitHub emails, like the GitHub contribution graph. |
| Commits that exist only in forks may not be indexed | Ask contributors to commit to their own repositories. |
| Search indexing is not instant | New pushes can take a few minutes to appear; later syncs re-check the last 14 days. |
| Git author dates can be set to anything | Future dates are rejected. Back-dated commits can't be detected by any public API and count on the date they claim (but never before the start date). |

## Security model

- **Browser:** only ever has the **publishable key**.
- **Sync:** the hourly sync uses a **secret key** stored only in GitHub's encrypted Actions secrets; it is never in the
  website or the repository, and is never printed in logs.
- **Row Level Security** on every table:
  - anyone can `SELECT` contributors (`students`), commits and daily activity (that's the public dashboard);
  - writes to `students` and `commits` require `public.is_admin()`, i.e. the signed-in user is listed in `admins`;
  - nobody can write `daily_activity` directly; only the `SECURITY DEFINER` triggers do;
  - `admins` cannot be modified through the API at all (SQL Editor only).
- **Table privileges** are also granted explicitly per role as a second layer.
- **Admin sign-in** uses Supabase Auth (email + password). Hiding the admin UI is cosmetic; the database enforces the rules.

## Updating

When a new version changes `supabase/schema.sql`, run the whole file again in the **SQL Editor**. It is idempotent: it
updates functions, triggers, policies and grants, and keeps your contributors and their data.
Website changes go live automatically via GitHub Pages after a push.

**Changing the start date:** edit the date in `rkc_tracking_start()` in `supabase/schema.sql` and re-run the file. Commits
from before the new date are deleted with their points. If you move the date *earlier*, tick **Full re-scan** on the admin
page and refresh, so the older commits are fetched.

**Changing the timezone:** edit `TIMEZONE` in `js/config.js` **and** `rkc_timezone()` in `supabase/schema.sql`, re-run the
file, then run `select public.rkc_rebuild_daily_activity();` to recompute every day.

## Tests

```bash
npm test          # unit tests: points, leaderboard, streaks, series, GitHub client, rate limits, sync logic (no setup)

npm install       # the integration tests need @supabase/supabase-js
cp .env.example .env   # point it at a THROWAWAY or local Supabase project (tests create and delete data)
npm run test:db   # RLS, constraints, duplicates, points triggers, start date, username change, cascade, live GitHub sync
```

To run Supabase locally: `npx supabase init && npx supabase start`, apply the schema with
`psql postgresql://postgres:postgres@127.0.0.1:54322/postgres -f supabase/schema.sql`, and use the printed URL/keys.
The points tests need a start date at least 3 days in the past; on a local database set one with:

```sql
create or replace function public.rkc_tracking_start() returns date language sql immutable as $$ select date '2026-10-25' $$;
```
