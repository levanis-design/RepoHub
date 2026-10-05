/* AI VIEWERS FOR A REPOSITORY. Four free web services that read a public
   GitHub repository when you swap github.com for their address:

     GitIngest   gitingest.com/owner/repo   the whole repository as one block of text for an AI chat
     GitDiagram  gitdiagram.com/owner/repo  an interactive architecture diagram
     DeepWiki    deepwiki.com/owner/repo    wiki-style docs, plus a chat that answers questions about the code
     GitMCP      gitmcp.io/owner/repo       a live MCP link an AI coding assistant uses to look things up

   The links are built here from a checked owner and repository name, never
   taken from the page, and open in your browser. They work for public
   repositories; the services cannot see private ones.

   "Add to Claude Code" runs one fixed command, shown first:
     claude mcp add --transport http --scope user gitmcp-<repo> https://gitmcp.io/<owner>/<repo> */

const os = require('os');
const { spawnTool } = require('./tooling');

const SERVICES = [
  { id: 'gitingest', name: 'GitIngest', host: 'gitingest.com', what: 'The whole repository as one block of text, ready to paste into an AI chat' },
  { id: 'gitdiagram', name: 'GitDiagram', host: 'gitdiagram.com', what: 'An interactive architecture diagram' },
  { id: 'deepwiki', name: 'DeepWiki', host: 'deepwiki.com', what: 'Wiki-style docs, plus a chat box that answers questions about the code' },
  { id: 'gitmcp', name: 'GitMCP', host: 'gitmcp.io', what: 'A live link your AI coding assistant can use to look things up in the repository\'s docs' },
];

const PART = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,99})$/;

/* "owner/repo" from a full name or a GitHub address; null when it is not one. */
function parse(full) {
  const m = String(full || '').trim().match(/^(?:https:\/\/github\.com\/)?([^/\s]+)\/([^/\s#?]+?)(?:\.git)?\/?$/i);
  if (!m || !PART.test(m[1]) || !PART.test(m[2]) || m[2] === '.' || m[2] === '..') return null;
  return { owner: m[1], repo: m[2] };
}

function links(full) {
  const p = parse(full);
  if (!p) return { ok: false, error: 'These tools work with GitHub repositories (owner/repository).' };
  return { ok: true, full: `${p.owner}/${p.repo}`, services: SERVICES.map((s) => ({ ...s, url: `https://${s.host}/${p.owner}/${p.repo}` })) };
}

function url(service, full) {
  const l = links(full);
  if (!l.ok) return '';
  const s = l.services.find((x) => x.id === service);
  return s ? s.url : '';
}

/* The fixed Claude Code command for GitMCP: name and arguments. */
function mcpCommand(full) {
  const p = parse(full);
  if (!p) return null;
  const name = `gitmcp-${p.repo}`.toLowerCase().replace(/[^a-z0-9_-]/g, '-').slice(0, 60);
  const args = ['mcp', 'add', '--transport', 'http', '--scope', 'user', name, `https://gitmcp.io/${p.owner}/${p.repo}`];
  return { name, args, text: `claude ${args.join(' ')}` };
}

function addToClaude(full) {
  const c = mcpCommand(full);
  if (!c) return Promise.resolve({ ok: false, error: 'Not a GitHub repository.' });
  return new Promise((resolve) => {
    let child;
    try { child = spawnTool('claude', c.args, { cwd: os.tmpdir(), windowsHide: true }); }
    catch { resolve({ ok: false, error: 'Claude Code is not installed. Install it in Settings → Installers.' }); return; }
    let out = '', err = '';
    const t = setTimeout(() => { try { child.kill(); } catch { /* gone */ } resolve({ ok: false, error: 'Claude Code did not answer.' }); }, 30000);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', () => { clearTimeout(t); resolve({ ok: false, error: 'Claude Code is not installed. Install it in Settings → Installers.' }); });
    child.on('close', (code) => {
      clearTimeout(t);
      const text = `${out}\n${err}`;
      if (code === 0) resolve({ ok: true, name: c.name });
      else if (/already exists/i.test(text)) resolve({ ok: true, name: c.name, already: true });
      else resolve({ ok: false, error: (err || out || `Claude Code exited with code ${code}.`).trim().split('\n')[0] });
    });
  });
}

module.exports = { SERVICES, parse, links, url, mcpCommand, addToClaude };
