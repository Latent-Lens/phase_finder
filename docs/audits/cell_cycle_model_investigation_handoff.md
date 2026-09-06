# Cell-cycle model investigation — handoff

**Date:** 2026-07-31 (§1–§10) · updated later the same day (**§11**)
**Branch:** `cell-cycle-report-warn`
**Working tree:** uncommitted. Unit suite **756/756**.
**Origin:** work on the unchecked SCI / VALID / GATE / STATE / PEAK / DOMAIN / QC / STAT / LEGACY / UNC / PERF-MODEL / FUTURE items in the codex remediation checklist (since merged into
[`docs/audits/master_checklist.md`](./master_checklist.md); the original is archived at
`docs/archive/audits/archive/codex_audit_of_full_project_remediation_checklist.md`).

> **This document is a research log, not a task list.** Open work lives in the master checklist.
> This is kept live because it records what was *tried and measured* — including four changes that
> made results worse — so those are not re-attempted. Keep it current.

> **Read §2 and §5 before touching the model.** Five separate model changes were
> attempted and measured; four made things worse and one is unattributed. The
> validated baseline is `HEAD`. Do not re-attempt any of §5 without reading why
> it failed.
>
> **Then read §11**, which is a later pass over the same problem. It resolves the
> ten test failures, corrects §4 (the revert it prescribes does not work) and §6
> (the diagnosis is incomplete in a way that matters), and replaces the framing of
> §8.1. Sections carrying a ⚠️ or ✅ marker have been superseded in part; the
> unmarked text stands.
>
> **Current one-line state:** peaks-first estimator, at the `HEAD` baseline on the
> 30-sample set (`all_pass` 7/30 vs 8/30) with 30/30 fits now converged and
> reportable. The dominant remaining defect is that **G2's mean is placed too low
> on 30 of 30 real samples** (§11.4.1) — that is where the next effort goes.

---

## 1. The one-line summary

Peak detection is **not** broken. The real defect is **S phase over-fitting into
G2**, and freezing the G1/G2 peaks at their clean-flank estimate is what holds it
in check. Every attempt to improve on that made the reported fractions worse.

---

## 2. Ground truth: the numbers that matter

All from the 30-sample FlowJo Dean–Jett–Fox reference set
(`tests/validation/validation_test_data/external_fcs/datasets/flowjo_async_djf/`),
asynchronous budding yeast, DNA channel `FL7-A` / `GFP/FITC-A` (SYTOX Green).
Run via `tests/validation/driving_code/validation_tests.py --flowjo-only`.

### 2.1 Baseline vs the working tree, matched QC config (`qc_structural`)

| metric | `HEAD` (frozen clean-flank peaks) | working tree (joint fit) |
|---|---|---|
| `g1_mean` ratio | 0.985× | 0.996× |
| %G1 median | +2.8pp | +0.3pp |
| **%S median** | **−2.9pp** | **+12.0pp** |
| %G2 median | +6.4pp | −6.8pp |
| **%S within tolerance** | **28/30** | **11/30** |
| **all_pass** | **8/30** | **0/30** |

**`HEAD` is materially better.** The joint fit buys a small G1 gain and pays for
it with a large S regression. This is the "S balloons to swallow a peak"
degeneracy that commit `41d4442` introduced clean-flank fitting to prevent.

### 2.2 Which criterion fails under `qc_structural` (working tree)

```
g2_g1_ratio     5/30 pass   0.970×
%G2             7/30 pass   -6.8pp
%S             11/30 pass  +12.0pp
g2_mean        15/30 pass   0.982×
%G1            17/30 pass   +0.3pp
g1_mean        20/30 pass   0.996×
```

G1 is right in both position and fraction. The failure is entirely S↔G2.

### 2.3 QC configuration matters enormously

| QC config | `g1_mean` median | within ±5% | period-doubled |
|---|---|---|---|
| `qc_structural` | 0.996 | 23/30 | **0/30** |
| all four gates | 1.015–1.023 | 20–21/30 | 0/30 |
| `qc_singlet` | 1.030 | 18/30 | 0/30 |
| `qc_cellgate` | 1.086 | 8/30 | 2/30 |
| No QC | 1.086 | 8/30 | 2/30 |

**Structural QC does nearly all the work** — it applies the `$PnR` saturation
ceiling to the DNA channel, which removes the extreme aggregate tail. Cell-gate
and Time QC alone are indistinguishable from no QC for peak placement.

Fitted fractions by config, against FlowJo's medians (%G1 19.1, %S 25.2, %G2 48.5):

| config | %G1 | %S | %G2 |
|---|---|---|---|
| `qc_structural` | **19.1** | 33.5 | 40.7 |
| all four gates | 26.9 | 20.7 | **48.0** |
| `qc_singlet` | 25.6 | 11.2 | 57.1 |

Neither config matches on both. **Adding gates is not "making it worse"** —
singlet gating correctly removes G1–G1 doublets (which sit at 2C and are counted
as G2), which enriches %G1. It diverges from FlowJo because FlowJo's own gating
is undocumented; the reference manifest states:

> *"FlowJo's exact pre-fit gating (debris/singlet gates, live-cell scatter gate)
> is not captured in the workbook; residual gating differences are a documented
> source of small discrepancies."*

**Do not read `qc_structural` scoring highest as "use less QC."** It is the
closest *configuration match* to an unknown reference, not necessarily the most
correct analysis.

### 2.4 Independent confirmation that the peaks are findable

`tests/external_tools/` runs a two-component Gaussian mixture (sklearn, the same
EM routine CytoFlow's `GaussianMixtureOp` wraps) on the raw DNA events:

| | within ±5% of FlowJo G1 | median |
|---|---|---|
| independent mixture | 23/30 | 1.001× |
| PhaseFinder, `qc_structural` | 23/30 | 0.996× |

Two independent methods agree. The peaks are findable and we find them.

---

## 3. What landed and should be kept

All orthogonal to the estimator. Unit tests included.

| ID | Change | Files |
|---|---|---|
| **STAT-01** | Structured rejection of non-finite/negative Poisson inputs (`PoissonInputError`); constraint audit derived from each model's published `bounds` so the two cannot drift. Also fixed `Int32Array.map` truncating deviance residuals to integers. | `js/analysis/math/poisson.js`, `js/analysis/cell_cycle/constraint_audit.js` |
| **GATE-01** | `apply_result_contract()` now *requires* a preflight bundle and stamps `contractVersion`. `is_reportable_result()` / `get_active_model_result()` demand the stamp, so an un-validated result cannot masquerade as validated. | `result_contract.js`, `pipeline_state.js` |
| **DOMAIN-01** | Per-fit coverage audit (excluded observed events, modelled tail mass) with documented thresholds; opt-in re-binning/domain sensitivity sweep. `componentTailCoverage` now populated. | `domain_sensitivity.js`, `modeling_state.js` |
| **STATE-01** | Sessions record `model_version`; restore labels drift `recomputed_new` vs `reproduced`. `settingsApplicability` records settings a model cannot consume. | `modeling_session.js`, `modeling_state.js` |
| **LEGACY-01** | Legacy bridge marked exploratory/unvalidated and refused by the contract; removed its leaks into the canonical fit table and plot accessibility text. Documented that the aggregate term is `0.5·p·F(x/2)`, **not** Bagwell self-convolution. | `legacy_bridge.js`, `render.js`, `modeling.js` |
| **SCI-06** | `robust_shared_regions()` refuses a proposal set whose G1 centres disagree (bimodal split), while still letting the median resist a *lone* outlier. Measured: 15 proposals split into clusters at 192 and 341; their median (306) matched neither. | `modeling_ui.js` |
| — | Region width decoupled from optimizer step scale and S seed. Measured spread across tight/default/wide regions: **9.2e-09 pp** in %S. | `dean_jett_fox.js` |
| — | Display-only x-axis framing on G1/S/G2 with debris-valley floor. Writes `axis_range_override`, never `analysis_domain_override`. | `peak_focus_range.js` |
| — | X-axis change now triggers a refit when a fit exists (Y is the count axis and cannot change binning — deliberately excluded). | `axis_modal.js` |

**Tooling:**
- `tests/validation/driving_code/render_fit_review.py` — per-sample HTML review:
  histogram, peak-region bands, filled G1/S/G2 components in the app's colours,
  detector candidates, active constraints. Strain sections, timepoint order.
- `tests/external_tools/` — isolated venv, independent-tool comparison, HTML report.

---

## 4. What should be reverted — ⚠️ SUPERSEDED, see §11

> The plan below was **not** followed, because a plain revert of these three
> files does not work and the reason it does not work matters. `shared.js` at
> `HEAD` exports `quadraticProfileMinimum`, not `sPhaseProfileMinimum`, and
> `constraint_audit.js` — the new STAT-01 module §3 says to **keep** — imports
> `sPhaseProfileMinimum`. So does `dean_jett.js`, and so do
> `unit_tests_stat_constraints.py` and `unit_tests_cell_cycle_model_shared.py`.
> Reverting `shared.js` therefore breaks STAT-01. **The Bernstein basis is load-
> bearing for work this document elsewhere says to keep**, so it stays.
>
> What was actually removed is the async/sync BIC selection, for a stronger
> reason than "it was landed with the joint estimator": it is **unidentifiable
> while the peaks are frozen** (§11.1).

The original text:

`js/analysis/cell_cycle/models/{dean_jett_fox,dean_jett,shared}.js` back to `HEAD`.

This discards two changes the user approved:
- **Bernstein basis** for the S-phase profile (nonnegative by construction)
- **async/sync BIC selection** per the reference implementation (§7)

Both were landed *together with* the joint estimator and never validated
separately. Re-land them **one at a time**, each validated against the 30-sample
set before keeping.

---

## 5. Failed attempts — do not repeat without reading this

### 5.1 Restoring the joint estimator ❌ **worst regression**

**Hypothesis:** freezing the peaks biases them; a joint fit seeded from the
clean-flank estimate would be unbiased.
**Synthetic evidence (misleading):** on DJF-generated histograms the frozen
estimator showed `g1CV` 0.084 vs a true 0.060 (+40%) in *every* configuration,
and starved %S by 3–21pp, worsening monotonically with S fraction. Freeing the
peaks recovered `g1CV` = 0.060 exactly and held S error to ~−1.5pp.
**Real-data outcome:** `all_pass` 8/30 → **0/30**; %S −2.9pp → **+12.0pp**.
**Why the synthetic evidence lied:** the fixtures were generated by DJF's own
equations with clean, well-separated Gaussians. Real yeast has skew, debris and
overlapping tails, where the freed S term expands into G2.
**Lesson:** same-model-family synthetics are not validation. This is VALID-01's
entire point.

### 5.2 G2 region ratio clamp to [1.8, 2.2]× G1 ❌

**Hypothesis:** constraining the G2 *region* to the biological band would stop it
being placed adjacent to G1 on arrested samples.
**Outcome:** squeezed the G2 region from ~300 channels to 67 on four samples;
the over-constrained fit collapsed `g1CV` from its **upper** bound (0.30) to its
**lower** bound (0.01) — trading one boundary degeneracy for another. `fit/ref`
worsened on all four (1.068→1.186, 1.120→1.214, 1.154→1.298, 1.081→1.178).
**Also could not have worked:** (1C,2C) and (2C,4C) are *both* ~2:1, so no ratio
constraint can distinguish them.
**Status:** reverted; rationale left as a comment in `peak_detection.js`.

### 5.3 4σ region width cap ⚠️ kept, but did not do what was claimed

**Hypothesis:** region width perfectly separated correct from period-doubled fits
(every region ≤4.0σ correct 16/16, every region ≥4.5σ doubled 14/14), so capping
it would prevent 10–14 of the 14 failures.
**Outcome:** widths dropped 6.8σ → ~2.5σ as intended. Doubling went **14/30 →
13/30**. Fixed **one**.
**Why:** narrowing the window around the *wrong centre* does not move the centre.
Width was a *correlate* of a bad pick (a misidentified broad feature has an
inflated σ estimate), not its cause.
**Lesson:** perfect separation in aggregate data ≠ causal power. Test the
intervention.

### 5.4 Period-doubling correction, position only ❌

**Rule:** no cycling cell holds less DNA than G1, so a well-formed peak at *half*
the chosen G1 proves the choice was doubled.
**Outcome:** promoted a sub-G1 debris spike to G1, breaking the existing
`a sub-G1 distractor peak does not beat the real G1/G2 pair` fixture.
**Bug:** the "debris zone" guard rejected candidates below 25% of G1 — but a
halved G1 sits at 50% *by definition*, so the guard could never fire on the case
it was written for.

### 5.5 Period-doubling correction, position + CV width ❌

**Refinement:** σ = CV × mean, so a real 1C/2C pair shares a CV while debris is
far narrower — use CV compatibility to reject the spike.
**Outcome:** still failed the same fixture.
**Why:** detection smooths at **[1, 2, 4] bins**. A σ=1 debris spike is measured
at √(1²+4²) ≈ **4.1 bins** — indistinguishable from a real σ=4.2 G1 peak. The
smoothing the detector needs destroys the width evidence.
**Conclusion:** the (1C,2C) vs (2C,4C) ambiguity is **not resolvable within one
histogram**. Both discriminators available locally are defeated. See §8.
**Status:** reverted; rationale left as a comment in `peak_detection.js`.

### 5.6 A misconfigured probe that produced a false diagnosis ❌ **methodological**

An ad-hoc drift probe constructed rows with `pnr: {}` (empty PnR map). Structural
QC applies the `$PnR` saturation ceiling to the DNA channel, so **saturation
rejection was silently disabled**. Consequences:
- aggregates at ~9,500 survived → histogram range 0–9,550
- 256 bins → **37 units/bin**; G1's σ was **0.4 bins** — unresolvable
- 12/30 samples had a G1 *region* that entirely excluded FlowJo's G1
- 13/30 fits period-doubled

This produced a confident but **wrong** conclusion that peak detection and
histogram resolution were broken. With `$PnR` present (as in the real app and the
validation harness) structural QC removes the tail and detection is fine (§2.3).

**Lesson:** when a probe disables a pipeline stage, its failures belong to the
probe. Always compare against the harness that drives the real code path.

---

## 6. Current test failures (10) — ✅ RESOLVED, see §11

All in the model layer, all caused by the half-reverted estimator state:

- 3 × tests written for the joint fit (peak-width recovery, deviance, wave
  recovery) — obsolete once peaks are frozen.
- 6 × async/sync selection tests — the selection **cannot converge with frozen
  peaks**. The failing guard is `converged: false`, so `w = 0` on every sample
  and the synchronous form is never selected despite ΔBIC of −107 to −709.
- 1 × `STATE-01: DJF applies ratio/CV` — with peaks frozen, ratio/CV settings are
  inert again (see §9).

> **The `converged: false` diagnosis above is correct but incomplete, and the
> incompleteness is the important part.** The synchronous variant does not merely
> fail to converge — it converges on the *wrong answer* when it converges at all,
> because with frozen peaks the wave fits peak misfit rather than a cohort. The
> `converged` guard was returning the right decision for an accidental reason.
> Measurement in §11.1.
>
> Suite is now **756/756**. Resolution in §11.3 — not by the revert in §4.

---

## 7. The reference implementation

`docs/audits/baselines/dean_jett_fox_javascript_implementation.html` specifies:

- **§3** S-phase profile in the quadratic **Bernstein basis**
  `q_A(z) = w₀(1−z)² + 2w₁z(1−z) + w₂z²` — nonnegative by construction, versus
  our direct `a + bz + cz²` with post-hoc projection.
- **§4** synchronous Fox extension `q_F(z) = q_A(z) + A_F·φ(z; z_F, σ_F)` —
  algebraically equivalent to our `(1−w)q + wT` reparameterisation.
- **§13 + Steps 6–9** fit async and sync separately, select by BIC with guards:
  `ΔBIC > 10`, `bumpFraction ≥ 2%`, cohort inside S phase, restart-stable.
- **Step 7** initialise the cohort from the **largest positive residual** of the
  asynchronous fit, not from a fixed grid.
- **§5** `σ_S(u) = CV₁·u` — **we already match this.**

Differences we do not implement: the BIC convention differs by a constant (deltas
agree); parameter counts differ (they 8 async / 11 sync, we 12).

---

## 8. Open problems

### 8.1 The real defect — restated: **the frozen peaks are biased**
%S +12.0pp / %G2 −6.8pp under `qc_structural` with a joint fit; −2.9pp / +6.4pp
with frozen peaks. Frozen peaks contain it but do not eliminate it. This is where
effort should go.

> **Restated with §11's evidence.** Calling this "S over-fitting into G2"
> describes the *joint* fit's failure. The estimator that actually ships fails in
> the **opposite direction**, and both failures have the same root cause.
>
> On the wave-free two-peak fixture (`TWO_PEAK_TRUTH`, exactly representable by
> the model), the clean-flank estimator returns:
>
> | | fitted | true | error |
> |---|---|---|---|
> | `g1CV` | 0.0842 | 0.060 | **+40%** |
> | `g2CV` | 0.0863 | 0.070 | +23% |
> | `g1Area` | 9339 | 8000 | **+17%** |
> | `g2Area` | 4271 | 3000 | **+42%** |
> | `g2Mean` | 137.5 | 140 | −2.5 ch |
>
> Both peaks come out **too wide and too fat**, so between them they claim area
> that belongs to S. Frozen, they cannot be corrected, and %S is starved by
> ~12pp — same sign as the −2.9pp measured on real data, larger because this
> fixture has more S. The joint fit fails the other way (S expands to swallow
> G2) because freeing the peaks removes the only thing holding S in check.
>
> **So the target is neither "freeze" nor "free" — it is a less biased peak
> estimator.** Freezing an unbiased estimate is what the FlowJo-style approach
> assumes; freezing a biased one is what we actually do. Proof that the rest of
> the model is fine: freeze the same fit at the **true** peaks and the deviance
> drops from 1289.6 to 46.1 (28×) — the S machinery reproduces the data almost
> exactly once the peaks are right.
>
> Three specific, independently testable biases in
> `estimatePeakFromRegion()` / `fit_local_peak()`, none of which is a design
> tradeoff — all three are straightforwardly wrong:
>
> 1. **No baseline subtraction in the width estimate.**
>    `estimateSigmaOneSidedWithinRegion()` walks out from the peak until the
>    smoothed count drops below `0.6 × peak`, using the *absolute* height. A peak
>    sitting on the S-phase pedestal stays above that threshold further out, so σ
>    is inflated. The threshold should be `baseline + 0.6 × (peak − baseline)`.
>    The area estimator has the same gap: `refine_local_area()` sums raw counts
>    over the window without removing the pedestal underneath.
> 2. **Smoothing width is never removed.** The estimate is taken on a histogram
>    Gaussian-smoothed at `smoothingSigmaBins: 2`, so it measures
>    √(σ² + 2²), not σ. This is exactly the arithmetic §5.5 already uses to
>    explain why the *detector* cannot distinguish a debris spike; it simply is
>    not applied here. Deconvolving in quadrature is a one-line correction.
> 3. **The mean is quantized to a bin centre.** `mean: centers[peakIndex]` — no
>    sub-bin interpolation. A three-point parabolic fit around the smoothed argmax
>    is standard and removes up to half a bin.
>
> Measured on the same fixture, each correction applied alone and then together
> (async-fit deviance, true peaks would give 46.1):
>
> | correction | `g1CV` | `g2Area` | deviance | %S (true 26.7) |
> |---|---|---|---|---|
> | none (today) | 0.0842 | 4271 | 1289.6 | 15.0 |
> | + baseline | 0.0842 | 3910 | 1184.0 | 16.2 |
> | + deconvolve | 0.0793 | 4254 | 926.1 | 15.4 |
> | + interpolate | 0.0846 | 4253 | 1316.6 | 15.4 |
> | **all three** | **0.0796** | **3874** | **847.1** | **17.1** |
>
> All three together close roughly a third of the deviance gap and recover ~2pp
> of %S. **They are not sufficient** — `g2Mean` stays ~2.3 channels low because
> the smoothed argmax inside the G2 region is pulled left by S-phase mass, which
> no purely local correction fixes. Getting the rest likely needs the peak centre
> estimated jointly with a coarse S model (one lightweight pass), which is *not*
> the same thing as the joint fit §5.1 rejected: the S term there was free to
> reshape itself, whereas this would only relocate the peaks.
>
> ⚠️ These numbers are all from DJF-generated synthetics, which §5.1 correctly
> warns are not validation. They are diagnostic of *mechanism*, not of benefit.
> Any change here must be measured on the 30-sample set before it is kept.

### 8.2 (1C,2C) vs (2C,4C) is unidentifiable within one histogram
Both pairings are ~2:1; smoothing destroys the width evidence (§5.5). Resolution
requires information from outside the single histogram:
1. **channel calibration** (beads / known control) — fixes 1C absolutely;
2. **cross-sample anchoring** — one acquisition run shares a DNA axis, so samples
   showing two peaks fix 1C for those that don't. Strongest available option;
3. **recorded condition** — metadata already carries `Nocodazole Arrest`;
   α-factor ⇒ G1 arrest, nocodazole ⇒ G2.

### 8.3 A pure single peak cannot be called at all
A pure G1 population and a pure G2 population produce histograms **identical up
to a scale factor on the x-axis**. No within-sample statistic can separate them.
Today `inferred_g2` always assumes the lone peak is G1 and places G2 at 2× — an
**unmarked guess** that is silently wrong on a G2-arrested sample. It should
surface as ambiguous and require review.
*User decision on record:* for automated testing, defaulting to G1 is acceptable;
in real use the user moves the regions.

### 8.4 Synchronized data is unvalidated
`../test_flow_data/AlphaFactorSynchronizedHaplodis_...` (121 files, 9 strains)
has **no reference values**. A partial run classified **115/116 asynchronous** —
the Fox cohort machinery has never fired on real synchronized data. Note those
runs used the misconfigured probe (§5.6), so re-run before drawing conclusions.

### 8.5 Open-source model comparison is not done
Of the requested packages — flowCore, openCyto, flowWorkspace, CytoExploreR,
FlowCal, CytoFlow, FlowKit, scverse/muon — **none implement DJF or Watson**; they
are I/O, transform, gating and calibration frameworks. Only a peak-position
comparison is possible, and that is done (§2.4).
**[flowPloidy](https://bioconductor.org/packages/flowPloidy/)** (Bioconductor)
*does* model DNA-content histograms (Gaussian peaks + explicit debris model) and
would be a genuine model-vs-model comparison. Its install did **not** complete
here — R build dependencies `fs`, `SparseM`, `nloptr` failed to compile. The
runner is written and ready: `tests/external_tools/driving_code/run_flowploidy.R`.
CytoFlow also failed to install (`setuptools.build_meta` backend error, persisted
through `--no-build-isolation`); its GMM op wraps sklearn's, which was used
directly instead.

---

## 9. Smaller findings worth keeping

- **DJF's ratio/CV settings are inert when peaks are frozen.** They constrain
  peak means and widths, which the optimizer never moves. `settings_applicability()`
  records them as not-applied and excludes them from the config hash, so the
  result key stops claiming a difference that does not exist.
  *Status: now actually true in the code.* `dean_jett_fox` was still listed in
  `RATIO_CV_CONSUMING_MODELS` in `modeling_state.js`, so the settings were being
  folded into the config hash and reported as `applied` while changing nothing.
  Removed; `unit_tests_state_reproducibility.py` now asserts the inertness
  directly (same hash, identical parameters, `notApplied` populated).
- **`auto_dj_djf` was retired** at user request, and `model_selection.js` deleted.
  It was *not* dead code — it was the only consumer of the joint estimator and
  implemented the BIC comparison the reference specifies. Retiring it removed the
  architecture §7 prescribes.
- **`js/analysis/djf/`** is an unreachable stale duplicate of the live pipeline
  (nothing outside it imports it). Left alone because two of its files had
  uncommitted edits from another task.

---

## 10. Recommended next steps — partly done, see §11.5

1. **Revert §4.** Restores the validated 8/30 baseline and fixes all 10 test
   failures.
2. **Re-land Bernstein alone** (peaks frozen, no async/sync selection) and
   validate against the 30 samples. Keep only if `all_pass` ≥ 8/30 and %S stays
   near −2.9pp.
3. **Then re-land async/sync selection**, noting it needs free wave parameters to
   converge — verify the guards behave with frozen peaks before trusting it.
4. **Attack §8.1**, the S↔G2 over-fit. That is the actual scientific defect.
5. **Do not** attempt §8.2 with another local heuristic. Use cross-sample
   anchoring or calibration.

**Validation command** (10-way sharded, ~20 min):
```
for i in 0 1 2 3 4 5 6 7 8 9; do
  python tests/validation/driving_code/validation_tests.py \
    --flowjo-only --keep --shard "$i/10" &
done
```
Then aggregate `comparison_*.json` filtering to `qc_structural` for an
apples-to-apples read.

---

# 11. Follow-up session — 2026-07-31 (later)

Picks up from §10. **The §4 revert was not performed**; it does not work as
written (§4's banner). What follows is what was measured, what changed, and what
is still open.

**Unit suite: 756/756.** All ten §6 failures resolved.

## 11.1 The async/sync BIC selection is unidentifiable with frozen peaks

§6 attributed the six selection-test failures to `converged: false`. That is the
observable, but it is not the defect — and the difference decides whether the
feature is fixable or not.

Replicating the two variants directly on the wave-free `TWO_PEAK_TRUTH` fixture
(true `w = 0`), holding the peaks at two different sets of fixed values:

| | frozen at the clean-flank estimate | frozen at the TRUE peaks |
|---|---|---|
| asynchronous deviance | 1289.6 | 46.1 |
| synchronous deviance | 1169.6 | 45.7 |
| fitted `w` | **0.95 — its ceiling** | 0.0135 |
| ΔBIC | **−102.9 → selects "synchronous"** | **+16.7 → selects asynchronous** ✅ |
| synchronous converged | no (`max_iterations`) | yes |

**Given unbiased peaks the selection is correct** — the cohort earns nothing on
cohort-free data and BIC rejects it, exactly as the reference intends. Given the
clean-flank peaks it is wrong, and wrong in the direction that matters: it claims
a synchronized cohort on asynchronous data.

The mechanism is §8.1's. The frozen peaks leave a large systematic residual; the
wave is the only flexible shape left in the model, so it absorbs that residual
and runs to its bound. **It is fitting peak misfit, not a population.**

The `converged` guard was rejecting the cohort for an unrelated reason (§11.2),
so the feature *appeared* to work while being decided by an accident of optimizer
termination. That is worse than no guard: it would have begun selecting spurious
cohorts the moment convergence behaviour changed.

**Removed** from `dean_jett_fox.js`, with the measurement recorded in the source
above `fit()`. What is kept:
- the wave itself (`w`, `waveMean`, `waveSigma` are always free and always
  charged to the parameter count, so BIC stays comparable across samples);
- reference **Step 7** — the wave start is located from the largest positive
  residual of a wave-free background pass, instead of only a fixed grid. This is
  now purely *initialization*: two passes, both fitting the same model, the first
  never reported and never compared against the second. `fitPoissonModel` takes
  the best restart by deviance, so an extra data-located start can only lower the
  objective;
- reporting. A wave above 20% of S raises a `complex_s_phase_shape` info warning
  that states it is S-phase **shape** and that the model does not test for
  synchronization — which is what plan §1.1's Fox row requires.

This is not evidence against the reference. It is evidence that population-form
selection needs peaks good enough for a cohort to be distinguishable from peak
misfit. Revisit **after** §8.1, not before.

## 11.2 Real bug fixed: `w` stalled against a hard clamp, so fits were unreportable

`w` was an `identity` optimizer coordinate hard-clamped into `[0, 0.95]` by the
projection, while every other bounded parameter in the model (both CVs,
`waveMean`, `waveSigma`) used a smooth sigmoid `bounded` coordinate. The comment
justified it as keeping the exact `w = 0` Dean-Jett nesting start representable.

That is precisely the **boundary stall** `lm_solver.js` deliberately refuses to
call convergence: the raw LM step stays large while the projected step is clipped
to nothing, so `stepGenuinelySmall` is never true. Because the steps were still
being *accepted* (the objective kept improving slightly), `lambda` never reached
`maximumLambda` either, so the run did not even terminate as `boundary_stall` —
it burned all 200 iterations and returned `maxIterationsReached`.

Since `w` runs to its bound routinely once the peaks are frozen (§11.1), this hit
constantly. And a non-converged result is **not reportable**
(`result_contract.js` raises `OPTIMIZER_NOT_CONVERGED`), so "the wave wants to be
large" silently became "no result at all".

Switched to `{ type: "bounded", min: config.wMin, max: config.wMax }`. The
sigmoid saturates instead of clipping: the Jacobian column shrinks as `w`
approaches the bound, the step shrinks with it, and the fit converges on
tolerance and reports `w` at its bound honestly (`parameter_at_upper_bound`).
On all three synthetic fixtures this flipped `max_iterations` →
`objective_step_tolerance`. `w = 0` is no longer *exactly* representable (it
decodes to ~1e-12), which nothing needs: the nesting identity is a property of
`expectedCounts()`, evaluated directly rather than reached through a fit.

Regression test: `the fit converges rather than stalling against the w bound`.

## 11.3 How the ten failures were resolved

Not by §4's revert.

| was | now |
|---|---|
| 3 × joint-fit tests (peak-width recovery, deviance-vs-truth, wave recovery) | Rewritten to the peaks-first contract. The reported peaks must equal the clean-flank estimate **exactly** (they are copied in by the projection on every evaluation, so any drift means a peak parameter escaped the free set). Wave **position** is asserted (z ≈ 0.4 recovered); wave **amplitude** is not, because with frozen peaks it also carries misfit. |
| 6 × async/sync selection tests | Feature removed (§11.1). Replaced by: the model never claims a population form (no `populationMode`, no synchronous/asynchronous label); a substantial wave is surfaced as shape with an explicit no-synchronization disclaimer; the parameter count is always 6. |
| 1 × `STATE-01: DJF applies ratio/CV` | Inverted to assert inertness, and `dean_jett_fox` removed from `RATIO_CV_CONSUMING_MODELS` so the claim is true (§9). |

One deliberately **pinned** test was added:
`DOCUMENTED LIMITATION: frozen peaks leave a large deviance gap to the truth`.
It asserts the deviance ratio stays in 5–60× rather than asserting it is small,
so that improving the peak estimator surfaces as a test that needs updating
instead of passing silently.

Also fixed while in here: `build_parameter_starts()` was seeding two peak
estimates (clean-flank and region-based), but the projection overwrites all six
peak slots with the fixed clean-flank values — so the two seed sets were
bit-identical after projection. Twice the restarts, same search. Collapsed to one.

## 11.4 Validation: 30-sample FlowJo set, `qc_structural`

Full 10-way sharded run on the current tree. 239/240 sample×config fits
completed (one error in shard 1). Against the two columns recorded in §2.1:

| metric | `HEAD` (§2.1) | joint fit (§2.1) | **this tree** |
|---|---|---|---|
| `g1_mean` ratio | 0.985× | 0.996× | **0.985×** |
| %G1 median | +2.8pp | +0.3pp | +3.4pp |
| %S median | −2.9pp | +12.0pp | **−3.4pp** |
| %G2 median | +6.4pp | −6.8pp | +7.0pp |
| %S within tolerance | 28/30 | 11/30 | 26/30 |
| **all_pass** | **8/30** | **0/30** | **7/30** |
| converged | not recorded | — | **30/30** |
| validForReporting | not recorded | 3/30 † | **30/30** |

† measured from the retained `comparison_20260729_101415.json`, a pre-fix state
that also shows all_pass 0/30.

**Read: at the `HEAD` baseline, one sample short on `all_pass`, and nowhere near
the joint fit's collapse.** The estimator is unchanged in kind (peaks frozen);
what differs from `HEAD` is the Bernstein profile, the smooth `w` coordinate, the
deduplicated start set and the background-pass seeding. The 8→7 difference is one
sample out of thirty on a multi-start local optimizer and was **not** isolated to
a single change — a clean `HEAD` comparison is not runnable without also
reverting STAT-01 (§4 banner), so this is stated as a caveat, not explained away.

Set against that: **30/30 converged and 30/30 reportable.** That is the direct
payoff of §11.2 — before it, a fit whose wave ran to the bound returned
`maxIterationsReached` and was refused by the result contract.

### 11.4.1 The dominant real-data error is G2 PLACEMENT, and it is systematic

The per-sample breakdown is far more specific than the medians suggest:

```
signed relative error vs FlowJo (Structural QC, n=30, tolerance ±0.03)
  g1_mean : median -0.015   range -0.023 .. +0.006    passes 30/30
  g2_mean : median -0.032   range -0.068 .. -0.018    passes 10/30
  g2:g1 ratio ours: median 1.974 (ref 2.0, tol ±0.06) passes 25/30
```

**G2's mean sits below FlowJo's on 30 of 30 samples** — never once above. G1 is
fine. `g2_mean` alone fails 20/30, and it is the *only* failing criterion on 2
samples, so fixing it moves `all_pass` from 7/30 to at least 9/30 before any
knock-on effect on the fractions.

The direction agrees with the synthetic diagnosis in §8.1 (there: `g2Mean` 137.5
against a true 140, −1.8%), which makes this the rare case where synthetic and
real data point the same way — so §5.1's warning does not apply here. The
mechanism is the same one: the smoothed argmax inside the G2 region is pulled
**left** by S-phase mass banked against G2's left flank, and nothing corrects for
it (no baseline subtraction, no sub-bin interpolation).

It also explains the %G2/%S imbalance without any appeal to "S over-fitting". A
G2 placed too low overlaps S more, and `refine_local_area()` sums raw counts over
its window without removing the pedestal — so G2 takes area that belongs to S.
Hence %G2 +7.0pp and %S −3.4pp, the same signature as the synthetic's inflated
`g2Area`.

## 11.5 Next steps, revised

Supersedes §10 items 1–3 (1 is void, 2 and 3 are done or deliberately dropped).

1. **Fix G2 placement — the highest-value single change available.** §11.4.1:
   30/30 samples biased the same way, 20/30 failing on it alone or with others,
   and it feeds the %G2/%S imbalance. Start with the three concrete biases in
   §8.1 (baseline-subtracted width threshold, deconvolve the 2-bin smoothing
   kernel, parabolic sub-bin argmax); expect them to be necessary but not
   sufficient, since none addresses S mass dragging the argmax left. Validate
   each on the 30 samples — `all_pass` and `g2_mean` pass-count are the metrics.
2. **Then re-check §8.1's area bias.** With G2 correctly placed, decide whether
   `refine_local_area()` still needs pedestal subtraction. Do not do both blind.
3. **Only then revisit the async/sync selection** (§11.1). It is correct code
   given unbiased peaks; it was removed because the peaks are not.
4. **Do not** attempt §8.2 with another local heuristic. Use cross-sample
   anchoring or calibration.
5. §8.4 (synchronized data) is still unvalidated and still needs a re-run that
   does not use the §5.6 probe.

**Aggregation.** `comparison_*.json` config labels are `"Structural"`, not
`"Structural QC"` — the §10 instruction to "filter to `qc_structural`" refers to
the `qc_applied` array, not the label. Filter on either, but not on the string
`"Structural QC"`, which matches nothing.

**Runtime.** §10 says ~20 min for the 10-way sharded run; it took **~70 min**
here. Ten concurrent Chromium instances contend badly, and each shard fits 3
samples × 8 QC configs. Budget an hour, and note that editing any `js/` file
mid-run invalidates it — the test server reads from disk per navigation, so
shards silently pick up the new code partway through.
