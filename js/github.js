// Minimal GitHub REST client with rate-limit handling. Works in the browser and in Node 18+.
// Only public endpoints are used; a token is optional and only raises rate limits.

const API = 'https://api.github.com';

export class GitHubError extends Error {
  constructor(message, { status = 0, code = 'error' } = {}) {
    super(message);
    this.name = 'GitHubError';
    this.status = status;
    this.code = code; // 'not_found' | 'rate_limited' | 'network' | 'error'
  }
}

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class GitHubClient {
  /**
   * @param {object} opts
   * @param {string} [opts.token]      optional personal access token (no scopes needed)
   * @param {Function} [opts.fetch]    fetch implementation (injectable for tests)
   * @param {Function} [opts.sleep]    sleep(ms) implementation (injectable for tests)
   * @param {Function} [opts.now]      () => epoch ms
   * @param {number} [opts.maxWaitMs]  longest we will wait for a rate-limit reset before giving up
   * @param {Function} [opts.onWait]   called with (ms, reason) before sleeping
   */
  constructor({ token = '', fetch: fetchImpl, sleep = defaultSleep, now = () => Date.now(), maxWaitMs = 90_000, onWait = () => {} } = {}) {
    this.token = token.trim();
    this.fetch = fetchImpl || globalThis.fetch.bind(globalThis);
    this.sleep = sleep;
    this.now = now;
    this.maxWaitMs = maxWaitMs;
    this.onWait = onWait;
    this.limits = {}; // resource -> { limit, remaining, reset (epoch s) }
  }

  async request(path, resource = 'core') {
    const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;

    for (let attempt = 0; attempt < 4; attempt++) {
      // Pre-emptively wait if we already know this bucket is empty.
      const known = this.limits[resource];
      if (known && known.remaining === 0) {
        await this.#waitUntil(known.reset * 1000, `GitHub ${resource} rate limit`);
        known.remaining = null;
      }

      let res;
      try {
        res = await this.fetch(API + path, { headers });
      } catch (err) {
        if (attempt === 3) throw new GitHubError(`Network error talking to GitHub: ${err.message}`, { code: 'network' });
        await this.sleep(1000 * 2 ** attempt);
        continue;
      }
      this.#readLimits(res.headers);

      if (res.ok) return res.json();

      const body = await res.json().catch(() => ({}));
      const message = body.message || res.statusText || `HTTP ${res.status}`;
      const retryAfter = Number(res.headers.get('retry-after'));
      const remaining = res.headers.get('x-ratelimit-remaining');

      if ((res.status === 403 || res.status === 429) && (retryAfter || remaining === '0' || /rate limit/i.test(message))) {
        const resetMs = retryAfter
          ? this.now() + retryAfter * 1000
          : Number(res.headers.get('x-ratelimit-reset') || 0) * 1000 || this.now() + 60_000;
        if (attempt === 3) throw this.#rateLimitError(resetMs);
        await this.#waitUntil(resetMs, 'GitHub rate limit');
        continue;
      }
      if (res.status === 404) throw new GitHubError(`Not found on GitHub (${path})`, { status: 404, code: 'not_found' });
      if (res.status === 422) {
        // Search returns 422 when the author: user does not exist.
        throw new GitHubError(`GitHub rejected the query: ${message}`, { status: 422, code: 'not_found' });
      }
      if (res.status >= 500 && attempt < 3) {
        await this.sleep(1000 * 2 ** attempt);
        continue;
      }
      if (res.status === 401) throw new GitHubError('GitHub token is invalid or expired.', { status: 401 });
      throw new GitHubError(`GitHub API error ${res.status}: ${message}`, { status: res.status });
    }
    throw new GitHubError('GitHub request failed after retries.');
  }

  /** Public profile; used to validate a username when adding a student. */
  getUser(username) {
    return this.request(`/users/${encodeURIComponent(username)}`, 'core');
  }

  /**
   * Non-merge commits authored by `username` with author date in [from, to]
   * ('YYYY-MM-DD'). Uses the commit search API (public repos, default branches).
   * Search returns at most 1000 results per query, so busy ranges are split.
   */
  async searchCommits(username, from, to, onPage = () => {}) {
    const out = [];
    const login = username.toLowerCase();
    const run = async (a, b) => {
      const q = `author:${username} author-date:${a}..${b} merge:false`;
      const base = `/search/commits?q=${encodeURIComponent(q)}&sort=author-date&order=desc&per_page=100`;
      const first = await this.request(`${base}&page=1`, 'search');
      onPage({ from: a, to: b, page: 1, total: first.total_count });
      // If the account does not exist (deleted or renamed), GitHub silently ignores
      // the author: qualifier and returns everyone's commits. Detect that and stop.
      if (first.items.length && !first.items.some((i) => (i.author?.login || '').toLowerCase() === login)) {
        throw new GitHubError(`GitHub user @${username} was not found (renamed or deleted?). Edit the contributor's username.`, { status: 422, code: 'not_found' });
      }
      if (first.total_count > 1000 && a < b) {
        const mid = midpoint(a, b);
        await run(a, mid);
        await run(nextDay(mid), b);
        return;
      }
      out.push(...first.items);
      const pages = Math.min(10, Math.ceil(first.total_count / 100));
      for (let page = 2; page <= pages; page++) {
        const data = await this.request(`${base}&page=${page}`, 'search');
        onPage({ from: a, to: b, page, total: data.total_count });
        out.push(...data.items);
        if (data.items.length < 100) break;
      }
    };
    await run(from, to);
    return out;
  }

  #readLimits(headers) {
    const resource = headers.get('x-ratelimit-resource');
    if (!resource) return;
    this.limits[resource] = {
      limit: Number(headers.get('x-ratelimit-limit')),
      remaining: Number(headers.get('x-ratelimit-remaining')),
      reset: Number(headers.get('x-ratelimit-reset')),
    };
  }

  async #waitUntil(epochMs, reason) {
    const ms = Math.max(0, epochMs - this.now()) + 1000;
    if (ms > this.maxWaitMs) throw this.#rateLimitError(epochMs);
    this.onWait(ms, reason);
    await this.sleep(ms);
  }

  #rateLimitError(epochMs) {
    const at = new Date(epochMs).toLocaleTimeString();
    return new GitHubError(
      `GitHub rate limit reached. It resets at ${at}.` + (this.token ? '' : ' Add a GitHub token to raise the limit.'),
      { status: 403, code: 'rate_limited' },
    );
  }
}

const dayMs = (d) => Date.parse(d + 'T00:00:00Z');
const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);
const midpoint = (a, b) => isoDay(dayMs(a) + Math.floor((dayMs(b) - dayMs(a)) / 86400000 / 2) * 86400000);
const nextDay = (d) => isoDay(dayMs(d) + 86400000);
