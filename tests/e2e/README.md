# Browser regression tests

The maintained runner is `tests/e2e/driving_code/drive_flow.py`. It serves the
source tree on the first available loopback port from 8000 through 9000, runs
the Playwright E2E groups, then runs the JavaScript unit harness in a second
page. Each invocation writes one self-contained HTML report to a unique,
git-ignored directory under `tests/e2e/results/`.

## Setup and local run

```bash
python3 -m venv .venv
.venv/bin/pip install --requirement requirements-dev.txt
.venv/bin/python -m playwright install chromium
.venv/bin/python tests/e2e/driving_code/drive_flow.py
```

Local runs use Playwright Chromium. CI selects Chromium, Firefox, WebKit,
Microsoft Edge, or Brave with `--browser`; WebKit is engine coverage and is not
described as native Safari. Useful options include `--headed`, `--files N`,
`--extra-files N`, `--data DIR`, `--url URL`, `--channel NAME`, `--skip-modeling`,
`--keep`, and `--all-media`. Media defaults to one representative item per group
plus every failure. The compatibility matrix uses `--skip-modeling`; scientific
modeling remains under its separate validation/readiness gate.

The source runner covers upload/FCS parsing, metadata, selection/filtering,
plotting and viewport tools, QC, peak review, model fitting, sidebar/layout,
statistics, sessions, and reset behavior. The unit-only entry point is:

`npm run test:audit` is the release-oriented audit regression. It runs every
source E2E group except the separately governed scientific-modeling UI group,
the complete browser unit harness, a production build, and the dist-only smoke.
Audit IDs such as `UI-14`, `DATA-02`, and `SES-03` remain in test names so a
failure maps directly to the remediation checklist.

```bash
.venv/bin/python tests/unit/driving_code/run_standalone.py
```

## Production artifact

Source-tree tests cannot detect missing or incorrectly hashed Vite assets. The
release gate separately builds and serves only `dist/`:

```bash
npm ci
npm run build
npm run check:dist
.venv/bin/python tests/e2e/driving_code/dist_smoke.py
```

The production smoke checks response failures, CSP headers, Help, icons, the web
manifest, the built FCS worker path, and absence of source-only `/js/` requests.

## Commit and CI behavior

Enable the tracked hook with `git config core.hooksPath .githooks`. The hook
warns when the working tree contains unstaged/untracked files, then runs the
small standard-library CI contract tests and the static supply-chain check. It
does not run the full browser suite and does not require a clean working tree.
Set `PHASEFINDER_TEST_PYTHON` when the desired Python executable is not
`.venv/bin/python` or `python3`. `--no-verify` bypasses the local hook, but the
required GitHub Actions checks still apply.

The test server returns 404 for `sessions/phasefinder_local.json` instead of
renaming or modifying any local session file. Concurrent runs therefore leave
the user's local state untouched.
