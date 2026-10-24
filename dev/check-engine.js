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
const cats = require('../categories');
const gitauth = require('../gitauth');
const aitools = require('../aitools');
const discover = require('../discover');

let failed = 0;
const ok = (cond, msg) => { console.log(`${cond ? 'PASS' : 'FAIL'} ${msg}`); if (!cond) failed += 1; };
const sh = (cmd, cwd) => execSync(cmd, { cwd, stdio: 'pipe', env: { ...process.env, NoDefaultCurrentDirectoryInExePath: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t.t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t.t' } }).toString();
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
    const pkgBefore = fs.readFileSync(path.join(A, 'package.json'), 'utf8');
    w(path.join(A, 'package.json'), pkgBefore + '\n');
    const dirtyUpdate = await R.updateOne(A);
    ok(dirtyUpdate.state === 'skipped' && /uncommitted/.test(dirtyUpdate.note) && fs.readFileSync(path.join(A, 'package.json'), 'utf8') === pkgBefore + '\n', 'Update all fetches and preserves edited tracked files');
    w(path.join(A, 'package.json'), pkgBefore);
    w(path.join(A, 'keep.txt'), 'uncommitted work');
    ok((await R.updateOne(A)).state === 'updated' && fs.existsSync(path.join(A, 'bulk.txt')) && fs.readFileSync(path.join(A, 'keep.txt'), 'utf8') === 'uncommitted work', 'Update all fast-forwards; a new untracked file does not block it and stays');
    fs.unlinkSync(path.join(A, 'keep.txt'));
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

    // ---------- v1.5: categories ----------
    const mk = (name, files) => { const d = path.join(T, 'cat-' + name); fs.mkdirSync(d, { recursive: true }); for (const [f, body] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true }); fs.writeFileSync(path.join(d, f), body); } return d; };
    const cases = [
      ['skill', { 'SKILL.md': '---\nname: x\n---' }, 'skills'],
      ['electron', { 'package.json': JSON.stringify({ devDependencies: { electron: '44' } }) }, 'desktop'],
      ['next', { 'package.json': JSON.stringify({ dependencies: { next: '15', react: '19' } }) }, 'web'],
      ['express', { 'package.json': JSON.stringify({ dependencies: { express: '5' } }) }, 'server'],
      ['mcp', { 'package.json': JSON.stringify({ dependencies: { '@modelcontextprotocol/sdk': '1' } }), 'README.md': 'An MCP server for things' }, 'mcp'],
      ['agent', { 'pyproject.toml': '[project]\ndependencies = ["anthropic>=0.40", "rich"]' }, 'agents'],
      ['cli', { 'package.json': JSON.stringify({ name: 'x', bin: { x: 'cli.js' } }) }, 'cli'],
      ['data', { 'requirements.txt': 'pandas==2.2\nmatplotlib' }, 'data'],
      ['notes', { 'README.md': '# notes', 'plan.docx': 'x' }, 'docs'],
      ['wp', { 'style.css': '/*\nTheme Name: Twenty\n*/' }, 'web'],
      ['video', { 'package.json': JSON.stringify({ dependencies: { remotion: '4' } }) }, 'media'],
    ];
    for (const [name, files, want] of cases) {
      const got = cats.classify(mk(name, files));
      ok(got.id === want && got.label && got.why, `category ${name} → ${got.id} (${got.why})`);
    }
    const dWeb = mk('override', { 'package.json': JSON.stringify({ dependencies: { react: '19' } }) });
    const fr = cats.forRepos([dWeb], { [dWeb.toUpperCase()]: 'docs' });
    ok(process.platform !== 'win32' || (fr[dWeb].id === 'docs' && fr[dWeb].mine), 'your own category wins (case-insensitive path on Windows)');
    ok(cats.forRepos([dWeb], { [dWeb]: 'bogus' })[dWeb].id === 'web', 'unknown chosen category falls back to the guess');
    const outside = path.join(T, 'outside-secret.txt'); fs.writeFileSync(outside, '{"dependencies":{"electron":"1"}}');
    const dLink = mk('link', {});
    let linked = false; try { fs.symlinkSync(outside, path.join(dLink, 'package.json')); linked = true; } catch { /* no symlink rights */ }
    ok(!linked || cats.classify(dLink).id !== 'desktop', 'a link pointing outside the repository is not read');
    ok(settings.write({ librarySort: 'category', sidebarWidth: 420, dockWidth: 520 }).ok && !settings.write({ librarySort: 'bogus' }).ok && !settings.write({ sidebarWidth: 50 }).ok, 'sort and separator settings validated');

    // ---------- v1.5: Git sign-in ----------
    ok(gitauth.helperName('manager').kind === 'gcm' && gitauth.helperName('manager-core').kind === 'gcm' && gitauth.helperName('').kind === 'none' && gitauth.helperName('!gh auth git-credential').kind === 'gh' && gitauth.helperName('store').kind === 'store', 'credential helpers named');
    ok(gitauth.ACCOUNT_RE.test('levanis-design') && !gitauth.ACCOUNT_RE.test('a b') && !gitauth.ACCOUNT_RE.test('x;rm') && !gitauth.ACCOUNT_RE.test('-x'), 'account names validated');
    ok(!(await gitauth.logout('bad name')).ok, 'logout refuses a bad account name');
    const gs = await gitauth.status();
    ok(gs.ok && /\d/.test(gs.git) && gs.helper && Array.isArray(gs.accounts), `git sign-in status reads (helper: ${gs.helper.label})`);
    // A fake helper proves the saved login is read without prompting, and never echoed.
    const fakeHome = path.join(T, 'fakehome'); fs.mkdirSync(fakeHome);
    const helper = path.join(T, 'fake-helper.sh');
    fs.writeFileSync(helper, '#!/bin/sh\nif [ "$1" = get ]; then echo username=octo; echo password=gho_abcdefghijklmnopqrstuvwxyz0123; fi\n'); fs.chmodSync(helper, 0o755);
    const oldHome = process.env.HOME, oldXdg = process.env.XDG_CONFIG_HOME, oldGcs = process.env.GIT_CONFIG_GLOBAL;
    if (process.platform !== 'win32') {
      fs.writeFileSync(path.join(fakeHome, '.gitconfig'), `[credential]\n\thelper = ${helper}\n`);
      process.env.GIT_CONFIG_GLOBAL = path.join(fakeHome, '.gitconfig');
      const tk = await gitauth.readToken();
      ok(tk.ok && tk.token === 'gho_abcdefghijklmnopqrstuvwxyz0123' && tk.username === 'octo', 'saved Git login read with prompts off');
      fs.writeFileSync(path.join(fakeHome, '.gitconfig'), '[credential]\n\thelper =\n');
      const t0 = Date.now(); const none = await gitauth.readToken();
      ok(!none.ok && none.notSignedIn && Date.now() - t0 < 10000, 'no saved login: fails fast, no prompt');
      process.env.GIT_CONFIG_GLOBAL = oldGcs === undefined ? '' : oldGcs; if (oldGcs === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    }
    void oldHome; void oldXdg;

    // ---------- v1.6: AI viewers and agent sign-ins ----------
    const al = aitools.links('https://github.com/QwenLM/qwen-code.git');
    ok(al.ok && al.full === 'QwenLM/qwen-code' && al.services.map((x) => x.url).join() === ['https://gitingest.com/QwenLM/qwen-code', 'https://gitdiagram.com/QwenLM/qwen-code', 'https://deepwiki.com/QwenLM/qwen-code', 'https://gitmcp.io/QwenLM/qwen-code'].join(), 'four AI viewer links built from a GitHub address');
    ok(aitools.links('mvanhorn/last30days-skill').ok, 'owner/repo accepted');
    for (const bad of ['https://evil.com/a/b', '../x', 'a/b/c', 'owner/repo"&calc', 'javascript:alert(1)/x', '']) ok(!aitools.links(bad).ok && aitools.url('deepwiki', bad) === '', `refused: ${JSON.stringify(bad)}`);
    ok(aitools.url('bogus', 'a/b') === '', 'unknown service refused');
    const mc = aitools.mcpCommand('QwenLM/qwen-code');
    ok(mc.text === 'claude mcp add --transport http --scope user gitmcp-qwen-code https://gitmcp.io/QwenLM/qwen-code' && mc.args.every((a) => !/["% !^&|<>]/.test(a)), 'GitMCP command is fixed and safe for Windows');
    const agents = installers.CATALOG.filter((t) => t.group === 'agent').map((t) => t.id);
    ok(['claude', 'codex', 'gemini', 'copilot', 'qwen', 'kimi', 'ollama', 'opencode', 'kilo', 'cline', 'droid', 'vibe'].every((id) => agents.includes(id)), `agents in the catalog: ${agents.join(', ')}`);
    ok(agents.every((id) => installers.SIGN_IN[id]), 'every agent has a sign-in command');
    ok(Object.values(installers.SIGN_IN).every((x) => /^[a-z0-9 .\-]+$/i.test(x.command)) && Object.values(installers.SIGN_OUT).every((c) => /^[a-z0-9 .\-]+$/i.test(c)), 'sign-in and sign-out commands are plain fixed text');
    ok(installers.installCommand(installers.CATALOG.find((t) => t.id === 'vibe')) === 'uv tool install mistral-vibe' && installers.installCommand(installers.CATALOG.find((t) => t.id === 'kimi')) === 'npm install --global @moonshot-ai/kimi-code', 'uv and npm install commands');
    ok(process.platform !== 'win32' || installers.installCommand(installers.CATALOG.find((t) => t.id === 'ollama')) === 'winget install --id Ollama.Ollama --exact --source winget', 'Ollama through winget on Windows');
    ok(installers.PROVIDERS.every((p) => /^https:\/\/(platform\.deepseek\.com|console\.perplexity\.ai|console\.x\.ai)\//.test(p.keyUrl) && p.via.every((v) => installers.CATALOG.some((t) => t.id === v))), 'provider key pages are fixed official addresses');
    const vs = installers.script(['vibe'], { npmAvailable: true });
    ok(fs.readFileSync(vs, 'utf8').includes('uv tool install mistral-vibe'), 'installer script runs uv for Mistral Vibe');
    const chk = await installers.check();
    ok(chk.providers.length === 3 && chk.tools.find((t) => t.id === 'ollama').signOut && chk.tools.find((t) => t.id === 'qwen').signIn.command === 'qwen', 'check() reports sign-in, sign-out and providers');

    // ---------- v1.7: search history and favorites ----------
    saved.clearHistory();
    ok(saved.visit('calesthio/OpenMontage', { description: 'Open video production system', stars: 63182, language: 'Python' }, 'https://github.com/calesthio/OpenMontage').ok, 'search recorded');
    saved.visit('ollama/ollama', { description: 'Run models' }, 'ollama/ollama');
    saved.visit('calesthio/OpenMontage', {}, 'openmontage');
    let hist = saved.all().history;
    ok(hist.length === 2 && hist[0].full === 'calesthio/OpenMontage' && hist[0].count === 2 && hist[0].stars === 63182 && hist[0].description === 'Open video production system' && hist[0].query === 'openmontage', 'repeat search moves to the top, counts, keeps details');
    ok(!saved.visit('not a repo', {}, 'x').ok && !saved.visit('../../etc', {}).ok, 'bad names are not recorded');
    ok(saved.forget('OLLAMA/ollama').removed === 1 && saved.all().history.length === 1, 'one entry removed (case-insensitive)');
    for (let i = 0; i < saved.HISTORY_MAX + 15; i++) saved.visit(`owner${i}/repo${i}`, {});
    ok(saved.all().history.length === saved.HISTORY_MAX, `history capped at ${saved.HISTORY_MAX}`);
    ok(saved.clearHistory().ok && saved.all().history.length === 0, 'history cleared');
    ok(saved.save('calesthio/OpenMontage', {}).ok && saved.all().bookmarks.length >= 1 && saved.unsave('calesthio/OpenMontage').ok, 'GitHub favorite added and removed');
    const favDir = R.cached().repos[0];
    if (favDir) {
      ok(R.setFavorite(favDir.path, true).ok && R.cached().repos.find((x) => x.path === favDir.path).favorite === true, 'local repository starred and reported');
      ok(R.setFavorite(favDir.path, false).ok, 'unstar works');
      ok(R.cached().repos.find((x) => x.path === favDir.path).favorite === false, 'local repository unstarred');
    } else ok(false, 'no repository in the cached list to star');
    ok(!R.setFavorite(path.join(T, 'not-a-repo'), true).ok, 'unknown folder cannot be starred');
    ok(settings.write({ favoritesFirst: false, keepHistory: false }).ok && !settings.write({ keepHistory: 'yes' }).ok, 'favorites and history settings validated');
    settings.write({ favoritesFirst: true, keepHistory: true });

    // ---------- v1.8: most starred ----------
    const now = Date.parse('2026-10-23T12:00:00Z');
    ok(discover.buildQuery({}, now).q === 'stars:>=1000 archived:false', 'all time: stars of at least 1,000, archived hidden');
    ok(discover.buildQuery({ period: 'week', language: 'Python', topic: 'AI Agents' }, now).q === 'stars:>=10 created:>=2026-10-16 language:Python topic:ai-agents archived:false', 'new this week, language and topic');
    ok(discover.buildQuery({ language: 'Jupyter Notebook', hideArchived: false }, now).q === 'stars:>=1000 language:"Jupyter Notebook"', 'language with a space is quoted');
    ok(discover.buildQuery({ text: 'video editor stars:>1 user:x "q"' }, now).q === 'video editor stars 1 user x q stars:>=1000 archived:false', 'keywords cannot add their own search rules');
    ok(!discover.buildQuery({ period: 'decade' }).ok && !discover.buildQuery({ topic: 'bad topic!' }).ok && !discover.buildQuery({ language: 'x"y' }).ok, 'bad period, topic and language refused');
    const github2 = require('../github');
    const realFetch = github2.doFetch;
    let asked = '';
    github2.doFetch = async (u) => { asked = u; return { ok: true, status: 200, headers: new Map([['x-ratelimit-remaining', '9']]), json: async () => ({ total_count: 4200000, incomplete_results: false, items: [{ full_name: 'a/b', owner: { login: 'a', avatar_url: 'https://avatars.githubusercontent.com/u/1?v=4' }, description: 'd', stargazers_count: 500000, forks_count: 9, language: 'TypeScript', license: { spdx_id: 'MIT' }, topics: ['x'], created_at: '2020-01-01T00:00:00Z', pushed_at: '2026-10-22T00:00:00Z', archived: false }] }) }; };
    const sr = await discover.search({ language: 'TypeScript' }, 1);
    ok(sr.ok && sr.total === 1000 && sr.totalFound === 4200000 && sr.hasMore && sr.items[0].full === 'a/b' && sr.items[0].avatar.endsWith('&s=64') && sr.items[0].license === 'MIT', 'results shaped; total capped at 1,000');
    ok(/sort=stars&order=desc&per_page=30&page=1$/.test(asked) && asked.includes(encodeURIComponent('language:TypeScript')), 'asks GitHub to sort by stars');
    asked = '';
    const again = await discover.search({ language: 'TypeScript' }, 1);
    ok(again.cached && asked === '', 'same page comes from the 30-minute cache');
    github2.doFetch = async () => ({ ok: false, status: 403, headers: new Map([['x-ratelimit-reset', String(Math.round(Date.now() / 1000) + 40)]]) });
    const lim = await discover.search({ language: 'Go' }, 1);
    ok(!lim.ok && lim.limited && /searches a minute/.test(lim.error) && lim.retryIn >= 5, 'search limit explained with a wait time');
    const p99 = await discover.search({ language: 'Rust' }, 999);
    ok(!p99.ok || p99.page <= 34, 'page number kept within GitHub\'s 1,000 results');
    github2.doFetch = realFetch;

    // ---------- v1.9: blocked updates ----------
    sh('git init -q --bare -b main remote2.git', T);
    sh('git clone -q remote2.git gamma', T);
    const G = path.join(T, 'gamma');
    sh('git config user.name t && git config user.email t@t.t && git config core.autocrlf false', G);
    w(path.join(G, 'README.md'), 'one\ntwo\nthree\n'); w(path.join(G, 'package-lock.json'), '{"a":1}\n'); w(path.join(G, 'app.js'), 'x = 1\n'); w(path.join(G, '.gitignore'), 'node_modules\n');
    sh('git add . && git commit -qm init && git push -q -u origin main', G);
    ok(R.addExtra(G).ok, 'test repository added');
    sh('git clone -q remote2.git gamma-other', T);
    const G2 = path.join(T, 'gamma-other');
    sh('git config user.name t && git config user.email t@t.t && echo news > news.txt && git add . && git commit -qm news && git push -q', G2);
    // the three kinds of change an install or Windows makes, plus a real edit and a .env
    w(path.join(G, 'README.md'), 'one\r\ntwo\r\nthree\r\n');
    w(path.join(G, 'package-lock.json'), '{"a":2}\n');
    w(path.join(G, 'postcss.config.mjs'), 'export default {}\n');
    w(path.join(G, '.env'), 'SECRET=keep-me\n');
    const ch = await R.changes(G);
    ok(ch.ok && ch.lineEndingsOnly.join() === 'README.md' && ch.lockfiles.join() === 'package-lock.json' && ch.untracked.includes('postcss.config.mjs') && ch.other.length === 0, `changes classified: ${JSON.stringify({ eol: ch.lineEndingsOnly, lock: ch.lockfiles, new: ch.untracked, other: ch.other })}`);
    w(path.join(G, 'app.js'), 'x = 9\n');
    sh('git add app.js', G);
    const stagedChanges = await R.changes(G);
    ok(stagedChanges.other.includes('app.js') && !stagedChanges.lineEndingsOnly.includes('app.js'), 'staged content edits are never described as line-ending-only');
    sh('git reset -q HEAD -- app.js && git checkout -- app.js', G);
    w(path.join(G, 'backend', '.env'), 'NESTED_SECRET=keep-local\n');
    const blocked = await R.pull(G);
    ok(!blocked.ok && /uncommitted changes/.test(blocked.error), 'plain pull still refuses over uncommitted changes');
    const ap = await R.asideAndPull(G);
    ok(ap.ok && fs.existsSync(path.join(G, 'news.txt')), `set aside and update pulled the new commit (${(ap.steps || []).join(' / ') || ap.error})`);
    ok(fs.readFileSync(path.join(G, '.env'), 'utf8') === 'SECRET=keep-me\n', '.env stays in place when changes are set aside');
    ok(fs.readFileSync(path.join(G, 'backend', '.env'), 'utf8') === 'NESTED_SECRET=keep-local\n', 'nested .env stays in place when changes are set aside');
    ok(!fs.existsSync(path.join(G, 'postcss.config.mjs')) && fs.readFileSync(path.join(G, 'package-lock.json'), 'utf8') === '{"a":1}\n', 'set-aside files leave the folder');
    const list = await R.setAsideList(G);
    ok(list.ok && list.items.length === 1 && /RepoHub: before updating/.test(list.items[0].message) && list.items[0].ref === 'stash@{0}', 'set-aside entry listed');
    w(path.join(G, 'app.js'), 'x = 2\n');
    ok(!(await R.bringBack(G, 'stash@{0}')).ok && fs.readFileSync(path.join(G, 'app.js'), 'utf8') === 'x = 2\n', 'bring back refuses while new edits are present');
    sh('git checkout -- app.js', G);
    const bb = await R.bringBack(G, 'stash@{0}');
    ok(bb.ok && fs.readFileSync(path.join(G, 'package-lock.json'), 'utf8') === '{"a":2}\n' && fs.existsSync(path.join(G, 'postcss.config.mjs')) && (await R.setAsideList(G)).items.length === 0, 'bring back restores everything and removes the entry');
    ok(!(await R.bringBack(G, 'HEAD~1; rm -rf /')).ok && !(await R.dropAside(G, '--all')).ok, 'only stash@{n} references accepted');
    // Update all with the option
    sh('echo more > more.txt && git add . && git commit -qm more && git push -q', G2);
    const u1 = await R.updateOne(G);
    ok(u1.state === 'skipped' && /uncommitted/.test(u1.note), 'Update all still skips by default');
    const u2 = await R.updateOne(G, { setAsideChanges: true });
    ok(u2.state === 'updated' && /set aside/.test(u2.note) && fs.existsSync(path.join(G, 'more.txt')), `Update all with set aside updates (${u2.note})`);
    // Local commits on someone else's project
    sh('git stash drop -q', G);
    w(path.join(G, 'mine.txt'), 'mine'); sh('git add mine.txt && git commit -qm "Update from Levani"', G);
    sh('echo theirs > theirs.txt && git add . && git commit -qm theirs && git push -q', G2);
    w(path.join(G, 'theirs.txt'), 'local untracked data\n');
    const refusedMatch = await R.matchRemote(G);
    ok(!refusedMatch.ok && fs.readFileSync(path.join(G, 'theirs.txt'), 'utf8') === 'local untracked data\n' && fs.existsSync(path.join(G, 'mine.txt')), 'match GitHub refuses to overwrite an untracked file and preserves local commits');
    fs.unlinkSync(path.join(G, 'theirs.txt'));
    const mr = await R.matchRemote(G);
    const branches = sh('git branch --list "repohub/backup-*"', G);
    ok(mr.ok && /repohub\/backup-\d{8}-\d{4}/.test(mr.backup) && branches.includes(mr.backup) && fs.existsSync(path.join(G, 'theirs.txt')) && !fs.existsSync(path.join(G, 'mine.txt')), `match GitHub keeps commits on ${mr.backup}`);
    ok(sh(`git log --format=%s -1 ${mr.backup}`, G).trim() === 'Update from Levani', 'backup branch holds the local commit');
    sh('echo latest > latest.txt && git add . && git commit -qm latest && git push -q', G2);
    const behindMatch = await R.matchRemote(G);
    ok(behindMatch.ok && fs.existsSync(path.join(G, 'latest.txt')), 'match GitHub updates a behind-only branch instead of claiming it already matches');
    w(path.join(G, 'app.js'), 'x = 10\n');
    await R.setAside(G, 'conflict recovery test');
    w(path.join(G2, 'app.js'), 'x = 20\n');
    sh('git add app.js && git commit -qm conflict && git push -q', G2);
    await R.pull(G);
    const restoreConflict = await R.bringBack(G, 'stash@{0}');
    ok(!restoreConflict.ok && restoreConflict.conflicts && (await R.setAsideList(G)).items.length === 1 && fs.readFileSync(path.join(G, 'app.js'), 'utf8').includes('<<<<<<<'), 'conflicting restore preserves the set-aside copy and reports conflict markers');
    // Push errors explained
    const tooling2 = require('../tooling');
    const den = tooling2.explain({ code: 128, out: '', err: 'remote: Permission to calesthio/OpenMontage.git denied to levanis-design.\nfatal: unable to access \'https://github.com/calesthio/OpenMontage.git/\': The requested URL returned error: 403' });
    ok(den.noPermission && den.account === 'levanis-design' && /cannot push to calesthio\/OpenMontage/.test(den.error) && !den.needsLogin, 'push to someone else\'s repository: says why, not "sign in"');
    const lg = tooling2.explain({ code: 128, out: '', err: 'fatal: could not read Username for \'https://github.com\': terminal prompts disabled' });
    ok(lg.needsLogin && /Settings → Accounts/.test(lg.error), 'missing login points to Git sign-in');
  } catch (e) {
    failed += 1;
    console.log('FAIL unexpected error:', e && e.stack || e);
  } finally {
    try { fs.rmSync(T, { recursive: true, force: true }); } catch { /* temp */ }
    console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed');
    process.exitCode = failed ? 1 : 0;
  }
})();
