// RKC configuration — edit these values after creating your Supabase project.
//
// SUPABASE_ANON_KEY is the *public* "anon" (or "publishable", sb_publishable_…) key.
// It is designed to be shipped to browsers: Row Level Security decides what it can do.
// NEVER put the service_role / secret key here — the app refuses to start if you do.
export const CONFIG = {
  SUPABASE_URL: 'https://YOUR-PROJECT-REF.supabase.co',
  SUPABASE_ANON_KEY: 'YOUR-SUPABASE-ANON-OR-PUBLISHABLE-KEY',

  // Which calendar day a commit counts for. Must match rkc_timezone() in supabase/schema.sql.
  TIMEZONE: 'Asia/Kolkata',

  // First sync of a student fetches this many days of history.
  BACKFILL_DAYS: 90,

  // Later syncs re-check this many days before the previous sync, to catch
  // commits that were authored earlier but pushed later.
  SYNC_OVERLAP_DAYS: 14,
};
