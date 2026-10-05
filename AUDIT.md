# RepoHub 1.4.0 release audit

Audit date: October 4, 2026 (America/New_York). Final source folder: `09_app projects/RepoHub-v1.4.0`.

## Result

The app source is prepared for review in the user-confirmed [levanis-design/RepoHub repository](https://github.com/levanis-design/RepoHub), on branch `audit/repohub-v1.4.0`. This branch preserves the remote's initial commit. External integration checks listed as blocked or untested below are not represented as completed installations or sign-ins. Live Docker lifecycle checks remain pending before promotion to a fully verified release.

The original v1.3.0 source has 27 recorded SHA-256 hashes; all remained unchanged. The older `RepoHub` folder was not modified. Changes are confined to v1.4.0. No real repositories were reset, cleaned, force-pulled or deleted. The inherited parent Git repository and its invalid `https://github.com` remote were left alone.

## Fixes

| Finding | Change and evidence |
| --- | --- |
| Repository-local `git.exe` could still run despite the Windows lookup environment flag | Resolve tools to absolute paths from absolute PATH entries. A disposable rogue executable failed the original test and passes after the fix. Probes still run in the temporary directory; registry reads use the system `reg.exe`. |
| Update all could rebase divergence and silently omit repositories without remotes | Move decisions to the main process, fetch first, check status, and use fast-forward-only pull with autostash disabled. Every visible repository gets a result. Six disposable Git integration checks cover dirty, clean/behind, current, divergent, missing and unavailable remotes. |
| Sandbox name alone authorized removal and log attachment | Require both the name prefix and actual `repohub.try=1` container label before destructive operations, reading logs or opening a shell. Built image cleanup also checks the image label. |
| Sandbox deadlines were lost on restart; failed builds lost logs | Persist deadlines and recipes, restore watchers, retain failed preparation logs, report cleanup failures accurately, and attempt cleanup on ordinary exit. Full relaunch preserves containers. Crash recovery checks expired deadlines on the next start. |
| JSONC trailing-comma cleanup changed quoted string content | Parse comments and trailing commas outside strings only; comments separate tokens, and unterminated comments fail parsing. URL and argument-array regression tests included. |
| Array postCreateCommand lost argument boundaries | Quote each array argument for the container shell. Install/start content travels as container environment values instead of duplicated shell interpolation. |
| Installer method could disagree with pnpm preview; Node-first installs used stale PATH | Derive the method from the exact command, refresh PATH before each step, reset exit status, and catch missing-command failures. Yarn is labelled Classic. |
| Junctions could read files outside the repository; SSH passwords were accepted | Resolve actual file locations before reading local files, README and setup material. Reject SSH URLs with embedded passwords. |
| Terminal startup reported success before asynchronous process errors | Wait for launcher outcomes, use system executables, encode fixed PowerShell instructions, and pass the repository path as an environment value. Regression tests simulate asynchronous errors and inspect quoting. |
| IPC and preview boundaries were broader than documented | IPC accepts only the main frames of app-owned windows loading the app page. Preview URLs must belong to a watched sandbox. Deny permission requests and preview popups; guard Settings navigation. |
| Settings accepted numeric fonts; valid JSON primitives could break startup | Validate string types and fall back to defaults for non-object files. Regression reproduced the issue before the fix. |
| Source launcher inherited Electron run-as-Node and hid startup failures | Clear the variable in a local batch environment, use the lockfile for dependencies, show failures and forward development arguments. Native start.bat startup verified. |
| Version and runtime prerequisites disagreed | Align package and lockfile at 1.4.0; require Node 22.12 or newer. Windows builds retain icon/version resource editing while remaining unsigned. |
| Renderer failure had weak recovery feedback | Show startup failures with recovery keys. Keep F5, Ctrl+Shift+R and F12 in the main process. DevTools can also be closed with its visible close control. |
| Grid controls overflowed beside pinned Settings at 125% scale | Wrap the grid toolbar and let cards fit narrow panes. Reproduced with the real Electron window, then added a desktop regression check. |
| Claude summaries inherited more tool/configuration access than necessary | Disable built-in tools, use empty strict MCP configuration and disable user/project setting sources. Material goes through stdin and output through sanitized Markdown. |

## Measured checks

| Status | Check | Evidence |
| --- | --- | --- |
| Passed | Original engine suite: 76 checks | Actual original execution, using disposable repositories. No screen-test file supporting the earlier “70 screen checks” report was present. |
| Passed | New engine suite: 82 checks | [Engine output](audit/engine-checks.txt); includes six bulk-update checks. |
| Passed | Regression suite: 18 tests | [Regression output](audit/regression-checks.txt); real Windows executable and junction fixtures, plus explicitly simulated Docker/terminal tests. |
| Passed | JavaScript syntax | [Syntax output](audit/syntax-checks.txt). No lint or TypeScript suite exists in the supplied project. |
| Passed | Real source Electron window: 16 automated checks | Preload/version, Indigo, floating/pinned/popout Settings, search, day/night, density/writing persistence, README sanitizer and image setting, 17 installer entries, preview rejection, reload, palette, grid, fonts and toolbar containment at 125% scale. See [desktop screenshot](audit/screenshots/desktop-grid.png) and [output](audit/desktop-checks.txt). |
| Passed | Native recovery shortcuts | Windows input tested with document/renderer listeners replaced by a failure fixture. F12 opened DevTools; F5 restored the actual app; full relaunch restores persisted fixture settings. This is not a test of a crashed GPU process. |
| Passed | Native start.bat launch and relaunch | Actual Windows Electron window; test data isolated under ignored `audit/local/`. |
| Passed | Dependency audit | `npm audit --json` reported zero vulnerabilities across 273 installed dependencies. This is not a guarantee of vulnerability absence. |
| Passed | WinGet catalog verification | All 12 IDs match Microsoft's live official manifests. [Sources](audit/installer-sources.json). |
| Passed | Windows packaging | Installer and portable x64 executable built locally. Dependencies and app archive inspected; no sibling projects included. |
| Passed | Packaged executable startup | Built executable launched on Windows and reported 1.4.0. Renderer exposes the IPC bridge without Node `require` or `process`. [Evidence](audit/packaged-checks.json), [screenshot](audit/screenshots/packaged-desktop.png), and [artifact checksums](audit/build-artifacts.json). All 19 runtime source files match the app archive byte for byte; package runtime metadata matches. |
| Blocked | Live Docker lifecycle | Docker executable is installed but the daemon is stopped. Resource flags, ownership, deadlines, extension and removal have simulated coverage, not a completed container run. |
| Untested | Real tool installations | No Git, Node/npm, pnpm, Yarn, Python, uv, Docker, Rust, Go, GitHub CLI, VS Code, Terminal or coding-agent installation was completed by the audit. Administrator/license prompts belong to the user. |
| Untested | Completed account authentication | No authentication was completed. GitHub CLI is missing; the app reports signed out. Claude/Codex/Gemini/Copilot rows report installation and explicitly do not verify their account sessions. |
| Untested | Live Claude summary and failure explanation | Prompt, stdin, tool restrictions and output rendering reviewed; no paid model request or agent account authentication was initiated. |
| Untested | Every display scale, narrow-window combination and keyboard shortcut | Selected layout and native recovery checks passed; an exhaustive display/accessibility matrix was not completed. |
| Untested | Real offline and authentication-failure network scenarios | Unavailable-remote failure tested on a disposable fixture; network and credential failures reviewed in error mapping. No real remote credentials were disturbed. |

## Official installation sources

WinGet package identifiers come from [Microsoft's package repository](https://github.com/microsoft/winget-pkgs); exact manifest links are in the JSON evidence above. CLI npm methods were checked against [pnpm installation](https://pnpm.io/installation), [Yarn installation guidance](https://yarnpkg.com/getting-started/install), [OpenAI Codex](https://github.com/openai/codex), [Gemini CLI](https://geminicli.com/docs/), [GitHub Copilot CLI](https://docs.github.com/en/copilot/get-started/cli-quickstart), and [Claude setup](https://code.claude.com/docs/en/setup). Claude tool/configuration flags follow its [CLI reference](https://code.claude.com/docs/en/cli-reference).

## Limitations and publication scope

Docker isolation is a container, with internet access and no host folder mounts. There is no microVM, public demo URL, network allowlist or browser-only sandbox. Supported devcontainer fields and unsupported multi-service/nested-build behavior are documented in README. Dockerfile builds are themselves untrusted code executed by Docker and can use network access.

Automatic cleanup depends on app/Docker availability. Normal exit attempts removal; full relaunch and crash recovery preserve deadlines. Neither stopped Docker nor a closed/crashed app can guarantee instant enforcement of a host timer. Installer completion and agent authentication require separate user-led checks.

Builds are unsigned. Source publication includes app source, icons, lockfile, launch/build scripts, tests, source-verification scripts, README and this audit. It excludes dependencies, local settings, caches, credentials, generated release executables and earlier versions. No license text was invented; existing package metadata says MIT but the supplied folder contains no license document.

Final staged review covered 45 files in the independent v1.4.0 Git repository. It found no detected credential patterns, personal absolute paths, dependency folders, release executables or sibling projects. All 27 original source hashes still matched. Git's staged whitespace check passed. Publication scope is the review branch; the existing `main` branch remains unchanged while live Docker testing is blocked by the stopped daemon.
