# PhaseFinder full project audit — remediation and optimization checklist

This is the implementation amendment to [the full Codex HTML audit](./codex_audit_of_full_project.html). It converts the audit findings into work items that another engineering agent can implement and verify.

Audit snapshot: **2026-07-24**, branch **`cell-cycle-modeling-sidebar`**, base commit **`2af7969`**, including the uncommitted peak-tracking Time QC work that was present during the review.

> This checklist describes the audited snapshot. Before changing an item, reproduce it against the current working tree. If later work has already corrected it, do not reimplement it: add the missing regression test, record the evidence, and then mark the item complete.

## How to use this checklist

- Keep the issue ID in commit messages and pull-request descriptions, for example `fix(SCI-02): guarantee G2:G1 bounds`.
- Prefer one independently testable issue per commit. Closely coupled items may share a pull request, but their tests and acceptance criteria remain separate.
- Do not mark an item complete because the visible symptom disappeared. Mark it complete only after its implementation, regression tests, and acceptance criteria are satisfied.
- Preserve unrelated work already present in the dirty working tree. Do not revert or overwrite another agent's edits.
- For scientific behavior, capture a before/after numeric fixture and explain why the new result is scientifically preferable. A UI-only snapshot is not sufficient.
- Treat changes to session formats, cache ownership, FCS interpretation, and model output as migrations. Maintain backward compatibility where practical and explicitly version any intentional incompatibility.
- Run source-tree tests and production-`dist/` tests. A source-only pass does not establish that the deployed site works.

### Priority legend

- **P0 — release/scientific blocker:** fix before any public production release or scientific reliance.
- **P1 — high priority:** can change analysis results, lose reproducibility, hide failures, or block supported users.
- **P2 — medium priority:** robustness, accessibility, security hardening, or important maintainability work.
- **P3 — improvement:** optimization, documentation, developer experience, or future-proofing.

## Global preparation and definition of done

### PREP-01 — Establish a stable baseline before remediation

**Problem:** The audited working tree contained active, uncommitted Time QC and modeling UI work. Multiple agents editing the same files without a recorded baseline can invalidate comparisons or overwrite work.

**Affected areas:** the entire repository, especially `js/analysis/`, `js/plotting/`, `js/session/`, `tests/`, and `index.html`.

- [ ] Record the current branch, commit, `git status --short`, Node version, Python version, and Playwright version in the implementation pull request.
- [x] Identify which existing modified/untracked files belong to another in-progress task and avoid changing them unless the assigned issue requires it. *(The 190-path shared dirty tree was inventoried; scientific/UI changes outside the release/privacy scope were preserved.)*
- [x] Run the browser unit harness and record the baseline result; the audited snapshot passed 415/415 unit checks. *(The later pre-PREP baseline is preserved in `docs/audits/baselines/browser_unit_baseline_2026-07-28.md`: 607/608 passed, with the single Session TOML setup failure recorded rather than hidden.)*
- [ ] Run the isolated full source-tree Playwright suite and record the baseline result; the audited snapshot passed 596/596 combined checks.
- [ ] Build with the intended Node version and archive a manifest of every path in `dist/` for before/after comparison.
- [x] Save representative numeric outputs for DJ, DJF, Auto, Watson, Time QC, scatter QC, and singlet QC fixtures before changing scientific code. *(The pre-remediation 2026-07-24 Chromium outputs and source-result hashes are preserved in `docs/audits/baselines/scientific_numeric_baseline_2026-07-24.json`.)*
- [x] Confirm the personal local-session autoload file is restored after every test run and that no `.e2e_suspended` file remains. *(Verified 2026-07-28: the ignored personal files remain present; no suspended file exists.)*

### PREP-02 — Apply one shared definition of done

- [x] The fix has a regression test that fails on the audited behavior and passes after the implementation. *(The artifact crawler rejected the old raw source-prefetch/broken manifest build and passed after the fixes.)*
- [ ] Existing source-tree unit and end-to-end tests pass without converting failures into warnings.
- [ ] The Vite production build succeeds from a clean dependency install.
- [ ] A smoke suite served from `dist/` passes, including Help, panel icons, web manifest, workers, plotting, and one model fit.
- [x] New errors are surfaced to the user with actionable text and are not silently treated as success. *(Preflight, privacy, provenance, crawler, and budget failures name the remediation target.)*
- [ ] Scientific result changes are documented with expected tolerances and reviewed against an independent calculation where available.
- [ ] Accessibility changes are verified by keyboard and an accessibility-tree or screen-reader check, not only visual inspection.
- [x] Documentation, help text, release notes, and supported-version declarations are updated with the code. *(README, release/privacy policy, license, third-party notice, and Node declarations updated.)*
- [x] No private session data, local paths, AI-tool configuration, test exports, or generated build output is accidentally staged. *(`npm run check:privacy` passed; private files are staged only for removal and generated builds remain ignored.)*

---

## 1. Release safety, production build, and privacy

### REL-01 / PRIV-01 — Repair the unsafe Cloudflare release workflow

**Priority:** P0

**Problem:** `.github/workflows/deploy-release.yml` calls `scripts/update-release-notes.sh`, while the repository script is `.github/scripts/update_release_notes.sh`. The workflow does not install Node or build the site. If only the script path were corrected, `pages deploy .` would publish the repository root, including source, tests, internal documentation, and tracked session/config metadata.

**Affected files:** `.github/workflows/deploy-release.yml`, `.github/scripts/update_release_notes.sh`, `package.json`, the Node version pin, and Cloudflare configuration.

- [x] Inspect `.github/scripts/update_release_notes.sh` and document its exact arguments, outputs, required permissions, and whether it modifies the checkout. *(Contract recorded in `docs/release-and-privacy.md`.)*
- [x] Disable the release trigger or add an intentional failing containment guard until the complete production artifact and release gates are ready. *(Production deploy is fail-closed behind `ENABLE_PRODUCTION_DEPLOY=true`.)*
- [x] Correct the workflow path and filename rather than adding a second duplicate release script.
- [x] Pass release tags through an environment variable, validate that the tag exists and is permitted, and avoid interpolating workflow input directly into shell source.
- [x] Set up the repository-pinned Node version before running any npm command.
- [x] Install from the committed lockfile with `npm ci`; fail if the lockfile is absent or out of sync.
- [x] Run the required test command before deployment and make any skipped unit phase a hard failure.
- [x] Run `npm run build` and fail if `dist/index.html`, `dist/help.html`, required runtime icons, workers, or manifest icons are absent.
- [x] Upload `dist/` as a workflow artifact so the exact deployed content is reviewable.
- [x] Change the Cloudflare command to deploy exactly `dist`, never `.` or an unresolved variable.
- [x] Add a workflow check that rejects files outside an explicit production allowlist or unexpectedly exposes `sessions/`, `.codex/`, `tests/`, `.git/`, or local environment files.
- [x] Reduce `permissions` to the minimum the release-note and deployment steps actually require; separate note generation and deployment jobs if their permissions differ.
- [x] Add workflow concurrency so an older release cannot finish after and overwrite a newer release.
- [x] Add an environment/protected approval for production while the release pipeline is being stabilized.
- [ ] Run `workflow_dispatch` against a staging Cloudflare Pages project and inspect the deployed file list and headers.
- [ ] Publish a test release and verify the public URL, Help link, panel icons, manifest, worker-based FCS parsing, and a model fit.
- [ ] Record rollback instructions and the last known-good Cloudflare deployment identifier.

### PRIV-02 — Remove personal session and local-tool material from publication paths

**Priority:** P0 when combined with root deployment; otherwise P1

**Problem:** `sessions/phasefinder_local.json`, `sessions/phasefinder_session_20260705.toml`, and `.codex/config.toml` are tracked. The session TOML includes experiment filenames, annotations, sizes, timestamps, and OPFS identifiers. `js/session/core.js` comments incorrectly say the local config is never committed.

**Affected files:** `.gitignore`, `sessions/`, `.codex/`, `js/session/core.js`, release workflow, repository history.

- [x] Inventory every tracked file under `sessions/`, `.codex/`, `.claude/`, test results, and local configuration directories. *(The inventory is enforced by `check-privacy.cjs` and documented in `docs/release-and-privacy.md`.)*
- [x] Classify each file as public example data, required application data, or private/local-only material.
- [x] Replace useful local examples with explicitly synthetic, nonidentifying `.example` files. *(`sessions/phasefinder_local.example.json` is the only retained session template.)*
- [x] Add active local-session filenames and `.codex/` to `.gitignore` while preserving any intentionally public templates with negated rules.
- [x] Remove private/local-only files from the current Git index without deleting the user's local copy.
- [x] Update `js/session/core.js` comments and documentation so they match the actual ignore/tracking policy.
- [x] Add a CI secret/privacy scan that rejects OPFS IDs, local absolute paths, active-session filenames, non-E2E FCS sample names, and known local-tool directories in deployable content. *(`npm run check:privacy`; explicit E2E filename examples remain allowed.)*
- [ ] Decide with the repository owner whether history rewriting is required. Do not rewrite shared Git history automatically; create a reviewed migration/notification plan first.
- [ ] Verify a fresh clone contains only synthetic examples and starts without silently autoloading a personal session.
- [ ] Verify the Cloudflare artifact contains none of the removed paths or metadata.

### REL-02 — Make the Vite production artifact complete

**Priority:** P0

**Problem:** Vite treats only `index.html` as an input. The live Help link points to `help.html`, but `dist/help.html` is absent. Runtime-swapped sidebar/table icons are string paths Vite does not discover, and the web manifest points to root-level Android icons that are not emitted.

**Affected files:** `vite.config.js`, `index.html`, `help.html`, `js/ui/dom.js`, `js/ui/panels.js`, `assets/img/favicon/site.webmanifest`, asset directories.

- [x] Configure `index.html` and `help.html` as explicit Vite multi-page inputs.
- [x] Decide which assets require stable public URLs and which should be imported/hashed by Vite. *(Policy recorded in `docs/release-and-privacy.md`.)*
- [x] Replace runtime string literals for `sidepanel_open.svg`, `sidepanel_close.svg`, `table_restore.svg`, and `table_minimize.svg` with imported URLs or `new URL(path, import.meta.url)`.
- [x] Alternatively place intentionally stable runtime assets under `public/` and use one documented base-safe path convention. *(N/A: the documented Vite-managed option above was chosen; only `_headers` is copied from `public/`.)*
- [x] Correct manifest icon URLs and ensure both Android icons are emitted at those URLs.
- [x] Make favicon and manifest URLs respect the configured deployment base instead of assuming domain root unless root-only hosting is an explicit requirement.
- [x] Remove the hand-authored raw `modulepreload` for `js/main.js`; allow Vite to generate the bundled entry preload graph.
- [x] Confirm no raw `main-*.js` preload asset with unresolved source-module imports remains in `dist/`. *(The raw pipeline prefetch was removed; the production crawler passed on the Node 24 validation build.)*
- [x] Add a post-build asset crawler that follows local `href`, `src`, JavaScript imports, manifest icons, and CSS URLs and fails on missing targets. *(`scripts/verify-dist.cjs`.)*
- [ ] Serve `dist/` locally and exercise Help plus every panel collapse/restore transition.
- [ ] Verify the manifest and installation icons in browser developer tools with no 404s.
- [x] Add regression coverage for both root deployment and the supported non-root/base-path behavior. *(`npm run check:dist` and `npm run check:base` both passed on 2026-07-28 under supported Node 24.)*

### REL-03 — Pin and document the Node/npm toolchain

**Priority:** P1

**Problem:** Vite 8 fails under Node 18.19.1 but `package.json` has no `engines` declaration or committed Node pin. The repository also lacks a conventional npm test contract.

**Affected files:** `package.json`, `package-lock.json`, `.nvmrc` or `.node-version`, README, workflows.

- [x] Choose a supported Node LTS/current line that satisfies Vite 8 (`^20.19.0 || >=22.12.0`); prefer one version used consistently in local development, Actions, and Cloudflare.
- [x] Add `engines.node` and, if desired, `engines.npm` to `package.json`.
- [x] Commit a single Node version pin such as `.nvmrc` or `.node-version` and configure Cloudflare to use the same version.
- [x] Commit and maintain the npm lockfile; use `npm ci` in automation.
- [x] Add scripts for the supported checks, for example `test:unit`, `test:e2e`, `test:dist`, `test`, and `check`.
- [x] Make scripts invoke repository-relative/configurable Python rather than a developer-specific hard-coded environment.
- [x] Mark the npm package `private` if it is not published and remove the nonexistent/stale `main: index.js` entry.
- [x] Reconcile package version, release version, and the claimed ISC license; add the actual repository license. *(Package/lock are 0.7.0 and ISC; `LICENSE` added.)*
- [x] Record the vendored D3 source, version, hash, and license in a third-party notice. *(`THIRD_PARTY_NOTICES.md`.)*
- [x] Add a preflight script that prints useful remediation when Node is unsupported.
- [x] Update README setup instructions for install, source development, build, preview, and tests.
- [ ] Verify a fresh clone can run `npm ci`, `npm test`, `npm run build`, and `npm run preview` without undocumented manual steps.

### BUILD-01 — Add production artifact budgets and integrity checks

**Priority:** P2 improvement

**Problem:** A successful bundler exit currently says nothing about missing pages/assets, unexpected source exposure, duplicate preloads, or growth in the roughly 431 kB main JavaScript bundle.

- [x] Generate a machine-readable `dist` manifest containing paths, sizes, and hashes after every build. *(`artifact-manifest.json`, generated by `npm run provenance`.)*
- [x] Define warning and failure budgets for the main JS, CSS, largest image, total compressed transfer, and total uncompressed artifact. *(`config/artifact-budgets.json`; warnings begin at 90%.)*
- [x] Fail when source maps, sessions, tests, local configuration, or unexpected file extensions enter production output.
- [x] Fail when a required application page, worker, icon, or manifest target is missing.
- [x] Track build-size deltas in pull requests rather than only absolute limits. *(`security.yml` builds the base and current artifacts and writes their delta to the job summary.)*
- [x] Inspect whether the 418 kB logo can be safely recompressed/resized for its rendered dimensions without visual regression. *(1593×331 rendered at ≤260 px; resize deferred pending screenshot comparison, documented in `docs/release-and-privacy.md`.)*
- [x] Verify cache headers distinguish hashed immutable assets from HTML/manifest files that must revalidate. *(`public/_headers`, enforced by `verify-dist.cjs`.)*

---

## 2. Scientific model correctness and result consistency

### SCI-01 — Restrict Watson residual S phase to the intended interval

**Priority:** P0

**Problem:** `js/analysis/cell_cycle/models/watson_pragmatic.js` sums `max(0, observed - G1 - G2)` over every bin. Sub-G1 debris, background, and post-G2 aggregates therefore become S phase. The modeling plan limits residual S to the interval between the fitted G1 and G2 centers.

**Affected files:** `js/analysis/cell_cycle/models/watson_pragmatic.js`, Watson unit tests, model help/report text, `docs/plans/cell_cycle_modeling_plan.md`.

**Status (2026-07-28, done):** The residual-S restriction is enforced in `watson_pragmatic.js`: `sCounts` returns 0 for any bin whose center is at or outside a fitted peak center, so residual S lives strictly in the open interval `(mu_G1, mu_G2)`. Boundary rule: a whole bin is in-interval iff its center is strictly between the two fitted centers (`center <= g1.mean || center >= g2.mean` → 0), so no fractional edge bins are integrated; sub-G1 debris and post-G2 aggregate mass can never be reclassified as S. Watson models no separate debris/aggregate component (`capabilities.contaminants: false`); the help text now states this and the exact interval. Tests in `tests/unit/driving_code/unit_tests_cell_cycle_watson_pragmatic.py`: strong sub-G1 debris + post-G2 aggregate leave %S near the clean level; every nonzero S bin lies strictly between the centers; a **planted bridge is quantitatively recovered within 5%** (observed 0.46%); the no-S test is tightened to `< 0.6%` of biological mass (~66 events, rejecting the previously-accepted ~145); and phase fractions are asserted finite, nonnegative, and summing to one. 593/594 unit checks pass (the 1 failure is the parallel session-TOML refactor, unrelated).

- [x] Define the exact inclusive/exclusive S integration boundaries and how fractional edge bins are handled. *(whole-bin, exclusive at both fitted centers via a bin-center test; no fractional-bin integration — documented in code and help.)*
- [x] Restrict residual S construction and area integration to that interval.
- [x] Ensure residual values outside the S interval are zero or separately labeled contamination, not phase mass. *(returns 0 outside the interval.)*
- [x] Decide how modeled debris/aggregate components interact with Watson and document the decision. *(Watson has no debris/aggregate component; contaminants must sit outside the G1–G2/M interval — stated in help text.)*
- [x] Preserve nonnegative, finite residual values within the accepted interval. *(`max(0, …)`; asserted finite+nonnegative per bin.)*
- [x] Add a fixture with only G1/G2 peaks and strong sub-G1 debris; assert debris does not increase %S.
- [x] Add a fixture with strong post-G2 aggregate signal; assert aggregate signal does not increase %S.
- [x] Add a planted bridge with known S area and assert quantitative recovery within a documented tolerance, rather than only checking “clearly nonzero.” *(recovers 3200 planted events within 5%; observed 0.46%.)*
- [x] Tighten the existing no-S test so a residual near 145 events is not automatically accepted without a relative tolerance rationale. *(bound is 0.6% of biological mass ≈ 66 events, with documented rationale; explicitly also `< 145`.)*
- [x] Confirm phase fractions remain finite, nonnegative, and sum to one after the correction.
- [x] Update UI/help text to state that Watson is a pragmatic decomposition and identify the exact S interval.

### SCI-02 — Guarantee G2:G1 mean-ratio constraints

**Priority:** P0

**Problem:** `project_means` independently clamps G1 and G2, adjusts G2 for the ratio, then reclamps it to the G2 region. The final clamp can reintroduce a ratio violation.

**Affected files:** `js/analysis/cell_cycle/models/dean_jett.js`, `dean_jett_fox.js`, shared constraint helpers, fit tests.

- [x] Write a shared feasibility/projection specification for free, bounded-ratio, and locked-ratio modes.
- [x] Implement one joint `(mu1, mu2)` projection onto the intersection of both peak regions and the ratio interval, or use a smooth transformed parameterization that is feasible by construction.
- [x] Use the same implementation in DJ and DJF; remove duplicated constraint logic.
- [x] Return an explicit infeasible-constraints error when the intersection is empty instead of silently selecting an invalid point.
- [ ] Validate every initial start, every projected optimizer step, and every final normalized result against all configured bounds.
- [x] Add the adversarial example G1 `[1,10]`, G2 `[18,20]`, ratio `[1.65,2.25]`, proposed G1 `1`; assert the result is feasible or explicitly rejected.
- [x] Add randomized/property tests over region and ratio combinations, checking constraints to a documented floating-point tolerance.
- [x] Add locked-ratio tests at both region boundaries and infeasible locked-ratio tests.
- [x] Surface an actionable UI error that identifies which regions/ratio are incompatible.
- [x] Confirm existing valid-fit fixtures retain expected fractions within tolerance.

### SCI-03 — Make convergence criteria and reasons truthful

**Priority:** P0

**Problem:** `js/analysis/cell_cycle/math/lm_solver.js` declares convergence when relative improvement is small **or** the step is small, but labels the termination `relative_deviance_and_step`. A stalled or ill-conditioned fit can be presented as converged.

- [ ] Define separate termination states for objective tolerance, step tolerance, gradient tolerance, boundary stall, numerical failure, and maximum iterations.
- [ ] Decide which combination constitutes scientific “converged”; require both objective and step criteria unless a justified alternative is documented.
- [ ] Add a scaled gradient or first-order optimality criterion.
- [ ] Record the last accepted/rejected step, damping value, objective change, step norm, gradient norm, and iteration count in diagnostics.
- [ ] Rename termination reasons so each describes the condition that actually occurred.
- [ ] Prevent normalization/UI code from converting a stalled or numerical-failure result into `converged: true`.
- [ ] Add tests where improvement is small but step is large, and where step is small but the gradient/objective remains poor.
- [ ] Add ill-conditioned and boundary-stall fixtures that must not receive the ordinary converged label.
- [ ] Show nonconvergence prominently in sidebar/table/export and disable authoritative phase reporting unless the user explicitly reviews it.
- [ ] Benchmark any stricter criteria against existing good fits to avoid excessive false nonconvergence.

### SCI-04 — Require valid candidates in automatic DJ/DJF selection

**Priority:** P0

**Problem:** `model_selection.js` explicitly requires DJF convergence but does not require the Dean–Jett baseline to converge before comparing BIC. Auto can select Fox against an invalid baseline or retain a nonconverged DJ.

- [x] Define a shared candidate-validity predicate covering convergence, finite objective/metrics, satisfied constraints, acceptable tail mass, and required diagnostics.
- [x] Apply the predicate to both DJ and DJF before calculating or interpreting model-selection deltas.
- [x] Return a typed `no_valid_model` result when neither candidate is valid.
- [x] If only one candidate is valid, document whether Auto may select it without an information-criterion comparison and label that policy in the result.
- [x] Do not display a BIC preference when either metric is missing/nonstandard for the comparison.
- [x] Add tests for: invalid DJ + valid DJF, valid DJ + invalid DJF, both invalid, and both valid.
- [x] Add a UI state for “No valid automatic model” with candidate-specific reasons and remediation suggestions.
- [x] Ensure bulk fitting counts `no_valid_model` once per sample and does not publish stale prior results.

### SCI-05 — Use one canonical phase-fraction result everywhere

**Priority:** P0

**Problem:** `js/plotting/render.js` recomputes fractions from component mass visible within the plotted histogram, while the sidebar and metadata table use canonical `fit.phaseFractions`. Large tail mass can make the same fit show different percentages.

**Affected files:** `js/plotting/render.js`, `js/analysis/cell_cycle/modeling_ui.js`, `js/ui/cell_cycle_columns.js`, export/session/report code.

- [x] Define `fit.phaseFractions` as the sole authoritative %G1/%S/%G2 contract.
- [x] Change plot labels/readouts to consume the canonical values directly.
- [x] If visible-domain component fractions remain useful, expose them under a different diagnostic name and label them explicitly as domain-limited.
- [x] Audit sidebar, table, tooltips, plot legend, downloaded plots, TSV, session restore, and debug API for independent recomputation.
- [ ] Add one cross-surface test asserting identical displayed fractions for a fit with meaningful modeled tail mass.
- [x] Add formatting/rounding tests so displayed values sum sensibly without altering stored full-precision fractions.
- [ ] Verify restored/recomputed sessions reproduce the same canonical values across every consumer.

### SCI-06 — Make bulk region sharing scientifically safe

**Priority:** P0/P1

**Problem:** Auto-Fit All averages absolute G1/G2 region bounds across all samples, including inferred or low-confidence proposals, without confirming common channel calibration. One atypical file can bias every fit.

**Affected files:** `js/analysis/cell_cycle/modeling_ui.js`, peak-region state, channel metadata, bulk-fit UI/tests.

- [x] Define what proves samples share a comparable DNA axis: channel identity, `$PnR`, amplification/scaling, compensation state, instrument settings, and/or an explicit normalized coordinate system.
- [x] Refuse absolute-bound sharing when compatibility cannot be established.
- [x] Exclude failed, inferred-only, or below-threshold peak detections from the shared estimate.
- [x] Use robust estimates such as median normalized centers/widths rather than arithmetic means of absolute boundaries.
- [x] Show the samples included/excluded and the proposed shared regions before fitting.
- [x] Reuse the explicit warning/review used by manual Apply All instead of bypassing it.
- [x] Allow users to fit independently when calibration differs.
- [x] Add mixed-scale fixtures proving the workflow blocks unsafe sharing.
- [x] Add one outlier-region fixture proving the robust proposal is not dragged by the outlier.
- [x] Store the calibration evidence and shared-region provenance with each bulk result.

### SCI-07 — Improve optimizer conditioning and parameterization

**Priority:** P1

**Problem:** Areas, intensities, CVs, ratios, and shape parameters with very different scales are optimized directly with hard clipping, finite differences, and normal equations. This is fragile on real data even when ideal synthetic fixtures pass.

- [x] Define dimensionless optimizer coordinates for every parameter.
- [x] Use log transforms for positive areas/scales, logit or bounded smooth transforms for finite intervals, and scale-relative coordinates for means/widths.
- [x] Replace hard nonsmooth projection where feasible with mappings that satisfy constraints by construction.
- [x] Scale finite-difference steps in transformed coordinates and document their relative magnitude.
- [x] Replace or supplement normal-equation solving with QR/SVD or report condition numbers/rank failures.
- [x] Add diagnostics for parameter scaling, Jacobian conditioning, active bounds, and identifiability.
- [ ] Compare convergence rate, restart dispersion, runtime, and recovered parameters on existing fixtures before/after.
- [ ] Add stress fixtures spanning low/high event counts, channel ranges, overlapping peaks, weak S, high debris, and near-bound parameters.
- [x] Preserve deterministic results for identical inputs/settings.

### SCI-08 — Constrain the quadratic S profile without arbitrary shrinking

**Priority:** P1

**Problem:** `models/shared.js` clips shape terms and repeatedly multiplies both by `0.7` until the profile is positive. This undocumented nonsmooth repair changes the model shape and optimizer surface.

- [x] State the mathematical positivity requirement for the normalized quadratic on `z in [0,1]`.
- [x] Derive a feasible parameterization or exact feasibility test for the quadratic coefficients.
- [x] Reject infeasible candidates or transform unconstrained parameters into the feasible region; do not use iterative magic-number shrinking.
- [x] Remove or justify the independent `±8` clipping constants.
- [x] Add boundary tests for profiles touching zero, strictly positive profiles, and invalid negative interiors/endpoints.
- [x] Verify quadrature normalization and nonnegative expected counts across randomized feasible shapes.
- [ ] Compare fitted phase fractions before/after on reference fixtures and explain intentional changes.

### SCI-09 — Harden heuristic QC stages

**Priority:** P1/P2

**Problem:** Automated scatter selection, raw-unit pulse-geometry PCA, and median-filled missing peak tracks are useful heuristics, but each can hide or misclassify biologically meaningful structure. Complete SCI-09A through SCI-09C as one reviewed QC-hardening program while preserving their separate tests and provenance.

### SCI-09A — Strengthen scatter-gate population selection

**Priority:** P1/P2

**Problem:** The two-component scatter GMM operates in raw FSC/SSC units and selects a substantial component with the greatest FSC. Large doublets, G2-rich cells, or instrument scaling can violate that heuristic.

- [x] Decide and document supported FSC/SSC transforms and standardization before GMM fitting.
- [x] Fit/score in standardized or scientifically justified transformed coordinates.
- [x] Add component quality checks for weight, covariance conditioning, density/compactness, and separation.
- [x] Treat ambiguous component selection as review-required instead of silently authoritative.
- [x] Expose selected-component evidence and alternative component metrics in the gate modal.
- [x] Add fixtures for debris-dominant, doublet-dominant, overlapping, and differently scaled populations.
- [x] Confirm manual gate edits remain the explicit authoritative override and are recorded in session provenance.

### SCI-09B — Normalize pulse-geometry PCA

**Priority:** P1/P2

**Problem:** Singlet gating prefers A/H over A/W and performs PCA on unstandardized raw channels. Gain and scale changes alter PCA orientation and orthogonal distance.

- [x] Define the channel-pair selection policy when both A/H and A/W exist, including data-quality criteria rather than a fixed preference alone.
- [x] Center and robustly scale axes, or use a ratio/log-ratio model justified for pulse geometry.
- [x] Store the transform and scaling parameters with gate diagnostics/session provenance.
- [x] Add fixtures with identical geometry under different channel gains; assert equivalent retained masks within tolerance.
- [x] Add doublet/singlet mixtures and quantify sensitivity/specificity against labeled synthetic truth.
- [x] Warn and require review when covariance/line fit is poorly identified.

### SCI-09C — Treat missing peak tracks as evidence, not neutral data

**Priority:** P1

**Problem:** Peak-tracking Time QC fills a missing track position with the track median. A disappearing population can therefore look perfectly stable.

**Affected file:** `js/analysis/peak_tracking_time_qc.js`, settings/UI/session/tests.

- [x] Retain an explicit missing/imputed mask for every track/bin.
- [x] Add missingness prevalence and consecutive-gap features to anomaly scoring.
- [x] Define when track disappearance rejects bins, produces a warning, or invalidates the method.
- [x] Distinguish a peak below detection threshold from a failed density estimate where possible.
- [x] Show missing/imputed track intervals in diagnostics and explain the decision.
- [x] Add a stable two-mode fixture where one mode disappears temporarily; assert the interval is not neutralized.
- [x] Add random isolated misses and confirm they do not cause excessive false rejection.
- [x] Version the algorithm/session configuration if behavior changes materially.

### SCI-10 — Standardize likelihood, AIC, and BIC reporting

**Priority:** P2

**Problem:** The reported Poisson log-likelihood omits `log(y!)`. This constant cancels for same-histogram model deltas, but absolute likelihood/AIC/BIC are nonstandard and cannot be compared across samples or tools.

- [x] Decide whether metrics are intended only for within-histogram deltas or as standard absolute values.
- [x] If absolute, include a numerically stable `lgamma(y + 1)` term and verify AIC/BIC definitions and parameter counts.
- [x] If retaining the constant-free form, rename fields/UI labels to make the restricted interpretation unmistakable. *(Not applicable: the standard absolute form is now used.)*
- [x] Prevent cross-sample sorting/comparison of noncomparable values.
- [x] Add hand-calculated small-count fixtures for likelihood, deviance, AIC, and BIC.
- [x] Add a test proving within-histogram delta rankings remain unchanged by inclusion of the constant.
- [x] Document which metrics are comparable across models, histograms, and external tools.

### SCI-11 — Require a material residual-structure improvement

**Priority:** P2

**Problem:** Auto selection treats any decrease in absolute lag-1 residual autocorrelation as improvement, even floating-point noise, while descriptions imply a material improvement.

- [x] Define an absolute and/or relative minimum improvement threshold from reference data.
- [x] Include reduced deviance or another residual diagnostic only if the selection rule actually evaluates it.
- [x] Make the criterion detail string report the exact metric and threshold used.
- [x] Add tests for no change, numerical-noise change, just-below threshold, and just-above threshold.
- [x] Calibrate the threshold against DJ-like and genuinely Fox-broadened reference cases.

### SCI-12 — Correct acquisition-rate estimation

**Priority:** P3 unless short bins are common

**Problem:** Acquisition-rate QC uses `n / duration`; `n` timestamps span `n - 1` event intervals, producing a small systematic bias.

**Affected files:** `js/analysis/acquisition_time_qc.js`, `js/analysis/peak_tracking_time_qc.js`.

- [x] Replace the estimator with `(n - 1) / (t_last - t_first)` when `n >= 2` and duration is positive.
- [x] Define fallback behavior for one event, duplicate timestamps, and zero duration.
- [x] Audit threshold calibration to determine whether the estimator change requires versioning.
- [x] Add exact constant-rate fixtures for short and long bins.
- [x] Confirm float32 timer jitter and rollover tests still pass.

### SCI-13 — Make configurable peak-width math internally consistent

**Priority:** P3

**Problem:** Overall width uses a configurable relative-height threshold while left/right sigma conversion assumes half-height. The default `0.5` masks the inconsistency.

- [x] Derive the Gaussian sigma conversion for arbitrary configured height fraction.
- [x] Use the same configured fraction for overall and side-specific widths.
- [x] Validate the allowed fraction range and numerical stability near 0 or 1.
- [x] Add analytic Gaussian tests at 0.25, 0.5, 0.6, and 0.75 relative height.
- [x] Confirm the default 0.5 result remains unchanged within floating-point tolerance.

### SCI-14 — Resolve canonical versus legacy model paths

**Priority:** P2

**Problem:** `cell_cycle_pipeline.js` still runs legacy stages 5–8 while canonical DJ/DJF/Watson fitting uses separate modeling state. It is easy for code, UI, session, or documentation to consume the wrong result.

- [x] Inventory every producer and consumer of legacy stage 5–8 fit/report data and canonical modeling results.
- [x] Declare one authoritative model-result contract.
- [x] Migrate required legacy consumers or isolate the bridge behind an explicitly named compatibility adapter.
- [x] Deprecate/remove unreachable legacy UI and stale DOM bindings after verifying no session compatibility dependency remains.
- [x] Add tests that reject accidental use of legacy output in canonical table/plot/export paths.
- [x] Document the migration and any session-version implications.

### VALID-01 — Establish independent scientific validation and uncertainty

**Priority:** P0 before publication-grade claims

**Problem:** Existing tests establish software consistency, largely with data generated from the same model family. They do not establish equivalence to primary equations, established software, annotated biological truth, or uncertainty of reported fractions.

**Status (2026-07-28, reference set defined):** An independent external reference set is now defined as the primary external validation for cell-cycle accuracy. It carries TWO references over one 30-sample asynchronous budding-yeast FCS acquisition set: (1) **FlowJo Dean-Jett-Fox** for all 30 samples (%G1/%S/%G2, G1/G2 means and CVs, G2:G1 ratio) — a direct DJF-vs-DJF comparison, unlike the same-direction-only manual-gate/mass-cytometry references; and (2) **Flowreader classic Watson** for the 15 mat-a samples (%G1/%S/%G2 + FSC-A mean), giving PhaseFinder's Watson its first external check. The Watson comparison is cross-tool AND cross-variant — PhaseFinder's Watson Pragmatic restricts residual S to between the peaks (SCI-01) while Flowreader's classic Watson runs %S markedly higher — so it is validated for broad agreement/direction (with %S expected lower), not strict equality. A reproducible generator (`tests/validation/driving_code/generate_flowjo_djf_reference.py`) reads the analyst's workbook, maps each strain to its FCS by the `async_<strain>__` filename token (clean 30↔30 bijection), and records per-file size + SHA-256. **Configuration equivalence** is pinned: the DNA channel is FL7-A / `GFP/FITC-A` (SYTOX Green), empirically confirmed (its 5th/95th percentiles bracket FlowJo's G1/G2 means; PI/FL8-A does not). **Predefined provisional acceptance tolerances**: phase fractions ±5pp (G1/G2), ±8pp (S); peak means ±3%; CVs ±2pp; G2:G1 ratio ±0.06. The dataset is **special/private** — the FCS and the compiled FlowJo values are gitignored and never committed; only a metadata stub (provenance/config/tolerances/weight) is tracked in the external-validation manifest, flagged `primary_external_validation` so a regression here is a primary failure. **Still open:** running PhaseFinder's DJF on the 30 FCS and asserting agreement within tolerance (box 6 execution), broadening beyond one instrument/encoding (box 4), deviance/model-choice/QC-mask tolerances (box 5), and domain-expert review (box 10).

- [ ] Select primary Dean, Jett, Fox, and Watson references and create a traceable equation-to-code mapping with units and parameter definitions.
- [x] Implement an independent reference calculation in a separate language/library or obtain validated reference curves from established software. *(obtained validated FlowJo DJF reference values for 30 real samples; defined as a reproducible, provenance-tracked reference set.)*
- [ ] Compare DJ and DJF expected component curves over a grid of parameters, not only fitted totals.
- [ ] Assemble redistributable deidentified/reference FCS datasets spanning instruments, channel encodings, contaminants, and cell-cycle distributions. *(one dataset assembled and mapped — 30 yeast async samples, single instrument/encoding, local-only/not redistributable; broadening across instruments/encodings remains.)*
- [ ] Predefine acceptance tolerances for peaks, phase fractions, deviance, model choice, and QC masks. *(peaks/phase-fractions/means/CVs/ratio tolerances predefined and provisional; deviance/model-choice/QC-mask tolerances not yet — FlowJo does not report them.)*
- [ ] Compare results with FlowJo, ModFit, or another accepted implementation and document configuration equivalence. *(configuration equivalence documented — DNA channel, FCS format, gating caveat; the actual per-sample comparison run is the next step.)*
- [ ] Investigate bootstrap, profile-likelihood, or other uncertainty intervals for phase fractions and key parameters.
- [ ] Add identifiability/restart/condition diagnostics that distinguish precise-looking but weakly identified fits.
- [ ] Document the validated scope, unsupported inputs, and remaining differences; do not generalize beyond tested conditions.
- [ ] Obtain domain-expert review before using “validated,” clinical, diagnostic, or publication-grade language.

### GATE-01 — Establish one authoritative scientific-result contract

**Priority:** P0

**Problem:** A nonconverged “best” restart can still be normalized/stored; direct API/session paths can fit stale or unreviewed regions; skipped/failed QC does not consistently prevent fractions becoming authoritative; Watson equates closed-form completion with convergence.

**Affected files:** `js/analysis/cell_cycle/modeling_state.js`, `fit_engine.js`, `modeling_ui.js`, `models/watson_pragmatic.js`, `pipeline_ui.js`, every result consumer.

- [x] Define separate fields/statuses for `computed`, `optimizerConverged`, `scientificallyValid`, `validForReporting`, `cancelled`, and `invalid`, with structured reason codes.
- [x] Add a model-layer preflight that validates histogram identity/revision, accepted/reviewed regions, DNA eligibility, retained-event sufficiency, required-QC outcomes, configuration, and constraints.
- [ ] Require every UI, worker, session-restore, debug API, and direct model entry point to call the same preflight/result validator.
- [x] Retain invalid/nonconverged candidates only as clearly marked diagnostic previews; do not activate fractions, populate authoritative columns, export as final, or use in Auto comparison.
- [x] Make optional-QC waiver explicit and provenance-bearing; distinguish not run, unavailable, failed, waived, and passed.
- [x] Replace Watson's unconditional `converged: true` with decomposition completion plus independent quality/validity state.
- [x] Add tests where all restarts hit limits, regions are stale/unreviewed, required QC failed, diagnostics contain NaN, or fitting is cancelled.
- [x] Audit every result consumer and assert it refuses `validForReporting !== true`.

### STATE-01 — Make model settings effective, immutable, and reproducible

**Priority:** P0/P1

**Problem:** Stored model settings do not reliably invalidate or parameterize fits. Result keys omit model/config/data/QC/domain versions. State uses `ratioRange` while model config expects `fitRatioRange`; session restore writes settings but can refit without passing them, promotes saved regions, and swallows per-sample errors. Changing the model selector can leave an old model's result visible.

**Affected files:** `js/analysis/pipeline_state.js`, `js/analysis/cell_cycle/modeling_state.js`, `modeling_ui.js`, DJ/DJF config builders, `js/session/modeling_session.js`.

- [x] Create one canonical validated configuration builder per model and map UI/session names to model names exactly once.
- [x] Resolve and pass stored settings into every fit; persist the exact applied configuration with the result.
- [x] Reject unsupported/inert settings instead of serializing controls that do nothing.
- [x] Build the result key from model ID/version, canonical config hash, input file/content digest, channel/transform, QC/mask digest, histogram edges/counts, region revision/review, and fit domain.
- [x] Invalidate/deactivate results immediately when any keyed input changes.
- [ ] Restore the saved `reviewed` state faithfully; do not silently accept/refit unreviewed regions.
- [ ] On algorithm/version drift, label recomputed results as new rather than implying exact reproduction.
- [x] Preserve structured per-sample restore errors instead of swallowing them.
- [x] Immediately clear/hide an active result when the selected model no longer matches it.
- [ ] Add tests proving each effective setting changes the config hash and applied model behavior, unknown settings fail, unreviewed sessions remain unreviewed, and changed file bytes cannot reuse caches/results.

### PEAK-01 — Require calibrated or reviewed peak initialization

**Priority:** P1

**Problem:** Peak confidence is a heuristic, but low-confidence/inferred-G2 proposals can be auto-accepted by bulk, bin-change, and session paths. Width-estimation fallbacks are not carried as evidence limitations, and recomputation can replace manual regions.

- [x] Centralize the rule that low confidence, inferred G2, ambiguous alternatives, and width fallback require explicit review before reporting.
- [x] Preserve detector status, candidates/scores, alternatives, width method, fallback reasons, source, and reviewer/acceptance state.
- [ ] Calibrate thresholds on independently annotated histograms; do not present the score as a probability.
- [x] Prevent bin/domain/session/bulk paths from auto-promoting unreviewed proposals.
- [x] Preserve valid manual regions during bin changes or require an explicit choice before replacement.
- [ ] Add fixtures for sub-G1 distractors, missing/weak G2, impulses, broad peaks, aneuploid peaks, weak S, and width fallbacks.
- [ ] Measure and document detection sensitivity, specificity, ambiguity, and review rate.

### DOMAIN-01 — Separate visual viewport from scientific fit domain

**Priority:** P1

**Problem:** Explicit X-axis bounds can become the modeling histogram domain, altering peak detection, Auto selection, fits, and fractions. Bin/domain changes can redetect, accept, and refit automatically, while tail/domain sensitivity is not treated as a scientific input.

- [x] Separate pan/zoom viewport state from an explicit analysis-domain control in state, UI, and result keys.
- [x] Default analysis to the full eligible DNA support; require deliberate confirmation to truncate it.
- [ ] Persist domain, bin edges/count, underflow, overflow, and component tail coverage in result provenance.
- [ ] Define warning/invalid thresholds for excluded observed events and modeled mass.
- [x] Invalidate results when the analysis domain/bins change; never invalidate/recompute fits for viewport-only changes.
- [ ] Add sensitivity analysis across supported bins and reasonable domain perturbations.
- [ ] Block/qualify results whose phase fractions/model choice exceed documented sensitivity tolerances.
- [x] Add tests proving viewport changes do not change fit identity, deliberate domain changes do, and manual/unreviewed regions are not silently replaced.

### QC-00 — Enforce mandatory DNA invariants independently of optional Stage 0

**Priority:** P0

**Problem:** Structural Stage 0 is optional and only checks loaded channels. Histogram construction accepts finite negative DNA values. Model validity cannot depend on whether a UI toggle happened to be selected.

**Status (2026-07-27, complete):** The mandatory boundary rejects non-finite, negative, and metadata-qualified saturated DNA independently of optional Structural QC. Histogram/model entry also requires 100 eligible events, five nonempty bins, and at least ten events in each reviewed peak region; all rejection counts and metadata remain in provenance.

- [x] Enforce finite, nonnegative, scientifically eligible DNA at histogram/model boundaries regardless of optional QC toggles.
- [x] Validate saturation/range using datatype and transform metadata rather than an unqualified `$PnR` ceiling.
- [x] Record rejected counts/reasons while preserving original event-index alignment.
- [x] Define minimum eligible events, nonempty bins, and peak-support requirements before detection/fitting.
- [x] Keep optional structural checks for companion channels separate from mandatory DNA model invariants.
- [x] Add Stage-0-on/off tests with negative, nonfinite, saturated, and semantically ineligible DNA; outcomes must enforce the same hard model boundary.

### QC-01 — Make QC outcomes explicit and scientifically fail-closed

**Priority:** P0

**Problem:** Selected gates can skip/unavailable/fail while retaining upstream masks; very high event removal can display an error without blocking modeling. A single success sentence obscures mixed per-file/per-stage outcomes.

**Status (2026-07-27, partial):** The contract-level fail-closed policy is implemented in `js/analysis/cell_cycle/result_contract.js`. `qc_outcome()` now maps each stage to an explicit status — `applied`, `passed_no_loss`, `skipped_optional`, `unavailable`, `degraded`, `failed`, `waived`, `cancelled`, `not_run` — carrying the event-loss fraction, warnings and reason. `model_preflight()` fails closed: a required stage is acceptable only when `applied`/`passed_no_loss`/`waived` (`QC_ACCEPTABLE_STATUSES`); any optional stage that `failed`/`cancelled` also blocks; a waiver counts only when it carries a `reason`; and removing >50% of events raises `QC_CRITICAL_REMOVAL` that blocks until acknowledged (`qcAcknowledgements`). The per-stage `qc` matrix (with loss %, warnings, reason) is stored on `result.preflight`, i.e. in result provenance. Regression tests in `tests/unit/driving_code/unit_tests_djf_edges.py` (taxonomy; required-unavailable/not_run/optional-failed block; waiver-needs-reason; critical-removal block/acknowledge); 548/548 unit checks pass. **Deferred (UI):** the acknowledgement dialog that lets a user supply `qcAcknowledgements`; the persistent on-screen batch outcome matrix; and verifying/hardening downstream-mask clearing when a stage rerun fails.

- [x] Define per-sample/per-stage outcomes: applied, passed-no-loss, skipped-optional, unavailable, degraded, failed, waived, and cancelled.
- [x] Require an explicit waiver with reason/provenance for a selected stage that cannot run.
- [x] Preserve companion/algorithm exceptions in pipeline state and result provenance.
- [ ] Require acknowledgement before reporting after critical removal or another configured QC warning. *(partial: the contract blocks on critical removal until `qcAcknowledgements` is supplied; the UI acknowledgement flow is not yet wired.)*
- [ ] Show a persistent batch matrix of outcomes and exact final-mask provenance. *(deferred: the outcome data exists on `result.preflight.qc`; the on-screen matrix is not built.)*
- [x] Clear stale downstream masks/results when a stage rerun fails.
- [x] Add fault/insufficient-data/missing-channel/high-removal tests; none may yield an unqualified complete/reportable result.

### QC-02 — Make Time QC cache identity include every effective option

**Priority:** P0/P1

**Problem:** Beyond modal transaction bugs, robust-summary cache identity omits `includeEventRateCheck`, and peak-tracking keys omit several effective settings. A changed configuration can reuse stale QC masks.

**Status (2026-07-27):** Fixed in `js/analysis/cell_cycle_pipeline.js`. `resolve_time_qc_config()` builds one canonical resolved config per method by merging the method's full default option set (`acquisition_time_qc.js` `DEFAULT_ROBUST_SUMMARY_OPTIONS` / `peak_tracking_time_qc.js` `DEFAULT_PEAK_TRACKING_OPTIONS`) with the caller's overrides, so no field can be cherry-picked out — `includeEventRateCheck`, `binSizeRounding`, `eventRateZThreshold`, `isolationTreeMaximumDepth`, `removeZeroValues` are all now part of the identity. `time_qc_cache_key()` hashes that resolved config **order-independently** (`stable_stringify`, sorted keys + sorted channels) together with the algorithm version and the structural-mask conditioning. `run_time_qc()` stamps `optionsUsed`, `configHash`, `algorithmVersion`, and `inputIdentity` on every result. Regression tests in `tests/unit/driving_code/unit_tests_djf_pipeline.py` toggle every effective option of both methods (all miss) and prove key-order/channel-order/omitted-default equivalence (hit); 554/554 unit checks pass.

- [x] Build one canonical resolved configuration object per Time QC method.
- [x] Hash every analysis-affecting field, selected channel identity, algorithm version, input event/mask revision, and Time channel identity. *(fields + channels + algorithm version hashed into the key; input/mask identity is enforced by the per-row cache entry keyed on channel + event count plus the `structuralActive` flag in the key, and stamped as `inputIdentity` on the result.)*
- [x] Ensure semantically identical objects with different key order produce the same hash.
- [x] Invalidate/recompute when any effective option changes; ignore presentation-only settings.
- [x] Persist `optionsUsed`, config hash, input identity, and algorithm version with the result/session. *(stamped on the result; the peak-tracking session config already persists options + algorithm version — persisting `configHash` into the session file is a small follow-up if desired.)*
- [x] Add a parameterized test that toggles every effective option and expects a cache miss; unchanged equivalent configs must hit.

### QC-03 — Harden robust-summary acquisition Time QC

**Priority:** P1

**Problem:** Rate uses `n/duration`, the robust method can score event rate despite its toggle, baselines can pool separate acquisition segments, `limitedReliability` is unused, and few valid bins/zero MAD can create overconfident decisions.

**Status (2026-07-27, partial):** Hardened in `js/analysis/acquisition_time_qc.js`. The rate estimator is the SCI-12 `(n-1)/duration`. `runTimeQC()` now builds its metric set from `includeEventRateCheck`, so a disabled event-rate check is excluded from scoring entirely (`disabledMetrics`). A run with no metric able to form a baseline, or fewer than `MIN_EVALUABLE_TIME_QC_BINS` (3) bins, is returned `notEvaluable` with **no events removed** (fail-safe) instead of a confident pass. The previously-unused reliability signal is enforced: a pooled multi-segment baseline, a degenerate zero-MAD active metric, or a mostly-small-bin acquisition set `limitedReliability: true`, which the QC-01 contract maps to a `degraded` outcome; `activeMetrics`/`excludedMetrics`/`disabledMetrics`/`degenerateMetrics`/`binCount` are surfaced on the result. Regression tests in `tests/unit/driving_code/unit_tests_djf_pipeline.py` (exact-rate, disabled-metric, too-few-bin, zero-MAD); 559/559 unit checks pass. **Deferred:** per-segment baseline *estimation* (currently pooled with a multi-segment reliability flag as the documented policy), the MAD-floor/threshold calibration study, and the multi-segment / known-disturbance test set with predefined error rates.

- [x] Apply the corrected `(n - 1) / duration` interval estimator from SCI-12.
- [x] Exclude event-rate scoring entirely when disabled.
- [x] Define minimum valid bin/segment coverage and return `not_evaluable` rather than a confident pass.
- [x] Estimate baselines per acquisition segment or document/validate another segment policy. *(documented policy: pooled baseline with a `limitedReliability` flag whenever `segmentCount > 1`; per-segment estimation is a future improvement.)*
- [x] Replace unused reliability flags with enforced outcome logic and surface active/excluded metrics.
- [ ] Calibrate MAD floors and thresholds against stable/clog/dropout/rollover/backward-jump acquisitions. *(deferred: needs a labeled calibration study.)*
- [ ] Add exact-rate, disabled-metric, too-few-bin, zero-MAD, multi-segment, and known-disturbance tests with predefined error rates. *(partial: exact-rate/disabled-metric/too-few-bin/zero-MAD added; multi-segment + known-disturbance with predefined error rates pending the calibration study above.)*

### QC-04 — Validate the full peak-tracking Time QC tracking model

**Priority:** P1/P2

**Problem:** In addition to median imputation, nearest/static track assignment is fragile under crossings, merges, splits, births, and deaths. Requested unavailable channels can disappear silently. Too-few-event/no-track segments can be left unfiltered while the overall result says complete. “Largest tree node is stable” and “any rejected overlapping bin rejects the event” are unvalidated policies.

**Status (2026-07-27, partial):** The reporting/coverage/evidence layer is hardened in `js/analysis/peak_tracking_time_qc.js`, consistent with QC-01/QC-03; the tracking-*algorithm* redesign is deferred as a larger validated effort. `runPeakTrackingTimeQC()` now reports `requestedChannels`/`availableChannels`/`missingChannels` (a requested-but-unloaded channel is no longer silently dropped) and qualifies the run. Coverage is computed (`evaluatedSegmentCount`/`segmentCount`, plus the existing evaluated-event/bin counts): a run where no segment could be scored is returned `notEvaluable` with **no events removed**, and partial coverage / a missing channel / >50% removal set `limitedReliability`, which the QC-01 contract maps to a `degraded` outcome (verified end-to-end). Per-bin track/reason evidence (`segmentResults[].rejectionReasons`, `peakMetadata[].imputed`) and the algorithm version are retained. Regression tests in `tests/unit/driving_code/unit_tests_time_qc_peak_tracking.py` (missing-channel, no-track/low-coverage not-evaluable, evidence+version, QC-01 degraded mapping); 592/592 unit checks pass. **Deferred (algorithmic):** explicit crossing/merge/split/birth/death assignment, replacing largest-terminal-node stability with validated criteria, and quantifying overlap-expansion false rejection — each needs labeled fixtures and a calibration study.

- [ ] Implement explicit missing/ambiguity plus order-constrained or dynamic assignment with merge/split/birth/death states. *(deferred: tracking-algorithm redesign; the per-bin imputed/missing evidence exists, but crossing/merge/split state assignment does not.)*
- [x] Report requested versus available channels and block/qualify missing required inputs.
- [x] Compute evaluated-event/bin/segment coverage and return degraded/not-evaluable when insufficient.
- [ ] Replace largest-terminal-node stability with validated continuity/quality/reference criteria or manual review. *(deferred: needs a validated continuity/reference criterion.)*
- [ ] Quantify overlap-expansion false rejection and evaluate consensus/weighted event decisions. *(deferred: needs a quantification study.)*
- [x] Retain per-bin track/reason/ambiguity evidence and version the algorithm. *(per-bin reasons + imputed/missing markers + algorithm version retained; richer crossing-ambiguity markers await the assignment redesign above.)*
- [x] Add crossing, merge/split, transient disappearance, mode-count, missing-channel, no-track, low-coverage, stable, and disturbed independent fixtures. *(stable/disturbed/transient-disappearance/mode-count fixtures already existed; missing-channel/no-track/low-coverage added. Crossing and merge/split fixtures await the assignment redesign.)*
- [ ] Predefine acceptable false-positive, detection, retention, and boundary-event rejection rates. *(deferred: needs the calibration study, shared with QC-03.)*
- [ ] Predefine acceptable false-positive, detection, retention, and boundary-event rejection rates.

### QC-05 — Do not apply an invalid scatter GMM

**Priority:** P1

**Problem:** A two-component full-covariance GMM may be fit with very few events; exactly two components and greatest-FSC selection are assumed; a nonconverged/singular/implausible mixture can still generate an applied mask.

**Status (2026-07-28, done):** Validity gating added to `js/analysis/scatter_gmm_gate.js`, consistent with the QC-01/QC-03/QC-04 fail-closed pattern. The gate now records the fitted event budget (`fittedEventCount`, `mainComponentEffectiveCount`, `coverageFraction`) and flags a fit as **review-required + `limitedReliability`** when it is underpowered (`< RELIABLE_SCATTER_EVENTS = 100` overall, or the selected biological component holds `< MINIMUM_COMPONENT_EVENTS = 25` effective events), non-converged (existing), near-singular (selected covariance condition `≥ MAXIMUM_COMPONENT_CONDITION = 1e4`, i.e. its narrow axis is regularization-dominated), or of implausibly small coverage (`< MINIMUM_PLAUSIBLE_COVERAGE`). `qc_outcome()` maps any of these to a `degraded` stage outcome, and the pipeline already withholds the filter mask on `reviewRequired` — verified end-to-end (`row.data.masks.scatter === null`). The 2-component full-covariance scope is documented in-code as the validated scope. Regression tests in `tests/unit/driving_code/unit_tests_djf_pipeline.py` (underpowered, non-converged, near-singular/collinear, clean-not-flagged, and a pipeline mask-withheld test); 620/620 unit checks pass and the app boots clean.

- [x] Set a defensible minimum effective sample/component count. *(hard fit floor `MINIMUM_SCATTER_EVENTS`; reliability tier `RELIABLE_SCATTER_EVENTS`; per-component effective floor `MINIMUM_COMPONENT_EVENTS`.)*
- [x] Compare plausible component counts or document why exactly two is supported for the validated scope. *(documented in-code: 2 components — biological cloud vs. debris — is the validated scope; higher counts are deliberately out of scope. An empirical component-count comparison is not attempted.)*
- [x] Treat nonconvergence, singular covariance, tiny components, implausible coverage, and severe boundary regularization as invalid/degraded. *(near-singular/regularization-dominated covariance is the "severe boundary regularization" signal.)*
- [x] Apply the normalized/scientifically transformed coordinates and biological-cloud selection work from SCI-09A. *(robust-z-score standardization + weight-primary selection with FSC tie-break already present; scale-invariance covered by an existing SCI-09A test.)*
- [x] Require manual review for ambiguous selection and preserve override provenance. *(ambiguous selection → review; `manualOverride`/`gateSource` provenance preserved by `update_cell_gate`.)*
- [x] Add underpowered, singular, nonconverged, high-FSC aggregate, debris-heavy, multimodal, and gain-rescaled fixtures; invalid fits must not apply a mask. *(underpowered/singular/nonconverged + "invalid fits must not apply a mask" added; high-FSC-aggregate, debris-heavy, multimodal (overlapping), and gain-rescaled fixtures already existed as SCI-09A tests.)*

### QC-06 — Do not apply an invalid pulse-geometry singlet gate

**Priority:** P1

**Problem:** Raw A/H or A/W ridge estimation uses scale-sensitive absolute convergence, permits very low counts, and can apply a nonconverged/degenerate ridge. Missing/insufficient geometry can silently preserve upstream masks.

**Status (2026-07-28, mostly done):** Validity gating added to `js/analysis/pulse_geometry_gate.js`, mirroring QC-05. The ridge is fit in robust-z-score coordinates, so the solver's convergence tolerance and Huber scale operate on a scale-stable representation (an instrument gain change on either channel leaves the mask unchanged — covered by an existing SCI-09B test). The gate now flags a fit as **review-required + `limitedReliability`** when it is non-converged (existing), poorly identified (blob; `ridgeIdentificationRatio < MINIMUM_RIDGE_IDENTIFICATION_RATIO`), underpowered (`< RELIABLE_PULSE_GEOMETRY_EVENTS = 50`, above the `DEFAULT_MINIMUM_POINTS = 20` skip floor), collinear-degenerate (minor-axis eigenvalue `≤ MINIMUM_RIDGE_OFF_AXIS_EIGENVALUE` in scale-stable coordinates — distinct from the blob case and robust to floating-point residuals), or of implausibly small coverage. Missing geometry (`no pulse geometry`) and too-few-events (`insufficient pulse-geometry events`) remain distinct skips, and waivers are handled by `qc_outcome()`; `qc_outcome()` maps the review states to `degraded`, and the pipeline withholds the filter mask on `reviewRequired` — verified end-to-end (`row.data.masks.singlet === null`). Regression tests in `tests/unit/driving_code/unit_tests_djf_pipeline.py` (underpowered, degenerate/collinear, non-converged, clean-not-flagged, and a pipeline mask-withheld test); 620/620 unit checks pass and the app boots clean. **Deferred:** empirical calibration of the distance/coverage thresholds against labeled data (shared with the QC-03/QC-04 calibration study).

- [x] Implement the scale-stable representation and channel-choice evidence from SCI-09B. *(robust-z-score standardization before the ridge fit; `selectPulseGeometry` records per-channel selection evidence.)*
- [x] Use relative/scaled convergence and report identifiability/quality diagnostics. *(convergence runs in scale-stable coordinates; `ridgeIdentificationRatio`, `coverageFraction`, `distanceMAD`, and `reviewReasons` are reported.)*
- [ ] Define defensible minimum sample size and calibrated distance/coverage thresholds. *(minimum sample size + reliability tier + plausible-coverage/off-axis floors are defined and documented, but empirical calibration of the distance/coverage thresholds against labeled data is deferred to the shared calibration study.)*
- [x] Treat nonconverged, collinear-degenerate, underpowered, missing, and waived states distinctly; never apply an invalid ridge. *(each is a distinct status/reason; the pipeline never installs the mask for a review-required fit — verified end-to-end.)*
- [x] Add gain-rescaling, nonconvergence, degeneracy, low-count, and labeled singlet/doublet fixtures with predefined classification targets. *(nonconvergence, degeneracy, and low-count/underpowered added; gain-rescaling and labeled singlet/doublet sensitivity/specificity fixtures already existed as SCI-09B tests.)*

### STAT-01 — Reject invalid Poisson inputs and audit every active bound

**Priority:** P1/P2

**Problem:** In addition to constant-free likelihood labels, negative observations/expectations can be silently clamped, and boundary diagnostics do not cover every active/joint constraint.

- [ ] Reject nonfinite/negative observed counts and nonfinite/negative expected counts with structured errors.
- [ ] Audit mean, ratio, area, CV, profile, wave, contamination, and joint-feasibility bounds.
- [ ] Emit exact constraint residuals and active-bound diagnostics.
- [ ] Add one focused test that triggers each configured bound/joint constraint warning.
- [ ] Calibrate reduced-deviance and residual warning thresholds against independent data.

### LEGACY-01 — Quarantine or retire legacy stages 5–8

**Priority:** P1/P2

**Problem:** Legacy bridge/contamination stages coexist with canonical models and can appear as a plot fallback. They use different likelihood/contamination equations, can include nonconverged fits, and some UI/errors call them DJF even though they are not canonical DJF.

- [ ] Remove legacy fallback from every canonical plot/table/export/report path.
- [ ] Prefer retirement; otherwise hide/label the legacy path exploratory/unvalidated under a distinct versioned model ID.
- [ ] Prevent legacy fractions/diagnostics from populating canonical columns or labels.
- [ ] Correct every “DJF” label that actually refers to the bridge.
- [ ] Document that the existing aggregate approximation is not the claimed self-convolution/Bagwell model.
- [ ] If retained scientifically, require the same validity, uncertainty, constraint, likelihood, and independent benchmark gates as canonical models.
- [ ] Add tests proving canonical consumers never silently fall back to legacy output.

### UNC-01 — Add uncertainty, identifiability, and sensitivity reporting

**Priority:** P1 publication gate

**Problem:** Phase fractions are point estimates without covariance/rank/condition information, intervals, bootstrap/profile likelihood, or model-selection uncertainty. Bounds/correlated parameters can make precise-looking values nonidentifiable.

- [ ] Report Jacobian/Hessian rank/condition evidence and parameter correlations after the solver is hardened.
- [ ] Use profile likelihood or bootstrap intervals suited to bounded nonlinear parameters and phase fractions.
- [ ] Include event resampling plus peak-region, bin/domain, and relevant QC perturbations, not optimizer-only uncertainty.
- [ ] Re-run Auto during resampling and report model-selection frequency/instability.
- [ ] Flag weak identifiability, multimodality, boundary-dominated intervals, or excessive fraction uncertainty as qualified/nonreportable.
- [ ] Persist interval method, seed, replicate count, failures, and definition.
- [ ] Validate nominal interval coverage on clean, low-count, boundary, weak-S, and contaminated simulations.

### PERF-MODEL-01 — Make fit cancellation real and avoid silent main-thread fallback

**Priority:** P2 optimization after model validation

**Problem:** A synchronous LM loop prevents the worker from processing a cancel message until fitting completes. Worker failure can fall back to synchronous main-thread fitting, freezing UI and silently changing execution behavior.

- [ ] Yield cooperatively between solver iterations or use a terminable worker per active fit.
- [ ] Add request-generation tokens so cancelled/stale worker results cannot activate.
- [ ] Do not silently execute canonical fits on the main thread; expose a worker-unavailable state or a strictly bounded reviewed fallback.
- [ ] Cache quadrature nodes and parameter-independent bin quantities.
- [ ] Evaluate analytic derivatives/automatic differentiation only after transformed parameterization is validated.
- [ ] Add cancellation-latency, worker-failure, UI-responsiveness, stale-result, runtime, and memory benchmarks.
- [ ] Assert optimized and reference expected counts/objective/parameters/fractions remain within strict tolerances.

### FUTURE-01 — Defer hierarchical/cross-sample models until per-sample validation

**Priority:** P3

**Problem:** Shared models may improve precision but would propagate current calibration/model/QC errors across a cohort.

- [ ] Complete VALID-01 and calibration-aware batch work before implementing shared models.
- [ ] Define which parameters may pool and retain explicit between-sample variance rather than hard equality.
- [ ] Require verified batch/calibration membership and preserve per-sample diagnostics/outlier handling.
- [ ] Validate with simulations under both correct and violated sharing assumptions plus leave-one-out sensitivity.

---

## 3. FCS parsing, channel validity, metadata, and memory

### DATA-01 — Validate FCS semantics before linear DNA modeling

**Priority:** P0

**Problem:** The parser returns stored F/D/I values but does not apply or reject `$PnE`/`$PnG` amplification/scaling, spillover/compensation, unsupported `$MODE`, or chained `$NEXTDATA`. DJ/DJF assumes intensity is proportional to DNA content, so an unsuitable channel can yield plausible but meaningless results.

**Affected files:** `js/fcs/parser.js`, `js/fcs/channel_cleaning.js`, `js/io/parameter_map.js`, channel-selection UI, session records, model entry gates.

- [x] Define the supported FCS versions, `$MODE`, `$DATATYPE`, byte orders, parameter widths, amplification encodings, gain semantics, and multi-dataset behavior.
- [x] Parse and normalize `$MODE`; require list mode for event analysis.
- [x] Detect `$NEXTDATA` and either iterate datasets correctly or reject multi-dataset files with an actionable message.
- [x] Parse `$PnE` and `$PnG` into a documented channel-transform descriptor.
- [x] Parse spillover/compensation keywords and decide whether PhaseFinder applies compensation, accepts precompensated channels, or blocks unsupported cases.
- [x] Add a channel-eligibility result that distinguishes linear, transformed-supported, transformed-unsupported, compensated, uncompensated, and unknown states.
- [x] Prevent histogram/model actions until the selected DNA channel is verified compatible or the user completes an explicit scientifically justified override.
- [x] Display transform/compensation status beside the channel selector and include it in exported/session provenance.
- [x] Apply transformations exactly once; add a guard against double transformation/compensation after session restore or cache reuse.
- [x] Add fixtures for linear, logarithmic, gained, compensated, unsupported mode, and `$NEXTDATA` files.
- [x] Compare transformed values against an independent FCS reader within documented tolerances.
- [x] Verify a numerically successful model cannot bypass an incompatible-channel gate.

### DATA-02 — Bound all FCS offsets, counts, widths, and allocations

**Priority:** P1

**Problem:** Header parsing checks too few relationships against `file.size`. `$TOT` can drive large allocations before proving `event_count × stride` fits the DATA segment. Integer parsing assumes byte-aligned `ceil(bits / 8)` fields and JavaScript loses exactness above 53 bits.

**Affected files:** `js/fcs/metadata_processing.js`, `js/fcs/parser.js`, `js/fcs/data_worker.js`.

- [x] Validate every HEADER/TEXT/DATA begin/end offset is finite, nonnegative, ordered, within `file.size`, and safe as a JavaScript integer.
- [x] Reconcile HEADER offsets with `$BEGIN*`/`$END*` keywords according to the supported FCS version and reject contradictions.
- [x] Validate `$PAR`, `$TOT`, every `$PnB`, computed event stride, and `event_count × stride` before slicing or allocating.
- [x] Establish configurable upper bounds for parameter count, event count, segment size, TEXT keyword count/length, and total working memory.
- [x] Detect integer widths that are non-byte-aligned or greater than the supported exact range; implement bit-packed decoding correctly or reject them explicitly.
- [x] Use checked arithmetic that rejects overflow and unsafe integer multiplication.
- [x] Verify DATA reads cannot extend into ANALYSIS or beyond the provided buffer.
- [x] Return typed parser errors containing the invalid keyword/offset without dumping sensitive metadata.
- [x] Add truncated HEADER, TEXT, and DATA fixtures at every boundary.
- [x] Add little/big-endian float32, float64, byte-aligned integers, non-byte-aligned integers, and >53-bit integer fixtures.
- [x] Add escaped TEXT delimiters, supplemental TEXT, conflicting offsets, huge `$TOT`, huge `$PAR`, and fuzzed keyword tests.
- [x] Fuzz the parser in a worker and assert bounded time/memory and no browser crash.

### DATA-03 — Reduce full-DATA copies and peak memory

**Priority:** P1 for large files; P2 otherwise

**Problem:** “Selected-column” loading still slices the entire DATA segment, allocates normal JavaScript arrays, then creates `Float64Array` copies. With concurrent files this can multiply peak memory and fail on large cytometry datasets.

**Affected files:** `js/io/channel_loading.js`, `js/fcs/data_worker.js`, `js/fcs/parser.js`, channel cache and concurrency settings.

- [x] Instrument peak memory, transferred bytes, parse time, and retained bytes for representative small/medium/large FCS files.
- [x] Avoid `Array` intermediates; decode directly into final typed arrays.
- [x] Use `File.slice()` byte ranges or chunked streaming so only required DATA portions are resident when the format permits it.
- [x] For interleaved event records, process bounded chunks and extract only requested columns rather than copying the full segment.
- [x] Transfer final typed-array buffers from workers without an additional structured clone/copy.
- [x] Make file concurrency adaptive to estimated DATA size and available memory rather than fixed file count alone.
- [x] Add cancellation and release buffers promptly when channel selection changes or a load is superseded.
- [x] Define a memory-limit error with guidance instead of allowing an unresponsive tab or worker crash.
- [x] Add performance fixtures and assert peak-memory ceilings and no regression in decoded values.
- [x] Verify event indexes and all selected channel lengths remain aligned across chunks.

### DATA-04 — Fail closed when required companion channels cannot load

**Priority:** P1

**Problem:** Failures loading Time, FSC/SSC, or pulse-geometry companions are caught and the analysis continues with the associated QC stage skipped. A status warning is easy to miss, and users can interpret the run as if requested QC occurred.

**Affected files:** `js/io/channel_loading.js`, `js/analysis/pipeline_ui.js`, pipeline state/reporting, bulk modeling.

- [x] Classify companion channels as required, optional, or unavailable for the currently enabled QC configuration.
- [x] Return a typed per-file/per-channel load result instead of swallowing every exception.
- [x] Block a required QC stage and downstream model fit when its companion load fails.
- [x] Allow an explicit user decision to disable the stage and continue; record that degraded path in model provenance and reports.
- [x] Show persistent per-sample QC status in the table/sidebar, not only a transient status-bar message.
- [x] Ensure bulk fitting reports each skipped/degraded file and does not reuse a stale successful mask.
- [x] Add fixtures for missing channel, wrong mapped index, truncated companion data, worker exception, and user-approved skip.
- [x] Assert the UI never says “Pre-model QC applied” when a required stage failed.

### DATA-05 — Reject or safely rename duplicate metadata headers

**Priority:** P2

**Problem:** Duplicate CSV/TSV headers map to the same object key, so earlier values are overwritten and multiple normalized columns read the same source value.

**Affected file:** `js/io/metadata_io.js`, metadata-import UI/tests.

- [x] Detect duplicate source headers before constructing row objects.
- [x] Choose and document one policy: reject with line/column details, or deterministically rename duplicates while preserving every value.
- [x] Treat headers that collide after normalization/case folding as duplicates where appropriate.
- [x] Show a preview of final column names and any renames before applying the import.
- [x] Preserve empty and quoted duplicate-column values without shifting neighboring columns.
- [x] Add CSV and TSV fixtures with exact duplicates, case variants, whitespace variants, quoted delimiters, and empty duplicate cells.
- [x] Round-trip exported/imported metadata and assert no columns or values disappear.

### DATA-06 — Define a supported-format compatibility matrix

**Priority:** P2 improvement

**Problem:** The parser advertises broad F/D/I support, but tests cover only a narrow subset and the UI does not clearly state unsupported FCS variants.

- [x] Create a machine-readable compatibility table for FCS version, data type, byte order, integer widths, mode, scaling, compensation, supplemental TEXT, and multiple datasets.
- [x] Generate parser tests from the matrix so every “supported” cell has a fixture and every “unsupported” cell has a clear rejection test.
- [x] Display the supported-input summary in Help and link specific parser errors to it.
- [x] Add the matrix to release criteria and update it whenever parsing behavior changes.

---

## 4. Sessions, OPFS, reproducibility, and local-file security

### SES-01 — Prevent orphaned OPFS FCS caches and make Reset complete

**Priority:** P1

**Problem:** A new runtime session ID is generated on each load, while restored session records can refer to older arbitrary `opfs_path` values. Reset deletes only the current runtime directory. Reload-before-save can lose the only in-memory reference to an automatically cached directory.

**Affected files:** `js/session/file_cache.js`, `js/session/core.js`, `js/session/reconnect.js`, `js/session/opfs_fs.js`, session schema/UI/tests.

- [x] Introduce a persistent cache index containing cache ID, owning logical session, file IDs, paths, sizes, digests, created/last-used times, and schema version.
- [x] Define ownership when a saved session reuses, imports, or copies an existing cached file.
- [x] Make Reset enumerate and delete every cache path owned/referenced by the active logical session, not only the current runtime ID.
- [x] Handle partially missing directories and deletion failures without abandoning the rest of cleanup.
- [x] Add a user-visible cache manager showing storage use, session ownership, orphan candidates, and Clear controls.
- [x] Detect orphaned legacy directories and offer a safe cleanup migration.
- [x] Define logo-reload semantics explicitly: delete current unsaved runtime copies or retain them as catalogued, user-visible cache entries.
- [x] Clear related IndexedDB directory handles/local persistent records when “Clear all PhaseFinder local data” is selected.
- [x] Reconcile the persistent-storage request with clear consent/help text and quota reporting.
- [x] Release cached entries when loading is cancelled or metadata insertion fails.
- [x] Add OPFS integration tests for fresh load, reload-before-save, save/restore, imported old session, multiple sessions sharing files, partial cache loss, and Reset.
- [x] Assert Reset leaves no owned entries and does not delete entries owned by another session.
- [x] Verify private cache metadata is never included in the production artifact or logs.

### SES-02 — Verify file identity with a content digest

**Priority:** P1

**Problem:** OPFS restore checks size; manual reconnect uses filename plus size. A different same-named, same-sized FCS file can be accepted as the saved sample.

**Affected files:** `js/session/file_cache.js`, `js/session/reconnect.js`, TOML serialization/parser, copy worker, reconnect UI/tests.

- [x] Compute SHA-256 (or a documented equivalent) while the existing file copy/read pass is already streaming the file.
- [x] Store digest algorithm and value in cache records and saved session file records.
- [x] Verify digest before accepting OPFS restore or manual reconnect.
- [x] Keep filename/size as quick prefilters only; do not treat them as identity.
- [x] Provide progress and cancellation for digesting large files.
- [x] Define backward compatibility for sessions without digests: require explicit review/reconnect and write a digest on the next save.
- [x] Show a clear mismatch message without silently substituting the new file.
- [x] Add tests for identical content with renamed file, same name/size with changed bytes, corrupted OPFS copy, and legacy no-digest session.
- [x] Confirm digest computation does not create a second full-file memory copy.

### SEC-01 — Make the TOML parser prototype-safe and schema-validated

**Priority:** P1

**Problem:** `js/session/toml_io.js` assigns arbitrary keys and section path components into normal objects. Keys such as `__proto__`, `constructor`, or `prototype` can alter object behavior when a shared session is imported.

- [x] Construct parser dictionaries with `Object.create(null)` or a safe `Map`-based representation.
- [x] Reject `__proto__`, `prototype`, and `constructor` in every bare/quoted key, inline table, dotted key, and section path.
- [x] Avoid truthiness/inherited-property checks; use own-property checks consistently.
- [x] Add recursion, nesting-depth, array-length, string-length, and total-key limits.
- [x] Validate the parsed object against an explicit versioned PhaseFinder session schema before applying any state.
- [x] Treat serialized `opfs_path` as untrusted: allow reads only inside a dedicated validated PhaseFinder namespace and generate a fresh trusted destination for reconnect copies.
- [x] Reject unknown critical sections and type mismatches with precise, nonexecuting error messages.
- [x] Ensure invalid sessions are applied atomically: no partial UI, cache, or model mutation before validation succeeds.
- [x] Add malicious prototype-key fixtures in all supported TOML syntaxes and assert global/object prototypes are unchanged.
- [x] Add malformed/deep/resource-exhaustion fixtures and confirm bounded behavior.
- [x] Add backward-compatibility fixtures for every supported session schema version.

### SEC-02 — Prevent spreadsheet formula injection in metadata exports

**Priority:** P2

**Problem:** TSV quoting handles tabs/newlines/quotes but does not neutralize cells beginning with `=`, `+`, `-`, or `@`. Spreadsheet programs may execute imported metadata or crafted filenames as formulas.

**Affected file:** `js/io/metadata_io.js`, export help/tests.

- [x] Define a safe spreadsheet-export policy for formula-leading cells, including leading whitespace and control characters.
- [x] Prefix risky cells with an apostrophe or another documented neutralization compatible with supported spreadsheet tools.
- [x] Preserve the original value in PhaseFinder session state; sanitize only the exported representation.
- [x] Decide whether numeric negatives should remain numeric and distinguish them safely from formulas.
- [x] Add fixtures for `=CMD()`, `+SUM`, `-1+2`, `@A1`, leading tabs/spaces, Unicode lookalikes, quotes, and ordinary negative numbers.
- [x] Open a generated fixture in the supported spreadsheet applications and confirm cells are inert and values remain understandable.
- [x] Document safe export behavior and limitations.

### SES-03 — Make session application transactional and observable

**Priority:** P2 improvement

**Problem:** Session restore touches table, files, layout, QC, and modeling state. Without a single validated transaction, a late failure can leave mixed old/new state that is hard to reproduce.

- [x] Parse and schema-validate into an immutable draft before mutating live state.
- [x] Resolve version migrations and file identity in the draft.
- [x] Apply the session in an ordered transaction with rollback or a clean-reload fallback on failure.
- [x] Record a restore summary: schema version, migrated fields, matched/missing files, degraded QC, and recomputed models.
- [x] Do not serialize transient worker/request IDs, stale fit results, or machine-local paths as authoritative science.
- [x] Add fault-injection tests at each restore stage and assert no partial state remains.

### SES-04 — Add explicit storage quotas, lifecycle, and privacy controls

**Priority:** P2/P3 improvement

- [x] Show estimated/actual OPFS use and browser quota before or during large cache operations.
- [x] Handle quota denial/exhaustion with an actionable fallback that still permits noncached analysis where possible.
- [x] Let users disable automatic FCS caching before files are copied.
- [x] Explain that OPFS is persistent browser-private storage, correcting “everything lives only in memory” documentation.
- [x] Add “Clear this session” and “Clear all PhaseFinder local data” controls with distinct confirmations.
- [x] Verify storage controls work in Chromium, Firefox, WebKit-supported behavior, private browsing, and unavailable-OPFS environments.

### SEC-03 — Add defense-in-depth for the static deployment

**Priority:** P2 improvement

- [x] Configure Cloudflare security headers: a restrictive Content Security Policy, `X-Content-Type-Options`, `Referrer-Policy`, frame protection, and an appropriate permissions policy.
- [x] Ensure the CSP supports local module workers, blob/download behavior, and vendored D3 without broad `unsafe-*` exceptions.
- [x] Audit every use of `innerHTML` and retain escaping/text-node construction for user-controlled metadata and filenames.
- [x] Add regression fixtures with HTML/script-like filenames, annotations, TOML strings, TSV cells, and model labels.
- [x] Add dependency/license/vulnerability checks for npm, Python test tooling, and GitHub Actions.
- [x] Pin third-party Actions to reviewed commit SHAs where supply-chain policy requires it.

---

## 5. HTML, CSS, UI state, plotting, and accessibility

### UI-01 — Make Time QC configuration transactional and valid

**Priority:** P1

**Problem:** Time QC configuration currently mixes live state, modal draft state, method-specific values, HTML-only constraints, programmatic setters, and session restoration. Complete UI-01A and UI-01B so every entry path uses one validated, transactional contract.

### UI-01A — Make Time QC settings a validated modal-local draft

**Priority:** P1

**Problem:** “Reset defaults” mutates live shared settings immediately. Cancelling afterward returns `null` but leaves the mutation. Apply checks only `Number.isFinite`; HTML `min`/`max` constraints do not run because this is not form submission, and session-restored values bypass HTML constraints entirely.

**Affected files:** `js/analysis/time_qc_modal.js`, `js/analysis/time_qc_settings.js`, `index.html`, session configuration/tests.

- [x] Clone current settings into a modal-local draft when the dialog opens.
- [x] Make Reset update only the draft and visible controls.
- [x] Make Cancel discard the draft without mutating shared state, DOM summary, session output, or active QC masks.
- [x] Make Apply validate and then atomically commit the draft.
- [x] Centralize constraints in a JavaScript validator/schema used by modal input, programmatic setters, defaults, and session restore.
- [x] Validate ranges, integer requirements, nonempty channel lists, overlap bounds, threshold bounds, and cross-field relationships.
- [x] Return field-specific error messages and focus the first invalid control.
- [x] Reject or migrate invalid session values before they reach scientific calculations.
- [x] Add tests for Reset→Cancel, edits→Cancel, Reset→Apply, invalid min/max values, invalid cross-field combinations, and invalid session restore.
- [x] Assert Cancel produces byte-for-byte identical serialized Time QC configuration before/after.

### UI-01B — Keep method-specific Time QC controls independent

**Priority:** P1/P2

**Problem:** Switching Time QC radio methods only toggles visibility. The event-rate checkbox retains the previous method's value, and Apply can write that value into the newly selected method. “Run All” bypasses the method-choice dialog even though enabling Time QC individually requires it.

- [x] Bind controls to separate `robustSummaryOptions` and `peakTrackingOptions` drafts.
- [x] On method switch, save the outgoing controls to its draft and load the incoming method's values.
- [x] Give duplicate concepts such as event-rate checking method-specific DOM IDs/names or one explicit shared semantic.
- [x] Route individual Time QC, QC toggles, Run All, session restore, and bulk workflows through one configuration/validation function.
- [x] Decide when Run All should prompt versus use a previously confirmed configuration, and show the chosen method before execution.
- [x] Add method A→B→A round-trip tests proving each method retains its own settings.
- [x] Add Run All tests proving the displayed/serialized method is the one actually executed.

### UI-02 — Stop swallowing QC exceptions and claiming success

**Priority:** P0/P1

**Problem:** `js/analysis/pipeline_ui.js` catches stage exceptions and then reports “Pre-model QC applied.” Expected insufficient-data skips and unexpected code/data failures are indistinguishable.

- [x] Define typed outcomes for `success`, `skipped_expected`, `warning/degraded`, `cancelled`, and `failed_unexpected`.
- [x] Remove broad empty catches; preserve the original error for diagnostics while presenting safe actionable text.
- [x] Aggregate per-file/per-stage outcomes without converting one failed file into global success.
- [x] Block dependent stages and modeling for samples with an unexpected or required-stage failure.
- [x] Clear stale masks/results when a rerun fails so old success cannot appear current.
- [x] Show a persistent summary with sample, stage, reason, and suggested action.
- [x] Keep detailed stack traces in developer/test output without exposing private filenames unnecessarily in shared reports.
- [x] Add fault injection for each QC stage and assert status, disabled actions, cleared state, and exit behavior.
- [x] Assert no successful status phrase appears when any required stage failed.

### UI-03 — Make the mobile/short-viewport layout reachable

**Priority:** P1

**Problem:** `body` disables scrolling and `.app` uses a viewport height based on a 60px header. At the mobile breakpoint, the header grows and sidebar/workspace stack, so lower content can become unreachable.

**Affected files:** `css/base.css`, `css/layout.css`, `css/responsive.css`, panel/sidebar sizing code.

- [x] Define which element owns vertical scrolling at desktop and at the stacked mobile breakpoint.
- [x] Remove fixed header-height assumptions or expose the actual header size through layout/grid/CSS custom properties.
- [x] Use dynamic viewport units with a safe fallback and apply `min-height: 0` to nested grid/flex scroll containers.
- [x] Allow document scrolling when sidebar and workspace stack vertically.
- [x] Ensure fixed status/progress UI does not cover the final controls or table rows.

### UI-04 — Export the complete ridge plot or state the limitation explicitly

**Priority:** P2

**Problem:** Ridge mode creates one SVG per sample, but export selects only the first SVG. The downloaded image silently omits the other samples.

**Affected files:** `js/plotting/render.js`, `js/plotting/plot_export.js`, PDF/raster export tests.

- [x] Define the expected ridge export: one composite SVG/page, a multi-page PDF, or a ZIP of clearly named per-sample files. *(One ordered composite SVG/page; HTML is the paginated fallback.)*
- [x] Build/export from the complete plot representation rather than `querySelector` of the first SVG.
- [x] Preserve titles, axes, labels, legends, model overlays, colors, and ordering for every ridge.
- [x] Calculate output dimensions safely and warn/offer pagination for very large sample counts.
- [x] Add SVG, PDF, PNG, and JPEG tests with at least three ridges and assert all sample names/content are present.
- [ ] Add a visual comparison fixture for overlay and ridge modes.
- [x] If a format cannot represent all ridges, disable it with a clear explanation rather than silently truncating.

### UI-05 — Complete the accessibility contract

**Priority:** P1/P2

**Problem:** Upload/reset controls, table selection/sorting, tooltips, plots, and custom modals have separate accessibility gaps. Complete UI-05A through UI-05E and test them as one keyboard/screen-reader workflow.

### UI-05A — Make upload and reset controls keyboard-accessible

**Priority:** P1/P2

**Problem:** The visible drop zone is a click-only `<div>`, the hidden file input lacks a clear accessible label, and the clickable logo is an image with a mouse listener rather than a semantic control.

- [x] Implement the upload trigger as a `<label for>` or `<button>` with a programmatically associated file input.
- [x] Preserve drag/drop behavior while supporting Enter and Space activation.
- [x] Provide an accessible name, accepted file type, multiple-file behavior, and instructions that do not rely only on hover.
- [x] Replace the clickable logo reset with a semantic button/link or add a separate named Reset control and make the logo noninteractive.
- [x] Keep confirmation behavior consistent for pointer and keyboard activation.
- [x] Add keyboard-only tests for upload, reset confirmation/cancel, visible focus, and disabled states.

### UI-05B — Label table selection and expose sort state

**Priority:** P2

**Problem:** Row and select-all checkboxes do not have accessible names, and sortable headers show state visually without `aria-sort`.

- [x] Give every row checkbox an accessible name that includes the sample filename/identifier.
- [x] Give select-all an accessible name and expose mixed state with `indeterminate` plus appropriate ARIA.
- [x] Implement sortable headers as buttons inside `<th>` and set `aria-sort` on the active column.
- [x] Ensure filter/remove-column controls have unique names including their column.
- [x] Preserve focus sensibly across table rerenders and announce changed row/filter counts.
- [x] Prefer stable-node updates or capture/restore focus by stable row/field/control identity after sort, filter, menu close, and select-all rerenders.
- [x] Expose filter popup relationships/state with appropriate `aria-controls`, `aria-haspopup`, grouping/menu semantics, and Escape behavior.
- [x] Add a caption and row-header strategy so screen readers retain table context.
- [ ] Test with keyboard, browser accessibility tree, and at least one screen reader.

### UI-05C — Make tooltips available to assistive technology and clamp them

**Priority:** P2

**Problem:** The shared tooltip remains `aria-hidden="true"`, triggers are not associated with it, and right-opening placement can leave the viewport on mobile. CSS pseudo-tooltips are generated content, while curve tooltips are pointer-only and can exceed viewport height.

- [x] Decide whether each tooltip is essential instruction or supplemental description; essential text must also exist persistently/semantically.
- [x] Assign stable tooltip IDs and connect visible descriptions with `aria-describedby` while shown or persistently when appropriate.
- [x] Synchronize `aria-hidden` with actual visibility.
- [x] Show tooltips on keyboard focus as well as hover and dismiss them on Escape/blur according to accessible-tooltip guidance.
- [x] Clamp/reposition on all viewport edges and account for scroll, zoom, and right-to-left layout if supported.
- [ ] Consolidate the shared, CSS pseudo-, and curve tooltip systems behind one accessible controller where practical.
- [x] Provide touch behavior and a maximum-height/scroll strategy for long scientific/metadata descriptions.
- [x] Verify tooltip content is present in the accessibility tree and does not trap focus.

### UI-05D — Give plots an accessible equivalent

**Priority:** P2

**Problem:** The plot SVG has no role, accessible name, `<title>`, `<desc>`, or structured text alternative. Color and pointer hover carry much of the meaning.

- [x] Add an accessible role and name describing plot type, sample count, channel, and current model/QC state.
- [x] Add `<title>`/`<desc>` that update when selection, axes, or model results change.
- [x] Provide a nearby table/text summary of series names, event counts, phase fractions, warnings, and axis ranges.
- [x] Ensure color groupings have text labels and sufficient contrast; do not use color as the only distinction.
- [ ] Make any keyboard-relevant region handles and toolbar operations understandable without reading the SVG geometry.
- [x] Mark decorative SVG layers/elements appropriately to prevent an unusable accessibility tree.
- [ ] Add accessibility-tree assertions and screen-reader review for empty, histogram-only, and modeled plots.

### UI-05E — Trap and restore modal focus

**Priority:** P2

**Problem:** Plot export, axis, Time QC, scatter, reconnect, and other custom modals focus an initial control but do not consistently trap focus, make the background inert, or restore focus to the trigger.

- [x] Centralize dialog opening/closing behavior or use the native `<dialog>` element where compatible.
- [x] Capture the trigger, focus a meaningful initial element, trap Tab/Shift+Tab, support Escape, and restore trigger focus on every close path.
- [x] Make the background inert and prevent hidden dialog controls from remaining tabbable.
- [ ] Ensure destructive/confirm dialogs have clear labels/descriptions and do not close on accidental outside click unless intended.
- [x] Handle nested/serial dialogs without losing the focus return stack.
- [ ] Add keyboard tests for first/last focus wrapping, Escape, Apply, Cancel, validation failure, and focus restoration for each modal type.

### UI-06 — Count bulk-fit outcomes once per sample

**Priority:** P2

**Problem:** Auto-Fit All increments `failed` during peak detection and can increment it again when it later attempts the same row. The displayed total can exceed the sample count.

- [x] Represent each sample with one terminal outcome and reason: converged/reportable, computed-nonconverged, detection failed, fit failed, cancelled, or skipped.
- [x] Skip later stages for samples that already reached a terminal detection failure.
- [x] Derive summary counts from the outcome map instead of mutable counters.
- [x] Preserve the exact per-row exception/validity reason and make it inspectable.
- [x] Add an outer `catch/finally` that restores all controls/progress and reports unexpected cohort-level failure.
- [x] Never phrase a computed-but-nonconverged fit or an invalid single fit as generic success.
- [x] Assert `success + failed + skipped + cancelled === attempted`.
- [x] Add mixed-outcome tests and verify each sample appears exactly once in the result summary.

### UI-07 — Reject invalid axis ranges before storing them

**Priority:** P2

**Problem:** Axis overrides accept equal or inverted bounds, store misleading state, and rely on renderer fallback. They can also trigger unnecessary model/histogram recomputation.

- [x] Validate finite `min < max` for each supplied axis and enforce any scientific domain restrictions.
- [x] Keep invalid input in the modal draft; do not mutate live axis/model state.
- [x] Show inline errors and focus the invalid field.
- [x] Distinguish visual viewport changes from scientific histogram/modeling domain changes and recompute only when scientifically required.
- [x] Add tests for empty/auto, equal, inverted, nonfinite, extreme, partially specified, and valid ranges.

### UI-08 — Define and test the modern-browser baseline

**Priority:** P2/P3

**Problem:** The code uses `structuredClone`, CSS `:has()`, `color-mix()`, module workers, OPFS, and other modern APIs without one documented support/fallback policy.

- [x] Define the minimum supported desktop Chrome/Edge, Firefox, and Safari versions based on required features.
- [x] Add feature detection and a clear startup capability report for required versus optional APIs.
- [x] Add safe fallbacks where inexpensive (`structuredClone` for plain config, non-`:has()` class hooks, color fallbacks).
- [x] Gracefully disable OPFS-only persistence while retaining core in-memory analysis where possible.
- [x] Make compatibility workflows test the declared minimums or explicitly state that only current versions are supported.
- [x] Publish the support matrix in Help and README.

### UI-09 — Remove stale DOM bindings and unreachable code

**Priority:** P3

**Problem:** Optional bindings such as `#plot_x_scale` and `#djf_readout` remain although no matching elements exist. Legacy/canonical overlap and stale code make refactoring riskier.

- [x] Inventory selectors queried by JavaScript against static and dynamically generated DOM.
- [x] Classify absent optional selectors as intentional extension points or dead code.
- [x] Remove dead bindings/listeners/styles and their stale tests/docs, or restore the intended controls with a documented contract.
- [x] Add a development/test assertion for required DOM references instead of failing later with a null dereference.
- [x] Keep dynamic selectors in one registry or component module to reduce string drift.

### UI-10 — Improve status/progress observability

**Priority:** P2/P3 improvement

- [x] Use stable operation IDs so superseded async loads/fits cannot overwrite newer status.
- [x] Separate transient progress, persistent warnings, and blocking errors visually and semantically.
- [x] Give determinate operations real progressbar semantics (`aria-valuemin/max/now`) and separate polite status from assertive alerts.
- [x] Ensure a blocking backdrop intercepts pointer input and its underlying controls cannot mutate operation inputs.
- [x] Announce appropriate updates through restrained ARIA live regions without reading every progress tick.
- [x] Include sample/stage context and a way to inspect/copy detailed diagnostics.
- [x] Preserve the full error in a persistent/copyable detail log instead of relying on a truncated footer.
- [ ] Add cancellation for long parsing, hashing, bulk fitting, and exports and test that cancellation releases workers/buffers.

### UI-11 — Coordinate concurrent operations and reject stale results

**Priority:** P1

**Problem:** QC, fitting, channel loading, selection changes, and delayed progress-hide timers use separate busy state. A prior operation can commit after inputs change or hide the progress UI owned by a newer operation.

**Affected files:** `js/analysis/pipeline_ui.js`, `js/analysis/cell_cycle/modeling_ui.js`, `js/ui/status_channels.js`, `css/feedback.css`.

- [ ] Introduce one operation coordinator that issues monotonically increasing run IDs and owns cancellation, progress, and final status.
- [ ] Capture immutable input/state revisions at operation start and reject results when files, selection, channel, masks, histogram, regions, bins, settings, or axes have changed.
- [ ] Cancel or supersede workers/promises when a newer incompatible operation starts.
- [ ] Associate every delayed hide/cleanup timer with the run that created it; an old timer must not affect a new operation.
- [ ] Make a “blocking” overlay actually intercept input, or disable every control that can invalidate the operation while retaining a working Cancel action.
- [ ] Keep independent per-row ridge fits concurrent where safe rather than serializing them through one unrelated global flag.
- [ ] Add rapid-sequence tests for QC→channel change, fit→region edit, fit-all→selection change, and overlapping progress operations.
- [ ] Assert stale results never mutate table, plot, session, or status state.

### UI-12 — Never clip live samples when staged and unstaged histograms mix

**Priority:** P1

**Problem:** If any displayed sample has a frozen Stage-4 histogram, the shared range can be derived only from staged histograms. Unstaged samples with a wider live extent are then binned outside that range and silently clipped in overlay and ridge rendering.

**Affected file:** `js/plotting/render.js` around the shared overlay and ridge range selection.

- [ ] Define one versioned histogram-range contract for the complete visible cohort.
- [x] When staged and live samples mix, union compatible extents or explicitly require/recompute all samples on one accepted range.
- [x] Invalidate dependent fits when the scientific histogram range changes.
- [x] Track and surface underflow, overflow, and in-range event counts per sample for frozen/manual ranges.
- [x] Warn or block when a sample has meaningful clipped mass rather than drawing a plausible incomplete curve.
- [ ] Add overlay and ridge tests with a narrow staged sample beside a wide unstaged sample; assert extrema/events are not silently lost.
- [ ] Add selection-change tests proving a newly visible wider sample updates or invalidates the shared range correctly.

### UI-13 — Make ridge statuses and region edits truthful and independent

**Priority:** P1

**Problem:** Ridge rows can show “Ready to model” regardless of missing, stale, failed, or nonconverged results. Edit/refit errors are swallowed, and one global pending flag can serialize or suppress unrelated rows.

- [x] Derive each row badge from explicit state: no regions, ready, fitting, converged, nonconverged, stale, warning, failed, or cancelled.
- [x] Include the reason and last successful revision in an inspectable text status.
- [x] Track pending/error state per sample; disable only the affected row unless a shared cohort operation requires otherwise.
- [x] Report region-edit/refit failure and keep the visible controls/state consistent; do not silently revert.
- [ ] Add numeric and keyboard editing equivalents for every ridge boundary/handle.
- [ ] Add tests for two simultaneous row edits/fits, stale results, nonconvergence, worker failure, and retry.
- [ ] Assert badges, stored model state, table values, and export labels agree.

### UI-14 — Make plot exports complete, bounded, and reproducible

**Priority:** P1/P2

**Problem:** Beyond the first-SVG ridge loss, export omits HTML ridge headers/badges and the HTML fit-results table even though the dialog implies “exactly as drawn.” Rasterization uses a fixed high scale without a pixel/memory ceiling, repeat submission is possible, Enter on unintended controls can submit, and generic filenames lack analysis provenance.

**Affected files:** `js/plotting/plot_export.js`, `js/plotting/modeling.js`, `js/plotting/plot_toolbar.js`, export modal in `index.html`.

- [ ] Define the exact export contract for overlay and ridge views, including labels, badges, legends, phase table, diagnostics/warnings, axis state, and every visible sample.
- [ ] Create a composite export document/SVG that includes required HTML-only content in semantic graphical/text form.
- [ ] Embed or accompany exports with sample/channel/view/model/bin/range/QC identifiers and a provenance/version block.
- [ ] Generate informative safe filenames without exposing unnecessary local paths/private metadata.
- [x] Set maximum width, height, pixel count, and estimated memory; offer lower scale/pagination when exceeded.
- [x] Prefer Blob/Object URLs over large base64 data URLs and revoke them after download.
- [x] Disable Download during encoding, reject repeat submissions, expose progress/cancel, and restore controls in `finally`.
- [x] Submit on Enter only from the intended form/default action; Enter on Cancel/Close/format controls must not download.
- [x] Add an ARIA-live error region and preserve detailed encoder errors.
- [ ] Test equivalent content in SVG/PDF/PNG/JPEG for overlay and multi-row ridge; test oversized output, failure, cancellation, repeated click, and keyboard controls.

### UI-15 — Fix destructive Enter and reachability behavior in draggable dialogs

**Priority:** P2

**Problem:** In the axis dialog, Enter bubbling from Reset, Cancel, or Close can call Apply before the button action. Dragging is mouse-only and a remembered card position can reopen off-screen after viewport changes.

- [ ] Convert the dialog controls to an actual form with one explicit default submit button.
- [x] Ensure Reset, Cancel, Close, and drag handles cannot trigger Apply through key bubbling.
- [x] Use pointer events for mouse/touch/pen dragging and provide a non-drag keyboard-accessible layout.
- [x] Clamp stored dialog position on every open, resize, orientation change, and zoom change.
- [x] Provide a “reset dialog position” fallback.
- [ ] Explain in the axis UI which X-bound changes alter histogram/model inputs versus viewport-only pan/zoom.
- [ ] Add tests pressing Enter/Space on every control.

### UI-16 — Make peak-region form and slider state exactly match accepted state

**Priority:** P1/P2

**Problem:** Invalid peak-region text can remain visible while the last valid stored region stays active and Accept remains enabled. Horizontal sliders incorrectly declare `aria-orientation="vertical"`; a committed redraw can destroy the focused node during repeated keyboard adjustment.

**Affected files:** `js/analysis/cell_cycle/peak_review_ui.js`, `js/plotting/peak_region_overlay.js`, peak-region inputs in `index.html`.

- [x] Maintain one modal-local region draft shared by text inputs and overlay handles.
- [x] Mark invalid fields with `aria-invalid` and an associated error; disable Accept/Fit while any displayed value is invalid or regions overlap illegally.
- [x] Never fit hidden last-valid values while different invalid values remain visible.
- [x] Correct slider orientation and dynamically expose neighbor-constrained min/max/current values.
- [x] Preserve logical focus after a committed change or update the overlay node in place.
- [x] Announce boundary label, value, units, and constraints without excessive live-region noise.
- [ ] Add repeated arrow-key tests that do not require re-tabbing, plus text↔slider synchronization, invalid entry, Cancel, and Accept tests.
- [x] Assert the four displayed boundaries exactly equal the accepted/fitted region state.

### UI-17 — Preserve valid numeric zero in metadata/model tables

**Priority:** P2

**Problem:** Cell-cycle values rendered via truthiness show a valid numeric `0` as an em dash, conflating zero with missing data.

**Affected file:** `js/ui/table_render.js` around cell-cycle value formatting.

- [x] Replace truthiness checks with explicit nullish and finite-number checks.
- [x] Define display policy for zero, negative values, `null`, `undefined`, `NaN`, and infinities by column type.
- [x] Use the same formatter in table, export, tooltip, and restored-session views.
- [x] Add regression tests for `0`, `0.0`, very small positive values, null, missing, and NaN.

### UI-18 — Make secondary widgets keyboard/touch/AT operable

**Priority:** P2

**Problem:** Column-removal selection is click-only; panel resizers are `aria-hidden` mouse-only divs; scatter contains focusable interaction inside an incompatible image-only semantic.

- [x] Represent removable-column choices as named selectable controls with exposed selected state and keyboard operation.
- [x] Implement resizers as focusable separators with orientation, value/min/max, arrow/Page/Home/End keys, pointer/touch support, and reset.
- [ ] Persist resized values only after validation.
- [x] Give the scatter widget appropriate interactive semantics or supply equivalent form controls outside a decorative/image SVG.
- [x] Expose the gate center, covariance/size, coverage, rotation, retained count, and reset/apply actions textually.
- [ ] Test column removal, both resizers, and scatter editing by keyboard, touch, and accessibility tree.

### UI-19 — Meet contrast, focus, reduced-motion, and non-color requirements

**Priority:** P2

**Problem:** Some semantic background/foreground pairs fall below WCAG AA, generated sample/component colors can fail non-text contrast, translucent focus indicators are weak, and reduced-motion handling covers only a few animations.

- [ ] Audit all text, control, border, focus, chart, selection, warning, and component color tokens against applicable AA thresholds.
- [ ] Replace failing semantic tokens and test every interaction state, including disabled and forced-colors modes.
- [x] Add line styles, patterns, symbols, or direct labels so sample/model/QC meaning is not color-only.
- [x] Define one visible solid `:focus-visible` system and forced-colors overrides.
- [x] Add a global `prefers-reduced-motion` policy covering marching ants, panels, modals, tooltips, spinners, and Help smooth scrolling.
- [x] Retain nonanimated state cues when motion is removed.
- [ ] Add automated token contrast tests plus manual color-deficiency, forced-colors, and reduced-motion review.

### PERF-UI-02 — Make scatter preview scale with display points, not all events

**Priority:** P2 optimization

**Problem:** Each drag/coverage preview can recompute an event-sized gate, and extent calculations allocate full mapped arrays.

- [ ] Throttle visual preview to at most one animation frame.
- [ ] Calculate preview membership only for downsampled displayed points.
- [ ] Compute the authoritative full event mask once on commit, preferably in a worker.
- [ ] Compute min/max/extents in streaming loops without allocating full mapped arrays.
- [ ] Cancel stale commit calculations when a newer gate edit occurs.
- [ ] Benchmark the largest supported sample and assert smooth preview plus bounded allocation.

### PERF-UI-03 — Make statistics exception-safe and bounded

**Priority:** P2 optimization

**Problem:** Statistics loads all files with unbounded `Promise.all`, rebuilds/rescans value arrays for each statistic, and can leave Calculate disabled after an unexpected failure.

- [ ] Add bounded/adaptive file concurrency and cancellation.
- [ ] Load/clean the selected channel once per file and compute compatible statistics in one aggregation pass.
- [ ] Allocate/sort only when a requested statistic requires it; use selection algorithms or documented approximations for large medians/quantiles if appropriate.
- [ ] Move expensive aggregation to a worker after profiling.
- [ ] Wrap the entire operation in `try/catch/finally` and restore controls/progress under every outcome.
- [ ] Preserve per-file failure reasons and distinguish partial results from complete success.
- [ ] Add memory/concurrency/cancellation/partial-failure tests and numeric reference fixtures.

### PERF-UI-04 — Avoid full-cohort event work on every plot redraw

**Priority:** P2/P3 optimization

**Problem:** Redraw can recompact masks, copy stored histograms, clear/rebuild SVG, and compute histograms for unchecked files only for the debug API. Persistent debug maps can retain stale samples.

- [ ] Cache compacted arrays/histograms by file, channel, mask revision, bin/range revision, and QC/model revision.
- [ ] Invalidate caches explicitly when their scientific inputs change.
- [ ] Compute unchecked/debug-only series lazily and remove map entries on deselection, file removal, channel change, and reset.
- [ ] Update stable SVG layers instead of destroying/recreating invariant structure; evaluate canvas only after accessibility/export requirements are preserved.
- [ ] Instrument event scans and assert resize/pan/tooltip-only actions do not rescan all events.
- [ ] Add a performance test proving unchecked samples add negligible redraw cost.

### UI-20 — Extend responsive fixes into every component

**Priority:** P2

**Problem:** Fixing the page scroll owner alone does not address a 460px plot minimum height, fixed right plot margin, 620px scatter minimum, `100vh` modal cards, fixed metadata action widths, and sidebar overflow behavior.

- [x] Use responsive plot margins/tick density/legend placement based on available size.
- [x] Let scatter and metadata controls reflow below their desktop minimums without horizontal page overflow.
- [x] Use dynamic viewport units and scrollable modal bodies that retain visible headers/actions.
- [x] Wrap/reorder metadata actions and define a single sidebar scroll owner in file/modeling modes.
- [x] Account for safe-area insets and mobile browser chrome.

### MAINT-03 — Consolidate repeated dialog/UI contracts and break import cycles

**Priority:** P2/P3

**Problem:** Dialog keyboard/focus/error logic, escaping, direct DOM capture, status handling, and validation are duplicated. Import cycles include plotting render/modeling and several table/metadata modules, increasing stale-state and initialization risk.

- [ ] Extract shared dialog, validated-draft, operation, progress/status, and asset-URL controllers.
- [ ] Consolidate HTML/text escaping and remove parallel implementations after tests prove equivalence.
- [ ] Break controller/render/data cycles with dependency injection, events, or lower-level pure modules.
- [ ] Add an import-graph CI check with an explicit temporary allowlist and a target of no new cycles.
- [ ] Add one shared dialog contract test suite for Enter, focus, Escape, Apply, Cancel, validation, failure, and restoration.
- [ ] Keep scientific calculation modules DOM-free and make UI adapters consume typed result contracts.

### PERF-UI-01 — Profile before optimizing large-table and plot interactions

**Priority:** P3 improvement

- [ ] Create representative performance fixtures for many files, long metadata, large event counts, ridge plots, and repeated model overlays.
- [ ] Measure initial load, table rerender, filter/sort, plot redraw, pan/zoom frame time, bulk fit, export, and memory.
- [ ] Preserve the existing animation-frame coalescing for viewport redraws.
- [ ] If table rerender dominates, introduce keyed row updates or virtualization without breaking focus, selection, filters, or accessibility.
- [ ] If plot redraw dominates, cache invariant scales/paths/components and invalidate them by explicit state version.
- [ ] Add performance thresholds broad enough for CI stability and track trends rather than microbenchmark noise.

---

## 6. Automated tests, browser compatibility, and developer workflow

### CI-01 — Remove the unsupported native Safari integration

**Priority:** P1

**Problem:** Native Safari service credentials and infrastructure were never established, so the repository must not carry or advertise an integration that cannot run.

- [x] Remove the unused native Safari workflow, service-specific test, and dependency file.
- [x] Retain Playwright WebKit as rendering-engine compatibility coverage.
- [x] Name WebKit accurately and do not present it as native Safari validation.
- [x] Keep native Safari outside the supported CI matrix unless a working service is deliberately added later.

### CI-02 — Make a missing or crashed unit phase fail the combined runner

**Priority:** P1

**Problem:** Unit-harness load failure can be recorded as WARN; other unit-run exceptions are caught and printed. Exit status considers only recorded FAIL rows, so zero unit results can still return success.

**Affected files:** `tests/unit/driving_code/run_unit_tests.py`, `tests/e2e/driving_code/drive_flow.py`, combined report generation.

- [ ] Track an explicit phase status for E2E setup, every E2E group, unit setup, unit execution, report generation, and cleanup.
- [x] Treat a harness load error, uncaught unit runner exception, zero discovered unit tests, or fewer than the expected minimum as a hard failure.
- [x] Preserve the exception in the generated report and process exit status.
- [x] Distinguish genuine test WARN results from infrastructure failure.
- [x] Add self-tests that intentionally break the unit harness URL, throw in the runner, return zero tests, and time out.
- [ ] Assert every case exits nonzero and identifies the failed phase.
- [x] Make GitHub Actions fail even if report/video upload succeeds under `if: always()`.

### CI-03 — Add a production-`dist/` end-to-end suite

**Priority:** P0/P1

**Problem:** Current E2E starts a server at the repository root. It cannot catch missing Vite pages/assets, bad hashed paths, worker bundling/MIME issues, or manifest errors.

- [x] Add a clean-build test path that removes/isolates prior `dist`, runs `npm ci` and `npm run build`, then serves only `dist/`.
- [x] Fail if any request made during the suite returns 4xx/5xx, excluding explicitly tested failures.
- [x] Follow the Help link and assert the expected Help content loads.
- [x] Toggle sidebar and metadata panels through every icon state and assert each image loads.
- [x] Fetch/validate the web manifest and every declared icon.
- [ ] Exercise FCS data worker, copy/fit workers, vendored D3, plot export, and session import from the built paths.
- [x] Assert no source-only module URL is requested from `dist/`.
- [x] Stop suppressing “expected” uncaught page errors by matching message text; exercise expected failures through typed result/error contracts so every real page error remains a failure. *(The production smoke fails on every page error.)*
- [x] Run the smoke suite under the same base path and headers used by Cloudflare. *(The dist-only server applies the built `_headers` contract at the production root base path.)*
- [x] Keep the broader source-tree E2E for fast diagnostics, but require the production smoke before release.

### CI-04 — Rationalize the browser/OS compatibility matrix

**Priority:** P2 optimization

**Problem:** The current matrix runs 3 operating systems × 5 browser labels. Chrome, Edge, and Brave share Chromium; Playwright “safari” is WebKit, not native Safari. The full cross-product is expensive without providing 15 independent compatibility signals.

- [x] Rename the Playwright target from Safari to WebKit in jobs, reports, and documentation.
- [x] Define coverage by rendering engine, browser channel, and OS-specific integration rather than an indiscriminate cross-product.
- [x] Run a fast PR matrix such as Chromium + Firefox + WebKit on one supported OS.
- [x] Run Edge on Windows and Brave on one representative OS outside the pull-request matrix.
- [ ] Keep at least one Windows production-artifact smoke for OS/path/download differences.
- [ ] Cache npm/Python/Playwright dependencies safely and avoid reinstalling Brave in jobs that do not need it.
- [ ] Publish a generated compatibility table with exact browser/engine/OS versions and pass/fail date.
- [x] Use `fail-fast: false` for evidence collection but make the overall required check fail if any required cell fails.
- [ ] Review job duration/cost after several runs and adjust from evidence.

### CI-05 — Eliminate the concurrent local-session test race

**Priority:** P1 for reliable parallel work

**Problem:** `suspended_local_autoload_config` renames `sessions/phasefinder_local.json` to one fixed `.e2e_suspended` path. Concurrent unit/E2E runs can restore or remove each other's file; this was observed during the audit.

**Affected files:** `tests/e2e/driving_code/helpers.py`, server handler/runner, local autoload logic.

- [x] Stop mutating the tracked working-tree session file during tests.
- [x] Prefer a test server handler that returns 404 only for `sessions/phasefinder_local.json`, or serve from an isolated temporary mirror/build directory.
- [x] If renaming remains temporarily necessary, use a process-unique backup plus an interprocess lock and atomic cleanup. *(Renaming was removed entirely.)*
- [x] Make cleanup idempotent when the source/backup is already missing and never overwrite a user's file. *(The server-only isolation path does not modify or restore the file.)*
- [x] Give every run a unique results/test-data directory to prevent parallel cleanup collisions.
- [ ] Add a self-test that launches two runners concurrently and verifies both finish with the original local-session file byte-identical.
- [ ] Add abnormal termination/KeyboardInterrupt tests and verify cleanup/restoration.

### CI-06 — Bound test-report and console output

**Priority:** P2 optimization

**Problem:** Some successful test details serialize full masks/arrays and produced roughly 480,000 output tokens in the audited combined run. This wastes CI storage/bandwidth, hides failures in truncation, and slows agents.

- [x] Add a shared safe-detail serializer with maximum depth, array preview length, string length, and total bytes.
- [x] Report array length, summary statistics, checksum, and a short head/tail instead of thousands of elements.
- [ ] Keep full diagnostic payloads only in an opt-in artifact when a test fails.
- [x] Put the final summary and failing tests before verbose passing detail in console output.
- [ ] Default video/screenshots to failures or selected visual tests rather than generating expensive evidence for every passing check.
- [ ] Add a test that passes a huge mask/detail and asserts bounded Markdown, HTML, and console sizes.
- [x] Preserve enough numeric precision/context to debug scientific failures.

### CI-07 — Make result directories and cleanup parallel-safe

**Priority:** P2

- [x] Generate a unique run ID and directory for results, synthetic FCS data, videos, screenshots, and import fixtures.
- [x] Never delete another active or historical run at startup.
- [ ] Update “latest” pointers atomically only after a complete report is written.
- [ ] Apply retention by age/count in a separate cleanup step with explicit directory validation.
- [x] Ensure generated fixtures/artifacts remain git-ignored while `.gitkeep` and required static fixtures remain tracked.
- [ ] Add parallel and interrupted-run tests.

### CI-08 — Enforce meaningful pre-commit behavior or document it honestly

**Priority:** P2/P3

**Problem:** README says the tracked hook blocks dirty worktrees, but the exits in `.githooks/pre-commit` are commented out.

- [x] Decide whether a dirty-tree block is required; avoid a policy that prevents legitimate staged partial commits unless the team explicitly wants it. *(Dirty/untracked content warns but does not block.)*
- [x] Make hook behavior and README text agree.
- [x] Keep the hook fast enough for normal use; move the full multi-browser/production suite to CI if local latency is excessive.
- [x] Provide documented environment discovery instead of hard-coding `/tmp/flowvenv`.
- [ ] Add a lightweight hook self-test for clean, staged-only, unstaged, missing dependency, pass, and fail cases.
- [x] Ensure bypass policy (`--no-verify`) and required CI checks are documented.

### CI-09 — Add targeted regression suites for every audit fix

**Priority:** P1/P2

- [ ] Create a dedicated audit-regression test group keyed by the IDs in this document.
- [ ] Include scientific adversarial tests, malformed FCS tests, session security/migration tests, production asset tests, accessibility checks, and UI-state cancellation tests.
- [ ] Make each test name describe the previously incorrect behavior and expected invariant.
- [ ] Avoid snapshot-only scientific tests; assert quantities, constraints, tolerances, and provenance.
- [ ] Keep synthetic data generators independent enough that they do not simply reproduce the implementation under test.
- [ ] Track flaky retries separately and fail if a test only passes after retry until the flake is fixed.

### DEV-01 — Add static checks without creating a false sense of correctness

**Priority:** P3 improvement

- [ ] Add JavaScript linting focused on correctness: accidental globals, unreachable code, unsafe promises, duplicate imports, and broad empty catches.
- [ ] Add formatting only after agreeing on scope; do not combine whole-repository formatting with scientific fixes.
- [ ] Add required-DOM selector checks and import/reference checks.
- [ ] Validate GitHub Actions YAML, web manifest, TOML examples, Markdown links, and HTML structure in CI.
- [ ] Add a dependency update policy with automated tests and explicit review for major Vite/D3/Playwright changes.

### CI-10 — Add accessibility and user-preference coverage

**Priority:** P2

- [ ] Add keyboard-only paths for upload, table, panels/resizers, QC, peak review, modeling, ridge edits, exports, sessions, and every modal.
- [ ] Add automated accessibility checks such as axe, while retaining manual screen-reader verification for plots, tables, dialogs, and live status.
- [ ] Emulate reduced motion, forced colors, high contrast, and coarse/touch pointer behavior.
- [ ] Add cross-surface assertions for fractions, validity/status, session restore, and all export formats.
- [x] Run WebKit under its accurate name without claiming native Safari coverage.

### PLAT-01 — Add supply-chain and release provenance

**Priority:** P2 improvement

- [x] Pin third-party GitHub Actions, especially floating `master` references, to reviewed releases or commit SHAs.
- [ ] Run Action/workflow security validation such as `actionlint` plus an appropriate workflow scanner.
- [ ] Add dependency review, vulnerability, license, and secret scanning without uploading private FCS/session fixtures.
- [x] Generate release checksums, dependency inventory/SBOM, source tag SHA, toolchain versions, and build metadata.
- [x] Expose a non-sensitive application version/commit so a deployment can be matched to its reviewed artifact. *(Published as `build-metadata.json`.)*
- [x] Verify the deployed file inventory and hashes match the inspected workflow artifact. *(Checksums are verified before the exact artifact is uploaded and deployed.)*
- [ ] Retain the previous successful deployment ID and exercise rollback on a staging project.

### PLAT-02 — Govern independent golden fixtures

**Priority:** P2/P3 improvement

- [ ] Maintain a small immutable, licensed golden FCS corpus with a SHA-256 manifest and expected semantics from an independent reader.
- [ ] Separate independent golden/reference fixtures from self-generated regression fixtures.
- [ ] Keep private biological data outside the public repository and define a reviewed deidentification/benchmark-ingestion process.
- [ ] Verify fixture hashes in CI and fail on silent mutation.
- [ ] Record source, license, FCS version/encoding, instrument/transform assumptions, and expected values for every fixture.
- [ ] Track CI duration, flake rate, artifact size, browser-specific failures, and benchmark drift.

---

## 7. Documentation, provenance, and maintainability

### DOC-01 — Bring README, Help, and release preview in sync with reality

**Priority:** P2

**Problem:** README says there is no build/package-manager pipeline and includes stale modeling language. Help mislocates its own link, conflicts with persistent OPFS behavior, and omits current modeling, Time QC, ridge, viewport, bulk-fit, and export features. `release-notes-preview.html` references a missing temporary absolute stylesheet.

- [ ] Rewrite install/development/build/preview/test/deployment instructions around the pinned Node/npm workflow.
- [ ] Remove contradictory CDN/no-build/no-package-manager/model-not-wired statements.
- [ ] Document source serving versus production `dist` serving and why `file://` cannot load the app.
- [ ] Update the feature tour for both Time QC methods, QC failure/degraded states, peak review, DJ/DJF/Auto/Watson, bulk fitting, ridge mode, viewport tools, and all export formats.
- [ ] Correct the Help-link location and describe OPFS persistence, quotas, reset, cache controls, and privacy accurately.
- [ ] State supported FCS formats/transforms, browser versions, scientific limitations, and which model outputs are heuristic versus generative.
- [ ] Correct `tests/e2e/README.md` for random-port behavior, current suites, browser/engine names, pre-commit behavior, and source-versus-`dist` modes.
- [ ] Reconcile application/package/release versions, copyright, license, and third-party notices.
- [ ] Generate release preview with repository-relative/embedded CSS and set a valid language attribute.
- [ ] Give Help images intrinsic dimensions, responsive sources where worthwhile, and below-fold lazy loading without losing useful alternative text.
- [ ] Add a documentation link checker and assertions that referenced UI labels/IDs still exist.
- [ ] Review documentation whenever a checklist issue changes public behavior.

### DOC-02 — Document scientific provenance and model contracts

**Priority:** P1/P2

- [ ] Cite primary references with equation numbers where possible.
- [ ] Map every public model parameter and component to units, bounds, transform, and equation.
- [ ] Document canonical phase-fraction definition, tail handling, contamination terms, convergence, model validity, and Auto-selection policy.
- [ ] Document QC methods as heuristics with failure modes, review requirements, and provenance fields.
- [ ] Explain the distinction between canonical modeling and any retained legacy bridge.
- [ ] Add a versioned machine-readable analysis provenance block to session/export results.

### DOC-03 — Keep architecture diagrams and file responsibilities generated/current

**Priority:** P3

- [ ] Update module/call-flow diagrams for the build pipeline, Time QC variants, canonical model state, workers, OPFS index, and production deployment.
- [ ] Generate module-import and page/asset graphs where practical instead of maintaining all edges manually.
- [ ] Add a CI staleness check or documented update command.
- [ ] Remove obsolete file responsibility statements after legacy code is removed.

### MAINT-01 — Centralize validation and typed result contracts

**Priority:** P2/P3 improvement

- [ ] Define shared schemas/validators for Time QC settings, axis ranges, model settings, FCS channel eligibility, session documents, and worker messages.
- [ ] Use discriminated result objects for success/skip/warning/failure instead of `null`, broad exceptions, and mutable status strings.
- [ ] Version worker/session/model contracts and reject incompatible messages deterministically.
- [ ] Keep scientific calculation modules independent from DOM/state mutation so they remain easy to test against references.
- [ ] Add JSDoc/TypeScript checking or another lightweight type-checking layer incrementally around these contracts.

### MAINT-02 — Make constants and policy thresholds traceable

**Priority:** P3

- [ ] Inventory magic thresholds in model selection, S-profile repair, QC, peak detection, memory/concurrency, and UI timing.
- [ ] Move policy values into named versioned configuration with units and rationale.
- [ ] Distinguish algorithmic constants from user-adjustable settings.
- [ ] Store analysis-affecting values in session/result provenance.
- [ ] Add boundary tests around every policy threshold.

---

## 8. Suggested implementation order and dependency map

### Phase 1 — Contain release and privacy risk

- [ ] Complete REL-01 / PRIV-01 before publishing another release.
- [ ] Complete PRIV-02 and confirm deployable content contains no personal session/tool metadata.
- [ ] Complete REL-02 and add CI-03 production-artifact tests.
- [ ] Complete REL-03 so local, Actions, and Cloudflare use one reproducible toolchain.

### Phase 2 — Protect scientific result integrity

- [ ] Complete GATE-01 and QC-00/QC-01 so invalid inputs/outcomes cannot become authoritative results.
- [ ] Complete SCI-01, SCI-02, SCI-03, SCI-04, SCI-05, and SCI-06.
- [ ] Complete STATE-01, PEAK-01, and DOMAIN-01 so every fit is keyed to effective, reviewed, reproducible inputs.
- [x] Complete DATA-01 and DATA-04 so invalid/degraded inputs cannot reach modeling silently.
- [ ] Add all corresponding CI-09 adversarial tests before refactoring optimizer internals.

### Phase 3 — Secure data and sessions

- [x] Complete DATA-02 and DATA-05.
- [ ] Complete SEC-01 before accepting shared session files as trusted state.
- [ ] Complete SES-02 digest support before claiming saved-session reproducibility.
- [ ] Complete SES-01 cache ownership/reset and SES-03 transactional restore.
- [ ] Complete SEC-02 and storage/privacy UI work.

### Phase 4 — Correct UI state and accessibility

- [ ] Complete UI-01A/UI-01B and UI-02 before relying on Time QC/Run All status.
- [ ] Complete UI-03/UI-20 and the UI-05/UI-18/UI-19 accessibility groups.
- [ ] Complete UI-04, UI-06 through UI-17, including operation ownership and truthful ridge/export/peak state.
- [ ] Add production-browser and accessibility tests for each path.

### Phase 5 — Numerical hardening and independent validation

- [ ] Complete SCI-07 through SCI-14, STAT-01, QC-02 through QC-06, and LEGACY-01 with before/after reference fixtures.
- [ ] Complete UNC-01 so quantitative outputs include identifiability/uncertainty evidence.
- [ ] Complete VALID-01 and publish the supported scientific claim boundary.
- [ ] Do not label the software scientifically validated until domain review and predefined tolerances pass.

### Phase 6 — Performance and long-term maintenance

- [x] Complete DATA-03 after memory profiling establishes the baseline.
- [ ] Complete BUILD-01, CI-04 through CI-08, PERF-UI-01, and DEV-01.
- [ ] Complete documentation and maintainability items and keep them enforced in CI.

---

## 9. Final release and scientific-readiness gate

Do not close the audit merely because every implementation checkbox is checked. Run this final evidence gate:

- [ ] No open P0 finding remains, and every deferred P1 has an owner, rationale, and explicit release approval.
- [ ] A clean clone with the pinned Node version passes `npm ci`, all required tests, and `npm run build`.
- [ ] The full source regression and production-`dist` regression pass with no missing phase, unexpected warning, page error, failed request, or test retry.
- [ ] Required current browser engines pass the documented compatibility matrix.
- [ ] The production artifact allowlist, privacy scan, asset crawl, CSP check, and size budgets pass.
- [ ] Cloudflare staging deployment passes the post-deploy smoke test and its artifact hash matches the reviewed build artifact.
- [ ] Every final DJ/DJF result satisfies parameter/region/ratio constraints and exposes honest convergence/validity state.
- [ ] Watson debris/aggregate adversarial fixtures no longer inflate S phase.
- [ ] Plot, sidebar, table, session restore, TSV, and downloaded plots agree on canonical phase fractions.
- [ ] Unsupported/scaled/uncompensated FCS inputs are transformed correctly or blocked before modeling.
- [ ] Session reconnect rejects same-name/same-size changed content and Reset removes all owned OPFS data.
- [ ] Keyboard, screen-reader, 200% zoom, and modal-focus acceptance checks pass.
- [ ] Reference-model and reference-FCS comparisons meet predefined tolerances, with uncertainty/limitations documented.
- [ ] README, Help, support matrix, scientific provenance, privacy/storage behavior, and release notes match the released code.
- [ ] A human scientific/domain reviewer approves the supported-use claims.
- [ ] A human release owner approves production deployment and rollback evidence.

## 10. Completion record template

Copy this block under an issue when an agent marks it complete:

```text
Issue ID:
Implemented by commit/PR:
Files changed:
Behavior before:
Behavior after:
Regression test(s):
Source test result:
dist test result:
Scientific/reference comparison (if applicable):
Compatibility/accessibility evidence (if applicable):
Migration/backward compatibility:
Remaining limitations or follow-up IDs:
Reviewer:
Date:
```
