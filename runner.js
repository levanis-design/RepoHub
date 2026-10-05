/* RUNNING THINGS. Two ways, both started only by a click:

   Jobs       install and build commands (npm install, pip install, npm start…)
              run inside RepoHub with their output streamed to the Output panel.
              One job per repository at a time; Stop ends it and everything it
              started.

   Terminals  a real PowerShell window opened in the repository's folder, either
              plain or already running Claude Code. Claude needs a real terminal
              for its interactive screen, so it is never squeezed into the
              Output panel. Windows Terminal is used when it is installed. */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { toolEnv, spawnTool, IS_WIN } = require('./tooling');

const jobs = new Map(); // dir → { child, command, started }

function start(dir, command, send) {
  if (!dir || !fs.existsSync(dir)) return { ok: false, error: 'That folder no longer exists.' };
  const cmd = String(command || '').trim();
  if (!cmd) return { ok: false, error: 'No command to run.' };
  if (jobs.has(dir)) return { ok: false, error: 'Something is already running for this repository. Stop it first.' };
  let child;
  try {
    // Its own process group outside Windows, so Stop can end everything it started.
    child = spawn(cmd, { cwd: dir, env: toolEnv({ FORCE_COLOR: '0', CI: '' }), shell: true, windowsHide: true, detached: !IS_WIN });
  } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
  const job = { child, command: cmd, started: Date.now() };
  jobs.set(dir, job);
  send({ dir, type: 'start', text: `> ${cmd}\n` });
  // Strip terminal colour codes; the Output panel is plain text.
  const clean = (d) => d.toString().replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
  child.stdout.on('data', (d) => send({ dir, type: 'out', text: clean(d) }));
  child.stderr.on('data', (d) => send({ dir, type: 'err', text: clean(d) }));
  child.on('error', (e) => send({ dir, type: 'err', text: `\n${e && e.message}\n` }));
  child.on('close', (code, signal) => {
    jobs.delete(dir);
    const secs = Math.round((Date.now() - job.started) / 1000);
    const how = job.stopped ? 'Stopped' : code === 0 ? 'Finished' : `Failed (exit code ${code}${signal ? `, ${signal}` : ''})`;
    send({ dir, type: 'end', code, ok: code === 0 && !job.stopped, text: `\n${how} after ${secs}s\n` });
  });
  return { ok: true };
}

function stop(dir) {
  const job = jobs.get(dir);
  if (!job) return { ok: true };
  job.stopped = true;
  try {
    // On Windows the shell's children (node, python) outlive a plain kill.
    if (IS_WIN && job.child.pid) {
      const killer = spawnTool('taskkill', ['/pid', String(job.child.pid), '/T', '/F'], { windowsHide: true });
      killer.on('error', () => { try { job.child.kill(); } catch { /* gone */ } });
    }
    else {
      // The process group first; then the shell's own children, for systems
      // where a new group could not be made; then the shell itself.
      try { process.kill(-job.child.pid, 'SIGTERM'); } catch { /* no group */ }
      try { require('child_process').spawnSync('pkill', ['-TERM', '-P', String(job.child.pid)]); } catch { /* no pkill */ }
      try { job.child.kill('SIGTERM'); } catch { /* gone */ }
    }
  } catch { /* already gone */ }
  return { ok: true };
}

function running() {
  return [...jobs.entries()].map(([dir, j]) => ({ dir, command: j.command, started: j.started }));
}

function stopAll() { for (const dir of jobs.keys()) stop(dir); }

/* A real terminal window in the folder. `command` is optional ("claude"). */
function openTerminal(dir, command = '') {
  if (!dir || !fs.existsSync(dir)) return { ok: false, error: 'That folder no longer exists.' };
  const cmd = String(command || '').trim();
  try {
    if (IS_WIN) {
      const wt = path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WindowsApps', 'wt.exe');
      const psExe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
      const encoded = Buffer.from('Set-Location -LiteralPath $env:REPOHUB_TERMINAL_DIR\n' + cmd, 'utf16le').toString('base64');
      const ps = [psExe, '-NoProfile', '-NoExit', '-EncodedCommand', encoded];
      const env = toolEnv({ REPOHUB_TERMINAL_DIR: dir });
      if (fs.existsSync(wt)) {
        return launch(wt, ['-d', dir, ...ps], { detached: true, stdio: 'ignore', env });
      } else {
        // "start" opens a new console window; the empty title argument is required.
        return launch(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe'), ['/d', '/c', 'start', '""', ...ps], { cwd: require('os').tmpdir(), detached: true, stdio: 'ignore', env, windowsHide: true });
      }
    } else if (process.platform === 'darwin') {
      const script = `tell application "Terminal" to do script "cd ${dir.replace(/(["\\])/g, '\\$1')}${cmd ? ' && ' + cmd : ''}"`;
      spawn('osascript', ['-e', script], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('x-terminal-emulator', ['-e', `bash -c 'cd "${dir}"; ${cmd}; exec bash'`], { detached: true, stdio: 'ignore' }).unref();
    }
    return { ok: true };
  } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
}

/* A PowerShell window running one script file (the installers). The script
   is written by installers.js from its fixed catalog. Execution policy is
   bypassed for this one file only, so Windows' default policy does not block it. */
function openScript(file) {
  if (!IS_WIN) return { ok: false, error: 'Installers run on Windows only. On this system, install the tools with its package manager.' };
  if (!file || !fs.existsSync(file)) return { ok: false, error: 'The installer script is missing.' };
  try {
    const psExe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const encoded = Buffer.from('& $env:REPOHUB_INSTALLER_FILE', 'utf16le').toString('base64');
    const ps = [psExe, '-NoProfile', '-NoExit', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded];
    const env = toolEnv({ REPOHUB_INSTALLER_FILE: file });
    const wt = path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WindowsApps', 'wt.exe');
    if (fs.existsSync(wt)) return launch(wt, ['-d', require('os').tmpdir(), ...ps], { detached: true, stdio: 'ignore', env });
    return launch(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe'), ['/d', '/c', 'start', '""', ...ps], { cwd: require('os').tmpdir(), detached: true, stdio: 'ignore', env, windowsHide: true });
  } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
}

function launch(file, args, options) {
  return new Promise((resolve) => {
    let child, timer, settled = false;
    const done = (result) => { if (settled) return; settled = true; clearTimeout(timer); resolve(result); };
    try { child = spawn(file, args, options); }
    catch (e) { done({ ok: false, error: e.message }); return; }
    child.on('error', (e) => done({ ok: false, error: `Could not open the terminal: ${e.message}` }));
    child.on('close', (code) => done(code === 0 ? { ok: true } : { ok: false, error: `The terminal launcher exited with code ${code}.` }));
    child.on('spawn', () => { child.unref(); timer = setTimeout(() => done({ ok: true }), 1500); });
  });
}

module.exports = { start, stop, stopAll, running, openTerminal, openScript };
