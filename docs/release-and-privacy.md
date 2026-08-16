# Release, artifact, and privacy policy

## Toolchain pin

**Node 24.x — decided 2026-08-15 (ENV-01).** The pin moved from 22.x to 24.x.

`.nvmrc` is the single source of truth for the Node major version. Everything
else derives from it: `scripts/preflight.cjs` reads `.nvmrc` and rejects any
other major, and all four CI workflows (`node_build`, `security`,
`browser-compatibility`, `deploy-release`) select their runtime with
`node-version-file: .nvmrc`. Two files declare the version and must always be
changed together — `.nvmrc` and `engines.node` in `package.json` — plus the
Development section of `README.md`, which names the major in prose.

**Why 24 over 22.** Node 24 is the current Active LTS; 22 has moved to
maintenance and reaches end-of-life in April 2027. The audit trail records
successful builds under both 22.23.2 and 24, so validation history favours
neither. Keeping 22 would have meant pinning the older line purely because it
was already declared.

`packageManager` in `package.json` tracks the npm that ships with the pinned
Node major (24.16.0 ships npm 11.13.0). Nothing enforces it — there is no
corepack step — but `scripts/generate-provenance.cjs` falls back to it when the
script runs outside an npm invocation, so a stale value would record the wrong
npm version in release provenance. Update it whenever the Node pin moves.

Contributors run `nvm use` in the checkout. Declared and installed versions must
never be left disagreeing — that state blocks `npm run check` entirely, because
the gate begins with `npm run preflight`.

**Verified on 24:** `npm run check` exits 0 end to end — preflight, lint, DOM
bindings, documents, import graph, privacy scan, 25 CI tests, 756/756 browser
unit checks, production build with provenance, and artifact verification. The
switch was made before the browser suites could run (they were blocked by
ENV-02) and confirmed in full once that was fixed, both on 2026-08-15.

## Release-note script contract

`.github/scripts/update_release_notes.sh <tag> [dry-run]` requires an existing
Git tag and a checkout with tag history. It reads commits since the preceding
tag and writes temporary Markdown/CSS files under the system temporary
directory. With `dry-run=true` it writes the ignored
`release-notes-preview.html` in the checkout and may append to
`GITHUB_STEP_SUMMARY`; it does not change Git or GitHub. With `dry-run=false`
it requires `gh`, network access, and `GH_TOKEN`, and updates only the named
GitHub release through `gh release edit`. The script does not commit or push.

Production deployment is fail-closed. The protected `production` environment
must approve the deployment and the repository/environment variable
`ENABLE_PRODUCTION_DEPLOY` must equal `true`. The build and release-note jobs
still run while deployment is disabled, allowing the exact artifact to be
reviewed safely.

`package.json` is the application-version source of truth. Preflight requires
the lockfile to match it and requires a release tag to be exactly `v<version>`.
Production `build-metadata.json` and the SBOM derive their version from the same
package field. The package license identifier, root license text, and vendored
D3 notice are checked together before a release build.

## Artifact URL policy

HTML entry assets and module imports are Vite-managed and hashed. The favicon
directory, web manifest, manifest icons, and `_headers` intentionally retain
stable public URLs because browsers and Cloudflare request them outside the
JavaScript import graph. Runtime panel icons use `new URL(...,
import.meta.url)` and are Vite-managed. `BASE_PATH` is the supported way to
build for a non-root deployment.

## Local/private-file inventory

| Path | Classification | Policy |
| --- | --- | --- |
| `sessions/phasefinder_local.json` | private active autoload configuration | ignored and absent from Git/deployments |
| `sessions/phasefinder_session_*.toml` | private experiment/session state | ignored and absent from Git/deployments |
| `sessions/*.example.json`, `sessions/*.example.toml` | public synthetic templates | may be tracked; must contain no real identifiers |
| `.codex/`, `.claude/` | private local AI-tool configuration | ignored and absent from Git/deployments |
| `tests/e2e/results/`, `tests/validation/results/` | generated local test output | ignored and absent from deployments |
| `tests/validation/validation_test_data/external_fcs/` | explicitly reviewed validation material | source-test only; never copied to `dist/` |

The current private session/tool files were removed from the Git index without
deleting local working copies. Rewriting shared history is an owner decision:
first review existing clones/releases, notify collaborators, rotate any exposed
credentials or identifiers, then use a coordinated `git filter-repo` migration
only with explicit approval.

## Rollback

Cloudflare Pages retains immutable deployments. Before enabling production,
record the current production deployment ID from `wrangler pages deployment
list --project-name=phasefinder`. To roll back, select that reviewed deployment
in the Cloudflare dashboard and choose **Rollback to this deployment**, then
disable `ENABLE_PRODUCTION_DEPLOY` until the incident is resolved. Never rebuild
an old tag as a substitute for rollback; redeploy or promote the exact archived
artifact and verify its `SHA256SUMS` first.

## Logo inspection

`assets/img/logo.png` is a 1593×331, 418,603-byte RGBA PNG rendered at no more
than 260 CSS pixels wide (over 6 source pixels per CSS pixel). Resizing it to a
2× display asset would save transfer size, but that binary change is deferred
until a screenshot comparison can prove there is no visual regression.
