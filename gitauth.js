/* GIT SIGN-IN. The ordinary Git sign-in on Windows is Git Credential Manager
   (GCM), which comes with Git for Windows. It signs you in to GitHub in the
   browser and keeps the login in Windows Credential Manager, where git clone,
   pull and push find it.

   What RepoHub does with it:
     - shows which credential helper Git uses and which GitHub accounts GCM holds
       (`git credential-manager github list`: account names only)
     - "Sign in to GitHub" opens a visible terminal running
       `git credential-manager github login`, so the browser sign-in is GCM's own
     - "Sign out" runs `git credential-manager github logout <account>`
     - "Use my Git sign-in" for RepoHub's own GitHub requests asks Git for the
       saved login with `git credential fill`, prompts disabled. The token is
       held in memory only (auth.js), exactly like the GitHub CLI login, and
       never written, logged or shown.

   RepoHub never sees a password: sign-in happens in GCM's browser window. */

const os = require('os');
const { git, spawnTool, toolEnv, IS_WIN } = require('./tooling');

const ACCOUNT_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const quiet = () => toolEnv({ GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', GCM_GUI_PROMPT: 'false' });

function run(args, { input = null, timeout = 15000 } = {}) {
  return new Promise((resolve) => {
    let child;
    try { child = spawnTool('git', args, { cwd: os.tmpdir(), env: quiet(), windowsHide: true }); }
    catch (e) { resolve({ code: -1, out: '', err: String(e && e.message || e) }); return; }
    let out = '', err = '', done = false;
    const finish = (code) => { if (done) return; done = true; clearTimeout(t); resolve({ code, out: out.trim(), err: err.trim() }); };
    const t = setTimeout(() => { try { child.kill(); } catch { /* gone */ } finish(-2); }, timeout);
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { err += d.toString(); });
    child.on('error', (e) => { err += String(e && e.message || e); finish(-1); });
    child.on('close', finish);
    if (input != null) { child.stdin.on('error', () => {}); child.stdin.end(input); } else child.stdin.end();
  });
}

function helperName(h) {
  const v = String(h || '').trim();
  if (!v) return { kind: 'none', label: 'none (Git asks for a password every time, or cannot sign in)' };
  if (/^(manager|manager-core)$|git-credential-manager/i.test(v)) return { kind: 'gcm', label: 'Git Credential Manager' };
  if (/osxkeychain/i.test(v)) return { kind: 'keychain', label: 'macOS Keychain' };
  if (/libsecret/i.test(v)) return { kind: 'libsecret', label: 'the system keyring (libsecret)' };
  if (/gh(\.exe)?\s+auth\s+git-credential/i.test(v)) return { kind: 'gh', label: 'the GitHub CLI' };
  if (/^store/.test(v)) return { kind: 'store', label: 'a plain-text file (store), not recommended' };
  if (/^cache/.test(v)) return { kind: 'cache', label: 'memory for a short time (cache)' };
  return { kind: 'other', label: v };
}

/* Everything the Accounts settings show about the Git sign-in. */
async function status() {
  const ver = await git(['--version'], { timeout: 10000 });
  if (ver.code !== 0) return { ok: true, git: '', helper: helperName(''), gcm: '', accounts: [], note: 'Git is not installed. Install Git for Windows in Settings → Installers; it includes Git Credential Manager.' };
  const [helperGh, helperAll, gcm] = await Promise.all([
    git(['config', '--get-urlmatch', 'credential.helper', 'https://github.com'], { timeout: 10000 }),
    git(['config', '--get-all', 'credential.helper'], { timeout: 10000 }),
    run(['credential-manager', '--version'], { timeout: 10000 }),
  ]);
  const helperRaw = (helperGh.code === 0 && helperGh.out) || (helperAll.code === 0 && helperAll.out.split('\n').filter(Boolean).pop()) || '';
  const helper = helperName(helperRaw);
  const gcmVersion = gcm.code === 0 ? (gcm.out.split('\n')[0] || '').replace(/\+.*$/, '').trim() : '';
  let accounts = [];
  if (gcmVersion) {
    const list = await run(['credential-manager', 'github', 'list'], { timeout: 15000 });
    if (list.code === 0) accounts = list.out.split('\n').map((s) => s.trim()).filter((s) => ACCOUNT_RE.test(s));
  }
  return { ok: true, git: ver.out.replace(/^git version\s*/i, ''), helper, gcm: gcmVersion, accounts, windows: IS_WIN };
}

/* The saved GitHub login, read without prompting. Memory only; never returned to the page. */
async function readToken() {
  const r = await run(['-c', 'credential.interactive=never', 'credential', 'fill'], { input: 'protocol=https\nhost=github.com\n\n', timeout: 15000 });
  if (r.code === -1) return { ok: false, missing: true };
  if (r.code !== 0) return { ok: false, notSignedIn: true };
  const fields = Object.fromEntries(r.out.split('\n').map((l) => { const i = l.indexOf('='); return i > 0 ? [l.slice(0, i), l.slice(i + 1)] : null; }).filter(Boolean));
  const tok = String(fields.password || '').trim();
  if (!/^[A-Za-z0-9_]{20,255}$/.test(tok)) return { ok: false, notSignedIn: true };
  return { ok: true, token: tok, username: ACCOUNT_RE.test(fields.username || '') ? fields.username : '' };
}

async function logout(account) {
  if (!ACCOUNT_RE.test(String(account || ''))) return { ok: false, error: 'That is not a GitHub account name.' };
  const r = await run(['credential-manager', 'github', 'logout', account], { timeout: 20000 });
  return r.code === 0 ? { ok: true } : { ok: false, error: (r.err || r.out || 'Git Credential Manager could not sign out.').split('\n')[0] };
}

/* Make Git use Git Credential Manager for every site (what Git for Windows sets by default). */
async function useGcm() {
  const r = await git(['config', '--global', 'credential.helper', 'manager'], { timeout: 10000 });
  return r.code === 0 ? { ok: true } : { ok: false, error: (r.err || 'Could not change the Git setting.').split('\n')[0] };
}

// The fixed command the sign-in terminal runs.
const LOGIN_COMMAND = 'git credential-manager github login';

module.exports = { status, readToken, logout, useGcm, helperName, LOGIN_COMMAND, ACCOUNT_RE };
