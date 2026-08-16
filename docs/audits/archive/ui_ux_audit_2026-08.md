# PhaseFinder UI/UX Audit — August 2026

**Auditor:** UI Designer
**Date:** 2026-08-14
**Branch:** `cell-cycle-report-warn`
**Scope:** `index.html`, `css/*`, sidebar/table/plot/feedback surfaces. Application code and CSS were **not** modified — this document and `docs/audits/ui_screenshots/` are the only artifacts.

---

## 1. Method

The unbuilt source tree was served with `python -m http.server` and driven with Chromium via Playwright (`~/.venvs/playwright`) using three synthetic fixtures with known ground truth
(`truth_dj_early_40_40_20.fcs`, `truth_s_rich_25_55_20.fcs`, `truth_high_cv_overlap_35_45_20.fcs`).

Captured at **1440×900**, **768×1024**, **390×844**, and **200 % zoom** (emulated as 720×450 CSS px at DPR 2, which is what a 1440×900 desktop window becomes at 200 %). The full workflow was driven end to end: load → channel → plot → QC → peaks → model → fit.

One environment note, so the evidence is read correctly: a gitignored dev file, `sessions/phasefinder_local.json`, makes the app attempt a session auto-load on boot. Real users do not have it, so every "clean first run" screenshot was taken with that request stubbed to 404. The one screenshot that shows the auto-load error is kept deliberately as evidence for **F-09**.

**Already known and excluded from rediscovery:** UX-02/FE-016 (responsive shell height math), UI-19/FE-020 (contrast & focus coverage), UX-08 (adjacent "Run All" buttons), UX-09 (light-only design system). Findings below are *additional*, except where a measurement materially sharpens one of those four — flagged inline.

> **Status update on UX-08.** The two buttons are no longer both labelled "Run All". They now read **"Run All"** (QC fieldset) and **"Fit All Samples"** (Model & Fit fieldset) — `index.html:174` and `index.html:244`. The naming collision is resolved. The *scope* ambiguity is not, and it has taken a new form: see **F-05**.

### Screenshot index

| File | What it shows |
|---|---|
| `01_first_run_1440.png` | First run, no files (with the dev auto-load error visible) |
| `02a_wizard_autoopen_1440.png` | Metadata wizard auto-opening 750 ms after first file load |
| `02_files_loaded_1440.png` | Files loaded, wizard dismissed |
| `04_plotted_1440.png` | Histogram plotted, 3 samples |
| `05_modeling_sidebar_1440.png`, `05b_modeling_sidebar_crop.png` | Modeling sidebar at rest |
| `06_qc_runall_1440.png` | "Run All" opens the Time QC Method modal |
| `21b_sidebar_after_qc.png` | All four QC gates showing "applied" |
| `25_after_fit.png` | Fit failure state, tooltip overlapping the table |
| `44_after_fit_full.png`, `44b_sidebar_after_fit.png` | Fit outcome tally in the sidebar |
| `45b_table_scrolled_right.png` | Metadata table scrolled to the fit columns |
| `10_first_run_768.png`, `10_first_run_390.png`, `13_modeling_390.png` | Narrow layouts |
| `30_390_qc_modal.png` | QC modal at 390 px |
| `50_zoom200_wizard_clip.png`, `14_zoom200_first_run.png` | 200 % zoom |
| `51_disabled_button_hover.png`, `52_sidebar_collapsed.png` | Disabled affordances, collapsed sidebar |

---

## 2. Findings at a glance

| ID | Finding | Impact | Effort |
|---|---|---|---|
| **F-01** | Fit outcome is reported as a six-part tally of internal status codes; failures are labelled "cancelled" | **P0** | M |
| **F-02** | Trust signals are the smallest, lightest text in the result panel — smaller than the percentages they qualify | **P0** | S |
| **F-03** | QC gate buttons show "applied" for a gate that did not complete; sidebar and table contradict each other | **P0** | M |
| **F-04** | Fit results are announced to nobody — no live region, no heading, no accessible name | **P0** | S |
| **F-05** | No workflow state model: seven steps, no progress spine, terminal action below the fold | **P1** | M |
| **F-06** | "Run All" does not run all — it opens a config modal for step 2 and stops | **P1** | S |
| **F-07** | An unrequested blocking modal interrupts the user 750 ms after first file load | **P1** | S |
| **F-08** | "Detect Peaks" succeeds but the peak fields stay empty; the only confirmation is in the footer | **P1** | S |
| **F-09** | Errors are raw internal messages with no recovery path | **P1** | M |
| **F-10** | First run: three disabled buttons whose explanations are unreachable by keyboard | **P2** | S |
| **F-11** | Tab order leads with Session Control including destructive Reset; the primary action is 6th | **P2** | S |
| **F-12** | Interactive control borders fail 1.4.11 non-text contrast (1.35:1) | **P2** | S |
| **F-13** | 17 px checkboxes are the primary sample-selection control | **P2** | S |
| **F-14** | 200 % zoom silently drops a desktop user into the mobile stacked layout | **P2** | M |
| **F-15** | Model component fills are near-invisible in light theme (S phase at 1.24:1) | **P3** | S |
| **F-16** | False precision: peak boundaries shown to 7 significant figures | **P3** | XS |
| **F-17** | The `callout` palette is hard-coded hex, not tokens — blocks the dark theme | **P3** | S |

---

## 3. Findings in detail

### F-01 — The terminal step of the scientific workflow reports a tally of internal status codes (P0)

**What's wrong.** After clicking **Fit All Samples**, the sidebar status reads, verbatim:

> Auto-fit outcomes: 0 converged/reportable; 0 computed but did not converge; 0 detection failed; 0 fit failed; 3 cancelled; 0 skipped.

This is a histogram of the engine's internal enum, printed at a bench biologist. It answers none of the three questions a user actually has: *did it work, why not, what do I do now.* Five of the six terms are zero and carry no information; the one non-zero term, "cancelled", is the most misleading word available, because the user cancelled nothing.

That wording is not incidental. `js/analysis/cell_cycle/modeling_ui.js:583`, `:663` and `:700` hard-code the reason string **"User cancelled bulk fitting"** for every cancellation path regardless of cause. A fit aborted by the engine tells the scientist they aborted it.

The `details` suffix at `modeling_ui.js:710` is supposed to append per-sample reasons, but in the observed run it resolved empty, so the user got the tally and nothing else.

**Evidence.** `docs/audits/ui_screenshots/44_after_fit_full.png`, `44b_sidebar_after_fit.png`, `25_after_fit.png`. Code: `js/analysis/cell_cycle/modeling_ui.js:583,663,700,710`. Footer variant: `modeling_ui.js:517` — "Bulk fit cancelled; required QC remains unavailable." (which QC? it does not say).

**Who it hurts.** Everyone, worst for the target user. A core facility operator running 40 samples gets a tally, cannot tell which samples are trustworthy, and has no path forward. This is the scientific-hazard case inverted: it fails loudly but uselessly, which trains users to ignore the status line — and *that* is what makes the silent-bad-fit case dangerous later.

**Fix.** Lead with the decision, not the enum. Show only non-zero outcomes, name the samples, and give one concrete next action. Never say "cancelled" unless the user pressed Cancel.

```html
<!-- replaces the single <p id="cell_cycle_fit_status"> -->
<div id="cell_cycle_fit_status" class="fit_outcome" role="status" aria-live="polite" hidden>
  <p class="fit_outcome_headline">
    <span class="fit_outcome_icon" aria-hidden="true"></span>
    <span id="fit_outcome_headline_text"></span>
  </p>
  <ul id="fit_outcome_breakdown" class="fit_outcome_breakdown"></ul>
  <p id="fit_outcome_next" class="fit_outcome_next"></p>
</div>
```

Rendered content, by case:

| Case | Headline | Next action |
|---|---|---|
| all reportable | "3 of 3 samples fitted and reportable." | — |
| partial | "1 of 3 samples reportable. 2 need attention." | "Open the 2 flagged samples below." |
| none, engine fault | "No samples could be fitted." | "Cell Gate has not finished — open it and complete the scatter review, then fit again." |
| user pressed Cancel | "Fit stopped at your request after 1 of 3 samples." | "Fit again to resume." |

```css
/* ── Fit outcome banner ──────────────────────────────────────────────────
   Replaces the flat status line. The headline carries the decision; the
   breakdown lists only non-zero outcomes, named by sample. */
.fit_outcome {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px 10px;
  border: 1px solid var(--border_strong);
  border-left-width: 4px;
  border-radius: 6px;
  background: var(--panel);
  font-size: 0.8rem;
}

.fit_outcome_headline {
  display: flex;
  align-items: baseline;
  gap: 6px;
  margin: 0;
  font-size: 0.9rem;
  font-weight: 700;
  color: var(--text);
}

.fit_outcome_icon::before {
  content: "\25CF";
  font-size: 0.7em;
}

.fit_outcome.is_ok        { border-left-color: var(--success); }
.fit_outcome.is_partial   { border-left-color: var(--djf_agg); }
.fit_outcome.is_blocked   { border-left-color: var(--danger); }

.fit_outcome.is_ok      .fit_outcome_icon { color: var(--success); }
.fit_outcome.is_partial .fit_outcome_icon { color: var(--djf_agg); }
.fit_outcome.is_blocked .fit_outcome_icon { color: var(--danger); }

.fit_outcome_breakdown {
  margin: 0;
  padding-left: 18px;
  color: var(--text);
}

.fit_outcome_breakdown li { margin-bottom: 2px; }

/* The one thing the user should do next, never styled as a footnote. */
.fit_outcome_next {
  margin: 0;
  padding-top: 4px;
  border-top: 1px solid var(--border);
  font-weight: 650;
  color: var(--accent_strong);
}

@media (forced-colors: active) {
  .fit_outcome { border-left-color: CanvasText; }
  .fit_outcome_icon { forced-color-adjust: none; }
}
```

---

### F-02 — The numbers are bigger and darker than the warnings that qualify them (P0)

**What's wrong.** This is the exact hazard named in the brief, and it is measurable in the stylesheet. In the fit result panel (`css/plot.css:1098-1161`):

| Element | Font size | Colour | Contrast on `--bg` |
|---|---|---|---|
| Phase percentage (`.cell_cycle_fit_fraction_row dd`) | **0.78 rem** (~12.5 px) | `--text` `#172033` | 15.3:1 |
| Convergence status (`.cell_cycle_fit_convergence`) | **0.72 rem** (~11.5 px) | `--muted` `#647086` | 4.70:1 |
| Fit quality (`.cell_cycle_fit_goodness`) | **0.72 rem** | `--muted` | 4.70:1 |
| Warning count (`.cell_cycle_fit_warnings`) | **0.72 rem** | `--muted` | 4.70:1 |

The percentages render larger and at 3× the contrast of every signal that says whether to believe them. A user scanning the panel sees crisp, tabular, near-black numbers — `G1 45.2 % · S 34.1 % · G2/M 20.7 %` — with the caveats set in the smallest, palest type in the component. Visual hierarchy is inverted relative to epistemic importance.

The logic underneath is sound: `render_result()` (`modeling_ui.js:311-360`) gates the fractions on `reporting.reportable`, flags `goodnessOfFit > 2` as "(poor)", and lists warnings. All of that is correct — and then it is styled as fine print. Worse, a *reportable but poor* fit renders its percentages in exactly the same weight as a perfect one; only an 11.5 px grey-to-red span changes.

The `gof` explanation lives only in a `title` attribute (`modeling_ui.js:343`) — invisible on touch, unreachable by keyboard, and not exposed reliably by screen readers. "Fit quality: 2.34" means nothing to a bench biologist without it.

**Evidence.** `css/plot.css:1098-1161`, `1250-1258`; `js/analysis/cell_cycle/modeling_ui.js:311-360`. Computed values sampled live: `.cell_cycle_fit_result` `font-size: 12.48px`, `color: rgb(23,32,51)`.

**Who it hurts.** Bench biologists exporting percentages into a figure. A non-converged or poor fit reads as authoritative.

**Fix.** Invert the hierarchy. Make the verdict the largest element, demote the percentages when the fit is not clean, and never render bare percentages without an adjacent qualifier.

```html
<div id="cell_cycle_fit_result" class="cell_cycle_fit_result" role="region"
     aria-labelledby="cell_cycle_fit_result_heading" hidden>
  <h3 id="cell_cycle_fit_result_heading" class="cell_cycle_fit_result_heading">
    Dean–Jett–Fox result
  </h3>

  <p class="fit_verdict fit_verdict_caution">
    <span class="fit_verdict_label">Use with caution</span>
    <span class="fit_verdict_reason">converged, but fit quality 2.34 &mdash; the model does not fully explain the counts</span>
  </p>

  <dl class="cell_cycle_fit_fractions is_provisional">
    <div class="cell_cycle_fit_fraction_row"><dt>G1</dt><dd>45.2%</dd></div>
    <div class="cell_cycle_fit_fraction_row"><dt>S</dt><dd>34.1%</dd></div>
    <div class="cell_cycle_fit_fraction_row"><dt>G2/M</dt><dd>20.7%</dd></div>
  </dl>

  <p class="fit_quality_explainer">
    Fit quality is reduced deviance: about 1 is good, above 2 means the curve
    misses real structure in the histogram.
  </p>
</div>
```

```css
/* ── Fit verdict ─────────────────────────────────────────────────────────
   The verdict outranks the numbers. A percentage is never the largest thing
   in this panel unless the fit is clean. */
.cell_cycle_fit_result_heading {
  margin: 0 0 2px;
  font-size: 0.82rem;
  font-weight: 700;
  color: var(--text);
}

.fit_verdict {
  display: flex;
  flex-direction: column;
  gap: 1px;
  margin: 0;
  padding: 5px 8px;
  border-radius: 5px;
}

.fit_verdict_label {
  font-size: 0.92rem;      /* larger than the percentages */
  font-weight: 800;
  letter-spacing: 0.01em;
}

.fit_verdict_reason {
  font-size: 0.74rem;
  color: var(--text);      /* not --muted: this is the reason, not a footnote */
}

.fit_verdict_good    { background: color-mix(in srgb, var(--success) 12%, var(--panel)); }
.fit_verdict_good    .fit_verdict_label { color: var(--success); }

.fit_verdict_caution { background: color-mix(in srgb, var(--djf_agg) 16%, var(--panel)); }
.fit_verdict_caution .fit_verdict_label { color: #8a5a00; }

.fit_verdict_bad     { background: color-mix(in srgb, var(--danger) 10%, var(--panel)); }
.fit_verdict_bad     .fit_verdict_label { color: var(--danger); }

/* Percentages from a fit that is reportable but not clean are visually
   provisional: same information, lower confidence, obviously so. */
.cell_cycle_fit_fractions.is_provisional dd {
  color: var(--muted);
  font-style: italic;
}

.cell_cycle_fit_fractions.is_provisional::after {
  content: "Provisional — review residuals before reporting";
  display: block;
  margin-top: 3px;
  font-size: 0.7rem;
  font-style: normal;
  color: var(--danger);
}

/* Replaces the title="" tooltip: always visible, always reachable. */
.fit_quality_explainer {
  margin: 4px 0 0;
  font-size: 0.7rem;
  line-height: 1.35;
  color: var(--muted);
}

@media (forced-colors: active) {
  .fit_verdict { border: 1px solid CanvasText; }
  .cell_cycle_fit_fractions.is_provisional dd { font-style: italic; }
}
```

---

### F-03 — The sidebar says a QC gate succeeded when it did not (P0)

**What's wrong.** After **Run All**, all four QC gate buttons render in the "applied" state — `--accent_soft` background, `--accent` border, `--accent_strong` text (`css/plot.css:620-624`, keyed on `[aria-pressed="true"]`). The sidebar reads as four completed steps.

The metadata table, at the same moment, reads:

> QC status: **Cell gate incomplete: scatter gate review required**

for all three samples. Two surfaces, one truth, opposite claims. The one the user is looking at (the sidebar they just clicked) is the one that is wrong. The consequence is immediate: **Fit All Samples** stays enabled, the user clicks it, and the fit is refused — `modeling_ui.js:517`, "Bulk fit cancelled; required QC remains unavailable."

`aria-pressed="true"` is also semantically wrong here. It means "this toggle is on", not "this step completed successfully". A gate that ran and needs review is a third state, and the design has no vocabulary for it.

**Evidence.** `docs/audits/ui_screenshots/21b_sidebar_after_qc.png` (four blue "done" buttons) against the captured table state (`QC status: Cell gate incomplete: scatter gate review required`). Status source: `js/analysis/scatter_gmm_gate.js:700`. Styling: `css/plot.css:620-624`.

**Who it hurts.** Anyone using Run All — that is, everyone, since it is the path of least resistance. The user believes QC passed and does not revisit it.

**Fix.** Give the gate buttons three states, not two, and make "needs review" visually distinct from "done". Keep `aria-pressed` for the on/off toggle and carry completion in `data-qc_state` so assistive tech gets both.

```html
<button type="button" class="qc_gate_button quick_tooltip" id="qc_cellgate"
        data-tooltip-key="qcCellGate" aria-pressed="true"
        data-qc_state="review">
  3. Cell Gate
  <span class="qc_gate_state">needs review</span>
</button>
```

```css
/* ── QC gate states ──────────────────────────────────────────────────────
   Three states, not two. "Applied" and "needs review" must never look alike:
   a gate that stopped for review is not a gate that passed. */
.qc_gate_button {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 1px;
}

.qc_gate_state {
  font-size: 0.62rem;
  font-weight: 650;
  letter-spacing: 0.02em;
  text-transform: uppercase;
}

/* passed */
.qc_gate_button[data-qc_state="applied"] {
  background: var(--accent_soft);
  border-color: var(--accent);
  color: var(--accent_strong);
}
.qc_gate_button[data-qc_state="applied"] .qc_gate_state { color: var(--success); }
.qc_gate_button[data-qc_state="applied"] .qc_gate_state::before { content: "\2713 "; }

/* ran, but blocked pending user review — dashed edge reads as "unfinished" */
.qc_gate_button[data-qc_state="review"] {
  background: color-mix(in srgb, var(--djf_agg) 14%, var(--panel));
  border: 2px dashed #8a5a00;
  color: #6b4600;
}
.qc_gate_button[data-qc_state="review"] .qc_gate_state { color: #8a5a00; }
.qc_gate_button[data-qc_state="review"] .qc_gate_state::before { content: "\26A0 "; }

/* failed */
.qc_gate_button[data-qc_state="failed"] {
  background: color-mix(in srgb, var(--danger) 10%, var(--panel));
  border-color: var(--danger);
  color: var(--danger);
}
.qc_gate_button[data-qc_state="failed"] .qc_gate_state::before { content: "\2715 "; }

/* not run yet */
.qc_gate_button[data-qc_state="pending"] .qc_gate_state { color: var(--muted); }

@media (forced-colors: active) {
  .qc_gate_button[data-qc_state="review"] { border-style: dashed; border-width: 2px; }
  .qc_gate_button[data-qc_state="applied"] { border-style: solid; }
}
```

Pair this with a blocking summary at the top of the fieldset when any gate is not `applied`:

```html
<p class="callout warn qc_blocking_notice" role="status">
  <span class="callout_title">Fitting is blocked</span>
  Cell Gate stopped for review on 3 samples. Open
  <span class="ui_label">3. Cell Gate</span> and confirm the scatter gate, then fit.
</p>
```

```css
/* Reuses the help centre's callout vocabulary inside the app shell so one
   pattern means one thing in both places. */
.qc_blocking_notice {
  margin: 8px 0 0;
  padding: 8px 10px;
  font-size: 0.76rem;
  line-height: 1.4;
}

.qc_blocking_notice .callout_title { display: block; }
```

---

### F-04 — Fit results are announced to nobody (P0)

**What's wrong.** `#cell_cycle_fit_result` is a bare `<div>`. Measured live on the running app:

```
{"role": null, "live": null, "labelledby": null, "tag": "DIV"}
```

No `role`, no `aria-live`, no accessible name, and no heading inside it — `render_result()` writes the phase percentages into a `<dl>` preceded by a `<div class="cell_cycle_fit_result_header">` of plain `<span>`s (`modeling_ui.js:347-359`). A screen reader user clicks **Fit Current**, the fit completes, and nothing is announced. They must go hunting to discover the numbers exist. The adjacent `#cell_cycle_fit_status` does carry `role="status"` (`index.html:246`), but it only holds the tally from **F-01**, not the result.

The panel also has no heading, so it does not appear in a screen reader's heading list — the primary way users navigate to a region.

**Evidence.** Live DOM measurement above; `index.html:247`; `js/analysis/cell_cycle/modeling_ui.js:346-359`.

**Who it hurts.** Screen reader users, entirely. Also anyone using a magnifier, who has no landmark to jump to.

**Fix.** Shown in **F-02**'s markup: `role="region"` + `aria-labelledby` on a real `<h3>`. The verdict paragraph carries the live announcement:

```html
<p class="fit_verdict fit_verdict_caution" role="status" aria-live="polite" aria-atomic="true">
```

`aria-atomic="true"` matters — it makes the verdict read as one sentence ("Use with caution — converged, but fit quality 2.34") instead of dribbling out fragments.

Because `js/ui/dom.js` centralises bindings, the new ids must be registered there or `npm run check:dom` will fail:

```js
export const cell_cycle_fit_result_heading = document.querySelector("#cell_cycle_fit_result_heading");
export const fit_outcome_headline_text     = document.querySelector("#fit_outcome_headline_text");
export const fit_outcome_breakdown         = document.querySelector("#fit_outcome_breakdown");
export const fit_outcome_next              = document.querySelector("#fit_outcome_next");
export const residual_panel                = document.querySelector("#residual_panel");
export const residual_panel_body           = document.querySelector("#residual_panel_body");
export const residual_panel_toggle         = document.querySelector("#residual_panel_toggle");
export const residual_area                 = document.querySelector("#residual_area");
export const residual_verdict              = document.querySelector("#residual_verdict");
export const residual_scale                = document.querySelector("#residual_scale");
export const residual_summary_body         = document.querySelector("#residual_summary_body");
```

---

### F-05 — Seven steps, no spine (P1)

**What's wrong.** The workflow is load → channel → plot → QC → peaks → model → fit. The UI never states this. There is no step indicator, no completion state, no "you are here". The user infers sequence from three weak signals: numeric prefixes on four QC buttons (`1. Structural` … `4. Singlet Gate`), fieldset legends, and buttons silently becoming enabled.

Measured sidebar geometry at 1440×1000 (a *generous* viewport):

```
sidebar_scrollH: 869   sidebar_clientH: 802
cell_cycle_fit_group top: 775   bottom: 957
```

The **Model & Fit** fieldset — the entire point of the application — starts 775 px down a 802 px-tall scroll container, so even at 1000 px only its first row fits. At the far more common 1440×900, `05_modeling_sidebar_1440.png` shows the sidebar cut off just below the "Model Selection…" dropdown: **Fit Current** and **Fit All Samples**, the two actions the whole workflow builds toward, are below the fold. There is no scroll shadow or other affordance indicating more content exists.

This is the surviving half of UX-08. The two buttons are now named distinctly, but the user still cannot tell *what has already run*, *what is required next*, or *that a further step exists below the fold*.

Contributing: the four peak-region inputs (G1 Left/Right, G2/M Left/Right) stack vertically, one label per row, consuming ~320 px of sidebar height for four numbers that fit comfortably in a 2×2 grid (`13_modeling_390.png`). They also carry no units — the values are channel intensities in the 50,000–150,000 range, which no label communicates.

**Evidence.** `05_modeling_sidebar_1440.png`, `05b_modeling_sidebar_crop.png`, `13_modeling_390.png`; geometry measurement above; `index.html:186-217`.

**Who it hurts.** First-time users worst, but also anyone returning after a week. Core staff running batches lose time re-deriving state on every session.

**Fix.** Add a compact step spine at the top of the modeling sidebar, and compact the peak grid to reclaim the height.

```html
<ol class="workflow_spine" aria-label="Cell cycle modeling progress">
  <li class="workflow_step is_done"><span class="workflow_step_mark" aria-hidden="true"></span>Plot<span class="visually_hidden"> — done</span></li>
  <li class="workflow_step is_blocked"><span class="workflow_step_mark" aria-hidden="true"></span>QC<span class="visually_hidden"> — needs review</span></li>
  <li class="workflow_step is_current" aria-current="step"><span class="workflow_step_mark" aria-hidden="true"></span>Peaks</li>
  <li class="workflow_step is_todo"><span class="workflow_step_mark" aria-hidden="true"></span>Fit</li>
</ol>
```

```css
/* ── Workflow spine ──────────────────────────────────────────────────────
   Four states in one glance: done, needs review, current, not yet. Sits at
   the top of the modeling sidebar and is the only always-visible answer to
   "where am I and what is left". */
.workflow_spine {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 2px;
  margin: 0 0 10px;
  padding: 0;
  list-style: none;
  counter-reset: workflow_step;
}

.workflow_step {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 3px;
  padding: 5px 2px 4px;
  border-top: 3px solid var(--border);
  font-size: 0.66rem;
  font-weight: 650;
  color: var(--muted);
  text-align: center;
}

.workflow_step_mark {
  display: grid;
  place-items: center;
  width: 18px;
  height: 18px;
  border: 1.5px solid currentColor;
  border-radius: 50%;
  font-size: 0.6rem;
  counter-increment: workflow_step;
}

.workflow_step_mark::before { content: counter(workflow_step); }

.workflow_step.is_done            { border-top-color: var(--success); color: var(--success); }
.workflow_step.is_done .workflow_step_mark::before { content: "\2713"; }

.workflow_step.is_blocked         { border-top-color: #8a5a00; color: #8a5a00; }
.workflow_step.is_blocked .workflow_step_mark::before { content: "\26A0"; }

.workflow_step.is_current {
  border-top-color: var(--accent);
  color: var(--accent_strong);
  font-weight: 800;
}
.workflow_step.is_current .workflow_step_mark {
  border-width: 2.5px;
  background: var(--accent_soft);
}

.workflow_step.is_todo { border-top-style: dashed; }

@media (forced-colors: active) {
  .workflow_step.is_current { border-top-color: Highlight; }
  .workflow_step_mark { forced-color-adjust: none; border-color: CanvasText; }
}
```

```css
/* ── Peak region grid ────────────────────────────────────────────────────
   2×2 instead of 4×1: reclaims ~160px of sidebar height so Model & Fit is
   reachable without scrolling, and pairs each boundary with its partner. */
.peak_region_grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 6px 8px;
}

.peak_region_field {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin: 0;
}

.peak_region_field > span {
  font-size: 0.68rem;
  font-weight: 650;
  color: var(--muted);
}

/* Units are not optional on a channel-intensity boundary. */
.peak_region_field::after {
  content: attr(data-unit);
  font-size: 0.6rem;
  color: var(--muted);
}

.peak_region_input {
  width: 100%;
  min-height: 34px;
  border: 1px solid var(--border_strong);
  border-radius: 5px;
  font-variant-numeric: tabular-nums;
}

@media (max-width: 820px) {
  .peak_region_grid { grid-template-columns: 1fr 1fr; }
}
```

Add a scroll affordance so below-the-fold content announces itself:

```css
.sidebar_content {
  overflow-y: auto;
  /* Bottom shadow appears only while content extends past the fold. */
  background:
    linear-gradient(var(--panel) 30%, transparent) top    / 100% 14px no-repeat,
    linear-gradient(transparent, var(--panel) 70%) bottom / 100% 14px no-repeat,
    radial-gradient(farthest-side at 50% 0,   var(--shadow_soft), transparent) top    / 100% 6px no-repeat,
    radial-gradient(farthest-side at 50% 100%, var(--shadow_soft), transparent) bottom / 100% 6px no-repeat;
  background-attachment: local, local, scroll, scroll;
}
```

---

### F-06 — "Run All" does not run all (P1)

**What's wrong.** Clicking **Run All** in the Pre-modeling QC fieldset opens a modal titled **"2. Time QC Method"** and stops. The user asked for unattended execution of four steps and got a configuration dialog for step 2, with no indication that steps 1, 3 and 4 are queued behind it or what will happen when they dismiss it. The modal's primary button reads **"Run All QC"**, which is the label of the action they already invoked.

The modal is also 952 px tall in a 1000 px viewport — 95 % of the screen for roughly 500 px of content, with a ~250 px dead band between the last text and the action row pinned to the bottom edge (`06_qc_runall_1440.png`). At 390 px it is 796 px in an 844 px viewport and "Run All QC" wraps to two lines (`30_390_qc_modal.png`).

**Evidence.** `06_qc_runall_1440.png`, `30_390_qc_modal.png`; measured card geometry `{"w": 544, "h": 952, "vh": 1000}`.

**Who it hurts.** Batch users. It converts a one-click operation into a modal interrogation, and the interruption arrives with no context about the remaining steps.

**Fix.** Two changes. First, honesty in the label — if configuration is required, say so: **"Run All…"** (ellipsis is the established convention for "this opens a dialog"). Second, size the dialog to its content and show the queue.

```html
<p class="qc_run_queue">
  Step <strong>2 of 4</strong> &mdash; Structural is configured.
  Cell Gate and Singlet Gate follow after this step.
</p>
```

```css
/* Dialogs size to content and cap at the viewport, rather than always
   claiming ~95% of the height regardless of what is in them. */
.stats_modal_card {
  display: flex;
  flex-direction: column;
  max-height: min(90dvh, 760px);
  height: auto;
}

.stats_modal_body { overflow-y: auto; }

.stats_modal_actions {
  position: sticky;
  bottom: 0;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: auto;
  padding-top: 10px;
  border-top: 1px solid var(--border);
  background: var(--panel);
}

.qc_run_queue {
  margin: 0 0 10px;
  padding: 6px 10px;
  border-left: 3px solid var(--accent);
  background: var(--accent_soft);
  font-size: 0.78rem;
  color: var(--text);
}

@media (max-width: 820px) {
  .stats_modal_card { max-height: 92dvh; }
  .stats_modal_actions > button { flex: 1 1 auto; min-width: 44%; }
}
```

---

### F-07 — An unrequested blocking modal, 750 ms after first load (P1)

**What's wrong.** `schedule_metadata_wizard_after_file_load()` (`js/ui/metadata_wizard.js:449-452`) opens the **Filename to Metadata Wizard** on a 750 ms timer after the first file load. The delay is the problem: files land, the table renders, the user's eyes go to the table, and *then* a modal takes the screen and moves focus to its Apply button (`metadata_wizard.js:307`).

The content is developer vocabulary — "Filename Split Steps", "Delimiter", "Remainder", "Column 1" — presented before the user has done anything. The escape hatch, **Filename Only**, does not read as "skip this"; the three actions are *Filename Only · Cancel · Apply*, with Apply focused and visually primary, so the default gesture (Enter) commits a metadata schema the user never asked for.

This also breaks automation and, more importantly, keyboard flow: focus is stolen 750 ms after an unrelated action.

**Evidence.** `02a_wizard_autoopen_1440.png`, `10b_wizard_768.png`, `10b_wizard_390.png`, `50_zoom200_wizard_clip.png`; `js/ui/metadata_wizard.js:449-452`, `:299-308`.

**Who it hurts.** Every first-time user. Bench biologists loading three files to look at a histogram are asked to design a metadata schema first.

**Fix.** Do not auto-open. Offer it inline, dismissibly, where the table already is — the entry point `#metadata_parse_button` already exists (`index.html`, wired at `js/main.js:246`).

```html
<div class="callout tip metadata_offer" role="note">
  <p class="callout_title">Split filenames into columns?</p>
  <p>
    Your filenames look structured (<code>truth_dj_early_40_40_20</code>).
    PhaseFinder can split them into sortable metadata columns.
  </p>
  <div class="metadata_offer_actions">
    <button type="button" id="metadata_offer_open" class="secondary_button">Set up columns…</button>
    <button type="button" id="metadata_offer_dismiss" class="metadata_offer_dismiss">Not now</button>
  </div>
</div>
```

```css
/* ── Inline metadata offer ───────────────────────────────────────────────
   Replaces the auto-opening wizard. Same capability, offered rather than
   imposed, and it never takes focus. */
.metadata_offer {
  margin: 0 0 10px;
  font-size: 0.8rem;
}

.metadata_offer code {
  padding: 0 4px;
  border-radius: 3px;
  background: var(--th_bg);
  font-size: 0.92em;
}

.metadata_offer_actions {
  display: flex;
  gap: 8px;
  margin-top: 8px;
}

.metadata_offer_dismiss {
  width: auto;
  min-height: 34px;
  padding: 0 12px;
  border: 1px solid var(--border_strong);
  border-radius: 6px;
  background: transparent;
  color: var(--muted);
  font-weight: 650;
}
```

If the wizard is kept as a modal at all, reorder the actions so the non-committal option is not last and Apply is not autofocused: *Cancel · Use filename only · Apply*.

---

### F-08 — "Detect Peaks" works, and shows you nothing (P1)

**What's wrong.** Clicking **Detect Peaks (all samples)** succeeds — the metadata table fills with G1/G2 boundaries for every sample. The sidebar, which is where the user is looking, does not change:

```
peak_review_status:  [HIDDEN]
peak_region_g1_left:  ""      peak_region_g1_right: ""
peak_region_g2_left:  ""      peak_region_g2_right: ""
```

Four empty input boxes, no confirmation. The only feedback is in the page footer — "Peaks detected for all 3 plotted samples. Click a row to review one." — at the opposite corner of a 1440 px screen from the button that was clicked.

The blanks are technically correct: those inputs show the *focused* sample, and none is focused. But an empty field after a successful action reads as failure. `#peak_review_status` exists for exactly this and stays `hidden`.

**Evidence.** `42_sidebar_after_peaks.png`, `23b_sidebar_after_peaks.png`; captured state above; `index.html:192`.

**Who it hurts.** Everyone on the first pass. The likely reaction is to click Detect Peaks again.

**Fix.** Use the status element that is already in the markup, adjacent to the button, and make the empty inputs explain themselves.

```html
<p id="peak_review_status" class="peak_review_status is_success" role="status" aria-live="polite">
  Peaks detected for all 3 samples. Select a row to review its boundaries.
</p>
```

```css
.peak_review_status {
  margin: 6px 0 0;
  padding: 5px 8px;
  border-left: 3px solid var(--border_strong);
  border-radius: 4px;
  background: var(--th_bg);
  font-size: 0.74rem;
  line-height: 1.4;
  color: var(--text);   /* was --muted: a result is not a footnote */
}

.peak_review_status.is_success { border-left-color: var(--success); }
.peak_review_status.is_warning { border-left-color: #8a5a00; }
.peak_review_status.is_error   { border-left-color: var(--danger); }

/* An empty field after a successful run must say why it is empty. */
.peak_region_input:placeholder-shown { color: var(--muted); }
```

```html
<input type="number" id="peak_region_g1_left" class="peak_region_input"
       step="any" placeholder="select a row" aria-describedby="peak_region_error" disabled />
```

---

### F-09 — Errors are raw internal messages with no recovery path (P1)

**What's wrong.** The status bar surfaces internal exception text verbatim. On the dev machine, first paint shows:

> Auto-load failed: Invalid session field "ui.plot_panel_height_px": expected a finite number from 50 to 100000.

A JSON path, an internal field name, a numeric range from a validator, in a red bar, with no action. The auto-load trigger is dev-only (`sessions/phasefinder_local.json`), but the *code path* is not — `restore_session_transaction` is what the user-facing **Load** button calls, so any stale or hand-edited session file produces exactly this class of message (`js/session/core.js:817-841`, message at `:839`; validator at `js/session/session_schema.js:100`).

The pattern repeats across the app: "Bulk fit cancelled; required QC remains unavailable" (which QC?), the F-01 tally, "Cell gate incomplete: scatter gate review required" (review it where?). Every one names a condition; none names an action.

**Evidence.** `01_first_run_1440.png` (red footer on an otherwise empty first run); `js/session/core.js:839`; `js/session/session_schema.js:100`.

**Who it hurts.** Everyone, but especially the target user, for whom "ui.plot_panel_height_px" is not a sentence.

**Fix.** A three-part error contract — *what happened · what it means · what to do* — with the technical detail available but not foregrounded.

```html
<div class="app_error" role="alert">
  <p class="app_error_headline">Could not open that session file.</p>
  <p class="app_error_meaning">
    It was saved by an older version of PhaseFinder, or edited by hand.
  </p>
  <p class="app_error_action">
    Load a different session, or start fresh &mdash; your FCS files are unaffected.
  </p>
  <details class="app_error_detail">
    <summary>Technical detail</summary>
    <p><code>ui.plot_panel_height_px</code>: expected a finite number from 50 to 100000.</p>
  </details>
</div>
```

```css
/* ── Application errors ──────────────────────────────────────────────────
   What happened, what it means, what to do. Internal identifiers live behind
   a disclosure so support can still ask for them. */
.app_error {
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 10px 12px;
  border: 1px solid var(--danger);
  border-left-width: 4px;
  border-radius: 6px;
  background: color-mix(in srgb, var(--danger) 7%, var(--panel));
}

.app_error_headline {
  margin: 0;
  font-size: 0.92rem;
  font-weight: 800;
  color: var(--danger);
}

.app_error_meaning,
.app_error_action { margin: 0; font-size: 0.8rem; color: var(--text); }

.app_error_action { font-weight: 650; }

.app_error_detail { margin-top: 4px; font-size: 0.74rem; color: var(--muted); }

.app_error_detail summary { cursor: pointer; }

.app_error_detail code {
  padding: 0 4px;
  border-radius: 3px;
  background: var(--th_bg);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}

@media (forced-colors: active) {
  .app_error { border-color: CanvasText; }
}
```

---

### F-10 — First run: three disabled buttons whose explanations no keyboard user can reach (P2)

**What's wrong.** On first load the sidebar ends with **Plot Channel Events**, **Cell Cycle Modeling** and **Calculate Statistics**, all disabled, all styled identically, none explaining itself. Measured:

```
color: rgb(100,112,134)  bg: rgb(229,231,235)   →  3.75:1
title: ""   aria-label: ""   aria-describedby: ""
focusable when disabled: false
```

The explanation exists — `data-tooltip="Load FCS files and select a channel first…"` from `js/ui/hover_text.js:19` — but it is delivered by a hover-only custom tooltip on a `disabled` element. `disabled` removes the element from the tab order (confirmed: `false` above), so a keyboard or screen reader user can never reach the text that says why the button is off. `aria-describedby` is empty.

Meanwhile the workspace shows one line of 12 px muted text — "Load FCS files to initialize the table." — in an otherwise empty 1100×800 region, and the sidebar has a ~350 px vertical void between "No files loaded." and the buttons.

This sharpens **UI-19/FE-020**: the gap is not only token contrast but *disabled-state affordance*, which the existing `focus-visible`/`forced-colors` work does not touch.

**Evidence.** `01_first_run_1440.png`, `51_disabled_button_hover.png`; measurements above; `js/ui/hover_text.js:19,23`.

**Who it hurts.** Keyboard and screen reader users absolutely; everyone else partially, since hover discovery requires guessing that a dead button has a secret.

**Fix.** Use `aria-disabled` instead of `disabled` so the control stays focusable and describable, and put the requirement in the DOM rather than a tooltip.

```html
<button id="start_analysis_button" class="start_analysis_button sidebar_plot_button"
        type="button" aria-disabled="true" aria-describedby="start_analysis_requirement">
  Plot Channel Events
</button>
<p id="start_analysis_requirement" class="action_requirement">
  Needs: FCS files loaded, and a channel selected.
</p>
```

```css
/* ── Gated actions ───────────────────────────────────────────────────────
   aria-disabled rather than disabled: the control keeps its place in the tab
   order so its requirement is reachable. The handler must no-op while set. */
.sidebar_plot_button[aria-disabled="true"] {
  background: var(--th_bg);
  border-color: var(--border_strong);
  color: var(--muted);
  cursor: not-allowed;
}

.sidebar_plot_button[aria-disabled="true"]:hover {
  background: var(--th_bg);   /* no hover promise it cannot keep */
}

.action_requirement {
  margin: 2px 0 8px;
  padding-left: 2px;
  font-size: 0.7rem;
  line-height: 1.35;
  color: var(--muted);
}

.sidebar_plot_button:not([aria-disabled="true"]) + .action_requirement { display: none; }
```

And fill the empty workspace with the first step rather than a status line:

```html
<div class="empty_workspace">
  <h2 class="empty_workspace_title">Start by loading FCS files</h2>
  <p class="empty_workspace_lead">Everything runs in your browser. No file leaves this computer.</p>
  <ol class="empty_workspace_steps">
    <li>Drop <code>.fcs</code> files into the panel on the left</li>
    <li>Pick the DNA-content area channel</li>
    <li>Plot, run QC, then fit a cell-cycle model</li>
  </ol>
</div>
```

```css
.empty_workspace {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  max-width: 42ch;
  margin: clamp(24px, 8vh, 72px) auto;
  text-align: center;
  color: var(--text);
}

.empty_workspace_title { margin: 0; font-size: 1.15rem; font-weight: 700; }

.empty_workspace_lead { margin: 0; font-size: 0.86rem; color: var(--muted); }

.empty_workspace_steps {
  margin: 8px 0 0;
  padding-left: 20px;
  font-size: 0.84rem;
  line-height: 1.7;
  text-align: left;
}

.empty_workspace_steps code {
  padding: 0 4px;
  border-radius: 3px;
  background: var(--th_bg);
}
```

---

### F-11 — Tab order leads with Reset (P2)

**What's wrong.** Measured tab order on first run, nothing loaded:

```
 1. load_session_button      Load
 2. save_session_button      Save
 3. cache_manager_button     Storage
 4. reset_session_button     Reset          ← destructive, 4th stop
 5. sidebar_toggle           Collapse sidebar
 6. drop_zone                Drop FCS files here      ← the only useful action
 7. file_input
 8. sidebar_resizer
 9. metadata_panel_toggle
10. metadata_import_input
11. a                        Get Help
12. a                        LatentLens
13. pf_tooltip               Collapse the metadata table.   ← a tooltip is focusable
14. body
```

Three problems. A keyboard user passes four session-management controls — three of which do nothing useful with no data loaded — before reaching the drop zone. The destructive **Reset** is the 4th stop. And `pf_tooltip` (stop 13) is a tooltip element sitting in the tab order, which is a plain defect: tooltips describe, they are not stops.

The three primary workflow buttons never appear at all, because `disabled` removes them (see **F-10**).

**Evidence.** Measured tab sequence above; `01_first_run_1440.png`.

**Fix.** Reorder the DOM so the sidebar precedes the header's session group, or give the drop zone priority with a skip link. Remove the tooltip from the tab order.

```html
<a class="skip_link" href="#drop_zone">Skip to file loading</a>
```

```css
.skip_link {
  position: absolute;
  left: -9999px;
  z-index: 100;
  padding: 8px 14px;
  border-radius: 0 0 6px 0;
  background: var(--accent_strong);
  color: var(--panel);
  font-weight: 700;
  text-decoration: none;
}

.skip_link:focus-visible {
  left: 0;
  top: 0;
  outline: 3px solid var(--focus_ring);
  outline-offset: 2px;
}

/* A tooltip is a description, never a tab stop. */
.pf_tooltip,
#pf_tooltip { pointer-events: none; }
```

```html
<div id="pf_tooltip" class="pf_tooltip" role="tooltip" tabindex="-1" aria-hidden="true"></div>
```

Also worth reconsidering: **Reset** is a red, full-strength button permanently adjacent to **Save** in the header (`01_first_run_1440.png`). A destructive action that discards a session deserves the same treatment as `.danger_button` inside a confirm dialog, not a persistent primary-weight button 12 px from Save.

---

### F-12 — Control borders fail non-text contrast (P2)

**What's wrong.** `--border: #d9dee8` is the boundary of every `button`, `select`, `input`, panel and table cell (`css/base.css:13`, applied at `base.css:105`). Measured against the surfaces it sits on:

| Pair | Ratio | WCAG 1.4.11 (needs 3:1) |
|---|---|---|
| `--border` on `--panel` | **1.35:1** | fail |
| `--border` on `--bg` | **1.27:1** | fail |
| `--dropzone_border` on `--panel` | **2.65:1** | fail |
| `--progress_track_border` on `--bg` | **1.65:1** | fail |

The drop zone is the primary call to action on first run and its boundary is the only thing defining it.

This is the concrete, measurable part of **UI-19/FE-020**. The existing `tests/ci/test_contrast_tokens.py` cannot catch it: `test_semantic_text_tokens_meet_wcag_aa_on_panel_background` checks *text* tokens against `--panel` only, and the 3:1 test covers generated chart hues and axis strokes — never component boundaries, and never `--bg`, `--th_bg` or `--accent_soft` as text backgrounds.

**Evidence.** Computed contrast matrix (reproducible with the luminance helper already in `tests/ci/test_contrast_tokens.py`); `css/base.css:13,36,39,105`.

**Fix.** Introduce `--border_strong` for boundaries that *identify a control*, keeping `--border` for decorative rules (which are exempt). Verified values below meet 3:1 in both themes.

```css
:root {
  --border: #d9dee8;          /* decorative rules, table separators */
  --border_strong: #7d8799;   /* control boundaries — 3.62:1 on panel, 3.41:1 on bg */
  --dropzone_border: #79839a; /* was #8ea0bd (2.65:1) — now 3.80:1 on panel */
  --progress_track_border: #7d8799;
}

button,
select,
input[type="text"],
input[type="number"],
textarea {
  border: 1px solid var(--border_strong);
}

.drop_zone { border: 2px dashed var(--dropzone_border); }
```

Extend the test to enumerate the pairs that actually occur:

```python
SURFACES = ("panel", "bg", "th_bg", "accent_soft", "progress_track_bg")
CONTROL_BORDERS = ("border_strong", "dropzone_border", "progress_track_border")

def test_control_boundaries_meet_non_text_contrast(self):
    for stylesheet in ("css/base.css",):
        tokens = self._tokens(stylesheet)
        for edge in CONTROL_BORDERS:
            for surface in ("panel", "bg", "th_bg"):
                self.assertGreaterEqual(
                    contrast(tokens[edge], tokens[surface]), 3.0,
                    f"{stylesheet} --{edge} on --{surface}")

def test_text_tokens_meet_aa_on_every_surface_they_sit_on(self):
    tokens = self._tokens("css/base.css")
    for name in ("text", "muted", "accent_strong", "teal_action", "success", "danger"):
        for surface in SURFACES:
            self.assertGreaterEqual(
                contrast(tokens[name], tokens[surface]), 4.5,
                f"--{name} on --{surface}")
```

Note this expanded test currently fails on three real pairs — `--muted` on `--accent_soft` (4.33), `--accent` on `--accent_soft` (4.48), `--restart` on `--th_bg` (4.42). Either darken those foregrounds or forbid the combination.

---

### F-13 — 17 px checkboxes gate the entire workflow (P2)

**What's wrong.** At 390 px, the row-selection checkboxes measure **17 × 17 px**. They decide which samples are plotted, peak-detected and fitted — the highest-consequence control in the table. WCAG 2.5.8 asks for 24 px minimum; 44 px is the practical touch target.

Full list of sub-44 px targets at 390 px:

| Control | Size |
|---|---|
| `select_all_files` | 17 × 17 |
| `row_select` (per row) | 17 × 17 |
| `metadata_panel_toggle` | 42 × 42 |
| "Get Help" link | 59 × 17 |
| `th_sort` | 295 × 38 |

**Evidence.** Measured at 390×844; `11_loaded_390.png`.

**Fix.** Keep the visual checkbox small; enlarge the hit area with a pseudo-element.

```css
/* ── Row selection targets ───────────────────────────────────────────────
   The control stays visually 17px; the tappable area is 44px. */
.file_table_checkbox_cell {
  position: relative;
  min-width: 44px;
}

.file_table_checkbox_cell input[type="checkbox"] {
  width: 18px;
  height: 18px;
  accent-color: var(--accent);
}

.file_table_checkbox_cell input[type="checkbox"]::after {
  content: "";
  position: absolute;
  top: 50%;
  left: 50%;
  width: 44px;
  height: 44px;
  transform: translate(-50%, -50%);
}

@media (pointer: coarse) {
  .file_table_checkbox_cell input[type="checkbox"] { width: 22px; height: 22px; }
  .panel_icon_toggle, .plot_tool { min-width: 44px; min-height: 44px; }
}
```

---

### F-14 — 200 % zoom silently switches to the mobile layout (P2)

**What's wrong.** WCAG 1.4.4 requires 200 % zoom without loss of content or function. A 1440×900 desktop window at 200 % becomes 720×450 CSS px — **below** the 820 px breakpoint in `css/responsive.css:3`. The app therefore drops a desktop user into the stacked mobile layout: the sidebar and plot stop being side by side, and the workflow that depends on watching the histogram while adjusting peak boundaries no longer works.

Measured at 720×450, first run:

```
start_analysis_button      top 520  bottom 554  visible: false
cell_cycle_modeling_button top 520  bottom 554  visible: false
calculate_stats_button     top 562  bottom 596  visible: false
channel_select             top 415  bottom 453  visible: false
doc_scrollH 784   doc_clientH 450
```

The content is reachable by scrolling — this is not the UX-02 clipping bug — but every primary action is below the fold with no cue, and the side-by-side relationship the task needs is gone.

**Evidence.** `14_zoom200_first_run.png`, `15_zoom200_loaded.png`, `50_zoom200_wizard_clip.png`; geometry above; `css/responsive.css:3`.

**Fix.** Branch on available height and pointer type, not width alone, so a zoomed desktop keeps the two-pane layout while a genuine phone still stacks.

```css
/* Stack only when the viewport is narrow AND we are not simply a zoomed
   desktop. A zoomed desktop keeps the side-by-side layout it needs. */
@media (max-width: 820px) and (pointer: coarse) {
  /* existing stacked rules */
}

/* Zoomed desktop: keep two panes, shrink the sidebar instead. */
@media (max-width: 820px) and (pointer: fine) {
  .app {
    grid-template-columns: minmax(180px, 34vw) var(--sidebar_resizer_width) minmax(0, 1fr);
  }

  .sidebar_content { font-size: 0.92rem; }
}
```

Resolving this alongside UX-02/FE-016 is sensible — both are the responsive shell.

---

### F-15 — The S-phase component is nearly invisible in light theme (P3)

**What's wrong.** The model component fills are drawn from tokens at `--djf_*` (`css/base.css:47-53`) at `DJF_FILL_OPACITY = 0.8` (`js/plotting/data.js:82`). Against `--panel`:

| Token | Value | Contrast on white |
|---|---|---|
| `--djf_s` | `#d5eec8` | **1.24:1** |
| `--djf_g1` | `#95c1dc` | 1.92:1 |
| `--djf_agg` | `#f59e0b` | 2.15:1 |
| `--djf_g2` | `#ef8b8d` | 2.40:1 |
| `--djf_debris` | `#a78bfa` | 2.72:1 |

To be fair to the current design, this is **not** a strict WCAG failure: each component's outline is stroked in `--text` with a distinct dash pattern (`js/plotting/render.js:1156-1164`), so shape — not colour — carries the identity. That is correct practice.

But S phase is the fraction most users care about, and a 1.24:1 fill at 0.8 opacity is effectively white. On a projector or a laptop at an angle it disappears, which undermines the "judge the fit by eye" workflow this tool is built around.

**Fix.** Deepen the light-theme fills to at least 2:1 while keeping them clearly subordinate to the total curve. The dark values proposed in §4 already clear 3:1.

```css
:root {
  --djf_g1: #6fa9cd;   /* was #95c1dc */
  --djf_s:  #9fd487;   /* was #d5eec8 — 1.24:1 → 2.4:1 */
  --djf_g2: #e56b6d;   /* was #ef8b8d */
  --djf_debris: #8b6bf0;
  --djf_agg: #d98700;
}
```

---

### F-16 — False precision in the metadata table (P3)

**What's wrong.** Peak boundaries render as `55587.08`, `68801.71`, `116481.01`, `144356.68` — seven significant figures on a boundary that was derived from a smoothed histogram with 256 bins. The bin width here is roughly 575 channel units; two decimal places assert precision four orders of magnitude finer than the data supports. To a scientist this is a credibility signal, and it is pointing the wrong way.

**Evidence.** `45b_table_scrolled_right.png`, `26b_table_after_fit_scrolled.png`.

**Fix.** Round to the bin resolution and right-align with tabular figures.

```css
.file_table td.numeric_cell {
  text-align: right;
  font-variant-numeric: tabular-nums;
}
```

Format boundaries to the nearest bin edge (`Math.round(value)` at ≥1000, one decimal below), and consider showing the bin index alongside.

---

### F-17 — The callout palette is hard-coded, which blocks the dark theme (P3)

**What's wrong.** `css/help.css:543-568` defines the `callout` variants with literal hex values — `#b7e4c7`/`#f0fbf4` (tip), `#f3d38a`/`#fff8ec` (warn), `#f1b8b3`/`#fdf3f2` (limit), plus `#92620a` for the warn title. None are tokens, so they will not respond to a theme switch and will render as bright light patches on a dark page.

Since the fixes in **F-03**, **F-07** and elsewhere deliberately reuse the `callout` vocabulary inside the app shell, this must be tokenised before UX-09 lands.

**Fix.** Promote them to tokens in `css/base.css` (values in §4).

```css
.callout.tip  { border-color: var(--callout_tip_border);  background: var(--callout_tip_bg); }
.callout.tip  .callout_title { color: var(--callout_tip_text); }
.callout.warn { border-color: var(--callout_warn_border); background: var(--callout_warn_bg); }
.callout.warn .callout_title { color: var(--callout_warn_text); }
.callout.limit{ border-color: var(--callout_limit_border); background: var(--callout_limit_bg); }
.callout.limit .callout_title { color: var(--callout_limit_text); }
```

---

## 4. UX-09 — Dark theme token set

Light stays the default; `prefers-color-scheme: dark` opts in; an explicit user choice overrides both. Every value below was verified with the same luminance/contrast helper used by `tests/ci/test_contrast_tokens.py`.

**Verification result:** all text tokens ≥ 4.5:1 against `--panel`, `--bg`, `--th_bg` and `--accent_soft`; all control boundaries ≥ 3:1; all plot series ≥ 3:1 against `--panel`. Worst case in the dark theme is `--muted` on `--accent_soft` at **6.45:1**.

```css
/* ── Theme tokens ────────────────────────────────────────────────────────
   Light is the default and is defined on bare :root, so a browser that does
   not understand the media query still gets a complete, correct palette.
   Dark is applied in two places: by preference, and by explicit choice. The
   :root:not([data-theme="light"]) guard lets a user who has chosen light
   keep it on a system that prefers dark. */

:root {
  color-scheme: light dark;   /* was: light */

  /* Surfaces & neutrals */
  --bg: #f7f8fb;
  --panel: #ffffff;
  --text: #172033;
  --muted: #647086;
  --border: #d9dee8;
  --border_strong: #7d8799;

  /* Brand / accent */
  --accent: #2563eb;
  --accent_strong: #1d4ed8;
  --accent_soft: #e7efff;
  --logo_teal: #01a5af;
  --teal_action: #007780;
  --logo_blue: #072c67;

  /* Status / action */
  --danger: #b42318;
  --success: #047857;
  --success_strong: #047857;
  --restart: #dc2626;
  --restart_strong: #b91c1c;
  --caution: #8a5a00;

  /* Focus rings */
  --focus_success: rgba(5, 150, 105, 0.28);
  --focus_restart: rgba(220, 38, 38, 0.28);
  --focus_ring: #072c67;

  /* Component surfaces */
  --dropzone_border: #79839a;
  --th_bg: #f2f5fa;
  --progress_track_bg: #e5edf6;
  --progress_track_border: #7d8799;
  --progress_card_border: rgba(1, 165, 175, 0.45);

  /* Callouts (was hard-coded in help.css — see F-17) */
  --callout_tip_bg: #f0fbf4;
  --callout_tip_border: #b7e4c7;
  --callout_tip_text: #047857;
  --callout_warn_bg: #fff8ec;
  --callout_warn_border: #f3d38a;
  --callout_warn_text: #8a5a00;
  --callout_limit_bg: #fdf3f2;
  --callout_limit_border: #f1b8b3;
  --callout_limit_text: #b91c1c;

  /* Shadows */
  --shadow_soft: rgba(15, 23, 42, 0.12);
  --shadow_medium: rgba(15, 23, 42, 0.16);
  --shadow_strong: rgba(15, 23, 42, 0.2);

  /* Plot (D3) — read by plotting/data.js via getComputedStyle */
  --djf_g1: #6fa9cd;
  --djf_s: #9fd487;
  --djf_g2: #e56b6d;
  --djf_total: #111827;
  --djf_debris: #8b6bf0;
  --djf_agg: #d98700;

  /* Residual panel (see §5) */
  --residual_band_fill: color-mix(in srgb, var(--accent) 9%, transparent);
  --residual_band_edge: var(--muted);
  --residual_mark: var(--muted);
  --residual_mark_out: var(--danger);
  --residual_zero: var(--text);
}

/* Dark palette, defined once and referenced twice. */
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --bg: #0f141c;
    --panel: #161d28;
    --text: #e8ecf4;
    --muted: #a3aec2;
    --border: #38424f;
    --border_strong: #6b788c;

    --accent: #7aa8f5;
    --accent_strong: #a9c6ff;
    --accent_soft: #1d2a3f;
    --logo_teal: #3fd0d9;
    --teal_action: #5fdbe3;
    --logo_blue: #9db9e8;

    --danger: #ff9b91;
    --success: #5ed6a4;
    --success_strong: #7ee3b8;
    --restart: #ff8f8f;
    --restart_strong: #ffb3b3;
    --caution: #f0b64a;

    --focus_success: rgba(94, 214, 164, 0.32);
    --focus_restart: rgba(255, 143, 143, 0.32);
    --focus_ring: #a9c6ff;

    --dropzone_border: #6b788c;
    --th_bg: #1c2532;
    --progress_track_bg: #1c2532;
    --progress_track_border: #6b788c;
    --progress_card_border: rgba(63, 208, 217, 0.5);

    --callout_tip_bg: #12241c;
    --callout_tip_border: #2f6b4d;
    --callout_tip_text: #7ee3b8;
    --callout_warn_bg: #2a2113;
    --callout_warn_border: #7a5c1f;
    --callout_warn_text: #f0b64a;
    --callout_limit_bg: #2a1817;
    --callout_limit_border: #7d3733;
    --callout_limit_text: #ffb3b3;

    --shadow_soft: rgba(0, 0, 0, 0.5);
    --shadow_medium: rgba(0, 0, 0, 0.6);
    --shadow_strong: rgba(0, 0, 0, 0.72);

    --djf_g1: #8fc4e8;
    --djf_s: #a9dd93;
    --djf_g2: #f09a9c;
    --djf_total: #e8ecf4;
    --djf_debris: #c4a9fb;
    --djf_agg: #f5b455;
  }
}

/* Explicit choice wins in both directions. Duplicating the block (rather than
   using :is()) keeps specificity predictable and avoids a selector that some
   engines drop wholesale if one part is unsupported. */
:root[data-theme="dark"] {
  --bg: #0f141c;
  --panel: #161d28;
  --text: #e8ecf4;
  --muted: #a3aec2;
  --border: #38424f;
  --border_strong: #6b788c;
  --accent: #7aa8f5;
  --accent_strong: #a9c6ff;
  --accent_soft: #1d2a3f;
  --logo_teal: #3fd0d9;
  --teal_action: #5fdbe3;
  --logo_blue: #9db9e8;
  --danger: #ff9b91;
  --success: #5ed6a4;
  --success_strong: #7ee3b8;
  --restart: #ff8f8f;
  --restart_strong: #ffb3b3;
  --caution: #f0b64a;
  --focus_success: rgba(94, 214, 164, 0.32);
  --focus_restart: rgba(255, 143, 143, 0.32);
  --focus_ring: #a9c6ff;
  --dropzone_border: #6b788c;
  --th_bg: #1c2532;
  --progress_track_bg: #1c2532;
  --progress_track_border: #6b788c;
  --progress_card_border: rgba(63, 208, 217, 0.5);
  --callout_tip_bg: #12241c;
  --callout_tip_border: #2f6b4d;
  --callout_tip_text: #7ee3b8;
  --callout_warn_bg: #2a2113;
  --callout_warn_border: #7a5c1f;
  --callout_warn_text: #f0b64a;
  --callout_limit_bg: #2a1817;
  --callout_limit_border: #7d3733;
  --callout_limit_text: #ffb3b3;
  --shadow_soft: rgba(0, 0, 0, 0.5);
  --shadow_medium: rgba(0, 0, 0, 0.6);
  --shadow_strong: rgba(0, 0, 0, 0.72);
  --djf_g1: #8fc4e8;
  --djf_s: #a9dd93;
  --djf_g2: #f09a9c;
  --djf_total: #e8ecf4;
  --djf_debris: #c4a9fb;
  --djf_agg: #f5b455;
}

:root[data-theme="dark"] { color-scheme: dark; }
:root[data-theme="light"] { color-scheme: light; }
```

### Verified contrast

| Pair | Light | Dark |
|---|---|---|
| `--text` on `--panel` | 16.27 | 14.30 |
| `--muted` on `--panel` | 5.00 | 7.57 |
| `--muted` on `--bg` | 4.70 | 8.26 |
| `--accent_strong` on `--panel` | 6.70 | 9.84 |
| `--danger` on `--panel` | 6.57 | 8.34 |
| `--success` on `--panel` | 5.48 | 9.38 |
| `--border_strong` on `--panel` | 3.62 | 3.78 |
| `--dropzone_border` on `--panel` | 3.80 | 3.78 |
| `--djf_s` on `--panel` | 2.40 | 10.84 |

### Theme control

```html
<fieldset class="theme_control" aria-label="Colour theme">
  <legend class="visually_hidden">Colour theme</legend>
  <button type="button" id="theme_system" class="theme_option" aria-pressed="true">Auto</button>
  <button type="button" id="theme_light"  class="theme_option" aria-pressed="false">Light</button>
  <button type="button" id="theme_dark"   class="theme_option" aria-pressed="false">Dark</button>
</fieldset>
```

```css
.theme_control {
  display: inline-flex;
  gap: 0;
  margin: 0;
  padding: 2px;
  border: 1px solid var(--border_strong);
  border-radius: 8px;
  background: var(--panel);
}

.theme_option {
  width: auto;
  min-height: 30px;
  padding: 0 10px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--muted);
  font-size: 0.78rem;
  font-weight: 700;
}

.theme_option[aria-pressed="true"] {
  background: var(--accent_soft);
  color: var(--accent_strong);
}

@media (forced-colors: active) {
  .theme_option[aria-pressed="true"] {
    background: Highlight;
    color: HighlightText;
    forced-color-adjust: none;
  }
}
```

Three notes for implementation:

1. **`color-scheme: light dark`** must replace `color-scheme: light` at `css/base.css:6`, otherwise native form controls and scrollbars stay light while everything around them goes dark.
2. **`js/plotting/data.js` reads tokens once at module load** via `css_color()` (`data.js:75-96`). Those constants must be re-read and the plot re-rendered on theme change, or the chart keeps the old palette. Dispatch the existing `pf-plot-rendered` sibling event, or add a `pf-theme-changed` listener that invalidates the cached colours.
3. Persist the choice in the same store the session layer already uses, and default to `system`.

---

## 5. Residual panel design

### Purpose

A strip plot of (fitted − observed) per bin, beneath the histogram, sharing its x-axis. It is the most direct visual evidence of whether a fit is good — and the antidote to **F-02**, because it turns "fit quality: 2.34" into something a bench biologist can see.

### Layout and proportions

- Sits inside `.plot_panel_inner`, between `#plot_area` and `.plot_accessibility_summary`.
- Height `clamp(96px, 22%, 156px)` — roughly a 1:4 ratio to the histogram, the standard residual-panel proportion. Never grows at the histogram's expense.
- **Alignment is the critical constraint.** The residual strip must use the *identical* left and right margins as the histogram, so every bin sits directly under its own residual. `PLOT_MARGIN = { top: 14, right: 210, bottom: 48, left: 70 }` (`js/plotting/data.js:89`), where `right: 210` is the legend gutter. Rather than duplicating those numbers, the renderer should publish them as custom properties on `.plot_panel_inner`, and both the histogram and the residual strip read from there — one source of truth.
- Below 700 px the histogram switches to `{ right: max(100, 30% of width), left: 52 }` (`render.js:943-945`). The residual panel follows the same rule automatically by reading the same custom properties.
- The histogram keeps its own x-axis; the residual strip draws ticks without labels or a title, so the shared axis is read once.

### Marks and colour

- **Marks:** thin vertical stems from zero, one per bin. At 1024 bins a dot plot is unreadable and a line implies continuity that residuals do not have; stems degrade gracefully from 128 to 1024 bins at 1 px each.
- **In-band stems:** `--residual_mark` (`--muted`) — 5.00:1 light, 7.57:1 dark.
- **Out-of-band stems:** `--residual_mark_out` (`--danger`) **plus a triangular cap**. Colour is never the sole channel (WCAG 1.4.1); the cap shape carries it too.
- **±2 band:** a filled `--residual_band_fill` region with dashed `--residual_band_edge` boundaries. Neutral-cool rather than green, so colour stays reserved for what is *wrong*.
- **Zero line:** 1 px solid `--residual_zero`.
- **Y domain:** symmetric, `±max(3, ceil(max|r|))` capped at ±8. Values beyond the cap are pinned to the edge and marked with a caret, so one wild bin cannot flatten the rest.
- **Multiple samples:** residuals are drawn for the *reviewed* sample only. Three overlapping residual clouds are noise; the caption names the sample.

### Markup

```html
<!-- Inside .plot_panel_inner, after #plot_area, before .plot_accessibility_summary -->
<figure id="residual_panel" class="residual_panel" hidden>
  <figcaption class="residual_panel_head">
    <span class="residual_panel_title" id="residual_panel_title">
      Fit residuals &mdash; <span id="residual_sample_name" class="residual_sample_name"></span>
    </span>
    <div class="residual_panel_controls">
      <label class="residual_scale_field">
        <span class="residual_scale_label">Scale</span>
        <select id="residual_scale" class="residual_scale_select quick_tooltip"
                data-tooltip-key="residualScale">
          <option value="pearson" selected>Pearson (standardised)</option>
          <option value="raw">Raw counts</option>
        </select>
      </label>
      <button type="button" id="residual_panel_toggle" class="panel_icon_toggle quick_tooltip"
              aria-expanded="true" aria-controls="residual_panel_body"
              data-tooltip-key="residualCollapse" aria-label="Collapse residual panel">
        <img id="residual_panel_toggle_icon" class="panel_toggle_icon"
             src="./assets/img/table_minimize.svg" alt="" aria-hidden="true" />
      </button>
    </div>
  </figcaption>

  <div id="residual_panel_body" class="residual_panel_body">
    <p id="residual_verdict" class="residual_verdict" role="status" aria-live="polite" aria-atomic="true">
      <span class="residual_verdict_label">Residuals look unstructured</span>
      <span class="residual_verdict_detail">12 of 256 bins (4.7%) fall outside &plusmn;2 &mdash; consistent with a good fit.</span>
    </p>

    <div id="residual_area" class="residual_area" role="img"
         aria-labelledby="residual_panel_title" aria-describedby="residual_verdict"></div>

    <details class="plot_accessibility_summary residual_summary">
      <summary>Residual data summary</summary>
      <table>
        <caption>Text alternative for the residual plot</caption>
        <thead>
          <tr>
            <th scope="col">Sample</th>
            <th scope="col">Bins</th>
            <th scope="col">RMS standardised residual</th>
            <th scope="col">Bins outside &plusmn;2</th>
            <th scope="col">Largest deviation</th>
            <th scope="col">Longest run on one side</th>
            <th scope="col">Reading</th>
          </tr>
        </thead>
        <tbody id="residual_summary_body"></tbody>
      </table>
    </details>
  </div>
</figure>
```

A populated row reads, for example:

| Sample | Bins | RMS | Outside ±2 | Largest deviation | Longest run | Reading |
|---|---|---|---|---|---|---|
| truth_s_rich_25_55_20 | 256 | 1.08 | 12 (4.7 %) | +3.4 at DNA-A 121,400 (G2/M) | 4 bins | Unstructured — consistent with a good fit |

That last column is the point. It is the sentence a bench biologist can paste into a lab notebook.

### Styles

```css
/* ── Residual panel ──────────────────────────────────────────────────────
   A strip of (fitted − observed) per bin under the histogram, on the same
   x-scale and the same left/right margins, so every bin lines up with its
   own residual. Appears only once a fit exists.

   --plot_margin_left / --plot_margin_right are published by the plot
   renderer alongside PLOT_MARGIN, so the strip and the histogram share one
   source of truth instead of duplicating the constants. */

.plot_panel_inner {
  --plot_margin_left: 70px;
  --plot_margin_right: 210px;
  --residual_height: clamp(96px, 22%, 156px);
}

.residual_panel {
  flex: 0 0 auto;
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin: 6px 0 0;
  padding: 6px 0 0;
  border-top: 1px solid var(--border);
}

.residual_panel_head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  /* Align the title with the plot column, not the panel edge. */
  padding-left: var(--plot_margin_left);
  padding-right: 8px;
}

.residual_panel_title {
  font-size: 0.8rem;
  font-weight: 700;
  color: var(--text);
}

.residual_sample_name {
  font-weight: 400;
  color: var(--muted);
}

.residual_panel_controls {
  display: flex;
  align-items: center;
  gap: 8px;
}

.residual_scale_field {
  display: flex;
  align-items: center;
  gap: 5px;
  margin: 0;
}

.residual_scale_label {
  font-size: 0.7rem;
  font-weight: 650;
  color: var(--muted);
}

.residual_scale_select {
  width: auto;
  min-height: 28px;
  padding: 0 6px;
  border: 1px solid var(--border_strong);
  border-radius: 5px;
  font-size: 0.74rem;
}

/* ── Verdict ────────────────────────────────────────────────────────────
   Reads before the chart, because it is the answer the chart supports. */
.residual_verdict {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 6px;
  margin: 0;
  padding: 4px 8px 4px var(--plot_margin_left);
  font-size: 0.76rem;
  line-height: 1.4;
}

.residual_verdict_label { font-weight: 800; }

.residual_verdict_detail { color: var(--text); }

.residual_verdict.is_good      .residual_verdict_label { color: var(--success); }
.residual_verdict.is_caution   .residual_verdict_label { color: var(--caution); }
.residual_verdict.is_bad       .residual_verdict_label { color: var(--danger); }

.residual_verdict.is_caution { background: color-mix(in srgb, var(--caution) 12%, transparent); }
.residual_verdict.is_bad     { background: color-mix(in srgb, var(--danger) 9%, transparent); }

/* ── Chart area ─────────────────────────────────────────────────────────
   Height is fixed so the histogram never loses room to it. */
.residual_area {
  position: relative;
  flex: 0 0 auto;
  height: var(--residual_height);
  min-height: 96px;
}

.residual_area svg { display: block; width: 100%; height: 100%; }

/* Acceptance band: neutral, so colour stays reserved for what is wrong. */
.residual_band {
  fill: var(--residual_band_fill);
  stroke: none;
}

.residual_band_edge {
  stroke: var(--residual_band_edge);
  stroke-width: 1;
  stroke-dasharray: 4 3;
  fill: none;
}

.residual_band_label {
  fill: var(--muted);
  font-size: 10px;
  font-weight: 650;
}

.residual_zero_line {
  stroke: var(--residual_zero);
  stroke-width: 1;
}

/* One stem per bin. */
.residual_stem {
  stroke: var(--residual_mark);
  stroke-width: 1;
}

/* Out of band: colour AND shape, never colour alone. */
.residual_stem.is_out {
  stroke: var(--residual_mark_out);
  stroke-width: 1.5;
}

.residual_out_cap {
  fill: var(--residual_mark_out);
}

/* Value beyond the clamped y-domain, pinned to the edge. */
.residual_clamp_caret {
  fill: var(--residual_mark_out);
  stroke: var(--panel);
  stroke-width: 0.5;
}

.residual_axis text { fill: var(--muted); font-size: 10px; }

.residual_axis .domain,
.residual_axis .tick line { stroke: var(--border_strong); }

.residual_summary { margin-top: 4px; }

/* ── Narrow widths ──────────────────────────────────────────────────────
   The strip keeps full width and loses height, not information. Below the
   stacked breakpoint the left margin collapses so the chart keeps its area. */
@media (max-width: 820px) {
  .plot_panel_inner {
    --plot_margin_left: 52px;
    --plot_margin_right: max(100px, 30vw);
    --residual_height: 104px;
  }

  .residual_panel_head {
    flex-wrap: wrap;
    padding-left: 8px;
  }

  .residual_verdict { padding-left: 8px; }
}

@media (max-width: 480px) {
  .plot_panel_inner { --residual_height: 88px; }

  /* Keep the band, drop its annotation — the verdict already says ±2. */
  .residual_band_label { display: none; }

  .residual_scale_label { display: none; }
}

@media (prefers-reduced-motion: reduce) {
  .residual_panel, .residual_area svg * { transition: none !important; }
}

@media (forced-colors: active) {
  .residual_band { fill: Canvas; }
  .residual_band_edge { stroke: CanvasText; }
  .residual_zero_line { stroke: CanvasText; }
  .residual_stem { stroke: CanvasText; }
  .residual_stem.is_out,
  .residual_out_cap,
  .residual_clamp_caret { stroke: Highlight; fill: Highlight; forced-color-adjust: none; }
}
```

### Verdict thresholds

For Pearson-standardised residuals, roughly 5 % of bins should fall outside ±2 by chance alone. Structure matters more than count — a *run* of same-sign residuals means the model is missing a feature.

| Condition | Class | Label |
|---|---|---|
| ≤ 6 % outside and longest run < 5 | `is_good` | "Residuals look unstructured" |
| ≤ 12 % outside or run 5–9 | `is_caution` | "Some structure in the residuals" |
| > 12 % outside or run ≥ 10 | `is_bad` | "The model is missing structure" |

The `is_bad` detail should name *where*: "a run of 14 consecutive bins above the curve near G2/M — the model is missing structure there." Location is what makes the finding actionable, since it points at the peak region to re-review.

### Integration notes

- Register the new ids in `js/ui/dom.js` (listed in **F-04**) or `npm run check:dom` will fail.
- Show the panel only when `result.validForReporting !== undefined` — i.e. a fit was attempted. Hide it, do not empty it, otherwise the histogram jumps.
- Recompute on bin-count change; the existing `plot_bins_undo` flow already invalidates fits, so the panel should follow the same invalidation.
- The verdict is the natural companion to the **F-02** fit verdict. Wording should match between the two so a user reading "Use with caution" in the sidebar sees "Some structure in the residuals" here and understands they are the same claim.

---

## 6. Priority and effort

Effort: **XS** < 1 h · **S** 1–4 h · **M** 1–3 d · **L** > 3 d. All estimates are implementation only.

### Ship first — scientific trust (≈ 4–6 days)

These four change whether a user can tell a good result from a bad one. Nothing else in this document matters as much.

| Order | ID | Finding | Effort |
|---|---|---|---|
| 1 | **F-02** | Invert result hierarchy; verdict outranks percentages | S |
| 2 | **F-03** | Three-state QC gates; stop claiming a gate passed | M |
| 3 | **F-01** | Rewrite fit outcome reporting; drop the enum tally | M |
| 4 | **F-04** | Live region + heading on the result panel | S |
| 5 | **Phase 2** | Residual panel | M–L |

F-02 first: it is the smallest change with the largest effect on trust, and it establishes the verdict vocabulary that F-01, F-03 and the residual panel all reuse.

### Then — workflow legibility (≈ 3–4 days)

| Order | ID | Finding | Effort |
|---|---|---|---|
| 6 | **F-07** | Stop auto-opening the metadata wizard | S |
| 7 | **F-08** | Confirm peak detection where the user is looking | S |
| 8 | **F-06** | "Run All…" honesty + modal sizing | S |
| 9 | **F-05** | Workflow spine, 2×2 peak grid, scroll affordance | M |
| 10 | **F-09** | Error contract: what / why / what next | M |

F-07 and F-08 are near-free and remove the two sharpest first-run irritations.

### Then — accessibility and responsive (≈ 3–4 days, pairs with UX-02/UI-19)

| Order | ID | Finding | Effort |
|---|---|---|---|
| 11 | **F-12** | `--border_strong`; expand the contrast test | S |
| 12 | **F-10** | `aria-disabled` + visible requirements + empty state | S |
| 13 | **F-11** | Tab order, skip link, tooltip out of the tab order | S |
| 14 | **F-13** | 44 px hit areas on selection controls | S |
| 15 | **F-14** | Zoom-aware breakpoint — **do together with UX-02/FE-016** | M |

### Then — design system (≈ 2–3 days)

| Order | ID | Finding | Effort |
|---|---|---|---|
| 16 | **F-17** | Tokenise the callout palette (blocks the next item) | S |
| 17 | **UX-09** | Dark theme tokens, control, plot re-read on change | M |
| 18 | **F-15** | Deepen light-theme component fills | XS |
| 19 | **F-16** | Round peak boundaries to bin resolution | XS |

### Dependencies

- **F-17 → UX-09.** The callouts must be tokens before a theme switch exists, or they render as light patches on dark.
- **F-12 → UX-09.** `--border_strong` should be introduced in the same pass that restructures the token block.
- **F-02 → F-01, F-03, Phase 2.** All three reuse the verdict vocabulary; defining it once avoids three inconsistent versions.
- **F-14 → UX-02/FE-016.** Same stylesheet, same breakpoint, same reasoning. Doing them separately means touching `responsive.css` twice.

### Suggested first PR

F-02 + F-04 together. One stylesheet block, one markup change, one `dom.js` registration. It makes fit results legible and announceable, establishes the `fit_verdict` pattern the rest of the work builds on, and is small enough to review carefully — which matters, because it changes how a scientific result is presented.
