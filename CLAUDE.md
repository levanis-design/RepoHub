# RepoHub — notes for Claude

Windows Electron app by Levani Sidiani: preview a GitHub repository from a link,
explain it, install it, and manage every git repository on the computer.

## Versions

- Never edit a working version in place: copy the folder to a new version folder (RepoHub-v1.5.0 → RepoHub-v1.6.0), bump `version` in package.json, and work there
- Do not copy node_modules; start.bat reinstalls it

## Run

- `npm install`, then `npm start` (or `start.bat`); `npm start -- --devtools` opens DevTools
- `npm run check` — engine checks in `dev/check-engine.js` (needs git); run after any change to
  `repos.js`, `tooling.js`, `github.js` or `explain.js`
- `npm run dist` or `build-windows.bat` — installer and portable exe in `release\`

## Layout

- `main.js` — window and every IPC handler, named `area:action`
- `preload.js` — exposes `window.hub` (repos, gh, explain, job, term, sandbox, auth, insights, files, saved, open, tools, app)
- `renderer.js` — the whole page: library list (left), Explore or repository view (right)
- `repos.js` — scanning for repositories and the git work (status, fetch, pull, commit, push, sync, clone)
- `tooling.js` — runs git and other tools with a fixed PATH; plain-English error messages; probe for installed tools
- `github.js` — link parsing and the GitHub preview (3 API calls; files from raw.githubusercontent.com)
- `explain.js` — facts read from files (kind, needs, install plan, .env names, cautions) and the `claude -p` summary
- `sandbox.js` — Try before install: plan (image, install, start, port) and the Docker container lifecycle; only names starting `repohub-try-` with label `repohub.try=1` may be touched
- `auth.js` — RepoHub's GitHub login, borrowed from `gh auth token` or from Git (`git credential fill`, prompts off); memory only, never written or logged
- `gitauth.js` — Git's own sign-in: credential helper, Git Credential Manager accounts (`git credential-manager github list|login|logout`)
- `aitools.js` — GitIngest, GitDiagram, DeepWiki and GitMCP links built from a checked owner/repo; the fixed `claude mcp add` command for GitMCP
- `categories.js` — what each local repository is for, read from project files; your own choice saved in repos.json `categories`
- `insights.js` — evidence gathering, the health score (six parts, 100 points) and the maintenance verdict; cached 6 hours in insights.json
- `collections.js` — bookmarks, collections, notes, tags, recently viewed, CSV and JSON export (saved.json)
- `charts.js` — hand-drawn SVG charts (one data colour #3b8ee8, validated on the dark surface); every chart has a tooltip and a table view
- `settings.js` — every setting with its default and validator; refuses unknown keys and bad values by name
- `installers.js` — the tool catalog (winget IDs, npm and uv packages), install commands, the installer script, agent sign-in and sign-out commands, and API-key-only providers (key pages only; RepoHub never takes a key)
- `runner.js` — install and run jobs with streamed output; terminal windows (Windows Terminal or PowerShell)
- Settings: `%APPDATA%\RepoHub\repos.json`; summaries: `summaries.json` beside it

## Adding a feature

1. Logic in a module (or a new one), exported
2. Handler in `main.js` registered with `handle('area:action', …)`; validate paths with `repos.known(dir)`
3. Expose it in `preload.js` under `window.hub`
4. UI in `renderer.js`
5. A check in `dev/check-engine.js` when it does real work
6. Bump `version` in `package.json`

## Rules

- Plain CommonJS JavaScript; no framework, no bundler, no native modules
- Every git read uses `--no-optional-locks`; never leave `.git/index.lock` behind
- Nothing runs without a click; never pipe downloads into a shell
- Never store or log passwords, tokens or API keys; refuse remotes with credentials in them
- README HTML is untrusted: keep the sanitizer in `md()` and the CSP in `index.html`
- Sandboxes: no host mounts, ports on 127.0.0.1 only, never `-P`; preview windows have no preload and only load their own 127.0.0.1 origin
- `term:open` only accepts the fixed commands `claude` or none; installers and sign-in run only commands defined in installers.js, gitauth.js and aitools.js; the page never passes a web address to open, only a service id and owner/repo
- Layout widths (sidebarWidth, dockWidth) are applied as CSS variables on `.layout`; the separators are absolutely positioned and never grid items
- Never run a tool by bare name from a project folder on Windows: toolEnv() sets NoDefaultCurrentDirectoryInExePath and probes run from the temp folder
- User-facing text: plain, direct English; "and" not "&"; no unexplained abbreviations
