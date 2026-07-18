# DJF 9-Stage Pipeline — Implementation Plan

> **Audience:** the implementing agent. This is a standalone execution spec. It
> maps the 9 stages in `docs/dean_jett_fox_implementation.md` onto PhaseFinder's
> current ES-module code, names the exact current variables/functions/files to
> touch, and flags the meshing pitfalls. Source line references into the doc use
> `dean_jett_fox_implementation.md:<line>`.
>
> **Deliverable location:** this document is saved at `docs/djf_impl_plan.md`.

---

## 1. Context

`docs/dean_jett_fox_implementation.md` specifies a rigorous 9-stage (Stage 0–8)
Dean–Jett–Fox cell-cycle pipeline: structural QC → time QC → FSC/SSC cell gate →
pulse-geometry singlet gate → 1D DNA histogram → peak detection → single-cycle
DJF fit → optional debris/aggregate contamination refit → fraction reporting +
diagnostics. Each stage ships self-contained sample JS in the doc.

PhaseFinder today has only a **simplified** DJF (`js/analysis/djf.js`) driven by
`plotting/render.js`, and the loader (`io/channel_loading.js`) loads **only**
DNA-A/H/W as compacted, positive-only `Float64Array`s. The new pipeline needs
FSC-A, SSC-A, Time (HDR-T) and masks over the *original* event order, which do
not exist yet.

**Goal:** implement all 9 stages as new per-stage ES modules, extend the loader
to full fidelity, and expose a **manual, one-button-per-stage** debugging UI so
each stage's code can be run and inspected independently. This is intentionally a
debug harness first (all-manual), not an automated end-to-end run.

### Decisions locked with the user (three forks)

1. **Pipeline wiring = new modules + rewire.** Add checkpoint modules directly
   under `js/analysis/`; rewire `render.js`/`modeling.js` to read pipeline state.
   Retire overlapping old `djf.js` helpers once the new path reaches parity.
2. **Event data = extend loader (full fidelity).** Auto-detect + load FSC-A,
   SSC-A, Time alongside DNA-A/H/W; keep **raw uncompacted** typed arrays plus
   `Uint8Array` masks over the original event order.
3. **Cleaning UI = one button per stage, all manual.** A row of buttons: one per
   stage. Optional stages carry "(opt)" in the label. Each button runs **only**
   that stage's code against stored pipeline state and shows diagnostics.

### Branch

Create the work branch off the current branch:

```bash
git checkout esm-restructure
git checkout -b djf-pipeline
```

Commit at the breakpoints in §9. Do not push or open a PR unless asked.

---

## 2. Current-code reference map (read this before coding)

Concrete names/locations the plan depends on. **Do not guess — these are verified.**

### 2.1 Loading & FCS

| What | Where | Notes |
|---|---|---|
| Lightweight header/metadata entry | `js/fcs/metadata_processing.js` → `read_fcs_header(file)` | Returns `{ id, name, file, summary }`. No event data. |
| FCS summary shape | `js/fcs/parser.js` → `summarize_fcs_header` | `summary = { header, metadata, columns, event_count, parameter_count, data_begin, data_end }`. `metadata` keys are normalized: `$` stripped, spaces→`_`, uppercased (so `$P1R`→`P1R`, `$TIMESTEP`→`TIMESTEP`). |
| Selected-column reader | `js/fcs/parser.js` → `FCSParser.parse_selected_columns(buf, metadata, indexes)` | Returns `columns` keyed by **1-based** param index → `Array` of per-event values (length = `$TOT`). |
| Column loader + worker | `js/io/channel_loading.js` → `load_analysis_row(row, selected, opts)` | Sets `row.data`. **Primary file to extend.** |
| Index resolution for a file | `js/io/channel_loading.js` → `selected_indexes_for_file(summary, selected)` | Currently returns `{ dna_a, dna_h, dna_w, dna_height_label, dna_width_label }`. **Extend to add fsc_a/ssc_a/time.** |
| Value filtering (compaction) | `js/fcs/channel_cleaning.js` → `filter_selected_channel_values(columns, indexes)` | Currently drops non-finite/≤0 and **compacts** to positive-only. **Replace with raw + structural mask (Stage 0).** |
| Param map | `js/io/parameter_map.js` → `parameter_map(summary)` | `[{ index (1-based), label, name, desc }]`. Also `find_param_index`, `unique_indexes`. |
| H/W companion finder | `js/fcs/channel_cleaning.js` → `find_auxiliary_indexes_for_file(params, label)` | Base-name match for area→height/width. **Pattern to copy for FSC/SSC/Time.** |
| Name normalizers | `js/fcs/channel_cleaning.js` → `normalize_measurement_name` / `measurement_kind` / `measurement_base` | area↔`a`, height↔`h`, width↔`w`, word-boundary aware. |
| Per-row/channel cache | `js/data_structs/channel_cache.js` → `analysis_data_key` / `store_analysis_data` / `cached_analysis_data` / `is_analysis_data_loaded` | Keyed by `selected.dna_area`. `is_analysis_data_loaded` checks `data.dna_a`. |

### 2.2 Current `row.data` shape (to be extended, not broken)

Set in `load_analysis_row` (`channel_loading.js:243–259`):

```js
row.data = {
  channel_key, channel,           // cache key + selected dna_area label
  dna_a, dna_h, dna_w,            // Float64Array, COMPACTED positive-only (today)
  keep_mask,                      // Uint8Array over original order (finite&>0)
  indexes,                        // { dna_a, dna_h, dna_w, ... }
  removed_invalid_count, total_count,
};
```

Current readers of `row.data.dna_a` (all must keep working — keep a top-level
`dna_a` alias in the new shape):
- `plotting/data.js`: `loaded_rows_for_active_channel`, `shared_range`, and via
  `plottable_rows`.
- `plotting/render.js`: `prepared_rows` fallback (`render.js:137,173`).
- `plotting/modeling.js`: `update_plot_title` (`row.data.dna_a.length`).
- `analysis/djf.js`: `prepare_row`.
- `data_structs/channel_cache.js`: `is_analysis_data_loaded` (`data.dna_a`).

### 2.3 Plotting / histogram

| What | Where | Notes |
|---|---|---|
| Main render pass | `js/plotting/render.js` → `render_density_plot()` | Currently calls `djf.prepare_row/fit/components/phase_stats`. **Rewire to read pipeline state.** |
| Histogram builder | `js/plotting/data.js` → `histogram_curve(values, opts)` + `axis_opts(range,is_log,bins)` + `build_histogram_summary(points, opts)` | `build_histogram_summary` → `{ binEdges, binCenters, counts, binWidth, min, max }`. Feed `binCenters` as `x` and `counts` as `y` to Stage 6. |
| Bin count control | `js/plotting/data.js` → `plot_bin_count()` | Clamps [16,1024], default 512. |
| Shared x-range | `js/plotting/data.js` → `shared_range_for_values(value_sets, positive_only)` | Percentile-based. |
| Plot state | `js/plotting/data.js` | `plot_channels` (`{ dna_area }`, via `set_plot_channels`), `plottable_rows()`, `series_by_name`, `histograms_by_name`, `modeling_started`, `shown_fits`, `peak_threshold`, `djf_readout` (DOM). |
| Correction toggles (existing) | `js/plotting/data.js` | `plot_debris_correction_toggle`, `plot_doublet_correction_toggle`, `correction_state()`. Existing IDs `#plot_debris_correction`, `#plot_doublet_correction`. |
| Fit-results table | `js/plotting/modeling.js` → `render_fit_results_table(fits, placement)` | Reuse for the Stage 8 report table. |
| Component colors | `js/plotting/data.js` | `DJF_G1_COLOR`, `DJF_S_COLOR`, `DJF_G2_COLOR`, `DJF_TOTAL_COLOR`, `DJF_FILL_OPACITY`. Add debris/aggregate colors (CSS tokens `--djf_debris`, `--djf_agg`). |

### 2.4 Modeling / lazy-load / wiring

| What | Where | Notes |
|---|---|---|
| Lazy DJF loader | `js/plotting/djf_loader.js` → `load_djf()` / `get_djf()` | Dynamic-imports `analysis/djf.js`, caches, shows progress overlay. **Model for a new `pipeline_loader.js`** (or generalize this). |
| Start modeling | `js/plotting/modeling.js` → `start_modeling()` | Lazy-loads DJF, sets `modeling_started`, seeds `shown_fits`. |
| Button wiring | `js/analysis/start.js` → `init_analysis_listeners()` | Wires `cell_cycle_modeling_button`, `collapsed_cell_cycle_modeling_button`, channel-change → `prepare_selected_channel_for_plotting`. |
| DOM refs | `js/ui/dom.js` and `js/ui/panels.js` | Add new stage-button refs here. |
| Bootstrap | `js/main.js` | Ordered `init_*()` calls. Single debug hook `window.PhaseFinder = { app, djf, plot }` (`main.js:268`). **Add `pipeline`.** |
| Progress overlay | `js/ui/status_channels.js` → `show_progress/update_progress/hide_progress/next_frame` | Reuse for the pipeline loader. |

### 2.5 Vendored numerics

`js/vendor/ml-levenberg-marquardt.js`, `js/vendor/ml-gsd.js`, `js/vendor/d3.min.js`,
imported via the `index.html` import map (and mirrored in
`tests/unit/test_harness.html`). **The doc's Stages 6–7 ship their own
self-contained LM solver and peak finder**, so the new pipeline does **not** need
ml-levenberg-marquardt or ml-gsd. Keep them only until old `djf.js` is retired
(§8), then drop the imports if nothing else uses them.

### 2.6 Tests

| What | Where | Notes |
|---|---|---|
| Unit harness page | `tests/unit/test_harness.html` | Imports app ESM, assigns to `window`, exposes `window.TestUtils` (`buildSyntheticFCS`, `buildBimodalHistogram`, `buildSyntheticIntegerFCS`) and `window.PhaseFinder = { djf }`. **Add new pipeline modules here.** |
| Unit runner | `tests/unit/run_unit_tests.py` | Playwright; each `unit_tests_*.py` exposes a `run_*` fn. |
| DJF unit tests | `tests/unit/unit_tests_djf.py` | Pattern to copy for `unit_tests_djf_pipeline.py`. Uses `page.evaluate()` snippets returning `[{name,pass,detail}]`. |
| E2E | `tests/e2e/tests_modeling.py`, `drive_flow.py`, `helpers.py` | Synthetic FCS in `tests/test_data/`. Pattern for `tests_pipeline.py`. |

---

## 3. Target architecture

### 3.1 New module layout (`js/analysis/`)

```
js/analysis/
  math/
    stats.js           # median, mad, mean, variance, quantileSorted,
                       #   maximumValue, sumSquares, robustResidualScale,
                       #   clamp, nearestIndex, safeFraction
    gaussian.js        # gaussianPeakHeight, gaussianSmooth, logistic,
                       #   logSumExp, logGaussian2D
    linalg2d.js        # 2x2 covariance: calculateGlobalCovariance,
                       #   regularizeCovariance, invertCovariance2D,
                       #   principalDirection2D, eigenDecomposition2D (new),
                       #   mahalanobisSquared, calculateWeightedCenter,
                       #   calculateWeightedCovariance, signedOrthogonalDistance
    lm_solver.js       # solveLinearSystem, buildNormalEquations,
                       #   buildFiniteDiffJacobian, runLevenbergMarquardt
    integrate.js       # integrateTrapezoidal
  djf_components.js    # shared model evals: evaluateSBridge, gaussianPeak,
                       #   evaluateBaseAt (+ shared PARAMETER_INDEX map)
  structural_qc.js     # Stage 0  | createStructuralValidityMask
  acquisition_time_qc.js # Stage 1 | prepareTimeQCBins + summarize + score + mask
  scatter_gmm_gate.js  # Stage 2  | gateMainBiologicalCloud (2-comp GMM)
  scatter_modal.js     # Stage 2  | FSC/SSC scatter + gate-ellipse modal
  pulse_geometry_gate.js # Stage 3 | gateByPulseGeometry (robust ridge)
  dna_histogram.js     # Stage 4  | generateHistogram (DNA_A, finalMask)
  peak_detection.js    # Stage 5  | detectDNAContentPeaks
  legacy_bridge_fit.js # Stage 6  | compatibility fitCellCycleHistogram (shared LM)
  debris_aggregate_extension.js # Stage 7 | extendCellCycleFit
  cell_cycle_fit_report.js # Stage 8 | summarizeCellCycleFit + createDisplaySummary
  background_model.js  # unspecified-background stub
  pipeline_state.js    # per-sample state store (Map by row.name) + combine_masks
  cell_cycle_pipeline.js # orchestrator: run_stageN(row), run_all(row),
                       #   run_stageN_all(), get_state(name)
  pipeline_loader.js   # dynamic import() on first stage-button click (model:
                       #   djf_loader.js)
  pipeline_ui.js       # wires the stage buttons -> orchestrator -> readout/redraw
```

Each checkpoint module is a faithful port of the doc's sample code, adapted to
(a) typed-array channels, (b) the shared `math/` modules (§3.5), and (c) `Uint8Array`
masks over original event order. Keep the doc's function names as internal names
where practical for traceability.

### 3.2 Extended `row.data` shape (loader output)

Additive: keep legacy top-level `dna_a` (now the **raw** DNA_A channel) so
existing readers keep working; add `channels`, `masks`, `eventCount`, `pnr`.

```js
row.data = {
  channel_key, channel,           // unchanged (cache key + dna_area label)
  eventCount,                     // = summary.event_count ($TOT)
  channels: {                     // RAW, uncompacted, index-aligned typed arrays
    DNA_A, DNA_H|null, DNA_W|null,
    FSC_A|null, SSC_A|null, Time|null,
  },
  pnr: {                          // per-channel max value ($PnR) for boundary QC
    DNA_A, DNA_H, DNA_W, FSC_A, SSC_A, Time,   // numbers or null
  },
  masks: {                        // Uint8Array(eventCount), 1 = pass; null until run
    structural: null, timeQC: null, scatter: null, singlet: null, final: null,
  },
  indexes,                        // extended: { dna_a, dna_h, dna_w, fsc_a, ssc_a, time }
  dna_a,                          // ALIAS -> channels.DNA_A (raw). legacy readers.
};
```

- `channels.*` are `Float64Array` (or `Float32Array`) of length `eventCount`,
  **not compacted** — a mask at index `i` refers to original event `i`.
- Legacy `dna_a` alias points at `channels.DNA_A` so `is_analysis_data_loaded`,
  `shared_range`, `update_plot_title` keep working. (Value range for plotting is
  fine: `histogram_curve` already skips `NaN`; negatives only matter on a log
  axis, and the app uses a linear x-axis.)

**Full populated example.** A snapshot after Stage 0 (structural) and Stage 3
(singlet) have run for one 65,691-event sample. Stage 1 (time) and Stage 2
(scatter) were skipped here because this file has no Time / no FSC+SSC channels,
so their masks stay `null`:

```js
row.data = {
  channel_key: "FL2-A",              // = selected.dna_area (cache key)
  channel: "FL2-A",                  // selected DNA-content area label
  eventCount: 65691,

  channels: {                        // raw, uncompacted, length === eventCount
    //          idx:  0        1   2         3     4          (index-aligned)
    DNA_A: Float64Array [ 64880.1,  0, 262144,   NaN, 129550.4, /* … 65691 */ ],
    DNA_H: Float64Array [ 64010.7,  0, 261900,  12.0, 128110.0, /* … */ ],
    DNA_W: Float64Array [ 65120,    0,  65400, 65000,  65210,   /* … */ ],
    FSC_A: null,                     // channel not present in this file
    SSC_A: null,
    Time:  null,
  },

  pnr: {                             // $PnR max per channel (upper-margin bound)
    DNA_A: 262144, DNA_H: 262144, DNA_W: 262144,
    FSC_A: null, SSC_A: null, Time: null,
  },

  masks: {                           // Uint8Array(eventCount), 1 = pass
    //   idx 2 = saturated (== PnR) and idx 3 = NaN are discarded;
    //   idx 1 (value 0) is KEPT (0 is valid — see Stage 0 note).
    structural: Uint8Array [ 1, 1, 0, 0, 1, /* … */ ],   // Stage 0 ran
    timeQC:     null,                                     // Stage 1 skipped
    scatter:    null,                                     // Stage 2 skipped
    singlet:    Uint8Array [ 1, 1, 0, 0, 0, /* … */ ],    // Stage 3 (idx 4 = doublet)
    final:      Uint8Array [ 1, 1, 0, 0, 0, /* … */ ],    // AND of present masks
  },

  indexes: {                         // 1-based FCS parameter indexes
    dna_a: 4, dna_h: 5, dna_w: 6,
    fsc_a: null, ssc_a: null, time: null,
  },

  dna_a: /* alias → channels.DNA_A (same Float64Array reference) */,
};
```

### 3.3 Pipeline state (`pipeline_state.js`)

A `Map` keyed by `row.name` (the sample filename, same key as `series_by_name`):

```js
state = {
  structuralMask, timeQC, scatterGate, singletResult,   // stage 0–3 outputs
  histogram,                                            // stage 4 { x:binCenters, y:counts, min,max,binWidth }
  peaks,                                                // stage 5 detectDNAContentPeaks(...)
  baseFit,                                              // stage 6 fitCellCycleHistogram(...)
  extendedFit,                                          // stage 7 extendCellCycleFit(...)
  report,                                               // stage 8 summarizeCellCycleFit(...)
  lastStageRun,                                         // int for UI/gating
}
```

`combine_masks(...)` (port of doc `combineMasks`,
`dean_jett_fox_implementation.md:2390`) recomputes `row.data.masks.final` = AND of
whichever of `{structural, timeQC, scatter, singlet}` exist. Stage 4 reads
`masks.final` (or all-pass if none run).

### 3.4 Debug hook

Extend the single documented hook in `main.js`:

```js
window.PhaseFinder = { app, get djf() {...}, plot, get pipeline() {...} };
```

`pipeline` exposes `get_state(name)`, `run_stageN`, and the raw per-sample state
so intermediate masks/GMM/ridge/histogram/fit/report are inspectable in DevTools
while debugging.

### 3.5 Shared math modules (dedup map)

The doc repeats the same helpers inside almost every stage sample (`median`
appears in Stages 1, 2, 3, 6, 7, 8; a Gaussian-elimination `solveLinearSystem`
appears verbatim in Stages 6 and 7). Consolidate them into small themed modules
so there is one implementation each; every `stageN` imports from these instead of
re-declaring.

| File | Functions | Used by |
|---|---|---|
| `math/stats.js` | `median`, `mad`, `mean`, `variance`, `quantileSorted`, `maximumValue`, `sumSquares`, `robustResidualScale`, `clamp`, `nearestIndex`, `safeFraction` | Stages 1, 2, 3, 5, 6, 7, 8 |
| `math/gaussian.js` | `gaussianPeakHeight`, `gaussianSmooth`, `logistic`, `logSumExp`, `logGaussian2D` | Stages 2, 5, 6, 7 |
| `math/linalg2d.js` | `calculateGlobalCovariance`, `regularizeCovariance`, `invertCovariance2D`, `principalDirection2D`, `eigenDecomposition2D` (new — for the Stage 2 ellipse), `mahalanobisSquared`, `calculateWeightedCenter`, `calculateWeightedCovariance`, `signedOrthogonalDistance` | Stages 2, 3, `scatter_modal.js` |
| `math/lm_solver.js` | `solveLinearSystem`, `buildNormalEquations`, `buildFiniteDiffJacobian`, `runLevenbergMarquardt` (generic driver taking `residualFn`/`projectFn`/`freeIndices`) | Stages 6, 7 |
| `math/integrate.js` | `integrateTrapezoidal` | Stage 8 |
| `djf_components.js` | `evaluateSBridge`, `gaussianPeak`, `evaluateBaseAt` (G1+S+G2) + shared `PARAMETER_INDEX` map | Stages 6, 7, 8 |

Notes:
- `solveLinearSystem` and `buildNormalEquations` are effectively identical between
  Stage 6 and Stage 7 in the doc — safe to share immediately.
- The two fit loops (`fitWithLevenbergMarquardt` vs `fitCandidateModel`) are
  structurally identical, differing only in their residual/project/free-index
  callbacks. Fold them into one `runLevenbergMarquardt({ residualFn, projectFn,
  freeIndices, options })`. If that refactor proves fiddly during porting, it is
  acceptable to keep a thin per-stage loop and still share the linear-algebra
  helpers — do not let the consolidation block a faithful port.
- `evaluateSBridge` is identical in Stages 6 and 7; `evaluateBaseAt` differs only
  in the index constant it reads — parameterize it on the shared `PARAMETER_INDEX`.

---

## 4. Per-stage implementation

For each stage: **Source** (doc lines), **Consumes → Produces**, **Mesh notes**
(current names + pitfalls), and **Checklist** (every doc checkbox mapped).

Standardize on: masks are `Uint8Array(eventCount)`, `1 = pass / 0 = fail`.

### Stage 0 — Structural validity (Step 1&2)
- **Source:** `dean_jett_fox_implementation.md:99–192` (`createStructuralValidityMask`).
- **Consumes:** `row.data.channels` (all loaded), `row.data.pnr`. **Produces:**
  `row.data.masks.structural`.
- **Mesh notes / pitfalls:**
  - Doc sample maps over `events` (array of objects); **rewrite to iterate typed
    arrays** `channels.DNA_A[i]`, etc.
  - **CRITICAL — do not hardcode `1000`.** The doc's `value < 1000` /
    `=== 1000` boundary rules assume a 0–1000 scale. Real data uses `$PnR` (e.g.
    synthetic fixtures use `262144`); hardcoding 1000 would drop every event. Use
    each channel's `row.data.pnr.<CH>` as the upper margin: discard `NaN/±Inf`,
    `value < 0` (below scale), `value >= pnr` (upper margin/saturated). If `pnr`
    is missing for a channel, skip the upper-bound test for it.
  - **`value === 0` is KEPT (user decision).** Discard only strictly-negative
    values. This diverges from the doc, whose sample code uses `value > 0` and
    whose checklist says `=== 0 → discard as lower-margin event`. The doc treats 0
    as a clipped lower-margin event; the user has decided 0 is a valid reading.
    Implement keep-0; leave a `// diverges from doc: 0 kept as valid` comment so
    it is easy to revert if low-end margin clipping later distorts the histogram.
  - **Time is exempt from the upper bound** (doc: keep `0 ≤ value < Inf`); only
    discard `NaN/±Inf` and `< 0` for Time. Time saturation is Stage 1's job.
  - Metadata to extract per param (doc checklist): `$DATATYPE`, `$PnB`, `$PnR`,
    `$PnE`, `$PnN`, `$PnS`. All already live in `summary.metadata` as `P{n}R`,
    `P{n}E`, `P{n}B`, `P{n}N`, `P{n}S` (normalized). Read them in the loader and
    stash `pnr` (§5). No parser change required beyond reading these keys.
  - Bounded channels = the subset of `{DNA_A, DNA_H, DNA_W, FSC_A, SSC_A}` that
    are actually loaded (skip nulls) — do not require FSC/SSC to exist.
- **Checklist coverage:** load FCS (done by app); extract metadata (`$DATATYPE`,
  `PnB`, `PnR`, `$PnE`, `$PnN`, `$PnS`) → §5 loader; user selects DNA_A (existing
  `channel_select`); auto-identify DNA_H/DNA_W/FSC_A/SSC_A/Time → §5; build
  keep-mask with the non-time and time rules above; keep original event indexes
  (the mask *is* over original indices).

### Stage 1 — Time-based acquisition QC (Step 3) — **(opt)**
- **Source:** `dean_jett_fox_implementation.md:195–811` (`prepareTimeQCBins`,
  `summarizeChannel`, `calculateBinEventRate`, `scoreTimeQCBins`,
  `mergeFlaggedBins`, `createTimeQCMask`).
- **Consumes:** `channels.Time` (+ `DNA_A/FSC_A/SSC_A` for bin summaries),
  `masks.structural`. **Produces:** `row.data.masks.timeQC` + a `timeQC` state
  blob (bins, scoredBins, flaggedIntervals, unwrappedTime).
- **Mesh notes / pitfalls:**
  - Requires `channels.Time`. If absent → skip: set `masks.timeQC = null` (treat
    as all-pass) and return a `{ skipped:true, reason:"no Time channel" }`
    diagnostic. The stage button still "runs" but reports skipped.
  - `timerRange` default `32.6824` is instrument-specific. Prefer deriving from
    the Time channel's `$PnR` (`row.data.pnr.Time`) or `$TIMESTEP`
    (`summary.metadata.TIMESTEP`) when present; fall back to the doc default.
    Wire as an option with that fallback order.
  - Restrict bin summaries to channels that exist (`FSC_A`/`SSC_A` may be null →
    those metrics become `NaN` and are naturally filtered by `.filter(Number.isFinite)`
    in `calculateMetricBaselines`).
  - Port `median`/`mad`/`quantileSorted` from `util_numeric.js` (doc defines them
    inline three times).
- **Checklist coverage:** detect time discontinuities/wrap (in `prepareTimeQCBins`);
  contiguous ~500-event bins with remainder spread evenly (the
  `Math.floor(binNumber*len/binCount)` split); unwrapped + raw time; per-bin
  medians (DNA_A/FSC_A/SSC_A) + event rate + IQRs; robust z across 7 metrics;
  flag bins with any `|z|>4`; build `timeQC` mask over flagged bins' events.

### Stage 2 — Cell gate, FSC/SSC 2-component GMM (Step 4) — **(opt)**
- **Source:** `dean_jett_fox_implementation.md:815–1624` (`buildScatterPoints`,
  `fitGMM2D`, `chooseMainBiologicalComponent`, `mahalanobisSquared`,
  `createScatterGateMask`, `gateMainBiologicalCloud`).
- **Consumes:** `channels.FSC_A`, `channels.SSC_A`, `masks.structural`,
  `masks.timeQC`. **Produces:** `row.data.masks.scatter` + `scatterGate` state
  (components, mainComponent, mahalanobis², threshold, converged).
- **Mesh notes / pitfalls:**
  - Requires both FSC_A and SSC_A. If either missing → skip (all-pass mask +
    `{skipped:true, reason:"FSC_A/SSC_A unavailable"}`).
  - `buildScatterPoints` takes `(dataset, structuralMask, timeQCMask)`; feed
    `row.data` as `dataset` with `dataset.eventCount` and
    `dataset.channels.{FSC_A,SSC_A}`. Pass `masks.timeQC` as null when Stage 1
    was skipped.
  - Default threshold `5.991` (95% χ² ellipse, 2 dof). Keep as option.
  - Port the GMM's local `median/mad/variance` to `util_numeric.js`.
  - Deterministic init (no RNG) — good; keep it so results are reproducible for
    debugging.
- **Checklist coverage:** build FSC/SSC scatter set; fit 2-comp GMM; pick main
  biological component (higher FSC-A mean, weight ≥ 0.1); Mahalanobis distance;
  ellipse threshold; scatter-gate mask.
- **Scatter + ellipse modal (required for this stage).** Clicking `#djf_stage2`
  runs the GMM and then opens a modal (`#djf_scatter_modal`, new — model the
  open/close plumbing on `plotting/axis_modal.js` `open_axis_range_modal` and the
  existing modal markup in `index.html`, e.g. the metadata-wizard/stats modals with
  a `.stats_modal_backdrop`) that shows the FSC-A × SSC-A scatter with the gate
  ellipse the stage will apply, so the user can eyeball the gate before trusting
  the mask. Implement in `scatter_modal.js`, drawn with d3:
  - Downsample the scatter to a responsive size (e.g. ≤10k points via a stride,
    the same idea as `shared_range_for_values`). Color each point inside vs.
    outside the gate from `masks.scatter` (equivalently `mahalanobis² ≤ threshold`).
  - Overlay the **main component's** gate ellipse. For covariance
    `Σ = [[a,b],[b,c]]` and Mahalanobis threshold `d² = 5.991`, the boundary
    `(x−μ)ᵀ Σ⁻¹ (x−μ) = d²` is an ellipse centred at μ with axes along Σ's
    eigenvectors and semi-axis lengths `sqrt(λ_i · d²)`. Eigenvalues of a 2×2
    symmetric matrix: `λ = (a+c)/2 ± sqrt(((a−c)/2)² + b²)`; the major-axis angle
    is `principalDirection2D(Σ)`. Add `eigenDecomposition2D(Σ)` to
    `math/linalg2d.js` (returns `{ values:[λ1,λ2], vectors }`) and reuse it here.
  - Optionally draw the second (non-selected) component's ellipse muted, plus a
    caption: component weights, `converged`, retained-event count, threshold.
  - Inspection-only for the debug harness (no accept/reject). A close button +
    backdrop click dismiss it; the mask is already stored on
    `row.data.masks.scatter` regardless of the modal.

### Stage 3 — Singlet gate by pulse geometry (Step 5) — **(opt)**
- **Source:** `dean_jett_fox_implementation.md:1627–2504` (`fitRobustRidge2D`,
  `selectPulseGeometry`, `buildPulseGeometryPoints`, `createSingletMaskFromRidge`,
  `gateByPulseGeometry`, `combineMasks`).
- **Consumes:** `channels.DNA_A` + (`DNA_H` preferred, else `DNA_W`), prior masks.
  **Produces:** `row.data.masks.singlet` + `singletResult` state (geometryMode,
  ridge, kMAD, retainedSingletCount, `optionalAggregateTermRecommended`).
- **Mesh notes / pitfalls:**
  - `selectPulseGeometry(dataset)` reads `dataset.channels.{DNA_A,DNA_H,DNA_W}` —
    matches our `row.data.channels`. Preference A/H then A/W then skip. When
    skipped, `optionalAggregateTermRecommended = true` — thread this into Stage 7
    /Stage 8 (`pulseGeometryAvailable`).
  - `gateByPulseGeometry(dataset, inputMask, opts)` — `inputMask` = combined
    structural∧timeQC∧scatter (use `combine_masks`). Default `kMAD = 5`.
  - The current app already links H/W via `find_auxiliary_indexes_for_file`; the
    doc re-derives from `channels` — consistent, no conflict.
- **Checklist coverage:** all 15 sub-items (robust stats, ridge direction,
  weighted center/cov, signed orthogonal distance, Huber-robust ridge fit,
  skip-copy mask, A/H-vs-A/W selection, point matrix, k·MAD threshold, full gate,
  combine masks, final mask, diagnostics).

### Stage 4 — 1D DNA histogram (Step 6a)
- **Source:** `dean_jett_fox_implementation.md:2506–2545` (`generateHistogram`).
- **Consumes:** `channels.DNA_A`, `masks.final` (via `combine_masks`), bin count.
  **Produces:** `state.histogram = { x: binCenters, y: counts, min, max, binWidth, binCount }`.
- **Mesh notes / pitfalls:**
  - Doc `generateHistogram(events, "DNA_A", binCount, min, max)` maps over event
    objects with fixed `min=0, max=1000`. **Rewrite** to iterate `channels.DNA_A`
    where `masks.final[i] === 1`, and set `min/max` from the data range, not
    literal 1000. Reuse `plot_bin_count()` for `binCount` and
    `shared_range_for_values([...])` (or the doc's own range) for `min/max`.
  - Produce **bin centers** as `x` (`min + (i+0.5)*binWidth`) since Stage 6
    expects `x` = strictly-increasing bin centers and `y` = counts. This mirrors
    `build_histogram_summary` output (`binCenters`, `counts`) — you may reuse that
    helper directly instead of the doc's function.
  - Y-axis "0 → max across all bins" (doc checklist) is handled by the existing
    render y-domain logic; note the histogram object carries counts for that.
- **Checklist coverage:** histogram with N bins (256/512/1024, from
  `plot_bin_count`); y from 0 to max bin count (render handles the axis).

### Stage 5 — Peak detection for G1/G2M (Step 6b)
- **Source:** `dean_jett_fox_implementation.md:2546–3097` (`detectDNAContentPeaks`).
- **Consumes:** `state.histogram`. **Produces:** `state.peaks` (`{ found, mu1,
  mu2, ratio, retainedPeaks, smoothedHistogram, ... }`).
- **Mesh notes / pitfalls:**
  - Call with `detectDNAContentPeaks(histogram.y, { histogramMin: histogram.min,
    binWidth: histogram.binWidth, sigma: 2, ... })`.
  - This is independent of Stage 6's *internal* peak detection
    (`chooseG1G2Peaks`, `dean_jett_fox_implementation.md:3593`). Stage 5 is a
    standalone inspection/hint step. Optionally pass `peaks.mu1/mu2` into Stage 6
    as initial hints, but Stage 6 self-initializes by default — keep them decoupled
    unless a hint is explicitly wanted.
  - Warn (doc): tallest peak is not necessarily G1 (2C-dominant yeast) — surface
    `ratio` and both peaks in the readout.
- **Checklist coverage:** smooth; local maxima; prominence filter; score
  lower/upper pairs near ratio 2; choose best; mu1/mu2 as 1C/2C means.

### Stage 6 — Single-cycle DJF fit (Step 7)
- **Source:** `dean_jett_fox_implementation.md:3101–5261` (`fitCellCycleHistogram`,
  self-contained LM). Exported by the doc as an ES module.
- **Consumes:** `state.histogram` (`x=binCenters`, `y=counts`). **Produces:**
  `state.baseFit` (`{ parameters, curves:{x,observed,g1,s,g2,fitted,residuals},
  diagnostics }`).
- **Mesh notes / pitfalls:**
  - Port the doc's Section-1–22 code near-verbatim into `legacy_bridge_fit.js`; keep the
    `export { fitCellCycleHistogram }`. Move shared `median/clamp/...` to
    `util_numeric.js`.
  - **Uses its own LM** — no `ml-levenberg-marquardt` dependency. Do not route
    through the old `djf.fit`.
  - `x` must be strictly increasing (bin centers satisfy this).
  - `unlockRatio:false` default (G2 = 2·G1). Expose `cvMin/cvMax`, `ratioTarget`,
    `weightedResiduals` as options surfaced later if wanted.
  - The pipeline's phase model differs from old `djf.js` (`components`,
    `s_phase_height`) — this **replaces** it; do not mix.
- **Checklist coverage:** all initialization items (mu1/mu2 from bins, R=mu2/mu1,
  sigma from FWHM, amplitudes from area, S bridge), constrained NLLS loop with the
  listed constraints, returns params + curves.

### Stage 7 — Debris/aggregate contamination refit (Step 8) — **(opt)**
- **Source:** `dean_jett_fox_implementation.md:5264–8009` (`extendCellCycleFit`).
  Exported ES module.
- **Consumes:** `state.histogram` + `state.baseFit` (needs
  `previousFit.parameters` and `previousFit.curves.residuals`). **Produces:**
  `state.extendedFit` (adds `curves.aggregate`, `curves.debris`, `selectedModel`,
  candidate comparisons).
- **Mesh notes / pitfalls:**
  - `extendCellCycleFit(x, y, previousFit, options)` where `previousFit =
    state.baseFit`. Gate the button so it errors clearly if Stage 6 hasn't run.
  - Self-contained LM again. Port Sections 1–31 into `debris_aggregate_extension.js`, sharing
    `util_numeric.js`.
  - Conservative model selection (BIC/SSE/targeted-residual thresholds) is
    built-in — surface `selectedModel` + `diagnostics.comparisons` in the readout
    for debugging.
- **Checklist coverage:** inspect residuals; add aggregate term (parameter `p`)
  if excess near 2C multiples; add debris term if excess near zero/left shoulder;
  joint refit; compare fit quality; keep simpler model unless materially improved.
- **Known gap:** the doc's aggregate model is an x-doubled self-convolution
  approximation and debris is the Bagwell sliced-nucleus family in §7a/7b
  (`dean_jett_fox_implementation.md:5272–5303`), but the shipped **code** uses a
  simpler aggregate = `0.5·p·F(x/2)` and exponential-left-edge debris. Implement
  the code as written; note the math/code divergence for a later fidelity pass.

### Stage 8 — Report fractions + diagnostics (Step 9)
- **Source:** `dean_jett_fox_implementation.md:8011–10499` (`summarizeCellCycleFit`,
  `createDisplaySummary`, `integrateTrapezoidal`). Exported ES module.
- **Consumes:** `state.extendedFit ?? state.baseFit`, plus the sample's channel
  names. **Produces:** `state.report` (areas, biological-singlet fractions
  %1C/%S/%2C, contamination fractions, goodness-of-fit, residual structure,
  warnings).
- **Mesh notes / pitfalls:**
  - Pass real channel names for pulse-geometry detection: `channelNames =
    parameter_map(row.summary).flatMap(p => [p.label, p.name, p.desc])` (or just
    `row.summary.columns`). Alternatively set `pulseGeometryAvailable` explicitly
    from Stage 3's `singletResult.geometryMode !== null`.
  - Render the summary via the existing `render_fit_results_table` (extend it to
    show %1C/%S/%2C + contamination + key GoF + warnings) and/or `djf_readout`
    text through `createDisplaySummary`.
- **Checklist coverage:** integrate each component; 1C/S/2C over biological
  singlet total; contamination fractions separately; goodness-of-fit; warnings
  (no pulse geometry, one visible peak, ratio far from expected, parameter at
  boundary, poor residual structure).

### Not covered by any code block — flag, don't invent
- **General background `B(x)`** appears in the full DJF formula and the "Cleaning
  options" list (`dean_jett_fox_implementation.md:57–68`) but **no sample code**
  implements it. Leave a clearly-labeled `stage_background` stub / TODO; do not
  fabricate an algorithm. Note it in the readout as "not yet specified."

---

## 5. Loader changes (full-fidelity data model)

Files: `js/io/channel_loading.js`, `js/fcs/channel_cleaning.js`,
`js/io/parameter_map.js` (helpers), `js/data_structs/channel_cache.js` (guard).

1. **Auto-identify helper channels.** Add
   `find_pipeline_channel_indexes(params)` in `channel_cleaning.js` that locates
   FSC-A, SSC-A, and Time by name patterns against `param.label/name/desc`
   (reuse `normalize_measurement_name`): FSC-A ≈ `fsc` + area token; SSC-A ≈ `ssc`
   + area token; Time ≈ `time` / `hdr-t` / `$TIMESTEP`-associated param. Return
   `{ fsc_a, ssc_a, time }` (1-based indexes or null). DNA_H/DNA_W keep using
   `find_auxiliary_indexes_for_file`.
2. **Extend `selected_indexes_for_file`** (`channel_loading.js:183`) to merge in
   `{ fsc_a, ssc_a, time }`.
3. **Request all indexes** in `load_analysis_row` via `unique_indexes([dna_a,
   dna_h, dna_w, fsc_a, ssc_a, time])`.
4. **Stop compacting.** Replace `filter_selected_channel_values` usage: keep raw
   `Float64Array` per channel of length `eventCount`; do **not** drop rows. Build
   `pnr` from `summary.metadata['P{index}R']` per channel (parse to Number, null
   if absent). Structural filtering now happens in **Stage 0**, not the loader.
   - Keep a thin `filter_selected_channel_values` (or a new
     `build_channel_arrays`) that returns `{ channels, pnr }` without compaction.
5. **Assemble the new `row.data`** (§3.2) including the `dna_a` alias =
   `channels.DNA_A`, `eventCount`, `channels`, `pnr`, `masks` (all null), extended
   `indexes`.
6. **Cache guard:** `is_analysis_data_loaded`/`cached_analysis_data` check
   `data.dna_a` — still true via the alias. No change needed, but confirm.
7. **Worker path:** `js/fcs/data_worker.js` already reads arbitrary selected
   indexes; passing more indexes needs no worker change (verify `columns` keyed by
   index round-trips the extra channels).

**Backward-compat check:** after this change, `row.data.dna_a` is raw
(uncompacted) rather than positive-only. Confirm `shared_range`,
`update_plot_title`, and `histogram_curve` behave (they do: NaN skipped in
binning; linear axis tolerates ≤0; range is percentile-based). Note the visible
raw plot (pre-Stage-0) is expected and desirable for debugging.

---

## 6. UI: one manual button per stage

Files: `index.html`, `js/ui/dom.js`, `js/ui/panels.js`,
`js/analysis/pipeline_ui.js`, `js/analysis/start.js` (or `main.js`) for init,
`css/` for button styling.

1. **Markup.** Add a "DJF Pipeline (manual)" control group in the plot-controls
   region of `index.html` (near the existing correction toggles around
   `index.html:188–216`). One `<button>` per stage with stable IDs:

   | ID | Label |
   |---|---|
   | `#djf_stage0` | `Stage 0: Structural QC` |
   | `#djf_stage1` | `Stage 1 (opt): Time QC` |
   | `#djf_stage2` | `Stage 2 (opt): Cell Gate` |
   | `#djf_stage3` | `Stage 3 (opt): Singlet Gate` |
   | `#djf_stage4` | `Stage 4: Histogram` |
   | `#djf_stage5` | `Stage 5: Peaks` |
   | `#djf_stage6` | `Stage 6: Fit DJF` |
   | `#djf_stage7` | `Stage 7 (opt): Debris/Aggregate` |
   | `#djf_stage8` | `Stage 8: Report` |

   Optionally a `#djf_run_all` convenience button. Keep the existing debris/doublet
   toggles for now (they drive old `djf.js` until retirement) or hide them behind
   the new flow — do not delete until §8. Also add the `#djf_scatter_modal` markup
   (hidden by default, same shape as the existing `.stats_modal` / metadata-wizard
   modals with a `.stats_modal_backdrop` + close button) for the Stage 2 view.

2. **DOM refs.** Export the buttons from `js/ui/dom.js` (co-locate with other plot
   controls) and/or `js/ui/panels.js`.

3. **Behaviour (`pipeline_ui.js`).** On each button click:
   - Lazy-load the pipeline via `pipeline_loader.js` (model on `djf_loader.js`,
     reuse `show_progress/update_progress/hide_progress`).
   - Determine target sample(s): default to **all `plottable_rows()`**; store
     per-sample state by `row.name`. (For a single-sample debug focus, you may
     scope to the first shown/selected row — keep it simple and documented.)
   - Call the orchestrator `run_stageN(row)` for each; it reads prior state,
     runs only that stage, updates `row.data.masks` / `state`, and returns a
     concise diagnostic.
   - Gate ordering leniently: if a prerequisite mask/state is missing, the stage
     either treats it as all-pass (masks) or reports a clear "run Stage N-1 first"
     message (Stage 6/7/8). Do not silently no-op.
   - Write diagnostics to `djf_readout` (per-sample one-liners) and, for visual
     stages, trigger `render_density_plot()`:
     - Stage 2 → open `#djf_scatter_modal` (FSC/SSC scatter + gate ellipse; see
       Stage 2) in addition to storing `masks.scatter`.
     - Stage 4 → draw the masked histogram.
     - Stage 6/7 → overlay fitted total + G1/S/G2 (+ debris/aggregate) using the
       existing area/line drawing in `render.js`.
     - Stage 8 → populate the report table via `render_fit_results_table`.
   - Optional stages: no-op-with-note is acceptable when the required channel is
     absent (Time / FSC+SSC / H+W).

4. **Init.** Call `init_pipeline_ui()` from the `main.js` bootstrap block
   (alongside `init_analysis_listeners()`), and add `get pipeline()` to
   `window.PhaseFinder`.

---

## 7. Render/modeling rewire

File: `js/plotting/render.js`, `js/plotting/modeling.js`.

- Replace the `djf.prepare_row / fit / components / phase_stats` calls in
  `render_density_plot()` (`render.js:135–223`) with reads from pipeline state:
  - Values to bin: `channels.DNA_A` filtered by `masks.final` (fallback raw).
  - Fitted curves: from `state.extendedFit ?? state.baseFit` `curves`
    (`x, g1, s, g2, fitted`, plus `aggregate/debris` when present). Convert each
    to `{x,y}[]` for the existing d3 `area`/`line`.
  - Fractions/readout: from `state.report` (Stage 8) or base fit diagnostics.
- Keep all existing D3 scaffolding (axes, legend, threshold line, axis modal,
  bins/curve display modes, colors). Only the data source changes.
- `modeling.js`: `render_fit_results_table` extended for the Stage 8 report;
  `update_plot_title` still reads `row.data.dna_a.length` (alias) — fine.
- Because the pipeline is manual, `render_density_plot` should draw whatever
  pipeline state currently exists (e.g., raw histogram before Stage 4; overlay
  after Stage 6). Guard every stage read with existence checks.

---

## 8. Retire overlapping old code (after parity)

Once the new path draws + reports correctly:

- Remove now-unused exports from `js/analysis/djf.js`: `prepare_row`, `fit`,
  `components`, `phase_stats`, `fractions`, `build_histogram`, `detect_peaks`,
  `best_g1g2_pair`, `seed_fit`, `estimate_run_g1`, `correction_summary`, etc.
  Keep `find_auxiliary_indexes` only if still referenced (unit test #8/#13/#14);
  otherwise move that thin adapter or point the test at
  `find_auxiliary_indexes_for_file`.
- If nothing else imports them, drop `import { levenbergMarquardt } from
  "ml-levenberg-marquardt"` and `import { gsd } from "ml-gsd"`, and consider
  removing those vendored files + their `index.html`/`test_harness.html` import-map
  entries. (d3 stays.)
- Update `djf_loader.js` / `get_djf()` debug hook: either repoint to the new
  pipeline or keep both `djf` and `pipeline` during transition.
- Remove/replace the old debris/doublet toggle path in `render.js`
  (`correction_state`) once Stage 0–3/7 buttons cover it.

Do this as a separate commit so parity and retirement are reviewable apart.

---

## 9. Sequencing & commits

1. **Branch + scaffolding:** `djf-pipeline` off `esm-restructure`; create the
   shared `js/analysis/math/` helpers and empty checkpoint modules directly
   under `js/analysis/`. Commit.
2. **Loader full-fidelity:** §5 (channels + pnr + masks + alias). Verify the plot
   still renders raw. Commit.
3. **Stages 0–3 (masks/gating)** + `pipeline_state.js` + orchestrator entries +
   buttons for 0–3. Verify masks via `window.PhaseFinder.pipeline`. Commit.
4. **Stages 4–6 (histogram → peaks → fit)** + buttons + render overlay of the base
   fit. Commit.
5. **Stages 7–8 (extend + report)** + buttons + report table. Commit.
6. **Rewire `render.js`/`modeling.js`** fully onto pipeline state; **retire** old
   `djf.js` overlap (§8). Commit.
7. **Tests** (§10). Commit.

---

## 10. Verification

- **Unit (Playwright + `test_harness.html`):**
  - Add the new pipeline modules to `test_harness.html` imports and expose on
    `window` (e.g., `window.PhaseFinderPipeline = { stage0, ..., stage8 }` or via
    `window.PhaseFinder.pipeline`).
  - New `tests/unit/unit_tests_djf_pipeline.py` (copy `unit_tests_djf.py` shape;
    register in `run_unit_tests.py`). Cover, per stage:
    - Stage 0: synthetic channels with NaN/≤0/≥PnR events → correct
      `structural` mask; Time exempt from upper bound.
    - Stage 1: crafted Time series with a wrap + a backward jump → correct
      segments/bins; an injected outlier bin gets `|z|>4` flagged.
    - Stage 2: two Gaussian blobs in FSC/SSC → main component chosen, ellipse
      mask keeps the tight cloud; skip path when FSC/SSC absent.
    - Stage 3: A/H ridge on singlets + injected doublets → doublets removed;
      A/W fallback; skip path (no H/W) sets `optionalAggregateTermRecommended`.
    - Stage 4: masked histogram counts match a hand-computed case; bin centers
      strictly increasing.
    - Stage 5: `buildBimodalHistogram(256)` → `found`, ratio ∈ [1.8,2.1].
    - Stage 6: bimodal histogram → G1 in range, G2/G1≈2, fractions sum ≈100%,
      `converged`.
    - Stage 7: residual with a 2C-multiple excess → aggregate selected; clean
      residual → base retained (conservative selection).
    - Stage 8: fractions %1C/%S/%2C sum ≈100% over singlet total; warnings fire
      for a one-peak / ratio-off case.
  - Reuse `window.TestUtils`; extend it with builders for FSC/SSC/Time-bearing
    synthetic FCS if needed.
- **E2E (`tests/e2e/`):** add `tests_pipeline.py` (register in `drive_flow.py`)
  that loads a fixture from `tests/test_data/`, selects a DNA channel, clicks
  Stage 0→8 buttons in order, and asserts each readout/plot update (masks reported,
  Stage 2 scatter modal opens/closes when FSC+SSC exist, histogram drawn, fit
  overlaid, fractions shown). Model on `tests_modeling.py`. Note the current
  fixtures may lack FSC/SSC/Time — add a builder or fixture that includes them so
  Stages 1–2 exercise their non-skip paths.
- **Manual smoke (per the ESM setup):** serve with `python3 -m http.server`
  (ESM needs HTTP, not `file://`), load a fixture, run each stage button, and
  inspect `window.PhaseFinder.pipeline.get_state(name)` in DevTools to confirm
  masks/GMM/ridge/histogram/fit/report populate. Use the `/run` skill / project
  run flow if present.
- **Regression:** existing `unit_tests_djf.py` will change as old `djf.js`
  exports are retired — update or remove those cases in the same commit as §8 and
  note it explicitly (don't leave them silently failing).

---

## 11. Known gaps / call-outs for the implementer

- **PnR scale (Stage 0):** never hardcode `1000`; derive per-channel upper margin
  from `$PnR`. This is the single most likely way to silently drop all events.
- **Structural lower bound (Stage 0):** per user decision, `value === 0` is KEPT
  (discard only `value < 0`). This diverges from the doc's `value > 0` sample and
  its `=== 0 → discard as lower-margin event` checklist item — comment it clearly
  and revisit if 0-valued margin events distort the low end of the histogram.
- **General background `B(x)`:** no code exists in the doc — stub + TODO, don't
  invent.
- **Stage 7 math vs. code divergence:** doc's §7a/§7b (self-convolution /
  Bagwell) differ from the shipped simpler aggregate/debris code. Implement the
  code as written; flag for a later fidelity pass.
- **timerRange (Stage 1):** derive from `$TIMESTEP`/Time `$PnR` when available;
  `32.6824` is only a fallback.
- **Per-sample vs. all-samples runs:** the manual UI defaults to all
  `plottable_rows()`; keep state per `row.name`. Confirm this matches your
  debugging preference or scope to one active sample.
- **Numeric util dedup:** the doc repeats `median/mad/clamp/quantile/...` and a
  full `solveLinearSystem`/LM loop across stages; consolidate into the themed
  `math/` modules + `djf_components.js` per §3.5 to avoid several drifting copies.
