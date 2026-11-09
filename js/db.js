// Supabase client + data access used by both pages.
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.117.3/+esm';
import { CONFIG } from './config.js';

/** Returns a problem description if config.js is not usable, otherwise null. */
export function checkConfig(cfg = CONFIG) {
  if (!cfg.SUPABASE_URL || cfg.SUPABASE_URL.includes('YOUR-PROJECT') ||
      !cfg.SUPABASE_ANON_KEY || cfg.SUPABASE_ANON_KEY.startsWith('YOUR-')) {
    return 'Supabase is not configured yet. Edit js/config.js with your project URL and anon/publishable key (see README).';
  }
  if (isSecretKey(cfg.SUPABASE_ANON_KEY)) {
    return 'js/config.js contains a Supabase service_role/secret key. Remove it immediately, rotate it in Supabase, and use the anon/publishable key instead.';
  }
  return null;
}

export function isSecretKey(key) {
  if (key.startsWith('sb_secret_')) return true;
  const parts = key.split('.');
  if (parts.length !== 3) return false;
  try {
    const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));
    return payload.role === 'service_role';
  } catch {
    return false;
  }
}

export const configError = checkConfig();
export const supabase = configError ? null : createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY);

/** Fetch every row of a query, paging past Supabase's 1000-row response cap. */
async function fetchAll(build, pageSize = 1000) {
  const out = [];
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await build().range(from, from + pageSize - 1);
    if (error) throw error;
    out.push(...data);
    if (data.length < pageSize) return out;
  }
}

export const loadStudents = () =>
  fetchAll(() => supabase.from('students').select('*').order('name').order('id'));

export const loadActivity = () =>
  fetchAll(() => supabase.from('daily_activity')
    .select('student_id, activity_date, commit_count, points')
    .order('activity_date').order('student_id'));

export async function loadRecentCommits(studentId, limit = 15) {
  const { data, error } = await supabase.from('commits')
    .select('sha, repo_full_name, message, html_url, committed_at, commit_date')
    .eq('student_id', studentId)
    .order('committed_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return data;
}

/** Storage adapter for js/sync.js (requires an admin session). */
export const syncStore = {
  async insertCommits(rows) {
    let inserted = 0;
    for (let i = 0; i < rows.length; i += 500) {
      const { data, error } = await supabase.from('commits')
        .upsert(rows.slice(i, i + 500), { onConflict: 'student_id,sha', ignoreDuplicates: true })
        .select('id');
      if (error) throw error;
      inserted += data.length;
    }
    return inserted;
  },
  async markSynced(studentId, at) {
    const { error } = await supabase.from('students').update({ last_synced_at: at }).eq('id', studentId);
    if (error) throw error;
  },
};
