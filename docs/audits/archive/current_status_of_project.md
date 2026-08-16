# PhaseFinder — current status and completion plan

**Written:** 2026-08-14
**Branch:** `cell-cycle-report-warn` (5 commits ahead of the last audit snapshot; working tree clean apart from three untracked docs)
**Purpose:** One document that says where the project actually is, what is left, and what to do first — with the goal of a **functional Dean–Jett–Fox method backed by a trustworthy report**.

> **How this document was built.** Every claim below was checked against the source tree today, not copied from the older planning docs. Where a planning doc and the code disagree, the code wins and the disagreement is called out in [§6](#6-documents-that-are-now-wrong). Statements taken from prior measurement runs (which cannot be re-run in minutes) are attributed to their source and marked as such.
>
> **Structure.** **Part I (§1–§8)** is the status: what is done, what is broken, what is stale. **[Part II](#part-ii--remediation-plan-with-code)** is the plan: seven work packages with drop-in code for each item, ordered by value, ending in a [suggested commit sequence](#suggested-commit-sequence). If you are starting work, read §1, §2, §3.0, then go to WP-1.

---

## 1. The one-page answer

**DJF works.** It converges on 30/30 real samples, produces reportable results on 30/30, and its fitted G1 position is right. It is not a broken feature — it is a working feature with **one dominant, precisely diagnosed, systematic error**.

**That error is G2 placement.** On all 30 samples of the FlowJo reference set, the fitted G2 mean sits *below* FlowJo's — never once above. Median −3.2%, and `g2_mean` alone fails 20 of 30 samples. Because a G2 placed too low overlaps S phase, and the area estimator sums raw counts without removing the S pedestal underneath, G2 also steals area that belongs to S. That single mechanism explains the whole remaining fraction error: **%G2 +7.0pp, %S −3.4pp**.

> **⚠️ Superseded on 2026-08-14 — read [WP-1.0](#wp-10--what-the-measurements-actually-say).** I re-measured this against synthetic ground truth and against the FlowJo reference. The G2 error **decomposes exactly** into a −1.5% G1 offset plus a −1.7% ratio difference, and roughly half of it is likely a property of the reference rather than a defect in our estimator. Of the three fixes proposed below, one is a clear win, one is inert, and one makes G2 *worse*. The paragraph immediately below is the older diagnosis, kept for continuity.

**The cause is three specific, independently fixable bugs in the peak estimator** — all confirmed present in the code today, all straightforwardly wrong rather than design tradeoffs. They are named with file and line in [§3.1](#31-step-1--fix-g2-placement-the-single-highest-value-change).

**The scoreboard.** `all_pass` is 7/30 against FlowJo. Fixing `g2_mean` moves that to **at least 9/30 mechanically** (it is the sole failing criterion on 2 samples) before any knock-on improvement to the fractions.

**What "a report" still needs.** The report *engine* is done and good — 850 lines of goodness-of-fit, residual structure, boundary-parameter detection, and warning generation, wired into the live pipeline. Three things are missing to make it a deliverable: **residuals are computed but never displayed anywhere** (a stated definition-of-done item), there is **no versioned JSON/CSV export**, and the **QC acknowledgement flow is not wired to the UI**. See [§4](#4-the-report-what-exists-and-what-is-missing).

**One environment blocker, fixable in a minute:** `.nvmrc` pins Node **22**, but the only version installed is **24** — so `nvm use` fails *and* `scripts/preflight.cjs` hard-rejects 24, which means `npm run check` cannot run at all today. `nvm install 22` fixes it. The Python side is fine: a working Playwright venv exists at `~/.venvs/playwright`, it just isn't auto-discovered. See [§2](#2-do-this-before-anything-else-5-minutes).

**The unit suite is green at 756/756**, confirmed by running it today.

**Hosting (Cloudflare Pages) is in good shape, with two shipping defects.** The deploy workflow now deploys `dist` rather than the repo root, is fail-closed behind a protected environment, and `public/_headers` carries a strict self-only CSP that `verify-dist.cjs` validates by hash. Pages' HTTPS also means OPFS — and therefore session caching — works in production. But the built artifact **404s on every page load** (`sessions/phasefinder_local.json`), and its importmap is dead markup pointing at a path absent from `dist/`. Both are small and both are public-facing. The remaining release items are blocked on Cloudflare account access, not code. See [§5.4](#54-hosting-cloudflare-pages).

---

## 2. Do this before anything else (5 minutes)

One real blocker, one papercut. Both verified today.

### 2.1 Node — `npm run check` currently fails, and so does `nvm use`

This is a genuine blocker, though not the obvious one:

| | |
|---|---|
| nvm's installed/default version | **v24.16.0** (the only one installed) |
| `.nvmrc` and `engines.node` | **22** / `"22.x"` |
| `nvm use` | ❌ `N/A: version "v22" is not yet installed` |
| `node scripts/preflight.cjs` on 24 | ❌ `PhaseFinder requires Node 22.x; found v24.16.0` (exit 1) |

Because `npm run check` begins with `npm run preflight`, **the entire gate — lint, docs, imports, privacy, tests, build, dist — cannot run today.** `nvm use` does not rescue it, because the version `.nvmrc` asks for was never installed.

```bash
nvm install 22     # the fix — one command
nvm use            # now succeeds
node scripts/preflight.cjs
```

*(Bare `node` outside nvm is `/usr/bin/node` v18.19.1, which Vite 8 also rejects. Non-interactive shells don't load nvm, so scripts and hooks will hit that v18 unless nvm is sourced.)*

Worth deciding: the audit trail records builds validated under **both** Node 22.23.2 and Node 24, while `.nvmrc` and `engines` pin 22 and only 24 is installed. Either install 22 and keep the pin, or move the pin to 24 deliberately — but don't leave the declared and installed versions disagreeing.

### 2.2 Python — the venv exists; it just isn't being found

**There is a working Playwright venv at `~/.venvs/playwright`** — Python 3.12.13, playwright 1.60.0, and Chromium verified launching today. Nothing needs installing.

The only issue is discovery. Test drivers look for `PHASEFINDER_TEST_PYTHON`, then `./.venv/bin/python`, then `python3` — and this project has no `.venv`, while bare `python3` resolves to `~/.local/bin/python3` (a uv-managed shim) that has no playwright. So `npm run test:unit` fails even though a perfectly good venv is sitting there.

```bash
# either
export PHASEFINDER_TEST_PYTHON="$HOME/.venvs/playwright/bin/python"
# or, better, make it permanent and zero-friction:
ln -s ~/.venvs/playwright .venv
```

The symlink is the better fix: `.venv` is already gitignored, and it makes `npm test` and the pre-commit hook work with no env var. **Recommended.**

Two minor notes, neither blocking: `requirements-dev.txt` pins playwright **1.61.0** but the venv has **1.60.0** (works fine — reconcile when convenient), and that venv lacks `flowio`, which is needed only by `generate_flowio_reference.py`. The external-tools comparison has its own venv at `tests/external_tools/.venv` with flowio 1.4.0, flowkit, numpy, and scikit-learn already installed.

### 2.3 Baseline — confirmed today

Run live during this review, not quoted from the handoff:

```bash
~/.venvs/playwright/bin/python tests/unit/driving_code/run_standalone.py --limited-media
# → 756/756 unit checks passed
```

**The suite is green at 756/756 as of 2026-08-14.** That is your before-picture; any change to the estimator should be measured against it.

---

## 3. The critical path to a functional DJF

This is the work that matters. Everything in this section is ordered — **do not reorder it**, because each step's measurement is only interpretable once the previous one has landed.

### 3.0 Read this first, or you will repeat a week of failed work

`docs/audits/cell_cycle_model_investigation_handoff.md` §5 documents **five model changes that were attempted and measured, four of which made results worse**. Two traps in particular:

- **Do not "free" the peaks into a joint fit.** It was tried. `all_pass` went 8/30 → **0/30**; %S went −2.9pp → **+12.0pp**. Synthetic fixtures said it would work; they lied, because they were generated by DJF's own equations.
- **Do not try to resolve (1C,2C) vs (2C,4C) ambiguity with another local heuristic.** Both pairings are ~2:1, and the smoothing the detector needs destroys the width evidence. Two separate discriminators were tried and both failed for provable reasons.

The estimator that ships freezes the peaks at a clean-flank estimate. **The goal is not to freeze or free them — it is to make the frozen estimate less biased.**

### 3.1 Step 1 — Fix G2 placement (the single highest-value change)

Three defects, all verified present in the source today. Each is independently testable.

| # | Defect | Location | Fix |
|---|---|---|---|
| 1 | **No baseline subtraction in the width estimate.** Walks out from the peak until smoothed count drops below `0.6 × peak` using the *absolute* height. A peak sitting on the S-phase pedestal stays above that threshold further out, so σ is inflated. | [peak_regions.js:114](js/analysis/cell_cycle/peak_regions.js#L114) `estimateSigmaOneSidedWithinRegion()` | Threshold should be `baseline + 0.6 × (peak − baseline)`. Note the *fallback* path at [peak_regions.js:189](js/analysis/cell_cycle/peak_regions.js#L189) already computes `localLinearBaseline` — the primary path just doesn't use it. |
| 2 | **Smoothing width never removed.** σ is measured on a histogram Gaussian-smoothed at `smoothingSigmaBins: 2`, so it measures √(σ² + 2²), not σ. | [peak_regions.js:173](js/analysis/cell_cycle/peak_regions.js#L173) | Deconvolve in quadrature — a one-line correction. This is the same arithmetic the handoff already uses to explain the detector's limits; it simply is not applied here. |
| 3 | **Mean quantized to a bin centre.** `mean: centers[peakIndex]` — no sub-bin interpolation. | [peak_regions.js:211](js/analysis/cell_cycle/peak_regions.js#L211) | Three-point parabolic fit around the smoothed argmax. Removes up to half a bin. |

**Prior measurement** (from the handoff §8.1, on a synthetic fixture — diagnostic of mechanism, *not* proof of benefit): all three together close roughly a third of the deviance gap and recover ~2pp of %S.

**Expect them to be necessary but not sufficient.** None addresses the deeper issue that the smoothed argmax inside the G2 region is dragged left by S-phase mass. If the three corrections leave `g2_mean` short, the next move is estimating the peak centre jointly with a *coarse* S model in one lightweight pass — which is **not** the joint fit that failed in §5.1, because there the S term was free to reshape itself; here it would only relocate the peaks.

**Acceptance:** validate on the 30-sample set. The metrics are `all_pass` (currently 7/30) and the `g2_mean` pass count (currently 10/30). Validate **each correction separately** — §5.3 of the handoff is a cautionary tale about an intervention that looked perfectly separated in aggregate data and fixed exactly one sample.

### 3.2 Step 2 — Re-check the area bias *after* G2 moves

[watson_pragmatic.js:117](js/analysis/cell_cycle/models/watson_pragmatic.js#L117) `refine_local_area()` sums raw counts across the window with no pedestal subtraction, so a G2 window overlapping S absorbs S mass.

**Do not fix this at the same time as §3.1.** With G2 correctly placed the overlap shrinks, and the correct size of this fix changes. Doing both blind makes neither attributable.

### 3.3 Step 3 — Reconsider async/sync BIC selection (only now)

This feature was **removed**, and the reason is subtle and worth understanding: with biased frozen peaks, the wave is the only flexible shape left in the model, so it absorbs peak misfit and runs to its ceiling. It was **claiming a synchronized cohort on asynchronous data**. Measured on a wave-free fixture, it selected "synchronous" with ΔBIC −102.9; frozen at the *true* peaks, the same code correctly selected asynchronous at ΔBIC +16.7.

**The code was right; the peaks were wrong.** Once §3.1 lands, this becomes re-landable — and it is what the reference implementation (§13, Steps 6–9) prescribes. Re-land it alone, with its guards (`ΔBIC > 10`, `bumpFraction ≥ 2%`, cohort inside S phase, restart-stable), and validate before keeping.

### 3.4 Validation harness — how to actually measure

```bash
PY=~/.venvs/playwright/bin/python
for i in 0 1 2 3 4 5 6 7 8 9; do
  "$PY" tests/validation/driving_code/validation_tests.py \
    --flowjo-only --keep --shard "$i/10" &
done
```

Three hard-won practical notes:

- **Budget ~70 minutes, not the 20 the older doc claims.** Ten concurrent Chromium instances contend badly.
- **Do not edit any `js/` file while a run is in progress.** The test server reads from disk per navigation, so shards silently pick up new code partway through and the run is void.
- **When aggregating `comparison_*.json`, filter on the `qc_applied` array, not the label string `"Structural QC"`** — the label is `"Structural"` and the literal string matches nothing.

Per-sample visual review (histogram, region bands, filled components, detector candidates, active constraints):

```bash
~/.venvs/playwright/bin/python tests/validation/driving_code/render_fit_review.py
```

### 3.5 A note on what "correct" means here

`qc_structural` scores closest to FlowJo, but **this does not mean "use less QC."** Singlet gating correctly removes G1–G1 doublets that sit at 2C and would otherwise be counted as G2. The reference manifest itself states FlowJo's exact pre-fit gating is undocumented. `qc_structural` is the closest *configuration match to an unknown reference*, not necessarily the most correct analysis. Do not optimize the science toward FlowJo agreement past the point where the difference is explained by gating.

---

## 4. The report — what exists and what is missing

### 4.1 What is already built and good

[`js/analysis/cell_cycle_fit_report.js`](js/analysis/cell_cycle_fit_report.js) (850 lines), consumed by the live pipeline at [cell_cycle_pipeline.js:25](js/analysis/cell_cycle_pipeline.js#L25), already computes:

- component integration, singlet and contamination fractions, parameter counts
- goodness of fit; residual structure via **lag-1 autocorrelation, Durbin–Watson, maximum local bias**
- **boundary-parameter detection** (`findBoundaryParameters`) — catches precise-looking fits pinned against a bound
- pulse-geometry detection, peak-visibility inspection, constraint extraction
- a structured warning system with severities, and a display summary layer

Supporting surfaces also exist: the metadata table writes per-model %G1/%S/%G2 columns ([cell_cycle_columns.js:109](js/ui/cell_cycle_columns.js#L109)), and the validation harness renders per-sample HTML review pages.

### 4.2 What is missing

| Gap | Evidence | Why it matters |
|---|---|---|
| **Residuals are never displayed.** Computed in the report and in every model, but `grep residual js/plotting/render.js` returns nothing, and there is no residual element in `index.html`. | verified today | The modeling plan's definition of done states *"residuals are visible by default."* This is also the single most useful thing a user can look at to judge a fit. Currently the best evidence of a bad fit is invisible. |
| **No versioned JSON/CSV export.** The plan specifies a new `js/analysis/cell_cycle/export.js`; the directory has no such file. | verified today | M6 exit gate requires *"export contains enough data to reproduce or independently inspect the fit."* Without it the report cannot leave the browser. |
| **QC acknowledgement flow not wired.** The result contract blocks reporting after critical QC removal until `qcAcknowledgements` is supplied — but no UI supplies it. | checklist QC-01, marked partial | A fail-closed gate with no way to satisfy it is a dead end for the user. |
| **Nonconvergence not surfaced prominently.** Contract-level honesty is done; sidebar/table/export prominence is not. | checklist SCI-03, open | A user can read a fraction without seeing that the fit did not converge. |

### 4.3 Recommended shape for the deliverable

Given the engine already exists, the remaining report work is presentation, and it should be sequenced **after** §3.1 — otherwise you will build a report that faithfully displays a known-biased G2. Suggested order: residual panel → nonconvergence prominence → versioned export → QC acknowledgement flow.

---

## 5. Everything else outstanding

The remediation checklist stands at **650 of 789 items complete, 139 open** — but see [§6.1](#61-the-remediation-checklist-is-stale): a meaningful number of those 139 are actually done and never ticked.

### 5.1 Genuinely open, grouped by what they block

**Blocks a scientific claim (do before calling anything "validated"):**

- **VALID-01** (9 open) — the big one. Equation-to-code mapping for Dean/Jett/Fox/Watson with units; DJ vs DJF component-curve comparison across a parameter grid; datasets spanning more than one instrument and encoding (currently one: 30 yeast async samples, single instrument, local-only); uncertainty intervals; identifiability diagnostics; domain-expert review before using the word "validated."
- **UNC-01** (7 open) — no uncertainty reporting at all. Profile-likelihood or bootstrap intervals, resampling that includes peak-region and binning perturbation, flagging weakly-identified fits as non-reportable.
- **PEAK-01** (3 open) — detector thresholds are uncalibrated and the confidence score is not a probability but may read as one.
- **QC-03 / QC-04 / QC-06** (8 open) — all block on **one shared labeled calibration study**. Doing that study unblocks three items at once; it is the highest-leverage QC work.
- **FUTURE-01** (4 open) — explicitly deferred, correctly.

**Blocks release** (target is Cloudflare Pages — see [§5.4](#54-hosting-cloudflare-pages)):

- **REL-01/PRIV-01** (3 open) — staging deploy, test release, rollback deployment ID. The workflow itself is largely repaired; these three are **blocked on Cloudflare account access**, not on code.
- **PRIV-02** (2 open) — fresh-clone verification, and confirming the deployed artifact carries none of the removed private paths. The staging deploy answers the second. *(History rewrite was completed at owner request.)*
- **REL-03** (1 open) — fresh clone has never been proven to run `npm ci && npm test && npm run build`.
- **§9 release gate** (15 open) — including the staging artifact-hash match, the post-deploy smoke test, and two human sign-offs (scientific reviewer, release owner).

**Correctness and consistency:**

- **SCI-05** (2 open) — cross-surface test that plot/sidebar/table/TSV/session all show identical fractions for a fit with meaningful tail mass. Cheap and worth doing.
- **SCI-03** (2 open), **SCI-07** (2 open), **SCI-08** (1 open) — mostly before/after benchmarking of changes already made.
- **DOMAIN-01** (4 open), **STATE-01** (3 open), **GATE-01** (1 open) — provenance persistence and a single validator entry point.
- **PERF-MODEL-01** (7 open) — cancellation is not truly cooperative; canonical fits can silently run on the main thread. Real but not blocking.

**Documentation and maintenance:** DOC-02 (5), MAINT-02 (5), PLAT-02 (6), DOC-03, MAINT-01, CI-04, CI-09, PLAT-01.

**UI/accessibility:** UI-19 (3), PERF-UI-01 (3), UI-04, UI-05B, UI-05D, UI-14 — one item each.

### 5.2 Dead code worth deleting

**`js/analysis/djf/` — 21 files, 6,630 lines, completely unreachable.** Verified today: nothing outside the directory imports it (`grep "djf/"` across `js/` returns zero external hits). The live pipeline is `js/analysis/pipeline_loader.js` → `cell_cycle_pipeline.js`. The unit tests named `unit_tests_djf_*.py` exercise the *live* pipeline through the harness, not this directory.

This is confusing in a way that actively costs time — it contains `stage8_report.js`, `pipeline_ui.js`, `pipeline_state.js` and `scatter_modal.js`, all of which have live counterparts with the same names. `djf-pipeline_report.md` in the repo root reviews this dead code as though it were shipping.

**Recommendation: delete the directory and archive `djf-pipeline_report.md`.** The handoff notes it was left alone only because two files had uncommitted edits from another task — the tree is clean now, so that reason has expired. Run `npm run check:imports` afterward.

### 5.3 CLOCCS

Registered as `cloccs`, version `0.1.0-unverified`, labeled "CLOCCS (Unverified)" in the dropdown, `fitScope: "joint_series"`, capability flag `unverified: true`. It has a worker, a client, a synthetic generator, and a unit suite.

`todo.md` asks whether it matches `CLOCCS_modeling.md`. **That file does not exist anywhere in the repo** — not in `docs/`, not in `docs/plans/`, not in `assets/`. If you have it, it needs to be added before that question can be answered. Otherwise the spec of record is `docs/plans/cell_cycle_modeling_plan.md` §5.6, and CLOCCS's gate is M8 — explicitly after per-sample validation. **It is correctly out of scope for finishing DJF.**

### 5.4 Hosting — Cloudflare Pages

**Target: Cloudflare Pages.** `package.json` is `"private": true` — npm is build tooling only, nothing is published. The app is pure static output with no server-side runtime, which is exactly what Pages wants.

#### What is already right

The deploy workflow has been substantially repaired. Verified in `.github/workflows/deploy-release.yml`:

- deploys **`dist`**, never `.` — `wrangler pages deploy dist --project-name=phasefinder --branch=main`
- fail-closed behind `vars.ENABLE_PRODUCTION_DEPLOY == 'true'`, with `environment: production` for protected approval and a `concurrency` group so an older release cannot overwrite a newer one
- a `workflow_dispatch` path exists for staging

**`public/_headers` is the correct Pages mechanism and is emitted into `dist/`.** It sets a strict CSP (`default-src 'self'`, no external hosts, no CDN), `nosniff`, `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY`, a Permissions-Policy, and immutable caching for hashed `/assets/*` with must-revalidate on HTML and the manifest.

One genuinely nice piece of engineering worth not breaking: the CSP pins the inline importmap by hash (`sha256-QegS…`), and **`verify-dist.cjs` recomputes that hash from the built HTML and checks it**. Edit the importmap and the build fails rather than shipping a CSP that silently blocks the page. Verified matching today.

#### Pages gives you HTTPS, which resolves the one real runtime constraint

`navigator.storage.getDirectory` (OPFS) — the browser-private FCS cache behind fast session reload — requires a **secure context**. Measured today:

| Served at | `isSecureContext` | OPFS |
|---|---|---|
| `http://127.0.0.1` | ✅ true | ✅ available |
| `http://192.168.1.100` (plain-HTTP LAN IP) | ❌ false | ❌ **unavailable** |

**On Pages this is a non-issue** — everything is HTTPS, so OPFS works in production. It matters only for **local preview shared over a LAN**, where it fails *silently*: the app boots with zero console errors and the cache is simply gone.

Still worth a small fix, now low priority: `browser_capabilities()` in [compatibility.js](js/ui/compatibility.js#L19) classifies `opfs` as *optional*, and `init_compatibility()` warns only for `missingRequired`, so `missingOptional` is recorded on `window.PhaseFinderCompatibility` and surfaced nowhere. A one-line notice turns a confusing dev-time mystery into an explanation.

#### Two real defects in the built artifact

Both ship to production as-is:

- **`dist/` logs a 404 on every page load.** It fetches `./sessions/phasefinder_local.json` — the personal autoload config, correctly excluded from the build. The JS treats absence as silent *by design*, but the browser still records a failed request and a red console error. This will be visible to every visitor on the public site. `verify-dist.cjs` cannot catch it because it is a runtime fetch, not a static reference. Fix: check before fetching, or ship an empty `{}`.
- **The importmap in `dist/index.html` is vestigial and points at a path that does not exist in `dist`.** It maps `d3` → `./js/vendor/d3.min.js`, but `dist/` has no `js/` directory — Vite bundles d3 and rewrites every bare `d3` import (confirmed: no `from"d3"` survives in the built output). Nothing resolves through it, so it is harmless, but it is dead markup that forces a CSP hash to exist for a script that does nothing. Dropping it from the built HTML would simplify the CSP.

#### Useful to know, not a deployment path

The **raw source tree also runs unbuilt** on any static server — the importmap resolves `d3` to the vendored copy, and workers use `new Worker(new URL(…), { type: "module" })`, which is native ESM. Serving the repo root with `python -m http.server` boots the app with **zero console errors and zero failed requests** (better than `dist/`, because the local session file is present).

That is not how you deploy, but it is worth knowing: it makes debugging trivial without a build step, and it confirms there is no hidden server-side dependency. There is also **no `SharedArrayBuffer`/`crossOriginIsolated` usage**, so no COOP/COEP headers are needed.

For subpath deploys, `vite.config.js` honours `BASE_PATH` and `npm run check:base` builds and verifies a `/phasefinder/` variant. For a root-domain Pages project the default `base: "/"` is correct.

#### What actually remains

The three open REL-01 items are blocked on **doing a deploy**, not on code — they need Cloudflare account access:

1. run `workflow_dispatch` against a **staging** Pages project; inspect the deployed file list and response headers
2. publish a **test release**; verify the public URL, Help link, panel icons, web manifest, worker-based FCS parsing, and one model fit
3. record **rollback instructions and the last known-good deployment ID** *(the artifact-based rollback procedure is already written in `docs/release-and-privacy.md`; only the deployment identifier is missing)*

Plus PRIV-02's check that the deployed artifact contains none of the removed private paths — which the staging deploy in (1) answers directly.

---

### 5.5 The two root-level audit docs — mostly resolved, four items survive

`needs_be_fixed_frontend_dev.md` (35 FE items) and `needs_to_be_fixed_ux.md` (9 UX items) are a separate review from 2026-07-17 that no one has reconciled since. **Most of it is done.** Spot-verified today:

| Item | Claim | Reality today |
|---|---|---|
| FE-003 | TOML prototype pollution | ✅ `FORBIDDEN_KEYS = {__proto__, prototype, constructor}` + `Object.create(null)` in `toml_io.js` |
| FE-028 | TSV formula injection | ✅ formula leaders neutralized in `metadata_io.js` |
| FE-024 / UX-09 | reduced motion | ✅ `prefers-reduced-motion` blocks in `base.css`, `plot.css`, `sidebar.css` |
| FE-017 / UX-03 | upload not keyboard-reachable | ✅ `#drop_zone` is now a real `<button>` with `aria-controls`/`aria-label` |
| FE-018 / UX-04 | modal focus | ✅ shared `js/ui/modal_focus.js` |
| FE-019 / UX-06 | plot absent from a11y tree | ✅ `make_plot_accessible()` sets `role="img"` + `aria-labelledby` |
| FE-002 / FE-001 / UX-01 | release workflow + autoload leak | ✅ workflow fixed, files untracked — **but see the `dist/` 404 in §5.4, which is the last residue of UX-01** |
| FE-034 | sessions can't reproduce fits | ✅ `model_version` recorded, drift labelled |
| FE-031 | no PR quality gate | ✅ four workflows incl. `node_build.yml`, `security.yml` |
| FE-032 | manifest paths broken | ✅ REL-02 |

**Correction (verified 2026-08-14): two more of these are already fixed.** An earlier draft of this section listed UX-02 and UX-08 as open. They are not:

- **UX-02 / FE-016 — fixed.** No hard-coded header subtraction remains. `body` uses `height: 100dvh`, and at `≤820px` `responsive.css` sets `.app { grid-template-rows: auto auto; height: auto; }` with `overflow-y: auto` and safe-area insets.
- **UX-08 — fixed.** Only one "Run All" remains (`#qc_filter_all`); the second belonged to the staged pipeline UI that is no longer wired in.
- **UX-05 — fixed.** The footer carries `role="status" aria-live="polite"` plus a separate `role="alert"` channel (`index.html:848-849`).
- **UX-07 — fixed.** Both resizers are `role="separator" tabindex="0"` with pointer *and* arrow-key handlers.

**Genuinely still open from these two files:**

- **FE-009 / PERF-MODEL-01** — `fit_client.js` still documents "caller falls back to the main thread" when no worker is available. A canonical scientific fit can therefore run on the UI thread silently.
- **FE-020 / UI-19** — `forced-colors` blocks exist in `base.css` and `help.css` and **nowhere else** (`sidebar.css` 0, `table.css` 0, `layout.css` 0, `plot.css` 0). `focus-visible` coverage is uneven, with `feedback.css` at 0.
- **UX-06** — axis-range editing is still reachable only by double-clicking invisible SVG hit areas. The plot toolbar has six buttons and none of them opens the dialog. This one matters because the axis range can be promoted to the scientific analysis domain.
- **UX-09** — still light-only. `color-scheme: light` is forced and there is zero `prefers-color-scheme` handling in any app stylesheet.

> **Full UI list with code fixes: [`docs/audits/ui_issues_report.md`](./ui_issues_report.md)**, which also covers items these two files never raised — chiefly that a fit result can display as an authoritative percentage without its convergence or reportability state, which is a UI problem with scientific consequences.

**Action:** these two files should be reconciled and folded into the main checklist, then deleted. Keeping a third and fourth parallel issue list is how items get lost — as `todo.md` already demonstrates.

### 5.6 Codebase audit — what a fresh sweep found (2026-08-14)

I swept the layers Part I had not covered, looking for unseen defects. **The core numerics are in good shape**; the findings are mostly latent traps and small inconsistencies.

**Model math — verified correct by execution, not reading.** Seven properties tested against ground truth in a Node sandbox:

```
1. Bernstein S profile integrates to 1.000000 over [0,1]        PASS
2. profile stays >= 0 across extreme shape params (min 2.6e-26) PASS
3. S-phase total mass == sArea (normalization)                  PASS
4. gaussianBinMass conserves area exactly                       PASS
5. peak narrower than one bin still conserves mass              PASS
6. inverted peaks (g2 <= g1) -> zeros, no NaN                   PASS
7. degenerate broadening CV=1e-9 stays finite                   PASS
```

The S-phase quadrature is a proper Gauss-Legendre integration over latent DNA occupancy with CV-scaled broadening, and it matches the reference's `σ_S(u) = CV₁·u`. Normalization is exact because the Bernstein weights sum to 3 and each basis polynomial integrates to 1/3. **No defects found in this layer.**

**Latent traps worth fixing cheaply:**

| Finding | Where | Risk |
|---|---|---|
| **`counts.map()` on histogram counts** | [watson_pragmatic.js:243](js/analysis/cell_cycle/models/watson_pragmatic.js#L243) | Safe **today** only because `dna_histogram.js` builds counts with `new Array(n)`. If anyone switches to a typed array for performance — a plausible optimization, and PERF-MODEL-01 invites exactly that — `.map()` returns the same typed array and **silently truncates S-phase counts to integers**. This is the identical bug class already fixed once in `poisson.js`. Convert to `Array.from(counts, …)` and the trap is gone permanently. |
| **Two different default bin counts** | `dna_histogram.js` `DEFAULT_BIN_COUNT = 512` vs `plotting/data.js` `DEFAULT_BINS = 256` | Different defaults in two modules for the same concept. Whichever wins depends on the call path. Should be one exported constant. |
| **`"type": "commonjs"` with an all-ESM source tree** | `package.json` | Harmless in the browser and handled by Vite, but it means Node treats every `.js` as CJS, so any Node-side tooling must use `.mjs`/`.cjs`. Worth a comment so the next person does not lose twenty minutes to it. |

**Checked and clean:** no `parseInt` without radix; no remaining TypedArray `.map()` bugs; `== null` uses are deliberate null/undefined checks; no unguarded division in the math modules (`Math.max(EPS, …)` guards are consistent); no `Array(n)` hole bugs.

### 5.7 Help documentation — audited and partly rewritten

The help centre is well-built (card grid, per-page sidebar, breadcrumbs, `callout` conventions) but had drifted from the app. **Fixed today:**

- **The model list was wrong.** `help-modeling.html` told users to pick "Dean–Jett, Dean–Jett–Fox, Watson Pragmatic, or Automatic" — but **Automatic no longer exists**, and **Watson Classic and CLOCCS were missing entirely**. Replaced with a five-row comparison table (what each model does / when to choose it) plus a callout explaining *why* Automatic was removed.
- **The Fit All description was wrong in a way that mattered.** It said Fit All "averages the regions across every plotted sample" — the pre-SCI-06 behaviour. It now describes what the code actually does: calibration compatibility checks, exclusion of failed/inferred/low-confidence detections, a **robust median** proposal rather than a mean, an explicit confirmation step, and independent fitting for excluded samples.
- **Nothing explained how to read a result honestly.** Added a section separating the three distinct questions — did the optimizer converge, is the result valid for reporting, do the warnings matter — because they are genuinely different and the UI reports them separately.
- **The two unresolvable ambiguities were undocumented.** Added a warning callout covering the single-peak G1 assumption and the (1C,2C) vs (2C,4C) degeneracy, with what the user should do about each.
- **Sidebar navigation was inconsistent.** Every sub-page listed 8 topics while `index.html` linked 10 — the two cell-cycle pages were reachable from home but not from any sub-page. Unified across all 9 sub-pages.

**Still outstanding on the help:**

- **Three orphaned pages**: `djf-model-validation.html`, `result_validation.html`, `tool_validation.html` are linked from nowhere and are **not copied into `dist/`** — so they are unshipped, unreachable documentation. Either wire them into the nav (they look substantive) or archive them.
- `help-getting-started.html` and `help-troubleshooting.html` have not been re-read line by line against the current UI; the QC and session sections most likely need the same treatment `help-modeling.html` just received.
- No help page documents the **residual panel** or **fit export** — because neither exists yet (WP-3). Write those sections with the features.

### 5.8 Static checks — all currently green

Verified today under Node 24 (preflight rejects it, but the individual checks run):

```
eslint js scripts vite.config.js   → clean
check-dom-bindings.mjs             → 225 static IDs, 4 generated IDs, passed
check_import_graph.py              → 137 modules, 428 edges, 0 cyclic components
check_documents.py                 → 14 HTML, 17 Markdown, manifest, TOML, Help labels
```

Note the import graph counts **137 modules** while the tree holds substantially more `.js` files — further confirmation that `js/analysis/djf/` (21 files) is not reachable from any entry point.

---

## 6. Documents that are now wrong

Fix these as you go; each one will otherwise cost someone an hour.

### 6.1 The remediation checklist is stale

`docs/audits/codex_audit_of_full_project_remediation_checklist.md` has not been updated since the cell-cycle investigation landed. Verified examples:

- **STAT-01** shows **5 of 5 open** — but `PoissonInputError` exists in [poisson.js:30](js/analysis/math/poisson.js#L30), and `constraint_audit.js` derives bounds from each model's published `bounds`. The handoff lists it as landed *with tests*.
- **LEGACY-01** shows **7 of 7 open** — but [legacy_bridge.js:79-80](js/analysis/cell_cycle/models/legacy_bridge.js#L79) declares `modelLabel: "Legacy Bridge (exploratory, unvalidated)"` and `exploratory: true`, the contract refuses it, it is absent from the model dropdown, and `unit_tests_legacy_quarantine.py` exists.

**Action:** reconcile the checklist against the tree before using its counts to plan. The true remaining count is lower than 139, and knowing by how much changes what "nearly done" means.

### 6.2 `todo.md` — two items are already done

- *"Prevent panning or zooming below 0 on the y-axis"* — **done**. [plot_viewport.js:133](js/plotting/plot_viewport.js#L133) `clamp_y_floor()` slides the domain up to pin the floor at 0 while preserving the gesture's span. `clamp_x_floor()` does the same for x.
- *"Phase 2 acquisition-order diagnostic plot"* — **done and wired**. [time_qc_diagnostic_plot.js](js/analysis/time_qc_diagnostic_plot.js) (306 lines) with a channel picker, consumed by `pipeline_ui.js` at lines 573–654, plus `unit_tests_time_qc_diagnostic_plot.py`. Three of the four spec layers are drawn; the event-scatter layer is *deliberately* omitted with a documented reason (raw per-event values aren't retained past Stage 1), and the spec itself says tracked peaks are more informative for this mode.

- *"Auto-Fit All doesn't add values to the table"* — **probably already fixed; verify rather than re-fix.** The path is complete: `on_fit_all_click` ([modeling_ui.js:503](js/analysis/cell_cycle/modeling_ui.js#L503)) fits every sample, then dispatches `cell-cycle-fit-changed`, which `update_cell_cycle_fraction_columns` listens for. But the column only fills when `result.phaseFractions` exists on a **reportable** result — and before the `w`-bound fix, only 3/30 fits were reportable, which would produce exactly the symptom you saw. It is now 30/30. **Load a few samples and check the table before spending time here.**

### 6.3 `README.md` claims a model that no longer exists

Lines 18–19 and 274 offer *"Automatic model selection."* The dropdown ([index.html:222](index.html#L222)) has Dean–Jett, Dean–Jett–Fox, Watson Pragmatic, Watson Classic, and CLOCCS — **no Auto**. `auto_dj_djf` was retired at user request and `model_selection.js` was deleted. Line 274 also omits Watson Classic and CLOCCS.

Worth knowing *why* this matters beyond tidiness: retiring Auto removed the only consumer of the joint estimator and the BIC comparison the reference implementation prescribes. That was a deliberate call, but it means the architecture in §7 of the reference is currently unimplemented — relevant background for §3.3.

### 6.4 `djf-pipeline_report.md`

Reviews `js/analysis/djf/**` — the dead directory — and reports all 8 findings resolved. Accurate about code nobody runs. Archive it with the directory.

---

## 7. Suggested plan for tomorrow

Realistic for one focused day, ordered so that nothing blocks on a long-running measurement.

**Morning**

1. **(5 min)** Environment: `nvm install 22`, then `ln -s ~/.venvs/playwright .venv`. §2. *(The venv already exists and works — only Node needs installing.)*
2. **(10 min)** Load a few samples and check whether Fit All fills the table (§6.2) — this either closes an item or reopens it, cheaply. *(The unit baseline is already confirmed green at 756/756 as of 2026-08-14, so re-running it is optional.)*
3. **(30 min)** Read handoff §5, §8.1, §11.4.1. Non-negotiable — §5 is a list of things that look obviously right and are measurably wrong.
4. **(2–3 hrs)** Implement §3.1's three corrections **as three separate commits**, each with a unit test. They are small and local; the discipline is in keeping them separable so the validation run can attribute the result.

**Midday**

5. **Kick off the 10-way sharded validation run and do not touch `js/`.** ~70 min. Use the time for work that cannot corrupt the run: §6 doc reconciliation, deleting `js/analysis/djf/`, and the two `dist/` defects in §5.4 (the 404 and the dead importmap) — those touch `index.html`/session startup, so land them *after* the run if you want to be strict.

**Afternoon**

6. **(30 min)** Read the results. Metrics: `all_pass` (from 7/30) and `g2_mean` pass count (from 10/30). If `g2_mean` improved but `all_pass` didn't, that is *still progress* — say so explicitly and check whether the fractions moved in the right direction.
7. **Branch on the outcome:**
   - **If `g2_mean` is largely fixed** → §3.2 (area pedestal), then start the residual panel (§4.2) — the report's most valuable missing piece.
   - **If G2 is still low** → the local corrections were insufficient, as predicted. Prototype the coarse-S joint peak relocation from §3.1, keeping the S term shape-locked.
8. **End of day:** update the handoff doc with what was measured. That document is the reason this project is recoverable at all — it is a genuinely excellent piece of engineering discipline. Keep it current.

**Explicitly not tomorrow:** VALID-01, UNC-01, the QC calibration study, release gating, CLOCCS. None of them are close to the critical path, and all are cheaper once the estimator is stable.

---

## 8. Decisions I need from you

1. **Scope of "finish the project."** A *functional, honest DJF with a usable report* is reachable in days. A *validated, publication-grade DJF* (VALID-01 + UNC-01 + calibration study + domain-expert review) is materially larger. My plan assumes the first. Say if you mean the second.

2. **Delete `js/analysis/djf/`?** 6,630 lines of unreachable duplicate with confusingly identical filenames. I recommend deleting it. It needs your approval because the working-tree commit plan requires explicit sign-off for deletions.

3. **`CLOCCS_modeling.md` doesn't exist in the repo.** If you want the CLOCCS implementation checked against it, the file needs to be added.

4. **How much FlowJo agreement is the target?** Some of the residual gap is FlowJo's undocumented gating and is not recoverable in principle (§3.5). `all_pass` 30/30 may not be an achievable goal, and pushing toward it risks tuning to an artifact.

5. **Do you have a staging Cloudflare Pages project, and account access?** (§5.4) The last three release items cannot be closed without it. If staging exists, running `workflow_dispatch` against it closes REL-01's first item and PRIV-02's artifact check in one go — probably an hour's work, and it de-risks the real release considerably.

6. **Fix the two `dist/` defects before or after the DJF work?** The 404 and the dead importmap are each ~15 minutes and both are visible on the public site. My recommendation: **do them tomorrow while the validation run is going** — they need no thought and cannot disturb the estimator work.

---

## Appendix — quick reference

**Live model path:** `pipeline_loader.js` → `cell_cycle_pipeline.js` → `cell_cycle/model_registry.js` → `models/dean_jett_fox.js`
**Registered models:** `legacy_bridge_v1` (quarantined), `dean_jett`, `dean_jett_fox`, `watson_pragmatic`, `watson_classic`, `cloccs` (unverified, joint-series)
**Dead code:** `js/analysis/djf/` — 21 files, 6,630 lines, zero external imports

**Toolchain:** Node → `nvm install 22 && nvm use` (24 is installed; 22 is required and missing) · Python → `~/.venvs/playwright/bin/python`, or `ln -s ~/.venvs/playwright .venv` once

| Command | Purpose |
|---|---|
| `npm run check` | Full gate: preflight, lint, DOM, docs, imports, privacy, tests, build, dist — **blocked until Node 22 is installed** |
| `npm run test:unit` | Browser unit suite (**756/756 green, verified 2026-08-14**) |
| `npm run test:e2e` | End-to-end |
| `npm run test:dist` | Production-bundle smoke |
| `npm run check:imports` | Import-graph / cycle check — run after deleting dead code |
| `validation_tests.py --flowjo-only --shard i/10` | 30-sample FlowJo comparison (~70 min, 10-way) |
| `render_fit_review.py` | Per-sample HTML fit review |
| `npm run check:base` | Build + verify the subpath (`/phasefinder/`) variant |
| `python -m http.server 8000` | Local static serve — works from `dist/` *or* the repo root unbuilt |

**Current DJF scorecard** (30-sample FlowJo set, `qc_structural`, from the last full run):

| metric | value | verdict |
|---|---|---|
| converged | 30/30 | ✅ |
| valid for reporting | 30/30 | ✅ |
| `g1_mean` | median −1.5%, passes 30/30 | ✅ |
| **`g2_mean`** | **median −3.2%, passes 10/30, low on 30/30** | ❌ **the defect** |
| g2:g1 ratio | median 1.974 (ref 2.0), passes 25/30 | ◐ |
| %G1 | +3.4pp | ◐ |
| %S | −3.4pp, 26/30 within tolerance | ◐ |
| %G2 | +7.0pp | ◐ |
| **`all_pass`** | **7/30** | — |

**Key documents:** `docs/audits/cell_cycle_model_investigation_handoff.md` (read §5, §8.1, §11 — the most important document in the repo) · `docs/plans/cell_cycle_modeling_plan.md` (§5.4 DJF math, §13 definition of done) · `docs/audits/baselines/dean_jett_fox_javascript_implementation.html` (reference implementation) · `docs/audits/codex_audit_of_full_project_remediation_checklist.md` (stale — reconcile before trusting)

---
---

# Part II — Remediation plan, with code

Part I says what is wrong. Part II says exactly what to write. Work packages are ordered by value; **WP-1 is the project's critical path** and everything else can wait behind it.

Every patch below was written against the code as it exists today (line numbers verified 2026-08-14). Snippets are drop-in unless marked *sketch*.

## Master work-package table

| WP | Scope | Items closed | Effort | Blocks |
|---|---|---|---|---|
| **WP-1** | **Peak estimator — fix G2 placement** | the DJF defect, `all_pass` 7/30 → 9+/30 | 1–2 days | everything scientific |
| **WP-2** | Production artifact defects | UX-01 residue, CSP simplification | ~30 min | public release polish |
| **WP-3** | Report completion | M6, SCI-03, plan §13 "residuals visible" | 2–3 days | the deliverable |
| **WP-4** | Honest capability + QC disclosure | QC-01, OPFS silent degradation | ~half day | user trust |
| **WP-5** | Cleanup and doc reconciliation | dead code, 3 stale docs, 2 audit files | ~half day | future confusion |
| **WP-6** | Release execution | REL-01, PRIV-02, PLAT-01, §9 gate | 1 day + CF access | going live |
| **WP-7** | The long tail | VALID-01, UNC-01, QC calibration | weeks | publication claims |

---

## WP-1 — Fix G2 placement

> ## ⚠️ READ THIS FIRST — WP-1 was re-measured on 2026-08-14 and the diagnosis changed
>
> I built a synthetic ground-truth histogram, reproduced the bias independently, ran an **ablation of the three proposed fixes**, and then decomposed the real-data error against the FlowJo reference. Three results overturn parts of the plan below. **[§WP-1.0](#wp-10--what-the-measurements-actually-say) has the evidence; read it before writing any code.**
>
> Short version: **only one of the three fixes is unambiguously good**, one is inert, one actively makes G2 *worse* — and roughly half the remaining G2 error may be a property of the reference rather than a defect in our estimator.

### WP-1.0 — What the measurements actually say

#### (a) The bias reproduces on synthetic ground truth

A DJF-generated histogram with known truth (G1 200, G2 400, CV 5.5%, real S bridge, 256 bins over 0–700):

| | fitted | true | error |
|---|---|---|---|
| G1 mean | 200.98 | 200 | **+0.49%** |
| G2 mean | 397.85 | 400 | **−0.54%** |
| G1 sigma | 13.53 | 11.00 | **+23.0%** |
| G2 sigma | 24.35 | 22.00 | **+10.7%** |

Both peaks are pulled **toward each other** — i.e. toward the S bridge between them — and both widths are inflated. That is the predicted mechanism, independently confirmed.

#### (b) Ablation — the three fixes do *not* all help

Each correction applied alone, error vs truth:

| variant | G1 mean | G1 sigma | G2 mean | G2 sigma |
|---|---|---|---|---|
| none (today) | +0.49% | +23.0% | −0.54% | +10.7% |
| + baseline subtraction | +0.49% | +23.0% | −0.54% | +10.7% |
| + deconvolve smoothing | +0.49% | **+12.5%** | −0.54% | **+7.8%** |
| + parabolic sub-bin | **+0.21%** | +23.0% | **−0.75%** ❌ | +10.7% |
| all three | +0.21% | +12.5% | **−0.75%** ❌ | +7.8% |

**Conclusions, and they are not what WP-1 originally assumed:**

1. **WP-1.2 (deconvolution) is the clear win.** Sigma error nearly halves on G1 (23.0% → 12.5%) and drops a third on G2. No downside on either mean. **Land this one.**
2. **WP-1.1 (baseline subtraction) is inert here.** Identical to no change, to every digit. The reason is quantization: the flank walk stops at a *discrete bin index*, and subtracting the pedestal does not move which bin first falls below threshold on this fixture. It may matter on a steeper pedestal, but **it is not the fix it was presented as**, and it must not be credited without a fixture where it moves a number.
3. **WP-1.3 (parabolic interpolation) helps G1 and *hurts* G2.** G1 improves (+0.49% → +0.21%); G2 gets **worse** (−0.54% → −0.75%). The reason is structural: the parabola leans toward the taller neighbour, and G2's taller neighbour is the S-phase side — so the interpolation pulls G2 further into the very bias it was meant to remove. **Applying it symmetrically is wrong.**

#### (c) The real-data error decomposes exactly — and half of it may not be ours

Against the 30-sample FlowJo reference:

```
reference g2:g1 ratio   median 2.0088   (quartiles 1.9941 .. 2.0296)
our fitted ratio        median 1.974
                                 ratio deficit  -1.73%
observed g2_mean error  -3.2%
        g1_mean error   -1.5%
        ratio error     -1.73%
              sum       -3.23%    <-- matches the observed -3.2%
```

Verified per-sample too (sample `1468f`: our G1 −0.70%, ratio −1.77%, G2 −2.45% ≈ −0.70 + −1.77).

**So "G2 is misplaced" is not one defect. It is two, and they are independent:**

- **~1.5% — G1 sits low.** A shared scale offset. G1 still passes 30/30 because the tolerance is ±3%, so this has been invisible. It propagates into G2 in full.
- **~1.7% — our G2:G1 ratio is lower than FlowJo's** (1.974 vs 2.0088).

**And the second one may be correct science rather than error.** Chromatin condensation in G2/M restricts DNA accessibility to intercalating dyes, so G2/M cells fluoresce slightly *less* than twice G1 — a documented cause of a true ratio below 2.0 ([Darzynkiewicz et al., *Analysis of Cellular DNA Content by Flow and Laser Scanning Cytometry*](https://pmc.ncbi.nlm.nih.gov/articles/PMC2967208/)). Our free-fitted 1.974 is exactly what that predicts. FlowJo's median of 2.0088 sits essentially *on* the theoretical value, and FlowJo explicitly supports constraining "the ratio of the mean peaks" ([FlowJo Cell Cycle: Univariate docs](https://docs.flowjo.com/flowjo/experiment-based-platforms/cell-cycle-univariate/)).

I checked whether the reference was hard-locked at 2.0: **it was not** — reference ratios span 1.94–2.29. But they cluster tightly around 2.0 (interquartile 1.994–2.030) in a way a freely-fitted, chromatin-affected population would not, and **every reference mean is recorded as an integer**, so the reference itself is quantized to ±0.29% on G1 and ±0.15% on G2.

> **Consequence for tomorrow.** Do **not** spend the day driving `g2_mean` toward FlowJo. Up to half that gap is a modelling-philosophy difference against a quantized reference, and "fixing" it would mean biasing our ratio *away* from the biologically expected value to match a tool whose configuration we cannot inspect. **The clearly-real, clearly-ours defect is the −1.5% G1 offset**, and it is worth more than the ratio chase because it is a *shared scale error that propagates into every downstream number.*

#### (d) Revised WP-1 priority

| | change | evidence | do it? |
|---|---|---|---|
| 1 | **Deconvolve the smoothing kernel** (WP-1.2) | sigma error −46% G1, −27% G2; no mean regression | ✅ **yes, first** |
| 2 | **Investigate the −1.5% G1 offset** | exact decomposition above; propagates into G2 | ✅ **yes — highest value, needs diagnosis first** |
| 3 | **Parabolic sub-bin, G1 only** (WP-1.3, asymmetric) | helps G1, hurts G2 | ⚠️ only with a clean-side guard |
| 4 | **Baseline subtraction** (WP-1.1) | no measurable effect | ⏸ hold until a fixture shows it moving something |
| 5 | **Pedestal-subtracted area** (WP-1.4) | untested | ⏸ unchanged — after 1–3 |
| 6 | **Chase the ratio to 2.0088** | likely a reference artifact | ❌ **no** |

**For (3), the guard is one line** — apply the interpolation only when the peak is not leaning into its contaminated flank:

```js
// The parabola leans toward the taller neighbour. On G1 the taller neighbour is
// the S side and the correction is small and helpful; on G2 the taller neighbour
// is ALSO the S side, so the same correction pushes G2 further into the bias it
// was meant to remove (measured: -0.54% -> -0.75%). Only accept an offset that
// moves the centre AWAY from the S bridge, i.e. toward the clean flank.
const rawOffset = parabolicPeakOffset(smoothed, peakIndex, indexes);
const towardCleanSide = cleanSide === "left" ? rawOffset <= 0 : rawOffset >= 0;
const subBinOffset = towardCleanSide ? rawOffset : 0;
```

**For (2), the diagnosis to run first.** A −1.5% offset on a G1 near 171 units is ≈2.6 units. Before writing any fix, determine which of these it is — they need different repairs and the measurement is cheap:

```
1. Bin quantization: what is binWidth in the validation runs? If ~5 units, then
   2.6 units is HALF A BIN and the cause is a centre/edge convention, not a
   modelling error. Check dna_histogram.js edge construction against the value
   reported as `mean`.
2. Reference quantization: reference means are integers (+/-0.29% on G1). That is
   a fifth of the offset, not all of it, but it sets the noise floor.
3. Estimator bias: the synthetic says G1 comes out HIGH (+0.49%), while real data
   says LOW (-1.5%). Those signs DISAGREE, which means the real-data G1 offset is
   NOT the same mechanism as the synthetic bias. Something else is going on --
   most likely QC/domain related (the structural $PnR ceiling changes the range,
   and therefore the binning) rather than the peak estimator at all.
```

Point 3 is the one to take seriously: **the sign flip between synthetic and real data means the G1 offset cannot be explained by the peak-estimator bias this plan was built around.** That is a genuinely open question and the best use of tomorrow's first hour.

---

The four changes below are the *original* plan. Items are still individually correct as code; their **priority and expected benefit are superseded by WP-1.0**. **Land them as separate commits and validate separately** — §3.0 exists because bundled changes have already produced unattributable results here twice.

All four live in two files:
- [`js/analysis/cell_cycle/peak_regions.js`](js/analysis/cell_cycle/peak_regions.js)
- [`js/analysis/cell_cycle/models/watson_pragmatic.js`](js/analysis/cell_cycle/models/watson_pragmatic.js)

### WP-1.1 — Baseline-subtracted width threshold

**Defect:** `estimateSigmaOneSidedWithinRegion()` walks out until the *absolute* smoothed count drops below `fraction × peak`. A peak on the S-phase pedestal never gets there as fast, so σ is inflated — and an inflated σ widens the area window, which is how G2 steals S mass.

**Replace `peak_regions.js:114-135` entirely:**

```js
// The flank walk must measure height ABOVE the local pedestal, not absolute
// height. A G1/G2 peak sitting on S-phase mass stays above an absolute
// threshold further out than a clean peak would, which inflates sigma and (via
// the area window built from it) lets the peak claim mass that belongs to S.
//
// The sigma conversion is unchanged: for a Gaussian on a pedestal, the height
// above pedestal still falls to `fraction` of its own maximum at
// sqrt(-2 ln fraction) * sigma.
function estimateSigmaOneSidedWithinRegion(values, peakIndex, indexes, fraction, side, baseline = null) {
  const first = indexes[0];
  const last = indexes[indexes.length - 1];
  // regionIndexes() returns a contiguous ascending run, so (index - first)
  // indexes the baseline array directly.
  const base = baseline ?? localLinearBaseline(values, indexes);
  const heightAt = (index) => values[index] - (base[index - first] ?? 0);

  const peakHeight = heightAt(peakIndex);
  if (!(peakHeight > 0)) return NaN;

  const f = clamp(fraction, 0.05, 0.95);
  const threshold = f * peakHeight;
  const above = (index) => heightAt(index) > threshold;

  let index = peakIndex;
  if (side === "left") {
    while (index > first && above(index)) index -= 1;
  } else if (side === "right") {
    while (index < last && above(index)) index += 1;
  } else {
    throw new Error("side must be 'left' or 'right'.");
  }

  // The threshold must be crossed before the region edge; otherwise this
  // shoulder was never exposed and the caller falls back to the second moment.
  if (above(index)) return NaN;
  const distanceBins = Math.abs(index - peakIndex);
  return distanceBins > 0 ? distanceBins / Math.sqrt(-2 * Math.log(f)) : NaN;
}
```

Then at the call site (`peak_regions.js:183`) pass the baseline once so it is computed a single time and shared with the fallback:

```js
  const baseline = localLinearBaseline(smoothed, indexes);
  const sigmaBins = estimateSigmaOneSidedWithinRegion(
    smoothed, peakIndex, indexes, heightFraction, cleanSide, baseline,
  );
```

and change the fallback block to reuse it instead of recomputing:

```js
  if (!(sigma > 0) || !Number.isFinite(sigma)) {
    const weights = indexes.map((index, i) => Math.max(0, smoothed[index] - baseline[i]));
    // …unchanged from here…
```

**Test** (`tests/unit/driving_code/unit_tests_cell_cycle_peak_detection.py`):

```js
run('WP-1.1: a peak on a pedestal recovers the same sigma as one without', () => {
  const edges = linspace(0, 200, 201);
  const clean  = gaussianCounts(edges, { mean: 100, sigma: 8, area: 10000 });
  const raised = clean.map((c) => c + 300);            // flat S-phase pedestal
  const a = estimatePeakFromRegion(edges, clean,  { left: 70, right: 130 }, { cleanSide: 'left' });
  const b = estimatePeakFromRegion(edges, raised, { left: 70, right: 130 }, { cleanSide: 'left' });
  const drift = Math.abs(b.sigma - a.sigma) / a.sigma;
  return { pass: drift < 0.05, detail: `sigma ${a.sigma.toFixed(2)} vs ${b.sigma.toFixed(2)} (${(drift*100).toFixed(1)}%)` };
});
```
On today's code this fails with the pedestal σ materially larger.

### WP-1.2 — Deconvolve the smoothing kernel

**Defect:** σ is measured on a histogram smoothed at `smoothingSigmaBins: 2`, so it measures √(σ² + 2²). Never removed. This is the same arithmetic the handoff already uses to explain the detector's limits — just never applied here.

**Add to `peak_regions.js`:**

```js
// Widths are measured on a Gaussian-smoothed histogram, so every estimate is
// sqrt(sigma^2 + kernel^2), not sigma. Remove the kernel in quadrature.
// A feature narrower than the kernel is unresolvable; rather than returning NaN
// (which would silently drop the caller to the much weaker second-moment
// fallback) we floor it at half a bin and let the optimizer widen from there.
const UNRESOLVED_SIGMA_BINS = 0.5;

function deconvolveSmoothing(sigmaBins, smoothingSigmaBins) {
  if (!Number.isFinite(sigmaBins) || !(sigmaBins > 0)) return sigmaBins;
  const kernel = Math.max(0, smoothingSigmaBins);
  if (!(kernel > 0)) return sigmaBins;
  const variance = sigmaBins * sigmaBins - kernel * kernel;
  return variance > UNRESOLVED_SIGMA_BINS ** 2 ? Math.sqrt(variance) : UNRESOLVED_SIGMA_BINS;
}
```

**Apply in both paths.** Flank estimate:

```js
  const smoothingSigmaBins = options.smoothingSigmaBins ?? 2;
  const smoothed = options.smoothed ?? gaussianSmooth(counts, smoothingSigmaBins);
  // …
  let sigma = deconvolveSmoothing(sigmaBins, smoothingSigmaBins) * binWidth;
```

Second-moment fallback (it measures on the same smoothed array, so it carries the same inflation — in data units this time):

```js
    if (weightSum > EPS) {
      const centroid = sum(indexes.map((index, i) => weights[i] * centers[index])) / weightSum;
      const variance = sum(indexes.map((index, i) => weights[i] * (centers[index] - centroid) ** 2)) / weightSum;
      const kernel = smoothingSigmaBins * binWidth;
      sigma = Math.sqrt(Math.max((UNRESOLVED_SIGMA_BINS * binWidth) ** 2, variance - kernel * kernel));
    }
```

> **Caveat worth stating in the commit message.** If `options.smoothed` is supplied by a caller that smoothed with a *different* kernel, this over- or under-corrects. Today every caller uses the default, but the parameter makes that assumption implicit. Consider asserting it.

**Test:**

```js
run('WP-1.2: a known-width Gaussian recovers its true sigma, not the smoothed one', () => {
  const edges = linspace(0, 400, 401);        // binWidth = 1
  const counts = gaussianCounts(edges, { mean: 200, sigma: 6, area: 50000 });
  const est = estimatePeakFromRegion(edges, counts, { left: 170, right: 230 }, { cleanSide: 'left' });
  const naive = Math.sqrt(6 * 6 + 2 * 2);     // 6.32 — what the old code returned
  return {
    pass: Math.abs(est.sigma - 6) < 0.4 && Math.abs(est.sigma - naive) > 0.2,
    detail: `sigma=${est.sigma.toFixed(3)} (true 6, un-deconvolved ${naive.toFixed(3)})`,
  };
});
```

### WP-1.3 — Sub-bin parabolic peak centre

**Defect:** `mean: centers[peakIndex]` — quantized to a bin centre, up to half a bin of error, and it is *always* biased toward the S side because that is where the neighbouring bin is taller.

**Add to `peak_regions.js`:**

```js
// Three-point parabolic interpolation through the smoothed argmax and its two
// neighbours. Standard sub-bin peak location: removes up to half a bin of
// quantization error, and removes it asymmetrically in the direction that
// matters here, since the taller neighbour is the one on the S-phase side.
// Returns a fractional bin offset in [-0.5, +0.5]; 0 when the vertex is not
// interior (a flat top, a monotone run, or the peak sitting on a region edge).
function parabolicPeakOffset(values, peakIndex, indexes) {
  const first = indexes[0];
  const last = indexes[indexes.length - 1];
  if (peakIndex <= first || peakIndex >= last) return 0;
  const yMinus = values[peakIndex - 1];
  const yZero = values[peakIndex];
  const yPlus = values[peakIndex + 1];
  const denominator = yMinus - 2 * yZero + yPlus;
  if (!(Math.abs(denominator) > EPS)) return 0;   // flat or inflected
  const offset = 0.5 * (yMinus - yPlus) / denominator;
  return Math.abs(offset) <= 0.5 ? offset : 0;
}
```

**Use it for the mean and everything derived from it** (`peak_regions.js:208-216`):

```js
  const subBinOffset = parabolicPeakOffset(smoothed, peakIndex, indexes);
  const mean = centers[peakIndex] + subBinOffset * binWidth;

  return {
    region,
    peakIndex,
    subBinOffset,          // recorded so provenance can show the correction applied
    mean,
    sigma,
    cv: sigma / Math.max(EPS, mean),
    area,
    binIndexes: indexes,
  };
```

> **Check before committing:** `peakIndex` stays an integer and is still used for window construction in `fit_local_peak`. Only `mean` moves. Confirm no consumer reconstructs the mean as `centers[result.peakIndex]` — grep for `peakIndex` across `models/`.

### WP-1.4 — Pedestal-subtracted area *(do this AFTER WP-1.1–1.3 are validated)*

**Defect:** `refine_local_area()` sums raw counts across the window; whatever S-phase pedestal lies under the peak is counted as peak area. This is the direct mechanism behind %G2 +7.0pp / %S −3.4pp.

**Replace `watson_pragmatic.js:117-126`:**

```js
function refine_local_area(edges, counts, mean, sigma, window, baseline = 0) {
  const unitTemplate = gaussianBinMass(edges, 1, mean, sigma);
  let observedSum = 0;
  let templateSum = 0;
  for (let i = window.start; i <= window.end; i += 1) {
    // Subtract the pedestal the peak sits on. Without this the window absorbs
    // S-phase mass under the peak and reports it as G1/G2 area.
    observedSum += Math.max(0, counts[i] - baseline);
    templateSum += unitTemplate[i];
  }
  return templateSum > EPS ? Math.max(0, observedSum / templateSum) : 0;
}
```

and estimate the pedestal from the contaminated edge of the window in `fit_local_peak`:

```js
  const window = build_asymmetric_window(local.peakIndex, sigmaBins, cleanSide, config, counts.length);
  // The pedestal is read from the window edge on the CONTAMINATED side -- the
  // side facing S phase -- because the clean side by construction sits on
  // background. Using the min of a few bins resists a single noisy bin.
  const pedestalIndex = cleanSide === "left" ? window.end : window.start;
  const span = 3;
  let baseline = Infinity;
  for (let i = Math.max(0, pedestalIndex - span); i <= Math.min(counts.length - 1, pedestalIndex + span); i += 1) {
    baseline = Math.min(baseline, counts[i]);
  }
  if (!Number.isFinite(baseline) || baseline < 0) baseline = 0;
  const area = refine_local_area(edges, counts, local.mean, local.sigma, window, baseline);
```

> **This one is genuinely uncertain and must be measured, not reasoned about.** Once G2 is correctly placed by WP-1.1–1.3 the overlap shrinks, so the right size of this correction changes. It is entirely possible that after WP-1.3 this over-corrects and starves G2. **Validate WP-1.1–1.3 first, then decide.** Handoff §11.5 item 2 says the same thing.

### WP-1.5 — If G2 is still low: coarse-S peak relocation *(sketch)*

Expect WP-1.1–1.3 to be necessary but not sufficient — none of them addresses the smoothed argmax being dragged left by S mass. If `g2_mean` is still short, the next move is **one lightweight pass that relocates the peaks against a coarse S model**, with the S shape held fixed:

```
1. Fit as today (frozen clean-flank peaks) -> coarse S profile q0.
2. Subtract q0's contribution from the histogram.
3. Re-run estimatePeakFromRegion on the S-subtracted histogram -> new peaks.
4. Refit with the peaks frozen at the NEW estimate. Do not iterate more than
   twice; log both estimates in provenance.
```

**This is not the joint fit that failed** (handoff §5.1): there, the S term was free to reshape itself and ballooned into G2. Here S is fixed during relocation and only the peak centres move. State that distinction in the commit message, because it looks superficially like the rejected approach and someone will ask.

### WP-1 validation

```bash
PY=~/.venvs/playwright/bin/python
for i in 0 1 2 3 4 5 6 7 8 9; do
  "$PY" tests/validation/driving_code/validation_tests.py --flowjo-only --keep --shard "$i/10" &
done
wait
```

Record after each commit: `all_pass` (7/30), `g2_mean` pass count (10/30), `%S` median (−3.4pp), `%G2` median (+7.0pp), converged (30/30), reportable (30/30). **A change that improves `g2_mean` but not `all_pass` is still progress** — say so rather than reverting it.

One test is deliberately pinned to fail when this works: `DOCUMENTED LIMITATION: frozen peaks leave a large deviance gap to the truth` asserts the deviance ratio stays in 5–60×. **Update it, don't delete it** — retighten the band to the new reality so the next improvement also surfaces.

---

## WP-2 — Production artifact defects

Two small fixes, both visible to every visitor. Good work for while a validation run is occupying the machine.

### WP-2.1 — Stop the 404 on every page load

`try_autoload()` fetches `./sessions/phasefinder_local.json`, which does not exist in `dist/`. The JS is silent by design, but the browser still logs a failed request and a console error.

**In `js/session/core.js`, replace the fetch guard:**

```js
async function try_autoload() {
  // The personal autoload config is deliberately absent from the production
  // build. Fetching it unconditionally produces a 404 in the console and the
  // network panel on every visit, which reads as a broken app. Probe quietly and
  // treat any non-OK response as "no autoload configured".
  let config;
  try {
    const resp = await fetch('./sessions/phasefinder_local.json', { cache: 'no-store' });
    if (!resp.ok) return;
    const type = resp.headers.get('content-type') || '';
    // A static host may answer a missing path with an SPA/index fallback.
    if (!type.includes('json')) return;
    config = await resp.json();
  } catch (_) {
    return;
  }
  // …unchanged…
```

That removes the *parse* risk but **not the 404 itself**. To remove the console error, the build must ship the file. Add to `vite.config.js`'s post-build step (or `scripts/generate-provenance.cjs`):

```js
// Ship an inert autoload config so the startup probe gets 200 {} instead of a
// 404. Keeps the console clean without shipping anyone's personal session.
const autoloadStub = path.join(distDir, "sessions", "phasefinder_local.json");
fs.mkdirSync(path.dirname(autoloadStub), { recursive: true });
fs.writeFileSync(autoloadStub, "{}\n");
```

Then extend `scripts/verify-dist.cjs` so the guarantee is enforced rather than assumed:

```js
// Runtime-fetched paths are invisible to the static crawler; assert them here.
assertExists("sessions/phasefinder_local.json", "startup autoload probe target");
const stub = JSON.parse(fs.readFileSync(path.join(DIST, "sessions/phasefinder_local.json"), "utf8"));
if (Object.keys(stub).length) {
  fail("dist/sessions/phasefinder_local.json must be an empty object; a real session leaked into the build.");
}
```

That last check is the valuable part — it makes a personal-session leak into `dist/` a **build failure**, which is exactly the class of bug UX-01/FE-001 was about.

### WP-2.2 — Remove the dead importmap from the built HTML

In `dist/`, the importmap maps `d3` → `./js/vendor/d3.min.js`, but `dist/` has no `js/` directory and Vite has rewritten every bare `d3` import. It is dead markup that forces a CSP hash to exist for a script that does nothing.

**Add a Vite plugin in `vite.config.js`:**

```js
// The importmap exists so the SOURCE tree runs unbuilt (bare "d3" -> vendored
// copy). Vite rewrites those imports and does not emit js/vendor/, so in the
// built HTML the map is dead markup pointing at a path that isn't there -- and
// it forces a CSP script-src hash for a script that does nothing.
function stripImportMap() {
  return {
    name: "phasefinder-strip-importmap",
    transformIndexHtml: {
      order: "post",
      handler: (html) => html.replace(/\s*<script type="importmap">[\s\S]*?<\/script>/, ""),
    },
  };
}
```

**This changes the CSP contract, so it is a two-file change.** Once the inline script is gone, `script-src` needs no hash:

```diff
- script-src 'self' 'sha256-QegSXuCeGvs/PPT8u2DSB5HlR9rojffhnwsctbN4gdE=';
+ script-src 'self';
```

and `verify-dist.cjs`'s hash check (line ~30) must flip from *"the declared hash matches the importmap"* to *"no inline script remains, and script-src declares no hash"*:

```js
const inlineScripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)];
if (inlineScripts.length) {
  fail(`Built HTML must contain no inline scripts; found ${inlineScripts.length}. Update the CSP if this is intentional.`);
}
if (/script-src[^;]*sha256-/.test(headers)) {
  fail("script-src still pins a hash but the built HTML has no inline script.");
}
```

> **Do not do WP-2.2 without WP-2.2's `_headers` edit in the same commit.** Removing the script while leaving the hash is harmless; removing the hash while leaving the script breaks production only. Keep them atomic and verify with `npm run check:dist`.

---

## WP-3 — Complete the report

The engine (`cell_cycle_fit_report.js`, 850 lines) is done. This is presentation. **Sequence it after WP-1**, or you will ship a beautiful report that faithfully displays a biased G2.

### WP-3.1 — Residual panel *(the highest-value missing piece)*

`fitResult.curves` **already carries `{ x, observed, g1, s, g2, fitted, residuals }`** — the report validates their presence. Nothing needs computing; this is purely a draw call.

`index.html`, after the plot SVG host:

```html
<div id="residual_panel" class="residual_panel" hidden>
  <div class="residual_panel_header">
    <span id="residual_panel_title">Residuals (fitted − observed)</span>
    <label class="residual_panel_toggle">
      <input id="residual_panel_normalize" type="checkbox" checked />
      Pearson (÷√fitted)
    </label>
  </div>
  <svg id="residual_plot" role="img" aria-labelledby="residual_panel_title residual_plot_desc">
    <desc id="residual_plot_desc"></desc>
  </svg>
</div>
```

New `js/plotting/residual_panel.js`:

```js
// Residual strip drawn beneath the main histogram. The modeling plan's
// definition of done requires residuals visible BY DEFAULT: structure in the
// residuals is the single most direct evidence that a fit is wrong, and until
// now it was computed on every fit and shown nowhere.
//
// Pearson residuals ((fitted - observed)/sqrt(fitted)) are the default because
// counts are Poisson, so raw residuals scale with peak height and the eye is
// drawn to G1 regardless of fit quality.

import * as d3 from "d3";   // resolved by the importmap in source, bundled by Vite
import { residual_plot, residual_panel, residual_panel_normalize } from "../ui/dom.js";

const BAND_2SIGMA = 2;

export function render_residual_panel(fitResult, { x_scale, width, height = 90, margin }) {
  if (!residual_panel) return;
  const curves = fitResult?.curves;
  if (!curves?.residuals?.length) { residual_panel.hidden = true; return; }
  residual_panel.hidden = false;

  const pearson = residual_panel_normalize?.checked ?? true;
  const values = curves.residuals.map((r, i) =>
    pearson ? r / Math.sqrt(Math.max(1, curves.fitted[i])) : r);

  const extent = Math.max(BAND_2SIGMA + 0.5, ...values.map(Math.abs));
  const y = (v) => (height / 2) - (v / extent) * (height / 2 - margin.top);

  const svg = d3.select(residual_plot).attr("width", width).attr("height", height);
  svg.selectAll("*:not(desc)").remove();

  // +/-2 band first, so residuals draw over it.
  if (pearson) {
    svg.append("rect")
      .attr("x", margin.left).attr("width", Math.max(0, width - margin.left - margin.right))
      .attr("y", y(BAND_2SIGMA)).attr("height", Math.max(0, y(-BAND_2SIGMA) - y(BAND_2SIGMA)))
      .attr("class", "residual_band");
  }
  svg.append("line")
    .attr("x1", margin.left).attr("x2", width - margin.right)
    .attr("y1", y(0)).attr("y2", y(0)).attr("class", "residual_zero");

  svg.selectAll("line.residual_stem")
    .data(values).enter().append("line")
    .attr("class", "residual_stem")
    .attr("x1", (_, i) => x_scale(curves.x[i])).attr("x2", (_, i) => x_scale(curves.x[i]))
    .attr("y1", y(0)).attr("y2", (v) => y(v));

  // Accessible equivalent: the numbers a sighted user reads off the shape.
  const outside = values.filter((v) => Math.abs(v) > BAND_2SIGMA).length;
  const worst = values.reduce((a, b) => (Math.abs(b) > Math.abs(a) ? b : a), 0);
  svg.select("desc").text(
    `${pearson ? "Pearson" : "Raw"} residuals across ${values.length} bins. `
    + `${outside} bins (${((100 * outside) / values.length).toFixed(1)}%) fall outside +/-2. `
    + `Largest deviation ${worst.toFixed(2)}.`,
  );
}
```

Wire it from `render.js` where the fit overlay is drawn, share the x-scale so the strips align with the histogram, and re-render on the checkbox's `change`. Add `residual_plot`, `residual_panel`, `residual_panel_normalize` to `js/ui/dom.js` — `check:dom` will fail until you do, which is the check doing its job.

### WP-3.2 — Versioned JSON/CSV export

The plan specifies `js/analysis/cell_cycle/export.js`; it does not exist. M6's exit gate: *"export contains enough data to reproduce or independently inspect the fit."*

```js
// Versioned, self-describing export of one fit. The version is the contract:
// bump EXPORT_FORMAT_VERSION on any breaking shape change and record a migration
// note. Everything needed to (a) re-run the fit and (b) check the arithmetic
// independently must be present -- that is M6's exit gate, not a nice-to-have.

export const EXPORT_FORMAT_VERSION = "1.0.0";

export function build_fit_export(row, result, { includeCurves = true } = {}) {
  if (!result) throw new Error("No fit result to export.");
  return {
    formatVersion: EXPORT_FORMAT_VERSION,
    exportedAt: new Date().toISOString(),
    // Vite injects both of these (see vite.config.js `define`). The source
    // commit is the part that actually makes an export reproducible -- a version
    // number alone cannot identify which build produced a number.
    application: {
      name: "PhaseFinder",
      version: __PHASEFINDER_VERSION__,
      sourceCommit: __PHASEFINDER_SOURCE_COMMIT__,
    },

    sample: { name: row.name, eventCount: row.data?.event_count ?? null, channel: row.data?.channelKey ?? null },

    model: {
      id: result.modelId, version: result.modelVersion,
      settings: result.settings ?? null,
      settingsApplicability: result.settingsApplicability ?? null,
      configHash: result.configHash ?? null,
    },

    // Reproduction inputs: without these the numbers cannot be recomputed.
    domain: {
      range: result.analysisDomain ?? null, binCount: result.binCount ?? null,
      underflow: result.domainCoverage?.underflow ?? null,
      overflow: result.domainCoverage?.overflow ?? null,
      componentTailCoverage: result.componentTailCoverage ?? null,
    },
    peakRegions: result.peakRegions ?? null,
    qc: result.preflight?.qc ?? null,
    bulkRegionProvenance: result.bulkRegionProvenance ?? null,

    // Results, with their honesty flags attached rather than alongside.
    fit: {
      parameters: result.parameters ?? null,
      phaseFractions: result.phaseFractions ?? null,
      converged: result.converged ?? null,
      convergenceReason: result.convergenceReason ?? null,
      validForReporting: result.validForReporting ?? null,
      validityReasons: result.validityReasons ?? [],
      warnings: result.warnings ?? [],
      goodnessOfFit: result.goodnessOfFit ?? null,
      optimizerDiagnostics: result.optimizerDiagnostics ?? null,
      contractVersion: result.contractVersion ?? null,
    },

    curves: includeCurves ? result.curves ?? null : null,
  };
}

// Long-form CSV: one row per bin. Chosen over wide format because bin counts
// vary between exports and spreadsheets handle a stable column set far better.
export function build_fit_csv(row, result) {
  const c = result?.curves;
  if (!c?.x?.length) throw new Error("This fit has no curves to export.");
  const head = ["sample", "model", "bin_center", "observed", "fitted", "g1", "s", "g2", "residual"];
  const lines = [head.join(",")];
  for (let i = 0; i < c.x.length; i += 1) {
    lines.push([
      csvCell(row.name), csvCell(result.modelId),
      c.x[i], c.observed[i], c.fitted[i], c.g1[i], c.s[i], c.g2[i], c.residuals[i],
    ].join(","));
  }
  return lines.join("\n");
}

// Reuse the existing formula-injection defence from metadata_io.js rather than
// writing a second one -- FE-028 was about exactly this class of bug.
function csvCell(value) {
  const text = String(value ?? "");
  return /^[=+\-@\t\r]/.test(text) ? `"'${text.replace(/"/g, '""')}"` : `"${text.replace(/"/g, '""')}"`;
}
```

Hang both off the existing plot-toolbar download control (`#plot_tool_camera` is already labelled "Download plot or analysis report", so the affordance exists).

### WP-3.3 — Make nonconvergence impossible to miss *(SCI-03)*

The contract is already honest; the UI is quiet. Wherever `phaseFractions` is displayed, the convergence state must travel with it. In `js/ui/cell_cycle_columns.js`, `update_cell_cycle_fraction_columns()` already fetches `active_result` — extend the value formatter:

```js
// A percentage with no qualifier reads as authoritative. If the fit did not
// converge, or the contract refused it for reporting, the number must not appear
// naked in a column someone will paste into a paper.
function format_fraction_cell(result, fraction) {
  if (!Number.isFinite(fraction)) return format_cell_cycle_value(null, "");
  const text = `${(fraction * 100).toFixed(1)}%`;
  if (result.validForReporting === false) return format_cell_cycle_value(`${text} ⚠ unvalidated`, "");
  if (result.converged === false) return format_cell_cycle_value(`${text} ⚠ not converged`, "");
  return format_cell_cycle_value(text, "");
}
```

Mirror it in the sidebar readout and carry `converged` / `validForReporting` into the TSV export. Then close SCI-05's open item with one cross-surface test:

```js
run('SCI-05: every surface shows identical fractions for a fit with large tail mass', () => {
  const r = fitWithHeavyTail();
  const shown = [
    sidebarFractionText(), tableColumnText(), tsvFractionField(), plotLegendText(),
  ].map(normalizePercent);
  return { pass: new Set(shown).size === 1, detail: shown.join(' | ') };
});
```

---

## WP-4 — Honest capability and QC disclosure

### WP-4.1 — Surface missing optional capabilities

`init_compatibility()` warns only on `missingRequired`, so OPFS absence — which silently disables session caching on any non-secure origin — is recorded and never shown.

```js
// Optional capabilities degrade features rather than breaking the app, so they
// must not raise the required-feature alarm. But silence is worse: on a
// non-secure origin OPFS disappears and session caching stops working with no
// explanation. Say so once, quietly, with the reason.
const OPTIONAL_CAPABILITY_IMPACT = {
  opfs: "Session file caching is unavailable, so files must be re-selected after reload.",
  folderPicker: "Choosing a whole data folder is unavailable; select files individually.",
};

export function init_compatibility() {
  const report = browser_capabilities();
  globalThis.PhaseFinderCompatibility = { baseline: BROWSER_BASELINE, ...report };

  if (report.missingRequired.length) {
    const warning = document.createElement("p");
    warning.className = "browser_compatibility_warning";
    warning.setAttribute("role", "alert");
    warning.textContent = `This browser is missing required features (${report.missingRequired.join(", ")}). `
      + "Use a supported current Chrome, Edge, Firefox, or Safari release.";
    document.querySelector(".page_header")?.appendChild(warning);
    return report;
  }

  const impacts = report.missingOptional.map((key) => OPTIONAL_CAPABILITY_IMPACT[key]).filter(Boolean);
  if (impacts.length) {
    const notice = document.createElement("p");
    notice.className = "browser_capability_notice";
    notice.setAttribute("role", "status");
    // The insecure-origin case is by far the most common cause and the most
    // actionable, so name it rather than making the user guess.
    const cause = !globalThis.isSecureContext
      ? " This page is not on a secure origin (HTTPS or localhost), which disables browser-private storage."
      : "";
    notice.textContent = `${impacts.join(" ")}${cause}`;
    document.querySelector(".page_header")?.appendChild(notice);
  }
  return report;
}
```

### WP-4.2 — Wire the QC acknowledgement flow *(QC-01)*

The result contract already blocks reporting after critical QC removal until `qcAcknowledgements` is supplied — **and nothing supplies it**, so the gate is currently a dead end rather than a safeguard. *Sketch:*

```
1. On a blocked result, read result.preflight.qc for the removal that tripped it.
2. Render an inline panel (not a modal -- this is a review decision, not an
   interruption): what was removed, how much, by which gate, and why it matters.
3. "I have reviewed this" writes { gate, acknowledgedAt, removedFraction } into
   modeling state and re-runs apply_result_contract().
4. Persist acknowledgements in the session and INVALIDATE them when the QC
   config or file bytes change -- an acknowledgement is about a specific
   filtering outcome, not a permanent opt-out.
```

Step 4 is the one to get right. An acknowledgement that survives a config change silently re-authorizes a different analysis.

---

## WP-5 — Cleanup and doc reconciliation

Low risk, high clarity. Ideal work to run alongside a validation job.

### WP-5.1 — Delete the dead pipeline

```bash
git rm -r js/analysis/djf/          # 21 files, 6,630 lines, zero external imports
git mv djf-pipeline_report.md docs/audits/archive/djf-pipeline_report.md
npm run check:imports && npm run test:unit
```

Verified safe: no `djf/` import exists outside the directory; `check_import_graph.py` reaches 137 modules without it; the `unit_tests_djf_*.py` suites drive the **live** pipeline via the harness, not this code. `assets/misc/` and `docs/` references are documentation-only. **Requires your sign-off** under the working-tree commit plan's deletion policy.

### WP-5.2 — Reconcile the checklist

`STAT-01` (5 open) and `LEGACY-01` (7 open) are implemented and tested; several others are partly stale. Tick them with evidence pointers, then re-run the count. Knowing the real remaining number changes what "nearly done" means.

### WP-5.3 — Fix the three stale docs

- `todo.md` — drop the y-axis item and the Phase 2 item (both done); re-check the Fit All item in the running app before keeping it.
- `README.md` lines 18–19 and 274 — remove "Automatic model selection", add Watson Classic and CLOCCS (Unverified).
- `needs_be_fixed_frontend_dev.md` / `needs_to_be_fixed_ux.md` — fold the four surviving items (§5.5) into the checklist and delete these files.

---

## WP-6 — Release execution

Blocked on Cloudflare account access, not code. In order:

1. `workflow_dispatch` → **staging** Pages project. Inspect the deployed file list and response headers; confirm the CSP, `nosniff`, and cache rules actually arrive (this is where you find out if Pages is honouring `_headers`). Closes REL-01 item 1 **and** PRIV-02's artifact check.
2. Publish a **test release**; walk the public URL: Help link, panel icons, web manifest, worker-based FCS parsing, one model fit. Closes REL-01 item 2.
3. Record the **deployment ID** in `docs/release-and-privacy.md` beside the existing rollback procedure, and exercise a rollback on staging. Closes REL-01 item 3 and PLAT-01.
4. Fresh-clone check (REL-03): `git clone` to a temp dir → `nvm use && npm ci && npm test && npm run build`. Do this **before** the test release; it is the cheapest way to find a missing committed file.

---

## WP-7 — The long tail

Not tomorrow, and not before WP-1. Recorded so the scope is explicit.

| Item | Note |
|---|---|
| **QC calibration study** | **Highest leverage here** — one labelled study closes items in QC-03, QC-04, and QC-06 simultaneously. Needs labelled acquisitions with known clogs/dropouts. |
| **VALID-01** (9) | Equation-to-code mapping with units; DJ vs DJF component curves over a parameter grid; datasets beyond one instrument/encoding; expert review before the word "validated" is used anywhere. |
| **UNC-01** (7) | No uncertainty reporting exists. Profile-likelihood or bootstrap intervals; resampling must perturb peak regions and binning, not just the optimizer. |
| **PERF-MODEL-01** / FE-009 (7) | Real cancellation; no silent main-thread fallback for canonical fits. |
| **PLAT-02** (6), **MAINT-02** (5), **DOC-02** (5) | Golden-fixture governance, threshold traceability, provenance docs. |
| **UI-19 / FE-020**, **UX-02**, **UX-08**, **PERF-UI-01** | Contrast completion, responsive shell rework, Run-All naming, profiling before optimizing. |
| **FUTURE-01** (4) | Correctly deferred until per-sample validation exists. |

---

## Suggested commit sequence

```
WP-1.1  fix(peaks): measure flank width above the local baseline
WP-1.2  fix(peaks): deconvolve the smoothing kernel from width estimates
WP-1.3  fix(peaks): locate peak centres to sub-bin precision
        --- validate on 30 samples; record all_pass and g2_mean ---
WP-1.4  fix(peaks): subtract the pedestal from local area estimates
        --- validate again; keep only if it improves ---
WP-2.1  fix(build): ship an inert autoload stub and assert it stays inert
WP-2.2  build: drop the dead importmap and its CSP hash
WP-5.1  chore: remove the unreachable staged DJF pipeline      [needs approval]
WP-5.3  docs: correct stale model-selection and todo claims
WP-3.1  feat(plot): show fit residuals by default
WP-3.3  fix(ui): mark nonconverged and unvalidated fits wherever fractions appear
WP-3.2  feat(export): add versioned JSON and CSV fit export
WP-4.1  fix(ui): explain degraded capabilities instead of failing silently
WP-4.2  feat(qc): wire the critical-removal acknowledgement flow
```

Each WP-1 commit must carry its measured before/after in the message — that is what makes the next agent's job possible, and it is the practice that made this project recoverable in the first place.
