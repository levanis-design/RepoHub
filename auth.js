/* GITHUB LOGIN, BORROWED FROM THE GITHUB CLI.

   Signed out, GitHub allows 60 requests an hour from your network. Signed in,
   it allows 5,000 and opens your private repositories. Rather than asking for a
   password or registering an app, RepoHub asks the GitHub CLI (`gh`) for the
   login it already holds:

     - you sign in once with `gh auth login` (RepoHub can open that for you)
     - RepoHub reads the token with `gh auth token` when it starts, keeps it in
       memory only, and sends it only to api.github.com and raw.githubusercontent.com
     - it is never written to disk, logged or shown; "Sign out" forgets it

   Since 1.5.0 the login can instead come from Git's own sign-in (Git
   Credential Manager, see gitauth.js): the same token Git uses for clone,
   pull and push, read with prompts disabled and kept in memory only.

   Only the choice is saved (authSource in repos.json: 'gh', 'git' or ''). */

const { spawn } = require('child_process');
const { toolEnv, spawnTool, IS_WIN } = require('./tooling');
const repos = require('./repos');
const gitauth = require('./gitauth');

let token = '';
let user = null; // { login, name }
let source = ''; // 'gh' | 'git'

function readGhToken() {
  return new Promise((resolve) => {
    let child;
    try { child = spawnTool('gh', ['auth', 'token', '--hostname', 'github.com'], { cwd: require('os').tmpdir(), env: toolEnv(), windowsHide: true }); }
    catch { resolve({ ok: false, missing: true }); return; }
    let out = '', err = '';
    const t = setTimeout(() => { try { child.kill(); } catch { /* gone */ } resolve({ ok: false, error: 'The GitHub CLI did not answer.' }); }, 15000);
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { err += d.toString(); });
    child.on('error', () => { clearTimeout(t); resolve({ ok: false, missing: true }); });
    child.on('close', (code) => {
      clearTimeout(t);
      const tok = out.trim();
      if (code === 0 && /^[A-Za-z0-9_]{20,255}$/.test(tok)) resolve({ ok: true, token: tok });
      else if (/not recognized|not found|ENOENT/i.test(err)) resolve({ ok: false, missing: true });
      else resolve({ ok: false, notSignedIn: true });
    });
  });
}

async function whoAmI(fetcher) {
  try {
    const res = await fetcher('https://api.github.com/user', { headers: headers() });
    if (!res.ok) return null;
    const j = await res.json();
    return { login: j.login, name: j.name || '' };
  } catch { return null; }
}

function headers(extra = {}) {
  const h = { 'User-Agent': 'RepoHub-desktop', 'X-GitHub-Api-Version': '2022-11-28', ...extra };
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}

/* Sign in: read the chosen login (GitHub CLI or Git) and confirm it works. */
async function signIn(fetcher, from = 'gh') {
  const via = from === 'git' ? 'git' : 'gh';
  const r = via === 'git' ? await gitauth.readToken() : await readGhToken();
  if (!r.ok) {
    token = ''; user = null; source = '';
    if (via === 'git') {
      if (r.missing) return { ok: false, missing: true, error: 'Git is not installed. Install Git for Windows in Settings → Installers, then sign in.' };
      return { ok: false, notSignedIn: true, error: 'Git has no saved GitHub login yet. Press "Sign in to GitHub" under Git sign-in, finish in the browser, then press "Use my Git sign-in" again.' };
    }
    if (r.missing) return { ok: false, missing: true, error: 'The GitHub CLI is not installed. Install it from cli.github.com, then press Sign in again.' };
    if (r.notSignedIn) return { ok: false, notSignedIn: true, error: 'The GitHub CLI is installed but not signed in. Use "Sign in with the GitHub CLI" to open the sign-in, finish it in the browser, then press Sign in again.' };
    return { ok: false, error: r.error || 'Could not read the GitHub CLI login.' };
  }
  token = r.token;
  user = await whoAmI(fetcher);
  if (!user) {
    token = '';
    return { ok: false, error: via === 'git' ? 'GitHub did not accept the login saved in Git. Sign out under Git sign-in and sign in again.' : 'GitHub did not accept the GitHub CLI login. Run "gh auth login" again.' };
  }
  source = via;
  repos.writeConfig({ authSource: via, useGh: via === 'gh' });
  return { ok: true, user, source };
}

function signOut() {
  token = ''; user = null; source = '';
  repos.writeConfig({ authSource: '', useGh: false });
  return { ok: true };
}

/* On start: sign in quietly with the login chosen before. */
async function restore(fetcher) {
  const cfg = repos.readConfig();
  const via = cfg.authSource || (cfg.useGh ? 'gh' : '');
  if (!via) return { ok: true, signedIn: false };
  const r = await signIn(fetcher, via);
  return { ok: true, signedIn: r.ok, user: r.user, source: r.source };
}

async function status(fetcher) {
  let rate = null;
  try {
    const res = await fetcher('https://api.github.com/rate_limit', { headers: headers() });
    if (res.ok) { const j = await res.json(); rate = { core: j.resources.core, search: j.resources.search }; }
  } catch { /* offline */ }
  return { ok: true, signedIn: !!token, user, rate, source };
}

module.exports = { headers, signIn, signOut, restore, status, hasToken: () => !!token };
