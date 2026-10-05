/* Checks for the parts of RepoHub that do real work, without opening the app:
   git status and actions on throwaway repositories, link parsing, and the
   facts read from files. Run with: npm run check   (needs git on PATH)

   Everything happens in a temporary folder that is deleted at the end. */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');

const T = fs.mkdtempSync(path.join(os.tmpdir(), 'repohub-check-'));
process.env.REPOHUB_CONFIG = path.join(T, 'config.json');
process.env.REPOHUB_SUMMARIES = path.join(T, 'summaries.json');
process.env.REPOHUB_SAVED = path.join(T, 'saved.json');
process.env.REPOHUB_INSIGHTS = path.join(T, 'insights.json');
process.env.REPOHUB_SETTINGS = path.join(T, 'settings.json');
const R = require('../repos');
const gh = require('../github');
const ex = require('../explain');
const sb = require('../sandbox');
const ins = require('../insights');
const saved = require('../collections');
const settings = require('../settings');
const installers = require('../installers');
const tooling = require('../tooling');

let failed = 0;
const ok = (cond, msg) => { console.log(`${cond ? 'PASS' : 'FAIL'} ${msg}`); if (!cond) failed += 1; };
const sh = (cmd, cwd) => execSync(cmd, { cwd, stdio: 'pipe', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t.t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t.t' } }).toString();
const w = (p, s) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s); };

(async () => {
  try {
    // ---------- setup ----------
    const SCAN = path.join(T, 'scan');
    sh(`git init -q --bare -b main remote.git`, T);
    sh(`git clone -q remote.git scan/alpha`, T);
    const A = path.join(SCAN, 'alpha');
    sh('git config user.name t && git config user.email t@t.t', A);
    w(path.join(A, 'package.json'), JSON.stringify({ name: 'a', scripts: { start: 'node x', build: 'tsc', postinstall: 'node setup.js', 'bad name': 'x' } }));
    sh('git add . && git commit -qm init && git push -q -u origin HEAD:main', A);
    sh('git branch -M main && git branch -u origin/main', A);
    sh(`git clone -q remote.git other`, T);
    const O = path.join(T, 'other');
    sh('git config user.name t && git config user.email t@t.t', O);
    const B = path.join(SCAN, 'nested', 'deep', 'beta');
    fs.mkdirSync(B, { recursive: true });
    sh('git init -q && git config user.name t && git config user.email t@t.t', B);
    w(path.join(B, 'f'), 'x'); sh('git add . && git commit -qm one', B);
    fs.mkdirSync(path.join(SCAN, 'empty', '.git'), { recursive: true });
    fs.mkdirSync(path.join(SCAN, 'node_modules', 'pkg'), { recursive: true }); sh('git init -q', path.join(SCAN, 'node_modules', 'pkg'));
    fs.mkdirSync(path.join(SCAN, 'grafsnas-main'), { recursive: true }); sh('git init -q', path.join(SCAN, 'grafsnas-main'));

    // ---------- library ----------
    R.saveSettings({ roots: [SCAN], depth: 4 });
    const s = await R.scan();
    const names = s.repos.map((r) => r.name).sort().join(',');
    ok(names === 'alpha,beta,grafsnas-main', `scan finds real repos, skips empty .git and node_modules (${names})`);
    ok(s.repos.find((r) => r.name === 'grafsnas-main').hidden, 'grafsnas hidden by default');

    let st = await R.status(A);
    ok(st.ok && st.changed === 0 && st.ahead === 0 && /remote\.git$/.test(st.remote), 'clean status');
    ok(!fs.existsSync(path.join(A, '.git', 'index.lock')), 'reading status leaves no lock file');
    w(path.join(A, 'new.txt'), 'hello'); fs.appendFileSync(path.join(A, 'package.json'), '\n');
    st = await R.status(A);
    ok(st.changed === 2, 'counts new and changed files');
    ok((await R.diff(A, 'new.txt')).text.includes('hello'), 'shows a new file');
    ok(!(await R.diff(A, '../other/x')).ok, 'refuses files outside the repository');
    ok(/uncommitted/.test((await R.pull(A)).error || ''), 'pull refuses over uncommitted work');
    let c = await R.commit(A, 'my message');
    ok(c.ok && /Committed 2 files/.test(c.steps[0]), 'commit');
    ok((await R.status(A)).ahead === 1, 'one commit to push');
    ok((await R.push(A)).steps[0] === 'Pushed to GitHub', 'push');

    sh('git pull -q && echo b > b.txt && git add . && git commit -qm other && git push -q', O);
    ok((await R.fetch(A)).ok, 'fetch');
    ok((await R.status(A)).behind === 1, 'one new commit on the remote');
    ok(/Pulled/.test((await R.pull(A)).steps[0]), 'pull');

    sh('git pull -q && echo theirs > new.txt && git commit -qam theirs && git push -q', O);
    w(path.join(A, 'new.txt'), 'mine');
    const sy = await R.syncRepo(A, '');
    ok(!sy.ok && /same lines/.test(sy.error), 'conflicting sync is explained');
    ok(!fs.existsSync(path.join(A, '.git', 'rebase-merge')) && !fs.existsSync(path.join(A, '.git', 'rebase-apply')), 'conflicting sync is undone');
    sh('git reset -q --hard origin/main', A);
    w(path.join(A, 'c.txt'), 'c');
    const sy2 = await R.syncRepo(A, '');
    ok(sy2.ok && sy2.steps.join('|').includes('Pushed'), `sync (${sy2.steps})`);

    w(path.join(A, '.git', 'index.lock'), '');
    ok(/index.lock/.test((await R.commit(A, 'x')).error || ''), 'actions wait for a lock file');
    ok(R.clearLock(A).ok && !fs.existsSync(path.join(A, '.git', 'index.lock')), 'empty lock cleared');
    ok(/not in the repository list/.test((await R.commit(O, 'x')).error || ''), 'refuses repositories outside the list');
    ok(/no GitHub address/.test((await R.push(B)).error || ''), 'push without a remote is explained');
    ok(!(await R.setRemote(B, 'https://u:token@github.com/a/b')).ok, 'remote with a token in it is refused');

    const ro = R.runOptions(A).options.map((o) => o.command).join('|');
    ok(ro === 'npm install|npm start|npm run build|npm run postinstall', `run options (${ro})`);

    // Bulk updates on disposable repositories only.
    ok((await R.updateOne(B)).state === 'skipped', 'Update all explains a missing remote');
    sh('git pull -q && echo update > bulk.txt && git add . && git commit -qm bulk && git push -q', O);
    w(path.join(A, 'keep.txt'), 'uncommitted work');
    const dirtyUpdate = await R.updateOne(A);
    ok(dirtyUpdate.state === 'skipped' && /uncommitted/.test(dirtyUpdate.note) && fs.readFileSync(path.join(A, 'keep.txt'), 'utf8') === 'uncommitted work', 'Update all fetches and preserves dirty files');
    fs.unlinkSync(path.join(A, 'keep.txt'));
    ok((await R.updateOne(A)).state === 'updated' && fs.existsSync(path.join(A, 'bulk.txt')), 'Update all fast-forwards a clean behind repository');
    ok((await R.updateOne(A)).state === 'current', 'Update all reports an already current repository');
    w(path.join(A, 'local-only.txt'), 'local'); sh('git add . && git commit -qm local-only', A);
    sh('echo remote > remote-only.txt && git add . && git commit -qm remote-only && git push -q', O);
    const oldHead = sh('git rev-parse HEAD', A).trim();
    const divergent = await R.updateOne(A);
    ok(divergent.state === 'skipped' && /Diverged/.test(divergent.note) && sh('git rev-parse HEAD', A).trim() === oldHead, 'Update all preserves divergent local history');
    sh('git remote set-url origin "' + path.join(T, 'missing-remote.git') + '"', A);
    ok((await R.updateOne(A)).state === 'failed', 'Update all reports an unavailable remote');

    // ---------- link parsing ----------
    const p1 = gh.parse('https://github.com/calesthio/OpenMontage/tree/main/src');
    ok(p1 && p1.full === 'calesthio/OpenMontage', 'parses a deep GitHub link');
    ok(gh.parse('git@github.com:owner/repo.git').full === 'owner/repo', 'parses an SSH address');
    ok(gh.parse('owner/repo').full === 'owner/repo', 'parses owner/repo');
    ok(gh.parse('https://gitlab.com/a/b') === null && gh.parse('https://github.com/a/..') === null, 'rejects other hosts and bad names');

    // ---------- facts ----------
    const f = ex.facts(ex.localInfo(A));
    ok(f.kinds.includes('Node.js project'), `kind (${f.kinds})`);
    ok(f.cautions.some((x) => /postinstall/.test(x)), 'warns about install scripts');
    ok(f.plan[0].command === 'npm install' && f.plan.some((x) => x.command === 'npm start'), 'install plan');
    const py = ex.facts({ name: 'p', source: 'github', files: [{ name: 'requirements.txt' }, { name: 'app.py' }, { name: '.env.example' }], setup: { 'requirements.txt': 'streamlit\n', '.env.example': 'OPENAI_API_KEY=\n# c\nDEBUG=1' }, readme: 'Install: curl -fsSL https://x.sh | bash', license: '', pushedAt: '2020-01-01' });
    ok(py.kinds.includes('Python web app'), 'python web app');
    ok(py.envKeys.join() === 'OPENAI_API_KEY,DEBUG', 'reads .env.example names only');
    ok(py.cautions.some((x) => /piping/.test(x)) && py.cautions.some((x) => /no license/.test(x)) && py.cautions.some((x) => /over a year/.test(x)), 'cautions: pipe to shell, no license, stale');
    ok(ex.contextText({ name: 'x', files: [], setup: {}, readme: 'Hello' }, py).includes('--- README ---'), 'Claude context built');

    // ---------- sandbox plans ----------
    const F = (...n) => n.map((name) => ({ name, type: 'file' }));
    let pl = sb.plan({ files: F('package.json'), setup: { 'package.json': JSON.stringify({ scripts: { dev: 'vite' }, devDependencies: { vite: '5' } }) } });
    ok(pl.image === 'node:22' && pl.install === 'npm install' && /--host 0\.0\.0\.0/.test(pl.start) && pl.port === 5173, `vite plan (${pl.start})`);
    pl = sb.plan({ files: F('package.json', 'pnpm-lock.yaml'), setup: { 'package.json': JSON.stringify({ scripts: { dev: 'next dev' }, dependencies: { next: '15' } }) } });
    ok(/corepack enable && pnpm install/.test(pl.install) && /-H 0\.0\.0\.0/.test(pl.start) && pl.port === 3000, `next + pnpm plan (${pl.install} / ${pl.start})`);
    pl = sb.plan({ files: F('requirements.txt', 'app.py', '.env.example'), setup: { 'requirements.txt': 'streamlit\n', '.env.example': 'KEY=' } });
    ok(pl.image === 'python:3.12' && /streamlit run app\.py --server\.address 0\.0\.0\.0/.test(pl.start) && pl.port === 8501 && pl.notes.some((n) => /\.env/.test(n)), 'streamlit plan with settings note');
    pl = sb.plan({ files: F('index.html', 'style.css'), setup: {} });
    ok(/http\.server 8000/.test(pl.start), 'static site plan');
    pl = sb.plan({ files: F('Dockerfile', 'go.mod'), setup: {} });
    ok(pl.mode === 'dockerfile', 'Dockerfile-only repo uses its Dockerfile');
    pl = sb.plan({ files: F('package.json'), setup: { 'package.json': JSON.stringify({ devDependencies: { electron: '1' } }) } });
    ok(!pl.start && pl.notes.some((n) => /Electron/.test(n)), 'Electron app explained, no start');
    ok(sb.cleanUrl('https://github.com/a/b.git') && !sb.cleanUrl('https://u:t@github.com/a/b') && !sb.cleanUrl('https://github.com/a/b;rm -rf') && !sb.cleanUrl('file:///etc'), 'sandbox address checks');
    ok(sb.validName('repohub-try-openmontage-ab12') && !sb.validName('postgres') && !sb.validName('repohub-try-x;rm'), 'only RepoHub sandboxes can be touched');
    ok(!/;/.test(sb.shellCommand('repohub-try-x-ab12')) && sb.shellCommand('other') === '', 'shell command safe for Windows Terminal');

    // ---------- local files ----------
    const lt = await R.localTree(A);
    ok(lt.ok && lt.items.some((x) => x.path === 'package.json') && lt.items.some((x) => x.path === 'c.txt'), 'local file list');
    ok((await R.localFile(A, 'package.json')).text.includes('"start"'), 'local file read');
    ok(!(await R.localFile(A, '../other/b.txt')).ok, 'local file outside the repository refused');
    w(path.join(A, 'bin.dat'), Buffer.from([0, 1, 2, 3]));
    ok((await R.localFile(A, 'bin.dat')).binary, 'binary file detected');

    // ---------- health score ----------
    const today = new Date().toISOString().slice(0, 10);
    const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
    const good = ins.score(
      { pushedAt: today, license: 'MIT', readme: 'x'.repeat(5000), homepage: 'https://x', archived: false, files: [{ name: 'tests', type: 'dir' }, { name: 'SECURITY.md', type: 'file' }, { name: 'CHANGELOG.md', type: 'file' }], setup: {} },
      { activity: Array.from({ length: 52 }, () => ({ total: 5 })), releases: [{ tag: 'v2', date: daysAgo(20), prerelease: false }], contributors: [{ commits: 30 }, { commits: 25 }, { commits: 20 }, { commits: 15 }, { commits: 10 }], contributorCount: 80, opened90: 40, closed90: 38, medianCloseDays: 3, workflows: 3, community: { contributing: true }, merged90: 50 },
      { cautions: [] });
    ok(good.total >= 90 && good.grade === 'Strong' && good.maintained.level === 'ok', `strong repository scores high (${good.total}, ${good.maintained.verdict})`);
    const dead = ins.score(
      { pushedAt: daysAgo(900), license: '', readme: 'hi', archived: false, files: [], setup: {} },
      { activity: Array.from({ length: 52 }, () => ({ total: 0 })), releases: [], contributors: [{ commits: 100 }], contributorCount: 1, opened90: 10, closed90: 0, medianCloseDays: null, workflows: 0, community: null, merged90: 0 },
      { cautions: ['runs its own scripts during install (postinstall); install only if you trust it'] });
    ok(dead.total < 25 && dead.grade === 'Weak' && dead.maintained.verdict === 'Inactive' && dead.maintained.reasons.some((r) => /one main person/.test(r)), `abandoned repository scores low (${dead.total})`);
    const arch = ins.score({ pushedAt: today, license: 'MIT', readme: 'x'.repeat(5000), archived: true, files: [], setup: {} }, { activity: [], releases: [], contributors: [], contributorCount: 5, opened90: 0, closed90: 0, workflows: 1, community: null }, { cautions: [] });
    ok(arch.total <= 39 && /Archived/.test(arch.maintained.verdict), 'archived repository is capped and flagged');
    ok(ins.busFactor([{ commits: 60 }, { commits: 30 }, { commits: 10 }]) === 1 && ins.busFactor([{ commits: 30 }, { commits: 30 }, { commits: 40 }]) === 2, 'bus factor');
    const sum = good.parts.reduce((a, p) => a + p.max, 0);
    ok(sum === 100 && good.parts.every((p) => p.points <= p.max), 'score parts add up to 100');

    // ---------- saved ----------
    ok(saved.save('calesthio/OpenMontage', { snap: { description: 'video', stars: 10, language: 'Python', license: 'AGPL-3.0', score: 81 } }).ok, 'save a repository');
    const col = saved.createCollection('Video tools');
    ok(col.ok && !saved.createCollection('video tools').ok, 'create collection, refuse duplicate');
    saved.save('calesthio/OpenMontage', { note: 'try, needs, "quotes"', tags: ['Video', 'video', 'AI'], collections: [col.collection.id, 'bogus'] });
    const b = saved.all().bookmarks[0];
    ok(b.tags.join() === 'video,ai' && b.collections.length === 1, 'tags cleaned, unknown collections dropped');
    ok(!saved.save('not a repo', {}).ok, 'refuses a bad name');
    const csv = saved.exportText('csv');
    ok(csv.split('\r\n')[1].includes('"try, needs, ""quotes"""') && csv.includes('Video tools'), 'CSV export quotes properly');
    ok(JSON.parse(saved.exportText('json', col.collection.id))[0].collections[0] === 'Video tools', 'JSON export by collection');
    saved.visit('a/b'); saved.visit('c/d'); saved.visit('a/b');
    ok(saved.all().history.map((x) => x.full).join() === 'a/b,c/d', 'recently viewed, newest first, no duplicates');
    saved.deleteCollection(col.collection.id);
    ok(saved.all().bookmarks[0].collections.length === 0, 'deleting a collection keeps the repositories');

    // ---------- v1.3: settings ----------
    ok(settings.read().colorTheme === 'indigo' && settings.read().textSize === 100, 'settings defaults');
    let sw = settings.write({ themeMode: 'day', textSize: 120, colorTheme: 'forest' });
    ok(sw.ok && settings.read().themeMode === 'day' && settings.read().textSize === 120, 'settings saved');
    sw = settings.write({ textSize: 999, themeMode: 'purple', uiFont: 'x; } body { display:none', bogus: 1 });
    ok(!sw.ok && sw.refused.sort().join() === 'bogus,textSize,themeMode,uiFont' && settings.read().textSize === 120, 'invalid settings refused by name, old values kept');
    settings.reset(['textSize']);
    ok(settings.read().textSize === 100 && settings.read().colorTheme === 'forest', 'reset one setting');

    // ---------- v1.3: installers ----------
    const ids = installers.CATALOG.map((t) => t.id);
    ok(['node', 'pnpm', 'yarn', 'python', 'uv', 'docker', 'cargo', 'go', 'claude', 'codex', 'gemini', 'copilot', 'gh'].every((x) => ids.includes(x)), 'catalog has every requested tool and agent');
    ok(installers.installCommand(installers.CATALOG.find((t) => t.id === 'codex'), true) === 'npm install --global @openai/codex', 'npm command for an agent');
    const scr = installers.script(['codex', 'npm', 'bogus'], { npmAvailable: true });
    const body = fs.readFileSync(scr, 'utf8');
    ok(body.includes('npm install --global @openai/codex') && !body.includes('bogus') && !/\[2\/2\]/.test(body), 'installer script: only catalog tools, npm is never installed on its own');
    ok(installers.script([], {}) === null, 'nothing chosen, no script');
    ok(Object.values(installers.SIGN_IN).every((x) => !/[;&|<>]/.test(x.command)), 'sign-in commands are fixed and plain');

    // ---------- v1.3: tool lookup safety ----------
    const env = tooling.toolEnv();
    ok(process.platform !== 'win32' || env.NoDefaultCurrentDirectoryInExePath === '1', 'Windows: no current-folder lookup');
    fs.writeFileSync(path.join(T, 'git.js'), 'throw new Error("must not run")');
    const v = await tooling.probe('git', ['--version']);
    ok(/git version/.test(v), 'probe finds the real git, not a git.js file');

    // ---------- v1.3: dev container recipe ----------
    const dcp = sb.plan({ files: F('package.json', '.devcontainer'), setup: { 'package.json': JSON.stringify({ scripts: { dev: 'vite' }, devDependencies: { vite: '5' } }), '.devcontainer/devcontainer.json': '{\n // comment\n "image": "mcr.microsoft.com/devcontainers/typescript-node:1-20-bullseye", /* block */\n "postCreateCommand": "npm ci",\n "forwardPorts": [5173,],\n "customizations": { "x": "https://example.com/a" }\n}' } });
    ok(dcp.image === 'mcr.microsoft.com/devcontainers/typescript-node:1-20-bullseye' && dcp.install === 'npm ci' && dcp.port === 5173 && dcp.source === 'devcontainer.json', `devcontainer recipe used (${dcp.image}, ${dcp.install})`);
    ok(dcp.framework === 'Vite' && dcp.language === 'JavaScript' && dcp.packageManager === 'npm', 'recipe fields');
    ok(sb.jsonc('{"a": "http://x//y", // c\n "b": [1,2,],}').a === 'http://x//y', 'comments stripped, addresses kept');
    const ex2 = require('../explain');
    ok(ex2.prompt({ style: 'technical', words: 400 }).includes('experienced developer') && ex2.prompt({ words: 9999 }).includes('under 600 words'), 'writing style and length in the prompt');
    ok(!ex2.prompt().includes('"'), 'prompt has no quotation marks (safe on Windows)');
  } catch (e) {
    failed += 1;
    console.log('FAIL unexpected error:', e && e.stack || e);
  } finally {
    try { fs.rmSync(T, { recursive: true, force: true }); } catch { /* temp */ }
    console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed');
    process.exitCode = failed ? 1 : 0;
  }
})();
