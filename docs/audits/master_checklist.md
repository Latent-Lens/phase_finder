# PhaseFinder — master remediation and feature checklist

**Consolidated:** 2026-08-15 · **Branch:** `cell-cycle-report-warn` · **Unit suite:** 756/756 green

This is the **single register** of everything left to fix or build. It supersedes and merges every prior issue list. Do not open a new tracking document; add to this one.

## Source documents merged into this register

All of these were **archived to [`docs/audits/archive/`](./archive/) on 2026-08-15** — see [that directory's README](./archive/README.md) for the full disposition. They are provenance, not a work queue; do not work from them.

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
- Run source-tree tests **and** production-`dist/` tests. A source-only pass does not establish that the deployed site works.

### Priority legend

- **P0** — release or scientific blocker. Fix before any public release or scientific reliance.
- **P1** — can change results, lose reproducibility, hide failures, or block supported users.
- **P2** — robustness, accessibility, security hardening, maintainability.
- **P3** — optimization, documentation, developer experience.

### Status legend

- `[ ]` open · `[x]` done · `[~]` partial (detail in italics) · `[?]` needs evidence before it can be scoped

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

**Gate status on 24:** passes preflight, `lint:js`, `check:dom` (225 static + 4 generated IDs), `check:docs` (14 HTML, 17 Markdown), `check:imports` (137 modules, 428 edges), `check:privacy` (527 tracked paths), and `test:ci` (25 tests). It then stops at `test:unit` on `ModuleNotFoundError: No module named 'playwright'` — **that is ENV-02, not this item.** `npm run build` and `check:dist` are still unverified because they sit behind the failing test step; re-run the full gate once ENV-02 is fixed.

### ENV-02 — The working Playwright venv is not discoverable

**Priority:** P2 · **Effort:** 1 minute

**Problem:** A working venv exists at `~/.venvs/playwright` (Python 3.12.13, playwright 1.60.0, Chromium verified). Test drivers look for `PHASEFINDER_TEST_PYTHON` → `./.venv/bin/python` → `python3`. The project has no `.venv`, and bare `python3` resolves to a uv shim without playwright — so `npm run test:unit` fails despite a perfectly good venv being present.

- [ ] `ln -s ~/.venvs/playwright .venv` (already gitignored; makes `npm test` and the pre-commit hook work with no env var).
- [ ] Reconcile `requirements-dev.txt` (pins playwright **1.61.0**) with the venv's **1.60.0**.
- [ ] Document in README that `tests/external_tools/.venv` is a separate environment (flowio, flowkit, numpy, scikit-learn) for independent-tool comparison.

---

# Section 1 — Scientific modeling correctness

> **Before changing any model code, read `docs/audits/cell_cycle_model_investigation_handoff.md` §5.** Five model changes were attempted and measured; four made results worse. That document is the reason this project is recoverable — keep it current.

### MODEL-01 — G2 mean is placed low on 30/30 samples — REDIAGNOSED

**Priority:** P0 · **Status:** diagnosis revised 2026-08-14, do not use the older framing

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

- [ ] **Do not tune `g2_mean` toward the FlowJo reference.** Record this decision so it is not re-attempted.
- [ ] Diagnose the −1.5% G1 offset — see MODEL-02. That is the clearly-ours half and it propagates into everything downstream.
- [ ] Re-run the 30-sample validation after MODEL-03 and re-derive this decomposition.
- [ ] Document the ratio decision in help and in `docs/scientific-result-contract.md`: we fit the ratio freely and expect ~1.97 on yeast; tools that constrain it to 2.0 will disagree systematically.

### MODEL-02 — The −1.5% G1 offset is unexplained

**Priority:** P0 · **Status:** `[?]` needs diagnosis before it can be scoped

**Problem:** G1 sits 1.5% below reference across the set. It passes 30/30 only because the tolerance is ±3%. It propagates into `g2_mean` in full (MODEL-01).

**What has been ruled out:** half-bin quantization. With ~460k events `recommended_bin_count()` selects the finest stop, so half a bin is ≈0.3% — a fifth of the offset. Reference integer quantization accounts for another ~0.29%. Neither explains 1.5%.

**The strongest clue, and it is a strange one:** on synthetic ground truth G1 comes out **high** (+0.49%); on real data it is **low** (−1.5%). *The signs disagree*, so the real-data offset is **not** the peak-estimator bias this was assumed to be. Most likely candidates are QC/domain related — the structural `$PnR` ceiling changes the histogram range and therefore the binning.

- [ ] Instrument one real sample end to end: raw channel values → structural QC ceiling → resolved range → bin edges → detected peak index → reported mean. Compare each stage against the reference's 171.
- [ ] Test whether the offset scales with the histogram range (QC/domain cause) or is constant in channel units (estimator cause).
- [ ] Only after the cause is known, write the fix and its regression test.

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

- [ ] Implement in both paths.
- [ ] Guard the assumption: if a caller supplies `options.smoothed` smoothed with a different kernel, this over- or under-corrects. Today every caller uses the default — assert it.
- [ ] Regression test: a known-width Gaussian must recover σ, not √(σ²+k²).
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
- [ ] Validate on the 30-sample set; record `all_pass` and `g2_mean` pass count.

### MODEL-04 — Sub-bin peak centre, clean-side only

**Priority:** P2 · **Status:** `[~]` symmetric version measured harmful

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

- [ ] Implement with the clean-side guard; record `subBinOffset` in provenance.
- [ ] Verify no consumer reconstructs the mean as `centers[result.peakIndex]` (grep `peakIndex` across `models/`).
- [ ] Validate: G1 must improve and G2 must not regress.

### MODEL-05 — Baseline-subtracted flank threshold

**Priority:** P3 · **Status:** `[?]` measured inert — hold until a fixture shows it moving something

**Problem:** `estimateSigmaOneSidedWithinRegion()` walks out until the *absolute* smoothed count drops below `fraction × peak`, so a peak on the S pedestal stays above threshold further out. Theoretically wrong.

**But measured effect is zero** — identical to no change, to every digit, on the ground-truth fixture. The flank walk stops at a *discrete bin index*, and subtracting the pedestal does not move which bin first falls below threshold. It may matter on a steeper pedestal.

- [ ] Build a fixture with a steep pedestal where this provably changes the crossing bin. **If no such fixture can be built, close this item as not-a-defect** rather than landing an inert change.

### MODEL-06 — Local area estimate does not subtract the pedestal

**Priority:** P2 · **Status:** blocked on MODEL-02/03 — do not do these together

**Problem:** `refine_local_area()` sums raw counts across the window, so S-phase mass under the peak is counted as peak area. Contributes to %G2 +7.0pp / %S −3.4pp.

**Affected file:** `js/analysis/cell_cycle/models/watson_pragmatic.js:117`

```js
function refine_local_area(edges, counts, mean, sigma, window, baseline = 0) {
  const unitTemplate = gaussianBinMass(edges, 1, mean, sigma);
  let observedSum = 0, templateSum = 0;
  for (let i = window.start; i <= window.end; i += 1) {
    observedSum += Math.max(0, counts[i] - baseline);   // was: counts[i]
    templateSum += unitTemplate[i];
  }
  return templateSum > EPS ? Math.max(0, observedSum / templateSum) : 0;
}
```
Estimate the pedestal from the **contaminated** window edge (the S-facing side); the clean side sits on background by construction:
```js
  const pedestalIndex = cleanSide === "left" ? window.end : window.start;
  let baseline = Infinity;
  for (let i = Math.max(0, pedestalIndex - 3); i <= Math.min(counts.length - 1, pedestalIndex + 3); i += 1) {
    baseline = Math.min(baseline, counts[i]);
  }
  if (!Number.isFinite(baseline) || baseline < 0) baseline = 0;
```

- [ ] Land **only after** MODEL-02 and MODEL-03 are validated — with G2 correctly placed the overlap shrinks and the correct size of this fix changes. It may over-correct and starve G2.

### MODEL-07 — Async/sync BIC selection was removed and should return

**Priority:** P2 · **Status:** blocked on MODEL-02

**Problem:** The reference implementation (§13, Steps 6–9) prescribes fitting asynchronous and synchronous forms separately and selecting by BIC. The feature was **removed** because with biased frozen peaks the wave is the only flexible shape left, so it absorbs peak misfit and runs to its ceiling — claiming a synchronized cohort on asynchronous data (ΔBIC −102.9 selecting "synchronous" on a wave-free fixture; frozen at *true* peaks the same code correctly selects asynchronous at ΔBIC +16.7).

**The code was right; the peaks were wrong.**

- [ ] Re-land after MODEL-02, alone, with its guards (`ΔBIC > 10`, `bumpFraction ≥ 2%`, cohort inside S phase, restart-stable).
- [ ] Validate before keeping. Note this also restores the architecture the reference prescribes, lost when `auto_dj_djf` was retired.

### MODEL-08 — Latent typed-array truncation trap

**Priority:** P2 · **Effort:** 5 minutes

**Problem:** `watson_pragmatic.js:243` uses `counts.map(...)`. Safe **today** only because `dna_histogram.js` builds counts with `new Array(n)`. If anyone switches to a typed array for performance — plausible, and PERF-01 invites it — `.map()` returns the same typed array type and **silently truncates S-phase counts to integers**. Identical bug class to the one already fixed in `poisson.js`.

- [ ] Replace with `Array.from(counts, (y, i) => …)`.
- [ ] Grep for the same pattern elsewhere on numeric arrays.

### MODEL-09 — Two different default bin counts

**Priority:** P2 · **Effort:** 15 minutes

**Problem:** `dna_histogram.js:18` declares `DEFAULT_BIN_COUNT = 512`; `plotting/data.js:47` declares `DEFAULT_BINS = 256`. Same concept, two values, and which applies depends on the call path.

- [ ] One exported constant, imported by both.
- [ ] Test asserting the histogram module and the plot module agree.

### SCI-03 — Convergence criteria and reasons must be truthful

**Priority:** P0 · **Status:** `[~]` contract done, UI not

Termination states, gradient criterion, and diagnostics are implemented; `apply_result_contract()` overrides contradictory `converged: true`.

- [ ] Show nonconvergence prominently in sidebar/table/export; disable authoritative phase reporting unless explicitly reviewed. **→ implemented by UI-01.**
- [ ] Benchmark stricter criteria against existing good fits to avoid excessive false nonconvergence.

### SCI-05 — One canonical phase-fraction result everywhere

**Priority:** P0 · **Status:** `[~]` contract defined, verification missing

- [ ] Cross-surface test asserting identical displayed fractions for a fit with meaningful modeled tail mass:
```js
run('SCI-05: every surface shows identical fractions for a fit with large tail mass', () => {
  const r = fitWithHeavyTail();
  const shown = [sidebarFractionText(), tableColumnText(), tsvFractionField(), plotLegendText()]
    .map(normalizePercent);
  return { pass: new Set(shown).size === 1, detail: shown.join(' | ') };
});
```
- [ ] Verify restored/recomputed sessions reproduce the same canonical values across every consumer.

### SCI-07 — Optimizer conditioning and parameterization

**Priority:** P1 · **Status:** `[~]` implemented, unbenchmarked

- [ ] Compare convergence rate, restart dispersion, runtime, and recovered parameters on existing fixtures before/after.
- [ ] Add stress fixtures: low/high event counts, channel ranges, overlapping peaks, weak S, high debris, near-bound parameters.

### SCI-08 — Quadratic S profile constrained without arbitrary shrinking

**Priority:** P1 · **Status:** `[~]` Bernstein basis landed; comparison missing

Verified by execution: profile integrates to 1.000000, stays ≥0 across extreme shape parameters (min 2.6e-26), S mass equals `sArea` exactly.

- [ ] Compare fitted phase fractions before/after on reference fixtures and explain intentional changes.

### STAT-01 — Poisson input rejection and bound auditing

**Priority:** P1/P2 · **Status:** `[~]` **largely implemented but never ticked** — reconcile

`PoissonInputError` exists (`js/analysis/math/poisson.js:30`); `constraint_audit.js` derives bounds from each model's published `bounds`.

- [ ] Verify each sub-item against the tree and tick with evidence pointers.
- [ ] Emit exact constraint residuals and active-bound diagnostics.
- [ ] One focused test triggering each configured bound/joint constraint warning.
- [ ] Calibrate reduced-deviance and residual warning thresholds against independent data. *(shared with the QC calibration study, QC-CAL-01.)*

### LEGACY-01 — Quarantine or retire legacy stages 5–8

**Priority:** P1/P2 · **Status:** `[~]` **largely implemented but never ticked** — reconcile

`legacy_bridge.js:79-80` declares `modelLabel: "Legacy Bridge (exploratory, unvalidated)"` and `exploratory: true`; the contract refuses it; it is absent from the dropdown; `unit_tests_legacy_quarantine.py` exists.

- [ ] Verify each sub-item and tick with evidence.
- [ ] Confirm no canonical plot/table/export/report path can fall back to legacy output.
- [ ] Correct any remaining "DJF" label that actually refers to the bridge.

### UNC-01 — Uncertainty, identifiability, and sensitivity reporting

**Priority:** P1 (publication gate) · **Status:** not started

**Problem:** No uncertainty reporting exists at all. A fitted percentage is presented as a point estimate with no interval.

- [ ] Report Jacobian/Hessian rank/condition evidence and parameter correlations.
- [ ] Profile-likelihood or bootstrap intervals suited to bounded nonlinear parameters and phase fractions.
- [ ] Include event resampling plus peak-region, bin/domain, and QC perturbations — not optimizer-only uncertainty.
- [ ] Report model-selection frequency/instability across resamples.
- [ ] Flag weak identifiability, multimodality, boundary-dominated intervals, or excessive fraction uncertainty as qualified/nonreportable.
- [ ] Persist interval method, seed, replicate count, failures, and definition.
- [ ] Validate nominal coverage on clean, low-count, boundary, weak-S, and contaminated simulations.

### VALID-01 — Independent scientific validation

**Priority:** P0 before any publication-grade claim · **Status:** `[~]` one dataset done

- [ ] Select primary Dean, Jett, Fox, and Watson references; build a traceable equation-to-code mapping with units and parameter definitions.
- [ ] Compare DJ and DJF expected component curves over a parameter grid, not only fitted totals.
- [~] Redistributable datasets spanning instruments, encodings, contaminants, distributions. *(one assembled — 30 yeast async samples, single instrument/encoding, local-only.)*
- [~] Predefine acceptance tolerances for peaks, fractions, deviance, model choice, QC masks. *(peaks/fractions/means/CVs/ratio done; deviance/model-choice/QC-mask not — FlowJo does not report them.)*
- [~] Compare against FlowJo/ModFit and document configuration equivalence. *(equivalence documented; **the ratio-convention difference in MODEL-01 must be added to it**.)*
- [ ] Investigate bootstrap/profile-likelihood intervals. *(overlaps UNC-01.)*
- [ ] Identifiability/restart/condition diagnostics distinguishing precise-looking but weakly identified fits.
- [ ] Document validated scope, unsupported inputs, remaining differences.
- [ ] Domain-expert review before using "validated", clinical, diagnostic, or publication-grade language.

### FUTURE-01 — Hierarchical/cross-sample models

**Priority:** P3 · **Status:** correctly deferred

- [ ] Complete VALID-01 and calibration-aware batch work first.
- [ ] Define which parameters may pool; retain explicit between-sample variance rather than hard equality.
- [ ] Require verified batch/calibration membership; preserve per-sample diagnostics and outlier handling.
- [ ] Validate under both correct and violated sharing assumptions, plus leave-one-out sensitivity.

### AMBIG-01 — Two ambiguities a single histogram cannot resolve

**Priority:** P1 · **Status:** documented in help, not handled in code

**Problem:** (a) A pure G1 and a pure G2 population produce histograms identical up to an x-scale factor. `inferred_g2` always assumes the lone peak is G1 — an **unmarked guess**, silently wrong on a G2-arrested sample. (b) (1C,2C) and (2C,4C) are both ~2:1; smoothing destroys the width evidence, and two local discriminators were tried and both provably failed.

*User decision on record: defaulting to G1 is acceptable for automated testing; in real use the user moves the regions.*

- [ ] Surface the single-peak case as **ambiguous, requiring review**, rather than silently assuming G1.
- [ ] **Do not** attempt another local heuristic for (b). Use cross-sample anchoring (one acquisition run shares a DNA axis, so samples showing two peaks fix 1C for those that don't), bead/known-control calibration, or recorded condition metadata (`Nocodazole Arrest` is already carried).


---

# Section 2 — Quality control

### QC-CAL-01 — The shared calibration study *(highest-leverage QC item)*

**Priority:** P1 · **Unblocks:** QC-01, QC-03, QC-04, QC-06, and STAT-01's threshold item

**Problem:** Five separate QC items are each blocked on the same missing thing — a labelled dataset with known disturbances against which thresholds can be calibrated. Doing the study once closes parts of all five; doing them individually is not possible.

- [ ] Assemble labelled acquisitions covering: stable runs, clogs, dropouts, timer rollover, backward time jumps, doublet-heavy samples, debris-dominant samples.
- [ ] Predefine acceptable false-positive, detection, retention, and boundary-event rejection rates.
- [ ] Calibrate MAD floors and Time QC thresholds (QC-03).
- [ ] Calibrate pulse-geometry distance/coverage thresholds (QC-06).
- [ ] Quantify peak-tracking overlap-expansion false rejection (QC-04).
- [ ] Calibrate reduced-deviance and residual warning thresholds (STAT-01).
- [ ] Version the algorithm/session configuration if any behaviour changes materially.

### QC-01 — QC outcomes explicit and fail-closed

**Priority:** P0 · **Status:** `[~]` contract blocks; UI does not exist

**Problem:** The result contract blocks reporting after critical QC removal until `qcAcknowledgements` is supplied — **and nothing supplies it**. The gate is currently a dead end rather than a safeguard.

- [ ] Wire the acknowledgement flow:
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
- [ ] Persistent batch matrix of per-file/per-stage outcomes with exact final-mask provenance. *(data already on `result.preflight.qc`; only the view is missing.)*

### QC-02 — The sidebar contradicts the table about QC state

**Priority:** P0 · **Source:** visual audit · **Verified**

**Problem:** After "Run All", all four gate buttons render the applied state (`css/plot.css:620`, keyed on `aria-pressed`) while the table simultaneously reads *"Cell gate incomplete: scatter gate review required."* The user believes QC passed, clicks Fit, and is refused.

**Root cause is a modelling gap, not styling:** `aria-pressed` is used to mean *"completed successfully"* when it means *"toggle is on."* **There is no vocabulary for the third state** — attempted-but-incomplete.

- [ ] Introduce an explicit per-gate state: `not-run` / `running` / `applied` / `needs-review` / `failed` / `skipped`.
- [ ] Drive button appearance from that state, not from `aria-pressed`. Keep `aria-pressed` for its real meaning.
- [ ] Make the sidebar and the table read the same state object so they cannot disagree.
- [ ] Test: a gate that completes with a review requirement must render `needs-review` in **both** surfaces.

### QC-03 — Robust-summary acquisition Time QC

**Priority:** P1 · **Status:** `[~]`

- [ ] Calibrate MAD floors and thresholds. *(→ QC-CAL-01)*
- [~] Exact-rate, disabled-metric, too-few-bin, zero-MAD tests added; multi-segment and known-disturbance tests with predefined error rates pending. *(→ QC-CAL-01)*

### QC-04 — Peak-tracking Time QC tracking model

**Priority:** P1/P2 · **Status:** `[~]` evidence layer exists, assignment model does not

- [ ] Explicit missing/ambiguity plus order-constrained or dynamic assignment with merge/split/birth/death states. *(per-bin imputed/missing evidence exists from SCI-09C; crossing/merge/split assignment does not.)*
- [ ] Replace largest-terminal-node stability with a validated continuity/quality/reference criterion, or require manual review.
- [ ] Quantify overlap-expansion false rejection; evaluate consensus/weighted event decisions. *(→ QC-CAL-01)*
- [ ] Predefine acceptable false-positive, detection, retention, and boundary-event rejection rates. *(→ QC-CAL-01)*

### QC-06 — Invalid pulse-geometry singlet gate

**Priority:** P1 · **Status:** `[~]` structure defined, thresholds uncalibrated

- [ ] Empirically calibrate distance/coverage thresholds against labelled data. *(→ QC-CAL-01. Minimum sample size, reliability tier, and plausible-coverage/off-axis floors are already defined and documented.)*

---

# Section 3 — Result integrity and reproducibility

### GATE-01 — One authoritative scientific-result contract

**Priority:** P0 · **Status:** `[~]`

`apply_result_contract()` requires a preflight bundle and stamps `contractVersion`; `is_reportable_result()` / `get_active_model_result()` demand the stamp.

- [ ] Require **every** UI, worker, session-restore, debug API, and direct model entry point to call the same preflight/result validator. Enumerate the entry points and prove each one routes through it.

### STATE-01 — Model settings effective, immutable, reproducible

**Priority:** P0/P1 · **Status:** `[~]`

Sessions record `model_version`; restore labels drift `recomputed_new` vs `reproduced`; `settingsApplicability` records settings a model cannot consume.

- [ ] Restore the saved `reviewed` state faithfully; never silently accept or refit unreviewed regions.
- [ ] On algorithm/version drift, label recomputed results as new rather than implying exact reproduction.
- [ ] Tests proving: each effective setting changes the config hash and applied behaviour; unknown settings fail; unreviewed sessions remain unreviewed; changed file bytes cannot reuse caches or results.

### DOMAIN-01 — Visual viewport separated from scientific fit domain

**Priority:** P1 · **Status:** `[~]`

Per-fit coverage audit exists; `componentTailCoverage` is populated; display-only framing writes `axis_range_override`, never `analysis_domain_override`.

- [ ] Persist domain, bin edges/count, underflow, overflow, and component tail coverage in result provenance.
- [ ] Define warning/invalid thresholds for excluded observed events and modelled mass.
- [ ] Sensitivity analysis across supported bin counts and reasonable domain perturbations.
- [ ] Block or qualify results whose fractions/model choice exceed documented sensitivity tolerances.

### PEAK-01 — Calibrated or reviewed peak initialization

**Priority:** P1 · **Status:** `[~]`

- [ ] Calibrate thresholds on independently annotated histograms; **do not present the confidence score as a probability** (it currently reads as one).
- [ ] Fixtures for sub-G1 distractors, missing/weak G2, impulses, broad peaks, aneuploid peaks, weak S, and width fallbacks.
- [ ] Measure and document detection sensitivity, specificity, ambiguity, and review rate.

---

# Section 4 — UI, UX, and accessibility

> Ordered by user impact. Items 1–2 are the ones with **scientific** consequences: they cause a reader to trust a number they should not.

### UI-01 — The trust hierarchy is inverted

**Priority:** P0 · **Effort:** ~1 day · **Source:** visual audit + code · **Verified**

**Problem:** The result panel renders the phase percentages *larger and darker* than the caveats that qualify them. Verified in `css/plot.css:1098-1161`:

| element | size | colour |
|---|---|---|
| phase percentages | `0.78rem` | `var(--text)` |
| convergence status, fit-quality score, warning count | `0.72rem` | `var(--muted)` |

A poor fit and a perfect one differ only by a small grey-to-red shift. The `goodnessOfFit` explanation lives solely in a `title` attribute — unreachable by keyboard or touch. Separately, `index.html:247` is `<div id="cell_cycle_fit_result" …>` with **no `role`, no `aria-live`, no heading**, so screen-reader users get silence when a fit completes.

- [ ] Invert the emphasis: the qualifier must be at least as prominent as the number.
- [ ] Move the goodness-of-fit explanation out of `title=` into visible, focusable content.
- [ ] Add `role="status" aria-live="polite"` and a heading to `#cell_cycle_fit_result`.
- [ ] Carry the state with the number wherever it appears — table, sidebar, plot legend, TSV:
```js
// A bare percentage reads as authoritative. If the fit did not converge, or the
// contract refused it for reporting, the number must not appear naked in a
// column someone will paste into a paper.
function format_fraction_cell(result, fraction) {
  if (!Number.isFinite(fraction)) return format_cell_cycle_value(null, "");
  const text = `${(fraction * 100).toFixed(1)}%`;
  if (result.validForReporting === false) return format_cell_cycle_value(`${text} ⚠`, "unvalidated result");
  if (result.converged === false)         return format_cell_cycle_value(`${text} ⚠`, "fit did not converge");
  return format_cell_cycle_value(text, "");
}
```
- [ ] Use a non-colour cue so the distinction survives greyscale printing.
- [ ] **Closes SCI-03's UI item.**

### UI-02 — Bulk-fit failures are misattributed to the user

**Priority:** P1 · **Effort:** ~2 hours · **Verified**

**Problem:** `modeling_ui.js:583` and `:663` hard-code the reason `"User cancelled bulk fitting"` on cancellation paths regardless of actual cause. The resulting summary reads *"0 converged/reportable; 0 computed but did not converge; 0 detection failed; 0 fit failed; 3 cancelled; 0 skipped"* — five of six terms are zero and the sixth is wrong. (`:700` does distinguish aborted from not-reached; this is two paths, not three.)

- [ ] Pass the real cause through each cancellation path.
- [ ] Suppress zero-valued terms from the summary sentence; report only what happened.
- [ ] Test: a QC-blocked bulk fit must not report "user cancelled".

### UI-03 — `--border` fails non-text contrast

**Priority:** P1 · **Effort:** ~0.5 day · **Verified by computation**

**Problem:** `css/base.css:13` — `--border: #d9dee8`. Against white that is **1.35:1**; WCAG requires **3:1** for control boundaries. Every bordered control in the app is under-delineated. Additionally `test_contrast_tokens.py` only checks text tokens against `--panel` — never `--bg`, `--th_bg`, or `--accent_soft`, and never component boundaries.

- [ ] Darken `--border` to meet 3:1 and re-check every surface it sits on.
- [ ] Extend `test_contrast_tokens.py` to all surface tokens and to component boundaries. The expanded test in the visual audit **currently fails on three real pairs** — land the test with the fixes.

### UI-04 — `forced-colors` support stops at the shell

**Priority:** P1 · **Effort:** ~1 day · **Verified**

**Problem:** `forced-colors` blocks exist in `css/base.css` (1) and `css/help.css` — and nowhere else. Counts: `sidebar.css` 0, `table.css` 0, `layout.css` 0, `plot.css` 0. So the shell adapts to Windows High Contrast and the table, sidebar, modals, and plot chrome do not. `focus-visible` is uneven too: `feedback.css` has **0**.

- [ ] Add `forced-colors` blocks to `sidebar.css`, `table.css`, `layout.css`, `plot.css` covering borders, focus rings, and colour-only state. Copy the pattern at `help.css:582`.
- [ ] Give `table.css` and `feedback.css` real focus-visible treatment.
- [ ] **Closes the remaining UI-19 items.**

### UI-05 — 200% zoom forces desktop into the mobile layout

**Priority:** P1 · **Effort:** ~0.5 day · **Source:** visual audit

**Problem:** `css/responsive.css` declares exactly one breakpoint, `@media (max-width: 820px)`. At 200% zoom a desktop viewport falls below it and drops into the mobile stacked layout. That is a WCAG reflow failure, and it also means one breakpoint serves everything from 320px to tablet.

- [ ] Verify at 320 / 390 / 768 / 820 / 1024 and at 200% zoom.
- [ ] Add a second breakpoint if the metadata table or sidebar demands different treatment at phone vs tablet width.
- [ ] Ensure zoom-induced narrow viewports get a layout appropriate to *zoom*, not to *phone*.

### UI-06 — The metadata wizard auto-opens and steals focus

**Priority:** P2 · **Effort:** ~1 hour · **Verified**

**Problem:** `js/ui/metadata_wizard.js:451` — `window.setTimeout(() => open_metadata_wizard(), 750)` fires a blocking modal 750 ms after the first file load, interrupting the user mid-orientation and taking focus.

- [ ] Replace the auto-open with a visible, dismissible affordance the user chooses to activate.
- [ ] If retained, never steal focus, and never fire while the user is mid-interaction.

### UI-07 — Axis-range editing is only reachable by a hidden double-click

**Priority:** P2 · **Effort:** ~2 hours · **Verified**

**Problem:** The plot toolbar has exactly six buttons — camera, pan, zoom in, zoom out, autoscale, home. **None opens the axis dialog.** `axis_modal.js:244` opens it from a custom event dispatched by double-clicking invisible SVG hit areas. This matters more than usual here because the axis range can be promoted to the **scientific analysis domain**, so a hidden gesture changes what gets modelled.

- [ ] Add a toolbar button:
```html
<button id="plot_tool_axes" class="plot_tool quick_tooltip" type="button"
        data-tooltip-key="plotToolAxes" aria-label="Set axis ranges"
        aria-haspopup="dialog">…</button>
```
- [ ] Register in `js/ui/dom.js` (`npm run check:dom` fails until you do); wire to `open_axis_range_modal()`.
- [ ] Keep the double-click as a shortcut. **Closes UX-06.**

### UI-08 — Fit buttons sit below the fold with no affordance

**Priority:** P2 · **Effort:** ~2 hours · **Source:** visual audit

**Problem:** Model & Fit begins 775 px into an 802 px scroll container, so the fit buttons are below the fold with no scroll indication. (This is the residual half of UX-08; the ambiguous button *labels* were already fixed.)

- [ ] Add a scroll affordance, or restructure so the primary action is reachable without discovering the scroll.

### UI-09 — Detect Peaks reports success with empty region fields

**Priority:** P2 · **Source:** visual audit

- [ ] Reproduce, then either populate the four sidebar fields on success or report the real outcome.

### UI-10 — "Run All" does not run all

**Priority:** P2 · **Source:** visual audit

**Problem:** "Run All" opens a configuration modal at step 2 and stops.

- [ ] Either run the remaining gates after configuration, or rename to reflect what it does.

### UI-11 — Row-selection checkboxes are 17 px

**Priority:** P3 · **Effort:** ~15 minutes

- [ ] Raise to a ≥24 px target (WCAG 2.2 target size), preserving row density.

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
- [ ] A verified dark token set (all text ≥4.5:1 on four surface tokens, all boundaries and plot series ≥3:1) is in the design document — use it as the starting point.

### UI-13 — Residuals are computed and never displayed

**Priority:** P2 · **Effort:** ~1 day · **Closes the plan's "residuals visible by default" gate**

**Problem:** `fitResult.curves` already carries `residuals`, and `cell_cycle_fit_report.js` analyses their structure (lag-1 autocorrelation, Durbin–Watson, maximum local bias). Nothing renders them — `grep residual js/plotting/render.js` returns nothing. The most direct visual evidence of a bad fit is invisible.

- [ ] Build the residual strip beneath the histogram. Full design (layout, proportions, colour, narrow-width behaviour, accessible equivalent) is in the design document.
- [ ] Pearson-normalise by default — raw residuals scale with peak height, so the eye is drawn to G1 regardless of fit quality.
- [ ] Share the x-scale with the histogram so the strips align.
- [ ] Provide the accessible text equivalent (bins outside ±2, largest deviation).
- [ ] Register new ids in `js/ui/dom.js`.

### UI-14 — Remaining accessibility verification

**Priority:** P2 · **Status:** `[~]` from the original checklist

- [ ] UI-04 (ridge export): visual comparison fixture for overlay and ridge modes.
- [ ] UI-05B (table selection/sort): test with keyboard, accessibility tree, and at least one screen reader.
- [ ] UI-05D (plot equivalent): accessibility-tree assertions for empty, histogram-only, and modeled plots. *(Chromium already asserts real SVG accessibility snapshots.)*
- [ ] UI-14 (exports): equivalent content in SVG/PDF/PNG/JPEG for overlay and multi-row ridge; oversized output, failure, cancellation, repeated click, keyboard controls.

---

# Section 5 — Performance

### PERF-01 — Fit cancellation is not real; canonical fits can run on the UI thread

**Priority:** P2 · **Source:** PERF-MODEL-01 + FE-009

**Problem:** `fit_client.js` documents "caller falls back to the main thread" when no worker is available, so a canonical scientific fit can silently run on the UI thread. Cancellation is not cooperative.

- [ ] Yield cooperatively between solver iterations, or use a terminable worker per active fit.
- [ ] Request-generation tokens so cancelled/stale worker results cannot activate.
- [ ] Never silently run canonical fits on the main thread — expose a worker-unavailable state, or a strictly bounded reviewed fallback.
- [ ] Cache quadrature nodes and parameter-independent bin quantities.
- [ ] Evaluate analytic derivatives / AD **only after** the transformed parameterization is validated.
- [ ] Cancellation-latency, worker-failure, UI-responsiveness, stale-result, runtime, and memory benchmarks.
- [ ] Assert optimized and reference expected counts/objective/parameters/fractions stay within strict tolerances.

### PERF-02 — Profile before optimizing table and plot interactions *(was PERF-UI-01)*

**Priority:** P3 · **Status:** `[?]` needs measurement first

- [ ] Representative fixtures: many files, long metadata, large event counts, ridge plots, repeated model overlays.
- [ ] Measure initial load, table rerender, filter/sort, plot redraw, pan/zoom frame time, bulk fit, export, memory.
- [ ] **Only if** table rerender dominates, introduce keyed row updates or virtualization — without breaking focus, selection, filters, or accessibility.

---

# Section 6 — Release, build, and privacy

### REL-01 — Cloudflare release execution

**Priority:** P0 · **Status:** `[~]` workflow repaired; blocked on account access

The workflow now deploys `dist` (never `.`), is fail-closed behind `ENABLE_PRODUCTION_DEPLOY`, has `environment: production` and a concurrency group, and `public/_headers` carries a strict self-only CSP that `verify-dist.cjs` validates by hash.

- [ ] `workflow_dispatch` against a **staging** Pages project; inspect the deployed file list and response headers (confirms Pages honours `_headers`). *Also closes PRIV-02's artifact check.*
- [ ] Publish a **test release**; verify public URL, Help link, panel icons, web manifest, worker-based FCS parsing, one model fit.
- [ ] Record the last known-good **deployment identifier** in `docs/release-and-privacy.md` beside the existing rollback procedure; exercise a rollback on staging. *Also closes PLAT-01.*

### REL-02 — `dist/` 404s on every page load

**Priority:** P1 · **Effort:** ~15 minutes · **Verified**

**Problem:** The built artifact fetches `./sessions/phasefinder_local.json` — the personal autoload config, correctly excluded from the build. The JS treats absence as silent *by design*, but the browser records a failed request and a console error on **every visit to the public site**. `verify-dist.cjs` cannot catch it because it is a runtime fetch, not a static reference.

- [ ] Ship an inert stub so the probe gets `200 {}`:
```js
// Ship an inert autoload config so the startup probe gets 200 {} instead of a
// 404. Keeps the console clean without shipping anyone's personal session.
const autoloadStub = path.join(distDir, "sessions", "phasefinder_local.json");
fs.mkdirSync(path.dirname(autoloadStub), { recursive: true });
fs.writeFileSync(autoloadStub, "{}\n");
```
- [ ] Make a session leak into `dist/` a **build failure** — this is the valuable half:
```js
assertExists("sessions/phasefinder_local.json", "startup autoload probe target");
const stub = JSON.parse(fs.readFileSync(path.join(DIST, "sessions/phasefinder_local.json"), "utf8"));
if (Object.keys(stub).length) {
  fail("dist/sessions/phasefinder_local.json must be an empty object; a real session leaked into the build.");
}
```
- [ ] Also guard the content type in `try_autoload()` — a static host may answer a missing path with an HTML fallback.

### REL-03 — The built HTML carries a dead importmap

**Priority:** P2 · **Effort:** ~30 minutes · **Verified**

**Problem:** `dist/index.html` maps `d3` → `./js/vendor/d3.min.js`, but `dist/` has no `js/` directory — Vite bundles d3 and rewrites every bare import (confirmed: no `from"d3"` survives). It is dead markup that forces a CSP `script-src` hash to exist for a script that does nothing.

- [ ] Strip it at build time:
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
- [ ] **Same commit**, drop the hash: `script-src 'self' 'sha256-QegS…'` → `script-src 'self'`.
- [ ] Flip `verify-dist.cjs` from "the declared hash matches the importmap" to "no inline script remains and script-src declares no hash".
- [ ] **Atomic.** Removing the script while leaving the hash is harmless; removing the hash while leaving the script breaks production only. Verify with `npm run check:dist`.

### REL-04 — Toolchain and fresh-clone verification

**Priority:** P1

- [ ] Verify a fresh clone runs `npm ci`, `npm test`, `npm run build`, `npm run preview` with no undocumented manual steps. *(Do this **before** the test release — cheapest way to find a missing committed file.)*
- [ ] Verify a fresh clone contains only synthetic examples and does not silently autoload a personal session.
- [ ] Record branch, commit, `git status --short`, Node, Python, and Playwright versions in the implementation PR (PREP-01).
- [ ] Build with the pinned Node version and archive a `dist/` path manifest for before/after comparison (PREP-01).

---

# Section 7 — Testing and validation

### TEST-01 — Definition-of-done gaps *(was PREP-02)*

**Priority:** P1

Applies to every item in this document, not just testing.

- [ ] Existing source-tree unit and E2E tests pass without converting failures into warnings.
- [ ] Scientific result changes documented with expected tolerances and reviewed against an independent calculation where available.

**The rest of the shared definition of done is already satisfied** and is restated here so it is not lost: a regression test that fails on the audited behaviour and passes after; a clean-install Vite build; a `dist/`-served smoke suite including one model fit; new errors surfaced with actionable text rather than silent success; accessibility verified by keyboard and accessibility tree, not visual inspection alone; documentation and release notes updated with the code; no private session data, local paths, tool configuration, or generated build output staged.

### TEST-02 — Golden fixture governance (PLAT-02)

**Priority:** P2/P3

- [ ] Maintain a small immutable, licensed golden FCS corpus with a SHA-256 manifest and expected semantics from an independent reader.
- [ ] Separate independent golden fixtures from self-generated regression fixtures.
- [ ] Keep private biological data outside the public repository; define a reviewed deidentification/ingestion process.
- [ ] Verify fixture hashes in CI; fail on silent mutation.
- [ ] Record source, license, FCS version/encoding, instrument/transform assumptions, and expected values for every fixture.
- [ ] Track CI duration, flake rate, artifact size, browser-specific failures, and benchmark drift.

### TEST-03 — Regression suite hygiene

**Priority:** P2

- [ ] Keep synthetic data generators independent enough that they do not simply reproduce the implementation under test. *(This is VALID-01's core lesson: DJF-generated fixtures made a harmful change look beneficial.)*
- [ ] Review browser/OS matrix job duration and cost after several runs; adjust from evidence (CI-04).

---

# Section 8 — Documentation and maintainability

### DOC-01 — Scientific provenance and model contracts (DOC-02)

**Priority:** P1/P2

- [ ] Cite primary references with equation numbers where possible.
- [ ] Map every public model parameter and component to units, bounds, transform, and equation.
- [ ] Document the canonical phase-fraction definition, tail handling, contamination terms, convergence, model validity, and (now) the **absence** of an Auto-selection policy.
- [ ] Document QC methods as heuristics with failure modes, review requirements, and provenance fields.
- [ ] Explain the distinction between canonical modeling and the retained legacy bridge.

### DOC-02 — Stale claims in shipped docs

**Priority:** P2

- [ ] `README.md` lines 18–19 and 274 still offer **"Automatic model selection"**, which no longer exists; line 274 also omits Watson Classic and CLOCCS.
- [x] `help/help-modeling.html` model list, Fit All description, honest-reporting guidance, and ambiguity warnings — *corrected 2026-08-14.*
- [x] Help sidebar navigation unified across all 9 sub-pages — *corrected 2026-08-14.*
- [ ] Re-check the "Fit All doesn't fill the table" report in the running app (see Appendix A). Its source, `todo.md`, was archived on 2026-08-15 — the y-axis clamp and Phase 2 diagnostic-plot items it also carried are verified done and need no edit there.
- [ ] `help-getting-started.html` and `help-troubleshooting.html` have not had a line-by-line pass against the current UI; their QC and session sections likely carry the same drift `help-modeling.html` had.
- [ ] Document the residual panel and fit export in help **with** those features (UI-13, FEAT-02).

### DOC-03 — Architecture currency

**Priority:** P3

- [ ] Remove obsolete file-responsibility statements after the dead pipeline is deleted (CLEAN-01).
- [ ] Regenerate diagrams after the deletion.

### MAINT-01 — Typed result contracts

**Priority:** P2/P3

- [ ] Add JSDoc/TypeScript checking or another lightweight type layer incrementally around the result contracts.

### MAINT-02 — Traceable constants and policy thresholds

**Priority:** P3

- [ ] Inventory magic thresholds in model selection, S-profile repair, QC, peak detection, memory/concurrency, and UI timing.
- [ ] Move policy values into named versioned configuration with units and rationale.
- [ ] Distinguish algorithmic constants from user-adjustable settings.
- [ ] Store analysis-affecting values in session/result provenance.
- [ ] Boundary tests around every policy threshold.

---

# Section 9 — Cleanup

### CLEAN-01 — Delete the unreachable staged pipeline

**Priority:** P2 · **Effort:** ~30 minutes · **Requires owner approval** (deletion policy)

**Problem:** `js/analysis/djf/` is **21 files, 6,630 lines, zero external imports** — verified: no `djf/` import exists outside the directory, and `check_import_graph.py` reaches 137 modules without it. It contains `pipeline_ui.js`, `pipeline_state.js`, `stage8_report.js`, and `scatter_modal.js` — all with **live counterparts of the same name**, which actively costs time when navigating. The `unit_tests_djf_*.py` suites drive the *live* pipeline through the harness, not this code.

- [ ] `git rm -r js/analysis/djf/`
- [x] `djf-pipeline_report.md` archived to `docs/audits/archive/` — it reviews this dead code and reports all 8 findings resolved, which is accurate about code nobody runs. *Done 2026-08-15.*
- [ ] Consider archiving `docs/djf_impl_plan.md` (46 KB) — it plans this same dead directory.
- [ ] `npm run check:imports && npm run test:unit` after.

### CLEAN-02 — Deduplicate documentation

**Priority:** P3

- [x] `docs/plans/dean_jett_fox_implementation.md` removed — byte-identical to `docs/dean_jett_fox_implementation.md`, which is the copy referenced by five other documents. *Done 2026-08-15.*
- [ ] Resolve five near-duplicate HTML pairs — `docs/X.html` vs `docs/audits/X.html` (color_use, user_controlled_vars, djf_diffs) and `docs/X.html` vs `docs/workflows/X.html` (both graph files). Sizes differ by 5–120 KB, so these are *different generations of the same document* and the filename does not say which is current.
  - **Evidence (2026-08-15):** for all three `docs/audits/` copies, the relative `.md` links are broken — they resolve against `docs/audits/` but the targets (`djf_impl_plan.md`, `dean_jett_fox_implementation.md`, `djf_diffs.md`) live in `docs/`. The `docs/` copies resolve cleanly. The `docs/audits/` copies are also 5–72 bytes larger. **This points to `docs/` as canonical and the `docs/audits/` copies as misplaced duplicates**; confirm before deleting.
- [ ] Fix the tracking inconsistency: `needs_to_be_fixed_ux.md` is **tracked** while `needs_be_fixed_frontend_dev.md` is **untracked**, though `working_tree_commit_plan.md` says both should be untracked.
- [x] Archive the superseded sources listed at the top of this document — all 8 moved to `docs/audits/archive/` with a provenance README. *Done 2026-08-15.*

### CLEAN-03 — Reconcile the original checklist

**Priority:** P2

**Problem:** The codex checklist reads 650/789 done, but at least two IDs (STAT-01, LEGACY-01) are implemented with tests and never ticked. The real remaining count is lower than 139, and knowing by how much changes what "nearly done" means.

- [ ] Walk each open item against the tree; tick with evidence pointers.
- [ ] Re-run the count and record it here.

### CLEAN-04 — Help pages that ship nowhere

**Priority:** P3

**Problem:** `help/djf-model-validation.html`, `help/result_validation.html`, and `help/tool_validation.html` are linked from nowhere and **not copied into `dist/`**. They are substantive — model formula term by term, peak calling, ground-truth recovery, a 30-sample FlowJo comparison — and **newer** (Jul 30–31) than the two condensed validation pages that *are* linked (Jul 30 14:51–52). The most detailed evidence that the numbers can be trusted is invisible to users.

- [ ] Decide: wire into the help index and sidebar nav (they already use `../css/help.css` and the standard layout, so no restyling needed), or archive deliberately. Not silently.
- [ ] If wired in, confirm the build copies them.

---

# Section 10 — Features not yet built

### FEAT-01 — Residual panel

See **UI-13**. Design in the design document.

### FEAT-02 — Versioned JSON/CSV fit export

**Priority:** P2 · **Effort:** ~1 day · **M6 exit gate:** *"export contains enough data to reproduce or independently inspect the fit."*

**Problem:** The plan specifies `js/analysis/cell_cycle/export.js`; the directory has no such file. Without it the report cannot leave the browser.

- [ ] Build the export. Everything needed to (a) re-run the fit and (b) check the arithmetic independently must be present:
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
- [ ] Long-form CSV, one row per bin (stable column set survives varying bin counts):
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
- [ ] Hang both off `#plot_tool_camera` (already labelled "Download plot or analysis report").
- [ ] Session round-trip test: restore reproduces exact manual regions and configuration; stale/mismatched restored fits require refitting.

### FEAT-03 — Optional components and multiple ploidy (M7)

**Priority:** P3 · Deferred behind VALID-01.

- [ ] Normalized truncated-exponential debris.
- [ ] Sub-G1-like truncated component — **never labelled apoptosis without orthogonal evidence.**
- [ ] Multiple-ploidy support.

### FEAT-04 — CLOCCS to production (M8)

**Priority:** P3 · **Status:** registered as `cloccs` v`0.1.0-unverified`, `capabilities.unverified: true`, joint-series scope, worker + client + synthetic generator + unit suite all exist.

- [ ] Validate against real synchronized data. `../test_flow_data/AlphaFactorSynchronizedHaplodis_…` (121 files, 9 strains) has **no reference values**, and a partial run classified 115/116 as asynchronous — the Fox cohort machinery has never fired on real synchronized data. Those runs used a misconfigured probe; re-run before drawing conclusions.
- [ ] **`CLOCCS_modeling.md` does not exist anywhere in the repo.** If a specification exists, add it; otherwise the spec of record is `docs/plans/cell_cycle_modeling_plan.md` §5.6.
- [ ] Meet the M8 gate before removing the "(Unverified)" label.

---

---

# Section 11 — Final release and scientific-readiness gate

**Nothing ships until every line here is true.** This is the last gate, not a summary — several entries are not covered by any item above.

### Build and deployment

- [ ] No open **P0** remains, and every deferred **P1** has an owner, a rationale, and explicit release approval.
- [ ] A clean clone on the pinned Node version passes `npm ci`, all required tests, and `npm run build`.
- [ ] Full source regression **and** production-`dist` regression pass with no missing phase, unexpected warning, page error, failed request, or test retry.
- [ ] Required current browser engines pass the documented compatibility matrix.
- [ ] Cloudflare staging deployment passes the post-deploy smoke test **and its artifact hash matches the reviewed build artifact**.

### Scientific correctness

- [ ] Every final DJ/DJF result satisfies parameter/region/ratio constraints and exposes honest convergence and validity state.
- [ ] Watson debris/aggregate adversarial fixtures do not inflate S phase.
- [ ] Plot, sidebar, table, session restore, TSV, and downloaded plots agree on canonical phase fractions. *(→ SCI-05)*
- [ ] Unsupported, scaled, or uncompensated FCS inputs are transformed correctly or blocked before modeling.
- [ ] Reference-model and reference-FCS comparisons meet predefined tolerances, with uncertainty and limitations documented. *(→ VALID-01, UNC-01. **Include the G2:G1 ratio-convention difference from MODEL-01** — it must be stated, not silently absorbed.)*

### Data safety and accessibility

- [ ] Session reconnect rejects same-name/same-size changed content, and Reset removes all owned OPFS data.
- [ ] Keyboard, screen-reader, 200% zoom, and modal-focus acceptance checks pass. *(→ UI-01, UI-04, UI-05)*

### Documentation and sign-off

- [ ] README, Help, support matrix, scientific provenance, privacy/storage behaviour, and release notes match the released code. *(→ DOC-02)*
- [ ] **A human scientific/domain reviewer approves the supported-use claims.**
- [ ] **A human release owner approves production deployment and rollback evidence.**

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
