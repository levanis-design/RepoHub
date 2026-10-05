/* TOOLING. One way to run git and the other command-line tools for the whole
   app, and one way to explain git failures in plain words.

   Finding tools reliably on Windows:
     - The PATH is re-read from the registry (user and system) before each
       check, so a tool installed while RepoHub is open is found at once,
       without restarting the app.
     - Common install folders are added, because an app started from the Start
       menu can inherit a bare PATH.
     - NoDefaultCurrentDirectoryInExePath=1 stops Windows from looking in the
       current folder first. Without it, "git" typed in RepoHub's own folder
       found RepoHub's git.js and opened it with Windows Script Host.
     - Tool checks run from the temporary folder, never from a project folder.

   Prompts are never left waiting invisibly: non-interactive git calls fail
   fast, and only clone and sign-in may open Git Credential Manager's browser
   sign-in. The app never sees or stores a password or token. */

const path = require('path');
const os = require('os');
const fs = require('fs');
const { spawn, execFileSync } = require('child_process');

const IS_WIN = process.platform === 'win32';

/* The PATH Windows would give a newly opened terminal: user plus system,
   with %VARIABLES% expanded. Cached for 10 seconds. */
let regCache = { at: 0, value: '' };
function registryPath() {
  if (!IS_WIN) return '';
  if (Date.now() - regCache.at < 10000) return regCache.value;
  const read = (key) => {
    try {
      const out = execFileSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'reg.exe'), ['query', key, '/v', 'Path'], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
      const m = out.match(/Path\s+REG_(?:EXPAND_)?SZ\s+(.+)/i);
      return m ? m[1].trim().replace(/%([^%]+)%/g, (all, name) => process.env[name] || all) : '';
    } catch { return ''; }
  };
  const value = [read('HKCU\\Environment'), read('HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment')].filter(Boolean).join(';');
  regCache = { at: Date.now(), value };
  return value;
}

function toolPath() {
  const home = os.homedir();
  const local = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
  const roaming = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
  const extra = IS_WIN
    ? [
        'C:\\Program Files\\Git\\cmd',
        'C:\\Program Files (x86)\\Git\\cmd',
        path.join(local, 'Programs', 'Git', 'cmd'),
        'C:\\Program Files\\nodejs',
        path.join(roaming, 'npm'),
        path.join(local, 'Microsoft', 'WinGet', 'Links'),
        path.join(local, 'Microsoft', 'WindowsApps'),
        path.join(local, 'Programs', 'Python', 'Python313'),
        path.join(local, 'Programs', 'Python', 'Python313', 'Scripts'),
        path.join(home, '.local', 'bin'),
        path.join(home, '.cargo', 'bin'),
        'C:\\Program Files\\Go\\bin',
        path.join(home, 'go', 'bin'),
        'C:\\Program Files\\Docker\\Docker\\resources\\bin',
        'C:\\Program Files\\GitHub CLI',
        path.join(local, 'pnpm'),
      ]
    : ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', path.join(home, '.local', 'bin'), path.join(home, '.cargo', 'bin')];
  const parts = [...extra, registryPath(), process.env.PATH || process.env.Path || ''].join(path.delimiter).split(path.delimiter);
  const seen = new Set();
  return parts.map((p) => p.trim().replace(/^"(.*)"$/, '$1')).filter((p) => { const k = p.toLowerCase(); if (!path.isAbsolute(p) || seen.has(k)) return false; seen.add(k); return true; }).join(path.delimiter);
}

/* libuv can search the working directory even when CMD's lookup is disabled.
   Resolve tools ourselves using absolute PATH entries and executable extensions. */
function resolveTool(bin, env = toolEnv()) {
  if (!/^[a-z0-9_.-]+$/i.test(bin)) return '';
  const extensions = IS_WIN ? ['.exe', '.com', '.cmd', '.bat'] : [''];
  for (const dir of (env.PATH || '').split(path.delimiter)) {
    if (!path.isAbsolute(dir)) continue;
    for (const ext of extensions) {
      const file = path.join(dir, bin + ext);
      try { if (fs.statSync(file).isFile()) return file; } catch { /* absent */ }
    }
  }
  return '';
}

function spawnTool(bin, args = [], options = {}) {
  const env = options.env || toolEnv();
  const file = resolveTool(bin, env);
  if (!file) { const e = new Error(`${bin} was not found on PATH (ENOENT).`); e.code = 'ENOENT'; throw e; }
  if (IS_WIN && /\.(cmd|bat)$/i.test(file)) {
    // Only fixed CLI arguments use a batch shim; repository content goes via stdin.
    if ([file, ...args].some((s) => /["% !^&|<>\r\n]/.test(String(s).replace(/ /g, '')))) throw new Error('Unsafe batch tool argument.');
    const command = [file, ...args].map((s) => `"${s}"`).join(' ');
    return spawn(command, { ...options, env, shell: path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe') });
  }
  return spawn(file, args, { ...options, env, shell: false });
}

function toolEnv(extra = {}) {
  const env = { ...process.env, PATH: toolPath(), ...extra };
  if (IS_WIN) {
    delete env.Path; // one PATH, not two differently cased copies
    env.NoDefaultCurrentDirectoryInExePath = '1';
  }
  return env;
}

function gitEnv({ interactive = false } = {}) {
  return toolEnv(interactive
    ? { GCM_INTERACTIVE: 'always' }
    : { GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' });
}

function git(args, { cwd, timeout = 90000, interactive = false } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnTool('git', args, { cwd: cwd || os.homedir(), env: gitEnv({ interactive }), windowsHide: true });
    } catch (err) {
      resolve({ code: -1, out: '', err: String(err && err.message || err) });
      return;
    }
    let out = '', errOut = '', done = false;
    const finish = (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ code, out: out.replace(/\s+$/, ''), err: errOut.trim() });
    };
    const timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } finish(-2); }, timeout);
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { errOut += d.toString(); });
    child.on('error', (err) => { errOut += String(err && err.message || err); finish(-1); });
    child.on('close', finish);
  });
}

const firstLine = (r, fallback) => ((r.err || r.out || fallback || '').split('\n').find(Boolean) || fallback || '').trim();

const LOGIN_RE = /could not read Username|Authentication failed|terminal prompts disabled|Permission denied \(publickey\)|403|Invalid username or password|credential/i;
const NET_RE = /Could not resolve host|unable to access|network|timed out|Connection refused/i;

function explain(r, fallback) {
  const text = `${r.err}\n${r.out}`;
  if (r.code === -1 && /ENOENT/.test(text)) return { error: 'Git is not installed or not on PATH. Install Git for Windows from git-scm.com, then restart RepoHub.' };
  if (r.code === -2) return { error: 'Git took too long to answer. Check the connection and try again.' };
  if (LOGIN_RE.test(text)) return { needsLogin: true, error: 'GitHub needs you to sign in. Run Clone or Push again and complete the GitHub sign-in window that opens.' };
  if (/Repository not found|does not appear to be a git repository/i.test(text)) return { error: 'GitHub cannot find that repository. Check the address, and that you are signed in to an account that can see it.' };
  if (NET_RE.test(text)) return { error: 'No connection to GitHub. Your work is saved locally; try again when you are back online.' };
  return { error: firstLine(r, fallback) };
}

/* A remote with a password or token written into it would sit in plain text in
   .git/config. Refuse it, and let Git Credential Manager hold the login. */
function cleanRemote(url) {
  const u = String(url || '').trim().replace(/\/+$/, '');
  if (!u) return { ok: false, error: 'Paste the repository address.' };
  if (/^https?:\/\/[^/]*@/i.test(u)) return { ok: false, error: 'Leave the login out of the address. Git asks you to sign in when it needs to, and keeps the login in Windows, not in a text file.' };
  if (/^ssh:\/\/[^/]*:[^/]*@/i.test(u)) return { ok: false, error: 'Leave the password out of the SSH address. Use an SSH key or Git Credential Manager.' };
  if (!/^(https:\/\/|git@|ssh:\/\/)/i.test(u)) return { ok: false, error: 'Use the address GitHub shows under Code, for example https://github.com/owner/repository' };
  return { ok: true, url: /^https:\/\/github\.com\/[^/]+\/[^/]+$/i.test(u) && !u.endsWith('.git') ? `${u}.git` : u };
}

function webUrl(remote) {
  if (!remote) return '';
  let m = remote.match(/^git@([^:]+):(.+?)(\.git)?$/i);
  if (m) return `https://${m[1]}/${m[2]}`;
  m = remote.match(/^ssh:\/\/git@([^/]+)\/(.+?)(\.git)?$/i);
  if (m) return `https://${m[1]}/${m[2]}`;
  m = remote.match(/^(https:\/\/.+?)(\.git)?$/i);
  return m ? m[1] : '';
}

/* Is a command-line tool installed? Used by the Tools check and by the
   install plan, to say what is missing before anything runs. */
function probe(bin, args = ['--version']) {
  return new Promise((resolve) => {
    let child;
    // From the temporary folder, so no project file can stand in for the tool.
    try { child = spawnTool(bin, args, { cwd: os.tmpdir(), env: toolEnv(), windowsHide: true }); }
    catch { resolve(''); return; }
    let out = '', err = '';
    const timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } resolve(''); }, 15000);
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { err += d.toString(); });
    child.on('error', () => { clearTimeout(timer); resolve(''); });
    child.on('close', (code) => { clearTimeout(timer); resolve(code === 0 ? ((out || err).split('\n').find(Boolean) || 'installed').trim() : ''); });
  });
}

module.exports = { git, explain, firstLine, cleanRemote, webUrl, toolEnv, probe, resolveTool, spawnTool, refreshPath: () => { regCache.at = 0; }, IS_WIN };
