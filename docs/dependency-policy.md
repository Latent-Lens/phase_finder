# Dependency update policy

Dependabot opens weekly npm, Python, and GitHub Actions updates. Every update
must keep lockfiles/pins current and pass the normal build, browser, security,
privacy, and production-artifact checks. Major updates to Vite, D3, Playwright,
or a GitHub Action require explicit maintainer review of release notes,
compatibility impact, generated artifact changes, and rollback before merge.

Runtime libraries remain vendored or lockfile-resolved; do not add a runtime CDN
or an unpinned Git/action dependency. Security fixes may be expedited, but they
still require the same automated checks and a documented reviewer.
