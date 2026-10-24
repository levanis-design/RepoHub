## RepoHub 1.9.0

See what a GitHub repository is before you install it, try it safely, and keep every repository on your computer in order.

### Download

- **RepoHub-Setup-1.9.0.exe**: installer (choose the folder, adds Start menu and desktop shortcuts)
- **RepoHub-1.9.0-portable.exe**: runs without installing

The executables are not code-signed, so Windows SmartScreen may say "Windows protected your PC". Choose **More info → Run anyway**. You can also run RepoHub from source: download the code, then double-click `start.bat` (needs Node.js 22.12 or newer).

### New since 1.4

**Updates that explain themselves (1.9)**
- When an update is blocked, the Git tab says why: lock files rewritten by an install, line endings changed by Windows, new files, or real edits
- **Set aside and update** stashes the changes and pulls; **Bring back** restores them; `.env` files are never moved
- New untracked files no longer block Pull or Update all
- Someone else's project shows **Update from GitHub** instead of Push and Sync, and a refused push now says which account cannot write to it
- Local commits on someone else's project can be kept on a backup branch while the folder matches GitHub again
- Push opens Git Credential Manager's sign-in window when GitHub asks for a login

**Most starred on GitHub (1.8)**
- The most starred repositories by time (all time, or new this year, month or week), language, topic and keywords, 30 at a time up to GitHub's 1,000

**Favorites and search history (1.7)**
- Star repositories on your computer; favorites stay on top and have their own filter and page
- Every repository you explore is kept in a searchable history; the search box suggests favorites and recent searches as you type

**AI agents and AI tools (1.6)**
- Sign in to Claude, ChatGPT (Codex), Gemini, GitHub Copilot, Qwen Code, Kimi Code, Ollama, OpenCode, Kilo Code, Cline, Factory Droid and Mistral Vibe, with Install for any that are missing
- DeepSeek, Perplexity and xAI (Grok): their API key pages, and which agents accept the keys
- GitIngest, GitDiagram, DeepWiki and GitMCP for any GitHub repository, with Add to Claude Code for GitMCP

**Sorting, separators and Git sign-in (1.5)**
- Sort by name, most recent, needs attention, or category (what each repository does), with groups that fold
- Drag the separators to resize the list and pinned Settings
- Git sign-in through Git Credential Manager, and Connect RepoHub to GitHub with your Git sign-in or the GitHub CLI

### Checks

162 engine checks, 18 regression tests, syntax checks for 26 JavaScript files, and 16 desktop smoke checks pass. Git operations are tested on disposable repositories; desktop checks use isolated settings. Not yet verified on Windows: each AI agent's own sign-in, and Add to Claude Code with a real Claude Code install.
