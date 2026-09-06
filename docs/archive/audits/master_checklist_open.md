> Archived 2026-09-05 from docs/audits/master_checklist_open.md. Historical findings are reconciled in the master checklist; unchecked boxes here are not an active work queue. [Current register](../../audits/master_checklist.md).

# PhaseFinder — master checklist, filtered to open items only

Generated from `docs/audits/master_checklist.md`: only items whose code has at least one
box that is not `[x]` (i.e. `[ ]` or `[~]`) are included below, in original document order.
Fully-checked items, the front-matter legend, Section 11's uncoded final-gate checklist, and
the appendices are omitted. Each item's full original text (status line, all boxes, and any
explanatory prose) is reproduced verbatim.

---

# Section 1 — Scientific modeling correctness

### MODEL-02 — The −1.5% G1 offset — DIAGNOSED, and it is not a location error

**Priority:** P0 · **Status:** `[~]` diagnosed 2026-08-19; both investigation boxes closed by measurement, the fix box re-scoped

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

### MODEL-07 — Async/sync BIC selection was removed and should return — RE-MEASURED, still blocked

**Priority:** P2 · **Status:** [~] **stays blocked 2026-08-19.** MODEL-02 is diagnosed but deliberately not *fixed*, and this item's blocker is that residual bias. Re-measured rather than assumed; the numbers are below.

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

### SCI-03 — Convergence criteria and reasons must be truthful

**Priority:** P0 · **Status:** `[~]` 1/2 boxes closed — UI half closed by UI-01; benchmarking box correctly left open (no candidate "stricter" criteria defined anywhere to benchmark)

Termination states, gradient criterion, and diagnostics are implemented; `apply_result_contract()` overrides contradictory `converged: true`.

- [x] Show nonconvergence prominently in sidebar/table/export; disable authoritative phase reporting unless explicitly reviewed. **Implemented by UI-01** (`master_checklist.md:906`, which explicitly names this as the box it closes) — the `⚠`-in-text-content marker travels with every surface (table, sidebar, TSV, SVG `<desc>`/summary text) via the single `fraction_trust_reason()`/`format_fraction_cell()` pair, weight-700 + non-colour cues survive greyscale/forced-colors, and `role="status" aria-live="polite"` announces the result to screen readers. **One clause of this box's literal wording is superseded by a later, deliberate design decision, not silently unmet**: `apply_result_contract()` (`result_contract.js:503-513`) explicitly does **not** withhold the phase-fraction number on nonconvergence — its own comment states the FlowJo-style rationale ("whether to TRUST a fit is ultimately the user's call, so we always present the fractions we actually computed... and rely on the warnings and the goodness-of-fit statistic to let the user judge"). So nonconvergence is shown prominently (satisfying the first half) but does not *disable* the number the way the box's second clause literally asks — it qualifies it instead, which is the intentional, documented product choice this project settled on rather than an oversight.
- [ ] Benchmark stricter criteria against existing good fits to avoid excessive false nonconvergence. **Genuinely not attempted — the box names no candidate criteria to benchmark.** The current LM optimizer's convergence tolerance is a single fixed constant (`js/analysis/math/lm_solver.js:11`, `tolerance: 1e-7`, plus a `stepTolerance`/`maxIterations` pair); nowhere in the codebase, `docs/`, or this checklist is there a proposed *stricter* value or an alternative gradient/step criterion to compare it against — "stricter" is undefined. Real "existing good fits" data does exist for this locally (`tests/validation/validation_test_data/external_fcs/` — 38 real FCS files including the 30-sample FlowJo/FlowReader reference set at `datasets/flowjo_async_djf/flowjo_djf_reference.json`, gitignored per the private-data convention), so this is not blocked the way QC-CAL-01 is; what is missing is the candidate criteria and the acceptable false-nonconvergence-rate threshold to test them against, both of which are judgment calls this checklist item does not make. Deliberately left open rather than inventing an arbitrary "stricter" number and reporting a benchmark result no one asked for.

### STAT-01 — Poisson input rejection and bound auditing

**Priority:** P1/P2 · **Status:** `[~]` **largely implemented but never ticked** — reconcile

`PoissonInputError` exists (`js/analysis/math/poisson.js:30`); `constraint_audit.js` derives bounds from each model's published `bounds`.

- [ ] Verify each sub-item against the tree and tick with evidence pointers.
- [ ] Emit exact constraint residuals and active-bound diagnostics.
- [ ] One focused test triggering each configured bound/joint constraint warning.
- [ ] Calibrate reduced-deviance and residual warning thresholds against independent data. *(shared with the QC calibration study, QC-CAL-01.)*

### UNC-01 — Uncertainty, identifiability, and sensitivity reporting

**Priority:** P1 (publication gate) · **Status:** `[~]` both layers built and measured; neither is wired into the fit pipeline yet

**Problem:** No uncertainty reporting existed at all. A fitted percentage was presented as a point estimate with no interval.

New module `js/analysis/cell_cycle/uncertainty.js`, fed by a Jacobian evaluated once at the solution in **natural** parameter units (`fit_engine.js:159-174` → `solutionJacobian`; the optimizer's own Jacobians are in transformed logit/log-area coordinates and are discarded each iteration, so they cannot be reused). Published on the normalized result of both `dean_jett` and `dean_jett_fox` as `uncertainty`, with its warnings folded into `result.warnings` so a consumer reading only that list still sees a nonreportable fit. 35 new browser checks in `tests/unit/driving_code/unit_tests_uncertainty.py`; suite 783 → **818/818**.

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

### VALID-01 — Independent scientific validation

**Priority:** P0 before any publication-grade claim · **Status:** `[~]` 5/9 boxes closed (1, 2, 7, 8 from a prior session; 3 newly credited this session); 2/9 already partial; 2/9 blocked on resources this session cannot fake

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
- [ ] Investigate bootstrap/profile-likelihood intervals. *(overlaps UNC-01, which has already built the resampling/interval-method layer; this box is about extending that comparison to bootstrap/profile-likelihood specifically and remains open.)*
- [x] Identifiability/restart/condition diagnostics distinguishing precise-looking but weakly identified fits. — already implemented, not previously credited here: `uncertainty.js`'s `multistartAgreement()` (`js/analysis/cell_cycle/uncertainty.js:417-472`) reads the optimizer's own per-restart audit trail (`fit.attempts`) to distinguish genuine multimodality (converged restarts disagreeing on parameters despite indistinguishable deviance) from mere restart dispersion (worse local minima), and `identifiabilityWarnings()` (`uncertainty.js:500-628`) turns rank/condition/interval/multistart evidence into a tagged warning vocabulary (`rank_deficient`, `ill_conditioned`, `parameter_correlation`, `multimodal_optimum`, `restart_dispersion`, etc.), each carrying `nonreportable: boolean` so GATE-01 can refuse to publish an unidentified fit. Wired into production for both `dean_jett.js:427,435` and `dean_jett_fox.js:774,782`. Watson (`watson_pragmatic.js`, `watson_classic.js`) is confirmed to have **zero** hits for any uncertainty/multistart/`fitPoissonModel`/`attempts` terms — structurally exempt, not an unaddressed gap, because Watson never runs the iterative multi-start optimizer this diagnostic reads from (it's a local asymmetric-window peak fit, §5.5).
- [x] Document validated scope, unsupported inputs, remaining differences. — added a consolidated "Validated scope, unsupported inputs, and remaining differences" section to `docs/scientific-result-contract.md`. It is an index, not a restatement: what's been checked (FlowJo agreement scope, SCI-07 optimizer benchmark, VALID-01 box 2 component-grid checks, UNC-01 coverage collapse under contamination), what has explicitly not been checked (multi-instrument datasets, bootstrap/profile-likelihood intervals, domain-expert review, CLOCCS/Watson's exclusion from cross-model claims), and the known FlowJo differences already on record — each claim links to its evidence rather than re-deriving it.
- [ ] Domain-expert review before using "validated", clinical, diagnostic, or publication-grade language. — cannot be performed by an AI; same boundary as the dataset-sourcing box above.

### FUTURE-01 — Hierarchical/cross-sample models

**Priority:** P3 · **Status:** correctly deferred

- [ ] Complete VALID-01 and calibration-aware batch work first.
- [ ] Define which parameters may pool; retain explicit between-sample variance rather than hard equality.
- [ ] Require verified batch/calibration membership; preserve per-sample diagnostics and outlier handling.
- [ ] Validate under both correct and violated sharing assumptions, plus leave-one-out sensitivity.

### AMBIG-01 — Two ambiguities a single histogram cannot resolve

**Priority:** P1 · **Status:** (a) closed this session — the guess was never silent in code, and its wording is now explicit; (b) still open, deliberately not attempted (see below)

**Problem:** (a) A pure G1 and a pure G2 population produce histograms identical up to an x-scale factor. `inferred_g2` always assumes the lone peak is G1 — an **unmarked guess**, silently wrong on a G2-arrested sample. (b) (1C,2C) and (2C,4C) are both ~2:1; smoothing destroys the width evidence, and two local discriminators were tried and both provably failed.

*User decision on record: defaulting to G1 is acceptable for automated testing; in real use the user moves the regions.*

- [x] Surface the single-peak case as **ambiguous, requiring review**, rather than silently assuming G1. Two things were already true in code before this session, confirmed by reading: the bulk "Run All" auto-fit flow already treats any `peakDetection.status !== "detected"` (including `inferred_g2`) as requiring review via `peak_detection_requires_review()` (`modeling_state.js:53-63`) and withholds auto-acceptance from those rows (`if (isShared || !reviewRequired) accept_peak_regions(row);`, `modeling_ui.js:687,733`); and the single-sample "Identify Peaks" panel never auto-accepts anything at all — `accept_peak_regions()` is called from exactly one place, `on_accept_click()` (`peak_review_ui.js:492-495`), which only fires on an explicit user click of the Accept button. What was missing was that the guess itself was unmarked in the panel's wording: the status line showed only the generic label "G2/M inferred" plus raw reason codes (`NO_PLAUSIBLE_DETECTED_PAIR`, `G2_INITIALIZED_FROM_EXPECTED_RATIO`), never stating in plain language that the visible peak was assumed to be G1. Fixed with a one-line addition to `status_text()` (`peak_review_ui.js:260-271`): for `inferred_g2` specifically, the status line now reads "...Only one peak was found; the region below assumes it is G1 and estimates G2/M from it — verify before accepting, since it could be G2 instead." Text-only change, no new detection logic.
  A second, deeper gap was found via this map's own D9 dependency note (below): reviewing and accepting an `inferred_g2` selection satisfied `model_preflight()`'s existing `REGIONS_UNREVIEWED` block, but nothing downstream (export, table, session, plot) retained any trace that the acceptance was of an ambiguous single-peak guess — an accepted `inferred_g2` fit was indistinguishable from a confident `detected` fit once reviewed. Fixed by threading `peakDetection.status` through the contract: `model_preflight()` (`result_contract.js`) now returns `peakDetectionStatus` in its bundle; a new frozen `RESULT_REASON.REGIONS_AMBIGUOUS_SINGLE_PEAK` code was added; `apply_result_contract()` pushes a non-blocking warning with that code whenever `preflight.peakDetectionStatus === "inferred_g2"`, naming the G1 assumption and noting the sample could be G2-arrested instead. Refusal already existed (`REGIONS_UNREVIEWED`); this adds the qualification half, so a `detected` fit and a reviewed `inferred_g2` fit remain distinguishable to every consumer that reads `warnings`.
  New regression test: `tests/unit/driving_code/unit_tests_gate_contract.py`, `'AMBIG-01/D9: an inferred_g2 (single-peak) selection is preflighted through and qualified with a warning, not silently accepted'` — asserts `peakDetectionStatus` is carried, the warning is present for `inferred_g2` and absent for `detected`, and the result stays `validForReporting: true` (qualified, not refused).
  861/861 unit tests pass (860 pre-existing + 1 new).
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

### DOMAIN-01 — Visual viewport separated from scientific fit domain

**Priority:** P1 · **Status:** `[~]` 2/4 boxes closed this session — the other 2 are a real, documented gate, not an oversight

Per-fit coverage audit exists and is wired into every fit; `componentTailCoverage` is populated; display-only framing writes `axis_range_override`, never `analysis_domain_override` (`js/plotting/peak_focus_range.js`, `js/plotting/data.js`).

- [x] Persist domain, bin edges/count, underflow, overflow, and component tail coverage in result provenance. `fit_cell_cycle_model()` (`modeling_state.js:~549-570`) builds `result.histogramProvenance = { domain, binEdges, binCount, counts, underflow, overflow, binnedCount, retainedCount, componentTailCoverage }` on every fit — not opt-in. Verified against a real fit by `unit_tests_domain_sensitivity.py`: `"a real fit stores its exact domain, bin grid, and exclusion counts"` (binEdges.length === binCount+1, `underflow + binnedCount + overflow === retainedCount`, every phase has a finite `componentTailCoverage`).
- [x] Define warning/invalid thresholds for excluded observed events and modelled mass. `js/analysis/cell_cycle/domain_sensitivity.js`: `EXCLUDED_OBSERVED_WARNING_FRACTION`/`_INVALID_FRACTION` (0.5% / 5%) and `MODELLED_TAIL_WARNING_FRACTION`/`_INVALID_FRACTION` (2% / 10%), each with a rationale comment. `domainCoverageAudit()` applies them and is the **one and only** caller wired into the real fit path (`modeling_state.js:18,581` imports and calls it on every result); on `coverage.status === "invalid"` it sets `result.validForReporting = false` — a genuine block, not just a warning label. 6 passing tests in `unit_tests_domain_sensitivity.py` cover clean/warning/invalid boundaries for both the excluded-observed and modelled-tail halves, plus that the thresholds travel with the audit for display.
- [ ] Sensitivity analysis across supported bin counts and reasonable domain perturbations. **Implemented but never invoked — does not tick.** `analyzeDomainSensitivity()` (`domain_sensitivity.js`) refits across `DEFAULT_SENSITIVITY_BIN_COUNTS = [64, 128, 256]` × `DEFAULT_DOMAIN_PERTURBATIONS` (baseline, trim 2% left/right/both), reports `maxShiftPercentagePoints` per phase and `modelChoiceStable`, and is correct by test (`unit_tests_domain_sensitivity.py`, 6 passing cases: stable-answer zero-shift, grid-dependent drift flagged past `FRACTION_SENSITIVITY_INVALID_PP`, a between-tolerances case that warns not blocks, unstable model choice across the grid, the sweep genuinely re-bins/re-domains, and a throwing variant is recorded rather than silently dropped). But `grep -rn "analyzeDomainSensitivity" js/` finds it only in its own definition and doc-comment — `modeling_state.js` imports `domainCoverageAudit` alone (line 18), never `analyzeDomainSensitivity`; no UI trigger, export gate, or other caller exists anywhere in `js/`. Same house rule already applied to `resampling.js` under UNC-01 (`master_checklist_map.md` PROGRESS LOG, 2026-08-19): a library the app never invokes does not tick a reporting box, however correct and tested it is in isolation.
- [ ] Block or qualify results whose fractions/model choice exceed documented sensitivity tolerances. **Half-done, left unchecked.** The coverage-audit half already blocks in production (see box 2's `validForReporting = false` wiring) — but this box, following directly from box 3, is about acting on the *sensitivity sweep's* verdict specifically, and since `analyzeDomainSensitivity()` has no caller (box 3), nothing in the running app can block or qualify a result on sensitivity grounds. `unit_tests_domain_sensitivity.py`'s `"an invalid coverage verdict withholds the result from reporting"` test deliberately shows the two mechanisms are separate: `apply_result_contract()` alone does *not* enforce the coverage verdict (`applied.validForReporting === true` even though `audit.status === "invalid"`) — the block comes from `modeling_state.js` applying the audit result afterward, a wiring that has no sensitivity-sweep equivalent to apply.

### PEAK-01 — Calibrated or reviewed peak initialization

**Priority:** P1 · **Status:** `[~]` 3/3 boxes addressed this session — 2 fully closed, 1 has a genuine external-data gate (same shape as QC-CAL-01)

- [~] Calibrate thresholds on independently annotated histograms; **do not present the confidence score as a probability** (it currently reads as one). — **presentation half closed, calibration half blocked on the same missing resource as QC-CAL-01.**
  - Presentation: `js/analysis/cell_cycle/peak_review_ui.js`'s `status_text()` formerly rendered `peakDetection.confidence` (a `clamp(0.45*score + 0.25*marginEvidence + 0.20*posteriorLike + 0.10*candidateFloor, 0, 1)` weighted heuristic computed in `peak_detection.js:507`, never calibrated) as `"${confidence}% confidence"` — a string that reads as a calibrated probability of correctness. Now formats it as `"heuristic score N/100, uncalibrated"` (no `%` sign, the word "uncalibrated" is explicit). `npm run test:unit`: 860/860, no regression — no test asserted the old `"% confidence"` string.
  - Calibration: doing this for real needs a histogram set with an independently annotated (human- or orthogonal-instrument-derived) correct/incorrect peak-pair label per case, so threshold choices can be scored against ground truth the detector did not produce. This project has none — the only "truth" available is the synthetic-fixture generator's own parameters (used below for box 3) and the 30-sample FlowJo comparison set (which records fitted means, not a peak-detector correct/incorrect verdict). Calibrating thresholds against either would be calibrating the detector against itself. **Cannot be done without that dataset — not attempted, per the same principle as QC-CAL-01.**
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

---

# Section 4 — UI, UX, and accessibility

### UI-02 — Bulk-fit failures are misattributed to the user

**Priority:** P1 · **Effort:** ~2 hours · **Verified**

**Problem:** `modeling_ui.js:583` and `:663` hard-code the reason `"User cancelled bulk fitting"` on cancellation paths regardless of actual cause. The resulting summary reads *"0 converged/reportable; 0 computed but did not converge; 0 detection failed; 0 fit failed; 3 cancelled; 0 skipped"* — five of six terms are zero and the sixth is wrong. (`:700` does distinguish aborted from not-reached; this is two paths, not three.)

- [ ] Pass the real cause through each cancellation path.
- [ ] Suppress zero-valued terms from the summary sentence; report only what happened.
- [ ] Test: a QC-blocked bulk fit must not report "user cancelled".

### UI-05 — 200% zoom forces desktop into the mobile layout

**Priority:** P1 · **Effort:** ~0.5 day · **Source:** visual audit

**Problem:** `css/responsive.css` declares exactly one breakpoint, `@media (max-width: 820px)`. At 200% zoom a desktop viewport falls below it and drops into the mobile stacked layout. That is a WCAG reflow failure, and it also means one breakpoint serves everything from 320px to tablet.

- [ ] Verify at 320 / 390 / 768 / 820 / 1024 and at 200% zoom.
- [ ] Add a second breakpoint if the metadata table or sidebar demands different treatment at phone vs tablet width.
- [ ] Ensure zoom-induced narrow viewports get a layout appropriate to *zoom*, not to *phone*.

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

**Priority:** P2/P3 · **Status:** `[~]` 5/6 boxes closed this session — box 6 is a genuine, honestly-recorded gap for 4 of its 5 sub-items

- [x] Maintain a small immutable, licensed golden FCS corpus with a SHA-256 manifest and expected semantics from an independent reader. — `tests/validation/validation_test_data/external_fcs/manifest.json` already does exactly this for two real, non-synthetic sources: a single MIT-licensed instrument file (`fcsparser_miltenyi_pbs_fcs31.fcs`, from the `fcsparser` test corpus) and a CC0 published dataset (Rodighiero 2024 eLife FUCCI/EdU Kasumi-1 and MDA-MB-231 acquisitions, with manual-gate phase percentages as reference results). Every fixture entry carries a `sha256`, an `oracle` block giving FlowIO 1.4.0's expected header offsets/first-parameter values (the same independent reader used for `independent_reader_reference.json`, see box 4), and a `license.spdx` + `redistribution_basis`. `verify.py`/`verify_phasefinder_parser.mjs` re-check the hashes and FlowIO oracle locally. This is a genuine golden corpus with independent-reader semantics — it was simply undocumented as satisfying this box.
- [x] Separate independent golden fixtures from self-generated regression fixtures. — Already structurally true: `tests/validation/validation_test_data/external_fcs/` (real/independent, hand-reviewed, git-ignored payloads) is a separate directory tree with a separate manifest schema from `tests/validation/validation_test_data/synthetic_fcs/` (100% generated, `contains_real_data: false`, tracked in Git, reproducible via `generate_fixtures.py --check`). Each manifest's own `description` field states its category. No code change needed; the separation already exists and is now cross-referenced from `docs/release-and-privacy.md`.
- [x] Keep private biological data outside the public repository; define a reviewed deidentification/ingestion process. — `check:privacy` (`scripts/check-privacy.cjs`) mechanically enforces the outside-repo half. Added a new **"Ingesting non-synthetic validation data (TEST-02 box 3)"** section to `docs/release-and-privacy.md` (next to the existing inventory-table row for this directory) that writes down, as an explicit repeatable process, the four steps the two existing `external_fcs/manifest.json` entries already followed: record upstream provenance, confirm and record the license, do and write down a privacy review, record a hash and (where practical) an independent-reader oracle. States plainly that this is a *human*-reviewed process — the "reviewed" claim is only as good as the review actually done per entry — and that any new addition needs the same write-up, not just a hash. `npm run check:docs` passes after the edit.
- [x] Verify fixture hashes in CI; fail on silent mutation. — Two existing-but-orphaned integrity checks are now wired in. Added `"check:fixtures": "sh scripts/python.sh tests/validation/validation_test_data/synthetic_fcs/generate_fixtures.py --check"` to `package.json` and inserted it into the aggregate `npm run check` chain; verified locally (`"Synthetic FCS corpus is reproducible (93 files checked)."`). Added two new steps to `.github/workflows/security.yml` (runs on every `pull_request` and every `push` to `main`): `generate_fixtures.py --check` (synthetic corpus, TEST-02 box 4) and `generate_flowio_reference.py --check` (`independent_reader_reference.json` freshness against a from-scratch FlowIO 1.4.0 decode) — both pre-verified passing (the latter via a scratch venv with `flowio==1.4.0`, which `requirements-dev.txt` already pins for exactly this script). The `external_fcs/` golden corpus above cannot be hash-verified in CI the same way because its payload files are intentionally git-ignored (box 3); `verify.py`/`verify_phasefinder_parser.mjs` remain the local re-verification path for that corpus, documented as such in the new `docs/release-and-privacy.md` section.
- [x] Record source, license, FCS version/encoding, instrument/transform assumptions, and expected values for every fixture. — Synthetic corpus: manifest-level `license`, `generator{name,version,command,randomness}`, `contains_real_data`; per-case `fcs.encoding`, `fcs.sha256`, `truth`; every generated FCS file also carries its own `$SRC` TEXT keyword (`"100% synthetic; no human or instrument data"`, `generate_fixtures.py:435`). Instrument/transform assumptions are covered at the corpus level by `docs/fcs-compatibility.json`'s compensation/scaling matrix and `docs/fcs-analysis-compatibility.md`. External corpus: per-fixture `upstream{repository_url,commit,source_path,producer}`, `license{spdx,evidence_url,redistribution_basis}`, `format{fcs_version,datatype,byte_order,events,parameters}`, and `oracle.expected_summary` (box 1). Nothing new needed here beyond the box-3 documentation already added.
- [~] Track CI duration, flake rate, artifact size, browser-specific failures, and benchmark drift. — **Artifact size is already tracked**: `scripts/report-artifact-delta.cjs` (`npm run report:size`) computes `{files, bytes, js, css, images}` deltas between base and PR builds and posts a Markdown table to the PR's step summary; already wired into `security.yml` on every pull request. **The other four sub-items have no existing tracking** — grepped the workflows, `scripts/`, and `docs/` for CI-duration capture, flake-retry accounting, per-browser failure breakdowns, and any stored benchmark-history/trend file, and found none. This is a genuine, unimplemented gap, not something fakeable from this project's current data (there is no historical CI run log to backfill from) — recording it honestly rather than inventing a metric.

# Section 8 — Documentation and maintainability

### DOC-02 — Stale claims in shipped docs

**Priority:** P2

- [ ] `README.md` lines 18–19 and 274 still offer **"Automatic model selection"**, which no longer exists; line 274 also omits Watson Classic and CLOCCS.
- [x] `help/help-modeling.html` model list, Fit All description, honest-reporting guidance, and ambiguity warnings — *corrected 2026-08-14.*
- [x] Help sidebar navigation unified across all 9 sub-pages — *corrected 2026-08-14.*
- [ ] Re-check the "Fit All doesn't fill the table" report in the running app (see Appendix A). Its source, `todo.md`, was archived on 2026-08-15 — the y-axis clamp and Phase 2 diagnostic-plot items it also carried are verified done and need no edit there.
- [ ] `help-getting-started.html` and `help-troubleshooting.html` have not had a line-by-line pass against the current UI; their QC and session sections likely carry the same drift `help-modeling.html` had.
- [ ] Document the residual panel and fit export in help **with** those features (UI-13, FEAT-02).

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

- [x] `git rm -r js/analysis/djf/` — 21 files, 6,630 lines. *Done 2026-08-17, owner-approved.*
- [x] `djf-pipeline_report.md` archived to `docs/archive/audits/archive/` — it reviews this dead code and reports all 8 findings resolved, which is accurate about code nobody runs. *Done 2026-08-15.*
- [x] `docs/djf_impl_plan.md` (46 KB) archived to `docs/archive/audits/archive/` — it plans this same dead directory. *Done 2026-08-17; all five inbound links repointed.*
- [ ] `npm run check:imports && npm run test:unit` after.

### CLEAN-02 — Deduplicate documentation

**Priority:** P3

- [x] `docs/plans/dean_jett_fox_implementation.md` removed — byte-identical to `docs/dean_jett_fox_implementation.md`, which is the copy referenced by five other documents. *Done 2026-08-15.*
- [ ] Resolve five near-duplicate HTML pairs — `docs/X.html` vs `docs/audits/X.html` (color_use, user_controlled_vars, djf_diffs) and `docs/X.html` vs `docs/workflows/X.html` (both graph files). Sizes differ by 5–120 KB, so these are *different generations of the same document* and the filename does not say which is current.
  - **Graph pair resolved (2026-08-17):** `docs/workflows/` deleted. `docs/build_diagram_pages.py` only ever writes to `docs/`, so the `docs/workflows/` copies could not be anything but a stale generation, and would have drifted again after every rebuild. Three `docs/` vs `docs/audits/` pairs remain.
  - **Evidence (2026-08-15):** for all three `docs/audits/` copies, the relative `.md` links are broken — they resolve against `docs/audits/` but the targets (`djf_impl_plan.md`, `dean_jett_fox_implementation.md`, `djf_diffs.md`) live in `docs/`. The `docs/` copies resolve cleanly. The `docs/audits/` copies are also 5–72 bytes larger. **This points to `docs/` as canonical and the `docs/audits/` copies as misplaced duplicates**; confirm before deleting.
  - **Note (2026-08-17):** two of those three link targets have since been archived — `djf_impl_plan.md` and `djf_diffs.md` now live in `docs/archive/audits/archive/`, and both HTML copies' "View Markdown" links were repointed at the new location. That repoint does not change the verdict above: the `docs/` and `docs/audits/` HTML files are still two generations of the same page, and one of them is still stale. Only `dean_jett_fox_implementation.md` remains at its original `docs/` path.
- [ ] Fix the tracking inconsistency: `needs_to_be_fixed_ux.md` is **tracked** while `needs_be_fixed_frontend_dev.md` is **untracked**, though `working_tree_commit_plan.md` says both should be untracked.
- [x] Archive the superseded sources listed at the top of this document — all 8 moved to `docs/archive/audits/archive/` with a provenance README. *Done 2026-08-15.*

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

### FEAT-03 — Optional components and multiple ploidy (M7)

**Priority:** P3 · Deferred behind VALID-01.

- [ ] Normalized truncated-exponential debris.
- [ ] Sub-G1-like truncated component — **never labelled apoptosis without orthogonal evidence.**
- [ ] Multiple-ploidy support.

### FEAT-04 — CLOCCS to production (M8)

**Priority:** P3 · **Status:** registered as `cloccs` v`0.1.0-unverified`, `capabilities.unverified: true`, joint-series scope, worker + client + synthetic generator + unit suite all exist. Box 2 closed this session; box 1's full 9-strain diagnostic run completed this session, and separately, box 1 now also has a real reference-bearing comparison against the Li 2026 CLOCCS dataset (see below); box 3 assessed and remains open — see below.

- [x] Validate against real synchronized data. `../test_flow_data/AlphaFactorSynchronizedHaplodis_…` (121 files, 9 strains) has **no reference values**, so this can only ever be diagnostic evidence, not pass/fail validation — recorded here as such, not as a pass. The prior 115/116-asynchronous result came from `docs/audits/cell_cycle_model_investigation_handoff.md` §5.6's probe, which built rows with `pnr: {}` and silently disabled Structural QC's `$PnR` saturation ceiling — that failure belongs to the probe, not to CLOCCS or the dataset. Re-run this session through the real app code path (`tests/validation/driving_code/run_alphafactor_cloccs.py`, new): loopback-only local server serving the repo's parent directory for the run's lifetime only (never copies/symlinks the private dataset into the repo), real `FCSParser`/`generateHistogram`/`CLOCCS.fitCloccsForStrainAsync`, real per-file `$PnR` (1000, unsaturated — confirmed directly from file bytes, nothing like the probe's synthetic 9,500 ceiling-bypass). One correction found and fixed along the way: the instrument's PI detector is spectrally shared with other dyes, so every file's `$PnS` label is `PI/LSS-mKate/PerCP-A` (confirmed via the real parser against all 9 strains' two filename conventions), not plain `PI` — the script matches the leading token.

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

---

---

