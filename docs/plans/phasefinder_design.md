# PhaseFinder — architecture, models, and design

**Consolidated:** 2026-08-15 · **Companion:** [`docs/audits/master_checklist.md`](../audits/master_checklist.md) — everything *left to do*

This document describes what PhaseFinder **is**: how it is built, what the models actually compute, and the design of features not yet implemented. It is the reference; the checklist is the work queue. Specifications that already exist in depth (the DJF reference implementation, the modeling plan, the Time QC spec) are cited rather than duplicated.

---

## 1. What it is

A browser-based tool for flow-cytometry DNA-content analysis. Users drop `.fcs` files into the page, inspect metadata in a sortable table, plot a DNA-content event histogram, run quality-control filters, then fit a cell-cycle model to estimate the fraction of cells in G1, S, and G2/M.

**Users** are bench biologists and flow-cytometry core staff — not developers.

**Everything runs locally.** Files are read by browser APIs. There is no upload server, no database, no telemetry. The only persistence is optional browser-private caching.

### Hard constraints

These are architectural commitments, not preferences:

| Constraint | Consequence |
|---|---|
| **No framework** | Vanilla ES modules in `js/`, plain CSS in `css/`. No React/Vue, no CSS preprocessing. |
| **Fully self-contained** | Strict CSP `default-src 'self'`. No CDN, no external fonts, no remote images. D3 is vendored at `js/vendor/d3.min.js`. |
| **Static hosting only** | The build output is static files. Deployed to Cloudflare Pages; also runs from any static server — **including the unbuilt source tree**, because the sole bare import (`d3`) resolves through an importmap. |
| **Local-first** | No data leaves the browser. Session caching uses OPFS, which requires a secure context. |
| **Honest reporting** | A number that cannot be trusted must not be presented as if it can. This is a design principle with teeth — see §7. |

---

## 2. Architecture

### 2.1 Module layout

137 modules, 428 edges, zero import cycles (enforced by `npm run check:imports`).

```
js/
├── main.js                    entry point; wires every subsystem
├── fcs/                       FCS parsing (header, TEXT, DATA), data_worker
├── io/                        metadata import/export, channel loading
├── data_structs/              table frame, derived columns
├── analysis/
│   ├── pipeline_loader.js     lazy-loads the analysis pipeline behind a progress UI
│   ├── cell_cycle_pipeline.js the live pipeline (lazy-loaded as one module)
│   ├── pipeline_ui.js         QC gate controls
│   ├── structural_qc.js       gate 1
│   ├── acquisition_time_qc.js gate 2a — robust summary
│   ├── peak_tracking_time_qc.js gate 2b — peak tracking
│   ├── scatter_gmm_gate.js    gate 3 — FSC/SSC cell cloud
│   ├── pulse_geometry_gate.js gate 4 — singlet discrimination
│   ├── dna_histogram.js       masked histogram construction
│   ├── cell_cycle_fit_report.js  goodness of fit, residual structure, warnings
│   ├── math/                  gaussian, poisson, quadrature, lm_solver, linalg2d, stats
│   └── cell_cycle/
│       ├── model_registry.js  explicit registration; no import-time side effects
│       ├── models/            dean_jett, dean_jett_fox, watson_pragmatic,
│       │                      watson_classic, cloccs, legacy_bridge, shared
│       ├── peak_detection.js  multi-scale detection
│       ├── peak_regions.js    region validation + local peak estimation
│       ├── fit_client.js      worker pool
│       ├── fit_worker.js      off-thread fitting
│       ├── result_contract.js the honesty gate
│       ├── modeling_state.js  per-sample state
│       └── modeling_ui.js     sidebar controls
├── plotting/                  render, viewport, modeling overlay, export, axis modal
├── session/                   TOML session I/O, OPFS cache, reconnect
├── ui/                        dom bindings, table render, modals, panels, compatibility
└── vendor/d3.min.js
```

**`js/ui/dom.js` centralises every `document.querySelector`.** `npm run check:dom` fails the build if markup and bindings drift (currently 225 static ids, 4 generated).

> **Dead code:** `js/analysis/djf/` (21 files, 6,630 lines) is an unreachable duplicate of the live pipeline with **identically named files** (`pipeline_ui.js`, `pipeline_state.js`, `scatter_modal.js`, `stage8_report.js`). Nothing imports it. Tracked for deletion as CLEAN-01.

### 2.2 Data flow

```
.fcs file
   → fcs/ parser (worker)      → raw channel arrays, $PnR metadata, event count
   → row.data                  → every channel array has length === event_count, always
   → QC gates                  → each writes a MASK; originals are never mutated
   → composed final mask       → dna_histogram.js bins the surviving events
   → peak detection            → proposed G1 / G2 regions, confidence, review flag
   → user review               → regions accepted (explicitly)
   → model fit (worker)        → parameters, components, curves, diagnostics
   → result contract           → reportable? converged? warnings?
   → plot + table + session
```

**Two invariants make this tractable:**

1. **Length contracts.** Every channel array equals `event_count`. Mask lengths are validated against `eventCount` on every `set_stage_mask` / `combine_masks`.
2. **Mask provenance is explicit.** A skipped optional gate stores `null` — *not* a pass-through mask of all-ones. So "this gate did not run" and "this gate ran and kept everything" are distinguishable forever after. Invalidating a stage clears downstream state and masks and recomputes the composite.

### 2.3 Concurrency

Four workers: `data_worker` (FCS parsing), `fit_worker` (per-sample model fitting, run as a pool), `cloccs_worker` (joint time-series fitting), `copy_worker` (OPFS file copying). All constructed as `new Worker(new URL("./x.js", import.meta.url), { type: "module" })` — native ESM, which works bundled *and* unbundled.

The analysis pipeline is **lazy-loaded as a whole** behind a visible progress indicator (`pipeline_loader.js`), keeping the numeric modules off the initial application graph.

> **Known gap:** `fit_client.js` still falls back to the main thread when no worker is available, so a canonical scientific fit can silently run on the UI thread. Tracked as PERF-01.

---

## 3. Quality control

Four gates, applied in a deliberate order. Automated preprocessing works in layers: remove acquisition artifacts over time first, then debris, then doublets, and only then fit. Order matters because clogs, flow-rate surges, and margin events distort the very populations the model quantifies.

| # | Gate | What it does | Optional? |
|---|---|---|---|
| 1 | **Structural** | Rejects non-finite, negative, and saturated measurements using the `$PnR` ceiling. Preserves original event indexes. | No — a mandatory finite/non-negative DNA filter always runs |
| 2 | **Time** | Removes unstable acquisition periods. Two methods, user-selected. | Yes |
| 3 | **Cell gate** | Two-component GMM on FSC/SSC in standardized coordinates; selects the biological cloud. Manually editable (drag, rotate, resize). | Yes |
| 4 | **Singlet gate** | Pulse-geometry discrimination (A/H or A/W) with robust scaling. | Yes |

**Structural QC does most of the work.** Measured across the 30-sample reference set: with structural QC the `g1_mean` median is 0.996× reference with 23/30 within ±5% and **0 period-doubled fits**; with no QC it is 1.086× with 8/30 and 2 doubled. Cell-gate and Time QC alone are indistinguishable from no QC *for peak placement* — because the `$PnR` saturation ceiling is what removes the extreme aggregate tail that wrecks the histogram range.

> **Do not read that as "use less QC."** Singlet gating correctly removes G1–G1 doublets that sit at 2C and would otherwise be counted as G2. It diverges from the FlowJo reference because FlowJo's own gating is undocumented, not because it is wrong.

### 3.1 Time QC methods

- **Robust summary** — monitors each acquisition bin's event rate, medians, and IQRs; flags bins deviating beyond MAD-scaled limits.
- **Peak tracking** — follows major density peaks across overlapping acquisition bins and rejects regions where those peaks shift abnormally. Retains an explicit **missing/imputed mask** per track and bin, so a disappearing population is treated as evidence rather than neutral data. Full specification: `docs/plans/peak_tracking_time_qc_implementation_spec.md`.

An acquisition-order diagnostic plot (`time_qc_diagnostic_plot.js`) renders tracked peak positions, rejected-bin shading, and segment boundaries with a channel picker. The raw per-event scatter layer is deliberately omitted — per-event values are not retained past Stage 1, and the spec itself notes tracked peaks are more informative for this mode.

---

## 4. Peak detection and regions

Detection smooths the histogram at multiple scales (`[1, 2, 4]` bins by default) and proposes G1 and G2/M regions with a confidence score and a review flag.

**Local peak estimation** (`peak_regions.js`) is separate from fitting and drives both the live preview and the models' starting values:

1. Find the smoothed argmax inside the region.
2. Estimate σ from the **clean flank only** — the side facing away from S phase — by walking out to a configured height fraction.
3. Fall back to a baseline-subtracted second moment, then to the region span, when the flank estimate is unusable.
4. Estimate area from a unit-Gaussian template ratio over an asymmetric window.

**Known biases, measured:** σ is inflated ~23% (G1) / ~11% (G2) because the smoothing kernel is never deconvolved, and the mean is quantized to a bin centre. See MODEL-03 / MODEL-04.

### 4.1 Two ambiguities no single histogram can resolve

These are **mathematical properties of the data**, not bugs to be fixed:

- **A lone peak is unidentifiable.** A pure G1 population and a pure G2 population produce histograms identical up to an x-axis scale factor. PhaseFinder currently assumes the lone peak is G1 — an unmarked guess, silently wrong on a G2-arrested sample.
- **(1C,2C) and (2C,4C) are both ~2:1.** Two local discriminators were tried and both provably fail: a position rule promotes debris spikes, and a CV-width rule is defeated because the smoothing the detector needs destroys the width evidence (a σ=1 spike measures √(1²+4²)≈4.1 bins, indistinguishable from a real σ=4.2 peak).

**Resolution requires information from outside the histogram:** channel calibration (beads/known control), cross-sample anchoring (one acquisition run shares a DNA axis, so samples showing two peaks fix 1C for those that don't — the strongest available option), or recorded condition metadata (`Nocodazole Arrest` is already carried).

---

## 5. The models

Registered explicitly by `register_default_models()` — no import-time side effects, so tests control exactly what exists.

### 5.1 Observation model

Counts are Poisson. The objective is the Poisson deviance; the reported log-likelihood includes the `lgamma(y+1)` term so AIC/BIC are standard absolute values, comparable across tools rather than only within one histogram.

### 5.2 Shared components

**Integrated peaks.** G1 and G2/M are Gaussians integrated over each bin — `area × [Φ((b_{i+1}−μ)/σ) − Φ((b_i−μ)/σ)]` — not point-sampled. Verified: area is conserved exactly, including for peaks narrower than one bin.

**S phase** is a latent-occupancy integral. Every latent DNA position `u(z) = μ₁ + z·(μ₂−μ₁)`, `z ∈ [0,1]`, carries `q(z)·dz` of occupancy and its own CV-scaled Gaussian broadening `σ_S(u) = CV₁·u`. Per-bin counts are the Gauss–Legendre quadrature sum of each node's broadened contribution.

**The S profile uses the quadratic Bernstein basis:**

```
q(z) = w₀(1−z)² + 2w₁z(1−z) + w₂z²
```

Nonnegative **by construction** — which is the point. The previous direct `a + bz + cz²` form needed post-hoc repair (repeatedly multiplying shape terms by 0.7 until positive), an undocumented nonsmooth operation that changed both the model shape and the optimizer surface. Weights sum to 3 because each basis polynomial integrates to 1/3, so `∫₀¹ q(z)dz = 1` and total S mass equals `sArea` exactly.

*Verified by execution: profile integral 1.000000; minimum ≥0 across extreme shape parameters (2.6e-26); S mass equals `sArea`; inverted peaks return zeros rather than NaN; degenerate CV stays finite.*

### 5.3 The registered models

| ID | Scope | Status | What it is |
|---|---|---|---|
| `dean_jett` | per-sample | canonical | Two integrated Gaussians + Bernstein S profile, Poisson ML |
| `dean_jett_fox` | per-sample | canonical, **default choice** | Dean–Jett plus a Gaussian wave term letting S take a more complex shape |
| `watson_pragmatic` | per-sample | canonical | Decomposition, not a fit — see below |
| `watson_classic` | per-sample | canonical | Original Watson formulation, for comparison with published results |
| `cloccs` | **joint_series** | `0.1.0-unverified` | Fits shared timing parameters across a strain's timepoints together |
| `legacy_bridge_v1` | per-sample | **quarantined** | Pre-canonical implementation; `exploratory: true`, refused by the contract, absent from the dropdown |

**There is no "Automatic" model.** One existed and was removed: it chose between DJ and DJF by an information criterion, but that comparison is **unidentifiable while the peaks are frozen**. Measured on a wave-free fixture it selected "synchronous" at ΔBIC −102.9; frozen at the *true* peaks the same code correctly selected asynchronous at ΔBIC +16.7. The code was right; the peaks were not. Retiring it also removed the BIC architecture the reference prescribes — tracked for return as MODEL-07.

**Watson Pragmatic** is deliberately different in kind. It estimates each peak locally from its clean flank, then takes S as the observed residual — *strictly between the two fitted peak centres*. Sub-G1 debris and post-G2 aggregates can never be reclassified as S. It models no separate contaminant component, and because it is a decomposition rather than a generative model its results are **never** AIC/BIC-ranked against DJ or DJF.

### 5.4 The estimator that ships: peaks-first

DJF freezes G1 and G2 at their clean-flank estimates and fits only the S-phase parameters. This is not an accident of implementation; it is the outcome of a measured decision.

**Freeing the peaks into a joint fit was tried and is much worse:** `all_pass` 8/30 → **0/30**; %S median −2.9pp → **+12.0pp**. Freezing is what holds S in check; freed, the S term expands to swallow G2. Synthetic fixtures suggested the opposite because they were generated by DJF's own equations with clean, well-separated Gaussians.

**The real target is neither "freeze" nor "free" — it is a less biased frozen estimate.** Freezing an unbiased estimate is what the FlowJo-style approach assumes; freezing a biased one is what currently happens. Proof the rest of the model is sound: freeze at the **true** peaks and deviance drops from 1289.6 to 46.1 (28×).

Consequence: DJF's ratio and CV settings are **inert** — they constrain peak means and widths the optimizer never moves. `settings_applicability()` records them as not-applied and excludes them from the config hash, so the result key stops claiming a difference that does not exist.

### 5.5 Current accuracy

30-sample FlowJo Dean–Jett–Fox reference set, asynchronous budding yeast, structural QC:

| metric | value | verdict |
|---|---|---|
| converged | 30/30 | ✅ |
| valid for reporting | 30/30 | ✅ |
| `g1_mean` | median −1.5%, passes 30/30 | ✅ but see MODEL-02 |
| `g2_mean` | median −3.2%, passes 10/30 | ❌ |
| g2:g1 ratio | median 1.974 (ref 2.0088) | ◐ likely correct — see below |
| %G1 / %S / %G2 | +3.4pp / −3.4pp / +7.0pp | ◐ |
| `all_pass` | 7/30 | — |

**The `g2_mean` gap decomposes exactly** into a −1.5% G1 offset plus a −1.73% ratio difference (−3.23% vs −3.2% observed). And **the ratio half is probably correct science**: chromatin condensation in G2/M restricts dye accessibility, so the true ratio sits below 2.0. Our free-fitted 1.974 is what that predicts; the reference clusters on the theoretical 2.0. Full evidence in the checklist under MODEL-01.

---

## 6. Result contract — the honesty gate

`result_contract.js` is the single place a fit becomes reportable, and it distinguishes **three questions that are genuinely different**:

| Question | Field | Meaning |
|---|---|---|
| Did the optimizer converge? | `converged`, `convergenceReason` | Requires **both** objective and step tolerance, plus a scaled-gradient criterion. Distinct termination states for boundary stall, step stall, numerical failure, and max iterations. |
| May the result be reported? | `validForReporting`, `validityReasons` | Separate. A converged fit can still be refused — parameter pinned at a bound, excessive modelled mass outside the histogram, required QC unavailable, un-acknowledged critical QC removal. |
| What should the user know? | `warnings` | Things the fit cannot decide: complex S shape, peak near a constraint, unusual residual structure. |

`apply_result_contract()` **requires** a preflight bundle and stamps `contractVersion`; `is_reportable_result()` and `get_active_model_result()` demand that stamp, so an un-validated result cannot masquerade as validated. It also overrides a contradictory `converged: true` for known non-converged termination reasons.

`fit.phaseFractions` is the **sole authoritative** %G1/%S/%G2 contract. Any visible-domain recomputation must be exposed under a different, explicitly domain-limited name.

> **The gap that matters:** the contract is honest and the UI is not. Percentages render larger and darker than the caveats qualifying them, and `#cell_cycle_fit_result` has no live region at all. Tracked as UI-01 — the highest-priority UI item precisely because it has scientific consequences.

---

## 7. Sessions and storage

Sessions are TOML. The file stores enough to **reconnect** the original FCS files — it does not embed event data.

- **OPFS** holds optional browser-private FCS copies for fast reload. Requires a **secure context**: works on HTTPS and `localhost`, silently unavailable on a plain-HTTP LAN address.
- Files are verified by **content digest**, so a same-name/same-size file with changed bytes is rejected rather than silently reused.
- Restores are **transactional**.
- Sessions record `model_version`; on drift, restored results are labelled `recomputed_new` rather than implying exact reproduction.
- TOML parsing guards `__proto__` / `prototype` / `constructor` and builds with `Object.create(null)`.

---

## 8. UI structure and design system

Header · sidebar (file/channel controls, swapping to QC + peaks + model panels) · metadata table · plot panel · footer status bar. Both panel dividers are keyboard-operable `role="separator"` controls. Modals share one focus controller (`js/ui/modal_focus.js`).

**Announcements** use one deliberate channel: `role="status" aria-live="polite"` on the footer for routine updates, plus a separate `role="alert"` element for actionable failures.

**The design system is token-based** (`css/base.css`), which is what makes a dark theme tractable. Current tokens cover surfaces, brand/accent, status, focus rings, component surfaces, callouts, shadows, and the plot series read by `plotting/data.js` through `getComputedStyle`.

> **Known token defect:** `--border: #d9dee8` is **1.35:1** against white where WCAG requires 3:1 for control boundaries. Tracked as UI-03.

---

## 9. Designs for features not yet built

### 9.1 Residual panel

A strip beneath the main histogram showing per-bin `(fitted − observed)`. **The most direct visual evidence of whether a fit is good** — currently computed on every fit and displayed nowhere.

**Data is already available.** `fitResult.curves` carries `{ x, observed, g1, s, g2, fitted, residuals }`; the report validates their presence. This is a draw call, not a computation.

**Design decisions:**

- **Pearson-normalised by default** (`(fitted − observed)/√fitted`). Counts are Poisson, so raw residuals scale with peak height and the eye is drawn to G1 regardless of fit quality. A toggle exposes raw.
- **±2 band drawn first**, residual stems over it, zero line on top.
- **Shares the histogram's x-scale** so the strips align vertically with the features they explain.
- **Accessible equivalent is mandatory**, not decorative: the `<desc>` states how many bins fall outside ±2, as a percentage, and the largest deviation — the same facts a sighted reader takes from the shape.

```html
<div id="residual_panel" class="residual_panel" hidden>
  <div class="residual_panel_header">
    <span id="residual_panel_title">Residuals (fitted − observed)</span>
    <label class="residual_panel_toggle">
      <input id="residual_panel_normalize" type="checkbox" checked /> Pearson (÷√fitted)
    </label>
  </div>
  <svg id="residual_plot" role="img" aria-labelledby="residual_panel_title residual_plot_desc">
    <desc id="residual_plot_desc"></desc>
  </svg>
</div>
```

Tokens: `--residual_band_fill`, `--residual_band_edge`, `--residual_mark`, `--residual_mark_out`, `--residual_zero`. Implementation sketch in the checklist (UI-13).

### 9.2 Dark theme

Light stays the default and the fallback. Dark is defined **only as token overrides**, so every component already consuming tokens follows without change. The palette below was verified programmatically: all text ≥4.5:1 on all four surface tokens; all control boundaries and plot series ≥3:1.

```css
:root { color-scheme: light dark; /* …existing light tokens unchanged… */ }

/* System preference, unless the user explicitly chose light. */
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) { /* overrides below */ }
}
/* Explicit choice wins in both directions. */
:root[data-theme="dark"] { /* same overrides */ }
```

| token | dark | token | dark |
|---|---|---|---|
| `--bg` | `#0f141c` | `--danger` | `#ff9b91` |
| `--panel` | `#161d28` | `--success` | `#5ed6a4` |
| `--text` | `#e8ecf4` | `--restart` | `#ff8f8f` |
| `--muted` | `#a3aec2` | `--caution` | `#f0b64a` |
| `--border` | `#38424f` | `--focus_ring` | `#a9c6ff` |
| `--border_strong` | `#6b788c` | `--th_bg` | `#1c2532` |
| `--accent` | `#7aa8f5` | `--djf_s` | `#a9dd93` |
| `--accent_strong` | `#a9c6ff` | `--djf_total` | `#e8ecf4` |
| `--accent_soft` | `#1d2a3f` | `--djf_debris` | `#c4a9fb` |
| `--logo_teal` | `#3fd0d9` | `--djf_agg` | `#f5b455` |

Callout, shadow, and progress tokens follow the same pattern.

> **The trap to avoid:** the plot component colours are read through `getComputedStyle` **with hard-coded fallbacks chosen against white**. They must be re-validated against the dark surface, not assumed to inherit. And `test_contrast_tokens.py` must run in both themes or dark ships unverified.

### 9.3 Versioned fit export

`js/analysis/cell_cycle/export.js` — JSON and long-form CSV. The design principle: everything needed to (a) re-run the fit and (b) check the arithmetic independently must be present. That means model id **and version**, settings **and** their applicability, config hash, analysis domain, bin count, underflow/overflow, tail coverage, peak regions, QC provenance, bulk-region provenance, and the honesty fields travelling *with* the parameters rather than beside them. The application block carries the Vite-injected **source commit**, because a version number alone cannot identify which build produced a number. Full implementation in the checklist (FEAT-02).

---

## 10. How correctness is established

**Test layers:** browser unit suite (756 checks, green), end-to-end Playwright, production-`dist/` smoke, synthetic FCS parser/QC/model benchmarks, the 30-sample FlowJo comparison, and an independent-tool comparison in an isolated venv.

**The methodological lesson this project learned the hard way**, and the reason `cell_cycle_model_investigation_handoff.md` should be kept current:

> **Same-model-family synthetics are not validation.** Fixtures generated by DJF's own equations showed the joint estimator recovering `g1CV` exactly and holding S error to ~1.5pp. On real data the same change took `all_pass` from 8/30 to 0/30. Real yeast has skew, debris, and overlapping tails that the fixtures did not.

A second lesson from the same record: **perfect separation in aggregate data is not causal power.** Region width separated correct from period-doubled fits perfectly (≤4.0σ correct 16/16, ≥4.5σ doubled 14/14), so a width cap was applied — and fixed exactly **one** of fourteen failures. Narrowing the window around the wrong centre does not move the centre. Test the intervention, not the correlation.

**Known limits of the current validation:** one dataset, one instrument, one encoding, local-only and not redistributable; no uncertainty intervals on any reported fraction; peak-detection thresholds uncalibrated against annotated truth; the FlowJo reference is quantized to integer means and its gating is undocumented. Nothing here supports the word "validated" without the qualifiers in VALID-01.
