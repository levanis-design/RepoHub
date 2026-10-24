/* MOST STARRED. GitHub has no "top repositories" list in its API, but its
   repository search can sort by stars, which gives the same thing and can be
   narrowed by language, topic, keywords and creation date:

     GET /search/repositories?q=stars:>=1000 archived:false&sort=stars&order=desc

   Limits (GitHub's): 10 searches a minute signed out, 30 signed in; at most
   1,000 results per search, 100 per page. RepoHub asks for 30 at a time and
   keeps each page for 30 minutes, so flipping between filters is free.

   GitHub's Trending page has no API; "New this week" here means repositories
   created in the last 7 days, ranked by stars, which is the closest honest match. */

const auth = require('./auth');
const github = require('./github');

const PERIODS = { all: 0, year: 365, month: 30, week: 7 };
const PER_PAGE = 30;
const MAX_RESULTS = 1000;
const TTL = 30 * 60 * 1000;
const cache = new Map(); // url → { at, data }

const LANG_RE = /^[A-Za-z0-9+#. -]{1,30}$/;
const TOPIC_RE = /^[a-z0-9][a-z0-9-]{0,49}$/;

const isoDay = (daysAgo, now = Date.now()) => new Date(now - daysAgo * 86400000).toISOString().slice(0, 10);

/* The search query, built from checked parts only. Returns { ok, q } or { ok: false, error }. */
function buildQuery({ period = 'all', language = '', topic = '', text = '', minStars, hideArchived = true } = {}, now = Date.now()) {
  if (!(period in PERIODS)) return { ok: false, error: 'Unknown time period.' };
  const lang = String(language || '').trim();
  if (lang && !LANG_RE.test(lang)) return { ok: false, error: 'That language name has characters GitHub does not use.' };
  const top = String(topic || '').trim().toLowerCase().replace(/^#/, '').replace(/\s+/g, '-');
  if (top && !TOPIC_RE.test(top)) return { ok: false, error: 'Topics use lowercase letters, numbers and hyphens (for example ai-agents).' };
  // Keywords: plain words only, so they cannot change the search's other rules.
  const words = String(text || '').replace(/[^\p{L}\p{N}\s._+#-]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
  const days = PERIODS[period];
  const floor = Number.isFinite(Number(minStars)) && Number(minStars) >= 0 ? Math.floor(Number(minStars)) : (days ? (days <= 7 ? 10 : days <= 30 ? 50 : 200) : 1000);
  const parts = [];
  if (words) parts.push(words);
  parts.push(`stars:>=${floor}`);
  if (days) parts.push(`created:>=${isoDay(days, now)}`);
  if (lang) parts.push(/\s/.test(lang) ? `language:"${lang}"` : `language:${lang}`);
  if (top) parts.push(`topic:${top}`);
  if (hideArchived) parts.push('archived:false');
  return { ok: true, q: parts.join(' ') };
}

function shape(it) {
  return {
    full: it.full_name,
    owner: it.owner && it.owner.login,
    avatar: it.owner && /^https:\/\/avatars\.githubusercontent\.com\//.test(it.owner.avatar_url || '') ? `${it.owner.avatar_url}${it.owner.avatar_url.includes('?') ? '&' : '?'}s=64` : '',
    description: String(it.description || '').slice(0, 300),
    stars: it.stargazers_count || 0,
    forks: it.forks_count || 0,
    issues: it.open_issues_count || 0,
    language: it.language || '',
    license: (it.license && it.license.spdx_id && it.license.spdx_id !== 'NOASSERTION') ? it.license.spdx_id : '',
    topics: (it.topics || []).slice(0, 6),
    createdAt: it.created_at, pushedAt: it.pushed_at,
    archived: !!it.archived, fork: !!it.fork,
  };
}

async function search(params = {}, page = 1) {
  const built = buildQuery(params);
  if (!built.ok) return built;
  const p = Math.max(1, Math.min(Math.floor(Number(page) || 1), Math.ceil(MAX_RESULTS / PER_PAGE)));
  const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(built.q)}&sort=stars&order=desc&per_page=${PER_PAGE}&page=${p}`;
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < TTL) return { ...hit.data, cached: true };
  let res;
  try { res = await github.doFetch(url, { headers: auth.headers({ Accept: 'application/vnd.github+json' }) }); }
  catch { return { ok: false, error: 'No connection to GitHub. Try again when you are back online.' }; }
  if (res.status === 403 || res.status === 429) {
    const reset = Number(res.headers.get('x-ratelimit-reset')) * 1000;
    const secs = reset ? Math.max(5, Math.round((reset - Date.now()) / 1000)) : 60;
    return { ok: false, limited: true, retryIn: secs, error: `GitHub allows ${auth.hasToken() ? 30 : 10} searches a minute${auth.hasToken() ? '' : ' without a login (30 when connected in Settings → Accounts)'}. Try again in about ${secs} seconds.` };
  }
  if (res.status === 422) return { ok: false, error: 'GitHub could not run that search. Try fewer or simpler filters.' };
  if (!res.ok) return { ok: false, error: `GitHub answered ${res.status}.` };
  const j = await res.json();
  const total = Math.min(j.total_count || 0, MAX_RESULTS);
  const data = {
    ok: true, q: built.q, page: p, perPage: PER_PAGE, total, totalFound: j.total_count || 0,
    incomplete: !!j.incomplete_results,
    hasMore: p * PER_PAGE < total,
    items: (j.items || []).map(shape),
    remaining: Number(res.headers.get('x-ratelimit-remaining')),
  };
  cache.set(url, { at: Date.now(), data });
  return data;
}

const LANGUAGES = ['Python', 'TypeScript', 'JavaScript', 'Go', 'Rust', 'Java', 'C++', 'C', 'C#', 'Kotlin', 'Swift', 'PHP', 'Ruby', 'Shell', 'Jupyter Notebook', 'HTML', 'Dart', 'Lua', 'Zig'];

module.exports = { buildQuery, search, shape, PERIODS, LANGUAGES, PER_PAGE, MAX_RESULTS };
