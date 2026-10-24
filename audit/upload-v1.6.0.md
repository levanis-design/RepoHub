# RepoHub 1.6.0 source upload verification

This upload uses the supplied RepoHub-v1.6.0 source. It preserves the existing GitHub history, RepoHub.jpg, and its README image link. The original local app folder and earlier versions were not edited.

## Passed

- Clean `npm ci --no-audit --no-fund`: 286 packages installed from the supplied lockfile in an isolated upload checkout.
- Engine suite: 119 recorded passing checks on Windows, using disposable repositories. [Output](v1.6.0-engine-checks.txt).
- Regression suite: 18 tests passed, zero failed or skipped. [Output](v1.6.0-regression-checks.txt).
- Syntax validation: 25 JavaScript files passed. [Output](v1.6.0-syntax-checks.txt).
- Package and lockfile versions both read 1.6.0.
- Upload snapshot comparison: all 48 supplied source files matched before publication documentation was added; the README additionally retained the existing GitHub screenshot link.

## Scope and limits

This is a source upload, not a new Windows installer release or a complete feature audit. Native desktop checks, Windows packaging, live Docker lifecycle, real tool installations, account sign-in/out, and live Claude/GitMCP operations were not rerun for this upload. Earlier audit reports, screenshots and build checksums describe 1.4.0; they are historical evidence rather than new 1.6.0 results. The engine suite records 119 checks on Windows; two additional credential-helper fixture checks run only on non-Windows platforms, accounting for the README's 121-check total.

The staged-file review checks credential patterns, personal absolute paths, ignored folders and accidental deletions. One credential-shaped match was an explicitly generated alphabetic dummy in the engine test's disposable credential-helper fixture; it was reviewed and excluded by exact value only.

Dependencies, local settings, caches, credentials and generated executables are excluded from publication. No license text was added.
