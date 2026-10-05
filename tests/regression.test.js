const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { EventEmitter } = require('events');
const root = path.resolve(__dirname, '..');

function load(file, mocks = {}) {
  const mod = { exports: {} };
  const context = { require: (id) => mocks[id] || require(id.startsWith('.') ? path.join(root, id) : id),
    module: mod, exports: mod.exports, process, console, Buffer, setTimeout, clearTimeout, setInterval, clearInterval };
  vm.runInNewContext(fs.readFileSync(path.join(root, file), 'utf8'), context, { filename: file });
  return mod.exports;
}
function childFor(args, calls) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
  child.stdin = { end() {} }; child.kill = () => {}; child.unref = () => {};
  calls.push(args);
  queueMicrotask(() => { child.stdout.emit('data', Buffer.from(args[0] === 'inspect' ? '{"repohub.try":"0"}' : '')); child.emit('close', 0); });
  return child;
}
test('JSONC preserves commas and braces inside strings', () => {
  const sb = require('../sandbox');
  assert.equal(sb.jsonc('{"url":"https://example.test/,}","array":[1,],}').url, 'https://example.test/,}');
});
test('JSONC block comments separate tokens rather than merging them', () => {
  assert.equal(require('../sandbox').jsonc('{"value":1/* gap */2}'), null);
});
test('sandbox removal requires the ownership label as well as the prefix', async () => {
  const calls = [];
  const sb = load('sandbox.js', { './tooling': { toolEnv: () => ({}), spawnTool: (bin, args) => childFor(args, calls) } });
  const result = await sb.remove('repohub-try-unowned');
  assert.equal(result.ok, false);
  assert.equal(calls.some((a) => a[0] === 'rm'), false);
});
test('sandbox attachment requires ownership before reading container logs', async () => {
  const calls = [];
  const sb = load('sandbox.js', { './tooling': { toolEnv: () => ({}), spawnTool: (bin, args) => childFor(args, calls) } });
  const result = await sb.attach('repohub-try-unowned', () => {});
  sb.stopWatching();
  assert.equal(result.ok, false);
  assert.equal(calls.some((a) => a[0] === 'logs'), false);
});
test('installer preview reports pnpm method matching its command', async () => {
  const inst = load('installers.js', { './tooling': { IS_WIN: true, probe: async () => 'installed' } });
  const item = (await inst.check()).tools.find((t) => t.id === 'pnpm');
  assert.equal(item.method, 'npm');
});
test('installer script refreshes PATH after installing Node and resets exit status per step', () => {
  const inst = require('../installers');
  const file = inst.script(['node', 'codex'], { npmAvailable: false });
  try { const text = fs.readFileSync(file, 'utf8'); assert.match(text, /GetEnvironmentVariable/); assert.match(text, /LASTEXITCODE = 0/); }
  finally { fs.unlinkSync(file); }
});
test('Update all explains divergent history and never pulls it', async () => {
  const repos = require('../repos');
  assert.equal(typeof repos.updateDecision, 'function');
  const result = repos.updateDecision({ ok: true, remote: 'x', upstream: 'origin/main', ahead: 2, behind: 3, changed: 0 });
  assert.equal(result.state, 'skipped'); assert.match(result.note, /diverg/i);
});
test('Update all reports failed status checks and missing remotes', () => {
  const decide = require('../repos').updateDecision;
  assert.equal(decide({ ok: false, error: 'status failed' }).state, 'failed');
  assert.match(decide({ ok: true, statusError: 'unreadable' }).note, /unreadable/);
  assert.match(decide({ ok: true }).note, /remote|address/i);
});
test('Update all protects uncommitted files even if already current', () => {
  assert.equal(require('../repos').updateDecision({ ok: true, remote: 'x', upstream: 'origin/main', changed: 1, behind: 0 }).state, 'skipped');
});
test('sandbox array postCreateCommand uses argument quoting', () => {
  const p = require('../sandbox').plan({ files: [], setup: { '.devcontainer/devcontainer.json': JSON.stringify({ image: 'node:22', postCreateCommand: ['printf', '%s', 'a; touch /bad'] }) } });
  assert.equal(p.install, "'printf' '%s' 'a; touch /bad'");
});
test('SSH remotes with embedded passwords are refused', () => {
  assert.equal(require('../tooling').cleanRemote('ssh://git:secret@example.test/repo.git').ok, false);
});
test('Windows git executable cannot be replaced by a file in a repository', async () => {
  if (process.platform !== 'win32') return;
  const os = require('os'); const dir = fs.mkdtempSync(path.join(os.tmpdir(),'repohub-rogue-'));
  try {
    fs.copyFileSync(process.execPath, path.join(dir,'git.exe'));
    const result = await require('../tooling').git(['--version'],{cwd:dir});
    assert.match(result.out, /^git version /);
  } finally { fs.rmSync(dir,{recursive:true,force:true}); }
});
test('local file reads refuse directory junctions leading outside the repository', async () => {
  const os = require('os'); const dir = fs.mkdtempSync(path.join(os.tmpdir(),'repohub-links-'));
  const old = process.env.REPOHUB_CONFIG; process.env.REPOHUB_CONFIG=path.join(dir,'config.json');
  try {
    const repo=path.join(dir,'repo'), other=path.join(dir,'other'); fs.mkdirSync(repo); fs.mkdirSync(other);
    fs.mkdirSync(path.join(repo,'.git')); fs.writeFileSync(path.join(repo,'.git','HEAD'),'ref: refs/heads/main');
    fs.writeFileSync(path.join(other,'secret.txt'),'private fixture'); fs.symlinkSync(other,path.join(repo,'escape'),'junction');
    const r = require('../repos'); r.writeConfig({last:[repo]});
    assert.equal(r.known(repo),true);
    assert.equal((await r.localFile(repo,'escape/secret.txt')).ok,false);
  } finally { if(old===undefined)delete process.env.REPOHUB_CONFIG; else process.env.REPOHUB_CONFIG=old; fs.rmSync(dir,{recursive:true,force:true}); }
});
test('terminal launch reports asynchronous process errors', async () => {
  const runner = load('runner.js', { './tooling': {IS_WIN:true,toolEnv:()=>({})}, child_process: { spawn: () => {
    const c=new EventEmitter(); c.unref=()=>{}; queueMicrotask(()=>c.emit('error',new Error('fixture ENOENT'))); return c;
  } } });
  const result = await runner.openTerminal(require('os').tmpdir());
  assert.equal(result.ok,false); assert.match(result.error,/ENOENT/);
});
test('terminal paths travel as environment values rather than PowerShell code', async () => {
  let captured;
  const runner=load('runner.js',{ './tooling': {IS_WIN:true,toolEnv:(e)=>e}, child_process:{spawn:(bin,args,options)=>{
    captured={bin,args,options}; const c=new EventEmitter();c.unref=()=>{};queueMicrotask(()=>{c.emit('spawn');c.emit('close',0)});return c;
  }}});
  const dir=require('os').tmpdir(); assert.equal((await runner.openTerminal(dir,'claude')).ok,true);
  assert.equal(captured.options.env.REPOHUB_TERMINAL_DIR,dir);
  const encoded=captured.args[captured.args.indexOf('-EncodedCommand')+1];
  const script=Buffer.from(encoded,'base64').toString('utf16le');
  assert.match(script,/Set-Location -LiteralPath \$env:REPOHUB_TERMINAL_DIR/); assert.equal(script.includes(dir),false);
});
test('Docker missing and Docker stopped remain distinct', async () => {
  let sb=load('sandbox.js',{'./tooling':{toolEnv:()=>({}),spawnTool:()=>{throw new Error('ENOENT')}}});
  assert.equal((await sb.status()).installed,false);
  sb=load('sandbox.js',{'./tooling':{toolEnv:()=>({}),spawnTool:()=>{const c=childFor([],[]); return c;}}});
  assert.equal((await sb.status()).installed,true);assert.equal((await sb.status()).running,false);
});
test('sandbox launch enforces resources and loopback ports without host mounts', async () => {
  const dir=fs.mkdtempSync(path.join(require('os').tmpdir(),'repohub-lifecycle-'));
  const old=process.env.REPOHUB_SANDBOX_STATE;process.env.REPOHUB_SANDBOX_STATE=path.join(dir,'sandboxes.json');
  const calls=[];const events=[];
  const sb=load('sandbox.js',{'./tooling':{toolEnv:()=>({}),spawnTool:(bin,args)=>{
    const c=new EventEmitter();c.stdout=new EventEmitter();c.stderr=new EventEmitter();c.kill=()=>{};calls.push(args);
    if(args[0]!=='logs')queueMicrotask(()=>{let out=args[0]==='version'?'test-version':args[0]==='inspect'&&args.includes('{{json .Config.Labels}}')?'{"repohub.try":"1"}':args[0]==='inspect'?'node:22':args[0]==='run'?'container-id':'image-id';c.stdout.emit('data',Buffer.from(out));c.emit('close',0)});
    return c;
  }}});
  try {
    const r=await sb.start({cloneUrl:'https://github.com/example/fixture.git',repo:'fixture',plan:{image:'node:22',install:'echo install',start:'echo start',port:3000},limits:{memoryGb:2,cpus:2,ttlMinutes:30,readOnly:true}},e=>events.push(e));
    assert.equal(r.ok,true); await new Promise(resolve=>setTimeout(resolve,30));
    const run=calls.find(a=>a[0]==='run');assert.ok(run);
    assert.equal(run[run.indexOf('--memory')+1],'2g');assert.equal(run[run.indexOf('--cpus')+1],'2');
    assert.ok(run.includes('--pids-limit'));assert.ok(run.includes('--read-only'));assert.ok(run.includes('no-new-privileges'));
    assert.equal(run.includes('-v')||run.includes('--mount')||run.includes('--privileged'),false);
    run.forEach((value,i)=>{if(value==='-p')assert.match(run[i+1],/^127\.0\.0\.1::\d+$/)});
    const state=JSON.parse(fs.readFileSync(process.env.REPOHUB_SANDBOX_STATE,'utf8'));assert.ok(state[r.name].expiresAt>Date.now());
    const before=state[r.name].expiresAt;sb.extend(r.name,15,()=>{});
    assert.ok(JSON.parse(fs.readFileSync(process.env.REPOHUB_SANDBOX_STATE,'utf8'))[r.name].expiresAt>before);
    assert.equal((await sb.remove(r.name)).ok,true);assert.equal(sb.getLog(r.name).text,'');
  } finally { sb.stopWatching();if(old===undefined)delete process.env.REPOHUB_SANDBOX_STATE;else process.env.REPOHUB_SANDBOX_STATE=old;fs.rmSync(dir,{recursive:true,force:true}); }
});
test('settings rejects numeric font names and survives a non-object settings file', () => {
  const dir=fs.mkdtempSync(path.join(require('os').tmpdir(),'repohub-settings-'));
  const old=process.env.REPOHUB_SETTINGS;process.env.REPOHUB_SETTINGS=path.join(dir,'settings.json');
  try {
    const settings=require('../settings');assert.equal(settings.write({uiFont:123}).ok,false);
    fs.writeFileSync(process.env.REPOHUB_SETTINGS,'"damaged settings"');
    assert.equal(settings.read().colorTheme,'indigo');
  } finally {if(old===undefined)delete process.env.REPOHUB_SETTINGS;else process.env.REPOHUB_SETTINGS=old;fs.rmSync(dir,{recursive:true,force:true});}
});
