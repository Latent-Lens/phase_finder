> Archived 2026-09-05 from docs/audits/archive/ui_issues_report.md. Historical findings are reconciled in the master checklist; unchecked boxes here are not an active work queue. [Current register](../../../audits/master_checklist.md).

# PhaseFinder — UI issues that should be fixed

**Date:** 2026-08-14
**Method:** every item below was verified against the current source today. Where an older audit claimed a problem that no longer exists, that is stated explicitly rather than repeated.
**Companion document:** a screenshot-backed *visual/design* audit is being produced separately at `docs/audits/ui_ux_audit_2026-08.md`. **This document is the code-verified list** — what is provably still broken in the markup, CSS, and wiring. The two should be merged once both exist.

---

## First: four items from the old audit are already fixed

`needs_to_be_fixed_ux.md` is from 2026-07-17 and has never been reconciled. I checked its open items against the tree, and **most have been remediated**. Do not spend time on these:

| Item | Old claim | Verified today |
|---|---|---|
| **UX-02 / FE-016** | Mobile layout subtracts a hard-coded 60 px header; content clipped behind the fixed footer | ✅ **Fixed.** No hard-coded header subtraction remains. `body` uses `height: 100dvh`, and at `≤820px` `css/responsive.css` sets `.app { grid-template-rows: auto auto; height: auto; }` with `overflow-y: auto` and safe-area insets. |
| **UX-05** | Status/error updates not announced to screen readers | ✅ **Fixed.** `index.html:848-849` gives the footer a `role="status" aria-live="polite"` message channel *and* a separate `role="alert"` assertive channel — exactly the "one deliberate announcement channel" the audit asked for. Eight live regions exist across the app. |
| **UX-07** | Panel resizers mouse-only and `aria-hidden` | ✅ **Fixed.** Both `#sidebar_resizer` and `#workspace_resizer` are `role="separator" tabindex="0"` with `pointerdown` **and** `keydown` arrow-key handlers (`panel_resize.js:39,73,158,189`). |
| **UX-08** | Two adjacent ambiguous "Run All" buttons | ✅ **Fixed.** Only one remains (`#qc_filter_all`, the QC gate runner). The second belonged to the staged pipeline UI that is no longer wired in. |

**I previously reported UX-02 and UX-08 as open in the status document. That was wrong, and §5.5 there needs correcting.**

---

## Still open, ordered by impact

### 1. A fit result can display as authoritative without its trust state — **scientific hazard**

**Severity: highest.** This is a UI problem with scientific consequences, not a cosmetic one.

The result contract already computes honest state — `converged`, `validForReporting`, `validityReasons`, `warnings`. The metadata table renders the percentage. **It does not render the state.** `js/ui/cell_cycle_columns.js:130-137` formats the fraction and nothing else:

```js
const fraction = result && result.modelId === modelId ? result.phaseFractions[phase] : null;
return format_cell_cycle_value(
  Number.isFinite(fraction) ? `${(fraction * 100).toFixed(1)}%` : null, "");
```

A user copies "46.2%" into a figure with no indication the optimizer stalled or the contract refused the result. Checklist item **SCI-03** covers this and is open.

**Fix** — the state must travel with the number wherever it appears:

```js
// A bare percentage reads as authoritative. If the fit did not converge, or the
// contract refused it for reporting, the number must not appear naked in a
// column someone will paste into a paper.
function format_fraction_cell(result, fraction) {
  if (!Number.isFinite(fraction)) return format_cell_cycle_value(null, "");
  const text = `${(fraction * 100).toFixed(1)}%`;
  if (result.validForReporting === false) return format_cell_cycle_value(`${text} ⚠`, "unvalidated result");
  if (result.converged === false) return format_cell_cycle_value(`${text} ⚠`, "fit did not converge");
  return format_cell_cycle_value(text, "");
}
```

Apply the same in the sidebar readout, the plot legend, and the TSV export. The symbol alone is not enough — pair it with a `title`/`aria-label` giving the reason, and use a non-colour cue so it survives greyscale printing.

**Effort:** ~half a day including the cross-surface test that checks all consumers agree.

---

### 2. No dark theme, and the OS preference is actively overridden

**Severity: high for the actual use context.** Flow cytometry is often read in a darkened room next to the instrument.

`css/base.css:6` declares `color-scheme: light` and there is **zero** `prefers-color-scheme` handling in any app stylesheet (verified: `grep prefers-color-scheme css/*.css` matches only the two `color-scheme: light` declarations). There is no theme control and no stored preference.

**Fix** — this is a token-layer change, and the existing CSS is already token-based, so it is more mechanical than it sounds:

```css
/* Light stays the default and the fallback. Dark is defined only as token
   overrides, so every component that already consumes tokens follows for free. */
:root {
  color-scheme: light dark;   /* was: light */
  /* …existing light tokens unchanged… */
}

/* System preference, unless the user has explicitly chosen light. */
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --surface: #14181d;
    --surface_raised: #1c2229;
    --text_primary: #e8edf2;
    --text_secondary: #a7b2bd;
    --border: #2b333c;
    /* Plot series must be re-checked for contrast against the dark surface --
       the existing DJF_G1/S/G2 colours were chosen against white. */
  }
}

/* Explicit choice wins in both directions. */
:root[data-theme="dark"] { /* same overrides as above */ }
```

**Two cautions specific to this app.** The plot component colours (`DJF_G1_COLOR`, `DJF_S_COLOR`, `DJF_G2_COLOR` in `js/plotting/data.js`) are read from CSS custom properties with hard-coded fallbacks — they must be re-validated for contrast against a dark surface, not merely inherited. And `test_contrast_tokens.py` must be extended to run in both themes, or the dark theme ships unverified.

**Effort:** 1–2 days, most of it re-validating plot colours.

---

### 3. `forced-colors` support stops at the front door

**Severity: medium-high**, blocking for Windows High Contrast users.

`forced-colors` blocks exist in `css/base.css` (1) and `css/help.css` — and **nowhere else**. Verified counts: `sidebar.css` 0, `table.css` 0, `layout.css` 0, `plot.css` 0. So the shell adapts and then the metadata table, the sidebar controls, the modals, and the plot chrome do not.

`focus-visible` coverage is better but uneven: `base.css` 2, `layout.css` 10, `sidebar.css` 8, `plot.css` 6, `table.css` 1, **`feedback.css` 0**.

**Fix** — add a forced-colors block to each of the four missing stylesheets covering borders, focus rings, and any colour-only state; and give `table.css` and `feedback.css` real focus treatment. The pattern already used in `help.css:582` is the right one to copy. This closes the remaining **UI-19** items.

**Effort:** ~1 day including a forced-colors pass in the test suite.

---

### 4. Axis-range editing is reachable only by an undocumented double-click

**Severity: medium.** Verified: the plot toolbar contains exactly six buttons — `camera`, `pan`, `zoom_in`, `zoom_out`, `autoscale`, `home`. **None opens the axis dialog.** `axis_modal.js:244` opens it from a custom event dispatched by a double-click on invisible SVG hit areas.

This matters more here than in a general-purpose app, because the axis range can be promoted to the **scientific analysis domain** — a setting that changes results. A control that changes what gets modelled should not be hidden behind an undiscoverable gesture.

**Fix** — add a seventh toolbar button next to `autoscale`:

```html
<button id="plot_tool_axes" class="plot_tool quick_tooltip" type="button"
        data-tooltip-key="plotToolAxes" aria-label="Set axis ranges"
        aria-haspopup="dialog">…</button>
```

Register it in `js/ui/dom.js` (`npm run check:dom` will fail until you do), wire it to `open_axis_range_modal()`, and keep the double-click as a shortcut. Note the button must be reachable by keyboard, which the current gesture never was. This closes **UX-06**.

**Effort:** ~2 hours plus an icon.

---

### 5. The strongest evidence of a bad fit is computed and never shown

**Severity: medium**, but it is a stated definition-of-done item.

`fitResult.curves` already carries `residuals`, and `cell_cycle_fit_report.js` analyses their structure (lag-1 autocorrelation, Durbin–Watson, maximum local bias). **Nothing renders them** — `grep residual js/plotting/render.js` returns nothing, and `index.html` has no residual element. The modeling plan's definition of done says *"residuals are visible by default."*

Covered as **WP-3.1** in the status document, with code. The companion design audit is producing a visual specification for the panel.

**Effort:** ~1 day.

---

### 6. One breakpoint for the whole responsive range

**Severity: medium.** `css/responsive.css` declares exactly one: `@media (max-width: 820px)`.

That single switch has to serve a 768 px tablet in landscape, a 390 px phone, and a 320 px small phone. The shell fix (item above) means it no longer *breaks*, but a metadata table with many columns and a sidebar with four QC panels almost certainly need different treatment at 390 px than at 768 px.

**Fix** — verify at 320 / 390 / 768 / 820 / 1024 and add a second breakpoint if the table or sidebar demands it. The screenshot audit will show whether this is a real problem or a theoretical one; treat this item as *needs evidence* rather than *known broken*.

---

### 7. Two different default bin counts

**Severity: low, but user-visible and confusing.**

`js/analysis/dna_histogram.js:18` declares `DEFAULT_BIN_COUNT = 512`; `js/plotting/data.js:47` declares `DEFAULT_BINS = 256`. Same concept, two values, and which one applies depends on the call path. A user who notices their histogram binning differs between two routes has no way to explain it.

**Fix:** one exported constant, imported by both. **Effort:** 15 minutes.

---

### 8. Three help pages are unreachable and unshipped

**Severity: low for the app, high for user trust.**

`help/djf-model-validation.html`, `help/result_validation.html`, and `help/tool_validation.html` are linked from nowhere and are **not copied into `dist/`**. They are substantive — model formula term by term, peak calling, ground-truth recovery, and a 30-sample FlowJo comparison — and they are **newer** (Jul 30–31) than the two condensed validation pages that *are* linked (Jul 30 14:51–14:52).

So the most detailed, most current evidence that the tool's numbers can be trusted is invisible to users. For a scientific tool, that is the documentation you least want to hide.

**Fix:** add them to the help index and the sidebar nav (they already use `../css/help.css` and the standard `help_layout`, so they will fit without restyling), and confirm the build copies them. Or archive them deliberately — but not silently.

---

---

## Findings from the visual audit that this document missed

The companion screenshot audit — [`docs/audits/ui_ux_audit_2026-08.md`](ui_ux_audit_2026-08.md), 1,892 lines, 54 screenshots in `ui_screenshots/` — drove the real app and found several things a source read could not. **I verified each of the following against the source before including it here.**

### A. The trust hierarchy is inverted — this supersedes item 1 above

Item 1 said the trust state is *absent*. It is worse than that: it is **present and visually subordinated**. Verified in `css/plot.css:1098-1161`:

| element | size | colour |
|---|---|---|
| phase percentages | `0.78rem` | `var(--text)` |
| convergence status, fit-quality score, warning count | `0.72rem` | `var(--muted)` |

The numbers are larger and darker than the caveats that qualify them. A poor fit and a perfect one are distinguished only by a small grey-to-red shift, and the `goodnessOfFit` explanation lives solely in a `title` attribute — unreachable by keyboard or touch. **The fix is not just "add the state" but "invert the emphasis."**

### B. Fit results are announced to nobody

`index.html:247` — `<div id="cell_cycle_fit_result" class="cell_cycle_fit_result" hidden></div>`. **No `role`, no `aria-live`, no heading.** Screen-reader users get silence when a fit completes. This is a one-attribute fix and belongs with item 1.

### C. The sidebar affirmatively contradicts the table about QC

After "Run All", all four gate buttons render the applied state (`plot.css:620`, keyed on `aria-pressed`) while the table simultaneously reads *"Cell gate incomplete: scatter gate review required."* The user believes QC passed, clicks Fit, and is refused.

Root cause: `aria-pressed` is being used to mean *"completed successfully"* when it actually means *"toggle is on."* **There is no vocabulary for the third state** — attempted-but-incomplete. That needs a real state model (`not-run` / `running` / `applied` / `needs-review` / `failed`), not a CSS tweak.

### D. Bulk-fit failures blame the user

Verified at `modeling_ui.js:583` and `:663` — the reason string `"User cancelled bulk fitting"` is hard-coded on cancellation paths regardless of actual cause. The resulting message reads *"0 converged/reportable; 0 computed but did not converge; 0 detection failed; 0 fit failed; 3 cancelled; 0 skipped"* — five of six terms are zero, and the one non-zero term misattributes the cause. (`:700` does distinguish aborted from not-reached, so this is two paths, not three.)

### E. `--border` fails non-text contrast

`css/base.css:13` — `--border: #d9dee8`. Computed against white: **1.35:1**, where WCAG requires **3:1** for control boundaries. Every bordered control in the app is under-delineated.

### F. Other verified items

- The metadata wizard **auto-opens as a blocking modal 750 ms after first file load and steals focus** (`metadata_wizard.js:451`). It interrupts the user mid-orientation.
- "Run All" opens a config modal at step 2 and stops — it does not run all.
- Detect Peaks reports success while leaving all four sidebar region fields empty.
- Row-selection checkboxes are 17 px (below the 24 px minimum target size).
- **200% zoom drops desktop users below the 820 px breakpoint** into the mobile stacked layout — which makes item 6 above concrete rather than theoretical, and is a WCAG reflow issue.
- Model & Fit begins 775 px into an 802 px scroll container, so the fit buttons sit below the fold with no scroll affordance. (This is the *residual* half of UX-08 — the button labels themselves were fixed.)
- `test_contrast_tokens.py` only checks text tokens against `--panel` — never `--bg`, `--th_bg`, or `--accent_soft`, and never component boundaries. The audit includes an expanded test that **currently fails on three real pairs**.

The visual audit also contains a full dark-theme token set (§4) and the residual panel design (§5), with every colour verified programmatically against WCAG.

---

## Consolidated priority

Both documents merged, most severe first:

| # | Issue | Severity | Effort | Source |
|---|---|---|---|---|
| 1 | **Trust hierarchy inverted** — caveats smaller and lighter than the numbers they qualify; no live region on the result | **Highest** | ~1 d | visual (A, B) |
| 2 | **QC state lies** — sidebar says applied, table says incomplete; no vocabulary for the third state | **Highest** | ~1–2 d | visual (C) |
| 3 | `--border` at 1.35:1; `test_contrast_tokens.py` misses most tokens | High | ~0.5 d | visual (E) |
| 4 | `forced-colors` missing from 4 of 6 stylesheets | High | ~1 d | code (3) |
| 5 | Bulk-fit failures misattributed to the user | High | ~2 h | visual (D) |
| 6 | 200% zoom forces desktop into mobile layout | High | ~0.5 d | visual (F) |
| 7 | Metadata wizard auto-opens and steals focus | Medium | ~1 h | visual (F) |
| 8 | Axis dialog only reachable by hidden double-click | Medium | ~2 h | code (4) |
| 9 | Residuals computed but never displayed | Medium | ~1 d | code (5) + design in §5 |
| 10 | No dark theme; OS preference overridden | Medium | 1–2 d | code (2) + tokens in §4 |
| 11 | Fit buttons below the fold with no affordance | Medium | ~2 h | visual (F) |
| 12 | Checkboxes at 17 px | Low | ~15 min | visual (F) |
| 13 | Two default bin counts (256 vs 512) | Low | ~15 min | code (7) |
| 14 | Three validation help pages unreachable/unshipped | Low | ~1 h | code (8) |

**Suggested order:** 13 → 12 → 5 → 1 → 2 → 3 → 4 → 6 → 7 → 8 → 9 → 11 → 10 → 14.

Rationale: the two 15-minute items clear first. Then 5 (misattributed failures) because it is cheap and actively misleading. Then 1 and 2 — the trust-communication defects, which are the ones with scientific consequences. Accessibility (3, 4, 6) follows. The dark theme (10) is the largest single item and depends on the contrast work in 3 being done first, so it goes late despite being the most visible.
