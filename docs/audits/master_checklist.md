# PhaseFinder — master remediation and feature checklist

**Reconciled:** 2026-09-05 · **Latest verification:** 2026-09-06 · **Reviewed tree:** working tree based on `fd74f10dcfc42a1281eb610bcc66c7c39a900268` (includes uncommitted work) · **Full Chromium regression:** 1138/1138 (E2E + units) · **Production smoke:** passed

Each issue now has a dated code review and a recommendation. Current status is derived from its acceptance boxes; historical measurements below are retained with their original dates. See [review evidence and document dispositions](review_2026_09_05.md) and [HTML tracker](master_checklist_status.html). The review is not a claim of scientific certification; independent calibration, browser-matrix and release gates remain explicit.

This is the **single register** of everything left to fix or build. It supersedes and merges every prior issue list. Do not open a new tracking document; add to this one.

## Source documents merged into this register

These sources were archived on **2026-08-15** and relocated with their directory structure preserved to [`docs/archive/audits/archive/`](../archive/audits/archive/) on **2026-09-05** — see [that directory's README](../archive/audits/archive/README.md) for the full disposition. They are provenance, not a work queue; do not work from them.

| Source (now in `archive/`) | Contribution | Disposition |
|---|---|---|
| `codex_audit_of_full_project_remediation_checklist.md` | 139 open items across 43 IDs; **format template for this document** | all 39 IDs with open items verified carried over |
| `current_status_of_project.md` | WP-1…WP-7 work packages, measurement evidence, implementation code | issues → here; architecture → design doc |
| `ui_ux_audit_2026-08.md` | 54-screenshot visual audit (`archive/ui_screenshots/`) | findings → §4; palette + residual design → design doc §9 |
| `ui_issues_report.md` | code-verified UI findings, consolidated priority | merged into §4 |
| `needs_be_fixed_frontend_dev.md` (35 FE items) | 4 survivors | 31 verified resolved — Appendix A |
| `needs_to_be_fixed_ux.md` (9 UX items) | 3 survivors | 6 verified resolved — Appendix A |
| `todo.md` | 2 survivors | 2 verified resolved, rest folded in |
| `djf-pipeline_report.md` | reviews dead code (`js/analysis/djf/`) | see CLEAN-01 |

**Not archived, deliberately:** `docs/audits/cell_cycle_model_investigation_handoff.md` is a **research log**, not a task list — five measured model changes, four of which made things worse, and why. It is what stops the joint estimator being re-attempted. Keep it current.

## How to use this checklist

- Keep the issue ID in commit messages: `fix(MODEL-02): deconvolve the smoothing kernel`.
- One independently testable issue per commit. Coupled items may share a PR; their tests stay separate.
- **Do not tick an item because the symptom disappeared.** Tick it when implementation, regression test, and acceptance criteria are all satisfied.
- For scientific behaviour, capture a before/after numeric fixture and say why the new result is preferable. A UI screenshot is not sufficient.
- Batch full-suite runs after five completed issues, using focused checks for each change in between.
- When starting or resuming active work, record `**Started:** YYYY-MM-DDTHH:MM:SS±HH:MM`. Only actively pursued issues should carry this field; remove it if work is deferred. Closed issues automatically leave the current-work card.
- When closing an issue, record `**Completed:** YYYY-MM-DDTHH:MM:SS±HH:MM` using the actual completion time and timezone. The generated tracker lists closed issues newest first; never invent timestamps for historical completions.
- Run source-tree tests **and** production-`dist/` tests. A source-only pass does not establish that the deployed site works.

### Priority legend

- **P0** — release or scientific blocker. Fix before any public release or scientific reliance.
- **P1** — can change results, lose reproducibility, hide failures, or block supported users.
- **P2** — robustness, accessibility, security hardening, maintainability.
- **P3** — optimization, documentation, developer experience.

### Status legend

- `[ ]` open · `[x]` done · `[~]` partial (detail in italics) · `[?]` needs evidence before it can be scoped
- Issue status is closed when all acceptance boxes are complete, partial when some are complete/partial, and open otherwise. Fenced examples do not count. For mixed priority labels the HTML filter uses the highest priority. Deferred ideas remain visible; FEAT-01 is an alias, not a second residual-panel issue.
- The dated review/recommendation is the current assessment. Earlier prose and benchmark tables document historical work and may describe the pre-fix state.

---

# Section 0 — Environment (do this first)

### ENV-01 — Node version pin — RESOLVED 2026-08-15

**Priority:** P0 (blocked every build and check) · **Effort:** 1 minute

**Problem:** `.nvmrc` and `engines.node` pinned **22**. The only installed version was **24**, so `nvm use` failed, and `scripts/preflight.cjs` hard-rejected 24. Because `npm run check` begins with `npm run preflight`, the entire gate — lint, docs, imports, privacy, tests, build, dist — could not run.

```
$ nvm use          → N/A: version "v22" is not yet installed
$ node scripts/preflight.cjs   (on 24) → requires Node 22.x; found v24.16.0   exit 1
```

**Resolution: the pin moved to 24.x.** Node 24 is the current Active LTS (`lts/*` → `lts/krypton` → v24.16.0); 22 is in maintenance with an April 2027 EOL. The audit trail records builds validated under *both* 22.23.2 and 24, so validation history favoured neither — keeping 22 would have meant pinning the older line only because it was already declared.

- [x] `nvm use` resolves and `node scripts/preflight.cjs` exits 0 — *`Toolchain preflight passed: PhaseFinder 0.8.0, Node v24.16.0`.* Node 22.23.2 was also installed while diagnosing and remains available via `nvm`.
- [x] Pin decided and applied — `.nvmrc` → `24`, `engines.node` → `24.x`, `README.md` Development section → "Use Node 24". All four CI workflows use `node-version-file: .nvmrc` and needed no change.
- [x] Recorded in `docs/release-and-privacy.md` under **Toolchain pin**, with the rationale and the two-file change rule.
- [x] `packageManager` corrected to `npm@11.13.0` (the npm shipping with 24.16.0; was `10.9.0`). Not enforced — no corepack — but `scripts/generate-provenance.cjs:19-20` falls back to it outside npm invocations, so a stale value would misreport npm in release provenance.

**Gate status on 24:** `npm run check` exits 0 end to end — preflight, `lint:js`, `check:dom` (225 static + 4 generated IDs), `check:docs` (14 HTML, 17 Markdown), `check:imports` (137 modules, 428 edges), `check:privacy` (527 tracked paths), `test:ci` (25 tests), `test:unit` (756/756), `build` + provenance (43 files), and `check:dist` (44 files). Verified 2026-08-15 after ENV-02 was fixed.

**Review (2026-09-05):** `.nvmrc`, `package.json` and preflight agree on Node 24; reviewed commands ran on v24.16.0.

**Recommendation:** Keep the pin and declared package manager synchronized when upgrading.

### ENV-02 — The working Playwright venv is not discoverable — RESOLVED 2026-08-15

**Priority:** P2 · **Effort:** 1 minute (**actual: the diagnosis below was wrong; see resolution**)

**Problem:** A working venv exists at `~/.venvs/playwright` (Python 3.12.13, playwright 1.60.0, Chromium verified). Test drivers look for `PHASEFINDER_TEST_PYTHON` → `./.venv/bin/python` → `python3`. The project has no `.venv`, and bare `python3` resolves to a uv shim without playwright — so `npm run test:unit` fails despite a perfectly good venv being present.

**Two errors in that diagnosis, both found while fixing it:**

1. **Only `.githooks/pre-commit` implemented that resolution chain — the npm scripts did not.** `test:unit` and its siblings called bare `python3`. The symlink alone would have fixed the hook and left `npm run check` failing exactly as before.
2. **`.venv` was not gitignored.** Only `tests/external_tools/.venv/` was. Creating the symlink would have left an untracked `.venv` at the root, one `git add -A` away from being committed.

- [x] `ln -s ~/.venvs/playwright .venv` — created and verified (`playwright 1.60.0`, Chromium 148.0.7778.96 launches).
- [x] `.venv` and `.venv/` added to `.gitignore` with a comment covering the symlink case.
- [x] Added `scripts/python.sh`, which implements the documented resolution order (`$PHASEFINDER_TEST_PYTHON` → `./.venv/bin/python` → `python3`) copied from the hook, and repointed all five `test:*` npm scripts at it. This is what actually unblocked the gate. `check:docs` and `check:imports` still call `python3` deliberately — they are stdlib-only and interpreter-agnostic.
- [x] Reconciled `requirements-dev.txt` **down to `playwright==1.60.0`**, matching the environment the 756-check suite is actually validated against. The 1.61.0 pin had never been exercised here. *If the intent was to move up to 1.61.0, this is the line to revisit — the direction was a judgement call.*
- [x] Documented both environments in README under **Which Python the tests use**: a table separating `.venv` (from `requirements-dev.txt`) from `tests/external_tools/.venv` (its own scripts, >1 GB, gitignored, not read by `npm run check`), plus the resolution order and why the indirection exists.

**Known gap, not blocking:** the `.venv` target `~/.venvs/playwright` has **no `pip`** and **no `flowio`**, so it does not fully satisfy `requirements-dev.txt`. Nothing in `npm run check` needs flowio — only `tests/validation/driving_code/generate_flowio_reference.py` imports it — but that script will fail under this `.venv`. Replace the symlink with a real venv (`python3 -m venv .venv`, as the README now instructs) if you need to regenerate flowio references.

**Review (2026-09-05):** `scripts/python.sh` resolves the existing `.venv`; all 865 browser unit checks ran successfully.

**Recommendation:** Keep the documented interpreter resolution; fresh-clone reproducibility remains REL-04.


---

# Section 1 — Scientific modeling correctness

> **Before changing any model code, read `docs/audits/cell_cycle_model_investigation_handoff.md` §5.** Five model changes were attempted and measured; four made results worse. That document is the reason this project is recoverable — keep it current.

### MODEL-01 — G2 mean is placed low on 30/30 samples — REDIAGNOSED

**Priority:** P0

**Problem:** `g2_mean` sits below the FlowJo reference on all 30 samples, median −3.2%, and `g2_mean` alone fails 20/30. It was previously believed to be a single peak-estimator defect. **Measurement shows it is two independent errors, and roughly half may not be ours.**

```
reference g2:g1 ratio   median 2.0088   (quartiles 1.9941 .. 2.0296)
our fitted ratio        median 1.974            → ratio deficit  -1.73%
observed g2_mean error  -3.2%
        g1_mean error   -1.5%
        ratio error     -1.73%
              sum       -3.23%    ← matches observed
```

Verified per-sample (`1468f`: G1 −0.70%, ratio −1.77%, G2 −2.45%).

**The ratio component is probably correct science, not error.** Chromatin condensation in G2/M restricts DNA accessibility to intercalating dyes, so G2/M cells fluoresce slightly less than twice G1 — a documented cause of a true ratio below 2.0 ([Darzynkiewicz et al.](https://pmc.ncbi.nlm.nih.gov/articles/PMC2967208/)). Our free-fitted 1.974 is what that predicts. FlowJo's median sits essentially on the theoretical 2.0, and FlowJo supports constraining the mean-peak ratio ([FlowJo docs](https://docs.flowjo.com/flowjo/experiment-based-platforms/cell-cycle-univariate/)). The reference is **not** hard-locked at 2.0 (ratios span 1.94–2.29) but clusters tightly around it, and **every reference mean is stored as an integer** (±0.29% quantization on G1).

- [x] **Do not tune `g2_mean` toward the FlowJo reference.** Record this decision so it is not re-attempted. *(Recorded in `docs/scientific-result-contract.md` §"G2:G1 mean ratio" and in `help/help-cell-cycle-accuracy.html` §6 as a user-facing statement, both naming it a convention difference rather than a gap to close.)*
- [x] Diagnose the −1.5% G1 offset — see MODEL-02. That is the clearly-ours half and it propagates into everything downstream. *(Diagnosed 2026-08-19: it is a **width** disagreement, not a location error — the fit-free histogram mode carries the whole offset, and pinning FlowJo's CV onto our own histogram closes 74% of it. MODEL-02 has the measurements.)*
- [x] Re-run the 30-sample validation after MODEL-03 and re-derive this decomposition. *(Re-derived 2026-08-19 on all 30 samples with MODEL-03 and MODEL-04 in place. The decomposition holds and is now slightly tighter:)*

  ```
  reference g2:g1 ratio   median 2.0088   (Q1 1.9927 .. Q3 2.0347)
  our fitted ratio        median 1.9766           → ratio deficit  -1.55%
  observed g2_mean error  -3.19%
          g1_mean error   -1.61%
          ratio error     -1.55%
                sum       -3.15%    ← still matches observed
  ```

  Per-sample (`1468f`): G1 −0.72%, ratio −1.35%, G2 −2.06%. Our free-fitted ratio is still ~1.977 — the chromatin-condensation reading is unchanged by MODEL-03/04, and MODEL-02 now shows the same ratio deficit (−1.48%) appears in the fit-free histogram **modes**, with no estimator involved.
- [x] Document the ratio decision in help and in `docs/scientific-result-contract.md`: we fit the ratio freely and expect ~1.97 on yeast; tools that constrain it to 2.0 will disagree systematically. *(Contract §"G2:G1 mean ratio" carries the decomposition, the mechanism and the citation; `help/help-cell-cycle-accuracy.html` §6 "Where the peaks sit" carries the plain-language version with the ~1.6%/~3.2% numbers a user needs to reconcile channels with a FlowJo collaborator.)*

**Review (2026-09-05):** Free G2:G1 ratio and documented convention difference remain in the models/help; the historical 30-sample comparison was not rerun in this audit.

**Recommendation:** Retain the convention explanation; do not tune means to an incompatible reference constraint.

### MODEL-02 — The −1.5% G1 offset — DIAGNOSED, and it is not a location error

**Started:** 2026-09-06T13:24:59-04:00
**Model:** GPT-6 Astra Light

**Priority:** P0

**Problem:** G1 sits ~1.5% below reference across the set. It passes 30/30 only because the tolerance is ±3%. It propagates into `g2_mean` in full (MODEL-01).

**What has been ruled out:** half-bin quantization. With ~460k events `recommended_bin_count()` selects the finest stop, so half a bin is ≈0.3% — a fifth of the offset. Reference integer quantization accounts for another ~0.29%. Neither explains 1.5%.

**The strongest clue, and it is a strange one:** on synthetic ground truth G1 comes out **high** (+0.49%); on real data it is **low** (−1.5%). *The signs disagree*, so the real-data offset is **not** the peak-estimator bias this was assumed to be. ~~Most likely candidates are QC/domain related — the structural `$PnR` ceiling changes the histogram range and therefore the binning.~~ **That hypothesis is now refuted — see below.**

#### How this was measured

All 30 samples of the `flowjo_async_djf` set were re-run outside the browser, driving the *same* app modules (`FCSParser` → `build_raw_analysis_channels` → `createStructuralValidityMask` → `dna_histogram` → `dean_jett_fox`) from node. The node path was validated against the browser path first: on `1468f` it reproduces the register's recorded G1 error to within 0.02pp (−0.72% here vs −0.70% recorded), so the numbers below are the app's numbers, not a re-implementation's.

Two traps were hit and are worth recording, because anyone repeating this will hit them: the DNA channel for this dataset is **`GFP/FITC-A` (FL7-A, SYTOX Green)**, not the PI channel — the manifest's `format.dna_channel_evidence` block is the authority, and using PI gives G1 means ~2.5× too low. And `find_pipeline_channel_indexes()` wants `parameter_map(summary)` objects, not `summary.columns` (which is an array of label strings); passing the latter silently returns all-null indexes.

- [x] Instrument one real sample end to end: raw channel values → structural QC ceiling → resolved range → bin edges → detected peak index → reported mean. Compare each stage against the reference's 171.

  `1468f`, reference G1 = 175:

  | stage | value |
  |---|---|
  | raw DNA (`GFP/FITC-A`) | min −47.55, max 2634.58, 460,415 events |
  | `saturation_ceiling()` | 1000 (`$PnR`, datatype F, gain 1, amp `0.0,0.0`) |
  | structural QC | 453,977 retained, 6,438 rejected (1.40%) |
  | eligible range | [0.000196, 998.586] |
  | binning | 1024 bins, binWidth 0.97518 |
  | detected G1 peak | bin 178, x = 174.07 |
  | fitted `g1Mean` | 173.735 — **−0.72%** |

  No stage introduces a step change. The reported mean sits 0.33 channels *below* the peak bin centre and 1.27 channels below the reference; the peak bin centre is itself already 0.93 below the reference. **The offset is present in the histogram before the model touches it.**

- [x] Test whether the offset scales with the histogram range (QC/domain cause) or is constant in channel units (estimator cause).

  Three sweeps on `1468f`:

  | sweep | what was varied | `g1Mean` response |
  |---|---|---|
  | A | bin count 128 → 2048 at the natural range (bin width 7.80 → 0.49) | 173.58 → 173.83 — flat, offset ≈ −1.2 channels throughout |
  | B | range max 1000 → 3000 at a fixed 1024 bins | scatters ±0.5 channel, no monotone trend (bin-grid alignment noise) |
  | C | range max 1000 → 1500 with bin **width** held at ~0.975 | 173.42 → 173.44 — moves **0.014 channels** |

  **The offset is constant in channel units and does not scale with the range.** The leading hypothesis in the paragraph above — that the `$PnR` ceiling changes the range and therefore the binning — is refuted: sweep C changes the range by 50% at constant bin width and the answer does not move.

#### The rediagnosis

Neither branch of that either/or is right. The offset is not an estimator defect *and* not a range/binning effect — it is already in the data as we gate and bin it, and what actually differs from FlowJo is the **peak width**, not the peak location.

**Fit-free measurement, 30 samples, gated, 1024 bins**, with the peak windows centred on the *reference* value so the measurement never depends on our detector:

| statistic | G1 | G2 |
|---|---|---|
| mode of the gated histogram | **−1.66%** | −3.14% |
| FWHM midpoint | −0.55% | — |
| fitted mean (DJF) | **−1.61%** | −3.19% |

**The fit-free mode already carries the entire offset; the estimator adds ~0.05pp.** 30/30 converged.

**QC does not cause it, it reveals it.** From the saved MODEL-04 baselines: no QC → median **+0.55%**, but with a −3.59%..+4.86% spread and two catastrophic detector failures (`191g` +96.33%, `191h` +93.56%). Full QC → median **−1.57%**, spread −2.24%..+0.47%. Structural QC alone (this node run) → **−1.61%**. Time QC, Cell Gate and Singlet Gate add essentially nothing. Structural QC removes the junk that was masking the offset and tightens the spread by 8×; it does not create it.

**What actually differs is the width.** FlowJo's reported G1 CV is **1.47×** ours (median 9.17 vs 6.20; against the fit-free raw-FWHM CV of 6.98 it is still 1.31×), G2 CV 1.35×. And our G1 peaks are **right-skewed** — median right-arm/left-arm ratio **1.321** at half max. A wider Gaussian fitted to a right-skewed peak is pulled up the heavy side, so it necessarily centres higher. Supporting signs: `corr(FlowJo CV − our CV, our G1 error %) = −0.367`, and the only two samples whose fitted G1 lands *above* reference — `1468i` (+0.60%, arms L 20.46 / R 17.12 = 0.84) and `1693i` (+0.40%, L 17.22 / R 18.24 = 1.06) — are exactly the two peaks that are **not** right-skewed.

**Confirmation, by pinning the width.** For each sample a single Gaussian was fitted to the gated G1 peak over ±2σ with free amplitude and free mean but **σ pinned**, first at our fitted CV and then at FlowJo's reported CV. Nothing else changed:

```
median G1 error with OUR width:     -0.97%
median G1 error with FlowJo's width: -0.09%
median share of the gap closed by the width change alone: 74%
```

Forcing FlowJo's width onto *our own* histogram moves the mean essentially onto FlowJo's answer. The location estimator is not what disagrees.

**Consistency check against MODEL-01.** The mode-based ratio deficit — G2 mode −3.14% minus G1 mode −1.66% = **−1.48%** — reproduces MODEL-01's −1.73% ratio deficit *with no estimator involved at all*. That strengthens MODEL-01's "do not tune `g2_mean` toward the reference" decision: the ratio deficit survives when every fitting step is removed.

- [ ] **Re-scoped from "write the fix".** The cause is known and it is *not* a location bug, so there is no location fix to write. What remains is a width question, and it is a real open question rather than a defect with a known correction: our σ is narrower than FlowJo's on 30/30 samples, and it is not yet established which is right. Do **not** widen σ to match — that is the same mistake as tuning `g2_mean`, one step earlier in the chain. The next measurement, and the only one that settles it, is whether our σ is too small (residual over-deconvolution from MODEL-03, or a smoothing/pedestal artefact) or FlowJo's is too large (its own smoothing, or a Gaussian absorbing the right skew that a skewed real peak genuinely has). Until that is answered, treat the residual −1.5% as **characterised and expected**, not as a bug — and say so in the scientific-result contract rather than closing the gap numerically.
- [x] Record the width disagreement in `docs/scientific-result-contract.md` alongside the MODEL-01 ratio decision: on this reference set our G1 CV runs ~0.68× FlowJo's and our G1 mean therefore sits ~1.5% low, both consequences of one width difference and neither independently tunable. *(New contract section "G1 mean sits ~1.6% low, and it is a width difference (MODEL-02)" — carries the fit-free mode evidence, the range/bin-width sweeps, the QC comparison, the pinned-σ confirmation and the explicit "do not widen sigma" instruction. User-facing version in `help/help-cell-cycle-accuracy.html` §6.)*

**Review (2026-09-05):** `peak_regions.js` retains the documented width estimator; no independent measurement settles the remaining width disagreement.

**Recommendation:** Compare known-width or independently reviewed peaks before changing sigma; preserve the measured convention differences.

### MODEL-03 — Peak width estimates are inflated by the smoothing kernel

**Priority:** P1 · **Effort:** ~1 hour · **This is the one unambiguous win from the estimator work.**

**Problem:** σ is measured on a histogram Gaussian-smoothed at `smoothingSigmaBins: 2`, so it measures √(σ² + 2²), never σ. The kernel is never removed.

**Measured on synthetic ground truth** (G1 σ true 11.00, G2 σ true 22.00):

| variant | G1 sigma err | G2 sigma err | G1 mean err | G2 mean err |
|---|---|---|---|---|
| today | +23.0% | +10.7% | +0.49% | −0.54% |
| **deconvolved** | **+12.5%** | **+7.8%** | +0.49% | −0.54% |

Sigma error nearly halves on G1, drops a third on G2, and neither mean regresses.

**Affected files:** `js/analysis/cell_cycle/peak_regions.js`

```js
// Widths are measured on a Gaussian-smoothed histogram, so every estimate is
// sqrt(sigma^2 + kernel^2), not sigma. Remove the kernel in quadrature.
// A feature narrower than the kernel is unresolvable; floor it at half a bin
// rather than returning NaN, which would drop the caller to the much weaker
// second-moment fallback.
const UNRESOLVED_SIGMA_BINS = 0.5;

function deconvolveSmoothing(sigmaBins, smoothingSigmaBins) {
  if (!Number.isFinite(sigmaBins) || !(sigmaBins > 0)) return sigmaBins;
  const kernel = Math.max(0, smoothingSigmaBins);
  if (!(kernel > 0)) return sigmaBins;
  const variance = sigmaBins * sigmaBins - kernel * kernel;
  return variance > UNRESOLVED_SIGMA_BINS ** 2 ? Math.sqrt(variance) : UNRESOLVED_SIGMA_BINS;
}
```

Apply in **both** paths — the flank estimate and the second-moment fallback (which measures on the same smoothed array, in data units):

```js
  const smoothingSigmaBins = options.smoothingSigmaBins ?? 2;
  const smoothed = options.smoothed ?? gaussianSmooth(counts, smoothingSigmaBins);
  // …
  let sigma = deconvolveSmoothing(sigmaBins, smoothingSigmaBins) * binWidth;
  // …fallback:
      const kernel = smoothingSigmaBins * binWidth;
      sigma = Math.sqrt(Math.max((UNRESOLVED_SIGMA_BINS * binWidth) ** 2, variance - kernel * kernel));
```

- [x] Implement in both paths. — `js/analysis/cell_cycle/peak_regions.js`: `deconvolveSmoothing()` at `:38`, applied to the flank estimate at `:269` and to the second-moment fallback at `:283` (the latter subtracts in data units, since `variance` already is one). Unresolvable features floor at `UNRESOLVED_SIGMA_BINS` rather than going imaginary.
- [x] Guard the assumption: if a caller supplies `options.smoothed` smoothed with a different kernel, this over- or under-corrects. Today every caller uses the default — assert it. — `peak_regions.js:240` throws when `options.smoothed` is passed without a finite `options.smoothingSigmaBins`, so a caller pre-smoothing with a different kernel gets an error instead of a silently mis-corrected width.
- [x] Regression test: a known-width Gaussian must recover σ, not √(σ²+k²). — `tests/unit/driving_code/unit_tests_cell_cycle_peak_detection.py:304`, plus `:328` (closed-form quadrature agreement) and `:362` (the mismatched-kernel guard throws).
```js
run('MODEL-03: a known-width Gaussian recovers its true sigma', () => {
  const edges = linspace(0, 400, 401);              // binWidth = 1
  const counts = gaussianCounts(edges, { mean: 200, sigma: 6, area: 50000 });
  const est = estimatePeakFromRegion(edges, counts, { left: 170, right: 230 }, { cleanSide: 'left' });
  const naive = Math.sqrt(6 * 6 + 2 * 2);           // 6.32 — the old value
  return { pass: Math.abs(est.sigma - 6) < 0.4 && Math.abs(est.sigma - naive) > 0.2,
           detail: `sigma=${est.sigma.toFixed(3)} (true 6, un-deconvolved ${naive.toFixed(3)})` };
});
```
- [x] Validate on the 30-sample set; record `all_pass` and `g2_mean` pass count. — Full sweep run 2026-08-18 over all 30 FlowJo asynchronous samples x 8 QC configurations (`validation_tests.py --flowjo-only --shard i/6`, six parallel shards; per-shard JSON in `tests/validation/validation_test_data/external_fcs/datasets/flowjo_async_djf/comparison_20260818_23*.json`).

| model | rows | converged | `all_pass` | `g1_mean` pass | `g2_mean` pass | `g2_g1_ratio` pass |
|---|---|---|---|---|---|---|
| `dean_jett_fox` | 239 (30 samples x 8 configs) | 236/239 | **51/239 (21.3%)** | 226/239 | **103/239** | 175/239 |
| `watson_classic` | 119 (15 samples x 8 configs) | 109/119 | 22/119 (18.5%) | n/a | n/a | n/a |

  Median absolute errors, DJF: `g1_mean` 1.48% rel, `g2_mean` 3.12% rel, `g2_g1_ratio` 0.037 absolute; phase deltas 3.95 pp (G1), 3.57 pp (S), 5.77 pp (G2). Per-phase within-tolerance counts are 161/239 (G1), 200/239 (S), 98/239 (G2).

  **What this does and does not establish.** The deconvolution did not regress the reference agreement, and G1 localization is now good on almost every sample-config (226/239). It did **not** rescue `g2_mean`, which fails on 57% of rows and is the single largest contributor to the low `all_pass` rate — G2 is where both the residual bias and the model disagreement live, and MODEL-03 was never the cause of it. `watson_classic` publishes no mean/ratio checks at all (`score_watson()` in `validation_tests.py` scores directional S only), so its columns are blank rather than zero. QC configuration matters more than the estimator change: the best config (`Time QC — peak-tracking`, 9/29) is more than twice the worst (`Time QC — robust-summary`, 3/30), which is the QC-CAL-01 calibration gap showing through, not an estimator defect.

**Review (2026-09-05):** `deconvolveSmoothing` and supplied-kernel guard remain in `peak_regions.js`; current peak-detection units pass.

**Recommendation:** Retain the correction and guard; historical real-data sweeps remain dated evidence.

### MODEL-04 — Sub-bin peak centre, clean-side only

**Priority:** P2

**Problem:** `mean: centers[peakIndex]` quantizes to a bin centre. A three-point parabolic fit removes up to half a bin — **but applied symmetrically it makes G2 worse.**

| variant | G1 mean | G2 mean |
|---|---|---|
| today | +0.49% | −0.54% |
| + parabolic (symmetric) | **+0.21%** | **−0.75%** ❌ |

The parabola leans toward the taller neighbour. For **both** peaks the taller neighbour is the S-phase side, so on G2 the correction pushes it further into the bias it was meant to remove.

```js
function parabolicPeakOffset(values, peakIndex, indexes) {
  const first = indexes[0];
  const last = indexes[indexes.length - 1];
  if (peakIndex <= first || peakIndex >= last) return 0;
  const yMinus = values[peakIndex - 1], yZero = values[peakIndex], yPlus = values[peakIndex + 1];
  const denominator = yMinus - 2 * yZero + yPlus;
  if (!(Math.abs(denominator) > EPS)) return 0;      // flat or inflected
  const offset = 0.5 * (yMinus - yPlus) / denominator;
  return Math.abs(offset) <= 0.5 ? offset : 0;       // reject non-interior vertex
}

// Only accept an offset that moves the centre AWAY from the S bridge.
const rawOffset = parabolicPeakOffset(smoothed, peakIndex, indexes);
const towardCleanSide = cleanSide === "left" ? rawOffset <= 0 : rawOffset >= 0;
const subBinOffset = towardCleanSide ? rawOffset : 0;
```

- [x] Implement with the clean-side guard; record `subBinOffset` in provenance. — `peak_regions.js`: `parabolicPeakOffset()` at `:183`, gated to the clean side at `:263` (`towardCleanSide ? rawOffset : 0`), applied at `:300` (`centers[peakIndex] + subBinOffset * binWidth`) and reported in the result at `:310`.
- [x] Verify no consumer reconstructs the mean as `centers[result.peakIndex]` (grep `peakIndex` across `models/`). — The only uses in `models/` are `watson_pragmatic.js:89,95,96,154,162`, all of which pass `peakIndex` to `build_asymmetric_window()` for windowing or forward it unchanged. Nothing recomputes a mean from it, so the sub-bin correction cannot be discarded downstream.
- [x] Validate: G1 must improve and G2 must not regress. — 30 samples × 8 QC configs against the FlowJo reference, run twice: once from a detached worktree at `fd74f10` with `subBinOffset` forced to `0` ("before"), once from the live tree ("after"). 358 paired rows.

  | check | pass before | pass after | gained | **lost** | closer after | **closer before** |
  |---|---|---|---|---|---|---|
  | `g1_mean` | 220/239 | **226/239** | 6 | **0** | 51 | 64 |
  | `g2_mean` | 90/239 | **103/239** | 13 | **0** | 121 | **0** |
  | `g2_g1_ratio` | 157/239 | **175/239** | 18 | **0** | 179 | 3 |

  `all_pass` 43 → 51; `dean_jett_fox` convergence 235 → 236 of 239; within-tolerance phase counts G1 156→161, S 190→200, G2 89→98; median |Δ| G1 3.99→3.95 pp, S 3.89→3.57 pp, G2 5.97→5.77 pp. `watson_classic` (which publishes no mean checks) went 17 → 22 `all_pass`.

  **Nothing regressed on any of the three mean checks** — zero rows lost a pass. The G2 column is the striking one: 121 rows moved closer to the reference and *not one moved away*. That is the predicted mechanism rather than a lucky draw. A sub-bin quantization error at the G1 position propagates to roughly twice the absolute error at the G2 position, and into the ratio at full strength, so correcting it at G1 pays off hardest exactly where the symmetric variant in the table above did damage. G1 itself is the weakest column (51 closer vs 64 farther, yet 6 gained and 0 lost) because the correction there is a fraction of a bin — small against the tolerance, so it only flips rows already sitting on the boundary.

**Review (2026-09-05):** Clean-side sub-bin correction and its provenance remain in `peak_regions.js`; current peak-detection units pass.

**Recommendation:** Keep the guard and regression fixtures; do not restore the rejected symmetric correction.

### MODEL-05 — Baseline-subtracted flank threshold

**Priority:** P3

**Problem:** `estimateSigmaOneSidedWithinRegion()` walks out until the *absolute* smoothed count drops below `fraction × peak`, so a peak on the S pedestal stays above threshold further out. Theoretically wrong.

**The "measured effect is zero" finding was recorded before MODEL-03 landed.** It rested on the flank walk stopping at a *discrete bin index*. MODEL-03's follow-on fix made the crossing a linearly **interpolated** position between two bins, so the threshold's absolute value now feeds straight into sigma whether or not the bin index moves. Re-measured on a pure Gaussian (σ = 6, kernel 2, `heightFraction` 0.5) on a flat pedestal:

| pedestal (% of peak height) | σ error, un-subtracted | σ error, subtracted | crossing bin moves? |
|---|---|---|---|
| 0% | +0.01% | +0.01% | — |
| 2% | +1.54% | +0.01% | no |
| 5% | +3.84% | +0.01% | no |
| 10% | +7.65% | +0.01% | **yes** (191 → 192) |
| 15% | +11.48% | +0.01% | **yes** |
| 30% | +23.18% | +0.01% | **yes** (190 → 192) |

So both halves of the checklist's own test are met: the error is real and grows linearly with the pedestal, *and* a fixture exists where the crossing bin itself moves.

- [x] Build a fixture with a steep pedestal where this provably changes the crossing bin. **If no such fixture can be built, close this item as not-a-defect** rather than landing an inert change. — the fixture is `tests/unit/driving_code/unit_tests_cell_cycle_peak_detection.py:391` (`pedestalFixture()` + a frozen copy of the pre-fix walk); at a 15%-of-peak pedestal the un-subtracted walk stops at bin 191 and the subtracted one at 192. Fix landed in `js/analysis/cell_cycle/peak_regions.js`: `pedestalUnderPeak()` at `:209` and the two-pass call at `:320`.

**The part that took the work was *where* to read the pedestal.** The obvious estimate — the value at the region edge — breaks a stronger invariant this repo already tests: *a peak region bounds the mean and nothing else* (`unit_tests_cell_cycle_dean_jett_fox.py:269`, `:282`). A box drawn tightly around a peak has its edges partway down the peak's own flanks, so the "pedestal" read there is peak, and the fitted width starts depending on how carefully the user dragged the handle. That version was implemented, measured, and rejected: it moved %S by 8.93pp and `g1CV` by 0.0249 across tight/default/wide regions, against tolerances of 1.5pp and 0.005.

The landed version samples the floor at **3σ out from the centre on the clean side**, σ coming from an un-subtracted first pass — a distance set by the peak, not by the region. When the region does not reach that far it has not exposed a pedestal, so nothing is subtracted and the un-subtracted behaviour stands. Both branches are functions of the peak's own width, so neither leaks region width; the two region-width tests pass unchanged. The bootstrap σ is itself pedestal-inflated, which pushes the sample point *further* out toward truer background — the error is in the conservative direction.

- [x] Regression coverage. — four checks at `unit_tests_cell_cycle_peak_detection.py:399`: recovered σ is pedestal-independent (5.9863 / 5.9945 / 6.0048 at 0 / 10% / 30%, spread 0.0185); the crossing bin provably moves; no-pedestal data is unchanged (σ = 5.9863); and a sub-2σ region over a 30%-of-peak pedestal gets no subtraction rather than a collapsed width.

#### Recorded limitation, found while measuring MODEL-06 (not a reopen)

The out-of-region fallback is safe, but it is **anti-correlated with need**: the bootstrap σ is pedestal-inflated, so a *taller* pedestal pushes the 3σ sample point *further* out, and past some pedestal height it leaves the region — disabling the subtraction exactly in the case that most needs it. Measured on the MODEL-06 fixtures, at a region of ±3σ the fitted G2 σ drifts 20.95 → 24.30 as background rises 0 → 800/bin (the gate has flipped off), while at ±3.5σ or wider it is flat at ~21.07 (the gate stays on).

Bounded, and deliberately left as-is: the failure mode is "reverts to the pre-MODEL-05 behaviour", which is what the tree did for its whole prior life, and the alternatives all re-introduce region dependence — the invariant MODEL-05 was careful to protect. The practical consequence is a peak-region drawing guideline, not a code change: **regions narrower than about ±3.5σ silently forgo the pedestal correction.** MODEL-06 does not inherit this, because `build_asymmetric_window()` clamps to the histogram rather than to the region.

**Review (2026-09-05):** Pedestal subtraction and regression checks remain in the current peak estimator; units pass.

**Recommendation:** Retain the measured fix and stated narrow-region limitation.

### MODEL-06 — Local area estimate does not subtract the pedestal — DONE, but not with the proposed rule

**Priority:** P2

**Problem:** `refine_local_area()` sums raw counts across the window and divides by summed template mass, so every background count inside the window is scaled up by the same sub-unity divisor and re-reported as peak area. G2 is hit hardest, because its window is wide relative to its area.

**Affected file:** `js/analysis/cell_cycle/models/watson_pragmatic.js`

#### The proposed fix is wrong, and it was measured

This register proposed reading the pedestal at the **contaminated** window edge, on the reasoning that "the clean side sits on background by construction". That is backwards. `contaminatedWindowSigmas` is **1**, and a Gaussian one sigma from its centre is still at **61% of peak height** — that floor is mostly peak. Subtracting it removes most of the signal:

```
                        bg=0      bg=1      bg=3      bg=8   (counts/bin)
contaminated-edge N_G1  -67.07%   -73.97%   -73.96%   -73.96%
contaminated-edge N_G2  -71.63%   -71.63%   -68.30%   -60.74%
```

A moderate over-count becomes a severe under-count on every background. This is now pinned by a regression test so the "obvious" symmetric version is not re-attempted.

Reusing MODEL-05's `pedestalUnderPeak()` (`peak_regions.js`) was the second candidate and was also rejected: it reads the right *place* but returns 0 when its sample point falls outside the user's **region**. In MODEL-05 that gate only reached sigma, where its effect stayed inside tolerance; routed into the *area* it reaches the phase fractions, and the region-width invariant breaks outright — **%S spread 8.28pp against a 1.5pp tolerance**, stepping exactly where the gate flips. A peak region bounds the mean and nothing else.

#### What landed

The floor is read at the **clean** window edge. That is MODEL-05's rule without MODEL-05's gate: it already sits at `cleanWindowSigmas` (3) from the centre, and `build_asymmetric_window()` clamps it to the **histogram**, never to the region, so it is available whatever the user dragged.

The one refinement measurement forced: at 3 sigma a Gaussian is still at `exp(-4.5)` = **1.11% of peak height** (~2 counts/bin for a typical G1), so reading the *raw* floor there subtracts the peak's own tail and biases a perfectly clean histogram low. So the peak's own tail is discounted first — the floor is `min(counts_i − tail_i)` over the edge bins, with `tail` the provisional Gaussian sized by the **un-subtracted** area. That provisional area is itself background-inflated, so the tail is over-estimated and the pedestal comes out **low by construction**: the estimator degrades toward doing nothing rather than toward eating the peak.

Measured on the bridged fixture (G1 8000 @ 70, CV 6%; G2 3000 @ 140, CV 7%; uniform S bridge) at 0/1/3/8 background counts per bin:

```
                     bg=0     bg=1     bg=3     bg=8     spread
N_G2 error  before   +0.07%   +7.00%  +21.60%  +63.64%   63.6pp
            after    +0.07%   +3.38%   +4.84%   +8.90%    8.8pp   → 7.2x less drift
N_G1 error  before   +0.72%   -1.00%   +0.99%   +5.90%    6.9pp
            after    +0.72%   -1.96%   -1.88%   -1.74%    2.7pp
pedestal read (G1/G2)  0/0   0.99/0.57  2.93/2.54  7.82/7.44   (never exceeds the true background)
```

At zero background the pedestal is **exactly 0** and the estimator is bit-for-bit its pre-MODEL-06 self, so nothing that was already right moved. It also *improves* region invariance rather than costing it: %S spread across tight/default/wide regions at 8/bin goes **2.020pp → 1.173pp**, moving a pre-existing breach of the 1.5pp tolerance back inside it.

The residual (+8.9% G2 at the heaviest background) is S-phase mass genuinely inside the window, not background. No flat subtraction can remove it — S is a ramp, not a pedestal — and limiting it is precisely what the window's asymmetry is for. Restricting the window to the clean half was measured too: it buys a further 1–6pp but makes `contaminatedWindowSigmas` inert, so it is a window redesign rather than this item, and was not taken.

The subtracted pedestal is reported as `diagnostics.g1Pedestal` / `g2Pedestal`, so the correction is auditable rather than silent.

- [x] Land **only after** MODEL-02 and MODEL-03 are validated — done in that order; MODEL-03 landed first and MODEL-02 is diagnosed. The feared over-correction did not appear, because the tail discount makes the subtraction self-limiting: with G2 correctly placed the pedestal read is *smaller*, not larger.

**Tests:** 7 assertions in `tests/unit/driving_code/unit_tests_cell_cycle_watson_pragmatic.py` — the hazard is real (frozen pre-fix estimator, +0.07% → +63.6%), the ≥5x sensitivity collapse, inertness at zero background, the pedestal-never-exceeds-background direction, the rejected contaminated-edge rule, region invariance under background, and the diagnostics exposure. Suite 818 → 825.

**Review (2026-09-05):** The two-pass pedestal estimate and tail discount remain implemented; current units pass.

**Recommendation:** Keep the measured implementation rather than the rejected formula recorded below.

### MODEL-07 — Async/sync BIC selection was removed and should return — RE-MEASURED, still blocked

**Priority:** P2

**Problem:** The reference implementation (§13, Steps 6–9) prescribes fitting asynchronous and synchronous forms separately and selecting by BIC. The feature was **removed** because with biased frozen peaks the wave is the only flexible shape left, so it absorbs peak misfit and runs to its ceiling — claiming a synchronized cohort on asynchronous data.

**The code was right; the peaks were wrong.** They are now considerably less wrong, and it is still not enough.

#### The measurement

MODEL-03, MODEL-04, MODEL-05 and MODEL-06 all landed on the clean-flank estimator since this was removed, so the blocker was re-measured on the same wave-free two-peak fixture (`unit_tests_cell_cycle_dean_jett_fox.py`, true w = 0):

```
                       at removal    now      frozen at the TRUE peaks
  asynchronous dev       1289.6     167.9            46.1
  synchronous  dev       1169.6     137.8            45.7
  fitted w               0.95       0.5877           0.0135
                         (ceiling)
  deltaBIC              -102.9     -13.1            +16.7
  selects                sync       sync             asynchronous
                         (WRONG)    (WRONG)          (correct)
```

The peaks improved by a factor of **7.7 in deviance** and the selection is still wrong.

#### Why re-landing it now would be worse than before

Both tells that made the old failure recognisable are gone. `w` no longer pins to its 0.95 ceiling (0.5877), and the synchronous fit now **converges** — so the accidental `converged` guard that used to reject the cohort no longer fires. The feature would fail *silently*.

And three of the four safeguards this register prescribes pass on the wrong answer:

| guard | value | verdict |
|---|---|---|
| ΔBIC > 10 | 13.1 | **passes** — selects synchronous with confidence |
| bumpFraction ≥ 2% | 58.8% | **passes** |
| cohort inside S phase | waveMean 0.401 | **passes** |
| restart-stable | sync deviance spread **30.18** across 4 restarts (vs **0.40** at true peaks) | **fails — the only guard that discriminates** |

Anyone re-attempting this should treat **restart stability as the primary guard**, not the fourth one. It separates the two cases by a factor of 75.

#### What is actually left to fix

`g2Mean` comes out **137.69 for a true 140 (−1.65%)** — the same offset MODEL-01/MODEL-02 diagnosed and deliberately left open, because widening σ to close it would be tuning the model to a reference rather than measuring it. So MODEL-07's blocker is literally the one box that was chosen to stay open.

Correcting **either** half of the remaining bias restores the right answer, and does so conservatively:

```
  true widths, estimated means   deltaBIC  +4.8  -> asynchronous
  true means,  estimated widths  deltaBIC  +5.6  -> asynchronous
```

Both are below the 10-point threshold, so the selection would *abstain* rather than guess — which is the behaviour you want at the margin.

- [ ] Re-land after MODEL-02, alone, with its guards (`ΔBIC > 10`, `bumpFraction ≥ 2%`, cohort inside S phase, restart-stable). — **not yet.** Measured 2026-08-19: still mis-selects, and three of the four listed guards do not catch it. Reorder them so restart-stability is primary when this is re-attempted.
- [ ] Validate before keeping. Note this also restores the architecture the reference prescribes, lost when `auto_dj_djf` was retired. — blocked behind the box above.

**Enforcement, so this is not re-litigated from memory:** two tests at `unit_tests_cell_cycle_dean_jett_fox.py` pin the blocker — one asserts the BIC comparison still mis-selects (**it failing is the signal to re-land**), one asserts the two old tells are gone. The stale numbers in `dean_jett_fox.js`'s "why there is no population-form selection" block were replaced with the current ones; they claimed a 0.95 ceiling and a non-converging fit, both now false, and a reader would have concluded the blockers had cleared.

**Review (2026-09-05):** No Automatic registry entry or production async/sync BIC selector exists; the recorded instability remains unresolved.

**Recommendation:** Require restart stability and independently reviewed peaks before reintroducing model selection.

### MODEL-08 — Latent typed-array truncation trap — **RESOLVED 2026-08-18**

**Priority:** P2 · **Effort:** 5 minutes

**Problem:** `watson_pragmatic.js:243` uses `counts.map(...)`. Safe **today** only because `dna_histogram.js` builds counts with `new Array(n)`. If anyone switches to a typed array for performance — plausible, and PERF-01 invites it — `.map()` returns the same typed array type and **silently truncates S-phase counts to integers**. Identical bug class to the one already fixed in `poisson.js`.

- [x] Replace with `Array.from(counts, (y, i) => …)`. — `js/analysis/cell_cycle/models/watson_pragmatic.js:243`, with a comment naming PERF-01 as the change that would arm the trap.
- [x] Grep for the same pattern elsewhere on numeric arrays. — The only live instance was this one. `lm_solver.js:192` maps over `new Array(parameterCount).fill(0)` and `peak_regions.js:277,280,281` map over locally-built `[]` index arrays; all four are structurally incapable of being typed arrays, so no further edits are warranted.

**Correction to the premise above:** the `.map()` was latent behind **two** guards, not one. Besides `dna_histogram.js` building with `new Array(n)`, `fit()` at `watson_pragmatic.js:226` already normalises with `const counts = Array.from(histogram.counts ?? histogram.y)` on entry. The fix is still correct and still worth having — it removes the dependence on a caller-side normalisation that nothing enforces — but the residual arithmetic was never reachable in a truncating state on `main`.

**Regression tests:** three, in `tests/unit/driving_code/unit_tests_cell_cycle_watson_pragmatic.py`. The first asserts the hazard is *real* (`Int32Array.prototype.map` truncates this exact arithmetic: `anyFractionalWhenTyped:false, anyFractionalWhenPlain:true`) so the other two cannot pass vacuously; the second feeds an `Int32Array` histogram and asserts the residual S counts come back fractional (206 nonzero, 206 fractional); the third asserts typed-array and plain-Array inputs produce identical `phaseFractions` and `parameters`.

**Review (2026-09-05):** Watson constructs residuals with `Array.from`, preserving floating values from integer counts; units pass.

**Recommendation:** Retain typed-array coverage when worker paths change.

### MODEL-09 — Two different default bin counts — **RESOLVED 2026-08-18**

**Priority:** P2 · **Effort:** 15 minutes

**Problem:** `dna_histogram.js:18` declares `DEFAULT_BIN_COUNT = 512`; `plotting/data.js:47` declares `DEFAULT_BINS = 256`. Same concept, two values, and which applies depends on the call path.

- [x] One exported constant, imported by both. — `DEFAULT_BIN_COUNT = 256` now lives in `js/analysis/pipeline/dna_histogram.js:24` (exported at `:333`, consumed by the `settings.binCount ?? DEFAULT_BIN_COUNT` fallback at `:267`); `js/plotting/data.js:51` imports it and re-exports it as `DEFAULT_BINS`, keeping the name its existing importers already use.
- [x] Test asserting the histogram module and the plot module agree. — `tests/unit/driving_code/unit_tests_bin_settings.py`, four tests, registered in `run_unit_tests.py`.

**Which value won, and why 256:** 256 is what the Bins slider defaults to and what its tooltip advertises, so it is the count users have actually been analysing at through the UI. 512 was the analysis-side silent fallback on a path no production caller reaches (every live caller of `ensure_histogram_current` passes an explicit `binCount`). Unifying *down* to 256 therefore changed no observed behaviour while removing the divergence.

**Which module owns it, and why not the plotting layer:** `js/plotting/data.js` runs `document.querySelector` at module top level, so anything importing it is barred from a worker. `dna_histogram.js` is a pure leaf with no imports. Putting the constant in the leaf and having the presentation layer import *from* it keeps the dependency pointing the correct way and leaves the histogram builder worker-safe — which PERF-01 will need.

**Tests pin the relationship, not the number.** They assert identity (`DEFAULT_BINS === DEFAULT_BIN_COUNT`, which only holds while `data.js` is genuinely re-exporting rather than keeping a copy that happens to match), that the shared default is a real `BIN_STOPS` entry so the slider can land on it, that non-finite stored bin counts fall back to the shared default index, and that every stop round-trips through `slider_index_for_bins`.

**A note for whoever tests this area next:** `plot_bin_count()` takes **no arguments** — it reads `#plot_bins` from the DOM. In the unit harness that element does not exist, so it unconditionally returns `DEFAULT_BINS`; assertions written against it pass vacuously. The DOM-independent entry point is `slider_index_for_bins(bins)`, which is what these tests use.

**Review (2026-09-05):** Histogram and plotting defaults share `DEFAULT_BIN_COUNT`; bin-settings units pass.

**Recommendation:** Keep one shared default.

### SCI-03 — Convergence criteria and reasons must be truthful

**Priority:** P0

Termination states, gradient criterion, and diagnostics are implemented; `apply_result_contract()` overrides contradictory `converged: true`.

- [x] Show nonconvergence prominently in sidebar/table/export; disable authoritative phase reporting unless explicitly reviewed. **Implemented by UI-01** (`master_checklist.md:906`, which explicitly names this as the box it closes) — the `⚠`-in-text-content marker travels with every surface (table, sidebar, TSV, SVG `<desc>`/summary text) via the single `fraction_trust_reason()`/`format_fraction_cell()` pair, weight-700 + non-colour cues survive greyscale/forced-colors, and `role="status" aria-live="polite"` announces the result to screen readers. **One clause of this box's literal wording is superseded by a later, deliberate design decision, not silently unmet**: `apply_result_contract()` (`result_contract.js:503-513`) explicitly does **not** withhold the phase-fraction number on nonconvergence — its own comment states the FlowJo-style rationale ("whether to TRUST a fit is ultimately the user's call, so we always present the fractions we actually computed... and rely on the warnings and the goodness-of-fit statistic to let the user judge"). So nonconvergence is shown prominently (satisfying the first half) but does not *disable* the number the way the box's second clause literally asks — it qualifies it instead, which is the intentional, documented product choice this project settled on rather than an oversight.
- [ ] Benchmark stricter criteria against existing good fits to avoid excessive false nonconvergence. **Genuinely not attempted — the box names no candidate criteria to benchmark.** The current LM optimizer's convergence tolerance is a single fixed constant (`js/analysis/math/lm_solver.js:11`, `tolerance: 1e-7`, plus a `stepTolerance`/`maxIterations` pair); nowhere in the codebase, `docs/`, or this checklist is there a proposed *stricter* value or an alternative gradient/step criterion to compare it against — "stricter" is undefined. Real "existing good fits" data does exist for this locally (`tests/validation/validation_test_data/external_fcs/` — 38 real FCS files including the 30-sample FlowJo/FlowReader reference set at `datasets/flowjo_async_djf/flowjo_djf_reference.json`, gitignored per the private-data convention), so this is not blocked the way QC-CAL-01 is; what is missing is the candidate criteria and the acceptable false-nonconvergence-rate threshold to test them against, both of which are judgment calls this checklist item does not make. Deliberately left open rather than inventing an arbitrary "stricter" number and reporting a benchmark result no one asked for.

**Review (2026-09-05):** Nonconvergence qualification remains implemented; no stricter candidate criterion or comparison study has been added.

**Recommendation:** Define a candidate and false-nonconvergence tolerance before benchmarking; retain the documented policy allowing qualified numbers.

### SCI-05 — One canonical phase-fraction result everywhere

**Completed:** 2026-09-06T12:39:22-04:00

**Started:** 2026-09-06T12:35:07-04:00

**Priority:** P0

Table/sidebar/TSV all read `format_fraction_cell()` (`js/ui/cell_cycle_columns.js:109-113`) off the same `active_result()`-gated object; the plot's SVG `<desc>`/"analysis summary" surface independently reconstructs its text in `analysis_text()` (`js/plotting/render.js:129-138`) because an SVG description can't carry a CSS class or a table cell's `⚠` styling, but is fed the identical contracted-result object via `pipeline_fit_for_series()` → `get_active_model_result()` (`render.js:427-437`) — the same `validForReporting===true` gate `active_result()` uses — so there is no second, independently-computed number for the two to disagree on. Every current model (`dean_jett.js`, `dean_jett_fox.js`, `watson_classic.js`, `watson_pragmatic.js`) always emits a complete `phaseFractions` object (real ratios, or an explicit all-zero fallback), so `build_fit_series_entry()`'s per-key moments-based fallback (`render.js:376-383`) is unreachable for any result that passes the shared gate.

- [x] Cross-surface test asserting identical displayed fractions for a fit with meaningful modeled tail mass. Implemented as `tests/unit/driving_code/unit_tests_sci05_cross_surface.py` (registered in `run_unit_tests.py`), 4 checks, all passing (`Unit summary: 865/865 passed, 0 FAILED`, `2026-08-20` run): a clean converged fit shows byte-identical percentages on the table (`format_fraction_cell()`) and the plot (`analysis_text()`); a nonconverged-but-reportable fit shows the same numbers **and** the same `⚠`/`(fit did not converge)` trust caveat on both; a cancelled/unreportable fit is refused by the identical `get_active_model_result()` gate on both surfaces, so neither ever shows a number the other withholds.
- [x] Verify restored/recomputed sessions reproduce the same canonical values across every consumer. The real TOML restore/refit regression in `unit_tests_state_reproducibility.py` now checks exact fractions/warnings and table/plot text after clearing the original state, and now also exports JSON and CSV before/after restore and asserts `exportsMatch` — closing the CSV gap this box previously flagged (FEAT-02's `result.curves` production bug: CSV threw for every real fit). The complete downloaded HTML analysis report (`export_analysis_report()` / `js/plotting/plot_export.js`) is a separate, larger surface — the full report page including the QC matrix and metadata table, not just the JSON/CSV fit payload — and remains untested end-to-end; left open.

**Earlier review (2026-09-06):** Real TOML modeling restore/refit now reproduces identical fractions, warning arrays, shared table/sidebar/TSV formatter text, plot-summary text, and JSON+CSV export payloads for an accepted inferred-G2 fixture. The browser test clears pipeline state before restoring and validates model-version drift through production code. The complete downloaded HTML report is the one consumer left unexercised by an automated restore comparison.

**Recommendation:** Keep the real download/restore regression when changing result producers or consumers.

**Review (2026-09-06):** Completed the real collector → TOML → cleared pipeline → refit → downloaded JSON/CSV/HTML/SVG regression in `tests/e2e/driving_code/priority_batch_checks.py`. JSON (apart from export time) and CSV match exactly before/after; HTML and SVG contain identical phase percentages. Component counts, accepted regions, settings, histogram provenance, warning arrays and independently computed residuals are checked. Shared table/sidebar/TSV and plot-formatting checks remain in the focused reproducibility units.

### SCI-07 — Optimizer conditioning and parameterization

**Priority:** P1

**Problem:** `make_parameter_transform()` (`dean_jett_fox.js`) maps optimizer coordinates to log/scaled/bounded space via `createParameterTransform()` (`fit_engine.js:22-45`). The transform has existed since Dean-Jett-Fox's introduction (`261e4d2`), so there is no historical "before" commit to diff against. `fitPoissonModel({parameterTransform = null, ...})` already has a well-defined, engine-native fallback for the untransformed case — raw identity encode/decode (`fit_engine.js:~92-97`) — so that fallback, not a detached worktree, is the "naive" baseline.

- [x] Compare convergence rate, restart dispersion, runtime, and recovered parameters on existing fixtures before/after. — `dean_jett_fox_naive.js`, a copy of the model with `make_parameter_transform()` forced to `return null`, benchmarked against the real `dean_jett_fox.js` across all 30 modelable known-truth/QC/scientific synthetic fixtures (`tests/validation/validation_test_data/synthetic_fcs/`, includes the two new SCI-07 stress fixtures below), loaded through the real `js/fcs/parser.js` + `dna_histogram.js` in a headless Node harness. Same peak regions, same restart budget (12 restarts, 200-iteration cap) for both variants.

  | | dimensionless (current) | identity (naive) |
  |---|---|---|
  | converged | **30/30 (100%)** | 16/30 (53.3%) |
  | mean iterations to convergence | 74.1 | 126.7 (repeatedly hits the 200-iter cap) |
  | mean restart-converged fraction | **57.2%** | 23.3% |
  | mean restart deviance std / range | **91.13 / 217.96** | 120.51 / 355.51 |
  | mean wall time per fit | **5884 ms** | 7598 ms |
  | recovered deviance (30 fixtures) | as-good-or-better in **27/30** (21 strictly lower, 6 tied) | strictly lower in 3/30 |

  The dimensionless coordinates convert a coin-flip optimizer (roughly half the fixtures never converge at all) into one that converges everywhere, with tighter restart agreement and lower per-fit cost despite doing more restart work that actually finishes. Raw benchmark rows: `out_benchmark.json` (30 rows) in the scratch harness.

- [x] Add stress fixtures: low/high event counts, channel ranges, overlapping peaks, weak S, high debris, near-bound parameters. — Most of this axis list was already covered (`truth_low_count_55_30_15` for low counts, `truth_high_cv_overlap_35_45_20` for overlapping peaks, `truth_low_s_48_04_48` for weak S, `bulk_scale_x10` for channel range, `qc_*` fixtures for debris/artifacts). The two gaps — high event count and near-bound parameters — are new, seeded 1011/1012 in `generate_fixtures.py`, registered under `SCIENTIFIC_CASES` and `_coverage().fcs_triggerable["SCI-07"]`:
  - `truth_high_event_count_50_30_20` — 300,000 events (vs. 12-20k for the rest of the corpus), the opposite end of the conditioning axis from the low-count fixture. On this one the naive baseline fails to converge at all within the iteration budget (0% restart-converged, deviance std 526.5) while the dimensionless transform converges cleanly (75% restart-converged, deviance std 227.0, essentially tied final deviance 3459.8 vs 3459.5).
  - `truth_djf_near_bound_wave_45_40_15` — Dean-Jett-Fox wave parameters (`w=0.90`, `waveMean=0.04`, `waveSigma=0.03`) planted deliberately near `DEFAULT_CONFIG`'s own optimizer bounds (`wMax=0.95`, `waveMeanMin=0.02`, `waveSigmaMin=0.02`), not just a strong wave. The naive baseline still nominally "converges" but to a **22.8% worse deviance** (756.1 vs 584.0) and its restart-converged fraction collapses to 8.3% (1/12) vs 58.3% (7/12) for the dimensionless transform — exactly the failure mode (near-boundary optimizer coordinates) this box exists to catch.

  Corpus regenerated 60→62 cases; `generate_fixtures.py --check` confirms byte-level reproducibility (93 files), and `run_benchmark.py`'s `validate_corpus()` passes on the new manifest.

**Review (2026-09-05):** Parameter transforms, stress fixtures and solver diagnostics remain present; 865/865 units pass. Historical before/after sweeps were not rerun.

**Recommendation:** Retain the recorded conditioning benchmark; require a new comparison when parameterization changes.

### SCI-08 — Quadratic S profile constrained without arbitrary shrinking

**Priority:** P1

Verified by execution: profile integrates to 1.000000, stays ≥0 across extreme shape parameters (min 2.6e-26), S mass equals `sArea` exactly.

- [x] Compare fitted phase fractions before/after on reference fixtures and explain intentional changes. — Both variants run headless over the 28 known-truth synthetic fixtures (`8164285^` vs `8164285`, each with the S-profile module instrumented to count `projectQuadraticProfile` activations).

  **How often the arbitrary shrinking actually fired** — the thing the item is named for:

  | model | shrinks fired / profile evaluations | fixtures affected | worst pre-shrink min q(z) |
  |---|---|---|---|
  | `dean_jett` | 8,694 / 356,983 (2.44%) | 12/28 | −172.90 |
  | `dean_jett_fox` | 62,137 / 999,418 (6.22%) | **28/28** | −52.71 |

  It was not a rare rescue. Every single DJF fixture drove the literal quadratic negative somewhere on [0,1], on average once every sixteen evaluations, and the ray-shrink then pulled the profile back toward flat by an amount determined by *how* negative it went — a non-smooth step in the middle of an LM iteration, applied to the very parameters LM was differentiating.

  **Fitted phase fractions, max |error| against known truth:**

  | model | mean before → after | median | moved >0.05 pp | after closer | before closer | converged |
  |---|---|---|---|---|---|---|
  | `dean_jett` | 9.130 → 8.526 pp | 3.925 → 3.925 pp | 11/28 | 8 | 3 | 25 → **24** |
  | `dean_jett_fox` | 10.118 → 9.993 pp | 7.824 → 7.555 pp | 21/28 | 13 | 8 | 25 → **28** |

  **What changed on purpose.** The Bernstein form `q(z) = w₀(1−z)² + 2w₁z(1−z) + w₂z²` with `(w₀,w₁,w₂) = 3·softmax(0, shape1, shape2)` is a *strictly smaller* function class than "any quadratic with unit integral": every member is non-negative by construction, whereas the old class contained profiles that were negative until the projector clipped them. So a slightly worse deviance on some fixtures is the expected price, not a bug — and it is small: median deviance change `dean_jett` +0.00%, `dean_jett_fox` −0.18%, with DJF's deviance *lower* on 22/28 fixtures despite fitting in the smaller class. Removing the non-smooth projection is what buys that: DJF convergence 25/28 → **28/28**.

  Individual movements are dominated by fixtures where the old fit had collapsed rather than by the basis change itself — `truth_high_cv_overlap_35_45_20` 25.21 → 11.37 pp (before: S ballooned to 70.2% with G2 at 0.2%), `tail_mass_clipped_domain` 18.05 → 11.13 pp. Regressions exist and are named: `watson_subg1_contamination` 10.69 → 16.55 pp (also non-converged → converged, so the two fits are not comparable point-for-point) and `qc_time_gain_drift` 15.22 → 16.77 pp. `ratio_nondiploid_1p50` moved 4 pp but both fits are misspecified — the fixture's G2:G1 ratio is 1.50 against a model assuming ~2.0.

  **The cost, stated plainly.** `softmax` saturates: as a weight approaches the edge of the simplex its shape parameter's Jacobian column goes to zero. `maximumJacobianCondition` (the max over *all* LM iterations, so one bad early step flags a whole fit) came back singular on 18/28 DJF fixtures before and **28/28** after; `dean_jett` 6 → 14. The old `(b, c)` parameterization entered the profile linearly and never saturated — it just produced negative profiles instead. This is a genuine trade, not a free win: the profile is now non-negative by construction and smooth for the optimizer, at the price of shape parameters that are locally unidentifiable near the simplex boundary. That is precisely the condition UNC-01's rank/condition reporting exists to surface rather than hide.

**Review (2026-09-05):** Bernstein S-profile implementation and DJF edge checks remain in the current models; units pass.

**Recommendation:** Keep positivity constraints and independent component-grid checks.

### STAT-01 — Poisson input rejection and bound auditing

**Priority:** P1/P2

`PoissonInputError` exists (`js/analysis/math/poisson.js:30`); `constraint_audit.js` derives bounds from each model's published `bounds`.

- [x] Verify each sub-item against the tree and tick with evidence pointers.
- [x] Emit exact constraint residuals and active-bound diagnostics.
- [x] One focused test triggering each configured bound/joint constraint warning.
- [ ] **HUMAN HELP NEEDED** — Calibrate reduced-deviance and residual warning thresholds against independent data. *(shared with the QC calibration study, QC-CAL-01. Needs a labelled real-acquisition dataset and a user/policy decision on acceptable rates — no engineering path closes this without that input.)*

**Review (2026-09-05):** `poisson.js` rejects invalid input; `constraint_audit.js` records residuals/bounds; `unit_tests_stat_constraints.py` passes in the current suite. Calibration remains open.

**Recommendation:** Retain these checks; calibrate warning thresholds against the independent data required by QC-CAL-01.

### LEGACY-01 — Quarantine or retire legacy stages 5–8

**Priority:** P1/P2

The item was written against a bridge that was still in the tree. It no longer is: `5ac4956` deleted `models/legacy_bridge.js` (215 lines), `legacy_bridge_fit.js`, `debris_aggregate_extension.js`, `cell_cycle_fit_report.js`, and the whole 21-file `js/analysis/djf/` directory, along with the `legacy_bridge_v1` registry entry. Quarantine became moot when the thing being quarantined stopped existing, so `unit_tests_legacy_quarantine.py` went with it and was replaced by an inverted assertion that the model is *not* registered.

- [x] Verify each sub-item and tick with evidence. — done in this pass; evidence on each box below.
- [x] Confirm no canonical plot/table/export/report path can fall back to legacy output. — nothing produces legacy output any more. `apply_base_fit`, `apply_contamination_fit`, and `apply_fit_report` have no definition anywhere in `js/`, and no module outside `pipeline_state.js` itself reads `.baseFit`, `.extendedFit`, or `.report`. Those three names survive only as inert slots in `STATE_FIELDS_IN_ORDER` (`pipeline_state.js:117`), initialised to `null` at `:307-309` and never written. `get_active_model_result()` (`:339`) excludes them by construction *and* requires the GATE-01 contract stamp, so no hand-written `resultsByKey` entry can publish either. The negative is pinned by test rather than left to inspection: `unit_tests_cell_cycle_registry.py:88` asserts `registry.get_model('legacy_bridge_v1') === null` and that the id is absent from the registered list.
- [x] Correct any remaining "DJF" label that actually refers to the bridge. — no such label survives, because no bridge survives. Every remaining `DJF` in `js/` names either the Dean–Jett–Fox *model* (`shared.js:36`, `dean_jett_fox.js`, `watson_pragmatic.js:7`) or the manual pipeline UI (`cell_cycle_pipeline.js:76`, `start.js:194`, `panels.js:44`) — neither of which is the bridge. The one path that genuinely mixed the two, the accessible plot description merging the stage-8 report's warnings into a canonical fit, now takes canonical warnings only (`render.js:141-144`).

**Residue, tracked elsewhere:** the three retired slot names still sit in `STATE_FIELDS_IN_ORDER`, and `docs/model-result-contract.md:5-7` still describes their deleted producers as live code. That is a documentation defect, filed under DOC-03 below, not a fallback path.

**Review (2026-09-05):** Deleted bridge and staged-model files remain absent; registry-negative and import checks pass.

**Recommendation:** Retain historical design under archive; repair remaining current-doc drift under DOC-03.

### UNC-01 — Uncertainty, identifiability, and sensitivity reporting

**Priority:** P1 (publication gate)

**Problem:** No uncertainty reporting existed at all. A fitted percentage was presented as a point estimate with no interval.

New module `js/analysis/cell_cycle/uncertainty.js`, fed by a Jacobian evaluated once at the solution in **natural** parameter units (`fit_engine.js:159-174` → `solutionJacobian`; the optimizer's own Jacobians are in transformed logit/log-area coordinates and are discarded each iteration, so they cannot be reused). Published on the normalized result of both `dean_jett` and `dean_jett_fox` as `uncertainty`, with its warnings folded into `result.warnings`. The warning policy fields now survive normalization and qualify fractions through the shared contract (GATE-02; fixed 2026-09-05). 35 new browser checks in `tests/unit/driving_code/unit_tests_uncertainty.py`; suite 783 → **818/818**.

- [x] Report Jacobian/Hessian rank/condition evidence and parameter correlations. — `parameterUncertainty()` (`uncertainty.js:143`) returns `{ covariance, correlations, standardErrors, eigenvalues, rank, rankDeficiency, conditionNumber, nullSpaceDirections, highCorrelations, weaklyIdentified }`, sharing `lm_solver.js`'s `gramMatrix()`/`symmetricEigenDecomposition()` (extracted at `:459`/`:474` from the sweep that was buried inside `estimateJacobianCondition`) so the optimizer and the reporter cannot disagree about whether a fit was identified — asserted directly (`uncertainty=3.1306967740648997 lm_solver=3.1306967740648997`).

  The covariance is `(J'J)^-1` with **no dispersion factor**. The objective is `sum(r²)` over Poisson *deviance* residuals, so `sum(r²) = D = −2logL + C` and the observed information is `I = ½·d²D/dθ² ≈ J'J`. Poisson dispersion is *known* (= 1), so unlike a least-squares fit there is no residual variance to estimate and multiply in; an overdispersed fit is a model-adequacy failure that `diagnostics.reducedDeviance` reports, not something to inflate the covariance with. The test that protects this is structural rather than numerical: scale J by k and every standard error must move by exactly 1/k, which nothing but `(J'J)^-1` does.

  Rank-deficient directions are handled by Moore-Penrose pseudo-inversion over the retained subspace, and the register should be explicit about why that needs a flag rather than trusting the numbers: **a singular `J'J` still yields small, entirely innocent-looking standard errors.** On the duplicated-column fixture the SEs come back `[0.354, 0.707, 0.354]` at rank 2 of 3. The rank flag is the only thing that says the fit is meaningless, so a consumer must never read `standardErrors` alone.

  Writing the tests surfaced a real defect. `RANK_TOLERANCE` was `1e-10` on eigenvalue ratios and `CONDITION_WARNING_THRESHOLD` was `1e8` on the condition number — but forming `J'J` **squares** the condition number, so the rank cut at `1e-10` corresponds to a condition of `1e5`, far below `1e8`, and *every* ill-conditioned fit was classified rank deficient first. The `ill_conditioned` branch was unreachable dead code. Fixed to `RANK_TOLERANCE = 1e-14` (double precision's own resolution for `J'J`, and the same cut `estimateJacobianCondition` uses to declare a Jacobian singular) and `CONDITION_WARNING_THRESHOLD = 1e6`, leaving a real `1e6`–`1e7` band; a test now asserts the band is non-empty so the two constants cannot drift back apart. The old cut was also actively harmful: a direction at `1e-10` is not null, merely weakly determined, and dropping it *hid* its large-but-real standard error inside the pseudo-inverse. Under the old constants a noiseless 9-parameter Dean–Jett fit generated by the model's own primitives reported rank **6/9**; it now correctly reports 9/9 at condition 8.6e5.

- [~] Profile-likelihood or bootstrap intervals suited to bounded nonlinear parameters and phase fractions. — The bootstrap half is built and measured; nothing calls it yet.

  New module `js/analysis/cell_cycle/resampling.js`. `percentileInterval()` returns endpoints that **are** replicate estimates, so a fraction interval cannot leave [0, 1] by construction rather than by repair — which is the specific defect it fixes in the delta-method layer, where `fraction_interval_clipped` fires precisely because a symmetric normal interval ran off the end of the simplex. Bias-corrected (Efron BC) endpoints are available too: `z0 = probit(#{θ* < θ̂}/B)`, endpoints at `Φ(2z0 + z_{α/2})` and `Φ(2z0 + z_{1-α/2})`. **Not BCa** — acceleration needs a leave-one-out jackknife, i.e. *n* further fits, and at 3.2 s per Dean–Jett–Fox fit that is not affordable. A saturated `z0` (every replicate on one side of the point estimate) falls back to the plain percentile and reports `biasCorrectionApplied: false` rather than collapsing both endpoints onto the extreme replicate.

  The event bootstrap here is **exact, not an approximation**. Every downstream consumer sees only bin counts, so resampling the retained DNA events with replacement is the exact nonparametric bootstrap of what the model was fit to; no within-bin position is invented. That only became possible after finding that `domain_sensitivity.js` already takes the retained `values` and re-bins via `generateHistogram` — the first design took `{edges, counts}` and reconstructed pseudo-events uniformly within bins, which would have been a stated approximation for no reason. The Poisson-counts path survives only as an explicitly labelled fallback (`method: "poisson_count_bootstrap"`) for a caller holding a histogram but not the events, and it records `event_bootstrap` and `bin_domain` as skipped with reasons.

  The Poisson sampler draws exponential inter-arrivals in **log form**. The textbook Knuth product form compares a running product against `exp(-λ)`, and `Math.exp(-1200) === 0` exactly in double precision — λ ≈ 1200 is an ordinary G1 bin of a 300 k-event file, so the product form returns 0 for every such bin and silently deletes the peak from every replicate. A unit check asserts the underflow *and* that no bin comes back empty at λ = 1200 (mean 1200.4, var/mean 1.011).

  **What remains:** no production caller. `fit_engine.js` publishes the asymptotic bundle but never invokes this layer, so a user still sees only optimizer-only intervals. Wiring it needs a cancellable off-thread run (measured cost below), which is why the module already takes `shouldCancel`/`onProgress` and returns a partial bundle on cancel.

- [~] Include event resampling plus peak-region, bin/domain, and QC perturbations — not optimizer-only uncertainty. — Three of the four are implemented and exercised; QC is a caller-supplied hook with no supplier.

  `resampleUncertainty()` builds each replicate in the order **QC → event bootstrap → binning/domain**. Any other order would bootstrap events that the chosen QC variant had already removed. The peak-region jitter perturbs each edge by ±(width × `DEFAULT_REGION_JITTER_FRACTION` = 0.10) and repairs any resulting overlap; bin counts are drawn from `domain_sensitivity.js`'s declared ladder restricted to a factor-of-2 neighbourhood of the baseline, and the domain from its declared trim set, so the two modules cannot disagree about what a "reasonable" perturbation is.

  QC gating happens upstream of the model layer and cannot be perturbed from inside this module, so `qcVariants` must be supplied by the caller. **The item's core requirement is the honesty about that, not the perturbation count.** When no variants arrive the bundle records `skipped: [{name: "qc", reason: …}]`, `resamplingWarnings()` emits `perturbations_incomplete`, and the generated `definition` sentence ends `It does NOT include: qc.` — all three built from what actually ran, not from what was configured. The module header states the principle it enforces: *an interval that hides which perturbations it omits is worse than no interval.* A unit check asserts the whole chain end to end, because any one of the three surfaces alone could drift silently.

  Prototyping the jitter found a real defect before it shipped: repairing an overlap by pulling the two **inner** edges to their midpoint could drag an inner edge past its own **outer** edge when the regions started close together, emitting a region with `left ≥ right`. 448 of 5000 draws did this at `jitterFraction: 0.9`. Fixed by restoring each region's original width from its repaired inner edge; the regression test runs 3000 draws of deliberately close regions through the **real** `validatePeakRegions` (0 rejected, 0 inverted) rather than through a restated copy of its rules.

  Also refused rather than worked around: if events are supplied but no bin count and domain can be resolved, the call throws immediately. Letting `generateHistogram` re-derive the range from each bootstrap sample would move the analysis domain between replicates — a different analysis, not a resampling of this one — and DOMAIN-01 is explicit that the domain is a scientific input. Failing at the door also matters at seconds per fit: the alternative spends the whole budget throwing one replicate at a time.

- [~] Report model-selection frequency/instability across resamples. — Implemented and tested; unwired with the rest of the layer.

  `selection` carries `{comparisonGroup, ambiguousGroups, pointEstimateWinner, frequency, winnerFrequency, replicates, instability, stable}`, where `frequency` is the share of replicates each model won and `stable` is `winnerFrequency ≥ 0.8`. Below that, `model_selection_unstable` fires: if a small perturbation of the data flips which model wins, "the best model is X" is not a finding.

  **This is where plan §5.5 stops being a declaration and becomes an enforcement.** `rankableOutcomes()` drops any outcome whose `comparisonGroup` is null before ranking, so `watson_pragmatic` can never be BIC-ranked against a generative model however low its BIC — the unit fixture gives the null-group model `bic: -99999` precisely so an unenforced rule would be unmistakable rather than subtle. Its intervals are still reported; it is excluded from the *ranking*, not from the output. Non-converged fits are dropped the same way. Two different **non-null** groups are refused as well, with `selection_group_ambiguous`: taking whichever group came first in the array would have hidden the error behind a plausible-looking winner, and that ordering dependence was found and removed while writing these tests.

- [~] Persist interval method, seed, replicate count, failures, and definition. — All five are on the bundle; none reach result provenance or the session TOML yet.

  `{method, intervalMethod, intervalLevel, seed, replicatesRequested, replicatesSucceeded, replicatesFailed, failures[], cancelled, perturbations: {requested, applied, skipped}, definition}`. `failures` records up to 20 per-replicate reasons — a cap, because a systematically broken fit would otherwise accumulate one string per replicate. `definition` is generated from `applied`/`skipped`, so it cannot claim a perturbation that did not run. `resamplingWarnings()` uses the same `{id, severity, nonreportable, message}` vocabulary as `identifiabilityWarnings()`: `resample_insufficient_replicates` (critical, **nonreportable**, below 40 usable replicates), `resample_failure_rate` (warning at 5%, critical at 20%), `perturbations_incomplete`, `selection_group_ambiguous`, `model_selection_unstable`, `fraction_interval_undefined`, `fraction_too_uncertain`.

  Measured cost, which is what forces the cancellation/progress API rather than a synchronous call (node, 300 bins, 15 k events): **Dean–Jett–Fox 3214 ms, dean_jett 468 ms, watson_classic 175 ms** per fit JIT-cold; dean_jett + watson_classic together settle at 0.5–1.06 s per replicate. At the default 200 replicates that is 100–210 s for the two cheap models and over 10 minutes if DJF is included.

  30 browser checks in `tests/unit/driving_code/unit_tests_resampling.py`; suite 827 → **857/857**.

- [x] Validate nominal coverage on clean, low-count, boundary, weak-S, and contaminated simulations. — 12 runs of 60 known-truth datasets × 80 replicates, both models, `intervalLevel: 0.95`. Coverage is the share of the 60 datasets whose 95% interval contained the true fraction; ± is the binomial standard error on 60.

  | scenario | model | G1 | S | G2 | mean S width |
  |---|---|---|---|---|---|
  | clean (8000/4000/3000) | watson_classic | 100.0% | 96.7% | 95.0% | 2.9 pp |
  | | dean_jett | 95.0% | 90.0% | 93.3% | 9.1 pp |
  | low count (800/400/300) | watson_classic | 100.0% | 96.7% | 98.3% | 9.2 pp |
  | | dean_jett | 93.3% | 88.3% | 86.7% | 16.0 pp |
  | boundary (S = 0.5%) | watson_classic | 100.0% | 88.3% | 100.0% | 0.5 pp |
  | | dean_jett | 100.0% | 86.7% | 100.0% | 0.7 pp |
  | weak S (S = 3.5%) | watson_classic | 100.0% | 95.0% | 96.7% | 1.3 pp |
  | | dean_jett | 100.0% | 73.3% | 85.0% | 2.0 pp |
  | contaminated (+2650 uniform) | watson_classic | **0.0%** | **13.3%** | **13.3%** | 7.4 pp |
  | | dean_jett | **0.0%** | 78.3% | **10.0%** | 13.3 pp |

  `watson_classic` holds nominal coverage or better on all four well-specified scenarios. `dean_jett` under-covers on S and G2 wherever the peak is hard (73.3% on weak-S S, 86.7% on low-count G2), which is the known MODEL-01/02 peak-offset bias showing up as interval failure rather than as a visible misfit. It also loses selection: `watson_classic` won 59/60 clean, 60/60 low-count, 60/60 boundary, 60/60 weak-S.

  **The contaminated row is the important result and it is a negative one.** Coverage collapses to 0–13% because mean bias reaches −7.5 pp on G1 and +4.1 pp on S — and *no* interval width rescues a biased point estimate. Widening the perturbation set from events-only to the full set roughly doubled the intervals (dean_jett S 13.3 → 23.3 pp) and lifted S coverage from 78% to 92%, but left G1 at 13% and G2 at 15%: the bias simply exceeds any defensible width. The layer's own guard is what partly covers this — with the full perturbation set `dean_jett` was flagged **nonreportable on 50 of 60** contaminated datasets (21/60 with events only), so most of these never reach a reader. `watson_classic` is the worry: only 7/60 blocked, with G1 coverage at 25%. It reports a tight, confident, wrong answer.

  Recorded plainly because it bounds what this item can claim: **resampling intervals quantify variance, not model misspecification.** Detecting the contaminated case is a QC/goodness-of-fit problem (`diagnostics.reducedDeviance`, QC-03/QC-04), not an interval-width problem, and the coverage numbers above are the evidence for that split.

- [x] Qualify weakly identified, rank-deficient, active-bound and unstable fractions consistently across result consumers; preserve the warning policy fields. Contract v2 interprets material warnings centrally; producer normalization retains `nonreportable`. Production resampling remains a separate unfinished requirement. See GATE-02. This requirement from the original register was missing from the consolidation.

**Review (2026-09-05):** DJ/DJF publish asymptotic uncertainty; `resampling.js` has passing units but no production caller. Shared warning qualification is implemented (GATE-02); CSV and actual session-restore coverage remain unfinished.

**Recommendation:** Wire cancellable worker resampling with QC variants, persist its seed/method/failures, and carry material warnings with all fractions.

### VALID-01 — Independent scientific validation

**Priority:** P0 before any publication-grade claim

- [x] Select primary Dean, Jett, Fox, and Watson references; build a traceable equation-to-code mapping with units and parameter definitions. — `docs/plans/cell_cycle_modeling_plan.md` §5.3-5.5 already had the equations and citations (`DeanJett1974`, `Fox1980`, `Watson1987` in `docs/references/references.bib`) but zero `file:line` cross-references into the actual implementation (`grep -c "\.js:"` was 0 before this edit). Added §5.5a, a symbol-by-symbol table linking every equation in 5.2-5.5 to its `file:line`, with units and the dimensionless-vs-channel-unit distinction made explicit per parameter (e.g. `w`, `waveMean`, `waveSigma` are dimensionless in latent-`z` units; `g1Mean`/`g2Mean` are channel units). Also documents that `sPhaseProfile`'s Bernstein reparameterization is what actually enforces non-negativity in code, where the plan's `a,b,c` form only *describes* the constraint.
- [x] Compare DJ and DJF expected component curves over a parameter grid, not only fitted totals. — the existing tests only compared the **combined** `expectedCounts()` curve at two single fixed parameter points (w=0, w=0.4). Added three grid tests to `unit_tests_cell_cycle_dean_jett_fox.py` that call `shared.js`'s already-public `peakComponents`/`convolvedSPhase`/`convolvedSPhaseWithProfile`/`sPhaseProfile` directly (the same functions both models' own `expected_counts_from_parameters()` call — no new test-only export added) across a 24-point grid of `(shape1, shape2, g1CV, g2Mean)`:
  - the **S-phase component alone** (not the combined curve) nests exactly at w=0 across the whole grid (`maxDiff=0`, not just at one point);
  - `peakComponents.g1 + S + peakComponents.g2` exactly reconstructs each model's own public `expectedCounts()` output across the grid, confirming the decomposition is faithful to production behavior, not just internally self-consistent;
  - at w>0 the wave perturbs **only** the S component (min divergence 14.06 across the grid, i.e. every grid point diverges, not just some) while G1/G2 stay byte-identical (`maxPeakDiff=0`), localizing exactly where DJ and DJF differ instead of only observing that the combined curve differs.
  Suite is 860/860 (was 857/860; 3 new checks, zero regressions).
- [x] Redistributable datasets spanning instruments, encodings, contaminants, distributions. *(stale claim corrected — three already-wired, genuinely redistributable datasets were previously left uncredited here.)* The box's prior text ("one assembled — 30 yeast async samples, single instrument/encoding, local-only... acquiring additional... is outside what this session can source or fabricate") described only `flowjo_async_djf`, which is explicitly **not** redistributable (no upstream license, local-only, never committed). It omitted three datasets already present in `external_fcs/manifest.json` and already run through `discover_external()` in `tests/validation/driving_code/validation_tests.py` (registered in `main()`, not exploratory code) — checked at the artifact level this session to confirm real, redistribution-safe licenses rather than relying on the top-level manifest fields (which are empty for two of the three; the license/format facts live per-artifact):
  - **Miltenyi PBS fixture** (`fcsparser_miltenyi_pbs_fcs31.fcs`) — MIT-licensed (`covers_binary: true`, retained via `LICENSES/fcsparser-MIT.txt`), MACSQuant instrument, FCS3.1, datatype F, byte order 1,2,3,4, 19 parameters. Parser-conformance fixture only — no biological/cell-cycle truth claimed.
  - **Rodighiero et al. 2024** (`datasets/rodighiero_2024/`) — CC0-1.0 (Dryad, `doi.org/10.5061/dryad.cvdncjtcx`), FCS3.0, datatype F, byte order 4,3,2,1, 11 parameters (DAPI/EdU/mCherry/GFP-A). Four FCS files: `kasumi1_edu_fucci.fcs` and `mda_mb_231_edu_fucci.fcs` carry real published phase percentages (Figure 4A / Figure 4—figure supplement 1A) already wired into `discover_external()`'s expected-value comparison; `kasumi1_negative.fcs` and `mda_mb_231_negative.fcs` are genuine negative-control/contaminant acquisitions with no published mapping. Two distinct human cancer cell lines (Kasumi-1 leukemia, MDA-MB-231 breast).
  - **Amouzgar et al. 2025** (`datasets/amouzgar_2025/primary_tcell_donor2_96h.fcs`) — CC-BY-4.0 (Zenodo record 14852934), FCS3.0, datatype F, byte order 4,3,2,1, 47 parameters, mass cytometry (CyTOF) — a fundamentally different acquisition modality than conventional fluorescence flow, on primary human T-cells. Diagnostic-only comparison (the published percentages aggregate all donors/samples, not per-file truth for this one).

  Together these give three distinct real SPDX licenses (MIT, CC0-1.0, CC-BY-4.0), two distinct FCS encodings (3.1/byte-order 1,2,3,4 vs 3.0/byte-order 4,3,2,1), instruments spanning a conventional MACSQuant cytometer, the Dryad-sourced cytometer behind the Rodighiero acquisitions, and a CyTOF mass cytometer, explicit negative-control/contaminant populations (Rodighiero), and three biological distributions (human leukemia line, human breast-cancer line, primary human T-cells) beyond the pre-existing single local-only yeast set. This satisfies the box's literal ask — diversity of redistributable datasets — without fabricating anything; it does not, on its own, change any other box (VALID-01 box 4/5's tolerance and FlowJo-comparison work, or QC-CAL-01's separate need for *labelled acquisition-time/pulse-geometry anomalies*, which none of these three datasets contain).
- [~] Predefine acceptance tolerances for peaks, fractions, deviance, model choice, QC masks. *(peaks/fractions/means/CVs/ratio done; deviance/model-choice/QC-mask not — FlowJo does not report them.)*
- [~] Compare against FlowJo/ModFit and document configuration equivalence. *(equivalence documented; **the ratio-convention difference in MODEL-01 must be added to it**.)*
- [x] Investigate bootstrap/profile-likelihood intervals. UNC-01 already records an implemented, tested bootstrap method and measured coverage across clean, low-count, boundary, weak-S and contaminated simulations. This investigation is complete; production wiring and independent validation remain open under UNC-01 and the other boxes here.
- [x] Identifiability/restart/condition diagnostics distinguishing precise-looking but weakly identified fits. — already implemented, not previously credited here: `uncertainty.js`'s `multistartAgreement()` (`js/analysis/cell_cycle/uncertainty.js:417-472`) reads the optimizer's own per-restart audit trail (`fit.attempts`) to distinguish genuine multimodality (converged restarts disagreeing on parameters despite indistinguishable deviance) from mere restart dispersion (worse local minima), and `identifiabilityWarnings()` (`uncertainty.js:500-628`) turns rank/condition/interval/multistart evidence into a tagged warning vocabulary (`rank_deficient`, `ill_conditioned`, `parameter_correlation`, `multimodal_optimum`, `restart_dispersion`, etc.), each carrying `nonreportable: boolean` so GATE-01 can refuse to publish an unidentified fit. Wired into production for both `dean_jett.js:427,435` and `dean_jett_fox.js:774,782`. Watson (`watson_pragmatic.js`, `watson_classic.js`) is confirmed to have **zero** hits for any uncertainty/multistart/`fitPoissonModel`/`attempts` terms — structurally exempt, not an unaddressed gap, because Watson never runs the iterative multi-start optimizer this diagnostic reads from (it's a local asymmetric-window peak fit, §5.5).
- [x] Document validated scope, unsupported inputs, remaining differences. — added a consolidated "Validated scope, unsupported inputs, and remaining differences" section to `docs/scientific-result-contract.md`. It is an index, not a restatement: what's been checked (FlowJo agreement scope, SCI-07 optimizer benchmark, VALID-01 box 2 component-grid checks, UNC-01 coverage collapse under contamination), what has explicitly not been checked (multi-instrument datasets, bootstrap/profile-likelihood intervals, domain-expert review, CLOCCS/Watson's exclusion from cross-model claims), and the known FlowJo differences already on record — each claim links to its evidence rather than re-deriving it.
- [ ] **HUMAN HELP NEEDED** — Domain-expert review before using "validated", clinical, diagnostic, or publication-grade language. — cannot be performed by an AI; same boundary as the dataset-sourcing box above. Needs a qualified domain expert's sign-off, which only the user can arrange.

**Review (2026-09-05):** Independent curve-grid and uncertainty units pass. Recorded bootstrap investigation exists; calibrated QC thresholds and domain-expert approval do not.

**Recommendation:** Use independent truth and predefined tolerances; do not equate self-generated regression success with scientific validation.

### FUTURE-01 — Hierarchical/cross-sample models

**Priority:** P3

- [ ] Complete VALID-01 and calibration-aware batch work first.
- [ ] Define which parameters may pool; retain explicit between-sample variance rather than hard equality.
- [ ] Require verified batch/calibration membership; preserve per-sample diagnostics and outlier handling.
- [ ] Validate under both correct and violated sharing assumptions, plus leave-one-out sensitivity.

**Review (2026-09-05):** No hierarchical cross-sample fit implementation is registered. The planned feature remains deferred.

**Recommendation:** Keep deferred until per-sample validation and an explicit use case justify it.

### AMBIG-01 — Two ambiguities a single histogram cannot resolve

**Priority:** P1

**Problem:** (a) A pure G1 and a pure G2 population produce histograms identical up to an x-scale factor. `inferred_g2` always assumes the lone peak is G1 — an assumption that can be wrong on a G2-arrested sample. (b) (1C,2C) and (2C,4C) are both ~2:1; smoothing destroys the width evidence, and two local discriminators were tried and both provably failed.

*User decision on record: defaulting to G1 is acceptable for automated testing; in real use the user moves the regions.*

- [x] Surface the single-peak assumption in the review panel and preserve a warning on a newly fitted result. `peak_review_ui.js` explicitly asks the user to verify the G1 assumption. Current bulk fitting asks for confirmation and then accepts regions; the older assertion that bulk auto-acceptance is withheld is superseded. Session restoration loses this provenance (STATE-02), and fraction labels now carry material warnings through GATE-02’s shared policy.
  A second, deeper gap was found via this map's own D9 dependency note (below): reviewing and accepting an `inferred_g2` selection satisfied `model_preflight()`'s existing `REGIONS_UNREVIEWED` block, but nothing downstream (export, table, session, plot) retained any trace that the acceptance was of an ambiguous single-peak guess — an accepted `inferred_g2` fit was indistinguishable from a confident `detected` fit once reviewed. Fixed by threading `peakDetection.status` through the contract: `model_preflight()` (`result_contract.js`) now returns `peakDetectionStatus` in its bundle; a new frozen `RESULT_REASON.REGIONS_AMBIGUOUS_SINGLE_PEAK` code was added; `apply_result_contract()` pushes a non-blocking warning with that code whenever `preflight.peakDetectionStatus === "inferred_g2"`, naming the G1 assumption and noting the sample could be G2-arrested instead. Refusal already existed (`REGIONS_UNREVIEWED`); this adds the qualification half, so a `detected` fit and a reviewed `inferred_g2` fit remain distinguishable to every consumer that reads `warnings`.
  New regression test: `tests/unit/driving_code/unit_tests_gate_contract.py`, `'AMBIG-01/D9: an inferred_g2 (single-peak) selection is preflighted through and qualified with a warning, not silently accepted'` — asserts `peakDetectionStatus` is carried, the warning is present for `inferred_g2` and absent for `detected`, and the result stays `validForReporting: true` (qualified, not refused).
  861/861 unit tests pass (860 pre-existing + 1 new).
- [ ] **HUMAN HELP NEEDED** — **Do not** attempt another local heuristic for (b). Use cross-sample anchoring (one acquisition run shares a DNA axis, so samples showing two peaks fix 1C for those that don't), bead/known-control calibration, or recorded condition metadata (`Nocodazole Arrest` is already carried). Needs a product decision on which anchoring approach to build before any of the three can be implemented.

**Review (2026-09-05):** Current peak review names the G1 assumption, and contract units retain a new-fit warning. Bulk acceptance policy differs from the old prose; restore loses detection status (STATE-02).

**Recommendation:** Preserve ambiguity provenance across restore and fraction labels; use control/cross-sample evidence for ploidy anchoring.


---

# Section 2 — Quality control

### QC-CAL-01 — The shared calibration study *(highest-leverage QC item)*

**Priority:** P1 · **Unblocks:** calibration-dependent work in QC-03, QC-04, QC-05, QC-06 and STAT-01; QC-01’s acknowledgement UI is already implemented

**Problem:** Five separate QC items are each blocked on the same missing thing — a labelled dataset with known disturbances against which thresholds can be calibrated. Doing the study once closes parts of all five; doing them individually is not possible.

- [~] Assemble labelled acquisitions covering: stable runs, clogs, dropouts, timer rollover, backward time jumps, doublet-heavy samples, debris-dominant samples. *(2026-08-21: no real labelled acquisitions of this kind exist anywhere in the project or its external datasets — confirmed, not assumed, by inventorying every dataset already wired into the test suites. Built an honest substitute instead of leaving this at zero: `tests/validation/validation_test_data/synthetic_fcs/generate_qc_calibration_fixtures.py` generates 7 reproducible (seeded, `--check`-verified) synthetic FCS fixtures — stable, clog, dropout, timer rollover, backward time jump, doublet-heavy, debris-dominant — each with injected, known-exact ground truth in `qc_calibration/manifest.json`, explicitly labelled as synthetic in the manifest's own disclaimer, never presented as real acquisitions. `verify_qc_calibration_fixtures.mjs` runs the REAL production `runTimeQC`/`gateByPulseGeometry`/`gateMainBiologicalCloud` (not reimplementations) against all 7; all pass. This closes the "nothing to calibrate against at all" gap but is explicitly NOT the literal ask — it is synthetic, not real-instrument data, so it can validate detector *behavior* against known-injected truth but cannot stand in for real-world acquisition variability. Left `[~]` rather than `[x]` for that reason.)*
- [ ] **HUMAN HELP NEEDED** — Predefine acceptable false-positive, detection, retention, and boundary-event rejection rates. *(still a genuine policy call for the user — no acceptable-rate numbers are proposed anywhere in the repo to adopt.)*
- [~] Calibrate MAD floors and Time QC thresholds (QC-03). *(2026-08-21: verified the existing default thresholds behave sensibly against the synthetic corpus above — clog/dropout windows are correctly flagged, timer rollover produces zero false positives, backward time jumps correctly set `limitedReliability`. No threshold VALUE was changed — this is diagnostic confirmation of the defaults, not a calibration exercise, and real calibration still needs the acceptable-rate policy call above plus real acquisitions.)*
- [~] Calibrate pulse-geometry distance/coverage thresholds (QC-06). *(2026-08-21: characterized `gateByPulseGeometry`'s real doublet-fraction breakdown curve via a sweep against the real detector — recall stays ~1.0 up to ~8-10% doublets, then degrades progressively (0.62 at 10%, 0.55 at 12%, 0.49 at 15%, ~0.09-0.12 by 35%), consistent with `fitRobustRidge2D`'s own documented minority-population assumption. This is a confirmed operating-envelope finding, not a threshold change — no constant in `pulse_geometry_gate.js` was edited.)*
- [ ] Quantify peak-tracking overlap-expansion false rejection (QC-04). *(out of scope of this session's work — untouched.)*
- [ ] **HUMAN HELP NEEDED** — Calibrate reduced-deviance and residual warning thresholds (STAT-01). *(needs the same labelled real-acquisition dataset and rate policy call as the box above.)*
- [ ] Version the algorithm/session configuration if any behaviour changes materially. *(no production threshold constants changed this session, so nothing to version yet.)*

**Review (2026-09-05):** All seven synthetic calibration cases reproduce their expected detector behavior; these include known failure behavior, not scientific acceptance. No independent labelled calibration was added.

**Recommendation:** Predefine acceptable rates and calibrate on labelled acquisitions; keep QC-05 inversion and QC-06 burden limits visible.

### QC-01 — QC outcomes explicit and fail-closed

**Priority:** P0

**Problem:** The result contract blocks reporting after critical QC removal until `qcAcknowledgements` is supplied — **and nothing supplies it**. The gate is currently a dead end rather than a safeguard.

- [x] Wire the acknowledgement flow:
```
1. On a blocked result, read result.preflight.qc for the removal that tripped it.
2. Render an INLINE panel (not a modal — this is a review decision, not an
   interruption): what was removed, how much, by which gate, why it matters.
3. "I have reviewed this" writes { gate, acknowledgedAt, removedFraction } into
   modeling state and re-runs apply_result_contract().
4. Persist acknowledgements in the session and INVALIDATE them when the QC config
   or file bytes change.
```
  Step 4 is the one to get right: an acknowledgement that survives a config change silently re-authorizes a different analysis.
  — **1.** `pending_qc_acknowledgements()` (`js/analysis/cell_cycle/qc_review_ui.js:57`) re-runs `model_preflight()` and returns *every* `QC_CRITICAL_REMOVAL` reason. It deliberately does not read the cached `lastFitError`: that records only the **first** blocking reason, and one sample can trip critical removal on more than one stage at once (`unit_tests_qc_acknowledgement.py`, "an acknowledgement on one stage does not cover a critical loss on another").
  **2.** Inline panel `#qc_critical_review` (`index.html:251`), rendered by `render_qc_critical_review()` (`qc_review_ui.js:178`) from the top of `refresh_panel()` (`modeling_ui.js`). It sits in the "Model & Fit" sidebar section beside the fit it is blocking — not a modal, per the item.
  **3.** `acknowledge_qc_critical_removal()` (`qc_review_ui.js:108`) writes `{ key, acknowledgedAt, removedFraction }` per stage; the button wiring re-renders and re-runs the panel through `init_qc_critical_review()` (`:219`).
  **4.** The invalidation is by **identity, not revocation**: `qc_acknowledgement_key()` (`result_contract.js:215`) derives a key from the stage's `configHash` plus its evaluated/rejected/retained counts, and `qc_acknowledgement_authorizes()` (`:247`) requires an exact match. Change the QC configuration or the file bytes, the stage re-runs, its counts move, its key changes, and the stored record silently stops authorizing — nothing has to remember to revoke it. A revocation list is only as complete as the last person to think of a new invalidation trigger; a match on identity fails closed by construction.
  Persistence: `qc_acknowledgements` round-trips through the session (`modeling_session.js`, `toml_io.js`) beside `qc_waivers`, and is threaded to the contract through `run_model_fit()` (`modeling_state.js`).
  Tests: `tests/unit/driving_code/unit_tests_qc_acknowledgement.py` (17 checks). The negatives are the load-bearing ones — a bare `true`, `{}`, and a key-less record each fail to open the gate; a changed `configHash` and changed event counts each re-block with `staleAcknowledgement: true` and a distinct message, so "you never reviewed this" and "your review was of a different analysis" never read the same.
  **Behaviour change:** a bare-truthy acknowledgement used to open this gate. `unit_tests_djf_edges.py:533` asserted that; it now asserts the opposite and uses a keyed record.
- [x] Persistent batch matrix of per-file/per-stage outcomes with exact final-mask provenance. *(data already on `result.preflight.qc`; only the view is missing.)* — `js/analysis/pipeline/qc_matrix.js` (pure, AD-5): `build_qc_matrix()` crosses every **loaded** sample with all four stages (a stage that never ran reads `not_run` rather than being omitted), `build_qc_matrix_tsv()` serializes it long-form with a fixed 24-column set, `qc_matrix_html()` renders the wide sample × stage grid. Reachable two ways, both durable: the **QC matrix (TSV)** option in the download modal (`index.html`, dispatched at `plot_export.js:557`), and a "QC matrix and final-mask provenance" section in the exported HTML analysis report.
  "Exact provenance" is the part worth reading: listing which stages ran is provenance by assertion — it records what was *supposed* to compose the final mask. `final_mask_provenance()` (`qc_matrix.js:75`) instead recomposes the stage masks that are present and compares element-by-element against the stored `masks.final`, so `verified: false` catches a mask left over from before a stage re-ran — a sample whose every per-stage row looks correct while its histogram was built from the wrong events. Absent, all-pass, stale, and length-mismatched masks are each distinguished; a length mismatch is reported rather than thrown, because a report that aborts on one broken sample says nothing about the other twenty-nine.
  Tests: `tests/unit/driving_code/unit_tests_qc_matrix.py` (20 checks), covering all four mask states, the acknowledgement columns agreeing with the contract, TSV rows that survive tabs/newlines/formula injection in a reason, and HTML escaping of sample names.

**Review (2026-09-05):** `qc_review_ui.js`, `qc_matrix.js`, acknowledgement/session and gate-entry units are present and pass.

**Recommendation:** Retain explicit waivers and per-stage provenance; algorithm validity is tracked separately in QC-03–06.

### QC-02 — The sidebar contradicts the table about QC state

**Priority:** P0 · **Source:** visual audit · **Verified**

**Problem:** After "Run All", all four gate buttons render the applied state (`css/plot.css:620`, keyed on `aria-pressed`) while the table simultaneously reads *"Cell gate incomplete: scatter gate review required."* The user believes QC passed, clicks Fit, and is refused.

**Root cause is a modelling gap, not styling:** `aria-pressed` is used to mean *"completed successfully"* when it means *"toggle is on."* **There is no vocabulary for the third state** — attempted-but-incomplete.

- [x] Introduce an explicit per-gate state: `not-run` / `running` / `applied` / `needs-review` / `failed` / `skipped`. — `GATE_STATES` at `js/analysis/pipeline/pipeline_state.js:38`, with `derive_gate_state()` classifying a stage product on top of `qc_outcome()`.
- [x] Drive button appearance from that state, not from `aria-pressed`. Keep `aria-pressed` for its real meaning. — Buttons carry `data-gate-state` (`pipeline_ui.js:334`, `:337`, plus `running`/`failed`/`not-run` transitions at `:765`, `:849-851`, `:1096-1097`). The old `.qc_gate_button[aria-pressed="true"]` appearance rule is deleted on purpose — `css/plot.css:628-629` records why — so `aria-pressed` reverts to meaning only "the toggle is on" (`pipeline_ui.js:218-219`).
- [x] Make the sidebar and the table read the same state object so they cannot disagree. — One `build_gate_state_matrix()` (`pipeline_ui.js:276`) produces `row.name -> [state0..state3]`; the sidebar buttons read it at `:314` and the table's QC status column at `:345`. They cannot disagree because there is only one derivation.
- [x] Test: a gate that completes with a review requirement must render `needs-review` in **both** surfaces. — `tests/unit/driving_code/unit_tests_djf_pipeline.py:1078` (review-required scatter gate reads `needs-review` in the shared derivation both surfaces use, asserted on `buttonState` at `:1107`), `:1116` (a clean gate reads `applied`, so the test is not trivially satisfiable), `:1125` (`aggregate_gate_state` picks the worst state across samples). `tests/ci/test_contrast_tokens.py:151` additionally pins that all six states stay distinguishable under `forced-colors`.

**Review (2026-09-05):** Sidebar/table consume shared derived gate states; gate-state units and current QC E2E checks pass.

**Recommendation:** Retain the shared state mapping.

### QC-03 — Robust-summary acquisition Time QC

**Priority:** P1

- [ ] **HUMAN HELP NEEDED** — Calibrate MAD floors and thresholds. *(→ QC-CAL-01; needs labelled real acquisitions.)*
- [~] Exact-rate, disabled-metric, too-few-bin, zero-MAD tests added; multi-segment and known-disturbance tests now exist against the QC-CAL-01 synthetic corpus (clog/dropout/timer-rollover/backward-time-jump fixtures, verified against the real `runTimeQC`) — **HUMAN HELP NEEDED**: predefined *acceptable error rates* are still pending, since that policy call remains open. *(→ QC-CAL-01)*

**Review (2026-09-05):** Robust-summary metrics and synthetic disturbance checks work; independent MAD/threshold calibration is still missing.

**Recommendation:** Calibrate against labelled multi-segment acquisitions through QC-CAL-01.

### QC-04 — Peak-tracking Time QC tracking model

**Priority:** P1/P2

- [ ] Explicit missing/ambiguity plus order-constrained or dynamic assignment with merge/split/birth/death states. *(per-bin imputed/missing evidence exists from SCI-09C; crossing/merge/split assignment does not.)*
- [ ] Replace largest-terminal-node stability with a validated continuity/quality/reference criterion, or require manual review.
- [ ] **HUMAN HELP NEEDED** — Quantify overlap-expansion false rejection; evaluate consensus/weighted event decisions. *(→ QC-CAL-01; needs labelled real acquisitions.)*
- [ ] **HUMAN HELP NEEDED** — Predefine acceptable false-positive, detection, retention, and boundary-event rejection rates. *(→ QC-CAL-01; policy call for the user.)*

**Review (2026-09-05):** `peak_tracking_time_qc.js` retains greedy tracking/terminal-population selection; the plan’s full merge/split/dynamic assignment is absent.

**Recommendation:** Implement the reviewed continuity/assignment specification, then quantify boundary-event and overlap-expansion errors.

### QC-06 — Invalid pulse-geometry singlet gate

**Priority:** P1

- [~] Empirically calibrate distance/coverage thresholds against labelled data. *(→ QC-CAL-01. Minimum sample size, reliability tier, and plausible-coverage/off-axis floors are already defined and documented. 2026-08-21: the real breakdown point is now characterized against the synthetic corpus — recall holds near 1.0 up to ~8-10% doublets and degrades progressively beyond it — but no threshold constant was changed. **HUMAN HELP NEEDED**: calibrating against real labelled acquisitions is still open.)*

**Review (2026-09-05):** Pulse-geometry reliability checks exist. The historical burden sweep records breakdown above roughly 8–10% doublets; synthetic checks do not remove that limit.

**Recommendation:** Use labelled high-doublet acquisitions to calibrate or replace the gate, and expose unsupported burden/reliability.


### QC-05 — Debris-dominant scatter gating selects the contaminant population

**Priority:** P1

**Problem:** `scatter_gmm_gate.js` ranks components primarily by population weight (`quality.weight + 1e-6 * mean[0]`). When debris dominates, the selected component can be debris, so the retained sample loses biological cells. This known issue appears in the scientific contract but was omitted from the master register.

**Review (2026-09-05):** The current seven-case QC verifier reproduces the debris-dominant failure: scatter recall 0.05636, false-positive rate 1.0. Its PASS means expected behavior was reproduced, not that this gate is scientifically acceptable.

**Recommendation:** Require reviewed biological-component selection or an independently validated component criterion. Keep the debris-dominant fixture as an adversarial acceptance case and calibrate with QC-CAL-01.

- [x] Reproduce and retain biological-cell recall/contaminant-retention metrics in regression evidence. — `tests/unit/driving_code/unit_tests_scatter_gate_calibration.py` (new, registered in `run_unit_tests.py`) pins the debris-dominant fixture's measured values against the real `gateMainBiologicalCloud()` (not a reimplementation, reached via `window.PhaseFinder.pipeline.cellGate`): recall = 0.05636114911080711, false-positive rate = 1.0. Independently re-verified 2026-09-05 by running `tests/validation/validation_test_data/synthetic_fcs/verify_qc_calibration_fixtures.mjs` directly (pure Node, no browser harness) — its `debris_dominant_run` output matches both pinned values exactly.
- [ ] **HUMAN HELP NEEDED** — Replace or explicitly review population selection; predefine acceptance thresholds using labelled acquisitions. *(→ QC-CAL-01; needs labelled real acquisitions and/or a reviewed replacement criterion, neither of which an AI can supply on its own.)*


---

# Section 3 — Result integrity and reproducibility

### GATE-01 — One authoritative scientific-result contract

**Priority:** P0

`apply_result_contract()` requires a preflight bundle and stamps `contractVersion`; `is_reportable_result()` / `get_active_model_result()` demand the stamp.

- [x] Require **every** UI, worker, session-restore, debug API, and direct model entry point to call the same preflight/result validator. Enumerate the entry points and prove each one routes through it.
  **Enumeration** (by reading every caller in `js/`, confirmed with `grep`):
  - `apply_result_contract(` has exactly **one** production caller anywhere in `js/`: `modeling_state.js:549`, inside `fit_cell_cycle_model()`.
  - `model_preflight(` is read by exactly two files: `modeling_state.js` (the finalizer, `:520`) and `qc_review_ui.js` (`:61` — QC-01's acknowledgement panel re-derives the bundle to render *pending* blockers; it never calls `apply_result_contract()` itself, so it cannot produce a second "finished" result).
  - Raw `entry.fit(` is called from exactly two places: `modeling_state.js:541` (main-thread fallback) and `fit_worker.js:48` (the worker-pool path). Both are internal to `fit_cell_cycle_model()`: whichever ran the raw fit, its output flows into the *same* `apply_result_contract()` call at `modeling_state.js:549` — the worker's `normalizeResult()` output is never treated as a finished result anywhere else in the app; `fit_client.js`'s `run_fit_in_worker()` only returns it to its one caller, `modeling_state.js:535`.
  - Every consumer-facing entry point calls `fit_cell_cycle_model()` — never the registry directly. Five call sites: `modeling_ui.js:505` (Fit Current), `modeling_ui.js:757` (Run All / bulk), `modeling_ui.js:1112` (re-fit after a model/setting change), `bin_settings_sync.js:231` (bin-count-change auto-recompute), `modeling_session.js:243` (session restore), and `render.js:519` (on-demand fit for display).
  - **CLOCCS is the one direct model entry point that does not route through the contract, by design**: `fitScope: "joint_series"` models are refused inside `fit_cell_cycle_model()` itself (`modeling_state.js:496-499`, throws before reaching preflight) because a joint-series fit is over a whole strain's timepoints, not one sample — there is no single-sample "reportable" result for the contract to stamp. Its own UI path (`modeling_ui.js:871-895`, `render_cloccs_strain()`) synthesizes a `{ validForReporting: false, converged }` wrapper so every value it prints routes through the same `format_fraction_cell()`/`render_fraction_value()` every contracted result uses, carrying the same ⚠ marker — this was already true before this session (documented at `modeling_ui.js:871`), re-verified rather than re-implemented.
  - The one documented debug hook, `window.PhaseFinder` (`main.js:313-337`), exposes `app`, `pipeline` (`cell_cycle_pipeline.js`'s module namespace — QC stages + histogram only, confirmed by reading its full export list), `plot`, `session`, and `time_qc`. None of these re-export `get_model`, `entry.fit`, `fit_cell_cycle_model`, `model_preflight`, or `apply_result_contract` — there is no console-reachable way to fit or contract a result outside `fit_cell_cycle_model()`.
  **Proof, made durable**: `tests/ci/test_gate_entry_points.py` (new, 7 tests) statically enumerates this at the source level rather than resting on a narrative — it fails CI if a future call site starts calling `apply_result_contract`/`model_preflight`/`entry.fit` from anywhere outside the sets above, if a new consumer starts fitting without going through `fit_cell_cycle_model()`, if the CLOCCS joint-series refusal is removed, or if the debug hook (`window.PhaseFinder` or `cell_cycle_pipeline.js`'s exports) starts leaking a bypass. `npm run test:ci`: 41/41 pass (34 pre-existing + 7 new).

**Review (2026-09-05):** Canonical consumers require the contract stamp and gate-entry units pass. That architectural enforcement does not imply every uncertainty warning is honored (GATE-02).

**Recommendation:** Keep the shared contract; extend its material-warning policy under GATE-02.

### STATE-01 — Model settings effective, immutable, reproducible

**Priority:** P0/P1

Sessions record `model_version`; restore labels drift `recomputed_new` vs `reproduced`; `settingsApplicability` records settings a model cannot consume.

- [x] Restore the saved `reviewed` state faithfully; never silently accept or refit unreviewed regions. `js/session/modeling_session.js:210` restores the exact saved boolean (`get_modeling_state(row).peakSelection.reviewed = saved.reviewed === true;`) rather than defaulting it true; `modeling_session.js:236-242` gates the post-restore refit on `saved.reviewed === true` specifically so an unreviewed sample's regions are restored but never silently accepted or recomputed into an authoritative result. Verified end-to-end: `tests/e2e/driving_code/tests_modeling.py` — `"STATE-01: restoring an unreviewed saved sample leaves it unreviewed and does not refit"` — PASS (`reviewedAfter: False, resultCount: 0`).
- [x] On algorithm/version drift, label recomputed results as new rather than implying exact reproduction. `js/session/modeling_session.js:244-263` compares `saved.model_version` against the live model's current version and stamps `result.reproduction.status` as `"recomputed_new"` on a mismatch (vs `"reproduced"` on a match, `"unknown_saved_version"` when no saved version was recorded), attaching a `model_version_drift` warning naming both versions. Verified end-to-end: `tests/e2e/driving_code/tests_modeling.py` — `"STATE-01: restoring a version-drifted saved model labels the result recomputed_new, carrying a warning"` — PASS (`reproduction: {status: 'recomputed_new', savedModelVersion: '0.0.1-state01-drift-probe', currentModelVersion: '1.0.0', modelId: 'watson_pragmatic'}`, `warningCodes` includes `'model_version_drift'`).
- [x] Tests proving: each effective setting changes the config hash and applied behaviour; unknown settings fail; unreviewed sessions remain unreviewed; changed file bytes cannot reuse caches or results. Pre-existing dedicated suite `tests/unit/driving_code/unit_tests_state_reproducibility.py` (group `"Unit / STATE-01 Settings & Reproducibility"`, 11 assertions) covers exactly these properties by name: config-hash-changes-with-effective-settings, DJF/Dean-Jett applied-vs-not-applied settings staying in/out of the hash, unknown model/contaminant/ploidy keys rejected, changed DNA content producing a different result key (no cache reuse), the result key pinning version/config/bins/regions/masks/domain, and an unreviewed peak selection blocking the fit rather than being auto-accepted — all passing as part of `npm run test:unit`. Supplemented this session by two new e2e assertions in `tests/e2e/driving_code/tests_modeling.py` (both PASS, detail above): the unreviewed-restore-does-not-refit case and the version-drift-labels-recomputed_new case, closing the gap between the unit-level config-hash guarantees and an actual save/restore round trip through the UI.

**Review (2026-09-05):** Configuration hashing, request identity, frozen applied configuration and version-drift checks exist and pass. Restore ambiguities and input validation are separate STATE-02/03 defects.

**Recommendation:** Keep immutable fit inputs and add complete scientific provenance/version checks during restore.

### DOMAIN-01 — Visual viewport separated from scientific fit domain

**Priority:** P1

Per-fit coverage audit exists and is wired into every fit; `componentTailCoverage` is populated; display-only framing writes `axis_range_override`, never `analysis_domain_override` (`js/plotting/peak_focus_range.js`, `js/plotting/data.js`).

- [x] Persist domain, bin edges/count, underflow, overflow, and component tail coverage in result provenance. `fit_cell_cycle_model()` (`modeling_state.js:~549-570`) builds `result.histogramProvenance = { domain, binEdges, binCount, counts, underflow, overflow, binnedCount, retainedCount, componentTailCoverage }` on every fit — not opt-in. Verified against a real fit by `unit_tests_domain_sensitivity.py`: `"a real fit stores its exact domain, bin grid, and exclusion counts"` (binEdges.length === binCount+1, `underflow + binnedCount + overflow === retainedCount`, every phase has a finite `componentTailCoverage`).
- [x] Define warning/invalid thresholds for excluded observed events and modelled mass. `js/analysis/cell_cycle/domain_sensitivity.js`: `EXCLUDED_OBSERVED_WARNING_FRACTION`/`_INVALID_FRACTION` (0.5% / 5%) and `MODELLED_TAIL_WARNING_FRACTION`/`_INVALID_FRACTION` (2% / 10%), each with a rationale comment. `domainCoverageAudit()` applies them and is the **one and only** caller wired into the real fit path (`modeling_state.js:18,581` imports and calls it on every result); on `coverage.status === "invalid"` it sets `result.validForReporting = false` — a genuine block, not just a warning label. 6 passing tests in `unit_tests_domain_sensitivity.py` cover clean/warning/invalid boundaries for both the excluded-observed and modelled-tail halves, plus that the thresholds travel with the audit for display.
- [x] Sensitivity analysis across supported bin counts and reasonable domain perturbations. The sweep runs off the main thread: `fit_worker.js` gained a `"domain_sensitivity"` message type that runs the real `analyzeDomainSensitivity()` inside the worker, and `fit_client.js` exports `run_domain_sensitivity_in_worker()` mirroring `run_fit_in_worker()`'s dispatch pattern. `modeling_state.js` exports `assess_domain_sensitivity(row, result, options)`, which runs the sweep (worker-backed, with a synchronous main-thread fallback) against an already-completed result and folds the verdict in using the same qualify/block convention `domainCoverageAudit()` already uses (box 2), including a staleness guard (`FIT_INPUTS_CHANGED`) if a newer fit lands on the row mid-sweep. Unit-tested: `unit_tests_domain_sensitivity.py` — a real dean_jett fit through the real 12-variant worker sweep folds its verdict in correctly, and a concurrent newer fit provably invalidates an in-flight assessment without mutating the original result (16/16 in that module, plus `unit_tests_cell_cycle_worker.py` 7/7 confirming the new worker message type doesn't disturb the existing fit/cancel protocol). **Now wired to a concrete caller**, closing the previous "never invoked" gap: `modeling_ui.js` adds a "Check domain sensitivity" button (`#cell_cycle_domain_sensitivity_button`, `index.html`/`dom.js`/`hover_text.js`), shown only once a reportable result exists, whose click handler `on_check_domain_sensitivity_click()` calls the real `assess_domain_sensitivity(row, result)` and renders the returned (mutated) result. E2E-verified end-to-end (`tests_modeling.py`, `"Clicking Check domain sensitivity runs the real sweep and shows its verdict on the result"`): drives the actual button, waits on the real worker-backed sweep, and asserts the verdict (`ok`/`warning`/`invalid`), all 12 variants present, and the status-bar/status-line text match what the mutated result carries — exercising the full click-to-UI path, not the underlying function in isolation. `grep -rn "assess_domain_sensitivity" js/` now finds a real caller outside `modeling_state.js` itself.
- [x] Block or qualify results whose fractions/model choice exceed documented sensitivity tolerances. Closes together with box 3: the coverage-audit half already blocked in production (box 2's `validForReporting = false` wiring), and the sensitivity half's qualify/block verdict is now surfaced the same way through the same caller (`on_check_domain_sensitivity_click()`) — the status bar and a dedicated status line report the verdict, and an "invalid" verdict demotes `activeResultKey` to `lastDiagnosticResultKey` exactly as `assess_domain_sensitivity()` documents. The E2E test above independently confirms this by checking both possible result keys for the mutated result rather than assuming it stays under `activeResultKey`.

**Review (2026-09-05):** Histogram provenance and coverage audit are wired, and the sensitivity sweep now has a genuine on-demand production caller — a "Check domain sensitivity" button wired end-to-end and E2E-tested against the real worker sweep — that surfaces and applies its qualify/block verdict on screen.

**Recommendation:** Export the canonical histogram fields under FEAT-02.

### PEAK-01 — Calibrated or reviewed peak initialization

**Priority:** P1

- [~] Calibrate thresholds on independently annotated histograms; **do not present the confidence score as a probability** (it currently reads as one). — **presentation half closed, calibration half blocked on the same missing resource as QC-CAL-01.**
  - Presentation: `js/analysis/cell_cycle/peak_review_ui.js`'s `status_text()` formerly rendered `peakDetection.confidence` (a `clamp(0.45*score + 0.25*marginEvidence + 0.20*posteriorLike + 0.10*candidateFloor, 0, 1)` weighted heuristic computed in `peak_detection.js:507`, never calibrated) as `"${confidence}% confidence"` — a string that reads as a calibrated probability of correctness. Now formats it as `"heuristic score N/100, uncalibrated"` (no `%` sign, the word "uncalibrated" is explicit). `npm run test:unit`: 860/860, no regression — no test asserted the old `"% confidence"` string.
  - Calibration: **HUMAN HELP NEEDED** — doing this for real needs a histogram set with an independently annotated (human- or orthogonal-instrument-derived) correct/incorrect peak-pair label per case, so threshold choices can be scored against ground truth the detector did not produce. This project has none — the only "truth" available is the synthetic-fixture generator's own parameters (used below for box 3) and the 30-sample FlowJo comparison set (which records fitted means, not a peak-detector correct/incorrect verdict). Calibrating thresholds against either would be calibrating the detector against itself. **Cannot be done without that dataset — not attempted, per the same principle as QC-CAL-01.**
- [x] Fixtures for sub-G1 distractors, missing/weak G2, impulses, broad peaks, aneuploid peaks, weak S, and width fallbacks. — all seven categories have existing coverage; none needed to be authored from scratch:

  | category | coverage |
  |---|---|
  | sub-G1 distractor | `unit_tests_cell_cycle_peak_detection.py:105` `'a sub-G1 distractor peak does not beat the real G1/G2 pair'`; corpus: `watson_subg1_contamination` |
  | missing/weak G2 | `unit_tests_cell_cycle_peak_detection.py:143` `'a single visible peak reports inferred_g2 with the expected reasons'`; corpus: `arrest_g1_95_04_01` (tags `arrest, g1-arrest, low-g2, inferred-g2`) |
  | one-bin impulse | `unit_tests_cell_cycle_peak_detection.py:124` `'a one-bin impulse is downweighted and does not win a pair'` |
  | broad peaks / inflated sigma | `unit_tests_cell_cycle_peak_detection.py:265` `'PEAK-01: an inflated detector sigma cannot open the region past the cap'` and `:287` `'PEAK-01: a normal detection is left alone by the cap'` — already tagged PEAK-01 from a prior session |
  | aneuploid peaks | corpus: `ratio_nondiploid_1p50` (ratio 1.50, tags `ratio, aneuploid, constraint`) |
  | weak S | corpus: `truth_low_s_48_04_48` (tags `low-s, known-truth`); no isolated unit-level "weak S" test exists for `bridgeEvidence()` specifically, but the full-pipeline fixture exercises the scenario end-to-end |
  | three-peak x/2x/4x ambiguity, width fallback | `unit_tests_cell_cycle_peak_detection.py:157` `'a three-peak x/2x/4x pattern is reported, not silently forced to one confident answer'`; `chooseFallbackG1()` (`peak_detection.js:530`) is exercised by the single-visible-peak test above |

- [x] Measure and document detection sensitivity, specificity, ambiguity, and review rate. — measured headlessly (`peak_detection.js` has zero DOM dependencies — same as `js/fcs/parser.js` for SCI-07) against the synthetic corpus's 29 `LOAD_OK` fixtures that carry both `analysis.peak_regions.g1` and `.g2` (one fixture, `ratio_projector_regions_1_10_18_20`, excluded — it is a deliberate SCI-02 ratio-feasibility counterexample whose own manifest description states its region bounds do **not** bracket the real peaks, so its midpoint is not a legitimate ground truth here). Ground truth is the region midpoint: `generate_fixtures.py:488` builds `peak_regions.g1 = [g1_mean*(1-3.2*g1_cv), g1_mean*(1+3.2*g1_cv)]`, so the midpoint equals the true `g1_mean` exactly — the same correct-answer region already fed to `.fit()`, not invented for this measurement.

  ```
  n = 29 fixtures, tolerance = 5% relative error per peak
  status distribution:  detected=9   low_confidence=10   inferred_g2=10
  review rate (non-"detected")                     = 20/29 = 69.0%
  sensitivity (both peaks within 5%, among "detected") = 9/9 = 100.0%
  distractor-tagged cases (sub-g1/contamination/doublet) = 3, false "detected" pair among them = 0
  ambiguous (>=2 scored pairs, top-two score margin < 0.05) = 12/29 = 41.4%
  ```

  Every miss (3 of 29: `ratio_nondiploid_1p50` g2Err 18.2%, `tail_mass_clipped_domain` g2Err 5.7%, `truth_high_cv_overlap_35_45_20` g2Err 8.4%) falls in `inferred_g2` status, never in `detected` or `low_confidence` — in this sample the `"detected"` label is a reliable signal and every miss is already flagged for review by its own status. `ratio_nondiploid_1p50`'s miss has an identified mechanism: the `inferred_g2` fallback initializes G2 from `expectedRatio * g1` (default 2.0, `peak_detection.js:759`) when no pair scores high enough, so a genuinely non-diploid (ratio 1.50) sample is seeded from the wrong ratio by design — a documented limitation, not a bug to silently patch (patching it would mean guessing the true ratio, which is exactly the ambiguity AMBIG-01 already forbids attempting locally). Review rate (69%) is high because roughly a third of this corpus is deliberately adversarial/edge-case fixtures (QC failures, clipped domains, high-CV overlap) rather than clean detections — it should not be read as the rate on typical data.

  Measurement script: `peak_detection_eval.js` (session scratch directory, not committed — reuses the SCI-07 `benchmark.js`/`load_fixture.js`/`domshim.js` harness pattern; rerunnable by any future session against the same manifest).

**Review (2026-09-05):** Heuristic labels, reviewed initialization and adversarial fixtures remain; current units pass. No independent annotated calibration was added.

**Recommendation:** Calibrate detection scores/rates on independently annotated histograms; retain explicit review.


### GATE-02 — Critical uncertainty and ambiguity do not qualify displayed fractions

**Completed:** 2026-09-06T12:39:22-04:00

**Started:** 2026-09-06T12:35:07-04:00

**Priority:** P1

**Problem:** DJ/DJF map uncertainty warnings to `{id,severity,message}`, dropping `nonreportable`. `apply_result_contract` does not incorporate uncertainty/constraint warnings into scientific/reporting validity, and `fraction_trust_reason` only checks reporting validity and convergence. A converged rank-deficient fit can therefore display bare percentages.

**Review (2026-09-06):** Implementation follow-up: Contract v2 preserves uncertainty policy fields and qualifies critical, weak-identification, active-bound, constraint, degenerate-peak and single-peak-assumption warnings. Critical/error/`nonreportable` warnings make `scientificallyValid=false`; coherent fractions stay available with a warning under the existing reporting policy. Informational notes alone do not qualify numbers. Browser regressions cover contract → shared table/sidebar/TSV formatter → plot projection and text → JSON/CSV → TOML restore, including rejection of old contract stamps. Both acceptance boxes are now closed.

**Recommendation:** Closed. No further action; the warning-qualification policy is defined, machine-readable, and routed through every numeric consumer including CSV export and restore.

- [x] Retain and interpret material uncertainty, constraint, ambiguity and resampling warning fields at the shared contract boundary. This handles supplied warnings; production resampling remains unwired under UNC-01.
- [x] Test a converged weakly identified fit through table, sidebar, plot, TSV, JSON/CSV and restore, including visible non-colour qualifications. — Table/sidebar/TSV share one `format_fraction_cell()` formatter (SCI-05 box 1); table and sidebar are asserted byte-equal before/after restore in the same test, and TSV is proven identical by code trace rather than a literal restore-path assertion: `metadata_io.js`'s `metadata_export_columns()` reads the cell-cycle TSV cell verbatim off the same column that `update_cell_cycle_fraction_columns()` populates via `format_fraction_cell()`, adding only generic `tsv_cell()` escaping on top — no separate formatting logic exists for TSV to diverge on. `metadata_io.js` isn't loaded in the bare unit harness by design (it pulls in DOM-coupled `js/ui/*` modules, per `export.js`'s own comment), so a literal TSV-through-restore check would have to be an e2e test; accepted as a scope boundary, same pattern as STATE-04/05's open box (b). Plot and JSON were already covered by the real TOML restore/refit regression (`unit_tests_state_reproducibility.py`'s `STATE-02/SCI-05` test, an accepted inferred-G2/weakly-identified fixture). The remaining CSV gap (FEAT-02's 2026-09-05 probe: `result.curves` was never populated on a real fit, so CSV threw for every production export) is now fixed — the same test exports both JSON and CSV before and after restore and asserts `exportsMatch`, plus a dedicated `unit_tests_cell_cycle_export.py` check that the CSV's `qualification`/`warnings` columns carry the fit's real trust caveat and warning content (not just header labels), guarding against a regression that wires them to the wrong field or leaves them blank. All three surfaces plus restore are now covered, independently re-verified 2026-09-06 (25/25 passed, standalone rerun).


### STATE-02 — Session restore loses the reviewed single-peak assumption

**Priority:** P1

**Problem:** `get_modeling_session_state` saves regions and their reviewed flag but omits `peakDetection.status`. Restore refits those regions without restoring detection ambiguity; `model_preflight` reads that missing status to emit AMBIG-01’s warning. An accepted inferred-G2 guess can look confidently detected after reload.

**Review (2026-09-06):** Implementation follow-up: saved modeling now includes `peak_detection_status`; TOML writes it and the previously omitted `model_version`. Restore attaches detection origin before preflight/refitting and clears any prior workspace detection. The review panel does not invent a score for restored status. A browser regression uses the real collector → TOML writer/parser → cleared pipeline → modeling restore/refit, compares exact fractions/warnings and table/plot text, and exercises actual model-version drift. Older sessions cannot recover omitted detection provenance. Restore drift checks now also compare the analysis implementation identity: `core.js` stashes the saved session envelope's `source_commit` (`PHASEFINDER_SOURCE_COMMIT`, already recorded at save time) alongside the pending modeling restore and threads it into `apply_modeling_session()`, which now flags `implementationDrifted` independently of `versionDrifted` — a code change with no version bump, or vice versa, are each reported with a distinct warning (`implementation_drift`/`model_version_drift`/`model_and_implementation_drift`) naming the actual cause(s). A session saved before this field existed (`savedSourceCommit` null) never spuriously reports implementation drift. A real TOML round-trip regression (`unit_tests_state_reproducibility.py`) serializes/parses a session with a synthetic mismatched `source_commit` and asserts the drift is attributed correctly and independently of the model-version signal. Independently re-verified 2026-09-06 via a standalone Playwright run of `unit_tests_state_reproducibility.py` in isolation (14/14 passed, including this new test).

**Recommendation:** None outstanding for this item; STATE-02 is closed.

- [x] Round-trip an accepted `inferred_g2` fit through real session import and preserve its assumption/warning. `unit_tests_state_reproducibility.py` exercises TOML and `apply_modeling_session` with a fresh fit, not a cloned result. File reconnection/outer import UI is covered separately by production smoke; the warning regression starts with connected events.
- [x] Audit serialized gate fields for restore consumers and record recomputation explicitly. Manual `scatter_gates` inputs are reapplied. `singlet_gates` stores derived diagnostic transforms and is regenerated when the restore caller reruns saved QC filters (`core.js` → `apply_saved_qc_filters`; `pulse_geometry_gate.js` fits the transform). Documented in the session collector and scientific contract.
- [x] Version scientific behavior changes and make restore drift checks include the analysis implementation identity, not only unchanged model version strings. `js/session/modeling_session.js`'s `apply_modeling_session()` now accepts `savedSourceCommit` and computes `implementationDrifted` (saved vs. current `PHASEFINDER_SOURCE_COMMIT`) alongside `versionDrifted`, with distinct warning codes/messages per cause and `result.reproduction`/`drifted[]` entries carrying both signals separately. `core.js` threads the saved commit from the session envelope through `run_modeling_restore()` into the restore call. Covered by a real end-to-end TOML round-trip test asserting the implementation-only-drift case is correctly distinguished from a model-version bump.


### STATE-03 — Nested session modeling records bypass schema validation

**Completed:** 2026-09-06T12:39:22-04:00

**Started:** 2026-09-06T12:35:07-04:00

**Priority:** P1

**Problem:** `session_schema.js` checks modeling collections are arrays but does not validate their entries. `modeling_session.js` dereferences `sample.name` in a filter before its per-sample guarded restore loop. Invalid entries can throw after other session state has already changed.

**Review (2026-09-05):** The real schema accepts a minimal session with `modeling: { samples: [null] }`. Static restore trace confirms the unguarded dereference.

**Recommendation:** Validate nested records, finite region/settings values, enum and waiver structures before applying any session mutations. Reject malformed input with an actionable error and preserve the previous session.

- [x] Reject null/malformed samples and gate/waiver records at the schema boundary. — `js/session/session_schema.js`: new `modeling_records(modeling)` validates every entry of `modeling.samples`/`scatter_gates`/`singlet_gates` (non-object/null rejection, unique nonempty `name`, finite region/geometry fields, ordering constraints, enum checks on `ratio_mode`/`cv_mode`/contaminant fields, and `qc_waivers`/`qc_acknowledgements` JSON-string shape), called from `validate_session_draft()` before `clone_and_freeze()`. `js/session/core.js`'s `restore_session_transaction()` calls `prepare_session_draft()` (which runs this validation) before any restore stage touches session state, and is now exported specifically so a test can drive the real path.
- [x] Add a real import regression showing malformed nested data cannot partly replace the active session. — `tests/unit/driving_code/unit_tests_session.py`: 10 `schema.validate_session_draft()` rejection cases (null sample, nonfinite region, reversed regions, invalid enum, invalid waiver/acknowledgement/stage, null scatter gate, bad singlet geometry, duplicate sample) plus a new end-to-end regression driving `sessionCore.restore_session_transaction()` directly with `modeling.samples: [null]`, asserting the import throws mentioning `modeling.samples[0]` and that `get_restore_summary()` is byte-identical before and after (session left untouched). Independently re-verified 2026-09-05 via a standalone Node ESM run of the same 10+1 cases against the real module.


**Review (2026-09-06):** Also verified malformed TOML through the actual Load button/file chooser: an invalid nested sample is rejected with its field path, while the complete collected session (excluding its generated timestamp) remains unchanged.

### STATE-04 — OPFS worker swallows file commit failures

**Completed:** 2026-09-06T12:42:27-04:00

**Started:** 2026-09-06T12:35:07-04:00

**Priority:** P1

**Problem:** `write_file_to_opfs` returns the digest from its try block, then catches and ignores every `writable.close()` error in finally. A quota/disk commit failure can be followed by `{ok:true}` although the cached file was not committed.

**Review (2026-09-06):** Fixed in `js/session/copy_worker.js`: `writable.close()` moved inside the try block so a close rejection now propagates as a real error instead of being swallowed by the old `finally { try { await writable.close(); } catch(_) {} }`. On any failure the worker aborts the writable and removes the partial OPFS entry before rethrowing. Verified via a new box-(a) test in `tests/unit/driving_code/unit_tests_session.py`: the real `copy_worker.js` module is run inside an actual dedicated `Worker` (built from a `Blob`, with a faked `navigator.storage.getDirectory` installed before import so a real worker message channel is exercised rather than a reimplementation) with a writable whose `close()` rejects after a successful `write()`; asserts the response is `{ok:false, error: /Quota exceeded/}`, never a cached-success, and that `write`/`close`/`abort`/`removeEntry` all fired in order. Independently re-run standalone (bypassing the full runner): 61/61 passed, 0 failed, no regressions to the pre-existing SES-01/02/03/04, STATE-03, SEC-01 tests in the same suite.

**Recommendation:** Keep both the injected commit-failure test and browser-enforced quota/retry regression. Reset/eviction and changed-file reconnection remain separate STATE-05 requirements.

- [x] Inject a writable whose writes succeed and close rejects; require an error response and no cached-success catalogue entry. Evidence: `js/session/copy_worker.js` (`close()` inside try, error propagates, partial file removed) + new Blob-backed real-Worker test in `unit_tests_session.py`, independently re-run 2026-09-06 (61/61 passed).
- [x] Exercise a browser storage/quota failure and verify reconnect/recovery messaging. `priority_batch_checks.py` uses Chromium’s actual 1 KB origin quota with a 1 MB synthetic file and no worker/storage mocks: caching fails, no success is catalogued, loaded bytes remain available, and the status bar explains that analysis remains available. Removing the quota and retrying succeeds and catalogues the file. The separate injected-close regression covers commit-after-write failure cleanup.


### STATE-05 — Cache reset and eviction recovery lack a verified lifecycle

**Priority:** P1

**Problem:** Save waits for cache idle, but Reset and cache-clear actions do not consistently cancel/drain queued writes before deletion. Cleanup errors are ignored on paths that clear catalogue state or reload, so pending writes or failed deletion can leave owned data behind. Agency AUDIT-014’s live eviction/reconnect drill is also missing.

**Review (2026-09-06):** Implemented in `js/session/file_cache.js`: `cancel_pending_cache_writes()`/`drain_cache_queue()` drop queued-but-unstarted entries immediately and abort (via `AbortController`) whichever copy is in flight, marking it `uncached`; wired into Reset and all three cache-manager clear buttons. `run_cache_queue()`'s loop body is now wrapped in `try { ... } finally { cache_running = false; ...; cache_idle_waiters flush }` — fixes a real bug found while validating this box: an unguarded `set_status_bar()` call could throw (e.g. no `#status_bar_message` element) and permanently strand `cache_running = true`, hanging every future `wait_for_cache_idle()`/`drain_cache_queue()` caller forever; the status-bar call is now routed through a `report_cache_progress()` wrapper that swallows failures from that purely-informational call without touching queue control flow. `core.js`'s `release_active_session_cache()` (Reset path) already reports `{results, failed, all_removed}` per entry. Verified via two new tests in `unit_tests_session.py`: (1) queue three large files, immediately call `cancel_pending_cache_writes()`+`wait_for_cache_idle()`, assert the two still-queued entries are `uncached` with no catalogue/OPFS residue and the in-flight one is either genuinely completed or cleanly cancelled with no partial file left behind; (2) catalogue a phantom cache entry whose OPFS file was never written, call the real `release_active_session_cache()`, assert `all_removed === false`, the phantom path appears in `failed`, and its cache-index entry is left with zero owners and a `cleanup_failed_at` marker rather than being reported as removed. Independently re-run standalone: 61/61 passed, 0 failed.

**Recommendation:** Box (a) is closed. Box (b) (AUDIT-014's live cache-clear/eviction drill against real browser storage) has not been attempted — it needs genuine live browser-storage manipulation (forcing real quota eviction or manually clearing site data mid-session), not a quick unit/E2E test, and is left open as a larger follow-up rather than a human-blocked item.

- [x] Add failure-injection coverage for pending writes and denied deletion; assert reset cannot falsely report all owned data removed. Evidence: `js/session/file_cache.js` (`cancel_pending_cache_writes()`/`drain_cache_queue()` + `run_cache_queue()` try/finally fix) + two new tests in `unit_tests_session.py`, independently re-run 2026-09-06 (61/61 passed).
- [ ] Perform AUDIT-014’s live cache-clear/eviction drill and document recovery with matching and changed file contents.


---

# Section 4 — UI, UX, and accessibility

> Ordered by user impact. Items 1–2 are the ones with **scientific** consequences: they cause a reader to trust a number they should not.

### UI-01 — The trust hierarchy is inverted

**Completed:** 2026-09-05

**Priority:** P0 · **Effort:** ~1 day · **Source:** visual audit + code

**Problem (as found):** The result panel renders the phase percentages *larger and darker* than the caveats that qualify them. Verified in `css/plot.css:1098-1161`:

| element | size | colour |
|---|---|---|
| phase percentages | `0.78rem` | `var(--text)` |
| convergence status, fit-quality score, warning count | `0.72rem` | `var(--muted)` |

A poor fit and a perfect one differ only by a small grey-to-red shift. The `goodnessOfFit` explanation lives solely in a `title` attribute — unreachable by keyboard or touch. Separately, `index.html:247` is `<div id="cell_cycle_fit_result" …>` with **no `role`, no `aria-live`, no heading**, so screen-reader users get silence when a fit completes.

- [x] Invert the emphasis: the qualifier must be at least as prominent as the number. — `.cc_qualifier` is `0.78rem`/`600`/`var(--text)` (`css/plot.css:1362-1366`), which is the phase-percentage size, not the old `0.72rem`/`var(--muted)`; the comment on `:1363` states the invariant so it is not silently reduced later. `--warn` and `--fail` go to weight `700` on top of that. The rendering side never emits the pre-existing `.cell_cycle_fit_not_converged` / `.cell_cycle_fit_has_warnings` modifiers on these elements (`modeling_ui.js:353-362`): those are compound selectors at specificity (0,2,0) and would outrank the new single-class `.cc_qualifier--warn/--fail` (0,1,0) whatever the source order — a fix that would otherwise have looked applied and had no effect.
- [x] Move the goodness-of-fit explanation out of `title=` into visible, focusable content. — now a `<details>`/`<summary>` disclosure (`modeling_ui.js:396-397`). The `<summary>` carries `tabindex="0"` explicitly because `base.css`'s `:focus-visible` ring selector lists tags and `<summary>` is not among them, so without it the control would be reachable but show no focus indicator.
- [x] Add `role="status" aria-live="polite"` and a heading to `#cell_cycle_fit_result`. — `index.html:259` carries both; the heading is `<h3 class="visually_hidden">Cell-cycle fit result</h3>`, injected as the first child of the rendered panel (`modeling_ui.js:404`), so it names the region for a screen reader without changing the visual design.
- [x] Carry the state with the number wherever it appears — table, sidebar, plot legend, TSV. — `format_fraction_cell()` (`cell_cycle_columns.js:109-113`) is the single producer, and it puts the `⚠` in the **text content** rather than a CSS `::before`, so the marker survives copy/paste, TSV, and screen readers. It shipped delegating its precedence to `fraction_trust_reason()` (`result_contract.js:593-597`) instead of inlining the two conditions as sketched below, so the glyph surfaces and the worded surfaces cannot drift:

  | surface | path |
  |---|---|
  | file table | `cell_cycle_columns.js:187` |
  | sidebar readout | `modeling_ui.js:337-339` (`render_fraction_value()` re-wraps the same trailing glyph in `.cc_value_flag`) |
  | TSV export | the derived column value already contains the glyph; `metadata_io.js:479` passes it through `format_cell_cycle_value()` |
  | SVG `<desc>` + "Plot data and analysis summary" | `analysis_text()` (`render.js:129-138`) — no CSS class is possible on these, so it spells the caveat in words from the same `fraction_trust_reason()` call |

  **There is no plot legend**: samples are identified by hovering their curve, stated at `render.js:1250` and `:893`. The surface the item named does not exist, and the two text surfaces that stand in for it are covered above. Both halves are held by test — `unit_tests_cell_cycle_fit_orchestration.py:84` (the projection must carry `validForReporting`/`converged` through undefaulted, which it previously dropped) and `:112` (the worded caveat must match the glyph, including `validForReporting` taking precedence over `converged`).

  The sketch below is what was proposed; the shipped version differs only in delegating precedence:

```js
// A bare percentage reads as authoritative. If the fit did not converge, or the
// contract refused it for reporting, the number must not appear naked in a
// column someone will paste into a paper.
function format_fraction_cell(result, fraction) {
  if (!Number.isFinite(fraction)) return format_cell_cycle_value(null, "");
  const text = `${(fraction * 100).toFixed(1)}%`;
  return fraction_trust_reason(result) ? format_cell_cycle_value(`${text} ⚠`) : format_cell_cycle_value(text);
}
```
- [x] Use a non-colour cue so the distinction survives greyscale printing. — three independent ones, so no single failure mode removes the distinction: the `⚠` glyph in the text itself; weight `700` plus a dotted underline on `.cc_qualifier--warn` and a 2px bottom border on `--fail` (`css/plot.css:1372-1385`); and a `forced-colors` block (`:2137-2149`) that keeps those borders visible when the UA replaces every author colour. The reasoning is recorded at `css/plot.css:1368-1371`.
- [x] **Closes SCI-03's UI item.** — SCI-03's first box ("show nonconvergence prominently in sidebar/table/export") is satisfied by the four surfaces above; **SCI-03’s corresponding box is checked.**

**Review (2026-09-05):** Implementation follow-up: Closed the cross-surface qualification gap in contract v2. `fraction_trust_reason` now includes material uncertainty and ambiguity warnings, constraint failures and scientific/reliability flags. The plot adapter preserves those flags; the table/sidebar/TSV formatter and HTML/PDF report use the same helper. Percentages remain numerically unchanged and carry a text warning marker or worded caveat. Regression coverage includes critical uncertainty, weak identification, active bounds, violated constraints, degenerate peaks, inferred G2 and informational-only notes.

**Recommendation:** Keep the shared qualification policy. Complete the separate CSV and actual session-restore acceptance coverage under GATE-02, FEAT-02 and SCI-05.

### UI-02 — Bulk-fit failures are misattributed to the user

**Priority:** P1 · **Effort:** ~2 hours · **Verified**

**Problem:** `modeling_ui.js:583` and `:663` hard-code the reason `"User cancelled bulk fitting"` on cancellation paths regardless of actual cause. The resulting summary reads *"0 converged/reportable; 0 computed but did not converge; 0 detection failed; 0 fit failed; 3 cancelled; 0 skipped"* — five of six terms are zero and the sixth is wrong. (`:700` does distinguish aborted from not-reached; this is two paths, not three.)

- [x] Pass the real cause through each cancellation path.
- [x] Suppress zero-valued terms from the summary sentence; report only what happened.
- [x] Test: a QC-blocked bulk fit must not report "user cancelled".

**Review (2026-09-05):** Distinct cancellation phases and zero-term suppression exist; orchestration units covering QC-blocked and genuine cancellation pass.

**Recommendation:** Retain reason-specific summary tests.

### UI-03 — `--border` fails non-text contrast

**Priority:** P1 · **Effort:** ~0.5 day · **Verified by computation**

**Problem:** `css/base.css:13` — `--border: #d9dee8`. Against white that is **1.35:1**; WCAG requires **3:1** for control boundaries. Every bordered control in the app is under-delineated. Additionally `test_contrast_tokens.py` only checks text tokens against `--panel` — never `--bg`, `--th_bg`, or `--accent_soft`, and never component boundaries.

- [x] Darken `--border` to meet 3:1 and re-check every surface it sits on. — `#7386aa` at `css/base.css:24` and `css/help.css:16`; checked against all four surfaces (`--panel`, `--bg`, `--th_bg`, `--accent_soft`) by the test below rather than by eye.
- [x] Extend `test_contrast_tokens.py` to all surface tokens and to component boundaries. The expanded test in the visual audit **currently fails on three real pairs** — land the test with the fixes. — `tests/ci/test_contrast_tokens.py` now sweeps `SURFACES` × semantic text tokens (`:73`) and `BORDER_TOKENS` = `border`, `dropzone_border`, `progress_track_border` at 3:1 (`:88`, `:100`). The three failing pairs were all boundary tokens and all three are fixed. `test_pre_ui03_tokens_would_have_failed` (`:114`) pins the *old* values as failing, so the suite proves it would have caught the original defect instead of merely passing on the new one.

**Review (2026-09-05):** Current light-theme contrast token tests pass across the declared surfaces.

**Recommendation:** Keep boundary contrast tests when tokens change; dark palette still requires UI-12 validation.

### UI-04 — `forced-colors` support stops at the shell

**Priority:** P1 · **Effort:** ~1 day · **Verified**

**Problem:** `forced-colors` blocks exist in `css/base.css` (1) and `css/help.css` — and nowhere else. Counts: `sidebar.css` 0, `table.css` 0, `layout.css` 0, `plot.css` 0. So the shell adapts to Windows High Contrast and the table, sidebar, modals, and plot chrome do not. `focus-visible` is uneven too: `feedback.css` has **0**.

- [x] Add `forced-colors` blocks to `sidebar.css`, `table.css`, `layout.css`, `plot.css` covering borders, focus rings, and colour-only state. Copy the pattern at `help.css:582`. — Counts are now `sidebar.css` 2, `table.css` 2, `layout.css` 2, `plot.css` 4 (each was 0), plus `feedback.css` 4, found to be 0 during the same sweep and not in the original list. `responsive.css` stays at 0 by design — it declares breakpoints only and sets no colour. Enforced by `test_forced_colors_blocks_cover_every_stylesheet` (`tests/ci/test_contrast_tokens.py:140`), so the counts cannot silently fall back to 0.
- [x] Give `table.css` and `feedback.css` real focus-visible treatment. — `table.css` 6 rules, `feedback.css` 4 (was 0; the status-bar footer's own `overflow: hidden` clipped the global `base.css` ring, so inheriting it was not sufficient). Pinned by `test_feedback_css_has_focus_visible_treatment`.
- [x] **Closes the remaining UI-19 items.** — Additionally, `test_gate_state_forced_colors_border_styles_stay_distinguishable` (`:151`) covers the AD-3 case: all six `GATE_STATES` must stay distinguishable once forced-colors flattens colour, so QC-02's fix does not silently regress for high-contrast users. The forced-colors block restates the solid/dashed split explicitly.

**Review (2026-09-05):** Forced-colors and focus-visible CSS exist; contrast/state tests pass. Manual assistive-technology acceptance remains UI-14.

**Recommendation:** Retain structural tests and finish manual accessibility review.

### UI-05 — Verify reflow and control reachability at 200% zoom

**Priority:** P1 · **Effort:** ~0.5 day · **Source:** visual audit

**Problem:** The historical screenshots warrant a current reflow/reachability check. A narrow responsive layout at 200% zoom is expected and is not itself an accessibility defect; clipping, inaccessible controls or unnecessary two-dimensional page scrolling would be.

- [x] Verify at 320 / 390 / 768 / 820 / 1024 and at 200% zoom. — `tests/e2e/driving_code/tests_sidebar.py`'s `test_responsive_reachability` already swept 320×568/375×600/390×844/844×390/768×600/820×1180/1280×500; a new `(1024, 768)` entry closes the last gap in the listed widths. A new 200%-zoom block (viewport 1280×800, `document.documentElement.style.zoom = '2'`) checks the same six major controls (`#reset_session_button`, `#drop_zone`, `#plot_panel_toggle`, `#metadata_panel_toggle`, `#cell_cycle_modeling_button`, `.status_bar_help a`) stay in-viewport, focusable controls actually take focus, and `document.documentElement.scrollWidth <= innerWidth + 1` (no forced horizontal scroll), then resets zoom in cleanup. Independently reran via a standalone Playwright script (bypassing `drive_flow.py`, reserved for the batch-of-5 gate) driving real `test_file_loading` → `test_plotting` → `test_responsive_reachability`: 53/53 passed, including the new 1024×768 and 200%-zoom checks. (An initial reproduction attempt without a wall-clock gap between `test_plotting` and `test_responsive_reachability` spuriously failed 7 checks — `#progress_overlay` briefly still covers the viewport for ~1–2s after plotting in a minimal harness that skips the intervening groups the real 15-group suite runs; adding a 2s wait, matching that natural gap, reproduced a clean pass and confirmed this was a harness-timing artifact, not a regression. Two unrelated failures — the metadata wizard not auto-opening and blank filename-annotation columns — are the already-tracked stale-E2E-expectation gap under UI-06/TEST-01, not new.)
- [x] Add a second breakpoint if the metadata table or sidebar demands different treatment at phone vs tablet width. — No clipping or unreachable-control defect was reproduced at any tested width (320 through 1280) or at 200% zoom, so the conditional does not trigger; no second breakpoint is warranted by evidence.
- [x] Ensure content and controls remain reachable at narrow CSS viewport widths and 200% zoom; change breakpoints only when a reproduced defect warrants it. — Confirmed by the same test and independent rerun above: all six major controls stay within the viewport, remain focusable, and induce no horizontal page scroll at 200% zoom; no defect was reproduced, so breakpoints are unchanged.

**Review (2026-09-06):** All three acceptance boxes are closed. `test_responsive_reachability` now covers every listed width (320/375/390/768/820/1024/1280 plus the two landscape/short-height cases already present) and adds a genuine 200%-zoom reachability + no-horizontal-overflow check with real `bounding_box()`/`focus()` assertions, not visual inspection. Independently re-verified with a standalone script driving the real page (53/53), after ruling out a harness-timing artifact (see box 1) as the cause of an initial spurious failure set.

**Recommendation:** Closed. No further action; revisit only if a future width/content change reproduces a real clipping or reachability defect.

### UI-06 — The metadata wizard auto-opens and steals focus

**Priority:** P2 · **Effort:** ~1 hour · **Verified**

**Problem:** `js/ui/metadata_wizard.js:451` — `window.setTimeout(() => open_metadata_wizard(), 750)` fires a blocking modal 750 ms after the first file load, interrupting the user mid-orientation and taking focus.

- [x] Replace the auto-open with a visible, dismissible affordance the user chooses to activate. — The `setTimeout` is gone. `schedule_metadata_wizard_after_file_load()` (`js/ui/metadata_wizard.js:469`) now only writes a non-blocking status-bar hint, once per session, pointing at the always-available "Configure filename metadata columns" toolbar button (`metadata_parse_button`, wired in `main.js`) — that button is the affordance the user chooses to activate.
- [x] If retained, never steal focus, and never fire while the user is mid-interaction. — Not retained; nothing opens the modal without a click. The replacement takes no focus and is suppressed entirely once `TABLE_COLUMNS.length > 1` (metadata already configured).

**Review (2026-09-05):** Wizard now writes a non-blocking status affordance; E2E test 4 still expects automatic opening.

**Recommendation:** Keep intentional user-triggered opening and repair the stale E2E setup under TEST-01.

### UI-07 — Axis-range editing is only reachable by a hidden double-click

**Priority:** P2 · **Effort:** ~2 hours · **Verified**

**Problem:** The plot toolbar has exactly six buttons — camera, pan, zoom in, zoom out, autoscale, home. **None opens the axis dialog.** `axis_modal.js:244` opens it from a custom event dispatched by double-clicking invisible SVG hit areas. This matters more than usual here because the axis range can be promoted to the **scientific analysis domain**, so a hidden gesture changes what gets modelled.

- [x] Add a toolbar button: — shipped at `index.html:338`.
```html
<button id="plot_tool_axes" class="plot_tool quick_tooltip" type="button"
        data-tooltip-key="plotToolAxes" aria-label="Set axis ranges"
        aria-haspopup="dialog">…</button>
```
- [x] Register in `js/ui/dom.js` (`npm run check:dom` fails until you do); wire to `open_axis_range_modal()`. — `index.html:338` carries the markup, `js/ui/dom.js:82` registers it, `js/plotting/plot_toolbar.js:90` wires the click to `open_axis_range_modal()`. The registration deliberately lives in `ui/dom.js` rather than `plot_toolbar.js` (AD-1, commented at `plot_toolbar.js:20`).
- [x] Keep the double-click as a shortcut. **Closes UX-06.** — Retained at `js/plotting/plot_viewport.js:465`; the toolbar button is an addition, not a replacement.

**Review (2026-09-05):** `plot_tool_axes` exists, is registered and opens axis editing; current toolbar has seven tools.

**Recommendation:** Retain both accessible button and shortcut; repair the six-tool E2E expectation.

### UI-08 — Fit buttons sit below the fold with no affordance

**Priority:** P2 · **Effort:** ~2 hours · **Source:** visual audit

**Problem:** Model & Fit begins 775 px into an 802 px scroll container, so the fit buttons are below the fold with no scroll indication. (This is the residual half of UX-08; the ambiguous button *labels* were already fixed.)

- [ ] Add a scroll affordance, or restructure so the primary action is reachable without discovering the scroll.

**Review (2026-09-05):** Primary fit actions remain in the scrollable modeling sidebar; a dedicated reachability acceptance check is absent.

**Recommendation:** Confirm the problem at supported viewports and add an affordance or reposition the actions only if needed.

### UI-09 — Detect Peaks reports success with empty region fields

**Priority:** P2 · **Source:** visual audit

- [x] Reproduce, then either populate the four sidebar fields on success or report the real outcome.

**Review (2026-09-05):** Current E2E “Sidebar region inputs reflect detected regions and are enabled” passes and compares all four controls to real state.

**Recommendation:** Retain this end-to-end regression.

### UI-10 — "Run All" does not run all

**Priority:** P2 · **Source:** visual audit

**Problem:** "Run All" opens a configuration modal at step 2 and stops.

- [x] Either run the remaining gates after configuration, or rename to reflect what it does.

**Review (2026-09-05):** `pipeline_ui.js` Run All configures and then activates all gates and awaits `apply_qc_selection`; current QC-flow E2E checks pass.

**Recommendation:** Retain the sequential configuration → execution behavior and test.

### UI-11 — Row-selection checkboxes are 17 px

**Priority:** P3 · **Effort:** ~15 minutes

- [x] Raise to a ≥24 px target (WCAG 2.2 target size), preserving row density. — `css/table.css:145` sets 24×24. Row density is genuinely unchanged: the comment at `:134` records that the row's other content already forces a taller line box, so growing the checkbox from 17 to 24 px does not move row height at all.

**Review (2026-09-05):** Table selection hit targets are 24×24 in `css/table.css`; existing acceptance remains satisfied.

**Recommendation:** Preserve target size while changing table density.

### UI-12 — No dark theme; the OS preference is overridden

**Priority:** P2 · **Effort:** 1–2 days · **Blocked on UI-03**

**Problem:** `css/base.css:6` declares `color-scheme: light` and there is **zero** `prefers-color-scheme` handling in any app stylesheet. No theme control, no stored preference. Flow cytometry is frequently read in a darkened room next to the instrument.

- [ ] Define dark tokens as overrides only, so token-consuming components follow for free:
```css
:root { color-scheme: light dark; /* …existing light tokens unchanged… */ }

@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) { /* dark token overrides */ }
}
:root[data-theme="dark"] { /* same overrides — explicit choice wins both ways */ }
```
- [ ] **Re-validate the plot component colours.** `DJF_G1_COLOR`, `DJF_S_COLOR`, `DJF_G2_COLOR` in `js/plotting/data.js` read CSS custom properties with hard-coded fallbacks chosen against white; they must be re-checked for contrast against a dark surface, not merely inherited.
- [ ] Add a Light / Dark / System control; persist explicit choice; follow live system changes in System mode.
- [ ] Extend `test_contrast_tokens.py` to run in **both** themes, or dark ships unverified.
- [ ] Recompute the proposed dark palette before adopting it: the design document’s `#38424f` border on `#161d28` does not meet 3:1. Treat the palette as a proposal, not verified acceptance evidence.

**Review (2026-09-05):** No complete dark token override or Light/Dark/System control exists. The proposed palette’s boundary claim is incorrect.

**Recommendation:** Recompute contrast, consolidate hardcoded component colors, then add tokens and preference control with both-theme tests (AUDIT-002/003/004).

### UI-13 — Residuals are computed and never displayed

**Priority:** P2 · **Effort:** ~1 day · **Closes the plan's "residuals visible by default" gate**

**Problem:** The live models expose expected counts, components and residual diagnostics, but there is no aligned residual strip in the plot. `fitResult.curves` is not a production field and `cell_cycle_fit_report.js` was deleted. Use the canonical result and its histogram provenance; the same field mismatch currently breaks FEAT-02.

- [ ] Build the residual strip beneath the histogram. Full design (layout, proportions, colour, narrow-width behaviour, accessible equivalent) is in the design document.
- [ ] Pearson-normalise by default — raw residuals scale with peak height, so the eye is drawn to G1 regardless of fit quality.
- [ ] Share the x-scale with the histogram so the strips align.
- [ ] Provide the accessible text equivalent (bins outside ±2, largest deviation).
- [ ] Register new ids in `js/ui/dom.js`.

**Review (2026-09-05):** No residual strip is rendered; the old issue cited nonexistent production fields and a deleted report module.

**Recommendation:** Render Pearson residuals from canonical counts/components on the shared x-scale, with an accessible summary.

### UI-14 — Remaining accessibility verification

**Priority:** P2

- [ ] UI-04 (ridge export): visual comparison fixture for overlay and ridge modes.
- [~] UI-05B (table selection/sort): test with keyboard, accessibility tree, and at least one screen reader.
- [~] UI-05D (plot equivalent): accessibility-tree assertions for empty, histogram-only, and modeled plots. *(Chromium already asserts real SVG accessibility snapshots.)*
- [ ] UI-14 (exports): equivalent content in SVG/PDF/PNG/JPEG for overlay and multi-row ridge; oversized output, failure, cancellation, repeated click, keyboard controls.

- [ ] Record a CVD/greyscale review of sample and model-component distinctions. Existing dash patterns are implemented, but do not establish perceptual acceptance (AUDIT-005).

**Review (2026-09-05):** Keyboard/Chromium accessibility snapshots exist; full screen-reader, export visual and CVD acceptance is not recorded.

**Recommendation:** Complete those acceptance checks and save evidence; automated snapshots alone do not establish accessibility.


---

# Section 5 — Performance

### PERF-01 — Fit cancellation is not real; canonical fits can run on the UI thread

**Priority:** P2 · **Source:** PERF-MODEL-01 + FE-009

**Problem:** `fit_client.js` documents "caller falls back to the main thread" when no worker is available, so a canonical scientific fit can silently run on the UI thread. Cancellation is not cooperative.

- [ ] Yield cooperatively between solver iterations, or use a terminable worker per active fit.
- [x] Request-generation tokens so cancelled/stale worker results cannot activate.
- [ ] Never silently run canonical fits on the main thread — expose a worker-unavailable state, or a strictly bounded reviewed fallback.
- [~] Cache quadrature nodes and parameter-independent bin quantities.
- [ ] Evaluate analytic derivatives / AD **only after** the transformed parameterization is validated.
- [ ] Cancellation-latency, worker-failure, UI-responsiveness, stale-result, runtime, and memory benchmarks.
- [ ] Assert optimized and reference expected counts/objective/parameters/fractions stay within strict tolerances.

**Review (2026-09-05):** Generation/revision/histogram guards reject stale fits; quadrature nodes are cached. Synchronous worker fitting cannot receive cancellation until it yields, and main-thread fallback remains.

**Recommendation:** Use terminable workers or cooperative iteration; retain request guards and benchmark latency before optimizing math.

### PERF-02 — Profile before optimizing table and plot interactions *(was PERF-UI-01)*

**Priority:** P3

- [ ] Representative fixtures: many files, long metadata, large event counts, ridge plots, repeated model overlays.
- [ ] Measure initial load, table rerender, filter/sort, plot redraw, pan/zoom frame time, bulk fit, export, memory.
- [ ] **Only if** table rerender dominates, introduce keyed row updates or virtualization — without breaking focus, selection, filters, or accessibility.

- [ ] Record local fit/decode timings and a measured file/event/rendering ceiling; parser `parse_ms`, plot counters and the 10,000-point scatter-preview cap are useful instrumentation, not a full interaction benchmark (AUDIT-006/007).

**Review (2026-09-05):** Some parse/plot timing exists and scatter preview is capped; no representative end-to-end performance ceiling is documented.

**Recommendation:** Profile the listed workflows locally before selecting an optimization.


### WORKER-01 — CLOCCS worker cannot reliably recover after an error

**Priority:** P2

**Problem:** `cloccs_client.js` rejects pending requests on worker error but retains the failed worker instance. A later call reuses it. `run_cloccs_fit` also inserts a pending request before an unguarded `postMessage`, so synchronous clone/post failures can leak pending state.

**Review (2026-09-05):** Static trace of `ensure_worker` and `run_cloccs_fit`; the unverified CLOCCS feature is not a release-ready joint-series path (FEAT-04).

**Recommendation:** Terminate and clear a failed worker; remove/reject requests when posting fails. Recreate on the next explicit request.

- [ ] Inject worker failure followed by retry and require a fresh worker with a settled result/error.
- [ ] Inject synchronous postMessage failure and verify no pending-request leak.


---

# Section 6 — Release, build, and privacy

### REL-01 — Cloudflare release execution

**Priority:** P0

The workflow now deploys `dist` (never `.`), is fail-closed behind `ENABLE_PRODUCTION_DEPLOY`, has `environment: production` and a concurrency group, and `public/_headers` carries a strict self-only CSP that `verify-dist.cjs` validates by hash.

- [ ] `workflow_dispatch` against a **staging** Pages project; inspect the deployed file list and response headers (confirms Pages honours `_headers`). *Also closes PRIV-02's artifact check.*
- [ ] Publish a **test release**; verify public URL, Help link, panel icons, web manifest, worker-based FCS parsing, one model fit.
- [ ] Record the last known-good **deployment identifier** in `docs/release-and-privacy.md` beside the existing rollback procedure; exercise a rollback on staging. *Also closes PLAT-01.*

- [ ] Provide a staging deployment route before attempting the dispatch acceptance step: the current release workflow’s manual dispatch previews release notes; it does not deploy to staging or build the requested tag automatically.

**Review (2026-09-05):** Release dispatch currently previews notes, so a staging route is missing in addition to account-side release evidence.

**Recommendation:** Implement the staging/artifact verification route, then execute smoke and rollback with the release owner.

### REL-02 — `dist/` 404s on every page load

**Priority:** P1 · **Effort:** ~15 minutes · **Verified**

**Problem:** The built artifact fetches `./sessions/phasefinder_local.json` — the personal autoload config, correctly excluded from the build. The JS treats absence as silent *by design*, but the browser records a failed request and a console error on **every visit to the public site**. `verify-dist.cjs` cannot catch it because it is a runtime fetch, not a static reference.

- [x] Ship an inert stub so the probe gets `200 {}`: — `vite.config.js:58-64`.
```js
// Ship an inert autoload config so the startup probe gets 200 {} instead of a
// 404. Keeps the console clean without shipping anyone's personal session.
const autoloadStub = path.join(distDir, "sessions", "phasefinder_local.json");
fs.mkdirSync(path.dirname(autoloadStub), { recursive: true });
fs.writeFileSync(autoloadStub, "{}\n");
```
- [x] Make a session leak into `dist/` a **build failure** — this is the valuable half: — `scripts/verify-dist.cjs:13,39-40`; a non-empty stub throws, so `npm run check:dist` fails the build rather than shipping someone's session.
```js
assertExists("sessions/phasefinder_local.json", "startup autoload probe target");
const stub = JSON.parse(fs.readFileSync(path.join(DIST, "sessions/phasefinder_local.json"), "utf8"));
if (Object.keys(stub).length) {
  fail("dist/sessions/phasefinder_local.json must be an empty object; a real session leaked into the build.");
}
```
- [x] Also guard the content type in `try_autoload()` — a static host may answer a missing path with an HTML fallback. — `js/session/core.js:827-829` reads `content-type` and, when it is not JSON, skips the auto-load and says so in the status bar naming the status and the content type, so an HTML fallback page cannot be parsed as a session.

**Review (2026-09-05):** Production build, 44-file verification and dist smoke pass; inert session stub and content-type guard remain.

**Recommendation:** Retain empty-stub/content-type checks.

### REL-03 — The built HTML carries a dead importmap

**Priority:** P2 · **Effort:** ~30 minutes · **Verified**

**Problem:** `dist/index.html` maps `d3` → `./js/vendor/d3.min.js`, but `dist/` has no `js/` directory — Vite bundles d3 and rewrites every bare import (confirmed: no `from"d3"` survives). It is dead markup that forces a CSP `script-src` hash to exist for a script that does nothing.

- [x] Strip it at build time: — `stripImportMap()` at `vite.config.js:25-31`, registered in the plugin list at `:66`.
```js
// The importmap exists so the SOURCE tree runs unbuilt (bare "d3" -> vendored
// copy). Vite rewrites those imports and does not emit js/vendor/, so in the
// built HTML the map is dead markup pointing at a path that isn't there.
function stripImportMap() {
  return { name: "phasefinder-strip-importmap",
    transformIndexHtml: { order: "post",
      handler: (html) => html.replace(/\s*<script type="importmap">[\s\S]*?<\/script>/, "") } };
}
```
- [x] **Same commit**, drop the hash: `script-src 'self' 'sha256-QegS…'` → `script-src 'self'`. — `public/_headers:2` now reads `script-src 'self'` with no hash.
- [x] Flip `verify-dist.cjs` from "the declared hash matches the importmap" to "no inline script remains and script-src declares no hash". — `scripts/verify-dist.cjs:54` throws if an importmap survives the build; `:69-72` parses `script-src` and requires it to be exactly `'self'`, so a hash reappearing (whether the map came back or a new inline script was added) fails the gate.
- [x] **Atomic.** Removing the script while leaving the hash is harmless; removing the hash while leaving the script breaks production only. Verify with `npm run check:dist`. — Both halves are in the tree together and `npm run check:dist` passes. The two `verify-dist.cjs` assertions are mutually reinforcing: neither half can regress without the other's check firing.

**Review (2026-09-05):** Built importmap removal and CSP verification pass in the current dist build and smoke.

**Recommendation:** Keep build/CSP checks paired.

### REL-04 — Toolchain and fresh-clone verification

**Priority:** P1

- [ ] Verify a fresh clone runs `npm ci`, `npm test`, `npm run build`, `npm run preview` with no undocumented manual steps. *(Do this **before** the test release — cheapest way to find a missing committed file.)*
- [ ] Verify a fresh clone contains only synthetic examples and does not silently autoload a personal session.
- [ ] Record branch, commit, `git status --short`, Node, Python, and Playwright versions in the implementation PR (PREP-01).
- [ ] Build with the pinned Node version and archive a `dist/` path manifest for before/after comparison (PREP-01).

**Review (2026-09-05):** Pinned-node local build, non-root-base check and dist smoke pass. This is a dirty working tree, not a fresh clone, and no preview/clean-install matrix was rerun.

**Recommendation:** Repeat clean-clone installation and required matrix on the finalized commit; record exact artifacts and environment.


### PRIV-03 — Private fixture and reference paths are outside the privacy denylist

**Completed:** 2026-09-06T12:39:22-04:00

**Priority:** P1

**Problem:** `docs/tmp/` contains local reference PDFs but is not ignored. `check-privacy.cjs` scans tracked paths without denying that directory or private `external_fcs` payload directories; staging such files can evade the stated privacy guard. No publication occurred during this review.

**Review (2026-09-05):** Reviewed `.gitignore`, the three local PDF paths, and `scripts/check-privacy.cjs`. The current privacy check passes, which does not prove these paths cannot be published.

**Recommendation:** Ignore local reference/download paths and add narrow tracked-path rules covering private payloads while allowing reviewed manifests and licensed redistributable fixtures. Test the denylist using path strings, without copying private data.

- [x] Cover local reference PDFs and private biological payloads in ignore rules and the tracked-path publication guard. — `.gitignore` adds `docs/tmp/`; `scripts/check-privacy.cjs` adds a `privatePayload` regex denying `docs/tmp/` and `tests/validation/validation_test_data/external_fcs/{datasets,files,results}/` as tracked paths, independent of `fs.existsSync` so it also catches paths absent on disk (e.g. in CI).
- [x] Add positive/negative path-policy checks and document the reviewed exception process. — `tests/ci/test_private_payload_paths.py` (new): positive/negative path-policy regression feeding candidate paths to `scripts/check-privacy.cjs` via stdin, cross-checked against `git check-ignore`, asserting private paths are rejected while `manifest.json`, `LICENSE`, and licensed `synthetic_fcs` fixtures stay allowed. `docs/release-and-privacy.md` documents the reviewed-exception process for adding a new redistributable `external_fcs` fixture (provenance, license, privacy review, hash/oracle). Independently re-verified 2026-09-05: `sh scripts/python.sh -m unittest tests.ci.test_private_payload_paths -v` → `ok` (1 test).


---

# Section 7 — Testing and validation

### TEST-01 — Definition-of-done gaps *(was PREP-02)*

**Priority:** P1

Applies to every item in this document, not just testing.

- [ ] Existing source-tree unit and E2E tests pass without converting failures into warnings.
- [ ] Scientific result changes documented with expected tolerances and reviewed against an independent calculation where available.

**The rest of the shared definition of done is already satisfied** and is restated here so it is not lost: a regression test that fails on the audited behaviour and passes after; a clean-install Vite build; a `dist/`-served smoke suite including one model fit; new errors surfaced with actionable text rather than silent success; accessibility verified by keyboard and accessibility tree, not visual inspection alone; documentation and release notes updated with the code; no private session data, local paths, tool configuration, or generated build output staged.

- [x] Resolve the eight failures in the 2026-09-05 E2E run: wizard setup (4, 11, 21–24), toolbar tool count (50), and imported row count/order (219). Update obsolete UI expectations through the real user flow; investigate the import failure before classifying it as a test defect. — Investigated each individually rather than assumed; two distinct root causes. (1) Items 4/11/21-24 (wizard setup + the four filter-header tests that depend on it) share one cause: `configure_default_metadata_wizard_columns()` (`tests/e2e/driving_code/helpers.py`) assumed the wizard still auto-opened after UI-06 intentionally removed that `setTimeout` in favor of a status-bar hint pointing at the `#metadata_parse_button` toolbar button — the helper silently returned `False` and never configured Strain/Replicate/Nocodazole Arrest/Timepoint, so the columns those filter tests look for never existed. Fixed by adding the deliberate `page.click("#metadata_parse_button")` the new UI-06 flow requires, in `helpers.py`, with matching docstring/comment updates in `helpers.py`, `tests_io.py` and `tests_metadata_wizard.py` — stale test setup, not a production bug, corrected through the real user flow per UI-06's own recommendation. (2) Item 50 (toolbar tool count) is UI-07's intentional seventh `plot_tool_axes` button; `tests_plotting.py`'s hardcoded six-button list corrected to the real seven, in DOM order, per UI-07's own recommendation. (3) Item 219/224 (imported row order) is a genuine production bug, not a stale test: `import_metadata_records()` (`js/io/metadata_io.js`) calls `set_preserve_metadata_row_order(true)` but never cleared the module-level `sort_state`; `set_metadata_table_columns()`'s existing stale-sort pruning (`table_state.js`) only clears a sort whose field is no longer among the new columns, and the Filename column (`field: "name"`) is always present, so a sort set by an earlier header click survives any import indefinitely and silently overrides the imported file's own row order. Fixed by calling `set_sort_state(null)` right after `set_preserve_metadata_row_order(true)` in the import path, scoped to import only (the session-restore call site in `table_session.js` already has its own explicit saved-sort restore/clear logic at its own call site, so it does not share this gap). Independently verified: read all 5 diffs directly (`helpers.py`, `tests_io.py`, `tests_metadata_wizard.py`, `tests_plotting.py`, `js/io/metadata_io.js`) against the UI-06/UI-07 checklist evidence and the actual `table_state.js` pruning logic — all claims confirmed in the real source, not taken on the report's word. Reran the affected scope independently (not the reporting worker's own run): a standalone Playwright script driving the 7 affected groups (`libraries`, `file_loading`, `table_filtering_sorting`, `plotting`, `plot_toolbar`, `metadata_wizard`, `metadata_table_actions`) end-to-end against a live dev server — 115/115 checks passed, 0 failed, including all 8 originally-failing check names.

**Review (2026-09-06):** All 8 known E2E failures from the 2026-09-05 run are fixed/corrected and independently re-verified (115/115 in the affected scope). This closes the item's own named acceptance box. The broader "existing source-tree unit and E2E tests pass" box (box 1) is a whole-suite claim that still needs confirmation by the next full `drive_flow.py` run (due once 5 more items are fully closed, per this project's batch-validation rule — not run here as a single-item spot check) before it can be checked off; "scientific result changes documented with expected tolerances" (box 2) is untouched, unrelated to this pass.

**Recommendation:** Box 3 closed. Confirm box 1 (whole-suite pass) at the next scheduled full validation run rather than an ad hoc rerun. Box 2 remains open, separate work.

### TEST-02 — Golden fixture governance (PLAT-02)

**Priority:** P2/P3

- [x] Maintain a small immutable, licensed golden FCS corpus with a SHA-256 manifest and expected semantics from an independent reader. — `tests/validation/validation_test_data/external_fcs/manifest.json` already does exactly this for two real, non-synthetic sources: a single MIT-licensed instrument file (`fcsparser_miltenyi_pbs_fcs31.fcs`, from the `fcsparser` test corpus) and a CC0 published dataset (Rodighiero 2024 eLife FUCCI/EdU Kasumi-1 and MDA-MB-231 acquisitions, with manual-gate phase percentages as reference results). Every fixture entry carries a `sha256`, an `oracle` block giving FlowIO 1.4.0's expected header offsets/first-parameter values (the same independent reader used for `independent_reader_reference.json`, see box 4), and a `license.spdx` + `redistribution_basis`. `verify.py`/`verify_phasefinder_parser.mjs` re-check the hashes and FlowIO oracle locally. This is a genuine golden corpus with independent-reader semantics — it was simply undocumented as satisfying this box.
- [x] Separate independent golden fixtures from self-generated regression fixtures. — Already structurally true: `tests/validation/validation_test_data/external_fcs/` (real/independent, hand-reviewed, git-ignored payloads) is a separate directory tree with a separate manifest schema from `tests/validation/validation_test_data/synthetic_fcs/` (100% generated, `contains_real_data: false`, tracked in Git, reproducible via `generate_fixtures.py --check`). Each manifest's own `description` field states its category. No code change needed; the separation already exists and is now cross-referenced from `docs/release-and-privacy.md`.
- [~] Keep private biological data outside the public repository; define a reviewed deidentification/ingestion process. — `check:privacy` (`scripts/check-privacy.cjs`) mechanically enforces the outside-repo half. Added a new **"Ingesting non-synthetic validation data (TEST-02 box 3)"** section to `docs/release-and-privacy.md` (next to the existing inventory-table row for this directory) that writes down, as an explicit repeatable process, the four steps the two existing `external_fcs/manifest.json` entries already followed: record upstream provenance, confirm and record the license, do and write down a privacy review, record a hash and (where practical) an independent-reader oracle. States plainly that this is a *human*-reviewed process — the "reviewed" claim is only as good as the review actually done per entry — and that any new addition needs the same write-up, not just a hash. `npm run check:docs` passes after the edit.
- [x] Verify fixture hashes in CI; fail on silent mutation. — Two existing-but-orphaned integrity checks are now wired in. Added `"check:fixtures": "sh scripts/python.sh tests/validation/validation_test_data/synthetic_fcs/generate_fixtures.py --check"` to `package.json` and inserted it into the aggregate `npm run check` chain; verified locally (`"Synthetic FCS corpus is reproducible (93 files checked)."`). Added two new steps to `.github/workflows/security.yml` (runs on every `pull_request` and every `push` to `main`): `generate_fixtures.py --check` (synthetic corpus, TEST-02 box 4) and `generate_flowio_reference.py --check` (`independent_reader_reference.json` freshness against a from-scratch FlowIO 1.4.0 decode) — both pre-verified passing (the latter via a scratch venv with `flowio==1.4.0`, which `requirements-dev.txt` already pins for exactly this script). The `external_fcs/` golden corpus above cannot be hash-verified in CI the same way because its payload files are intentionally git-ignored (box 3); `verify.py`/`verify_phasefinder_parser.mjs` remain the local re-verification path for that corpus, documented as such in the new `docs/release-and-privacy.md` section.
- [x] Record source, license, FCS version/encoding, instrument/transform assumptions, and expected values for every fixture. — Synthetic corpus: manifest-level `license`, `generator{name,version,command,randomness}`, `contains_real_data`; per-case `fcs.encoding`, `fcs.sha256`, `truth`; every generated FCS file also carries its own `$SRC` TEXT keyword (`"100% synthetic; no human or instrument data"`, `generate_fixtures.py:435`). Instrument/transform assumptions are covered at the corpus level by `docs/fcs-compatibility.json`'s compensation/scaling matrix and `docs/fcs-analysis-compatibility.md`. External corpus: per-fixture `upstream{repository_url,commit,source_path,producer}`, `license{spdx,evidence_url,redistribution_basis}`, `format{fcs_version,datatype,byte_order,events,parameters}`, and `oracle.expected_summary` (box 1). Nothing new needed here beyond the box-3 documentation already added.
- [~] Track CI duration, flake rate, artifact size, browser-specific failures, and benchmark drift. — **Artifact size is already tracked**: `scripts/report-artifact-delta.cjs` (`npm run report:size`) computes `{files, bytes, js, css, images}` deltas between base and PR builds and posts a Markdown table to the PR's step summary; already wired into `security.yml` on every pull request. **The other four sub-items have no existing tracking** — grepped the workflows, `scripts/`, and `docs/` for CI-duration capture, flake-retry accounting, per-browser failure breakdowns, and any stored benchmark-history/trend file, and found none. This is a genuine, unimplemented gap, not something fakeable from this project's current data (there is no historical CI run log to backfill from) — recording it honestly rather than inventing a metric.

**Review (2026-09-05):** Fixture reproducibility checks pass; privacy denylist omits sensitive payload paths (PRIV-03). Runtime/flake/browser trend evidence remains incomplete.

**Recommendation:** Harden fixture exclusion, retain independent golden sources, and collect actual CI trend data.

### TEST-03 — Regression suite hygiene

**Priority:** P2

- [x] Keep synthetic data generators independent enough that they do not simply reproduce the implementation under test. *(This is VALID-01's core lesson: DJF-generated fixtures made a harmful change look beneficial.)* — `generate_fixtures.py`'s own module docstring already states the requirement as a design constraint: *"The scientific event generator is intentionally independent of PhaseFinder's JavaScript equations. It creates exact phase labels first, then simulates instrument channels conditionally."* Verified structurally, not just by the docstring's say-so: `grep`-ing the whole file for any `import`/`from` of a `js/` module or any `subprocess`/`node` call returns nothing — it is stdlib-only Python (`fcs_factory`, `math`, `random`, `statistics.NormalDist`). The per-event sampling forms are also mathematically distinct from the models under test: G1/G2 are sampled from a truncated normal (`_sample_truncated_normal_progress`) and S-phase progress from a quadratic-CDF profile (`_quadratic_profile_cdf`/`_sample_quadratic_progress`), neither of which is the DJ/DJF convolution-with-Bernstein-wave form or Watson's asymmetric-window fit that `js/analysis/cell_cycle/models/*.js` implement — a shared bug in one would not silently reproduce in the other. This already appears to be the fix for the exact incident the item's own parenthetical describes.
- [~] Review browser/OS matrix job duration and cost after several runs; adjust from evidence (CI-04). — Pulled real run history via `gh run list --workflow=browser-compatibility.yml` / `security.yml` rather than reviewing the YAML in the abstract. **Finding: both workflows have failed on every run since 2026-07-30**, including plain pushes to `main`, not just dependabot PRs — so "review duration/cost" was moot until this was fixed, and this session's own new `security.yml` steps (TEST-02 box 4) had only ever been verified locally, never by CI. Root cause (`gh api .../jobs/<id>/logs`): `##[error]No file in .../PhaseFinder matched to [**/requirements.txt or **/pyproject.toml]` — both workflows set `cache: pip` on `actions/setup-python` without a `cache-dependency-path`, and this repo's Python lockfile is named `requirements-dev.txt`, which the action's default glob does not match, so every run fails at the setup step before any test executes. Fixed by adding `cache-dependency-path: requirements-dev.txt` next to each of the 3 `cache: pip` occurrences (`security.yml:26`, `browser-compatibility.yml:28,64`); `actionlint` (the same version `security.yml` itself runs) reports no problems on both edited files. Once runs succeed again, the matrix design already reads as cost-conscious from the YAML alone: the cheap 3-browser Linux matrix (`engines`) runs on every PR/push, while the expensive cross-OS/exotic-browser matrix (`browser-channels`: Windows Edge, apt-installed Brave) is gated `if: github.event_name != 'pull_request'` — already kept off the PR hot path, only running on push-to-main/schedule/dispatch. No further matrix change is justified without first observing real durations post-fix.

**Review (2026-09-05):** The pip-cache path repair exists, but successful post-repair matrix duration/cost evidence is not recorded; reopened that acceptance box.

**Recommendation:** Review successful runs after the fix, then tune job cost from measured duration and failures.


### CI-05 — Baseline artifact provenance is overwritten with candidate metadata

**Priority:** P2

**Problem:** The security workflow builds the base checkout, then runs `DIST_DIR=base/dist npm run provenance` from the candidate checkout. `generate-provenance.cjs` derives source metadata from its working directory, so the base artifact is labeled with the candidate revision and dependency metadata. `GITHUB_SHA` also overrides the checkout’s local revision, so moving the command alone does not fix the revision field.

**Review (2026-09-05):** Static trace of `.github/workflows/security.yml` and `scripts/generate-provenance.cjs`; no hosted workflow run was triggered.

**Recommendation:** Generate each artifact’s provenance from its own checkout/lockfile/toolchain and explicitly set its reviewed source SHA (the base build inherits the candidate `GITHUB_SHA` too). Retain artifact hashes of the actual files.

- [ ] Compare base and candidate provenance in a pull-request job and assert their source revisions match their respective checkouts.


---

# Section 8 — Documentation and maintainability

### DOC-01 — Scientific provenance and model contracts (DOC-02)

**Priority:** P1/P2

- [x] Cite primary references with equation numbers where possible. — Read all three papers in full. Result is mixed by paper, and recorded honestly rather than forcing a uniform answer:
  - **Dean & Jett 1974 has no numbered equations at all.** The entire paper contains exactly one displayed formula (the complete-distribution function, G1 Gaussian + G2 Gaussian + a polynomial S-phase term) and one inline S-phase polynomial `P(X) = α + βX + γX²` — neither is numbered by the authors anywhere in the text. This is a fact about the source, not a remaining access failure: the "where possible" qualifier in this box's own wording is satisfied by confirming there is no equation number to cite. `dean_jett.js`'s Gaussian peak integral (`peakComponents()`, `shared.js:235`, plan §5.2) and quadratic S-phase profile (`sPhaseProfile()`, `shared.js:110`, plan §5.3) trace to this paper's unnumbered complete function and unnumbered `P(X)`, cited by description rather than number.
  - **Fox 1980 numbers exactly 5 equations, and two map directly onto this codebase.** Fox's eq. (4), `f(xj) = A + Bxj + Cxj²` — stated in the paper's own text as "identical to the Dean and Jett model" — is the asynchronous-S-phase polynomial, i.e. plan §5.3's `q(z) = a+bz+cz²` (`sPhaseProfile()`, `shared.js:110`). Fox's eq. (5), `f(xj) = A+Bxj+Cxj² + [Ns/√2π σs]·exp[-(xj-xs)²/2σs²]` — the synchronous case, polynomial plus a floating Gaussian — is exactly `dean_jett_fox.js`'s blended profile `q_F(z) = (1-w)q(z) + w·T(z;m_W,s_W)` (plan §5.4, `combined_profile()` at `dean_jett_fox.js:213`, `wave_profile()` at `dean_jett_fox.js:192`). Fox's eq. (1)/(2)/(3) (`F1(x)`, the S-phase broadening convolution `Fs(x)`, and `F2(x)`) are the G1 Gaussian, broadened-S convolution, and G2 Gaussian terms — plan §5.2's `G_{k,i}` (`peakComponents()`, `shared.js:235`) and §5.3's `S_i` (`convolvedSPhase()`, `shared.js:314`).
  - **Watson, Chambers & Smith 1987 numbers exactly 4 equations, but they describe an algorithm this codebase does not implement, so citing them as direct sources would misattribute.** Watson's eq. (1)/(2) define an iterative ERF-based correction (`kG1`/`kG2` solved from `ERF(kG1) = S/(G1·2)`, etc.) that finds the S-phase-contaminated window boundary; eq. (3)/(4) then recompute a bias-corrected true mean and variance from that window. `watson_pragmatic.js`'s `build_asymmetric_window()` (`watson_pragmatic.js:92`) and `fit_local_peak()` (`watson_pragmatic.js:253`) solve the same problem this codebase's own way — a **fixed**-sigma-multiple asymmetric window (`cleanWindowSigmas`/`contaminatedWindowSigmas` from config, not Watson's iterative ERF solve) plus a background-pedestal floor (`MODEL-06`, `pedestal_at_clean_edge()`) and a direct Gaussian-template area refinement (`refine_local_area()`) — not Watson's own mean/variance bias-correction formulas. The paper's eq. (1) (the S-phase probability distribution `Ps(x)` built from windowed peak halves) is the conceptual ancestor of the "definable G1 peak, residual S by subtraction" approach `watson_pragmatic.js` implements, and is cited as that; eq. (2)/(3)/(4) are recorded as **not** what the code does, rather than force-fit onto a table row they don't actually match.

  No project equation numbering changed as a result of this — this box was about correctly attributing existing code to primary-source equation numbers where such numbers exist and actually match, which is now done for all three papers (including the two negative findings: Dean & Jett has none, and Watson's own correction formulas aren't the ones implemented).
- [x] Map every public model parameter and component to units, bounds, transform, and equation. — `docs/plans/cell_cycle_modeling_plan.md` §5.5a (added for VALID-01 box 1) already does the units/equation/code-location part for every symbol in §5.2-5.5: `N_k`/`mu_k`/`CV_k`, `q(z)`, `S_i`, `u(z)`, `w`/`m_W`/`s_W`, and Watson's window/residual terms, each with its own row giving meaning, units (explicitly flagging dimensionless-vs-channel-unit), and a `file:line` pointer. Two things that table doesn't spell out on their own: (a) **transform** — `SHAPE1`/`SHAPE2` are the *stored* dimensionless logit parameters, not `b`/`c` directly; the table's own note says the code "parameterizes the same curve to keep it non-negative by construction," and this is the general pattern across all three models' `PARAMETER_INDEX` layouts (`dean_jett.js:69-77`, `dean_jett_fox.js:111-116`) — internal storage is always the constrained/transformed form, never the raw published symbol. (b) **bounds** — these are not static per-parameter constants (a G1-mean bound depends on the fitted histogram's domain, for instance), so there is no fixed bounds table to write; instead each model constructs its actual per-fit `bounds` object at fit time and publishes it as a first-class field on the result (`dean_jett.js:601-647`, `dean_jett_fox.js:1003-1066`), which `scientific-result-contract.md` already documents as part of the authoritative result shape. Between §5.5a (units/equation/transform) and the published per-result `bounds` field (bounds), every public parameter is traceable; nothing new needed here beyond this cross-reference.
- [x] Document the canonical phase-fraction definition, tail handling, contamination terms, convergence, model validity, and the **absence** of an Auto-selection policy. — All already documented, just scattered across three places that this box's evidence now ties together. Phase-fraction definition, tail handling, and contamination: `cell_cycle_modeling_plan.md` §5.1 gives the exact `p_G1`/`p_S`/`p_G2` formula (total-component-area basis), states "report the portion of every component falling inside the observed fit domain," "warn when missing tail mass is large enough to make total-area fractions sensitive to the chosen domain," and "contaminants never enter the biological denominator" verbatim. Convergence: §5's own numerical-specification passages (`:757` "never declare convergence merely because projection produced a zero step," `:763` "return explicit nonconvergence, boundary, singularity, and cancellation," `:1215`/`:1456` "a projected zero step is not reported as convergence," "deterministic restarts and explicit nonconvergence") plus the runtime `converged`/`convergenceReason` fields on every fit result. Model validity: `docs/scientific-result-contract.md`'s `scientificallyValid`/`validForReporting` fields and the "Validated scope, unsupported inputs, and remaining differences" section (VALID-01 box 8) already states plainly what has and hasn't been checked, against what data, and what "validated" does not mean here. Absence of Auto-selection: `docs/plans/phasefinder_design.md`'s models table already has the exact sentence — "**There is no 'Automatic' model.** One existed and was removed: it chose between DJ and DJF by an information criterion, but that comparison is unidentifiable while the peaks are frozen," with the measured ΔBIC flip that proved it wrong and a pointer to MODEL-07 for its tracked, gated return.
- [x] Document QC methods as heuristics with failure modes, review requirements, and provenance fields. — Each QC/gate module already carries a substantial header docstring stating what heuristic it runs and what failure mode it exists to catch: `structural_qc.js` (finite/negative/saturated-reading rejection, DNA-channel-only ceiling), `acquisition_time_qc.js` (robust per-bin median/IQR/event-rate drift — "catching clogs, bubbles, and fluidics instability"), `peak_tracking_time_qc.js` (peak-position drift across bins — explicitly contrasts its false-positive/false-negative tradeoff against the robust-summary method: "catches population shifts that barely move a median... at the cost of being more sensitive to genuine biological drift"), `scatter_gmm_gate.js` (2-component GMM cell-cloud gate, deterministic by construction so "a sample always gates the same way"), `pulse_geometry_gate.js` (robust-PCA-ridge singlet/doublet gate). Review requirements and provenance fields are documented once, centrally, in `scientific-result-contract.md`'s "Input preflight and QC provenance" section: every gate's outcome is one of `not_run`/`unavailable`/`failed`/`waived`/`passed`, a waiver "must be supplied explicitly and is retained verbatim in the result's preflight provenance," and it "never turns a failed QC outcome into a pass." QC-01 (already resolved) is the concrete review mechanism this describes: a blocked result renders an inline acknowledgement panel, and `{gate, acknowledgedAt, removedFraction}` is what actually gets written and persisted. This is distributed across five source files plus one contract doc rather than consolidated into a single QC reference page — genuinely present, just not centralized; noting that honestly rather than claiming a single page exists where it doesn't.
- [x] Explain the distinction between canonical modeling and the retained legacy bridge. — This box is now moot rather than satisfied by new prose: there is no more legacy bridge to distinguish canonical modeling *from*. `5ac4956` deleted `models/legacy_bridge.js`, its fit/aggregate/report adapters, the whole `js/analysis/djf/` directory, and the `legacy_bridge_v1` registry entry outright (LEGACY-01, already `[x]`) — it was retired, not retained. The only remaining work here was documentation hygiene: `docs/model-result-contract.md` and `docs/plans/phasefinder_design.md` still described the deleted bridge as live code (DOC-03 box 1's exact finding). Fixed both files in this pass — past-tense, cites `5ac4956` and the registry-negative test (`unit_tests_cell_cycle_registry.py:88`) — closing DOC-03 box 1 at the same time. `npm run check:docs` passes after both edits.

**Review (2026-09-05):** Primary references, equation mapping and contract docs exist. Current limitations are retained; no new scientific sign-off occurred.

**Recommendation:** Maintain equation provenance; address remaining current-doc inaccuracies under DOC-02/03.

### DOC-02 — Stale claims in shipped docs

**Priority:** P2

- [ ] `README.md` lines 18–19 and 274 still offer **"Automatic model selection"**, which no longer exists; line 274 also omits Watson Classic and CLOCCS.
- [x] `help/help-modeling.html` model list, Fit All description, honest-reporting guidance, and ambiguity warnings — *corrected 2026-08-14.*
- [x] Help sidebar navigation unified across all 9 sub-pages — *corrected 2026-08-14.*
- [x] Re-check the "Fit All doesn't fill the table" report in the running app (see Appendix A). Its source, `todo.md`, was archived on 2026-08-15 — the y-axis clamp and Phase 2 diagnostic-plot items it also carried are verified done and need no edit there.
- [ ] `help-getting-started.html` and `help-troubleshooting.html` have not had a line-by-line pass against the current UI; their QC and session sections likely carry the same drift `help-modeling.html` had.
- [ ] Document the residual panel and fit export in help **with** those features (UI-13, FEAT-02).

- [ ] Correct README’s 47-case synthetic claim to the current 62-case manifest; document Node CommonJS CLI scope in `docs/dependency-policy.md` (AUDIT-001/012).
- [ ] Explain in Help that AIC/BIC comparisons require the same accepted regions/domain and comparable likelihood groups; distinguish single-seed regression from calibrated multi-seed validation (AUDIT-009/010).

**Review (2026-09-05):** Fit All populates the table in current E2E. README still claims Automatic selection/47 fixtures; Help lacks some comparison caveats.

**Recommendation:** Update shipped descriptions against the registry/manifest and document new UI/export behavior when implemented.

### DOC-03 — Architecture currency

**Priority:** P3

- [~] Remove obsolete file-responsibility statements after the dead pipeline is deleted (CLEAN-01). — `docs/plans/cell_cycle_modeling_plan.md` was already corrected in place in a prior pass: `:167-173` names the three files that no longer exist and says what replaced them, and its `js/analysis/cell_cycle/` tree at `:222` is explicitly the *originally planned* layout, not a claim about the current one. The two remaining stale documents (found while working DOC-01 box 5, which describes the same residue) are now fixed too:

  - `docs/model-result-contract.md` — rewrote the "older numbered pipeline still produces..." paragraph to state in the past tense that `apply_base_fit`/`apply_contamination_fit`/`apply_fit_report` and their adapters (`legacy_bridge_fit.js`, `debris_aggregate_extension.js`, `cell_cycle_fit_report.js`, `models/legacy_bridge.js`) were deleted in `5ac4956`, and that the three retired slot names are inert `null`s in `STATE_FIELDS_IN_ORDER`. Rewrote the `legacy_bridge_v1` paragraph to cite `unit_tests_cell_cycle_registry.py:88`'s negative assertion instead of describing it as a still-registered compatibility model.
  - `docs/plans/phasefinder_design.md` — removed the `cell_cycle_fit_report.js` line from the live-tree file listing and `legacy_bridge` from the registered-models line; replaced the "**Dead code** ... tracked for deletion as CLEAN-01" blockquote (`js/analysis/djf/` was in fact deleted on 2026-08-17) with a past-tense note citing `5ac4956` and LEGACY-01; removed the `legacy_bridge_v1` "quarantined" table row and replaced it with a note that it was deleted outright rather than left quarantined.

  Nothing else was stale on this axis: `pipeline_loader.js` in the diagram docs is the *live* `js/analysis/pipeline/pipeline_loader.js`, and the `djf` in `window.PhaseFinder` is a real compatibility alias (`main.js:315`), not a leftover. `npm run check:docs` passes after both edits.
- [x] Regenerate diagrams after the deletion. — `fd74f10`. Both mermaid sources described the retired nine-stage architecture in roughly 25 places (`run_stageN()`, `index.run_all(row)`, `run_manual_stage()`, Stage 5–8 prose, dead DOM ids); the dataflow, orchestration, render, numerical-call, invalidation, and user-decision graphs were rewritten from live code and the HTML regenerated. The stale `docs/workflows/` copies were deleted in the same commit — `build_diagram_pages.py` only ever writes to `docs/`, so they could not have been anything but a stale generation. Verified clean: no diagram doc now names a deleted module.

- [ ] Refresh onboarding, directory tree, import graph counts and modeling-plan current/default statements against the live 117-module/399-edge graph. Remove current-tense claims about Automatic selection, retired modules and nonexistent result fields.

**Review (2026-09-05):** Retirement notes and diagrams were updated historically, but onboarding, graph counts and plan default/result-field statements still drift from the live tree.

**Recommendation:** Regenerate/check current architecture descriptions; label historical proposed structures explicitly.

### MAINT-01 — Typed result contracts

**Priority:** P2/P3

- [ ] Add JSDoc/TypeScript checking or another lightweight type layer incrementally around the result contracts.

**Review (2026-09-05):** No enforced static result-shape check connects model producers to exporters; FEAT-02 demonstrates the consequence.

**Recommendation:** Add lightweight checked JSDoc at the canonical result boundary and a real producer/consumer test; avoid a wholesale rewrite.

### MAINT-02 — Traceable constants and policy thresholds

**Priority:** P3

- [ ] Inventory magic thresholds in model selection, S-profile repair, QC, peak detection, memory/concurrency, and UI timing.
- [ ] Move policy values into named versioned configuration with units and rationale.
- [ ] Distinguish algorithmic constants from user-adjustable settings.
- [ ] Store analysis-affecting values in session/result provenance.
- [ ] Boundary tests around every policy threshold.

**Review (2026-09-05):** Named constants exist, but no complete units/rationale/versioned policy inventory or threshold-boundary audit exists.

**Recommendation:** Inventory scientific policy first; keep numerical constants separate and version analysis-affecting changes.


### DOC-04 — First-analysis tutorial and evidence-led usability review are missing

**Priority:** P3

**Problem:** Agency AUDIT-016 requests a bundled synthetic walkthrough from load through QC, peak review, fit, qualification and export. AUDIT-017/018 propose a small usability study and step indicator, but there is no evidence yet that a new step UI is needed.

**Review (2026-09-05):** Current Help explains individual controls; no reviewed first-analysis walkthrough with expected outcomes or recorded first-user task study was found.

**Recommendation:** Add a local synthetic walkthrough with realistic warning interpretation. Optionally observe a small consented task study before adding a step indicator; no telemetry service is required.

- [ ] Write a reproducible first-analysis walkthrough using redistributable synthetic data and current controls.
- [ ] Review task completion with representative users if onboarding remains confusing; implement new progress UI only if that evidence warrants it.


### DOC-05 — Documentation validation misses nested audit and plan documents

**Priority:** P2

**Problem:** `scripts/check_documents.py` validates public Help and top-level `docs/*.md`, omitting nested plans/audits and the generated tracker. Broken nested links and stale generated statuses can therefore pass `check:docs`.

**Review (2026-09-05):** Static checker review; this reconciliation adds a deterministic tracker `--check` and parser test, but they still need integration into the repository’s normal check command.

**Recommendation:** Include active nested documentation and tracker freshness in the normal docs gate. Treat archived obsolete code references as historical, while checking navigational links and archive provenance.

- [ ] Wire tracker freshness/parser verification and recursive active-document link validation into the normal checks.
- [ ] Define archive exceptions explicitly so historical source names do not hide newly broken navigation.


### BRAND-01 — Optional brand usage rules have no second-surface acceptance

**Priority:** P3

**Problem:** Agency AUDIT-015 proposes logo clearspace and minimum-size rules. These are not a demonstrated application defect and no additional branded surface is currently specified.

**Review (2026-09-05):** Logo assets exist; no approved minimum-size/clearspace guide is present. AUDIT-019/020 are mismatched geospatial personas and require no product change.

**Recommendation:** Keep this optional and deferred until a second publication surface needs consistent logo usage; then record simple asset-specific rules.

- [ ] When another branded surface is approved, specify and verify logo clearspace/minimum size on that surface.


---

# Section 9 — Cleanup

### CLEAN-01 — Delete the unreachable staged pipeline

**Priority:** P2 · **Effort:** ~30 minutes

**Problem:** `js/analysis/djf/` is **21 files, 6,630 lines, zero external imports** — verified: no `djf/` import exists outside the directory, and `check_import_graph.py` reaches 137 modules without it. It contains `pipeline_ui.js`, `pipeline_state.js`, `stage8_report.js`, and `scatter_modal.js` — all with **live counterparts of the same name**, which actively costs time when navigating. The `unit_tests_djf_*.py` suites drive the *live* pipeline through the harness, not this code.

- [x] `git rm -r js/analysis/djf/` — 21 files, 6,630 lines. *Done 2026-08-17, owner-approved.*
- [x] `djf-pipeline_report.md` archived to `docs/archive/audits/archive/` — it reviews this dead code and reports all 8 findings resolved, which is accurate about code nobody runs. *Done 2026-08-15.*
- [x] `docs/djf_impl_plan.md` (46 KB) archived to `docs/archive/audits/archive/` — it plans this same dead directory. *Done 2026-08-17; all five inbound links repointed.*
- [x] `npm run check:imports && npm run test:unit` after.

**Review (2026-09-05):** Dead staged files remain absent; current import check reports 117 modules, 399 edges, zero cycles and all units pass.

**Recommendation:** Keep retired design in the archive.

### CLEAN-02 — Deduplicate documentation

**Priority:** P3

- [x] `docs/plans/dean_jett_fox_implementation.md` removed — byte-identical to `docs/dean_jett_fox_implementation.md`, which is the copy referenced by five other documents. *Done 2026-08-15.*
- [x] Resolve five near-duplicate HTML pairs — `docs/X.html` vs `docs/audits/X.html` (color_use, user_controlled_vars, djf_diffs) and `docs/X.html` vs `docs/workflows/X.html` (both graph files). Sizes differ by 5–120 KB, so these are *different generations of the same document* and the filename does not say which is current.
  - **Graph pair resolved (2026-08-17):** `docs/workflows/` deleted. `docs/build_diagram_pages.py` only ever writes to `docs/`, so the `docs/workflows/` copies could not be anything but a stale generation, and would have drifted again after every rebuild. Three `docs/` vs `docs/audits/` pairs remain.
  - **Evidence (2026-08-15):** for all three `docs/audits/` copies, the relative `.md` links are broken — they resolve against `docs/audits/` but the targets (`djf_impl_plan.md`, `dean_jett_fox_implementation.md`, `djf_diffs.md`) live in `docs/`. The `docs/` copies resolve cleanly. The `docs/audits/` copies are also 5–72 bytes larger. **This points to `docs/` as canonical and the `docs/audits/` copies as misplaced duplicates**; confirm before deleting.
  - **Note (2026-08-17):** two of those three link targets have since been archived — `djf_impl_plan.md` and `djf_diffs.md` now live in `docs/archive/audits/archive/`, and both HTML copies' "View Markdown" links were repointed at the new location. That repoint does not change the verdict above: the `docs/` and `docs/audits/` HTML files are still two generations of the same page, and one of them is still stale. Only `dean_jett_fox_implementation.md` remains at its original `docs/` path.
- [x] Retire the obsolete commit-plan prescription and consolidate the archived documents (staging/committing is outside this review): `needs_to_be_fixed_ux.md` is **tracked** while `needs_be_fixed_frontend_dev.md` is **untracked**, though `working_tree_commit_plan.md` says both should be untracked.
- [x] Archive the superseded sources listed at the top of this document — all 8 moved to `docs/archive/audits/archive/` with a provenance README. *Done 2026-08-15.*

**Review (2026-09-05):** Superseded duplicate reports and commit plans are archived with paths preserved; active tracker derives from Markdown only. No Git staging changes are claimed.

**Recommendation:** Use the archive index for provenance and the master checklist as the only work queue.

### CLEAN-03 — Reconcile the original checklist

**Priority:** P2

**Problem:** The codex checklist reads 650/789 done, but at least two IDs (STAT-01, LEGACY-01) are implemented with tests and never ticked. The real remaining count is lower than 139, and knowing by how much changes what "nearly done" means.

- [x] Walk each open item against the tree; tick with evidence pointers.
- [x] Re-run the count and record it here.

**Review (2026-09-05):** Original issue lists, agency consolidation and current source/test outcomes are reconciled in this register and the linked coverage report.

**Recommendation:** Maintain unique IDs and regenerate HTML after checkbox edits; preserve historical evidence dates.

### CLEAN-04 — Help pages that ship nowhere

**Priority:** P3

**Problem:** `help/djf-model-validation.html`, `help/result_validation.html`, and `help/tool_validation.html` are linked from nowhere and **not copied into `dist/`**. They are substantive — model formula term by term, peak calling, ground-truth recovery, a 30-sample FlowJo comparison — and **newer** (Jul 30–31) than the two condensed validation pages that *are* linked (Jul 30 14:51–52). The most detailed evidence that the numbers can be trusted is invisible to users.

- [ ] Decide: wire into the help index and sidebar nav (they already use `../css/help.css` and the standard layout, so no restyling needed), or archive deliberately. Not silently.
- [ ] If wired in, confirm the build copies them.

**Review (2026-09-05):** The three detailed validation help pages remain outside the public navigation/build allowlist.

**Recommendation:** Choose reviewed public content or deliberate archival after scientific claims are reconciled; do not publish stale validation claims automatically.


---

# Section 10 — Features not yet built

## FEAT-01 — Alias of UI-13 (not counted twice)

See **UI-13**. Design in the design document.

### FEAT-02 — Versioned JSON/CSV fit export

**Completed:** 2026-09-06T12:39:22-04:00

**Started:** 2026-09-06T12:35:07-04:00

**Priority:** P2 · **Effort:** ~1 day · **M6 exit gate:** *"export contains enough data to reproduce or independently inspect the fit."*

**Problem:** The plan specifies `js/analysis/cell_cycle/export.js`; the directory has no such file. Without it the report cannot leave the browser.

- [x] Build the export. Everything needed to (a) re-run the fit and (b) check the arithmetic independently must be present: — Fixed the exact gap the 2026-09-05 probe below reproduced. `build_fit_export()` (`export.js:39`) now reads `result.appliedConfiguration` (falling back to the never-populated `result.settings` only for hand-built test fixtures), derives `domain` from `result.histogramProvenance` (`.domain`, `.binCount`, `.underflow`/`.overflow`) instead of the never-set `analysisDomain`/`binCount`/`domainCoverage`, includes the raw `histogramProvenance` block itself, reads `result.diagnostics` (falling back to `optimizerDiagnostics`), and bumped `EXPORT_FORMAT_VERSION` to `1.1.0` for the shape change. `peakRegions` was already correctly wired (`modeling_state.js:551` sets `result.peakRegions` on every real fit) and needed no change.
```js
export const EXPORT_FORMAT_VERSION = "1.0.0";

export function build_fit_export(row, result, { includeCurves = true } = {}) {
  if (!result) throw new Error("No fit result to export.");
  return {
    formatVersion: EXPORT_FORMAT_VERSION,
    exportedAt: new Date().toISOString(),
    // Vite injects both; the source commit is what actually makes an export
    // reproducible -- a version number alone cannot identify which build ran.
    application: { name: "PhaseFinder", version: __PHASEFINDER_VERSION__,
                   sourceCommit: __PHASEFINDER_SOURCE_COMMIT__ },
    sample: { name: row.name, eventCount: row.data?.event_count ?? null,
              channel: row.data?.channelKey ?? null },
    model: { id: result.modelId, version: result.modelVersion,
             settings: result.settings ?? null,
             settingsApplicability: result.settingsApplicability ?? null,
             configHash: result.configHash ?? null },
    domain: { range: result.analysisDomain ?? null, binCount: result.binCount ?? null,
              underflow: result.domainCoverage?.underflow ?? null,
              overflow: result.domainCoverage?.overflow ?? null,
              componentTailCoverage: result.componentTailCoverage ?? null },
    peakRegions: result.peakRegions ?? null,
    qc: result.preflight?.qc ?? null,
    bulkRegionProvenance: result.bulkRegionProvenance ?? null,
    fit: { parameters: result.parameters ?? null,
           phaseFractions: result.phaseFractions ?? null,
           converged: result.converged ?? null,
           convergenceReason: result.convergenceReason ?? null,
           validForReporting: result.validForReporting ?? null,
           validityReasons: result.validityReasons ?? [],
           warnings: result.warnings ?? [],
           goodnessOfFit: result.goodnessOfFit ?? null,
           optimizerDiagnostics: result.optimizerDiagnostics ?? null,
           contractVersion: result.contractVersion ?? null },
    curves: includeCurves ? result.curves ?? null : null,
  };
}
```
- [x] Long-form CSV, one row per bin (stable column set survives varying bin counts): — `build_fit_csv()` at `js/analysis/cell_cycle/export.js:144` now derives its bin data from `export_curves()` (real `histogramProvenance`/`expectedCounts`/`components`, not the never-populated `result.curves`) and adds `qualification`/`warnings` columns carrying the fit's actual `fraction_trust_reason()` caveat and warning list — a regression test (`unit_tests_cell_cycle_export.py`) asserts the values, not just the header labels. The column set (`sample,model,bin_center,observed,fitted,g1,s,g2,residual,qualification,warnings`) is a fixed literal in the header regardless of bin count; only row count (one per bin, `c.x.length`) varies, so stability across bin counts is a structural property of the long-form design. The FE-028 formula-injection defence is at `:121` with a comment explaining why it is a deliberate mirror of `metadata_io.js`'s `tsv_cell()` rather than an import: `metadata_io.js` transitively pulls in DOM-coupled modules that the unit harness cannot load. The comment says to switch to an import if that coupling is ever broken up.
```js
export function build_fit_csv(row, result) {
  const c = result?.curves;
  if (!c?.x?.length) throw new Error("This fit has no curves to export.");
  const lines = [["sample","model","bin_center","observed","fitted","g1","s","g2","residual"].join(",")];
  for (let i = 0; i < c.x.length; i += 1) {
    lines.push([csvCell(row.name), csvCell(result.modelId),
      c.x[i], c.observed[i], c.fitted[i], c.g1[i], c.s[i], c.g2[i], c.residuals[i]].join(","));
  }
  return lines.join("\n");
}
// Reuse the formula-injection defence from metadata_io.js -- FE-028 was exactly
// this bug class; do not write a second implementation.
function csvCell(value) {
  const text = String(value ?? "");
  return /^[=+\-@\t\r]/.test(text) ? `"'${text.replace(/"/g, '""')}"` : `"${text.replace(/"/g, '""')}"`;
}
```
- [x] Hang both off `#plot_tool_camera` (already labelled "Download plot or analysis report"). — `plot_tool_camera` opens `open_plot_export_modal()` (`js/plotting/plot_toolbar.js:85`), and that modal calls `build_fit_export()` at `js/plotting/plot_export.js:408` and `build_fit_csv()` at `:419`.
- [x] Session round-trip test: restore reproduces exact manual regions and configuration; stale/mismatched restored fits require refitting. — `unit_tests_session.py:160` covers per-sample regions/model/settings surviving the TOML round-trip; `unit_tests_state_reproducibility.py:257` asserts the result key pins model version, config, bins, regions, masks and domain, `:301` that version drift is labelled `recomputed_new` rather than reused, and `:273` that an unreviewed peak selection blocks the fit instead of being auto-accepted. Ten more export-specific tests live in `unit_tests_cell_cycle_export.py`.

- [x] Exercise a real converged production fit through JSON/CSV download; assert exact settings, accepted regions, bin/domain provenance, expected/component counts and independently calculated residuals. Existing exporter unit fixtures invent fields absent from production results. — `unit_tests_state_reproducibility.py`'s `STATE-02/SCI-05` test now runs a real `fit_cell_cycle_model()` result (not a hand-built fixture) through `build_fit_export()`/`build_fit_csv()` and asserts, independently: `curves.x` has one entry per `histogramProvenance.binCount`; `residuals[i] === histogramProvenance.counts[i] - expectedCounts[i]` (residual recomputed from the raw histogram, not trusted from the export itself); each of `curves.g1`/`s`/`g2` equals the matching `components[].counts`; and the exported `model.settings`/`configHash` equal the live result's `appliedConfiguration`/`configHash`. The old hand-built-fixture unit tests in `unit_tests_cell_cycle_export.py` remain as fast pure-module coverage of the serializer's shape/defaults/injection-defence logic, not as the sole claim of production correctness.

**Review (2026-09-06):** The 2026-09-05 probe's exact reproduction (settings/config/domain/regions/curves null on a real fit; CSV throwing "This fit has no curves to export.") is fixed: `result.curves` was never populated by any production code path (confirmed — `grep -rn "\.curves"` across `js/` matches only `export.js` itself), so every real CSV/JSON export was broken. `build_fit_export()`/`build_fit_csv()` now derive curve, settings, and domain data from the fields real fits actually populate (`histogramProvenance`, `expectedCounts`, `components`, `appliedConfiguration`, `diagnostics`), verified against a real fit result rather than a fixture. All four acceptance boxes are closed.

**Recommendation:** Closed. `appliedConfiguration`, `histogramProvenance`, `expectedCounts`, `components` and `diagnostics` are now serialized; accepted regions were already snapshotted; a real fit → JSON/CSV download path is now under regression test.

**Verification (2026-09-06):** Real download regression confirms version 1.1 JSON/CSV settings, accepted regions, histogram, components, warnings and residual arithmetic, including downloads after TOML refitting. Completion timestamp records this acceptance verification.

### FEAT-03 — Optional components and multiple ploidy (M7)

**Priority:** P3 · Deferred behind VALID-01.

- [ ] Normalized truncated-exponential debris.
- [ ] Sub-G1-like truncated component — **never labelled apoptosis without orthogonal evidence.**
- [ ] Multiple-ploidy support.

- [ ] Add a normalized aggregate self-convolution component with identifiable biological/contaminant denominators and independent adversarial validation (modeling plan M7).

**Review (2026-09-05):** M7 optional debris/sub-G1/ploidy and aggregate self-convolution are not registered production features.

**Recommendation:** Keep deferred behind independent per-sample validation; implement normalized components and denominator/adversarial tests together.

### FEAT-04 — CLOCCS to production (M8)

**Priority:** P3

- [~] Compare against real synchronized data and pass predefined scientific tolerances. Comparisons have run; validation has not passed. `../test_flow_data/AlphaFactorSynchronizedHaplodis_…` (121 files, 9 strains) has **no reference values**, so this can only ever be diagnostic evidence, not pass/fail validation — recorded here as such, not as a pass. The prior 115/116-asynchronous result came from `docs/audits/cell_cycle_model_investigation_handoff.md` §5.6's probe, which built rows with `pnr: {}` and silently disabled Structural QC's `$PnR` saturation ceiling — that failure belongs to the probe, not to CLOCCS or the dataset. Re-run this session through the real app code path (`tests/validation/driving_code/run_alphafactor_cloccs.py`, new): loopback-only local server serving the repo's parent directory for the run's lifetime only (never copies/symlinks the private dataset into the repo), real `FCSParser`/`generateHistogram`/`CLOCCS.fitCloccsForStrainAsync`, real per-file `$PnR` (1000, unsaturated — confirmed directly from file bytes, nothing like the probe's synthetic 9,500 ceiling-bypass). One correction found and fixed along the way: the instrument's PI detector is spectrally shared with other dyes, so every file's `$PnS` label is `PI/LSS-mKate/PerCP-A` (confirmed via the real parser against all 9 strains' two filename conventions), not plain `PI` — the script matches the leading token.

  **Full 9-strain result** (`docs/audits/evidence/alphafactor_cloccs_report.json`, all 121 files, 3 multi-starts per strain, ~78 minutes total): **all 9 series report `NOT CONVERGED`** (hit the 3×`maxIterations` multi-start budget rather than a convergence tolerance — iteration counts ranged 14,401–47,058). Reading `diagnostics` per series:
  - The **objective value agrees tightly across the 3 starts** for every strain (CV 0.03%–0.4%) — the optimizer is consistently landing in the same-quality basin, not scattering.
  - Despite that, **`lambda` (cycle length) disperses widely across starts within the same strain** for most series (CV 0.37–1.40; e.g. `1693o` ranges 4.2–1841.6 min across its 3 starts at essentially the same objective value). Matching objectives with wildly different `lambda` is the signature of a **flat ridge in the objective along the cycle-length direction** — this dataset does not pin down `lambda` even when the fit "agrees with itself." `gamma1`/`gamma2` show smaller but still often-substantial dispersion (CV up to ~1.0).
  - Phase fractions stay **largely flat across the time course** for most strains (e.g. `1468o` g1 0.839–0.924, s 0.056–0.114, g2 0.02–0.047 across all timepoints; `1982p` even tighter) rather than showing the clear G1→S→G2/M synchronization wave an alpha-factor-arrested-and-released culture is expected to produce. Two series (`1693q`, `1982o`) show much larger swings, but not obviously in a single coherent direction across the time series.
  This is **diagnostic evidence of weak parameter identifiability and non-convergence on real data, not a validated fit** — it should not be read as "CLOCCS works" or "CLOCCS is broken," since there is no reference value to compare against either way. It is a concrete, reproducible reason box 3's M8 gate is correctly not being attempted: the model does not yet demonstrably recover known biology on this dataset, separate from the missing UI surface.

  **Separately, this dataset does have reference values, and the comparison against them is real and already wired in.** The Li, MacAlpine & Hartemink 2026 CLOCCS series (`external_fcs/datasets/li_2026_cloccs/`, 32 FCS files, 2 replicates × 16 timepoints, `github.com/HarteminkLab/cell-cycle-deconv@6d3b06a`) was previously undiscovered in this checklist despite already being documented in `README.md`, tracked with real published posterior parameters in `external_fcs/manifest.json`, and run through `discover_cloccs_series()`/`execute_cloccs()` in `tests/validation/driving_code/validation_tests.py` — this is `execute_cloccs()`'s registered validation target, not exploratory code. Ran it this session (`validation_tests.py --files cloccs`, both replicates, real FCS bytes, real `CLOCCS.fitCloccsForStrainAsync`):
  - **`replicate_1`: CONVERGED.** Fitted vs. published: S-phase entry 16.9 vs 24.0 min (−7.1), recovery delay 11.2 vs 26.8 min (−15.6), cycle length λ 84.6 vs 68.2 min (+16.4), daughter delay δ 1.2 vs 8.2 min (−7.0). Same order of magnitude and correct qualitative shape — the per-timepoint fractions show a real G1→S→G2/M→G1 synchronization wave (G1 98%→35%→0%→100% across the time course) — but no parameter is within a small tolerance of published.
  - **`replicate_2`: NOT CONVERGED.** Fitted vs. published diverge by an order of magnitude on multiple parameters: cycle length λ 9.8 vs 60.2 min, daughter delay δ 162.4 vs 10.9 min, γ1/γ2 both off by 60+ points. S-phase entry coincidentally close (17.1 vs 17.0) despite the surrounding parameters being wrong; the per-timepoint fractions never leave a G1-dominated plateau, i.e. no synchronization wave recovered.
  - Both series correctly excluded the model's "halted-cell fraction" (22–29% published, unimplemented in PhaseFinder) rather than silently absorbing it into another parameter — the report records it as N/A, per the known limitation.
  - **Reading:** this is the project's first real ground-truth CLOCCS comparison (unlike the AlphaFactor run above, which has no reference values at all). It shows partial, order-of-magnitude recovery on one replicate and a real optimizer failure on the other — evidence in the same direction as the AlphaFactor diagnostic (weak identifiability), now with an actual published answer to be wrong against. It does not change box 3: the CLOCCS exit gate's "synchronized reference data pass the scientific validation gate" bullet (`cell_cycle_modeling_plan.md:1442`) is not met by a 1-of-2-converged, order-of-magnitude-off result — this result argues *against* box 3 being ready, not for it.
- [x] **`CLOCCS_modeling.md` does not exist anywhere in the repo.** Confirmed again this session (`find` across `docs/`, `docs/plans/`, `assets/`, and the repo root: no match). This is not new — `docs/archive/audits/archive/current_status_of_project.md:234` reached the same conclusion previously. The spec of record is, and remains, `docs/plans/cell_cycle_modeling_plan.md` §5.6; CLOCCS's production gate is M8, explicitly after per-sample validation.
- [ ] Meet the M8 gate before removing the "(Unverified)" label. Assessed this session, not attempted: the M8 CLOCCS joint-series adapter (`cell_cycle_modeling_plan.md:1406-1426`) requires UI wiring that does not exist yet — enabling the `cloccs_time_series` dropdown entry, a series/condition ID selector, numeric-time-with-unit/replicate/synchronized-metadata input, and sidebar joint-series controls — none of which is a documentation or one-file fix; it is new feature surface. The 8-point CLOCCS exit gate (`:1428-1439`) additionally requires session round-trip persistence of series membership, Fit-disabling validation for missing/duplicate/nonnumeric time, invalidation on time/membership edits, an independent-oracle agreement check on small fixtures, and — the box directly above this one — synchronized reference data passing the *scientific validation gate*. The AlphaFactor dataset structurally cannot do this (no reference values exist); the Li 2026 CLOCCS dataset does have published reference values and was run this session, but the result is 1-of-2-replicates-converged with order-of-magnitude parameter disagreement on the non-converged one, so it does not pass either — see box 1 for the numbers. Given P3 priority, the size of the remaining UI work, and now two independent real-data runs that fail rather than pass the validation gate, this box stays open rather than attempting a partial implementation; box 3 is correctly gated on more than box 1 alone.

**Review (2026-09-05):** CLOCCS stays unverified and lacks production joint-series controls. Recorded nine-strain diagnostics and Li comparison do not pass validation (only one of two Li replicates converged).

**Recommendation:** Retain the Unverified label until reference agreement, series UI/validation, invalidation and persistence satisfy M8.


---

### FEAT-05 — Marker-assisted event-level modeling remains a planned extension

**Priority:** P3

**Problem:** The modeling plan §5.13/M8 describes marker-assisted event-level analysis, controls, provenance and uncertainty; no production registry/UI path implements this extension. It was missing from the consolidated feature register.

**Review (2026-09-05):** Reviewed the modeling plan and model registry; existing per-sample DNA models and unverified CLOCCS do not satisfy this milestone.

**Recommendation:** Keep deferred behind validated DNA-only fitting. Scope one supported marker/control workflow, preserve event/QC provenance, and validate calibrated posteriors against independent labels before enabling it.

- [ ] Define supported markers, controls, compensation/transform assumptions and missing-input blocking.
- [ ] Implement event-level/posterior analysis and session/result provenance with explicit uncertainty.
- [ ] Pass independent labelled validation and reviewed UI/interpretation acceptance before release.


---

# Section 11 — Final release and scientific-readiness gate

**Nothing ships until every line here is true.** This is the last gate, not a summary — several entries are not covered by any item above.

### READY-01 — Build and deployment

**Priority:** P0

- [ ] No open **P0** remains, and every deferred **P1** has an owner, a rationale, and explicit release approval.
- [ ] A clean clone on the pinned Node version passes `npm ci`, all required tests, and `npm run build`.
- [ ] Full source regression **and** production-`dist` regression pass with no missing phase, unexpected warning, page error, failed request, or test retry.
- [ ] Required current browser engines pass the documented compatibility matrix.
- [ ] Cloudflare staging deployment passes the post-deploy smoke test **and its artifact hash matches the reviewed build artifact**.

**Review (2026-09-05):** Local build/base/dist smoke pass; eight source E2E failures and open P0 items remain. No fresh-clone, full browser-matrix or staging evidence was produced.

**Recommendation:** Close the named prerequisite issues and verify the exact release artifact.

### READY-02 — Scientific correctness

**Priority:** P0

- [ ] Every final DJ/DJF result satisfies parameter/region/ratio constraints and exposes honest convergence and validity state.
- [ ] Watson debris/aggregate adversarial fixtures do not inflate S phase.
- [x] Plot, sidebar, table, session restore, TSV, and downloaded plots agree on canonical phase fractions. *(→ SCI-05)*
- [ ] Unsupported, scaled, or uncompensated FCS inputs are transformed correctly or blocked before modeling.
- [ ] Reference-model and reference-FCS comparisons meet predefined tolerances, with uncertainty and limitations documented. *(→ VALID-01, UNC-01. **Include the G2:G1 ratio-convention difference from MODEL-01** — it must be stated, not silently absorbed.)*

**Review (2026-09-05):** Canonical unit paths pass but independent validation, warning propagation, session provenance and export remain incomplete.

**Recommendation:** Require VALID-01/UNC-01 plus GATE-02, STATE-02 and FEAT-02 evidence before scientific-readiness sign-off.

### READY-03 — Data safety and accessibility

**Priority:** P0

- [ ] Session reconnect rejects same-name/same-size changed content, and Reset removes all owned OPFS data.
- [ ] Keyboard, screen-reader, 200% zoom, and modal-focus acceptance checks pass. *(→ UI-01, UI-04, UI-05)*

**Review (2026-09-05):** Identity checks exist, but cache close/cleanup recovery gaps and manual accessibility acceptance remain.

**Recommendation:** Exercise failure recovery and current assistive-technology acceptance; see STATE-04/05 and UI-14.

### READY-04 — Documentation and sign-off

**Priority:** P0

- [ ] README, Help, support matrix, scientific provenance, privacy/storage behaviour, and release notes match the released code. *(→ DOC-02)*
- [ ] **A human scientific/domain reviewer approves the supported-use claims.**
- [ ] **A human release owner approves production deployment and rollback evidence.**

**Review (2026-09-05):** Docs were reconciled against current code; that does not update every shipped claim or provide human scientific/release approval.

**Recommendation:** Complete DOC-02/03 and obtain the specified human sign-offs on the final artifact.


---

# Appendix A — Verified resolved (do not re-open)

Recorded so that closed items are not rediscovered from the archived source documents.

| Item | Source | Evidence |
|---|---|---|
| UX-01 / FE-001 autoload leak | UX/FE audits | files untracked; **residue tracked as REL-02** |
| UX-02 / FE-016 responsive shell | UX/FE audits | no hard-coded header subtraction; `100dvh`; `.app{height:auto}` + `overflow-y:auto` ≤820px |
| UX-03 / FE-017 upload keyboard | UX/FE audits | `#drop_zone` is a `<button>` with `aria-controls`/`aria-label` |
| UX-04 / FE-018 modal focus | UX/FE audits | shared `js/ui/modal_focus.js` |
| UX-05 status announcements | UX audit | `index.html:848-849` — `role="status" aria-live="polite"` + separate `role="alert"` |
| UX-07 panel resizers | UX audit | both `role="separator" tabindex="0"`, pointer + arrow-key handlers |
| UX-08 ambiguous Run All labels | UX audit | one Run All remains; **below-fold residue tracked as UI-08** |
| FE-003 TOML prototype pollution | FE audit | `FORBIDDEN_KEYS` + `Object.create(null)` in `toml_io.js` |
| FE-028 TSV formula injection | FE audit | formula leaders neutralized in `metadata_io.js` |
| FE-024 reduced motion | FE audit | `prefers-reduced-motion` in `base.css`, `plot.css`, `sidebar.css` |
| FE-019 plot accessibility | FE audit | `make_plot_accessible()` sets `role="img"` + `aria-labelledby` |
| FE-034 session reproducibility | FE audit | `model_version` recorded, drift labelled |
| FE-031 PR quality gate | FE audit | four workflows incl. `node_build.yml`, `security.yml` |
| FE-032 manifest paths | FE audit | REL-02 (original checklist) |
| todo: y-axis below zero | todo.md | `plot_viewport.js:133` `clamp_y_floor()` |
| todo: Phase 2 diagnostic plot | todo.md | `time_qc_diagnostic_plot.js`, wired at `pipeline_ui.js:573-654`, unit tested |
| Model math correctness | this audit | 7 properties verified by execution — profile integral 1.000000, non-negativity, S mass = `sArea`, area conservation, sub-bin-width peaks, inverted peaks, degenerate CV |
| Static checks | this audit | eslint clean; DOM bindings 225 IDs; import graph 137 modules / 0 cycles; docs check passing |

**Also verified but needing confirmation in the running app:** "Fit All doesn't fill the table" (todo.md). The path is complete — `on_fit_all_click` → `cell-cycle-fit-changed` → `update_cell_cycle_fraction_columns` — and columns fill only for **reportable** results. Reportability went 3/30 → 30/30 after the `w`-bound fix, which would produce exactly the reported symptom. Load a few samples and check before spending time on it.

# Appendix B — Where the detail lives

| Topic | Document |
|---|---|
| Architecture, models, features, design specs | `docs/plans/phasefinder_design.md` |
| Model research log, failed attempts, measurements | `docs/audits/cell_cycle_model_investigation_handoff.md` **(keep current)** |
| DJF reference implementation | `docs/audits/baselines/dean_jett_fox_javascript_implementation.html` |
| Modeling plan, milestones, definition of done | `docs/plans/cell_cycle_modeling_plan.md` |
| Peak-tracking Time QC spec | `docs/plans/peak_tracking_time_qc_implementation_spec.md` |
| Release and privacy policy | `docs/release-and-privacy.md` |
| Result contracts | `docs/scientific-result-contract.md`, `docs/model-result-contract.md` |
