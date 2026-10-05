/* INSTALLERS. Every tool RepoHub (or the repositories you try) may need, with
   a check for whether it is installed and a way to install it.

   How installing works, and why:
     - Windows tools install with winget, the Windows Package Manager built into
       Windows 10 and 11. Package IDs are the official ones in Microsoft's winget
       catalog (checked October 2026).
     - Command-line agents and pnpm or yarn install with npm, so Node.js comes first.
     - Installs run in a visible PowerShell window, never silently: you see the
       progress, answer winget's license prompt yourself, and approve Windows'
       administrator prompt when an installer needs one.
     - RepoHub only runs the fixed commands in this file. Nothing is downloaded
       from a link a repository suggests.
     - After an install, "Check again" finds the tool at once: tooling.js re-reads
       the PATH from Windows. */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { probe, refreshPath, IS_WIN } = require('./tooling');

/* group: runtime | package | container | agent | tool */
const CATALOG = [
  { id: 'git', name: 'Git', group: 'tool', check: ['git', ['--version']], winget: 'Git.Git', why: 'downloads and updates repositories; includes the GitHub sign-in helper' },
  { id: 'node', name: 'Node.js (LTS, includes npm)', group: 'runtime', check: ['node', ['--version']], winget: 'OpenJS.NodeJS.LTS', why: 'runs JavaScript projects; npm comes with it' },
  { id: 'npm', name: 'npm', group: 'package', check: ['npm', ['--version']], includedWith: 'node', why: 'installs JavaScript libraries; installed with Node.js' },
  { id: 'pnpm', name: 'pnpm', group: 'package', check: ['pnpm', ['--version']], npm: 'pnpm', winget: 'pnpm.pnpm', why: 'a faster JavaScript package manager some projects require' },
  { id: 'yarn', name: 'Yarn Classic', group: 'package', check: ['yarn', ['--version']], npm: 'yarn', why: 'a JavaScript package manager some projects require', note: 'This installs Yarn 1 (Classic). Projects requiring modern Yarn should use their documented Corepack setup.' },
  { id: 'python', name: 'Python 3.13', group: 'runtime', check: ['python', ['--version']], winget: 'Python.Python.3.13', why: 'runs Python projects', note: 'If "python" opens the Microsoft Store instead, turn off the python.exe app alias in Windows Settings → Apps → Advanced app settings → App execution aliases.' },
  { id: 'uv', name: 'uv', group: 'package', check: ['uv', ['--version']], winget: 'astral-sh.uv', why: 'a fast Python package and environment manager' },
  { id: 'docker', name: 'Docker Desktop', group: 'container', check: ['docker', ['--version']], winget: 'Docker.DockerDesktop', why: 'needed for Try before install (sandboxes)', note: 'Docker Desktop needs WSL 2 (Windows Subsystem for Linux). If it asks, run "wsl --install" in an administrator terminal, restart Windows, then start Docker Desktop once and accept its terms.' },
  { id: 'cargo', name: 'Rust (rustup and cargo)', group: 'runtime', check: ['cargo', ['--version']], winget: 'Rustlang.Rustup', why: 'builds Rust projects', note: 'Rust on Windows also needs the Microsoft C++ build tools; rustup offers to install them.' },
  { id: 'go', name: 'Go', group: 'runtime', check: ['go', ['version']], winget: 'GoLang.Go', why: 'builds Go projects' },
  { id: 'gh', name: 'GitHub CLI', group: 'tool', check: ['gh', ['--version']], winget: 'GitHub.cli', why: 'GitHub login for RepoHub: 5,000 requests an hour, star history, private repositories' },
  { id: 'code', name: 'Visual Studio Code', group: 'tool', check: ['code', ['--version']], winget: 'Microsoft.VisualStudioCode', why: 'opens repositories in an editor' },
  { id: 'wt', name: 'Windows Terminal', group: 'tool', check: null, winget: 'Microsoft.WindowsTerminal', why: 'a better terminal window for Claude and the sandbox shell' },
  { id: 'claude', name: 'Claude Code', group: 'agent', check: ['claude', ['--version']], winget: 'Anthropic.ClaudeCode', npm: '@anthropic-ai/claude-code', why: 'Explain with Claude, and Open Claude here' },
  { id: 'codex', name: 'Codex CLI (OpenAI, sign in with ChatGPT)', group: 'agent', check: ['codex', ['--version']], npm: '@openai/codex', why: 'OpenAI\'s coding agent; signs in with your ChatGPT account' },
  { id: 'gemini', name: 'Gemini CLI (Google)', group: 'agent', check: ['gemini', ['--version']], npm: '@google/gemini-cli', why: 'Google\'s coding agent' },
  { id: 'copilot', name: 'GitHub Copilot CLI', group: 'agent', check: ['copilot', ['--version']], npm: '@github/copilot', why: 'GitHub\'s coding agent; needs a Copilot plan' },
];

/* Sign-in commands, run in a visible terminal. These are the only commands
   the Accounts settings may start. */
const SIGN_IN = {
  gh: { label: 'GitHub', command: 'gh auth login --hostname github.com --git-protocol https --web', hint: 'Finish in the browser. Then press Sign in under GitHub so RepoHub picks it up.' },
  claude: { label: 'Claude', command: 'claude', hint: 'Claude Code opens; if it is not signed in it asks you to log in (or type /login).' },
  codex: { label: 'ChatGPT (Codex)', command: 'codex login', hint: 'Choose "Sign in with ChatGPT" and finish in the browser.' },
  gemini: { label: 'Gemini', command: 'gemini', hint: 'Gemini CLI asks how to sign in the first time; choose your Google account.' },
  copilot: { label: 'GitHub Copilot', command: 'copilot', hint: 'Copilot CLI opens; type /login if it asks.' },
};

async function hasWinget() { return !!(await probe('winget', ['--version'])); }

async function check() {
  if (refreshPath) refreshPath();
  const [winget, ...results] = await Promise.all([
    IS_WIN ? hasWinget() : Promise.resolve(false),
    ...CATALOG.map(async (t) => {
      if (!t.check) {
        const wt = IS_WIN && fs.existsSync(path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WindowsApps', 'wt.exe'));
        return { id: t.id, version: wt ? 'installed' : '' };
      }
      return { id: t.id, version: await probe(t.check[0], t.check[1]) };
    }),
  ]);
  const versions = Object.fromEntries(results.map((r) => [r.id, r.version]));
  const npmAvailable = !!versions.npm;
  return {
    ok: true,
    winget,
    windows: IS_WIN,
    tools: CATALOG.map((t) => ({
      id: t.id, name: t.name, group: t.group, why: t.why, note: t.note || '',
      version: versions[t.id] || '',
      method: t.includedWith ? `installed with ${CATALOG.find((x) => x.id === t.includedWith).name}` : installCommand(t, npmAvailable).split(' ')[0] || '',
      canInstall: !t.includedWith && ((IS_WIN && !!t.winget) || !!t.npm),
      command: installCommand(t, npmAvailable),
      signIn: SIGN_IN[t.id] ? { label: SIGN_IN[t.id].label, hint: SIGN_IN[t.id].hint } : null,
    })),
  };
}

/* The exact command for one tool (shown before installing, then run). */
function installCommand(t, npmAvailable) {
  if (t.includedWith) return '';
  if (IS_WIN && t.winget && !(t.npm && t.id === 'pnpm' && npmAvailable)) return `winget install --id ${t.winget} --exact --source winget`;
  if (t.npm) return `npm install --global ${t.npm}`;
  return '';
}

/* The PowerShell script for the chosen tools: one numbered step per tool,
   stopping to show any failure, and a summary at the end. */
function script(ids, { npmAvailable } = {}) {
  const picks = CATALOG.filter((t) => ids.includes(t.id) && !t.includedWith);
  if (!picks.length) return null;
  const lines = [
    '$ErrorActionPreference = "Continue"',
    'Write-Host "RepoHub installer" -ForegroundColor Cyan',
    'Write-Host "Each step runs the official installer. Answer any prompt that appears."',
    'Write-Host ""',
    '$failed = @()',
  ];
  picks.forEach((t, i) => {
    // npm tools use npm; Claude Code prefers winget on Windows; pnpm prefers npm when Node is present.
    const cmd = installCommand(t, npmAvailable);
    if (!cmd) return;
    lines.push(
      `Write-Host "[${i + 1}/${picks.length}] ${t.name.replace(/"/g, '')}" -ForegroundColor Cyan`,
      `Write-Host "> ${cmd}" -ForegroundColor DarkGray`,
      '$env:PATH = [Environment]::ExpandEnvironmentVariables(([Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [Environment]::GetEnvironmentVariable("Path", "User") + ";" + $env:PATH))',
      '$global:LASTEXITCODE = 0',
      'try {',
      cmd,
      'if (-not $? -or $LASTEXITCODE -ne 0) { throw "Installer failed (exit code $LASTEXITCODE)." }',
      `} catch { $failed += "${t.name.replace(/"/g, '')}"; Write-Host $_ -ForegroundColor Yellow }`,
      'Write-Host ""');
  });
  lines.push(
    'if ($failed.Count -eq 0) { Write-Host "Done. Go back to RepoHub and press Check again." -ForegroundColor Green }',
    'else { Write-Host ("Did not finish: " + ($failed -join ", ")) -ForegroundColor Yellow; Write-Host "Read the messages above. You can run the installer again from RepoHub." }');
  const dir = path.join(os.tmpdir(), 'repohub-installers');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `install-${Date.now()}.ps1`);
  fs.writeFileSync(file, '﻿' + lines.join('\r\n'), 'utf8');
  return file;
}

module.exports = { CATALOG, SIGN_IN, check, script, installCommand };
