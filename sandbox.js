/* TRY BEFORE INSTALL. Runs a repository inside a throwaway Docker container,
   so you can see it working before anything lands on your own system.

   What the container gets:
     - its own copy of the code, cloned inside the container (nothing is
       written to your folders, and no folder of yours is shared with it)
     - internet access, because installing needs to download libraries
     - a cap of 2 GB memory, 2 CPUs and 1,024 processes
     - ports published on 127.0.0.1 only, so only this computer can open it

   Two ways to build it:
     image       a standard Node.js or Python image; RepoHub clones, installs
                 and starts the project with the commands it detected (you can
                 edit them before starting)
     dockerfile  the repository's own Dockerfile, built straight from its git
                 address

   Every container RepoHub makes is labelled repohub.try=1 and named
   repohub-try-…, and only those can be stopped, opened or removed from here. */

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const { toolEnv, spawnTool, IS_WIN } = require('./tooling');

const PREFIX = 'repohub-try-';
const LABEL = 'repohub.try=1';
const COMMON_PORTS = [3000, 5173, 8000, 8080, 4173, 5000, 8501, 7860, 4321, 8888, 4200, 1313];

/* ---------- running docker ---------- */

function docker(args, { timeout = 120000, input } = {}) {
  return new Promise((resolve) => {
    let child;
    try { child = spawnTool('docker', args, { env: toolEnv(), windowsHide: true }); }
    catch (e) { resolve({ code: -1, out: '', err: String(e && e.message || e) }); return; }
    let out = '', err = '', done = false;
    const finish = (code) => { if (done) return; done = true; clearTimeout(t); resolve({ code, out: out.trim(), err: err.trim() }); };
    const t = setTimeout(() => { try { child.kill(); } catch { /* gone */ } finish(-2); }, timeout);
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { err += d.toString(); });
    child.on('error', (e) => { err += String(e && e.message || e); finish(-1); });
    child.on('close', finish);
    if (input != null) child.stdin.end(input);
  });
}

/* A docker command whose output streams to the page while it runs. */
function dockerStream(args, onText) {
  return new Promise((resolve) => {
    let child;
    try { child = spawnTool('docker', args, { env: toolEnv(), windowsHide: true }); }
    catch (e) { onText(`${e && e.message}\n`); resolve({ code: -1 }); return; }
    let tail = '';
    const clean = (d) => d.toString().replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
    const take = (d) => { const s = clean(d); tail = (tail + s).slice(-4000); onText(s); };
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    child.on('error', (e) => { onText(`${e && e.message}\n`); resolve({ code: -1, tail }); });
    child.on('close', (code) => resolve({ code, tail }));
  });
}

async function status() {
  const v = await docker(['version', '--format', '{{.Server.Version}}'], { timeout: 20000 });
  if (v.code === 0 && v.out) return { ok: true, installed: true, running: true, version: v.out };
  if (v.code === -1 && /ENOENT/i.test(v.err)) return { ok: true, installed: false, running: false, error: 'Docker is not installed. Install Docker Desktop (free for personal use) to try repositories safely.' };
  return { ok: true, installed: true, running: false, error: 'Docker is installed but not running. Start Docker Desktop, wait until it says it is running, then try again.' };
}

/* ---------- the plan: how to run this repository ---------- */

function json(s) { try { return JSON.parse(s); } catch { return null; } }
/* devcontainer.json allows comments and trailing commas. Walks the text
   once, so "//" inside a string (a web address) is left alone. */
function jsonc(src) {
  const t = String(src);
  let out = '', i = 0, inStr = false;
  while (i < t.length) {
    const c = t[i], n = t[i + 1];
    if (inStr) {
      out += c;
      if (c === '\\') { out += n || ''; i += 2; continue; }
      if (c === '"') inStr = false;
      i += 1; continue;
    }
    if (c === '"') { inStr = true; out += c; i += 1; continue; }
    if (c === '/' && n === '/') { out += ' '; while (i < t.length && t[i] !== '\n') i += 1; continue; }
    if (c === '/' && n === '*') { const e = t.indexOf('*/', i + 2); if (e < 0) return null; out += ' '; i = e + 2; continue; }
    out += c; i += 1;
  }
  let clean = ''; inStr = false;
  for (i = 0; i < out.length; i++) {
    const c = out[i];
    if (inStr) { clean += c; if (c === '\\') clean += out[++i] || ''; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    if (c === ',' && /^\s*[}\]]/.test(out.slice(i + 1))) continue;
    clean += c;
  }
  return json(clean);
}

function plan(info) {
  const names = new Set((info.files || []).map((f) => f.name));
  const has = (n) => names.has(n);
  const setup = info.setup || {};
  const pkg = setup['package.json'] ? json(setup['package.json']) : null;
  const scripts = (pkg && pkg.scripts) || {};
  const deps = pkg ? { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) } : {};
  const py = `${setup['requirements.txt'] || ''}\n${setup['pyproject.toml'] || ''}`.toLowerCase();
  const isPy = has('requirements.txt') || has('pyproject.toml') || has('setup.py') || has('uv.lock');
  const notes = [];
  const out = { mode: 'image', image: '', install: '', start: '', port: 0, notes, framework: '', language: '', packageManager: '', source: 'detected from the files' };

  if (pkg) {
    out.image = 'node:22';
    const pm = has('pnpm-lock.yaml') ? 'pnpm' : has('yarn.lock') ? 'yarn' : 'npm';
    out.packageManager = pm;
    out.language = deps.typescript || has('tsconfig.json') ? 'TypeScript' : 'JavaScript';
    out.framework = deps.next ? 'Next.js' : deps.vite ? 'Vite' : deps.astro ? 'Astro' : deps.electron ? 'Electron' : deps.express ? 'Express' : deps.react ? 'React' : 'Node.js';
    out.install = pm === 'npm' ? 'npm install' : `corepack enable && ${pm} install`;
    const run = (s) => (pm === 'npm' ? `npm run ${s}` : `${pm} ${s}`);
    if (scripts.dev) {
      // Dev servers listen on localhost inside the container unless told otherwise.
      if (deps.vite || /vite/.test(scripts.dev)) { out.start = `${run('dev')} -- --host 0.0.0.0 --port 5173`; out.port = 5173; }
      else if (deps.next || /next dev/.test(scripts.dev)) { out.start = `${run('dev')} -- -H 0.0.0.0 -p 3000`; out.port = 3000; }
      else if (deps.astro) { out.start = `${run('dev')} -- --host 0.0.0.0 --port 4321`; out.port = 4321; }
      else { out.start = run('dev'); out.port = 3000; }
    } else if (scripts.start) {
      out.start = pm === 'npm' ? 'npm start' : `${pm} start`;
      out.port = deps.next ? 3000 : 3000;
    }
    if (deps.electron) notes.push('This is a desktop (Electron) app. Its window cannot be shown from a container; the sandbox can still install it and run its checks. Use Shell to look around.');
  } else if (isPy) {
    out.image = 'python:3.12';
    out.language = 'Python';
    out.packageManager = has('uv.lock') ? 'uv' : 'pip';
    out.framework = /streamlit/.test(py) ? 'Streamlit' : /gradio/.test(py) ? 'Gradio' : /fastapi/.test(py) ? 'FastAPI' : /flask/.test(py) ? 'Flask' : /django/.test(py) ? 'Django' : 'Python';
    const entry = ['app.py', 'main.py', 'run.py', 'streamlit_app.py'].find(has);
    if (has('uv.lock')) out.install = 'pip install --quiet uv && uv sync';
    else if (has('requirements.txt')) out.install = 'pip install -r requirements.txt';
    else out.install = 'pip install -e .';
    const pyRun = has('uv.lock') ? 'uv run python' : 'python';
    if (/streamlit/.test(py) && entry) { out.start = `${has('uv.lock') ? 'uv run ' : ''}streamlit run ${entry} --server.address 0.0.0.0 --server.port 8501 --server.headless true`; out.port = 8501; }
    else if (/gradio/.test(py) && entry) { out.start = `${pyRun} ${entry}`; out.port = 7860; }
    else if (entry) { out.start = `${pyRun} ${entry}`; out.port = /fastapi|uvicorn/.test(py) ? 8000 : /flask/.test(py) ? 5000 : 8000; }
  } else if (has('index.html')) {
    out.image = 'python:3.12';
    out.install = '';
    out.start = 'python -m http.server 8000 --bind 0.0.0.0';
    out.port = 8000;
    out.framework = 'Static website'; out.language = 'HTML';
    notes.push('A static website: served as files, exactly as a browser would open them.');
  }

  // A dev container definition is the author's own recipe: prefer it.
  const dc = setup['.devcontainer/devcontainer.json'] ? jsonc(setup['.devcontainer/devcontainer.json']) : null;
  if (dc) {
    if (typeof dc.image === 'string' && /^[a-z0-9][a-z0-9._\/:-]*$/i.test(dc.image)) { out.image = dc.image; out.source = 'devcontainer.json'; }
    const pc = typeof dc.postCreateCommand === 'string' ? dc.postCreateCommand : Array.isArray(dc.postCreateCommand) ? dc.postCreateCommand.map((s) => "'" + String(s).replace(/'/g, "'\\''") + "'").join(' ') : '';
    if (pc && out.source === 'devcontainer.json') out.install = pc;
    const fp = Array.isArray(dc.forwardPorts) ? Number(dc.forwardPorts[0]) : 0;
    if (fp > 0 && fp < 65536) out.port = fp;
    if (dc.build || dc.dockerFile) notes.push('Its dev container builds from its own Dockerfile; "Use its Dockerfile" follows that.');
    if (out.source === 'devcontainer.json') notes.push(`Using the author's dev container image (${dc.image}).`);
  }

  if (has('Dockerfile')) {
    out.dockerfile = true;
    if (!out.image) { out.mode = 'dockerfile'; }
    notes.push('The repository has its own Dockerfile. "Use its Dockerfile" builds it the way its author intended (slower, but closest to real).');
  }
  if (has('docker-compose.yml') || has('compose.yaml')) notes.push('It uses Docker Compose (several services together). The sandbox runs the main app only; databases or other services it expects will be missing.');
  if (setup['.env.example']) notes.push('It expects settings in a .env file (often API keys). Without them it may stop with an error; that is useful to know before installing.');
  if (!out.image && out.mode !== 'dockerfile') {
    out.image = 'node:22';
    notes.push('RepoHub could not tell how this project runs. The sandbox will download it and wait; use Shell to explore it.');
  }
  if (!out.start && out.mode === 'image') notes.push('No start command was found, so the sandbox installs it and then waits. Use Shell to run it by hand.');
  return out;
}

/* ---------- starting, watching, stopping ---------- */

const sessions = new Map(); // name → { logs child, poll timer, url, repo, log, steps, expiresAt, ttlTimer }
function stateFile() {
  if (process.env.REPOHUB_SANDBOX_STATE) return process.env.REPOHUB_SANDBOX_STATE;
  try { return path.join(require('electron').app.getPath('userData'), 'sandboxes.json'); }
  catch { return path.join(os.tmpdir(), 'repohub-sandboxes.json'); }
}
function journal() {
  try {
    const data = Object.fromEntries([...sessions].map(([name, s]) => [name, { repo: s.repo, plan: s.plan, cloneUrl: s.cloneUrl, limits: s.limits, expiresAt: s.expiresAt || 0, container: !!s.container }]));
    fs.mkdirSync(path.dirname(stateFile()), { recursive: true });
    fs.writeFileSync(stateFile(), JSON.stringify(data));
  } catch (e) { console.error('Could not save sandbox deadlines:', e.message); }
}
const STEP_RE = /^::repohub-step::([a-z]+)$/;
const MAX_LOG = 2 * 1024 * 1024;

/* Every event goes through here: the log is kept (for Download logs and for
   re-opening the page) and step markers become progress events. */
function emitter(name, send) {
  return (m) => {
    const s = sessions.get(name);
    if (s && m.text) s.log = ((s.log || '') + m.text).slice(-MAX_LOG);
    if (s && m.type === 'step') s.steps = { ...(s.steps || {}), [m.step]: m.state };
    send(m);
  };
}

const slug = (s) => String(s || 'repo').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'repo';
const validName = (n) => typeof n === 'string' && n.startsWith(PREFIX) && /^[a-z0-9][a-z0-9_.-]+$/.test(n);

function cleanUrl(u) {
  const s = String(u || '').trim();
  if (!/^https:\/\/[A-Za-z0-9.-]+\/[A-Za-z0-9._\/-]+$/.test(s)) return '';
  if (/@/.test(s)) return '';
  return s;
}

/* Does anything answer HTTP on this local port? */
function probe(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/', timeout: 2500 }, (res) => { res.resume(); resolve(true); });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
  });
}

async function mappedPorts(name) {
  const r = await docker(['port', name], { timeout: 15000 });
  if (r.code !== 0) return [];
  // "3000/tcp -> 127.0.0.1:49153"
  return r.out.split('\n').map((l) => l.match(/^(\d+)\/tcp -> [\d.:[\]]+:(\d+)$/)).filter(Boolean)
    .map((m) => ({ container: Number(m[1]), host: Number(m[2]) }));
}

async function isRunning(name) {
  const r = await docker(['inspect', '-f', '{{.State.Running}}', name], { timeout: 15000 });
  return r.code === 0 && r.out === 'true';
}

function watch(name, send, preferPort) {
  const s = sessions.get(name) || {};
  sessions.set(name, s);
  // Logs, from the start, as they come. Step markers the script prints become
  // progress events and are kept out of the log.
  const logs = spawnTool('docker', ['logs', '-f', name], { env: toolEnv(), windowsHide: true });
  const clean = (d) => d.toString().replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
  let partial = '';
  let current = '';
  const take = (d) => {
    const text = partial + clean(d);
    const lines = text.split('\n');
    partial = lines.pop();
    const keep = [];
    for (const line of lines) {
      const m = line.trim().match(STEP_RE);
      if (m) {
        if (current) send({ name, type: 'step', step: current, state: 'done' });
        current = m[1];
        send({ name, type: 'step', step: current, state: 'on' });
      } else keep.push(line);
    }
    if (keep.length) send({ name, type: 'log', text: keep.join('\n') + '\n' });
  };
  logs.stdout.on('data', take);
  logs.stderr.on('data', take);
  logs.on('error', () => { /* docker gone */ });
  s.logs = logs;
  // Look for a web page, for up to 15 minutes (first installs can be slow)
  const started = Date.now();
  const tick = async () => {
    if (!sessions.has(name)) return;
    if (!(await isRunning(name))) {
      if (s.steps) for (const [k, v] of Object.entries(s.steps)) if (v === 'on') send({ name, type: 'step', step: k, state: 'failed' });
      send({ name, type: 'stopped', text: '\nThe sandbox stopped. Read the log above for the reason.\n' });
      clearInterval(s.poll); s.poll = null;
      return;
    }
    if (s.url) return;
    const ports = await mappedPorts(name);
    ports.sort((a, b) => (b.container === preferPort) - (a.container === preferPort));
    for (const p of ports) {
      if (await probe(p.host)) {
        s.url = `http://127.0.0.1:${p.host}/`;
        for (const [k, v] of Object.entries(s.steps || {})) if (v === 'on') send({ name, type: 'step', step: k, state: 'done' });
        send({ name, type: 'step', step: 'ready', state: 'done' });
        send({ name, type: 'ready', url: s.url, port: p.container, text: `\nRunning: open ${s.url} (port ${p.container} inside the sandbox)\n` });
        return;
      }
    }
    if (Date.now() - started > 15 * 60000) { clearInterval(s.poll); s.poll = null; send({ name, type: 'log', text: '\nNo web page appeared within 15 minutes. If this is not a web app, use Shell.\n' }); }
  };
  s.poll = setInterval(tick, 3000);
}

async function start(req, send) {
  const st = await status();
  if (!st.running) return { ok: false, error: st.error };
  const url = cleanUrl(req.cloneUrl);
  if (!url) return { ok: false, error: 'The sandbox needs a public https address for the repository (private repositories cannot be cloned inside it).' };
  const p = req.plan || {};
  const name = `${PREFIX}${slug(req.repo)}-${Math.random().toString(36).slice(2, 6)}`;
  const lim = req.limits || {};
  const memGb = Math.min(16, Math.max(1, Number(lim.memoryGb) || 2));
  const cpus = Math.min(8, Math.max(1, Number(lim.cpus) || 2));
  const ttl = Math.min(480, Math.max(0, Number(lim.ttlMinutes) || 0));
  const limits = ['--memory', `${memGb}g`, '--cpus', String(cpus), '--pids-limit', '1024', '--security-opt', 'no-new-privileges', '--label', LABEL, '--label', `repohub.repo=${String(req.repo || '').slice(0, 120)}`];
  // Strict mode: the container's system files are read-only; only the code, temp and home folders can be written.
  if (lim.readOnly) limits.push('--read-only', '--tmpfs', '/app:rw,exec,size=4g', '--tmpfs', '/tmp:rw,exec,size=1g', '--tmpfs', '/root:rw,exec,size=2g');
  const ports = [...new Set([Number(p.port) || 0, ...COMMON_PORTS].filter((n) => n > 0 && n < 65536))];
  const publish = ports.flatMap((n) => ['-p', `127.0.0.1::${n}`]);
  sessions.set(name, { repo: req.repo, log: '', steps: {}, plan: p, cloneUrl: url, limits: { memGb, cpus, ttl, readOnly: !!lim.readOnly } });
  send = emitter(name, send);
  const say = (text) => send({ name, type: 'log', text });
  const step = (st, state) => send({ name, type: 'step', step: st, state });
  send({ name, type: 'created', repo: req.repo, text: `Sandbox ${name}\n` });
  step('detect', 'done');

  (async () => {
    let image = String(p.image || '').trim();
    if (p.mode === 'dockerfile') {
      image = `repohub-try/${name}:latest`;
      step('image', 'on');
      say(`\n> docker build ${url}\n`);
      const b = await dockerStream(['build', '--label', LABEL, '-t', image, url], say);
      if (b.code === 0) { step('image', 'done'); step('clone', 'done'); step('install', 'done'); }
      if (b.code !== 0) { step('image', 'failed'); send({ name, type: 'failed', text: '\nThe Dockerfile build failed. Read the log above, or try again with "Use a standard image".\n' }); return; }
      // Publish the ports its Dockerfile declares, on 127.0.0.1 only (never -P, which opens them to the network).
      const exp = await docker(['image', 'inspect', '-f', '{{json .Config.ExposedPorts}}', image], { timeout: 15000 });
      const declared = Object.keys(json(exp.out) || {}).map((k) => Number(k.split('/')[0])).filter((n) => n > 0 && n < 65536);
      const allPorts = [...new Set([...declared, ...ports])];
      say(`\n> docker run ${image}\n`);
      step('start', 'on');
      const r = await docker(['run', '-d', '--name', name, ...limits, ...allPorts.flatMap((n) => ['-p', `127.0.0.1::${n}`]), image], { timeout: 120000 });
      if (r.code !== 0) { send({ name, type: 'failed', text: `\n${r.err || r.out}\n` }); if (await owned(name)) await remove(name); return; }
    } else {
      if (!/^[a-z0-9][a-z0-9._\/-]*(:[A-Za-z0-9._-]+)?$/.test(image)) { send({ name, type: 'failed', text: '\nThat image name is not valid.\n' }); return; }
      // Download the base image only when it is not already on this computer.
      step('image', 'on');
      const local = await docker(['image', 'inspect', '-f', '{{.Id}}', image], { timeout: 15000 });
      const pull = local.code === 0 ? { code: 0 } : (say(`\n> docker pull ${image}   (first time only; can take a few minutes)\n`), await dockerStream(['pull', image], say));
      step('image', pull.code === 0 ? 'done' : 'failed');
      if (pull.code !== 0) { send({ name, type: 'failed', text: '\nCould not download the base image. Check the internet connection and that Docker Desktop is running.\n' }); return; }
      const install = String(p.install || '').trim();
      const startCmd = String(p.start || '').trim();
      // The script runs inside the container. The address is passed as a variable, not pasted into it.
      const script = [
        'set -e',
        'echo "::repohub-step::clone"',
        'echo "> git clone $REPO_URL"',
        'git clone --depth 1 "$REPO_URL" /app',
        'cd /app',
        'echo "::repohub-step::install"',
        'printf ">%s\\n" "$INSTALL_COMMAND"',
        install ? 'sh -ec "$INSTALL_COMMAND"' : '',
        'echo "::repohub-step::start"',
        startCmd ? 'printf ">%s\\n" "$START_COMMAND"' : 'echo "Installed. No start command, so the sandbox is waiting. Use Shell to explore."',
        startCmd ? 'exec sh -ec "$START_COMMAND"' : 'exec sleep infinity',
      ].filter(Boolean).join('\n');
      const env = ['-e', `REPO_URL=${url}`, '-e', `INSTALL_COMMAND=${install}`, '-e', `START_COMMAND=${startCmd}`, '-e', 'HOST=0.0.0.0', '-e', 'HOSTNAME=0.0.0.0', '-e', `PORT=${Number(p.port) || 3000}`,
        '-e', 'BROWSER=none', '-e', 'CI=1', '-e', 'GRADIO_SERVER_NAME=0.0.0.0', '-e', 'STREAMLIT_SERVER_ADDRESS=0.0.0.0', '-e', 'FLASK_RUN_HOST=0.0.0.0', '-e', 'PYTHONUNBUFFERED=1'];
      say(`\n> docker run ${image}\n`);
      const r = await docker(['run', '-d', '--name', name, ...limits, ...publish, ...env, '-w', '/', image, 'sh', '-c', script], { timeout: 120000 });
      if (r.code !== 0) { send({ name, type: 'failed', text: `\n${r.err || r.out}\n` }); if (await owned(name)) await remove(name); return; }
    }
    send({ name, type: 'running', text: '\nSandbox started. Installing and starting inside it…\n' });
    sessions.get(name).container = true;
    journal();
    watch(name, send, Number(p.port) || 0);
    if (ttl > 0) setTtl(name, ttl, send);
  })().catch((e) => { send({ name, type: 'failed', text: `\n${e && e.message}\n` }); });
  return { ok: true, name };
}

async function list() {
  const r = await docker(['ps', '-a', '--filter', `label=${LABEL}`, '--format', '{{json .}}'], { timeout: 20000 });
  if (r.code !== 0) return { ok: false, items: [], error: r.err || 'Docker could not list sandboxes.' };
  const items = r.out.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean)
    .filter((c) => validName(c.Names))
    .map((c) => {
      const repoLabel = String(c.Labels || '').split(',').find((x) => x.startsWith('repohub.repo='));
      const s = sessions.get(c.Names);
      return { name: c.Names, repo: repoLabel ? repoLabel.slice('repohub.repo='.length) : '', state: c.State, status: c.Status, created: c.CreatedAt, image: c.Image, url: s && s.url ? s.url : '', expiresAt: (s && s.expiresAt) || 0 };
    });
  return { ok: true, items };
}

/* Re-attach to a sandbox that is still running (after RepoHub restarts). */
async function attach(name, send) {
  if (!validName(name)) return { ok: false, error: 'Not a RepoHub sandbox.' };
  if (!(await owned(name))) return { ok: false, error: 'This container is not labelled as a RepoHub sandbox.' };
  const s = sessions.get(name);
  if (s && s.logs) return { ok: true, url: s.url || '', log: s.log || '', steps: s.steps || {}, expiresAt: s.expiresAt || 0, plan: s.plan || null, cloneUrl: s.cloneUrl || '', limits: s.limits || null };
  let previous = {};
  try { previous = JSON.parse(fs.readFileSync(stateFile(), 'utf8'))[name] || {}; } catch { /* no previous session */ }
  if (previous.expiresAt && previous.expiresAt <= Date.now()) { const r = await remove(name); return { ...r, expired: true }; }
  sessions.set(name, { ...previous, container: true, log: '', steps: {} });
  watch(name, emitter(name, send), 0);
  if (previous.expiresAt) setTtl(name, (previous.expiresAt - Date.now()) / 60000, emitter(name, send));
  return { ok: true, log: '', steps: {}, expiresAt: previous.expiresAt || 0, plan: previous.plan || null };
}

async function remove(name) {
  if (!validName(name)) return { ok: false, error: 'Not a RepoHub sandbox.' };
  const ownership = await owned(name);
  if (!ownership) return { ok: false, error: 'This container is not labelled as a RepoHub sandbox, or Docker cannot verify it.' };
  const s = sessions.get(name);
  const img = await docker(['inspect', '-f', '{{.Config.Image}}', name], { timeout: 15000 });
  const r = await docker(['rm', '-f', name], { timeout: 60000 });
  if (r.code !== 0 && !/No such container/i.test(r.err)) return { ok: false, error: r.err || 'Could not remove the sandbox.' };
  if (s) { try { s.logs && s.logs.kill(); } catch { /* gone */ } if (s.poll) clearInterval(s.poll); if (s.ttlTimer) clearTimeout(s.ttlTimer); sessions.delete(name); }
  journal();
  // An image built from the repository's Dockerfile goes too; standard images stay for next time.
  if (img.code === 0 && img.out.startsWith('repohub-try/')) {
    const label = await docker(['image', 'inspect', '-f', '{{json .Config.Labels}}', img.out], { timeout: 15000 });
    if (json(label.out)?.['repohub.try'] === '1') await docker(['rmi', img.out], { timeout: 60000 });
  }
  return { ok: true };
}

async function owned(name) {
  if (!validName(name)) return false;
  const r = await docker(['inspect', '-f', '{{json .Config.Labels}}', name], { timeout: 15000 });
  const labels = json(r.out);
  return r.code === 0 && labels && labels['repohub.try'] === '1';
}

async function removeAll() {
  const l = await list();
  if (!l.ok) return { ...l, removed: 0 };
  const failed = []; let removed = 0;
  for (const c of l.items) { const r = await remove(c.name); if (r.ok) removed++; else failed.push({ name: c.name, error: r.error }); }
  return { ok: failed.length === 0, removed, failed };
}

/* Time to live: the sandbox removes itself when the time is up. */
function setTtl(name, minutes, send) {
  const s = sessions.get(name);
  if (!s) return { ok: false };
  if (s.ttlTimer) clearTimeout(s.ttlTimer);
  s.expiresAt = Date.now() + minutes * 60000;
  journal();
  s.ttlTimer = setTimeout(async () => {
    const r = await remove(name);
    send({ name, type: r.ok ? 'expired' : 'failed', text: r.ok ? '\nTime is up: the sandbox was removed automatically.\n' : `\nAutomatic removal failed: ${r.error}\n` });
  }, minutes * 60000);
  send({ name, type: 'ttl', expiresAt: s.expiresAt });
  return { ok: true, expiresAt: s.expiresAt };
}

function extend(name, minutes, send) {
  if (!validName(name) || !sessions.has(name)) return { ok: false, error: 'That sandbox is not being watched.' };
  const s = sessions.get(name);
  const left = s.expiresAt ? Math.max(0, s.expiresAt - Date.now()) / 60000 : 0;
  return setTtl(name, Math.min(480, left + Math.max(1, Number(minutes) || 15)), emitter(name, send));
}

function getLog(name) {
  if (!validName(name)) return { ok: false, error: 'Not a RepoHub sandbox.' };
  const s = sessions.get(name);
  return { ok: true, text: (s && s.log) || '' };
}

function stopWatching() {
  for (const s of sessions.values()) { try { s.logs && s.logs.kill(); } catch { /* gone */ } if (s.poll) clearInterval(s.poll); if (s.ttlTimer) clearTimeout(s.ttlTimer); }
}

async function restore(send) {
  const l = await list();
  if (!l.ok) return l;
  let previous = {};
  try { previous = JSON.parse(fs.readFileSync(stateFile(), 'utf8')); } catch { /* no journal */ }
  // Seed every deadline before attach writes the journal, preserving sibling sessions.
  for (const item of l.items) sessions.set(item.name, { ...(previous[item.name] || {}), log: '', steps: {} });
  for (const item of l.items) await attach(item.name, send);
  return { ok: true };
}

async function shutdown() {
  stopWatching();
  const failed = [];
  for (const name of [...sessions.keys()]) {
    if (await owned(name)) { const r = await remove(name); if (!r.ok) failed.push(r.error); }
    else if (sessions.get(name)?.container) failed.push(`Could not verify cleanup for ${name}; check Docker when it is available.`);
  }
  return { ok: !failed.length, failed };
}

function previewAllowed(url) { return [...sessions.values()].some((s) => s.url && s.url === url); }

/* The command a terminal runs to look inside a sandbox. */
function shellCommand(name) {
  if (!validName(name)) return '';
  // No semicolons: Windows Terminal would read them as its own command separator.
  return `docker exec -it ${name} sh -c "cd /app && exec bash || exec sh"`;
}

module.exports = { status, plan, start, list, attach, remove, removeAll, stopWatching, shellCommand, validName, cleanUrl, extend, getLog, jsonc, owned, restore, shutdown, previewAllowed, PREFIX, IS_WIN };
