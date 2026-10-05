/* REPOS — every git repository on this computer, and the git work on each.

   Finds repositories under the folders you choose (your user folder by default),
   reads each one's state, and does the everyday git work in place: fetch, pull,
   commit, push, and the one-click sync (commit, then pull, then push — the same
   order and the same safety rules as the SvaNews Sync button).

   What it deliberately is not: a full git client. Anything that needs a human
   decision (a conflict, a rebase that stops half-way) is undone and reported in
   words, and the folder is left the way it was.

   Reading state never writes to the repository: every read runs with
   --no-optional-locks, so a status check cannot leave an index.lock behind or
   collide with an editor that is also using git.

   Sign-in is left to Git Credential Manager (see tooling.js). Remote
   addresses with a password or token written into them are refused. */

const path = require('path');
const fs = require('fs');
const os = require('os');
const { git, explain, firstLine, cleanRemote, webUrl } = require('./tooling');

/* ---------- configuration (userData/repos.json) ---------- */

function configFile() {
  if (process.env.REPOHUB_CONFIG) return process.env.REPOHUB_CONFIG; // checks in dev/
  try {
    const { app } = require('electron');
    return path.join(app.getPath('userData'), 'repos.json');
  } catch { return path.join(os.homedir(), '.repohub.json'); }
}

const DEFAULTS = {
  roots: [],          // folders to scan; empty means the user folder
  depth: 4,           // how many folder levels below each root to look
  extra: [],          // repositories added by hand, outside the roots
  hidden: [],         // repository paths hidden from the list
  hidePatterns: ['grafsnas'], // folder names hidden by default (Gräfsnäs lives on another computer)
  owner: '',          // your GitHub account; repos under it are grouped as "Mine"
  commands: {},       // per-repo custom commands: { "<path>": ["npm run build", ...] }
  last: [],           // last scan result, so the list shows instantly on open
  categories: {},     // your own category for a repository: { "<path>": "web" } (categories.js)
  authSource: '',     // which login RepoHub uses for GitHub requests: 'gh', 'git' or ''
};

function readConfig() {
  try { return { ...DEFAULTS, ...(JSON.parse(fs.readFileSync(configFile(), 'utf8')) || {}) }; }
  catch { return { ...DEFAULTS }; }
}

function writeConfig(patch) {
  const next = { ...readConfig(), ...patch };
  try {
    fs.mkdirSync(path.dirname(configFile()), { recursive: true });
    fs.writeFileSync(configFile(), JSON.stringify(next, null, 2));
  } catch { /* best effort */ }
  return next;
}

const norm = (p) => path.resolve(String(p || '')).toLowerCase();

/* ---------- finding repositories ---------- */

/* Folders never worth walking into: package caches, build output, app data,
   and the system's own folders. Skipping them is what keeps a scan of the
   whole user folder down to seconds. */
const SKIP = new Set([
  'node_modules', 'appdata', 'application data', '.cache', '.npm', '.nuget', '.gradle',
  '.cargo', '.rustup', '.m2', '.vscode', '.vscode-shared', '.cursor', '.android', '.expo',
  '.electron-gyp', '.ollama', '.local', 'scoop', 'dist', 'build', 'release', 'out',
  '.venv', 'venv', 'env', '__pycache__', '.uv-cache', '.next', '.turbo', 'vendor',
  'saved games', 'music', 'videos', 'pictures', 'contacts', 'favorites', 'links',
  'searches', 'onedrive', 'icloud drive', 'dropbox', '$recycle.bin', 'windows',
  'program files', 'program files (x86)', 'programdata',
]);

function hasGitDir(dir) {
  try {
    const g = path.join(dir, '.git');
    const st = fs.statSync(g);
    if (st.isFile()) return true; // a worktree or submodule pointer
    if (!st.isDirectory()) return false;
    // An empty .git folder is a leftover, not a repository.
    return fs.existsSync(path.join(g, 'HEAD'));
  } catch { return false; }
}

async function walk(root, depth, found, seen, started, limitMs) {
  if (Date.now() - started > limitMs) return;
  const key = norm(root);
  if (seen.has(key)) return;
  seen.add(key);
  if (hasGitDir(root)) found.push(root);
  if (depth <= 0) return;
  let entries;
  try { entries = await fs.promises.readdir(root, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (!e.isDirectory() || e.isSymbolicLink()) continue;
    const name = e.name.toLowerCase();
    if (name === '.git' || SKIP.has(name)) continue;
    await walk(path.join(root, e.name), depth - 1, found, seen, started, limitMs);
  }
}

function roots(cfg = readConfig()) {
  const list = (cfg.roots && cfg.roots.length ? cfg.roots : [os.homedir()]).filter((r) => fs.existsSync(r));
  return list.length ? list : [os.homedir()];
}

/* The repository list: everything found under the roots plus the ones added by
   hand. Your user folder being a repository itself is reported with a warning
   (it usually happens by accident). */
async function scan() {
  const cfg = readConfig();
  const found = [];
  const seen = new Set();
  const started = Date.now();
  for (const r of roots(cfg)) await walk(r, Math.max(1, Math.min(8, cfg.depth || 4)), found, seen, started, 60000);
  for (const x of cfg.extra || []) if (hasGitDir(x) && !found.some((f) => norm(f) === norm(x))) found.push(x);
  writeConfig({ last: found });
  return { ok: true, repos: decorate(found, cfg), timedOut: Date.now() - started > 60000 };
}

function isHidden(p, cfg) {
  const k = norm(p);
  if ((cfg.hidden || []).some((h) => norm(h) === k)) return true;
  const lower = p.toLowerCase();
  return (cfg.hidePatterns || []).some((pat) => pat && lower.includes(String(pat).toLowerCase()));
}

function decorate(paths, cfg) {
  const home = norm(os.homedir());
  return paths.map((p) => ({
    path: p,
    name: path.basename(p),
    isHome: norm(p) === home,
    hidden: isHidden(p, cfg),
    commands: (cfg.commands || {})[p] || [],
  }));
}

/* The last scan, without walking the disk again. */
function cached() {
  const cfg = readConfig();
  return { ok: true, repos: decorate((cfg.last || []).filter((p) => fs.existsSync(p)), cfg), fresh: false };
}

/* ---------- reading one repository ---------- */

// Every read: no optional locks, so nothing is written into .git.
const R = (args) => ['--no-optional-locks', ...args];

function known(dir) {
  if (!dir || !hasGitDir(dir)) return false;
  const cfg = readConfig();
  const k = norm(dir);
  return (cfg.last || []).some((p) => norm(p) === k) || (cfg.extra || []).some((p) => norm(p) === k);
}

function guard(dir) {
  if (!dir || !fs.existsSync(dir)) return { ok: false, error: 'That folder no longer exists. Rescan to refresh the list.' };
  if (!hasGitDir(dir)) return { ok: false, error: 'That folder is not a git repository.' };
  if (!known(dir)) return { ok: false, error: 'That folder is not in the repository list. Rescan or add it first.' };
  if (fs.existsSync(path.join(dir, '.git', 'index.lock'))) {
    return { ok: false, locked: true, error: 'Another git program is working in this repository (index.lock is present). If nothing else is running, use Clear lock.' };
  }
  return null;
}

function parsePorcelain(out) {
  return String(out || '').split('\n').filter(Boolean).map((line) => {
    const x = line[0], y = line[1];
    let file = line.slice(3);
    if (file.includes(' -> ')) file = file.split(' -> ').pop();
    file = file.replace(/^"(.*)"$/, '$1');
    let kind = 'changed';
    if (x === '?' && y === '?') kind = 'new';
    else if (x === 'U' || y === 'U' || (x === 'A' && y === 'A') || (x === 'D' && y === 'D')) kind = 'conflict';
    else if (x === 'D' || y === 'D') kind = 'deleted';
    else if (x === 'A') kind = 'added';
    else if (x === 'R') kind = 'renamed';
    return { file, kind };
  });
}

async function status(dir) {
  const bad = guard(dir);
  if (bad && !bad.locked) return bad;
  const [branch, remote, st, last, up] = await Promise.all([
    git(R(['rev-parse', '--abbrev-ref', 'HEAD']), { cwd: dir, timeout: 20000 }),
    git(R(['remote', 'get-url', 'origin']), { cwd: dir, timeout: 20000 }),
    git(R(['status', '--porcelain=v1', '-uall']), { cwd: dir, timeout: 60000 }),
    git(R(['log', '-1', '--format=%cs%x09%s']), { cwd: dir, timeout: 20000 }),
    git(R(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']), { cwd: dir, timeout: 20000 }),
  ]);
  let ahead = 0, behind = 0;
  if (up.code === 0) {
    const c = await git(R(['rev-list', '--left-right', '--count', '@{upstream}...HEAD']), { cwd: dir, timeout: 20000 });
    if (c.code === 0) { const [b, a] = c.out.split(/\s+/).map(Number); behind = b || 0; ahead = a || 0; }
  }
  const files = st.code === 0 ? parsePorcelain(st.out) : [];
  const [lastDate, ...lastMsg] = (last.code === 0 ? last.out : '').split('\t');
  const remoteUrl = remote.code === 0 ? remote.out : '';
  return {
    ok: true,
    path: dir,
    branch: branch.code === 0 ? branch.out : '',
    noCommits: last.code !== 0,
    remote: remoteUrl,
    web: webUrl(remoteUrl),
    upstream: up.code === 0 ? up.out : '',
    ahead, behind,
    files: files.slice(0, 500),
    changed: files.length,
    conflicts: files.filter((f) => f.kind === 'conflict').length,
    lastDate: lastDate || '',
    lastMessage: lastMsg.join('\t'),
    locked: !!(bad && bad.locked),
    statusError: st.code === 0 ? '' : firstLine(st, 'Could not read status'),
  };
}

/* Status for many repositories at once, four at a time so a big list does not
   start forty git processes together. */
async function statusMany(paths = []) {
  const out = {};
  const queue = paths.slice();
  const worker = async () => {
    while (queue.length) {
      const p = queue.shift();
      try { out[p] = await status(p); } catch (e) { out[p] = { ok: false, error: String(e && e.message || e) }; }
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  return out;
}

async function log(dir, n = 25) {
  const bad = guard(dir);
  if (bad && !bad.locked) return bad;
  const r = await git(R(['log', `-n${Math.max(1, Math.min(200, Number(n) || 25))}`, '--format=%h%x09%cs%x09%an%x09%s']), { cwd: dir, timeout: 30000 });
  if (r.code !== 0) return { ok: true, commits: [] };
  return {
    ok: true,
    commits: r.out.split('\n').filter(Boolean).map((l) => {
      const [hash, date, author, ...s] = l.split('\t');
      return { hash, date, author, subject: s.join('\t') };
    }),
  };
}

/* The change in one file, for review before a commit. A new file has no diff,
   so its first lines are shown instead. */
async function diff(dir, file) {
  const bad = guard(dir);
  if (bad && !bad.locked) return bad;
  const rel = String(file || '');
  const abs = path.resolve(dir, rel);
  if (!rel || !norm(abs).startsWith(norm(dir) + path.sep.toLowerCase())) return { ok: false, error: 'That file is outside the repository.' };
  const r = await git(R(['diff', 'HEAD', '--', rel]), { cwd: dir, timeout: 30000 });
  if (r.code === 0 && r.out) return { ok: true, text: r.out.slice(0, 200000) };
  try {
    const realDir = norm(fs.realpathSync(dir));
    if (!norm(fs.realpathSync(abs)).startsWith(realDir + path.sep.toLowerCase())) return { ok: false, error: 'That file points outside the repository.' };
    const st = fs.statSync(abs);
    if (st.size > 400000) return { ok: true, text: `(new file, ${Math.round(st.size / 1024)} KB, too large to show)` };
    return { ok: true, text: '(new file)\n\n' + fs.readFileSync(abs, 'utf8').slice(0, 200000) };
  } catch { return { ok: true, text: r.out || '(no change to show)' }; }
}

/* ---------- changing a repository ---------- */

async function fetch(dir) {
  const bad = guard(dir); if (bad) return bad;
  const r = await git(['fetch', '--prune', 'origin'], { cwd: dir, timeout: 120000 });
  return r.code === 0 ? { ok: true, steps: ['Fetched from GitHub'] } : { ok: false, ...explain(r, 'Fetch failed') };
}

async function currentBranch(dir) {
  const b = await git(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: dir });
  return b.code === 0 && b.out && b.out !== 'HEAD' ? b.out : '';
}

async function pullRebase(dir) {
  const up = await git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], { cwd: dir });
  let r;
  if (up.code === 0) r = await git(['pull', '--rebase'], { cwd: dir, timeout: 180000 });
  else {
    const branch = await currentBranch(dir);
    if (!branch) return { r: { code: 1, out: '', err: 'Not on a branch (detached HEAD). Check out a branch first.' }, pulled: false };
    const f = await git(['fetch', 'origin'], { cwd: dir, timeout: 120000 });
    if (f.code !== 0) return { r: f, pulled: false };
    const rb = await git(['rev-parse', '--verify', `origin/${branch}`], { cwd: dir });
    if (rb.code !== 0) return { r: { code: 0, out: '', err: '' }, pulled: false };
    r = await git(['pull', '--rebase', 'origin', branch], { cwd: dir, timeout: 180000 });
  }
  return { r, pulled: r.code === 0 && !/Already up to date|is up to date/i.test(`${r.out}${r.err}`) };
}

function pullFailure(r) {
  const text = `${r.err}\n${r.out}`;
  if (/conflict/i.test(text)) return { error: 'GitHub has changes to the same lines. Nothing was lost and the folder is back as it was. Open a Claude session here to resolve it, or use VS Code.' };
  if (/unrelated histories/i.test(text)) return { error: 'The GitHub repository has its own separate history. Resolve this once by hand (for example in a Claude session) before syncing.' };
  return explain(r, 'Pull failed');
}

async function pull(dir) {
  const bad = guard(dir); if (bad) return bad;
  const dirty = await git(['status', '--porcelain'], { cwd: dir });
  if (dirty.code === 0 && dirty.out) return { ok: false, error: 'There are uncommitted changes. Commit them first, or use Sync, which commits before it pulls.' };
  const { r, pulled } = await pullRebase(dir);
  if (r.code !== 0) { await git(['rebase', '--abort'], { cwd: dir }); return { ok: false, ...pullFailure(r) }; }
  return { ok: true, steps: [pulled ? 'Pulled the latest from GitHub' : 'Already up to date'] };
}

/* Bulk updates never rebase local commits or guess whether a failed status is clean. */
function updateDecision(s) {
  if (!s || !s.ok || s.statusError) return { state: 'failed', note: (s && (s.error || s.statusError)) || 'Could not read repository status.' };
  if (!s.remote) return { state: 'skipped', note: 'No remote address (origin).' };
  if (s.locked) return { state: 'skipped', note: 'A lock file is blocking Git.' };
  if (s.conflicts) return { state: 'skipped', note: 'Has conflicts.' };
  if (s.branch === 'HEAD') return { state: 'skipped', note: 'Detached HEAD: choose a branch first.' };
  if (!s.upstream) return { state: 'skipped', note: 'Branch has no upstream.' };
  if (s.changed) return { state: 'skipped', note: `${s.changed} uncommitted change(s): commit or Sync first.` };
  if (s.ahead && s.behind) return { state: 'skipped', note: `Diverged: ${s.ahead} local and ${s.behind} remote commits. Resolve this first.` };
  if (!s.behind) return { state: 'current', note: s.ahead ? `Up to date (${s.ahead} local commits to push).` : 'Up to date.' };
  return { state: 'eligible', note: `${s.behind} remote commits to pull.` };
}

async function updateOne(dir) {
  const bad = guard(dir); if (bad) return { ...bad, state: 'skipped', note: bad.error };
  const remote = await git(R(['remote', 'get-url', 'origin']), { cwd: dir });
  if (remote.code !== 0 || !remote.out) return { ok: true, state: 'skipped', note: 'No remote address (origin).' };
  const f = await fetch(dir);
  if (!f.ok) return { ...f, state: 'failed', note: f.error };
  const s = await status(dir);
  const decision = updateDecision(s);
  if (decision.state !== 'eligible') return { ok: decision.state !== 'failed', ...decision };
  // Recheck immediately before the mutation and override any autostash configuration.
  const dirty = await git(R(['status', '--porcelain']), { cwd: dir });
  if (dirty.code !== 0) return { ok: false, state: 'failed', note: firstLine(dirty) };
  if (dirty.out) return { ok: true, state: 'skipped', note: 'Uncommitted work appeared during the update.' };
  const r = await git(['-c', 'merge.autostash=false', '-c', 'rebase.autostash=false', 'pull', '--ff-only', '--no-rebase'], { cwd: dir, timeout: 180000 });
  return r.code === 0 ? { ok: true, state: 'updated', note: `Pulled ${s.behind} remote commit(s).` }
    : { ok: false, state: 'failed', note: explain(r, 'Fast-forward pull failed.').error };
}

async function commit(dir, message) {
  const bad = guard(dir); if (bad) return bad;
  const before = await git(['status', '--porcelain'], { cwd: dir });
  const changed = before.code === 0 ? before.out.split('\n').filter(Boolean).length : 0;
  if (!changed) return { ok: true, nothing: true, steps: ['Nothing to commit'] };
  const add = await git(['add', '-A'], { cwd: dir, timeout: 180000 });
  if (add.code !== 0) return { ok: false, error: `Could not stage changes: ${firstLine(add)}` };
  const staged = await git(['diff', '--cached', '--quiet'], { cwd: dir });
  if (staged.code !== 1) return { ok: true, nothing: true, steps: ['Nothing to commit'] };
  const host = os.hostname().replace(/\.local$/, '');
  const msg = String(message || '').trim() || `Update from ${host} — ${changed} file${changed === 1 ? '' : 's'}`;
  const c = await git(['commit', '-m', msg], { cwd: dir, timeout: 60000 });
  if (c.code !== 0) {
    if (/Please tell me who you are|user\.email|user\.name/i.test(`${c.err}${c.out}`)) {
      return { ok: false, error: 'Git needs your name and email for commits. Set them once in RepoHub → Tools → Git identity.' };
    }
    return { ok: false, error: `Could not commit: ${firstLine(c)}` };
  }
  return { ok: true, steps: [`Committed ${changed} file${changed === 1 ? '' : 's'}`] };
}

async function push(dir) {
  const bad = guard(dir); if (bad) return bad;
  const remote = await git(['remote', 'get-url', 'origin'], { cwd: dir });
  if (remote.code !== 0 || !remote.out) return { ok: false, error: 'This repository has no GitHub address (origin). Add one with Set GitHub address.' };
  const branch = await currentBranch(dir);
  if (!branch) return { ok: false, error: 'Not on a branch (detached HEAD). Check out a branch first.' };
  const up = await git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], { cwd: dir });
  const r = up.code === 0
    ? await git(['push'], { cwd: dir, timeout: 180000 })
    : await git(['push', '-u', 'origin', branch], { cwd: dir, timeout: 180000 });
  if (r.code !== 0) {
    if (/rejected|fetch first|non-fast-forward/i.test(`${r.err}${r.out}`)) return { ok: false, error: 'GitHub has newer commits. Pull first (or use Sync), then push.' };
    return { ok: false, ...explain(r, 'Push failed') };
  }
  return { ok: true, already: /Everything up-to-date/i.test(`${r.out}${r.err}`), steps: [/Everything up-to-date/i.test(`${r.out}${r.err}`) ? 'Already pushed' : 'Pushed to GitHub'] };
}

/* Commit, then pull, then push — in that order, because pushing before pulling
   is rejected and pulling over uncommitted work is refused. */
async function syncRepo(dir, message) {
  const bad = guard(dir); if (bad) return bad;
  const steps = [];
  const c = await commit(dir, message);
  if (!c.ok) return c;
  if (!c.nothing) steps.push(...c.steps);
  const remote = await git(['remote', 'get-url', 'origin'], { cwd: dir });
  if (remote.code !== 0 || !remote.out) return { ok: true, steps: [...steps, 'No GitHub address, so nothing was sent'] };
  const { r, pulled } = await pullRebase(dir);
  if (r.code !== 0) { await git(['rebase', '--abort'], { cwd: dir }); return { ok: false, steps, ...pullFailure(r) }; }
  if (pulled) steps.push('Pulled the latest from GitHub');
  const p = await push(dir);
  if (!p.ok) return { ...p, steps };
  if (!p.already) steps.push(...p.steps);
  return { ok: true, steps: steps.length ? steps : ['Already in sync'] };
}

async function setRemote(dir, url) {
  const bad = guard(dir); if (bad) return bad;
  const c = cleanRemote(url);
  if (!c.ok) return c;
  const has = await git(['remote', 'get-url', 'origin'], { cwd: dir });
  const r = await git(has.code === 0 ? ['remote', 'set-url', 'origin', c.url] : ['remote', 'add', 'origin', c.url], { cwd: dir });
  return r.code === 0 ? { ok: true, steps: ['GitHub address saved'] } : { ok: false, error: firstLine(r) };
}

/* A stale index.lock is left when a git program is killed mid-write. A lock
   younger than two minutes probably belongs to git running right now. */
function clearLock(dir) {
  if (!known(dir)) return { ok: false, error: 'That folder is not in the repository list.' };
  const f = path.join(dir, '.git', 'index.lock');
  try {
    const st = fs.statSync(f);
    const ageMin = (Date.now() - st.mtimeMs) / 60000;
    if (st.size > 0 && ageMin < 2) return { ok: false, error: 'The lock is less than two minutes old, so git may still be running. Try again shortly.' };
    fs.unlinkSync(f);
    return { ok: true, steps: ['Lock cleared'] };
  } catch (e) {
    if (e && e.code === 'ENOENT') return { ok: true, steps: ['No lock to clear'] };
    return { ok: false, error: String(e && e.message || e) };
  }
}

/* Clone into a folder you pick. Sign-in is allowed here (a private repository
   opens Git Credential Manager's browser sign-in). */
async function clone(url, parent) {
  const c = cleanRemote(url);
  if (!c.ok) return c;
  if (!parent || !fs.existsSync(parent)) return { ok: false, error: 'Choose the folder to clone into.' };
  const name = (c.url.split(/[/:]/).pop() || 'repo').replace(/\.git$/i, '');
  if (!/^[\w.\-]+$/.test(name)) return { ok: false, error: 'That address does not end in a usable repository name.' };
  const dest = path.join(parent, name);
  if (fs.existsSync(dest)) return { ok: false, error: `A folder named ${name} already exists there.` };
  const r = await git(['clone', c.url, dest], { cwd: parent, timeout: 600000, interactive: true });
  if (r.code !== 0) return { ok: false, ...explain(r, 'Clone failed') };
  addExtra(dest);
  return { ok: true, path: dest, steps: [`Cloned into ${dest}`] };
}

/* ---------- list management ---------- */

function addExtra(dir) {
  if (!hasGitDir(dir)) return { ok: false, error: 'That folder is not a git repository (it has no .git folder).' };
  const cfg = readConfig();
  const extra = (cfg.extra || []).filter((p) => norm(p) !== norm(dir)).concat([dir]);
  const last = (cfg.last || []).some((p) => norm(p) === norm(dir)) ? cfg.last : (cfg.last || []).concat([dir]);
  writeConfig({ extra, last });
  return { ok: true };
}

function setHidden(dir, hide) {
  const cfg = readConfig();
  const k = norm(dir);
  const hidden = (cfg.hidden || []).filter((p) => norm(p) !== k);
  let hidePatterns = cfg.hidePatterns || [];
  if (hide) hidden.push(dir);
  else {
    // Showing a repo that a name pattern hid drops that pattern.
    const lower = String(dir).toLowerCase();
    hidePatterns = hidePatterns.filter((pat) => !(pat && lower.includes(String(pat).toLowerCase())));
  }
  writeConfig({ hidden, hidePatterns });
  return { ok: true };
}

function setCommands(dir, list) {
  if (!known(dir)) return { ok: false, error: 'Unknown repository.' };
  const cfg = readConfig();
  const commands = { ...(cfg.commands || {}) };
  const clean = (Array.isArray(list) ? list : []).map((s) => String(s || '').trim()).filter(Boolean).slice(0, 20);
  if (clean.length) commands[dir] = clean; else delete commands[dir];
  writeConfig({ commands });
  return { ok: true, commands: clean };
}

function settings() {
  const cfg = readConfig();
  return { ok: true, roots: cfg.roots, effectiveRoots: roots(cfg), depth: cfg.depth, owner: cfg.owner, hidePatterns: cfg.hidePatterns, home: os.homedir() };
}

function saveSettings(patch = {}) {
  const next = {};
  if (Array.isArray(patch.roots)) next.roots = patch.roots.map(String).filter((r) => r && fs.existsSync(r));
  if (patch.depth != null) next.depth = Math.max(1, Math.min(8, Number(patch.depth) || 4));
  if (patch.owner != null) next.owner = String(patch.owner).trim();
  if (Array.isArray(patch.hidePatterns)) next.hidePatterns = patch.hidePatterns.map((s) => String(s).trim()).filter(Boolean);
  writeConfig(next);
  return settings();
}

/* ---------- what each repository can run ---------- */

/* Buttons for the Run section, read from the repository's own files. Commands
   run in a Grid terminal you can see, never hidden in the background. */
function runOptions(dir) {
  const opts = [];
  const has = (f) => fs.existsSync(path.join(dir, f));
  try {
    if (has('package.json')) {
      const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
      const pm = has('pnpm-lock.yaml') ? 'pnpm' : has('yarn.lock') ? 'yarn' : 'npm';
      opts.push({ label: `${pm} install`, command: `${pm} install`, kind: 'install' });
      for (const name of Object.keys(pkg.scripts || {})) {
        if (!/^[\w:.\-]+$/.test(name)) continue;
        const command = pm === 'npm' ? (name === 'start' || name === 'test' ? `npm ${name}` : `npm run ${name}`) : `${pm} ${name}`;
        opts.push({ label: name, command, kind: 'script' });
      }
    }
  } catch { /* unreadable package.json: no buttons from it */ }
  if (has('uv.lock')) opts.push({ label: 'uv sync', command: 'uv sync', kind: 'install' });
  else if (has('requirements.txt')) opts.push({ label: 'pip install', command: 'python -m pip install -r requirements.txt', kind: 'install' });
  else if (has('pyproject.toml')) opts.push({ label: 'pip install -e .', command: 'python -m pip install -e .', kind: 'install' });
  for (const f of ['main.py', 'app.py', 'run.py']) if (has(f)) opts.push({ label: `python ${f}`, command: `python ${f}`, kind: 'script' });
  if (has('docker-compose.yml') || has('compose.yaml')) opts.push({ label: 'docker compose up', command: 'docker compose up', kind: 'script' });
  const cfg = readConfig();
  for (const c of (cfg.commands || {})[dir] || []) opts.push({ label: c, command: c, kind: 'custom' });
  return { ok: true, options: opts.slice(0, 40), hasClaudeMd: has('CLAUDE.md'), hasAgentsMd: has('AGENTS.md') };
}


/* ---------- Files tab for a local repository ---------- */

/* Tracked files plus new ones not ignored by .gitignore. */
async function localTree(dir) {
  if (!known(dir)) return { ok: false, error: 'Unknown repository.' };
  const r = await git(R(['ls-files', '--cached', '--others', '--exclude-standard', '-z']), { cwd: dir, timeout: 60000 });
  if (r.code !== 0) return { ok: false, error: firstLine(r, 'Could not list files.') };
  const files = [...new Set(r.out.split('\0').filter(Boolean))];
  const dirs = new Set();
  for (const f of files) { const parts = f.split('/'); for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/')); }
  const items = [...[...dirs].map((p) => ({ path: p, type: 'dir', size: 0 })), ...files.map((p) => ({ path: p, type: 'file', size: 0 }))];
  return { ok: true, items: items.slice(0, 20000), truncated: items.length > 20000 };
}

async function localFile(dir, rel) {
  if (!known(dir)) return { ok: false, error: 'Unknown repository.' };
  const abs = path.resolve(dir, String(rel || ''));
  if (!norm(abs).startsWith(norm(dir) + path.sep.toLowerCase())) return { ok: false, error: 'That file is outside the repository.' };
  try {
    if (!norm(fs.realpathSync(abs)).startsWith(norm(fs.realpathSync(dir)) + path.sep.toLowerCase())) return { ok: false, error: 'That file points outside the repository.' };
    const st = fs.statSync(abs);
    if (!st.isFile()) return { ok: false, error: 'Not a file.' };
    if (st.size > 1500000) return { ok: true, tooLarge: true, size: st.size };
    const buf = fs.readFileSync(abs);
    if (buf.subarray(0, 8000).includes(0)) return { ok: true, binary: true, size: buf.length };
    return { ok: true, text: buf.toString('utf8'), size: buf.length };
  } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
}

module.exports = {
  updateOne, updateDecision,
  localTree, localFile,
  scan, cached, status, statusMany, log, diff, fetch, pull, commit, push, syncRepo,
  setRemote, clearLock, clone, addExtra, setHidden, setCommands, settings, saveSettings,
  runOptions, parsePorcelain, hasGitDir, configFile, known, readConfig, writeConfig,
};
