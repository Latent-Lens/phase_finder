# DJF Pipeline — Code Review Report

**Branch:** `djf-pipeline` (reviewed against `main`, focused on the 7 DJF commits on top of `7b5bed9 Finishing restructure`)
**Reviewed:** 2026-07-12 · **Updated:** 2026-07-12
**Status:** All 8 findings resolved in commit `771b9fe`, plus two follow-on features.
**Scope:** The staged Dean–Jett–Fox pipeline (`js/analysis/djf/**`), its app wiring (`pipeline_ui.js`, `start.js`, `channel_loading.js`, `stats.js`), and the plot-layer integration (`render.js`, `modeling.js`).

## Summary

The pipeline is, overall, carefully engineered. The numeric core (LM solver, 2-D linear algebra, robust statistics, Gaussian/S-bridge model) is well-guarded with input validation, length-contract checks, and explicit mask provenance. A smoke test on a synthetic bimodal DNA histogram produced correct results: Stage 6 recovered `mu1 = 100.01`, `R = 2.000`; Stage 5 located peaks at 100.2 / 199.8 (ratio 1.994); Stage 8's fractions summed to 100%.

The findings were mostly about **error isolation and diagnostic quality**, not wrong math. All 8 have been addressed; each is marked ✅ RESOLVED below with the fix. Two features were then added on top (gated view, metadata-table stats).

---

## Findings

### 1. No per-sample error isolation — one bad sample aborts the whole batch and the Run-All chain *(Medium)* — ✅ RESOLVED

**Where:** [pipeline_ui.js](js/analysis/djf/pipeline_ui.js)

The per-row loop ran inside a single `try/catch`, so one sample's throw skipped every remaining sample in the stage and returned `[]`, which broke `run_manual_all` — a single bad file stopped analysis for the whole selection.

**Fix:** Each `run_stage` call is now wrapped individually; a failing sample records `{ name, error, failed: true }` and the loop continues. The stage is only treated as failed if *every* sample errored (returns `[]` so Run-All stops). Failed samples are named per-line in the readout (`"<file>: Stage N failed — <message>"`) and summarized in the status bar (`"…completed for 4 of 5 sample(s); 1 failed: <file>."`). The scatter-modal lookup was guarded against error entries with no `.result`.

---

### 2. Sparse gating stages throw instead of skipping *(Low–Medium)* — ✅ RESOLVED

**Where:** [stage2_scatter_gate.js](js/analysis/djf/stage2_scatter_gate.js)

When fewer than 10 finite FSC/SSC events survived upstream masks — a normal gating outcome — `buildScatterPoints` threw, which (via Finding 1) aborted the batch.

**Fix:** Added `MINIMUM_SCATTER_EVENTS` and a shared `skippedScatterResult()` helper. The too-few condition throws a tagged error (`code: "TOO_FEW_SCATTER_EVENTS"`) that `gateMainBiologicalCloud` catches and converts to a `{ skipped: true, reason }` result matching the missing-channel path. Structural errors (length mismatches) still propagate. Skip counts are surfaced in the status bar (`"(N skipped)"`) and per-line in the readout.

---

### 3. Clean fits report `converged: false` / "stopped" *(Low, diagnostic quality)* — ✅ RESOLVED

**Where:** [math/lm_solver.js](js/analysis/djf/math/lm_solver.js), [stage6_fit.js](js/analysis/djf/stage6_fit.js), [stage7_extend.js](js/analysis/djf/stage7_extend.js), [pipeline_ui.js](js/analysis/djf/pipeline_ui.js)

The LM driver only set `converged` on a tolerance hit, so an accurate fit that exhausted its iteration budget (common with any model/data mismatch) reported `converged: false` and showed "stopped".

**Fix (reporting-only; numeric result unchanged):** The solver now returns `maxIterationsReached` (`!converged && ran to the budget`), threaded into Stage 6/7 diagnostics and the per-candidate list. A new `fit_outcome_label()` maps to three distinct readout states — **"converged"**, **"reached max iterations"**, or **"stopped"** — so "stopped" now means a genuine early abort. Verified: the same fit that recovered `mu1=100.01, R=2.000` now reports `maxIterationsReached: true`.

---

### 4. `STATE_FIELDS_BY_STAGE[0]` doesn't match the actual Stage 0 field *(Low, latent trap)* — ✅ RESOLVED

**Where:** [pipeline_state.js](js/analysis/djf/pipeline_state.js)

The stage→field invalidation map listed `"structuralMask"` at index 0, but Stage 0's primary output is `state.structuralQC` (`structuralMask` is an unread secondary copy). Harmless today, but a trap if anything ever invalidated from Stage 0 downward.

**Fix:** Relabeled index 0 to `"structuralQC"` with a comment noting `structuralMask` is a secondary copy cleared with its mask. Confirmed `state.structuralMask` is written but never read (stages read the mask from `row.data.masks.structural`).

---

### 5. Iteration count over-reported by one *(Low, cosmetic)* — ✅ RESOLVED

**Where:** [math/lm_solver.js](js/analysis/djf/math/lm_solver.js)

On convergence the `for` loop's post-increment ran once more, so `iterationsPerformed` was one high on the converge and trivial paths.

**Fix:** `iterationsPerformed = Math.max(0, iterations - 1)` — the true count of executed loop bodies in every case. Verified across edge cases: converges-on-iteration-1 reports 1, no-free-params reports 0, run-to-budget still reports `maxIterations`; `maxIterationsReached` stays correct.

---

### 6. Stage 4 histogram + fit overlays freeze at the run-time bin count *(Info / design)* — ✅ RESOLVED (documented)

**Where:** [pipeline_ui.js](js/analysis/djf/pipeline_ui.js), [render.js](js/plotting/render.js)

Stage 4 snapshots the bin count/range into stored state; a later bin-count change re-bins only samples *without* stage state, so a mixed selection can show two bin widths. This is an edge case (the realistic trigger is a newly-checked or Stage-4-skipped sample) and freezing is defensible because re-binning would invalidate the fit.

**Fix:** Documented the snapshot semantics at both the capture site and the render site (Option A — no behavior change). Note: the mixed case is now slightly more reachable because of Finding 1/2's per-sample isolation.

---

### 7. Fraction fallback differs from Stage 8 *(Info)* — ✅ RESOLVED

**Where:** [render.js](js/plotting/render.js)

Before Stage 8 ran, displayed 1C/S/2C percentages used a coarse discrete sum, then shifted to the report's trapezoidal fractions once Stage 8 completed — the numbers appeared to jump.

**Fix:** The numeric fit-results table now only renders for samples that have a Stage 8 `report`. The fitted-curve overlay and legend still draw from Stages 6/7 (visual feedback), but no numbers appear until the pipeline is complete — so the transient fallback values are never shown and the numbers never change under the user. (`fit.fractions`, an unused fallback field, was confirmed dead and left in place.)

---

### 8. Display staleness guard weaker than the state-creation guard *(Info)* — ✅ RESOLVED

**Where:** [pipeline_state.js](js/analysis/djf/pipeline_state.js), [render.js](js/plotting/render.js)

`active_pipeline_state` gated display on `channelKey` only, while `get_or_create_state` also invalidated on `eventCount`/`rowId` — the two could drift.

**Fix:** Extracted a shared `state_matches_row(state, row)` predicate (checks `channelKey`, `eventCount`, and `rowId` when both known) used by both call sites, so they can no longer diverge. Verified across match/mismatch/unknown-id cases.

---

## Follow-on features (added after the review)

### A. Progressively filtered "gated view"

**Where:** [pipeline_state.js](js/analysis/djf/pipeline_state.js), [index.js](js/analysis/djf/index.js)

The originals remain the source of truth, and a second compacted array (`row.data.filtered`) now holds only the events surviving the composed masks so far, rebuilt at every mask change with an `originalIndex` map back to raw event indices — so each mask "deletes" events from the view as it runs while the mask layer keeps the scatter inspector and re-runs working. Stage 4 bins the gated array directly (verified numerically identical to the masked-originals path).

**Scatter note:** the scatter plot already uses upstream-filtered data (structural + timeQC survivors) in an ordered run; the only "raw" case is running Stage 2 standalone with nothing upstream yet, which the coming automation resolves. Stage 2 was intentionally *not* routed through `row.data.filtered`, since that view reflects the cumulative final mask (it would wrongly include the singlet gate on a re-run).

### B. Metadata-table stats

**Where:** [index.js](js/analysis/djf/index.js) (`pipeline_table_stats`), [pipeline_ui.js](js/analysis/djf/pipeline_ui.js)

On Stage 8 completion, seven columns are written to the file table: per-filter losses **Structural / Time QC / Scatter / Singlet lost** formatted as `1,905 (4.5%)` (percent relative to the events *entering* that stage; skipped filters show "—"), then **G1 % / S % / G2/M %** from the report. The funnel is derived from the composed masks so it stays correct regardless of per-stage mask semantics, and columns populate only for samples that completed the pipeline.

---

## What looks solid

- **Length contracts are enforced end to end.** `raw_channel` guarantees every channel array equals `event_count`; `set_stage_mask` / `combine_masks` validate mask lengths against `eventCount`.
- **Mask provenance is explicit.** Skipped optional gates store `null` (not a copied pass-through mask), and `invalidate_after` correctly clears downstream state and masks and recomputes `final`.
- **Numeric inputs are validated** across the fitter, peak detector, histogram builder, and report stage, with sensible NaN/empty handling in the robust-stats helpers.
- **Overflow-safe primitives** (`logistic`, `logSumExp`) and singular-matrix guards (`invertCovariance2D`, `solveLinearSystem`).
- **Lazy loading** keeps the numeric modules off the initial application graph until a stage button is used.

## Verification performed

- Static review of all Stage 0–8 modules, the shared math layer, state/mask composition, and the app/plot wiring.
- Node smoke tests of the DOM-free stages and helpers: Stage 5/6/8 on a synthetic bimodal histogram (correct); LM iteration accounting across edge cases; the gated view (shrinks 10→8→7, correct `originalIndex` mapping, Stage 4 histogram identical to the masked path); and the per-filter funnel math (losses relative to entering events).
- `node --check` passes on every edited file.

The full Playwright unit/e2e suites (`tests/unit/unit_tests_djf_pipeline.py`, `tests/e2e/tests_pipeline.py`) were **not executed** here — they require a running static server and browser driver. Recommended next step: run them, and add unit coverage for the new behavior (per-sample error isolation, `maxIterationsReached`, the gated view, and `pipeline_table_stats`), which the current suites do not exercise.
