# Release, artifact, and privacy policy

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
