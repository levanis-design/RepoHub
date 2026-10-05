/* REPOHUB — main process. One window; every action the page asks for arrives
   here over IPC as 'area:action' and is handled by a small module:

     repos.js    finding repositories and the git work on each
     github.js   previewing a GitHub link before anything is downloaded
     explain.js  what a repository is (facts from files, summary from Claude)
     runner.js   install and run jobs, and terminals opened in a folder
     sandbox.js  Try before install: a repository running in a Docker container
     auth.js     GitHub login borrowed from the GitHub CLI (token in memory only)
     insights.js health score, "Is this maintained?" and the chart data
     collections.js  bookmarks, collections, notes, tags and recently viewed
     settings.js     every setting, validated; changes reach every window
     installers.js   the tool catalog: check, install (winget or npm), sign in
     tooling.js  running git and the other command-line tools */

const { app, BrowserWindow, ipcMain, dialog, shell, Menu, nativeTheme } = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
if (!app.isPackaged && process.env.REPOHUB_USER_DATA) app.setPath('userData', process.env.REPOHUB_USER_DATA);
const repos = require('./repos');
const github = require('./github');
const explain = require('./explain');
const runner = require('./runner');
const sandbox = require('./sandbox');
const auth = require('./auth');
const insights = require('./insights');
const saved = require('./collections');
const settings = require('./settings');
const installers = require('./installers');
const { git, probe, firstLine, toolEnv, spawnTool } = require('./tooling');

let win = null;

function createWindow() {
  win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 980,
    minHeight: 620,
    title: 'RepoHub',
    backgroundColor: '#15171c',
    icon: path.join(__dirname, 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.removeMenu();
  win.loadFile(path.join(__dirname, 'index.html'));
  wireWindow(win);
  // Links in READMEs open in the browser, never inside the app window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (url !== win.webContents.getURL()) {
      e.preventDefault();
      if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    }
  });
  if (process.argv.includes('--devtools')) win.webContents.openDevTools({ mode: 'detach' });
}

/* Shortcuts that must work even if the page itself is broken, handled before
   the page sees the key: F5 reloads the page (running jobs and sandboxes live
   here in the main process and keep running), Ctrl+Shift+R relaunches the
   whole app (needed after editing main.js or preload.js), F12 toggles DevTools.
   Also applies the text size. */
function wireWindow(w) {
  const s = settings.read();
  w.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  w.webContents.session.setPermissionCheckHandler(() => false);
  w.webContents.on('render-process-gone', (_e, detail) => {
    if (detail.reason !== 'clean-exit') dialog.showMessageBox(w, { type: 'error', title: 'RepoHub page stopped', message: 'The app page stopped. Press F5 to reload it, or Ctrl+Shift+R to relaunch.', detail: detail.reason });
  });
  w.webContents.on('did-finish-load', () => w.webContents.setZoomFactor(settings.read().textSize / 100));
  const onInput = (e, input) => {
    if (input.type !== 'keyDown') return;
    const k = String(input.key || '').toLowerCase();
    if (k === 'f5' && !input.control) { e.preventDefault(); w.webContents.reload(); }
    else if (k === 'r' && input.control && input.shift) { e.preventDefault(); relaunch(); }
    else if (k === 'f12') { e.preventDefault(); w.webContents.toggleDevTools(); }
  };
  w.webContents.on('before-input-event', onInput);
  w.webContents.on('devtools-opened', () => {
    const tools = w.webContents.devToolsWebContents;
    if (tools) tools.on('before-input-event', onInput);
  });
  return s;
}
function relaunch() { runner.stopAll(); sandbox.stopWatching(); app.relaunch(); app.exit(0); }
function applyTheme() { const m = settings.read().themeMode; nativeTheme.themeSource = m === 'day' ? 'light' : m === 'night' ? 'dark' : 'system'; }

/* Settings can also live in their own window. */
let settingsWin = null;
function openSettingsWindow() {
  if (settingsWin && !settingsWin.isDestroyed()) { settingsWin.focus(); return { ok: true }; }
  settingsWin = new BrowserWindow({
    width: 820, height: 860, minWidth: 560, minHeight: 500, title: 'RepoHub settings', backgroundColor: '#15171c',
    icon: path.join(__dirname, 'icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  settingsWin.removeMenu();
  settingsWin.loadFile(path.join(__dirname, 'index.html'), { query: { view: 'settings' } });
  wireWindow(settingsWin);
  settingsWin.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:\/\//i.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  settingsWin.webContents.on('will-navigate', (e, url) => { if (url !== settingsWin.webContents.getURL()) e.preventDefault(); });
  settingsWin.on('closed', () => { settingsWin = null; if (win && !win.isDestroyed()) win.webContents.send('settings:popped', false); });
  if (win && !win.isDestroyed()) win.webContents.send('settings:popped', true);
  return { ok: true };
}
function broadcastSettings(value) {
  for (const w of BrowserWindow.getAllWindows()) {
    if (w.isDestroyed()) continue;
    w.webContents.send('settings:changed', value);
    w.webContents.setZoomFactor(value.textSize / 100);
  }
}

const send = (msg) => { if (win && !win.isDestroyed()) win.webContents.send('job:event', msg); };
const sendSandbox = (msg) => { if (win && !win.isDestroyed()) win.webContents.send('sandbox:event', msg); };

/* The app running in a sandbox, in its own window: no preload, no Node, its own
   storage, and it may only show pages from its own local address. */
const previews = new Map(); // url → window
function openPreview(url, title) {
  if (!sandbox.previewAllowed(url)) return { ok: false, error: 'Only a running RepoHub sandbox can be previewed.' };
  const m = String(url || '').match(/^http:\/\/127\.0\.0\.1:(\d{2,5})\/?/);
  if (!m) return { ok: false, error: 'Only a sandbox address can be previewed.' };
  const origin = `http://127.0.0.1:${m[1]}`;
  const existing = previews.get(origin);
  if (existing && !existing.isDestroyed()) { existing.focus(); return { ok: true }; }
  const pw = new BrowserWindow({
    width: 1280, height: 860, title: `Sandbox preview — ${title || origin}`, backgroundColor: '#ffffff',
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, partition: 'repohub-sandbox-preview' },
  });
  pw.removeMenu();
  pw.webContents.session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  pw.webContents.session.setPermissionCheckHandler(() => false);
  const inside = (u) => String(u).startsWith(origin + '/') || String(u) === origin;
  pw.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  pw.webContents.on('will-navigate', (e, u) => { if (!inside(u)) { e.preventDefault(); if (/^https?:\/\//i.test(u)) shell.openExternal(u); } });
  pw.loadURL(origin + '/');
  previews.set(origin, pw);
  pw.on('closed', () => previews.delete(origin));
  return { ok: true };
}

/* Every handler returns { ok, … } and never throws across IPC. */
const handle = (name, fn) => ipcMain.handle(name, async (e, a = {}) => {
  const windows = [win, settingsWin].filter((w) => w && !w.isDestroyed());
  const frame = e.senderFrame;
  if (!frame || frame !== e.sender.mainFrame || !windows.some((w) => w.webContents === e.sender)
    || frame.url.split('?')[0].split('#')[0] !== pathToFileURL(path.join(__dirname, 'index.html')).href) {
    return { ok: false, error: 'This window is not allowed to use RepoHub commands.' };
  }
  try { return await fn(a || {}); } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
});

function registerIpc() {
  // Library
  handle('repos:cached', () => repos.cached());
  handle('repos:scan', () => repos.scan());
  handle('repos:status', ({ dir }) => repos.status(dir));
  handle('repos:statusMany', ({ dirs }) => repos.statusMany(Array.isArray(dirs) ? dirs : []));
  handle('repos:log', ({ dir, n }) => repos.log(dir, n));
  handle('repos:diff', ({ dir, file }) => repos.diff(dir, file));
  handle('repos:fetch', ({ dir }) => repos.fetch(dir));
  handle('repos:pull', ({ dir }) => repos.pull(dir));
  handle('repos:updateOne', ({ dir }) => repos.updateOne(dir));
  handle('repos:commit', ({ dir, message }) => repos.commit(dir, message));
  handle('repos:push', ({ dir }) => repos.push(dir));
  handle('repos:sync', ({ dir, message }) => repos.syncRepo(dir, message));
  handle('repos:setRemote', ({ dir, url }) => repos.setRemote(dir, url));
  handle('repos:clearLock', ({ dir }) => repos.clearLock(dir));
  handle('repos:setHidden', ({ dir, hide }) => repos.setHidden(dir, !!hide));
  handle('repos:setCommands', ({ dir, commands }) => repos.setCommands(dir, commands));
  handle('repos:settings', () => repos.settings());
  handle('repos:saveSettings', (patch) => repos.saveSettings(patch));
  handle('repos:addFolder', ({ dir }) => repos.addExtra(dir));
  handle('repos:clone', ({ url, parent }) => repos.clone(url, parent));
  handle('repos:runOptions', ({ dir }) => (repos.known(dir) ? repos.runOptions(dir) : { ok: false, error: 'Unknown repository.' }));

  // Understanding a repository
  handle('gh:preview', ({ link }) => github.preview(link));
  handle('gh:parse', ({ link }) => ({ ok: true, parsed: github.parse(link) }));
  handle('explain:local', ({ dir }) => {
    if (!repos.known(dir)) return { ok: false, error: 'Unknown repository.' };
    const info = explain.localInfo(dir);
    return { ok: true, info, facts: explain.facts(info), summary: explain.getSummary(`local:${dir.toLowerCase()}`) };
  });
  handle('explain:facts', ({ info }) => ({ ok: true, facts: explain.facts(info || {}) }));
  handle('explain:summary', ({ key }) => ({ ok: true, summary: explain.getSummary(String(key || '')) }));
  handle('explain:claude', async ({ key, link, dir }) => {
    let info;
    if (dir) { if (!repos.known(dir)) return { ok: false, error: 'Unknown repository.' }; info = explain.localInfo(dir); }
    else { info = await github.preview(link); if (!info.ok) return info; }
    const st = settings.read();
    const r = await explain.claudeSummary(info, explain.facts(info), { style: st.writeStyle, words: st.summaryLength });
    if (r.ok) explain.saveSummary(String(key), r.text);
    return r;
  });

  // Running
  handle('job:start', ({ dir, command }) => {
    if (!repos.known(dir)) return { ok: false, error: 'Unknown repository.' };
    return runner.start(dir, command, send);
  });
  handle('job:stop', ({ dir }) => runner.stop(dir));
  handle('job:running', () => ({ ok: true, jobs: runner.running() }));
  handle('term:open', ({ dir, command }) => {
    if (!repos.known(dir)) return { ok: false, error: 'Unknown repository.' };
    // Only the two fixed commands are allowed from the page: a plain shell or Claude.
    return runner.openTerminal(dir, command === 'claude' ? 'claude' : '');
  });

  // Try before install (Docker sandbox)
  handle('sandbox:status', () => sandbox.status());
  handle('sandbox:plan', async ({ link, dir }) => {
    let info;
    if (dir) { if (!repos.known(dir)) return { ok: false, error: 'Unknown repository.' }; info = explain.localInfo(dir); }
    else { info = await github.preview(link); if (!info.ok) return info; }
    return { ok: true, plan: sandbox.plan(info) };
  });
  handle('sandbox:start', ({ cloneUrl, repo, plan }) => {
    // Limits come from Settings, read here: the page cannot raise them.
    const st = settings.read();
    return sandbox.start({ cloneUrl, repo, plan, limits: { memoryGb: st.sandboxMemoryGb, cpus: st.sandboxCpus, ttlMinutes: st.sandboxTtlMinutes, readOnly: st.sandboxReadOnly } }, sendSandbox);
  });
  handle('sandbox:extend', ({ name, minutes }) => sandbox.extend(name, minutes, sendSandbox));
  handle('sandbox:saveLog', async ({ name }) => {
    const r = sandbox.getLog(name);
    if (!r.ok) return r;
    const out = await dialog.showSaveDialog(win, { title: 'Save sandbox log', defaultPath: path.join(app.getPath('downloads'), `${name}.log`) });
    if (out.canceled || !out.filePath) return { ok: false, canceled: true };
    fs.writeFileSync(out.filePath, r.text);
    return { ok: true, path: out.filePath };
  });
  handle('explain:failure', async ({ name, link, dir }) => {
    const lg = sandbox.getLog(name);
    if (!lg.ok) return lg;
    let info;
    if (dir) { if (!repos.known(dir)) return { ok: false, error: 'Unknown repository.' }; info = explain.localInfo(dir); }
    else { info = await github.preview(link); if (!info.ok) return info; }
    const att = await sandbox.attach(name, sendSandbox);
    const st = settings.read();
    return explain.claudeFailure(info, explain.facts(info), lg.text, att && att.plan, { style: st.writeStyle, words: st.summaryLength });
  });
  handle('sandbox:list', () => sandbox.list());
  handle('sandbox:attach', ({ name }) => sandbox.attach(name, sendSandbox));
  handle('sandbox:remove', ({ name }) => sandbox.remove(name));
  handle('sandbox:removeAll', () => sandbox.removeAll());
  handle('sandbox:shell', async ({ name }) => {
    if (!(await sandbox.owned(name))) return { ok: false, error: 'This container is not a RepoHub sandbox.' };
    const cmd = sandbox.shellCommand(name);
    if (!cmd) return { ok: false, error: 'Not a RepoHub sandbox.' };
    return runner.openTerminal(app.getPath('home'), cmd);
  });
  handle('sandbox:preview', ({ url, title }) => openPreview(url, title));
  handle('sandbox:openBrowser', async ({ url }) => {
    if (!sandbox.previewAllowed(url)) return { ok: false, error: 'Only a running RepoHub sandbox can be opened.' };
    if (!/^http:\/\/127\.0\.0\.1:\d{2,5}\/?$/.test(String(url || ''))) return { ok: false, error: 'Only a sandbox address opens from here.' };
    await shell.openExternal(url);
    return { ok: true };
  });

  // GitHub login through the GitHub CLI
  handle('auth:status', () => auth.status(github.doFetch));
  handle('auth:signIn', () => auth.signIn(github.doFetch));
  handle('auth:signOut', () => auth.signOut());
  handle('auth:openCliLogin', () => runner.openTerminal(app.getPath('home'), 'gh auth login --hostname github.com --git-protocol https --web'));

  // Insights and files
  handle('insights:get', ({ link, force }) => insights.insights(link, { force: !!force }));
  handle('files:refs', ({ link }) => { const p = github.parse(link); return p ? github.refs(p.owner, p.repo) : { ok: false, error: 'Not a GitHub link.' }; });
  handle('files:tree', ({ link, ref }) => { const p = github.parse(link); return p ? github.tree(p.owner, p.repo, String(ref || 'HEAD')) : { ok: false, error: 'Not a GitHub link.' }; });
  handle('files:file', ({ link, ref, path: p2 }) => { const p = github.parse(link); return p ? github.file(p.owner, p.repo, String(ref || 'HEAD'), String(p2 || '')) : { ok: false, error: 'Not a GitHub link.' }; });
  handle('files:localTree', ({ dir }) => repos.localTree(dir));
  handle('files:localFile', ({ dir, path: p2 }) => repos.localFile(dir, p2));
  handle('files:save', async ({ name, text }) => {
    const r = await dialog.showSaveDialog(win, { title: 'Save file', defaultPath: path.join(app.getPath('downloads'), path.basename(String(name || 'file.txt'))) });
    if (r.canceled || !r.filePath) return { ok: false, canceled: true };
    fs.writeFileSync(r.filePath, String(text == null ? '' : text));
    return { ok: true, path: r.filePath };
  });

  // Saved repositories
  handle('saved:all', () => saved.all());
  handle('saved:save', ({ full, ...rest }) => saved.save(full, rest));
  handle('saved:unsave', ({ full }) => saved.unsave(full));
  handle('saved:createCollection', ({ name }) => saved.createCollection(name));
  handle('saved:renameCollection', ({ id, name }) => saved.renameCollection(id, name));
  handle('saved:deleteCollection', ({ id }) => saved.deleteCollection(id));
  handle('saved:visit', ({ full, snap }) => saved.visit(full, snap));
  handle('saved:clearHistory', () => saved.clearHistory());
  handle('saved:export', async ({ format, collectionId }) => {
    const fmt = format === 'json' ? 'json' : 'csv';
    const r = await dialog.showSaveDialog(win, { title: 'Export saved repositories', defaultPath: path.join(app.getPath('documents'), `repohub-saved.${fmt}`), filters: [{ name: fmt.toUpperCase(), extensions: [fmt] }] });
    if (r.canceled || !r.filePath) return { ok: false, canceled: true };
    fs.writeFileSync(r.filePath, saved.exportText(fmt, collectionId));
    return { ok: true, path: r.filePath };
  });

  // Settings
  handle('settings:get', () => ({ ok: true, settings: settings.read(), defaults: settings.defaults(), file: settings.file() }));
  handle('settings:set', ({ patch }) => { const r = settings.write(patch); applyTheme(); broadcastSettings(r.settings); return r; });
  handle('settings:reset', ({ keys }) => { const r = settings.reset(keys); applyTheme(); broadcastSettings(r.settings); return r; });
  handle('settings:popout', () => openSettingsWindow());
  handle('settings:closePopout', () => { if (settingsWin && !settingsWin.isDestroyed()) settingsWin.close(); return { ok: true }; });
  handle('settings:clearData', ({ what }) => {
    const ud = app.getPath('userData');
    const files = { cache: ['insights.json'], summaries: ['summaries.json'], history: [] }[what];
    if (!files) return { ok: false, error: 'Unknown item.' };
    for (const f of files) { try { fs.unlinkSync(path.join(ud, f)); } catch { /* absent */ } }
    if (what === 'history') saved.clearHistory();
    return { ok: true };
  });

  // Installers and agent sign-in
  handle('installers:check', () => installers.check());
  handle('installers:install', async ({ ids }) => {
    const list = (Array.isArray(ids) ? ids : []).filter((id) => installers.CATALOG.some((t) => t.id === id));
    if (!list.length) return { ok: false, error: 'Nothing chosen to install.' };
    const npmAvailable = !!(await probe('npm', ['--version']));
    const needsNpm = list.filter((id) => { const t = installers.CATALOG.find((x) => x.id === id); return t.npm && !(process.platform === 'win32' && t.winget); });
    if (needsNpm.length && !npmAvailable && !list.includes('node')) return { ok: false, error: 'These install with npm, which comes with Node.js: install Node.js first (or tick it too), then try again.' };
    const file = installers.script(list, { npmAvailable });
    return file ? runner.openScript(file) : { ok: false, error: 'Nothing to install.' };
  });
  handle('installers:signIn', ({ id }) => {
    const s2 = installers.SIGN_IN[id];
    if (!s2) return { ok: false, error: 'No sign-in for that tool.' };
    return runner.openTerminal(app.getPath('home'), s2.command);
  });

  // Window and app
  handle('app:reload', () => { if (win && !win.isDestroyed()) win.webContents.reload(); return { ok: true }; });
  handle('app:relaunch', () => { relaunch(); return { ok: true }; });
  handle('app:devtools', () => { if (win && !win.isDestroyed()) win.webContents.toggleDevTools(); return { ok: true }; });

  // Opening things
  handle('open:folder', async ({ dir }) => {
    if (!repos.known(dir)) return { ok: false, error: 'Unknown repository.' };
    const e = await shell.openPath(dir);
    return e ? { ok: false, error: e } : { ok: true };
  });
  handle('open:web', async ({ url }) => {
    if (!/^https:\/\/(github\.com|gitlab\.com|bitbucket\.org|www\.docker\.com|cli\.github\.com)\//i.test(String(url || ''))) return { ok: false, error: 'Only GitHub, GitLab, Bitbucket, Docker and GitHub CLI links open from here.' };
    await shell.openExternal(url);
    return { ok: true };
  });
  handle('open:editor', ({ dir }) => {
    if (!repos.known(dir)) return { ok: false, error: 'Unknown repository.' };
    const { spawn } = require('child_process');
    const win32 = process.platform === 'win32';
    return new Promise((resolve) => {
      try {
        const child = spawnTool('code', [dir], { cwd: require('os').tmpdir(), env: toolEnv(), detached: true, stdio: 'ignore', windowsHide: true });
        child.on('error', () => resolve({ ok: false, error: 'VS Code was not found. Install it with "Add to PATH" ticked.' }));
        child.unref();
        setTimeout(() => resolve({ ok: true }), 400);
      } catch (e) { resolve({ ok: false, error: String(e && e.message || e) }); }
    });
  });
  ipcMain.handle('dialog:pickFolder', async (_e, { title, defaultPath } = {}) => {
    const r = await dialog.showOpenDialog(win, { title: title || 'Choose a folder', defaultPath, properties: ['openDirectory', 'createDirectory'] });
    return r.canceled || !r.filePaths[0] ? { ok: false } : { ok: true, path: r.filePaths[0] };
  });

  // Tools on this computer
  handle('tools:check', async () => {
    const list = [
      ['git', 'git'], ['node', 'node'], ['npm', 'npm'], ['pnpm', 'pnpm'], ['yarn', 'yarn'],
      ['python', 'python'], ['uv', 'uv'], ['docker', 'docker'], ['cargo', 'cargo'], ['go', 'go', ['version']],
      ['claude', 'claude'], ['code', 'code'],
    ];
    const out = {};
    await Promise.all(list.map(async ([id, bin, args]) => { out[id] = await probe(bin, args || ['--version']); }));
    return { ok: true, tools: out };
  });
  handle('tools:identity', async () => {
    const [n, e] = await Promise.all([git(['config', '--global', 'user.name']), git(['config', '--global', 'user.email'])]);
    return { ok: true, name: n.code === 0 ? n.out : '', email: e.code === 0 ? e.out : '' };
  });
  handle('tools:setIdentity', async ({ name, email }) => {
    const nm = String(name || '').trim(), em = String(email || '').trim();
    if (!nm || !/^[^\s@]+@[^\s@]+$/.test(em)) return { ok: false, error: 'Enter your name and a valid email (GitHub shows it on your commits).' };
    const a = await git(['config', '--global', 'user.name', nm]);
    const b = await git(['config', '--global', 'user.email', em]);
    return a.code === 0 && b.code === 0 ? { ok: true } : { ok: false, error: firstLine(a.code ? a : b) };
  });
  handle('app:defaultCloneDir', () => {
    const cfg = repos.readConfig();
    const d = cfg.cloneDir && fs.existsSync(cfg.cloneDir) ? cfg.cloneDir : path.join(app.getPath('home'), 'Repos');
    return { ok: true, path: d, exists: fs.existsSync(d) };
  });
  handle('app:setCloneDir', ({ dir }) => {
    if (!dir) return { ok: false };
    fs.mkdirSync(dir, { recursive: true });
    repos.writeConfig({ cloneDir: dir });
    return { ok: true, path: dir };
  });
  handle('app:version', () => ({ ok: true, version: app.getVersion() }));
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  applyTheme();
  registerIpc();
  createWindow();
  sandbox.restore(sendSandbox).catch((e) => console.error('Sandbox recovery failed:', e.message));
  // Sign in quietly if the GitHub CLI login was turned on before.
  auth.restore(github.doFetch).then((r) => { if (win && !win.isDestroyed()) win.webContents.send('auth:changed', r); }).catch(() => {});
});
let quitting = false;
app.on('before-quit', (e) => {
  if (quitting) return;
  e.preventDefault(); quitting = true; runner.stopAll();
  sandbox.shutdown().then((r) => {
    if (!r.ok) dialog.showMessageBoxSync({ type: 'warning', title: 'Sandbox cleanup needs attention', message: 'Docker could not remove every active sandbox. Reopen RepoHub with Docker running to retry saved deadlines.', detail: r.failed.join('\n') });
  }).catch((error) => console.error('Sandbox cleanup failed:', error.message)).finally(() => app.quit());
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
