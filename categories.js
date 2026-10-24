/* CATEGORIES. What each repository on this computer is for, so the list can be
   grouped by it. Read from a few small files in the repository (package.json,
   pyproject.toml, requirements.txt, Cargo.toml, go.mod, SKILL.md, plugin and
   MCP files, the start of the README); nothing runs and nothing is downloaded.

   The guess is shown with its reason ("electron in package.json"). You can
   choose another category for any repository; your choice is saved in
   repos.json (categories) and always wins over the guess.

   Files are read only when their real location is inside the repository, so a
   link or junction cannot point the reader at another folder. */

const fs = require('fs');
const path = require('path');

const CATEGORIES = [
  ['agents', 'AI agents and LLM tools'],
  ['skills', 'Claude skills and plugins'],
  ['mcp', 'MCP servers'],
  ['desktop', 'Desktop apps'],
  ['web', 'Websites and web apps'],
  ['server', 'Servers and APIs'],
  ['cli', 'Command-line tools'],
  ['library', 'Libraries and packages'],
  ['data', 'Data, notebooks and analysis'],
  ['media', 'Video, audio and images'],
  ['docs', 'Documents and notes'],
  ['other', 'Other'],
];
const LABEL = Object.fromEntries(CATEGORIES);
const IDS = new Set(CATEGORIES.map(([id]) => id));

function safeRead(dir, rel, max = 65536) {
  try {
    const root = fs.realpathSync(dir);
    const file = fs.realpathSync(path.join(dir, rel));
    if (file !== root && !file.startsWith(root + path.sep)) return '';
    const st = fs.statSync(file);
    if (!st.isFile()) return '';
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(Math.min(st.size, max));
      fs.readSync(fd, buf, 0, buf.length, 0);
      return buf.toString('utf8');
    } finally { fs.closeSync(fd); }
  } catch { return ''; }
}
function topNames(dir) {
  try { return fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.name !== '.git').map((d) => ({ name: d.name.toLowerCase(), dir: d.isDirectory() })); }
  catch { return []; }
}

const any = (text, words) => words.find((w) => new RegExp(`(^|[^a-z0-9_-])${w.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}([^a-z0-9_-]|$)`, 'i').test(text));

const AI_DEPS = ['openai', 'anthropic', '@anthropic-ai/sdk', 'langchain', 'langgraph', 'llama-index', 'llama_index', 'transformers', 'ollama', 'litellm', 'crewai', 'autogen', '@ai-sdk/openai', 'ai', 'google-generativeai', '@google/genai', 'mistralai', 'groq'];
const WEB_DEPS = ['next', 'react', 'react-dom', 'vue', 'nuxt', 'svelte', '@sveltejs/kit', 'vite', 'astro', 'angular', '@angular/core', 'gatsby', 'remix', '@remix-run/react', 'solid-js', 'streamlit', 'gradio', 'django', 'flask'];
const SERVER_DEPS = ['express', 'fastify', 'koa', 'hono', '@nestjs/core', 'fastapi', 'uvicorn', 'aiohttp', 'tornado', 'socket.io', 'prisma', 'sequelize', 'mongoose'];
const DATA_DEPS = ['pandas', 'numpy', 'polars', 'matplotlib', 'seaborn', 'plotly', 'scikit-learn', 'sklearn', 'jupyter', 'notebook', 'duckdb', 'openpyxl', 'xlsx'];
const MEDIA_DEPS = ['ffmpeg', 'fluent-ffmpeg', 'moviepy', 'opencv-python', 'pillow', 'sharp', 'remotion', '@remotion/cli', 'pydub', 'whisper', 'openai-whisper', 'diffusers'];
const CLI_DEPS = ['commander', 'yargs', 'click', 'typer', 'argparse', 'clap', 'cobra', 'inquirer', 'oclif'];

/* The guess: { id, label, why }. First matching rule wins, most specific first. */
function classify(dir) {
  const names = topNames(dir);
  const has = (n) => names.some((x) => x.name === n);
  const pkgText = safeRead(dir, 'package.json');
  let pkg = null;
  try { pkg = pkgText ? JSON.parse(pkgText) : null; } catch { pkg = null; }
  const deps = pkg ? Object.keys({ ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}), ...(pkg.peerDependencies || {}) }).map((d) => d.toLowerCase()) : [];
  const dep = (list) => list.find((d) => deps.includes(d));
  const py = [safeRead(dir, 'pyproject.toml'), safeRead(dir, 'requirements.txt'), safeRead(dir, 'setup.py'), safeRead(dir, 'environment.yml')].join('\n').toLowerCase();
  const pyDep = (list) => list.find((d) => new RegExp(`(^|["'\\s,\\[])${d.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\s*[=<>~!\\[;,"']|\\s*$)`, 'm').test(py));
  const cargo = safeRead(dir, 'Cargo.toml').toLowerCase();
  const gomod = safeRead(dir, 'go.mod').toLowerCase();
  const readme = (safeRead(dir, 'README.md', 6000) || safeRead(dir, 'readme.md', 6000) || safeRead(dir, 'README', 6000)).toLowerCase();
  const out = (id, why) => ({ id, label: LABEL[id], why });

  // Claude skills and plugins
  if (has('skill.md')) return out('skills', 'SKILL.md at the top level');
  if (has('.claude-plugin')) return out('skills', '.claude-plugin folder');
  if (has('skills') && (has('plugins') || has('.claude') || /claude code|agent skill|skill\.md/.test(readme))) return out('skills', 'skills folder');
  // MCP servers
  const mcpDep = dep(['@modelcontextprotocol/sdk', 'fastmcp']) || pyDep(['mcp', 'fastmcp']);
  if (mcpDep && /mcp server|model context protocol/.test(readme + ' ' + String(pkg && pkg.description || '').toLowerCase())) return out('mcp', `${mcpDep} and "MCP server" in the README`);
  if (mcpDep && !dep(['electron'])) return out('mcp', `${mcpDep} in the dependencies`);
  // Desktop apps
  const desk = dep(['electron', '@tauri-apps/api', '@tauri-apps/cli', 'nw', '@neutralinojs/lib']) || pyDep(['pyqt5', 'pyqt6', 'pyside6', 'tkinter', 'customtkinter', 'wxpython', 'kivy', 'flet']) || (cargo.includes('tauri') ? 'tauri' : '') || (has('src-tauri') ? 'src-tauri' : '');
  if (desk) return out('desktop', `${desk} in the project files`);
  if (names.some((x) => /\.(sln|csproj|xcodeproj)$/.test(x.name))) return out('desktop', 'Visual Studio or Xcode project');
  // AI agents and LLM tools
  const ai = dep(AI_DEPS.filter((d) => d !== 'ai' || deps.includes('ai'))) || pyDep(AI_DEPS);
  if (ai) return out('agents', `${ai} in the dependencies`);
  if (any(readme.slice(0, 1500), ['llm', 'ai agent', 'agents', 'chatgpt', 'claude', 'gpt-4', 'gemini', 'rag']) && (pkg || py.trim())) return out('agents', 'the README describes an AI or agent tool');
  // Media
  const media = dep(MEDIA_DEPS) || pyDep(MEDIA_DEPS);
  if (media) return out('media', `${media} in the dependencies`);
  // Web apps and websites
  const web = dep(WEB_DEPS) || pyDep(['streamlit', 'gradio', 'django', 'flask']);
  if (web) return out('web', `${web} in the dependencies`);
  if (has('wp-content') || /theme name:/i.test(safeRead(dir, 'style.css', 2000))) return out('web', 'WordPress files');
  if (has('index.html') && !pkg && !py.trim()) return out('web', 'index.html at the top level');
  if (has('_config.yml') || has('hugo.toml') || has('docusaurus.config.js') || has('mkdocs.yml')) return out('web', 'static site generator files');
  // Servers and APIs
  const srv = dep(SERVER_DEPS) || pyDep(SERVER_DEPS);
  if (srv) return out('server', `${srv} in the dependencies`);
  if (gomod && /(gin-gonic|labstack\/echo|gofiber|net\/http|chi)/.test(gomod)) return out('server', 'Go web framework in go.mod');
  if (cargo && /(axum|actix-web|rocket|warp)/.test(cargo)) return out('server', 'Rust web framework in Cargo.toml');
  if (has('docker-compose.yml') || has('compose.yaml') || has('docker-compose.yaml')) return out('server', 'Docker Compose file');
  // Data
  const data = dep(DATA_DEPS) || pyDep(DATA_DEPS);
  if (data || names.some((x) => x.name.endsWith('.ipynb'))) return out('data', data ? `${data} in the dependencies` : 'Jupyter notebooks');
  // Command-line tools
  if (pkg && pkg.bin) return out('cli', '"bin" in package.json');
  const cli = dep(CLI_DEPS) || pyDep(CLI_DEPS) || (cargo.includes('clap') ? 'clap' : '') || (gomod.includes('cobra') ? 'cobra' : '');
  if (cli) return out('cli', `${cli} in the dependencies`);
  if (/\[project\.scripts\]|console_scripts/.test(py)) return out('cli', 'command entry points in pyproject.toml');
  if (cargo.includes('[[bin]]') || (cargo && has('src') && fs.existsSync(path.join(dir, 'src', 'main.rs')))) return out('cli', 'Rust program (src/main.rs)');
  if (gomod && has('main.go')) return out('cli', 'Go program (main.go)');
  // Libraries
  if (pkg && (pkg.main || pkg.exports || pkg.module) && !pkg.private) return out('library', 'package.json publishes a module');
  if (cargo.includes('[lib]') || (cargo && fs.existsSync(path.join(dir, 'src', 'lib.rs')))) return out('library', 'Rust library (src/lib.rs)');
  if (gomod) return out('library', 'Go module');
  if (py.trim()) return out('library', 'Python package files');
  if (pkg) return out('library', 'package.json');
  // Documents and notes
  const files = names.filter((x) => !x.dir);
  const docsOnly = files.length > 0 && files.every((x) => /\.(md|txt|pdf|docx?|xlsx?|csv|json|ya?ml|png|jpe?g|gif|svg)$/.test(x.name) || ['license', '.gitignore', '.gitattributes'].includes(x.name));
  if (docsOnly) return out('docs', 'only documents and notes at the top level');
  return out('other', 'no project files recognized');
}

/* All categories for a set of known repositories, with your own choices applied. */
function forRepos(dirs, overrides = {}) {
  const lower = Object.fromEntries(Object.entries(overrides || {}).map(([k, v]) => [path.resolve(k).toLowerCase(), v]));
  const result = {};
  for (const d of dirs) {
    const mine = lower[path.resolve(d).toLowerCase()];
    if (mine && IDS.has(mine)) result[d] = { id: mine, label: LABEL[mine], why: 'chosen by you', mine: true };
    else result[d] = { ...classify(d), mine: false };
  }
  return result;
}

module.exports = { CATEGORIES, LABEL, IDS, classify, forRepos, safeRead };
