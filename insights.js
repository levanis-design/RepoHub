/* INSIGHTS: is this repository good, active and safe?

   Gathers the evidence from GitHub, then turns it into:
     - a health score out of 100, in six parts, each with the evidence behind it
     - a plain verdict on "Is this maintained?" with its reasons
     - the series behind the charts: weekly commits, star history, releases,
       contributors and languages

   Request cost per repository: about 9 API requests plus 4 searches signed out;
   star history (about 12 more) only when signed in. Results are kept for six
   hours, in memory and in insights.json, so Compare and revisits are free. */

const fs = require('fs');
const os = require('os');
const path = require('path');
const github = require('./github');
const explain = require('./explain');
const auth = require('./auth');

const SIX_HOURS = 6 * 60 * 60 * 1000;
const DAY = 86400000;

function cacheFile() {
  if (process.env.REPOHUB_INSIGHTS) return process.env.REPOHUB_INSIGHTS;
  try { return path.join(require('electron').app.getPath('userData'), 'insights.json'); }
  catch { return path.join(os.homedir(), '.repohub-insights.json'); }
}
function readCache() { try { return JSON.parse(fs.readFileSync(cacheFile(), 'utf8')) || {}; } catch { return {}; } }
function writeCache(all) {
  // Keep the 60 most recent, so the file stays small.
  const keep = Object.entries(all).sort((a, b) => (b[1].at || 0) - (a[1].at || 0)).slice(0, 60);
  try { fs.mkdirSync(path.dirname(cacheFile()), { recursive: true }); fs.writeFileSync(cacheFile(), JSON.stringify(Object.fromEntries(keep))); } catch { /* best effort */ }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dayText = (n) => (n === 0 ? 'today' : n === 1 ? '1 day ago' : `${n} days ago`);
const daysSince = (iso) => (iso ? Math.floor((Date.now() - Date.parse(iso)) / DAY) : null);
const isoDaysAgo = (n) => new Date(Date.now() - n * DAY).toISOString().slice(0, 10);
const median = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const lastPage = (headers) => { const l = headers && headers.get('link'); const m = l && l.match(/[?&]page=(\d+)[^>]*>;\s*rel="last"/); return m ? Number(m[1]) : null; };

async function searchCount(q) {
  try { const r = await github.api(`/search/issues?q=${encodeURIComponent(q)}&per_page=1`); return r.total_count; }
  catch { return null; }
}

/* Weekly commits for the last year. GitHub computes these on request and
   answers 202 ("ask again shortly") the first time. */
async function commitActivity(full) {
  for (let i = 0; i < 4; i++) {
    try {
      const r = await github.api(`/repos/${full}/stats/commit_activity`, { full: true });
      if (r.status === 200 && Array.isArray(r.data)) return r.data.map((w) => ({ week: new Date(w.week * 1000).toISOString().slice(0, 10), total: w.total }));
      if (r.status === 204) return [];
    } catch { return null; }
    await sleep(2000 + i * 1500);
  }
  return null; // still computing
}

/* Star history from a sample of pages: each page's first star and its date. */
async function starHistory(full, stars) {
  if (!stars) return { points: [], partial: false };
  const pages = Math.ceil(stars / 100);
  const want = [...new Set([1, ...Array.from({ length: 10 }, (_, i) => Math.max(1, Math.round(((i + 1) / 11) * pages))), pages])].sort((a, b) => a - b);
  const points = [];
  let partial = false;
  for (const p of want) {
    try {
      const r = await github.api(`/repos/${full}/stargazers?per_page=100&page=${p}`, { accept: 'application/vnd.github.star+json' });
      if (!Array.isArray(r) || !r.length || !r[0].starred_at) { partial = true; break; }
      points.push({ date: r[0].starred_at.slice(0, 10), stars: (p - 1) * 100 + 1 });
    } catch { partial = true; break; } // very large star counts are only partly listed by GitHub
  }
  points.push({ date: new Date().toISOString().slice(0, 10), stars });
  return { points, partial };
}

async function gather(full, info) {
  const [releases, contribs, contribCount, closed, workflows, community, activity, openPRs, opened90, closed90, merged90] = await Promise.all([
    github.api(`/repos/${full}/releases?per_page=50`).catch(() => []),
    github.api(`/repos/${full}/contributors?per_page=100`).catch(() => []),
    github.api(`/repos/${full}/contributors?per_page=1&anon=true`, { full: true }).then((r) => lastPage(r.headers) || (Array.isArray(r.data) ? r.data.length : 0)).catch(() => null),
    github.api(`/repos/${full}/issues?state=closed&sort=updated&direction=desc&per_page=100`).catch(() => []),
    github.api(`/repos/${full}/actions/workflows?per_page=1`).then((r) => r.total_count || 0).catch(() => null),
    github.api(`/repos/${full}/community/profile`).catch(() => null),
    commitActivity(full),
    searchCount(`repo:${full} is:pr is:open`),
    searchCount(`repo:${full} is:issue created:>=${isoDaysAgo(90)}`),
    searchCount(`repo:${full} is:issue closed:>=${isoDaysAgo(90)}`),
    searchCount(`repo:${full} is:pr is:merged merged:>=${isoDaysAgo(90)}`),
  ]);
  const closeDays = (Array.isArray(closed) ? closed : [])
    .filter((x) => !x.pull_request && x.closed_at && daysSince(x.closed_at) <= 180)
    .map((x) => (Date.parse(x.closed_at) - Date.parse(x.created_at)) / DAY);
  const contributors = (Array.isArray(contribs) ? contribs : []).filter((c) => c.type !== 'Bot' && !/\[bot\]$/i.test(c.login || ''))
    .map((c) => ({ login: c.login, commits: c.contributions }));
  const stars = auth.hasToken() ? await starHistory(full, info.stars) : null;
  return {
    releases: (Array.isArray(releases) ? releases : []).filter((r) => !r.draft)
      .map((r) => ({ tag: r.tag_name, name: r.name || r.tag_name, date: (r.published_at || r.created_at || '').slice(0, 10), prerelease: !!r.prerelease })),
    contributors,
    contributorCount: contribCount,
    medianCloseDays: closeDays.length >= 3 ? Math.round(median(closeDays) * 10) / 10 : null,
    closedSample: closeDays.length,
    workflows,
    community: community ? {
      health: community.health_percentage,
      contributing: !!(community.files && community.files.contributing),
      codeOfConduct: !!(community.files && community.files.code_of_conduct),
      issueTemplate: !!(community.files && community.files.issue_template),
    } : null,
    activity,
    openPRs,
    opened90, closed90, merged90,
    starHistory: stars,
  };
}

/* ---------- the score ---------- */

function busFactor(contributors) {
  const total = contributors.reduce((a, c) => a + c.commits, 0);
  if (!total) return null;
  let run = 0;
  for (let i = 0; i < contributors.length; i++) { run += contributors[i].commits; if (run >= total / 2) return i + 1; }
  return contributors.length;
}

function hasTests(info, facts) {
  const names = new Set((info.files || []).map((f) => f.name.toLowerCase()));
  if (['test', 'tests', '__tests__', 'spec', 'e2e', 'testing'].some((n) => names.has(n))) return true;
  const pkg = (() => { try { return JSON.parse((info.setup || {})['package.json'] || ''); } catch { return null; } })();
  if (pkg && pkg.scripts && pkg.scripts.test && !/no test specified/i.test(pkg.scripts.test)) return true;
  if (/pytest|unittest|tox/i.test(`${(info.setup || {})['pyproject.toml'] || ''}${(info.setup || {})['requirements.txt'] || ''}`)) return true;
  return false;
}

function score(info, g, facts) {
  const parts = [];
  const add = (key, label, max, items) => {
    const pts = Math.min(max, items.reduce((a, x) => a + x.pts, 0));
    parts.push({ key, label, max, points: Math.round(pts), items });
  };
  const pushedDays = daysSince(info.pushedAt);
  const weeks12 = Array.isArray(g.activity) ? g.activity.slice(-12).reduce((a, w) => a + w.total, 0) : null;
  const lastRelease = g.releases.find((r) => !r.prerelease) || g.releases[0];
  const relDays = lastRelease ? daysSince(lastRelease.date) : null;
  const bf = busFactor(g.contributors);
  const names = new Set((info.files || []).map((f) => f.name.toLowerCase()));
  const has = (re) => [...names].some((n) => re.test(n));
  const tests = hasTests(info, facts);
  const lifecycle = (facts.cautions || []).some((c) => /runs its own scripts during install/.test(c));
  const pipe = (facts.cautions || []).some((c) => /piping a download/.test(c));

  add('activity', 'Activity', 25, [
    { label: pushedDays == null ? 'last change unknown' : `last change ${dayText(pushedDays)}`, pts: pushedDays == null ? 0 : pushedDays <= 30 ? 15 : pushedDays <= 90 ? 11 : pushedDays <= 180 ? 7 : pushedDays <= 365 ? 3 : 0 },
    { label: weeks12 == null ? 'weekly commits still being counted by GitHub' : `${weeks12} commits in the last 12 weeks`, pts: weeks12 == null ? 5 : weeks12 >= 24 ? 10 : weeks12 >= 6 ? 7 : weeks12 >= 1 ? 4 : 0 },
  ]);
  const ratio = g.opened90 ? (g.closed90 || 0) / g.opened90 : null;
  add('maintenance', 'Maintenance', 20, [
    { label: lastRelease ? `latest release ${lastRelease.tag}, ${dayText(relDays)}` : 'no releases published', pts: relDays == null ? 0 : relDays <= 180 ? 6 : relDays <= 365 ? 3 : 1 },
    { label: g.opened90 == null ? 'issue counts unavailable' : g.opened90 === 0 ? 'no new issues in 90 days' : `${g.closed90 || 0} issues closed for ${g.opened90} opened in 90 days`, pts: g.opened90 == null ? 3 : g.opened90 === 0 ? 6 : ratio >= 0.8 ? 8 : ratio >= 0.5 ? 5 : ratio >= 0.2 ? 2 : 0 },
    { label: g.medianCloseDays == null ? 'too few closed issues to time' : `issues close in ${g.medianCloseDays} days (median)`, pts: g.medianCloseDays == null ? 3 : g.medianCloseDays <= 7 ? 6 : g.medianCloseDays <= 30 ? 4 : g.medianCloseDays <= 90 ? 2 : 0 },
  ]);
  add('community', 'People', 15, [
    { label: bf == null ? 'contributors unknown' : bf === 1 ? 'one person wrote half the code (high dependence on them)' : `${bf} people wrote half the code`, pts: bf == null ? 0 : bf >= 4 ? 8 : bf === 3 ? 6 : bf === 2 ? 4 : 1 },
    { label: g.contributorCount == null ? 'contributor count unknown' : `${g.contributorCount} contributors`, pts: g.contributorCount == null ? 0 : g.contributorCount >= 50 ? 7 : g.contributorCount >= 10 ? 5 : g.contributorCount >= 3 ? 3 : 1 },
  ]);
  const readmeLen = String(info.readme || '').length;
  add('docs', 'Documentation', 15, [
    { label: readmeLen ? `README of ${Math.round(readmeLen / 100) / 10}k characters` : 'no README', pts: readmeLen >= 2000 ? 5 : readmeLen >= 500 ? 3 : 0 },
    { label: info.license ? `license: ${info.license}` : 'no license', pts: info.license ? 4 : 0 },
    { label: g.community && g.community.contributing ? 'contributing guide' : 'no contributing guide', pts: g.community && g.community.contributing ? 2 : 0 },
    { label: names.has('docs') || info.homepage ? 'documentation site or docs folder' : 'no docs folder or site', pts: names.has('docs') || info.homepage ? 2 : 0 },
    { label: has(/^changelog/) || g.releases.length ? 'changelog or release notes' : 'no changelog', pts: has(/^changelog/) || g.releases.length ? 2 : 0 },
  ]);
  add('engineering', 'Engineering', 15, [
    { label: g.workflows == null ? 'automated checks unknown' : g.workflows ? `${g.workflows} automated workflow${g.workflows === 1 ? '' : 's'} (GitHub Actions)` : 'no automated checks', pts: g.workflows ? 8 : 0 },
    { label: tests ? 'tests present' : 'no tests found', pts: tests ? 7 : 0 },
  ]);
  add('safety', 'Safety', 10, [
    { label: info.archived ? 'archived by its owner' : 'not archived', pts: info.archived ? 0 : 4 },
    { label: has(/^security(\.md)?$/) ? 'security policy' : 'no security policy', pts: has(/^security(\.md)?$/) ? 2 : 0 },
    { label: lifecycle ? 'runs scripts during install' : 'no install-time scripts', pts: lifecycle ? 0 : 2 },
    { label: pipe ? 'README pipes a download into a shell' : 'no "pipe to shell" install lines', pts: pipe ? 0 : 2 },
  ]);
  let total = parts.reduce((a, p) => a + p.points, 0);
  if (info.archived) total = Math.min(total, 39);
  const grade = total >= 80 ? 'Strong' : total >= 60 ? 'Good' : total >= 40 ? 'Fair' : 'Weak';

  // Is this maintained?
  const reasons = [];
  let verdict, level;
  if (info.archived) { verdict = 'Archived: no longer maintained'; level = 'bad'; reasons.push('the owner archived it, so no fixes will come'); }
  else if (pushedDays != null && pushedDays <= 90 && ((weeks12 || 0) > 0 || (relDays != null && relDays <= 180))) {
    verdict = 'Actively maintained'; level = 'ok';
    reasons.push(`changed ${dayText(pushedDays)}`);
    if (weeks12) reasons.push(`${weeks12} commits in 12 weeks`);
    if (relDays != null && relDays <= 180) reasons.push(`released ${dayText(relDays)}`);
  } else if (pushedDays != null && pushedDays <= 365) {
    verdict = 'Maintained, but slowing'; level = 'warn';
    reasons.push(`last change ${dayText(pushedDays)}`);
    if (!weeks12) reasons.push('no commits in the last 12 weeks');
  } else { verdict = 'Inactive'; level = 'bad'; reasons.push(pushedDays == null ? 'no activity data' : `no changes for ${pushedDays} days`); }
  if (g.opened90 && ratio != null && ratio < 0.3) reasons.push('issues are piling up faster than they are closed');
  if (bf === 1) reasons.push('depends on one main person');
  if ((g.merged90 || 0) > 0) reasons.push(`${g.merged90} pull requests merged in 90 days`);

  return { total, grade, parts, maintained: { verdict, level, reasons } };
}

/* ---------- entry ---------- */

async function insights(link, { force = false } = {}) {
  const info = await github.preview(link);
  if (!info.ok) return info;
  const key = info.fullName.toLowerCase();
  if (!force) {
    const hit = readCache()[key];
    if (hit && Date.now() - hit.at < SIX_HOURS && (hit.data.starHistory || !auth.hasToken())) return { ...hit.data, cached: true };
  }
  const facts = explain.facts(info);
  const g = await gather(info.fullName, info);
  const s = score(info, g, facts);
  const data = {
    ok: true,
    fullName: info.fullName, web: info.web, description: info.description,
    stars: info.stars, forks: info.forks, license: info.license, pushedAt: info.pushedAt, createdAt: info.createdAt,
    archived: info.archived, languages: info.languages, openIssues: g.openPRs != null ? Math.max(0, info.openIssues - g.openPRs) : info.openIssues,
    ...g, ...s, signedIn: auth.hasToken(), at: Date.now(),
  };
  const all = readCache(); all[key] = { at: Date.now(), data }; writeCache(all);
  return data;
}

module.exports = { insights, score, busFactor, hasTests };
