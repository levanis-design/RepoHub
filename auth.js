/* GITHUB LOGIN, BORROWED FROM THE GITHUB CLI.

   Signed out, GitHub allows 60 requests an hour from your network. Signed in,
   it allows 5,000 and opens your private repositories. Rather than asking for a
   password or registering an app, RepoHub asks the GitHub CLI (`gh`) for the
   login it already holds:

     - you sign in once with `gh auth login` (RepoHub can open that for you)
     - RepoHub reads the token with `gh auth token` when it starts, keeps it in
       memory only, and sends it only to api.github.com and raw.githubusercontent.com
     - it is never written to disk, logged or shown; "Sign out" forgets it

   Only the on/off choice is saved (useGh in repos.json). */

const { spawn } = require('child_process');
const { toolEnv, spawnTool, IS_WIN } = require('./tooling');
const repos = require('./repos');

let token = '';
let user = null; // { login, name }

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

/* Sign in: read the CLI's token and confirm it works. */
async function signIn(fetcher) {
  const r = await readGhToken();
  if (!r.ok) {
    token = ''; user = null;
    if (r.missing) return { ok: false, missing: true, error: 'The GitHub CLI is not installed. Install it from cli.github.com, then press Sign in again.' };
    if (r.notSignedIn) return { ok: false, notSignedIn: true, error: 'The GitHub CLI is installed but not signed in. Use "Sign in with the GitHub CLI" to open the sign-in, finish it in the browser, then press Sign in again.' };
    return { ok: false, error: r.error || 'Could not read the GitHub CLI login.' };
  }
  token = r.token;
  user = await whoAmI(fetcher);
  if (!user) { token = ''; return { ok: false, error: 'GitHub did not accept the GitHub CLI login. Run "gh auth login" again.' }; }
  repos.writeConfig({ useGh: true });
  return { ok: true, user };
}

function signOut() {
  token = ''; user = null;
  repos.writeConfig({ useGh: false });
  return { ok: true };
}

/* On start: sign in quietly if the user chose it before. */
async function restore(fetcher) {
  if (!repos.readConfig().useGh) return { ok: true, signedIn: false };
  const r = await signIn(fetcher);
  return { ok: true, signedIn: r.ok, user: r.user };
}

async function status(fetcher) {
  let rate = null;
  try {
    const res = await fetcher('https://api.github.com/rate_limit', { headers: headers() });
    if (res.ok) { const j = await res.json(); rate = { core: j.resources.core, search: j.resources.search }; }
  } catch { /* offline */ }
  return { ok: true, signedIn: !!token, user, rate };
}

module.exports = { headers, signIn, signOut, restore, status, hasToken: () => !!token };
