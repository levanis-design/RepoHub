/* GITHUB PREVIEW. Paste a link, see what the repository is before anything
   is downloaded: description, owner, stars, license, last activity, languages,
   the top-level files, the README and the setup files that say how it installs.

   Uses GitHub's REST API. Signed out that allows 60 requests an hour from one
   network; signed in through the GitHub CLI (auth.js) it allows 5,000 and
   private repositories work too. One preview costs three requests (the files
   themselves come from GitHub's file server), and results are kept an hour.

   Also here: branches, tags, the file tree and single files, for the Files tab. */
const auth = require('./auth');

const PARSE_RE = /^(?:https?:\/\/)?(?:www\.)?github\.com\/([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100}?)(?:\.git)?(?:[/?#].*)?$/i;
const SSH_RE = /^git@github\.com:([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100}?)(?:\.git)?$/i;
const SHORT_RE = /^([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100})$/;

/* "https://github.com/owner/repo/tree/main/src", "git@github.com:owner/repo.git"
   and "owner/repo" all mean the same repository. */
function parse(link) {
  const s = String(link || '').trim();
  const m = s.match(PARSE_RE) || s.match(SSH_RE) || s.match(SHORT_RE);
  if (!m) return null;
  const owner = m[1], repo = m[2].replace(/\.git$/i, '');
  if (!repo || repo === '.' || repo === '..') return null;
  return { owner, repo, full: `${owner}/${repo}`, cloneUrl: `https://github.com/${owner}/${repo}.git`, web: `https://github.com/${owner}/${repo}` };
}

/* Inside the app, Electron's net.fetch uses Windows' own network and proxy
   settings, as a browser would. Under plain Node (the checks in dev/) it falls
   back to the built-in fetch. */
const doFetch = (() => {
  try { const { net } = require('electron'); if (net && typeof net.fetch === 'function') return (u, o) => net.fetch(u, o); } catch { /* not in Electron */ }
  return (u, o) => fetch(u, o);
})();

const cache = new Map(); // full name → { at, data }
const HOUR = 60 * 60 * 1000;

/* One GitHub API request. `full: true` returns { status, data, headers } so
   callers can handle 202 ("still computing") and read paging headers. */
async function api(pathname, { raw = false, full = false, accept } = {}) {
  const res = await doFetch(`https://api.github.com${pathname}`, {
    headers: auth.headers({ Accept: accept || (raw ? 'application/vnd.github.raw+json' : 'application/vnd.github+json') }),
  });
  if (res.status === 404) { const e = new Error('not found'); e.status = 404; throw e; }
  if (res.status === 401) { const e = new Error('GitHub did not accept the login. Sign in again from Tools.'); e.status = 401; throw e; }
  if (res.status === 403 || res.status === 429) {
    const reset = Number(res.headers.get('x-ratelimit-reset')) * 1000;
    const mins = reset ? Math.max(1, Math.round((reset - Date.now()) / 60000)) : 60;
    const left = res.headers.get('x-ratelimit-remaining');
    const e = new Error(left === '0'
      ? (auth.hasToken()
        ? `GitHub's hourly limit is used up. It resets in about ${mins} minutes.`
        : `GitHub's limit without a login is reached (60 requests an hour). It resets in about ${mins} minutes. Sign in through the GitHub CLI in Tools to raise it to 5,000.`)
      : 'GitHub refused this request (it may be private, or blocked for this account).');
    e.status = res.status;
    throw e;
  }
  if (!res.ok && res.status !== 202) { const e = new Error(`GitHub answered ${res.status}.`); e.status = res.status; throw e; }
  const data = res.status === 202 || res.status === 204 ? null : (raw ? await res.text() : await res.json());
  return full ? { status: res.status, data, headers: res.headers } : data;
}

async function rawFile(owner, repo, branch, name, { limit = 0 } = {}) {
  try {
    const path = String(name).split('/').map(encodeURIComponent).join('/');
    const res = await doFetch(`https://raw.githubusercontent.com/${owner}/${repo}/${encodeURIComponent(branch)}/${path}`, { headers: auth.headers() });
    if (!res.ok) return '';
    if (limit) {
      const len = Number(res.headers.get('content-length') || 0);
      if (len > limit) return { tooLarge: true, size: len };
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (limit && buf.length > limit) return { tooLarge: true, size: buf.length };
    if (limit) return { buf };
    return buf.toString('utf8');
  } catch { return ''; }
}

const SETUP_FILES = ['package.json', 'requirements.txt', 'pyproject.toml', 'uv.lock', 'pnpm-lock.yaml', 'yarn.lock',
  'docker-compose.yml', 'compose.yaml', 'Dockerfile', 'Cargo.toml', 'go.mod', 'composer.json', 'Gemfile',
  'Makefile', '.env.example', 'CLAUDE.md', 'AGENTS.md', '.mcp.json', 'main.py', 'app.py', 'run.py'];

async function preview(link) {
  const p = parse(link);
  if (!p) return { ok: false, error: 'That does not look like a GitHub repository link. Use the address from the repository page, for example https://github.com/owner/repository' };
  const hit = cache.get(p.full.toLowerCase());
  if (hit && Date.now() - hit.at < HOUR) return hit.data;
  try {
    const meta = await api(`/repos/${p.owner}/${p.repo}`);
    const branch = meta.default_branch || 'main';
    // A refused request must fail the preview, not quietly leave gaps in it.
    const soft = (fallback) => (e) => { if (e && (e.status === 403 || e.status === 429)) throw e; return fallback; };
    const [contents, languages] = await Promise.all([
      api(`/repos/${p.owner}/${p.repo}/contents/`).catch(soft([])),
      api(`/repos/${p.owner}/${p.repo}/languages`).catch(soft({})),
    ]);
    const files = (Array.isArray(contents) ? contents : []).map((c) => ({ name: c.name, type: c.type === 'dir' ? 'dir' : 'file', size: c.size || 0 }));
    /* The README and setup files come from GitHub's file server, which does not
       count against the hourly limit: three API requests per preview, not ten. */
    const raw = (name) => rawFile(p.owner, p.repo, branch, name);
    const readmeEntry = files.find((f) => f.type === 'file' && /^readme(\.(md|markdown|txt|rst))?$/i.test(f.name));
    const wanted = files.filter((f) => f.type === 'file' && SETUP_FILES.includes(f.name) && f.size < 200000).slice(0, 8);
    const setup = {};
    const [readme] = await Promise.all([
      readmeEntry ? raw(readmeEntry.name) : Promise.resolve(''),
      ...wanted.map(async (f) => { const t = await raw(f.name); if (t) setup[f.name] = t.slice(0, 40000); }),
      // The dev container recipe lives one folder down.
      files.some((f) => f.name === '.devcontainer' && f.type === 'dir')
        ? raw('.devcontainer/devcontainer.json').then((t) => { if (t) setup['.devcontainer/devcontainer.json'] = t.slice(0, 40000); })
        : Promise.resolve(),
    ]);
    const totalBytes = Object.values(languages || {}).reduce((a, b) => a + b, 0) || 1;
    const data = {
      ok: true,
      source: 'github',
      ...p,
      cloneUrl: meta.clone_url || p.cloneUrl,
      name: meta.name,
      fullName: meta.full_name,
      description: meta.description || '',
      homepage: meta.homepage || '',
      stars: meta.stargazers_count || 0,
      forks: meta.forks_count || 0,
      openIssues: meta.open_issues_count || 0,
      license: (meta.license && (meta.license.spdx_id !== 'NOASSERTION' ? meta.license.spdx_id : meta.license.name)) || '',
      defaultBranch: branch,
      archived: !!meta.archived,
      fork: !!meta.fork,
      parent: meta.parent ? meta.parent.full_name : '',
      createdAt: (meta.created_at || '').slice(0, 10),
      pushedAt: (meta.pushed_at || '').slice(0, 10),
      sizeKb: meta.size || 0,
      topics: meta.topics || [],
      ownerType: meta.owner && meta.owner.type,
      languages: Object.entries(languages || {}).sort((a, b) => b[1] - a[1]).slice(0, 6)
        .map(([name, bytes]) => ({ name, pct: Math.round((bytes / totalBytes) * 1000) / 10 })),
      files,
      readme: String(readme || '').slice(0, 120000),
      setup,
    };
    cache.set(p.full.toLowerCase(), { at: Date.now(), data });
    return data;
  } catch (e) {
    if (e.status === 404) return { ok: false, error: `GitHub has no public repository at ${p.full}. If it is private, use Clone instead; Git will ask you to sign in.`, parsed: p };
    const msg = String(e && e.message || e);
    if (/fetch failed|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|ERR_INTERNET|ERR_NAME|ERR_CONNECTION/i.test(msg)) return { ok: false, error: 'Could not reach GitHub. Check the internet connection and try again.', parsed: p };
    return { ok: false, error: msg, parsed: p };
  }
}

/* ---------- Files tab ---------- */

async function refs(owner, repo) {
  const [branches, tags] = await Promise.all([
    api(`/repos/${owner}/${repo}/branches?per_page=100`).catch(() => []),
    api(`/repos/${owner}/${repo}/tags?per_page=100`).catch(() => []),
  ]);
  return { ok: true, branches: (branches || []).map((b) => b.name), tags: (tags || []).map((t) => t.name) };
}

const treeCache = new Map();
async function tree(owner, repo, ref) {
  const key = `${owner}/${repo}@${ref}`.toLowerCase();
  const hit = treeCache.get(key);
  if (hit && Date.now() - hit.at < HOUR) return hit.data;
  try {
    const t = await api(`/repos/${owner}/${repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`);
    const items = (t.tree || []).filter((x) => x.type === 'blob' || x.type === 'tree')
      .map((x) => ({ path: x.path, type: x.type === 'tree' ? 'dir' : 'file', size: x.size || 0 }));
    const data = { ok: true, ref, sha: t.sha, items: items.slice(0, 20000), truncated: !!t.truncated || items.length > 20000 };
    treeCache.set(key, { at: Date.now(), data });
    return data;
  } catch (e) {
    return { ok: false, error: e.status === 404 ? `No branch, tag or commit named "${ref}".` : String(e.message || e) };
  }
}

/* One file's text for the viewer. Binary and very large files are not shown. */
async function file(owner, repo, ref, path) {
  const r = await rawFile(owner, repo, ref, path, { limit: 1500000 });
  if (!r) return { ok: false, error: 'Could not read that file.' };
  if (r.tooLarge) return { ok: true, tooLarge: true, size: r.size };
  const buf = r.buf;
  if (buf.subarray(0, 8000).includes(0)) return { ok: true, binary: true, size: buf.length };
  return { ok: true, text: buf.toString('utf8'), size: buf.length };
}

module.exports = { parse, preview, api, rawFile, doFetch, refs, tree, file, SETUP_FILES };
