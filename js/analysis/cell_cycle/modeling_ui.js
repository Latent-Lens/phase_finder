// Sidebar "Model & Fit" panel: lets the user pick a registered cell-cycle
// model (js/analysis/cell_cycle/model_registry.js) and fit it against the
// reviewed sample's accepted G1/G2 peak regions, showing a model-neutral
// phase-fraction summary. Reuses peak_review_ui.js's active_peak_review_row()
// -- there is still no separate sample picker here, by design.
//
// This is the first increment of the M6 UI-wiring milestone: model
// selection, fit orchestration, and a sidebar result summary. Rendering
// fitted components/residuals on the plot itself, model-neutral metadata-
// table columns, session persistence, and export are follow-up increments
// (docs/plans/cell_cycle_modeling_plan.md §7 and M6's remaining tasks).

import {
  cell_cycle_model_select,
  cell_cycle_fit_current_button,
  cell_cycle_fit_all_button,
  cell_cycle_fit_status,
  cell_cycle_fit_result,
  cell_cycle_domain_sensitivity_button,
  cell_cycle_domain_sensitivity_status,
  cell_cycle_resampling_button,
  cell_cycle_resampling_status,
  peak_regions_apply_all_button,
} from "../../ui/dom.js";
import {
  plottable_rows,
  plot_bin_count,
  clamp_range_to_analysis_domain,
  set_plot_view_mode,
  plot_view_mode_select,
} from "../../plotting/data.js";
import { render_density_plot } from "../../plotting/render.js";
import { set_status_bar, show_progress, update_progress, hide_progress, show_progress_cancel } from "../../ui/status_channels.js";
import { load_pipeline } from "../pipeline/pipeline_loader.js";
import { get_state, get_active_model_result } from "../pipeline/pipeline_state.js";
import { get_file_table } from "../../state/app_state.js";
import { histogramFromEdgesCounts } from "./models/cloccs.js";
import { run_cloccs_fit } from "./cloccs_client.js";
import { fit_pool_size } from "./fit_client.js";
import { get_model } from "./model_registry.js";
import { active_peak_review_row, peak_region_draft_valid } from "./peak_review_ui.js";
import { deep_clone } from "../../util/clone.js";
import { escape_html } from "../../util/html.js";
import { result_reporting_summary } from "./result_contract.js";
// QC-01: the critical-event-loss review panel. Kept in its own module so the
// acknowledgement rules stay testable without this file's orchestration.
import { render_qc_critical_review, init_qc_critical_review } from "./qc_review_ui.js";
// UI-01: the same fraction formatter the metadata table/TSV route through
// (js/ui/cell_cycle_columns.js), so the sidebar can never disagree with them
// about whether a number is flagged (SCI-05).
import { format_fraction_cell } from "../../ui/cell_cycle_columns.js";

// CLOCCS metadata-column mapping controls (index.html). Queried once at module
// load, like the rest of the sidebar's DOM refs -- the markup is parsed before
// these deferred module scripts run.
const cloccs_mapping = document.querySelector("#cloccs_mapping");
const cloccs_timepoint_column = document.querySelector("#cloccs_timepoint_column");
const cloccs_strain_column = document.querySelector("#cloccs_strain_column");
import {
  get_modeling_state,
  fit_cell_cycle_model,
  assess_domain_sensitivity,
  assess_resampling_uncertainty,
  peak_detection_requires_review,
  set_model_settings,
  detect_peak_regions,
  update_peak_regions,
  accept_peak_regions,
} from "./modeling_state.js";

let initialized = false;
let busy = false;

const MODEL_LABELS = {
  dean_jett: "Dean–Jett",
  dean_jett_fox: "Dean–Jett–Fox",
  watson_pragmatic: "Watson Pragmatic",
  watson_classic: "Watson Classic",
  cloccs: "CLOCCS (Unverified)",
};

// Joint time-series models fit a whole strain's plotted timepoints together, so
// they take the bulk (Fit All) path, never the single-sample Fit Current path.
const JOINT_SERIES_MODELS = new Set(["cloccs"]);
const SHARED_REGION_MIN_CONFIDENCE = 0.65;

// Config for the live CLOCCS fit: a modest per-start budget with 3 dispersed
// starts, so the sidebar can report multi-start agreement (an identifiability
// signal) without the fit running too long in the browser worker.
const CLOCCS_FIT_CONFIG = Object.freeze({
  starts: 3,
  coordinateRounds: 6,
  biologicalMaxIterations: 200,
  sampleMaxIterations: 100,
});

function model_label(modelId) {
  return MODEL_LABELS[modelId] ?? modelId;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

// Absolute regions are comparable only when the active DNA parameter has the
// same recorded representation and compensation/instrument context. Empty
// FCS amplification and spillover keywords mean the standard linear,
// uncompensated defaults; unlike a missing $PnR, those are usable evidence.
export function dna_axis_calibration(row) {
  const data = row?.data;
  const parameter = data?.parameterMetadata?.DNA_A;
  const metadata = row?.summary?.metadata ?? {};
  const range = Number(parameter?.range ?? data?.pnr?.DNA_A);
  const bits = Number(parameter?.bits);
  const datatype = String(parameter?.datatype ?? "");
  if (!data?.channel_key || !Number.isFinite(range) || range <= 0
      || !Number.isFinite(bits) || bits <= 0 || !datatype) return null;
  return {
    channel: String(data.channel_key),
    parameterName: String(parameter.name ?? ""),
    stain: String(parameter.stain ?? ""),
    range,
    datatype,
    bits,
    amplification: String(parameter.amplification || "0,0"),
    spillover: String(metadata.SPILLOVER ?? metadata.SPILL ?? metadata.COMP ?? "none"),
    instrument: String(metadata.CYT ?? metadata.CYTOMETER ?? metadata.SYS ?? "unspecified"),
  };
}

export function calibration_matches(left, right) {
  return Boolean(left && right && Object.keys(left).every((key) => left[key] === right[key]));
}

export function detection_can_share(detection) {
  return detection?.status === "detected"
    && Number.isFinite(detection.confidence)
    && detection.confidence >= SHARED_REGION_MIN_CONFIDENCE;
}

// SCI-06. A median is only a consensus when the things being averaged mean the
// SAME thing. Peak detection picks the two most prominent peaks, and which
// physical peaks those are can change across a sample set: in a synchronized
// time course the 1C peak depletes as cells progress, so late timepoints get
// (2C, 4C) proposed where early ones got (1C, 2C). Each proposal is
// individually "detected" with good confidence; they simply disagree about
// which peak is G1.
//
// Measured on an alpha-factor release (strain 1468o, 24 timepoints): 15
// proposals passed the detected + confidence >= 0.65 filter and split into two
// clusters with G1 centres near 192 and 341 -- a 1.77x ratio. Their median,
// 306, matches NEITHER cluster, so sharing it would have put every sample's G1
// region in the wrong place: worse than not sharing at all.
//
// So a set whose G1 proposals are not mutually consistent is refused rather
// than averaged. The near-2x signature is called out by name because it is the
// specific, recurring failure -- but any split wider than the tolerance is
// rejected, since an unexplained bimodal set is not a consensus either.
const SHARED_CENTER_TOLERANCE = 0.25; // relative deviation from the median allowed
const DOUBLING_RATIO_RANGE = [1.6, 2.4];
// A lone disagreeing proposal is an OUTLIER, and the median is chosen precisely
// to resist one of those. A disagreement is only a genuine split -- two
// populations of proposals meaning different things -- when enough of the set
// sits away from the median. Both a minimum count and a minimum share are
// required so neither a single stray nor a tiny fraction of a large set trips it.
const SPLIT_MINIMUM_COUNT = 2;
const SPLIT_MINIMUM_SHARE = 0.25;

/*

Purpose:
	Whether a set of peak-region proposals actually agrees about which peak is
	G1, so a median across them is meaningful.

Input:
	entries [array]: [{ regions, calibration }] candidate proposals

Output:
	verdict [object]: { consistent, ratio, low, high, reason } -- ratio is the
	                  widest G1-centre ratio in the set

*/
export function shared_regions_consistent(entries) {
  const centers = entries
    .map(({ regions, calibration }) => (regions.g1.left + regions.g1.right) / (2 * calibration.range))
    .filter((value) => Number.isFinite(value) && value > 0)
    .sort((a, b) => a - b);
  if (centers.length < 2) return { consistent: true, ratio: 1, low: null, high: null, dissenters: 0, reason: null };

  const middle = median(centers);
  const deviates = (value) => Math.max(value / middle, middle / value) > 1 + SHARED_CENTER_TOLERANCE;
  const dissenters = centers.filter(deviates);
  const low = centers[0];
  const high = centers[centers.length - 1];
  const ratio = high / low;

  // Not a split: either everything agrees, or one stray proposal the median
  // already resists.
  if (dissenters.length < SPLIT_MINIMUM_COUNT
      || dissenters.length / centers.length < SPLIT_MINIMUM_SHARE) {
    return { consistent: true, ratio, low, high, dissenters: dissenters.length, reason: null };
  }

  const doubled = ratio >= DOUBLING_RATIO_RANGE[0] && ratio <= DOUBLING_RATIO_RANGE[1];
  return {
    consistent: false,
    ratio,
    low,
    high,
    dissenters: dissenters.length,
    reason: doubled
      ? `the proposals disagree about which peak is G1 — their G1 centres differ by ${ratio.toFixed(2)}x, `
        + "the signature of some samples having (1C, 2C) detected and others (2C, 4C). "
        + "Averaging them would place G1 between the two and match neither."
      : `${dissenters.length} of ${centers.length} proposed G1 centres sit more than `
        + `${Math.round(100 * SHARED_CENTER_TOLERANCE)}% from the median (widest ratio ${ratio.toFixed(2)}x), `
        + "so there is no single consensus region to share.",
  };
}

// Median normalized centers/widths keep one atypical proposal from dragging
// the consensus. Calibration matching currently implies a common range, but
// normalization keeps the estimator correct if compatible scaling is widened.
//
// Returns null when the set is not mutually consistent (see
// shared_regions_consistent): a median over disagreeing proposals is not a
// robust estimate, it is a wrong one.
export function robust_shared_regions(entries) {
  if (entries.length && !shared_regions_consistent(entries).consistent) return null;
  return robust_shared_regions_unchecked(entries);
}

function robust_shared_regions_unchecked(entries) {
  if (!entries.length) return null;
  const normalized = entries.map(({ regions, calibration }) => ({
    g1Center: (regions.g1.left + regions.g1.right) / (2 * calibration.range),
    g1Width: (regions.g1.right - regions.g1.left) / calibration.range,
    g2Center: (regions.g2.left + regions.g2.right) / (2 * calibration.range),
    g2Width: (regions.g2.right - regions.g2.left) / calibration.range,
  }));
  const range = entries[0].calibration.range;
  const center = (key) => median(normalized.map((entry) => entry[key]));
  const g1Center = center("g1Center") * range;
  const g1Width = center("g1Width") * range;
  const g2Center = center("g2Center") * range;
  const g2Width = center("g2Width") * range;
  return {
    g1: { left: g1Center - g1Width / 2, right: g1Center + g1Width / 2 },
    g2: { left: g2Center - g2Width / 2, right: g2Center + g2Width / 2 },
  };
}

const QC_PRODUCT = {
  structural: "structuralQC",
  time: "timeQC",
  scatter: "scatterGate",
  singlet: "singletResult",
};

export function approve_degraded_qc(rows, confirm = (message) => window.confirm(message)) {
  const unavailable = [];
  for (const row of rows) {
    const state = get_state(row.name);
    for (const stage of state?.requiredQc ?? []) {
      const product = state?.[QC_PRODUCT[stage]];
      if ((!product || product.failed || product.skipped || product.cancelled || product.reviewRequired)
          && !state?.qcWaivers?.[stage]?.reason) {
        unavailable.push({ row, state, stage, reason: product?.reason ?? product?.message ?? product?.status ?? "not available" });
      }
    }
  }
  if (!unavailable.length) return true;
  const summary = unavailable.map(({ row, stage, reason }) => `${row.name}: ${stage} (${reason})`).join("\n");
  if (!confirm(`Required QC is unavailable:\n\n${summary}\n\nDisable these stages and continue with a degraded analysis?`)) return false;
  const approvedAt = new Date().toISOString();
  unavailable.forEach(({ state, stage, reason }) => {
    state.qcWaivers ??= {};
    state.qcWaivers[stage] = { reason: `User disabled unavailable ${stage} QC: ${reason}`, approvedAt };
  });
  return true;
}

function degraded_qc_names(rows) {
  return rows.filter((row) => Object.keys(get_state(row.name)?.qcWaivers ?? {}).length).map((row) => row.name);
}

// A bulk fit is inherently multi-sample review, so switch the plot to the ridge
// view (stacked small-multiples) automatically once it runs.
function switch_to_ridge_view() {
  set_plot_view_mode("ridge");
  if (plot_view_mode_select) plot_view_mode_select.value = "ridge";
}

// The dropdown opens on a "Model Selection…" placeholder (value "") so the
// choice of model is always deliberate -- picking one is a scientific decision,
// not something to inherit from whatever happened to be first in the list.
// Empty means "nothing chosen yet", which disables both Fit buttons.
function selected_model_id() {
  return cell_cycle_model_select?.value || "";
}

function has_model_selected() {
  return Boolean(selected_model_id());
}

// AD-2/SCI-05: #cell_cycle_fit_status (role="status", immediately above
// #cell_cycle_fit_result in the DOM) and #cell_cycle_fit_result
// (role="status" aria-live="polite") both live-announce. At the one call site
// where a single fit event updates both for the same outcome
// (on_fit_current_click), that is a duplicate announcement of the same event
// to assistive tech -- annoying, not just redundant, since AT reads both in
// full. `announce: false` suppresses just this element's announcement for
// that update (the text/visual state still change normally, and the *next*
// independent update to this element -- e.g. "Bin count changed" -- announces
// as usual) by removing the role immediately before the mutation and
// restoring it on a later task, after the mutation has already happened with
// no live region present to announce it.
function set_fit_status(message, isError = false, { announce = true } = {}) {
  if (!cell_cycle_fit_status) return;
  const previousRole = cell_cycle_fit_status.getAttribute("role");
  if (!announce && previousRole) cell_cycle_fit_status.removeAttribute("role");
  cell_cycle_fit_status.textContent = message || "";
  cell_cycle_fit_status.hidden = !message;
  cell_cycle_fit_status.classList.toggle("cell_cycle_fit_not_converged", Boolean(isError));
  if (!announce && previousRole) {
    window.setTimeout(() => cell_cycle_fit_status.setAttribute("role", previousRole), 0);
  }
}

function set_controls_disabled(disabled) {
  if (cell_cycle_model_select) cell_cycle_model_select.disabled = disabled;
  if (cell_cycle_fit_current_button) cell_cycle_fit_current_button.disabled = disabled;
  if (cell_cycle_fit_all_button) cell_cycle_fit_all_button.disabled = disabled;
  if (cell_cycle_domain_sensitivity_button) cell_cycle_domain_sensitivity_button.disabled = disabled;
  if (cell_cycle_resampling_button) cell_cycle_resampling_button.disabled = disabled;
}

// DOMAIN-01: mirrors set_fit_status() above, but for the "Check domain
// sensitivity" action's own status line -- kept separate rather than sharing
// #cell_cycle_fit_status so running a sensitivity check never overwrites (or
// gets overwritten by) the most recent fit's own convergence message.
function set_domain_sensitivity_status(message, isError = false) {
  if (!cell_cycle_domain_sensitivity_status) return;
  cell_cycle_domain_sensitivity_status.textContent = message || "";
  cell_cycle_domain_sensitivity_status.hidden = !message;
  cell_cycle_domain_sensitivity_status.classList.toggle("cell_cycle_fit_not_converged", Boolean(isError));
}

// UNC-01: mirrors set_domain_sensitivity_status() above, for the "Check
// resampling uncertainty" action's own status line.
function set_resampling_status(message, isError = false) {
  if (!cell_cycle_resampling_status) return;
  cell_cycle_resampling_status.textContent = message || "";
  cell_cycle_resampling_status.hidden = !message;
  cell_cycle_resampling_status.classList.toggle("cell_cycle_fit_not_converged", Boolean(isError));
}

// AD-2/UI-01: wraps format_fraction_cell()'s trailing " ⚠" (already the exact
// text every other fraction-printing surface emits) in .cc_value_flag so the
// sidebar's glyph gets the same non-colour, non-text-only affordance as the
// metadata table -- the glyph itself stays in the text format_fraction_cell()
// returns (SCI-05: identical text everywhere, incl. copy/paste), this only
// adds a wrapping element where the surface renders markup.
function render_fraction_value(result, fraction) {
  const cell = format_fraction_cell(result, fraction);
  return cell.endsWith(" ⚠") ? `${cell.slice(0, -2)}<span class="cc_value_flag">⚠</span>` : cell;
}

function render_result(result) {
  if (!cell_cycle_fit_result) return;
  if (!result) {
    cell_cycle_fit_result.hidden = true;
    cell_cycle_fit_result.innerHTML = "";
    return;
  }

  const warnings = result.warnings ?? [];
  const reporting = result_reporting_summary(result);
  const convergenceText = result.converged ? "Converged" : `Not converged (${escape_html(result.convergenceReason ?? "unknown")})`;
  // AD-2 (UI-01/SCI-03): the qualifier text is sized/weighted to match or
  // exceed the phase-percentage text (.cc_qualifier, 0.78rem/600 == the
  // fraction row's size) rather than the old 0.72rem/muted treatment, and
  // never emits the legacy .cell_cycle_fit_not_converged /
  // .cell_cycle_fit_has_warnings modifier classes on these elements: those are
  // compound selectors (0,2,0) that would silently outrank the new single-class
  // .cc_qualifier--warn/--fail (0,1,0) regardless of source order. "Not
  // reportable" (no usable number at all -- cancelled, legacy, non-finite) is
  // the fail state; "reportable but not converged" (still shown, per the
  // FlowJo-style philosophy in result_contract.js) is the warn state.
  const convergenceQualifier = !reporting.reportable
    ? "cc_qualifier cc_qualifier--fail"
    : result.converged === false
      ? "cc_qualifier cc_qualifier--warn"
      : "cc_qualifier";
  // Retained for any result that still carries a model comparison (older saved
  // sessions); the auto_dj_djf policy that produced them has been retired.
  const selectedNote = result.modelComparison
    ? `<p class="cell_cycle_fit_selected_model">${result.modelComparison.selectedModelId ? `Selected: ${escape_html(model_label(result.modelComparison.selectedModelId))}` : "No valid automatic model"}</p>`
    : "";
  const warningList = warnings.length
    ? `<ul class="cell_cycle_fit_warning_list">${warnings.map((warning) => `<li>${escape_html(warning.message)}</li>`).join("")}</ul>`
    : "";
  const fractions = reporting.reportable
    ? `<dl class="cell_cycle_fit_fractions">
        <div class="cell_cycle_fit_fraction_row"><dt>G1</dt><dd>${render_fraction_value(result, reporting.phaseFractions?.g1)}</dd></div>
        <div class="cell_cycle_fit_fraction_row"><dt>S</dt><dd>${render_fraction_value(result, reporting.phaseFractions?.s)}</dd></div>
        <div class="cell_cycle_fit_fraction_row"><dt>G2/M</dt><dd>${render_fraction_value(result, reporting.phaseFractions?.g2)}</dd></div>
      </dl>`
    : `<p class="cc_qualifier cc_qualifier--fail">No phase fractions: the fit did not produce a usable result${result.cancelled ? " (cancelled)" : ""}.</p>`;
  // Goodness of fit (reduced deviance, the chi-square analogue). ~1 is a good
  // fit; well above 1 means the model does not fully explain the counts. Shown
  // so the user -- not the tool -- judges whether to trust the fractions.
  // AD-2: moved out of a title="" tooltip (keyboard/touch-unreachable) into a
  // visible, focusable <details>/<summary> disclosure -- the summary carries
  // the qualifier treatment and base.css's :where(...,[tabindex]):focus-visible
  // ring needs the explicit tabindex="0" since <summary> isn't in that
  // selector's tag list.
  const gof = result.goodnessOfFit;
  const gofPoor = Number.isFinite(gof) && gof > 2;
  const goodnessQualifier = gofPoor ? "cc_qualifier cc_qualifier--warn" : "cc_qualifier";
  const goodnessBlock = Number.isFinite(gof)
    ? `<details class="cell_cycle_fit_goodness_disclosure">
        <summary class="cc_goodness_detail ${goodnessQualifier}" tabindex="0">Fit quality: ${gof.toFixed(2)}${gofPoor ? " (poor)" : ""}</summary>
        <p class="cc_goodness_detail_body">Reduced deviance (chi-square analogue): ~1 is a good fit, well above 1 means the model does not fully explain the counts.</p>
      </details>`
    : "";
  const warningsQualifier = warnings.length ? "cc_qualifier cc_qualifier--warn" : "cc_qualifier";

  cell_cycle_fit_result.hidden = false;
  cell_cycle_fit_result.innerHTML = `
    <h3 class="visually_hidden">Cell-cycle fit result</h3>
    <div class="cell_cycle_fit_result_header">
      <span>${escape_html(result.modelLabel ?? model_label(result.modelId))}</span>
    </div>
    <p class="cell_cycle_fit_convergence ${convergenceQualifier}">${convergenceText}</p>
    ${goodnessBlock}
    ${fractions}
    ${selectedNote}
    <p class="cell_cycle_fit_warnings ${warningsQualifier}">${
      warnings.length ? `${warnings.length} warning${warnings.length === 1 ? "" : "s"}` : "No warnings."
    }</p>
    ${warningList}
  `;
}

function refresh_panel() {
  const row = active_peak_review_row();
  // QC-01: a critical event loss blocks the fit, so the review that unblocks it
  // belongs on every refresh -- not only after a failed fit attempt. Showing it
  // before the user clicks Fit is the difference between an explained
  // precondition and an unexplained refusal.
  render_qc_critical_review(row);
  // Fit All is a bulk auto-fit over every plotted sample (auto-detect + average
  // + fit), so it's enabled whenever anything is plotted -- even with several
  // samples checked and none singled out as the active review row. The model
  // dropdown is likewise enabled whenever there's something to fit.
  const plotted_count = plottable_rows().length;
  const has_plotted = plotted_count > 0;
  const model_chosen = has_model_selected();
  const draft_valid = peak_region_draft_valid();
  if (cell_cycle_fit_all_button) cell_cycle_fit_all_button.disabled = !has_plotted || !model_chosen || !draft_valid;
  if (cell_cycle_model_select) cell_cycle_model_select.disabled = !has_plotted;
  sync_cloccs_mapping_visibility();
  // "Apply to All" needs the active sample's regions and at least one other
  // plotted sample to copy them to.
  if (peak_regions_apply_all_button) {
    const active_regions = row && get_modeling_state(row).peakSelection.regions;
    peak_regions_apply_all_button.disabled = !active_regions || plotted_count <= 1 || !draft_valid;
  }

  if (!row) {
    if (cell_cycle_fit_current_button) cell_cycle_fit_current_button.disabled = true;
    if (cell_cycle_domain_sensitivity_button) cell_cycle_domain_sensitivity_button.hidden = true;
    if (cell_cycle_resampling_button) cell_cycle_resampling_button.hidden = true;
    render_result(null);
    return;
  }

  const modeling = get_modeling_state(row);
  // fit_cell_cycle_model() itself validates the histogram/regions preconditions
  // with a clear error message on click; the button only needs to reflect the
  // preconditions visible from here: accepted regions exist and aren't stale.
  // Stale regions (a bin-count change since detection, see bin_settings_sync.js)
  // would fit against a histogram that no longer matches the plot, so require a
  // re-detect first -- the Identify Peaks panel prompts for it.
  if (cell_cycle_fit_current_button) {
    cell_cycle_fit_current_button.disabled =
      !model_chosen || !modeling.peakSelection.regions || modeling.peakSelection.stale || !draft_valid;
  }
  if (modeling.peakSelection.regions && modeling.peakSelection.stale) {
    set_fit_status("Bin count changed — re-detect peaks before fitting.", true);
  } else if (cell_cycle_fit_status && cell_cycle_fit_status.textContent.startsWith("Bin count changed")) {
    set_fit_status("");
  }

  // Adopt the sample's stored model only once something has actually been fit
  // with it, so an unfitted sample keeps the "Model Selection…" placeholder
  // rather than adopting a model the user never picked.
  if (cell_cycle_model_select && modeling.activeResultKey
      && cell_cycle_model_select.value !== modeling.settings.modelId) {
    cell_cycle_model_select.value = modeling.settings.modelId;
  }

  const activeResult = get_active_model_result(get_state(row.name));
  render_result(activeResult);
  // DOMAIN-01: only offered once there is a reportable result to check --
  // the same result render_result() just displayed. assess_domain_sensitivity()
  // requires a contracted fit result, so there is nothing for the action to do
  // before that exists. Also clears the disabled state set_controls_disabled(true)
  // leaves behind after any other sidebar action finishes -- unlike the other
  // controls above, this button has no extra precondition once a result exists,
  // so "visible" and "enabled" are the same condition here.
  if (cell_cycle_domain_sensitivity_button) {
    cell_cycle_domain_sensitivity_button.hidden = !activeResult;
    cell_cycle_domain_sensitivity_button.disabled = !activeResult;
  }
  // UNC-01: same "visible" == "enabled" condition as domain sensitivity above,
  // plus excluding joint-series models (CLOCCS): resampleUncertainty()'s fitFn
  // calls a model's per-sample fit({histogram, peakRegions, config}), which a
  // joint_series model does not implement (it fits a whole strain's timepoints
  // via fitSeries() instead), so offering the check on one would only produce
  // a guaranteed error.
  if (cell_cycle_resampling_button) {
    const resamplable = Boolean(activeResult) && get_model(activeResult.modelId)?.fitScope === "per_sample";
    cell_cycle_resampling_button.hidden = !resamplable;
    cell_cycle_resampling_button.disabled = !resamplable;
  }
}

async function on_fit_current_click() {
  if (busy) return;
  if (!peak_region_draft_valid()) return set_fit_status("Fix the invalid peak-region values before fitting.", true);
  const row = active_peak_review_row();
  if (!row) return;
  const modelId = selected_model_id();
  if (!modelId) {
    set_fit_status("Choose a model first.", true);
    return;
  }
  if (JOINT_SERIES_MODELS.has(modelId)) {
    set_fit_status(
      `${model_label(modelId)} is a joint time-series model — it fits all plotted timepoints together. Use "Fit All Samples".`,
      true,
    );
    return;
  }
  if (!approve_degraded_qc([row])) {
    set_fit_status("Fit cancelled; required QC remains unavailable.", true);
    return;
  }

  busy = true;
  set_controls_disabled(true);
  const progress_operation = show_progress(`Fitting ${model_label(modelId)}`);
  try {
    const result = await fit_cell_cycle_model(row, modelId);
    render_result(result);
    // announce: false -- #cell_cycle_fit_result just announced this same fit
    // outcome (role="status" aria-live="polite" via render_result() above); a
    // second role="status" region reporting the identical event would be a
    // duplicate announcement, not new information.
    set_fit_status(
      `${model_label(modelId)} fit for ${row.name}: ${result.converged ? "converged" : "did not converge"}.`,
      !result.converged,
      { announce: false },
    );
    set_status_bar(`Cell-cycle model fit for ${row.name}${degraded_qc_names([row]).length ? " with an approved QC waiver" : ""}.`, false, null, progress_operation);
  } catch (error) {
    set_fit_status(error.message, true);
    set_status_bar(`Model fit failed: ${error.message}`, true, null, progress_operation, error);
  } finally {
    hide_progress(300, progress_operation);
    busy = false;
    refresh_panel();
    render_density_plot();
    document.dispatchEvent(new CustomEvent("cell-cycle-fit-changed"));
  }
}

// DOMAIN-01: the opt-in caller for assess_domain_sensitivity() (modeling_state.js).
// Deliberately a separate, explicit action rather than anything Fit Current/Fit
// All trigger themselves -- the sweep re-fits the sample per bin count x domain
// perturbation (~12 fits by default), so folding it into the hot fit path would
// multiply every interactive fit's latency by roughly that factor. This runs
// only when the user asks for it, against the result already on screen.
async function on_check_domain_sensitivity_click() {
  if (busy) return;
  const row = active_peak_review_row();
  if (!row) return;
  const state = get_state(row.name);
  const result = get_active_model_result(state);
  if (!result) {
    // The button is hidden whenever there's no active result to check (see
    // refresh_panel()); this is only reachable if the result was invalidated
    // between the click and this handler running.
    set_domain_sensitivity_status("No current fit result to check — fit this sample first.", true);
    return;
  }

  busy = true;
  set_controls_disabled(true);
  const progress_operation = show_progress(`Checking domain sensitivity for ${row.name}`);
  try {
    const updated = await assess_domain_sensitivity(row, result);
    // Render the mutated result directly rather than re-reading
    // get_active_model_result(): an "invalid" verdict demotes activeResultKey
    // (see assess_domain_sensitivity()'s header), and the demoted result --
    // now failing validForReporting -- is exactly the thing this action needs
    // to surface, the same way a blocking domainCoverageAudit() already does
    // on a fresh fit.
    render_result(updated);
    const verdict = updated.domainSensitivity?.status ?? "unknown";
    const verdictNote = verdict === "invalid"
      ? " — result is no longer valid for reporting."
      : verdict === "warning"
        ? " — see the warnings below."
        : "";
    set_domain_sensitivity_status(`Domain sensitivity: ${verdict}${verdictNote}`, verdict !== "ok");
    set_status_bar(`Domain sensitivity checked for ${row.name}: ${verdict}.`, verdict === "invalid", null, progress_operation);
  } catch (error) {
    set_domain_sensitivity_status(error.message, true);
    set_status_bar(`Domain sensitivity check failed: ${error.message}`, true, null, progress_operation, error);
  } finally {
    hide_progress(300, progress_operation);
    busy = false;
    refresh_panel();
  }
}

// Runs `worker(item, index)` over `items` with at most `limit` in flight at
// once, so a bulk fit dispatches up to pool-size fits to the worker pool in
// parallel (each independent sample lands on a different worker) instead of one
// at a time. `limit` runner loops each pull the next item when they finish,
// giving dynamic balancing when fits take different amounts of time.
async function run_with_limit(items, limit, worker) {
  let next = 0;
  const runner = async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      await worker(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, runner));
}

// UI-02: a term is only worth a reader's attention when it actually happened
// -- "0 cancelled" next to "3 converged" reads as if cancellation were part of
// THIS run's story when nothing was ever cancelled. Zero-valued terms are
// dropped from the sentence entirely rather than printed as "0 <label>".
export function summarize_bulk_fit_outcomes(outcomes) {
  const values = [...outcomes.values()];
  const count = (status) => values.filter((outcome) => outcome.status === status).length;
  const converged = count("converged_reportable");
  const nonconverged = count("computed_nonconverged");
  const detectionFailed = count("detection_failed");
  const fitFailed = count("fit_failed");
  const cancelled = count("cancelled");
  const skipped = count("skipped");
  const failed = nonconverged + detectionFailed + fitFailed;
  const terms = [
    [converged, "converged/reportable"],
    [nonconverged, "computed but did not converge"],
    [detectionFailed, "detection failed"],
    [fitFailed, "fit failed"],
    [cancelled, "cancelled"],
    [skipped, "skipped"],
  ];
  const message = terms.filter(([term_count]) => term_count > 0)
    .map(([term_count, label]) => `${term_count} ${label}`)
    .join("; ") || "0 attempted";
  return {
    attempted: values.length,
    success: converged,
    failed,
    skipped,
    cancelled,
    message,
  };
}

// UI-02: the two phases below (peak detection, then model fitting) both check
// the SAME AbortController -- wired only to the Cancel button
// (show_progress_cancel) below, so "cancelled" here always means the user hit
// Cancel -- but a single shared string for both would hide which phase a
// bulk fit actually got through before the user stopped it, information the
// per-row detail line (built from `outcome.reason`) exists to carry.
const CANCEL_REASON_DETECTION = "User cancelled bulk fitting during peak detection";
const CANCEL_REASON_FITTING = "User cancelled bulk fitting during model fitting";

// Bulk auto-fit across every plotted sample. Trustworthy detections with proven
// matching DNA calibration receive a robust shared proposal; every excluded or
// incompatible sample keeps its own detected regions and is fit independently.
async function on_fit_all_click() {
  if (busy) return;
  if (!peak_region_draft_valid()) return set_fit_status("Fix the invalid peak-region values before fitting.", true);
  const modelId = selected_model_id();
  if (!modelId) {
    set_fit_status("Choose a model first.", true);
    return;
  }
  const rows = plottable_rows();
  if (!rows.length) {
    set_status_bar("Plot at least one sample before fitting.", true);
    return;
  }
  if (!approve_degraded_qc(rows)) {
    set_status_bar("Bulk fit cancelled; required QC remains unavailable.", true);
    return;
  }

  // Joint time-series models (CLOCCS) fit every plotted timepoint together
  // rather than averaging per-sample regions -- route them to their own path.
  if (JOINT_SERIES_MODELS.has(modelId)) {
    await run_cloccs_joint_fit(rows);
    return;
  }

  busy = true;
  set_controls_disabled(true);
  const progress_operation = show_progress(`Auto-fitting ${model_label(modelId)}`);
  const controller = new AbortController();
  show_progress_cancel(() => controller.abort());
  const outcomes = new Map(rows.map((row) => [row.name, { sample: row.name, status: "pending", reason: "Not attempted" }]));
  const finish = (row, status, reason, code = status) => {
    const current = outcomes.get(row.name);
    if (current?.status !== "pending") return current;
    const outcome = { sample: row.name, status, code, reason };
    outcomes.set(row.name, outcome);
    const modeling = get_modeling_state(row);
    modeling.lastBulkFitOutcome = outcome;
    if (["detection_failed", "fit_failed"].includes(status) && !modeling.lastFitError) {
      modeling.lastFitError = { code, message: reason };
    }
    return outcome;
  };
  try {
    const pipeline = await load_pipeline();
    const range = clamp_range_to_analysis_domain(pipeline.shared_histogram_range(rows));
    const binCount = plot_bin_count();

    // Phase 1: auto-detect regions and collect calibration evidence.
    const proposals = [];
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      if (controller.signal.aborted) break;
      get_modeling_state(row).lastFitError = null;
      update_progress((45 * index) / rows.length, "Auto-detecting peaks", row.name, "", progress_operation);
      try {
        pipeline.ensure_histogram_current(row, { binCount, range });
        detect_peak_regions(row);
        const modeling = get_modeling_state(row);
        const regions = modeling.peakSelection.regions;
        if (regions?.g1 && regions?.g2) {
          proposals.push({
            row,
            regions,
            detection: modeling.peakDetection,
            calibration: dna_axis_calibration(row),
          });
        } else {
          finish(row, "detection_failed", "Peak detection did not produce usable G1/G2 regions", "no_peak_regions");
        }
      } catch (error) {
        const stored = {
          code: error?.code ?? "bulk_fit_failed",
          message: error?.message ?? String(error),
        };
        get_modeling_state(row).lastFitError = stored;
        finish(row, "detection_failed", stored.message, stored.code);
      }
    }
    if (controller.signal.aborted) {
      rows.forEach((row) => finish(row, "cancelled", CANCEL_REASON_DETECTION, "fit_cancelled"));
      const summary = summarize_bulk_fit_outcomes(outcomes);
      set_fit_status(`Auto-fit cancelled: ${summary.message}.`, true);
      set_status_bar(`Auto-fit cancelled: ${summary.message}.`, "warning", null, progress_operation);
      return;
    }
    if (!proposals.length) {
      const summary = summarize_bulk_fit_outcomes(outcomes);
      set_fit_status(`Auto-fit outcomes: ${summary.message}.`, true);
      set_status_bar(`Could not detect peaks on any plotted sample: ${summary.message}.`, true, null, progress_operation);
      return;
    }

    const trustworthy = proposals.filter((entry) =>
      !peak_detection_requires_review(entry.detection, entry.regions).required
      && detection_can_share(entry.detection) && entry.calibration);
    const reference = trustworthy[0]?.calibration ?? null;
    const included = trustworthy.filter((entry) => calibration_matches(reference, entry.calibration));
    const consistency = included.length >= 2
      ? shared_regions_consistent(included)
      : { consistent: true, reason: null };
    const shared = included.length >= 2 ? robust_shared_regions(included) : null;
    const ordered = shared && shared.g1.left < shared.g1.right
      && shared.g1.right <= shared.g2.left && shared.g2.left < shared.g2.right;
    const useShared = Boolean(ordered);
    const includedNames = useShared ? included.map((entry) => entry.row.name) : [];
    const includedSet = new Set(includedNames);
    const excludedNames = proposals.filter((entry) => !includedSet.has(entry.row.name)).map((entry) => entry.row.name);
    const proposalText = useShared
      ? `Shared median proposal: G1 ${shared.g1.left.toFixed(0)}–${shared.g1.right.toFixed(0)}, G2 ${shared.g2.left.toFixed(0)}–${shared.g2.right.toFixed(0)}.`
      : consistency.consistent
        ? "No safe shared proposal; every sample will use its own detected regions."
        : `No shared proposal — ${consistency.reason} Every sample will use its own detected regions; `
          + "review the peak assignments before trusting a comparison across these samples.";
    if (!window.confirm(
      `${proposalText}\n\nIncluded in shared estimate (${includedNames.length}): ${includedNames.join(", ") || "none"}` +
      `\nExcluded / independently fit (${excludedNames.length}): ${excludedNames.join(", ") || "none"}` +
      "\n\nContinue with these reviewed assignments?",
    )) {
      proposals.forEach(({ row }) => finish(row, "cancelled", "User cancelled after reviewing region assignments"));
      const summary = summarize_bulk_fit_outcomes(outcomes);
      set_fit_status(`Auto-fit outcomes: ${summary.message}.`, true);
      set_status_bar(`Auto-fit cancelled: ${summary.message}.`, "warning", null, progress_operation);
      return;
    }

    // Phase 2a: apply the shared proposal to included samples and accept every
    // sample's regions (synchronous state setup). Others retain their own
    // proposal, so incompatible axes and weak detections are never silently
    // forced onto another sample's absolute boundaries.
    const fit_list = [];
    for (const { row } of proposals) {
      try {
        const isShared = includedSet.has(row.name);
        if (isShared) {
          update_peak_regions(row, {
            g1: { left: shared.g1.left, right: shared.g1.right },
            g2: { left: shared.g2.left, right: shared.g2.right },
          }, { source: "shared-median", minimumGap: -0.01 });
        }
        // Bulk fitting is fully automated -- there is no reviewer to defer
        // to, so every proposal gets accepted regardless of detection
        // confidence. A low-confidence detection (ambiguous/inferred/
        // fallback-width) still surfaces as a warning on its own result via
        // model_preflight()/apply_result_contract() (see AMBIG-01/D9)
        // instead of silently blocking the fit.
        accept_peak_regions(row);
        fit_list.push({ row, isShared });
      } catch (error) {
        const stored = {
          code: error?.code ?? "bulk_fit_failed",
          message: error?.message ?? String(error),
        };
        get_modeling_state(row).lastFitError = stored;
        finish(row, "fit_failed", stored.message, stored.code);
      }
    }

    // Phase 2b: fit the prepared samples across the worker pool in parallel.
    let completed = 0;
    await run_with_limit(fit_list, fit_pool_size(), async ({ row, isShared }) => {
      if (controller.signal.aborted) {
        finish(row, "cancelled", CANCEL_REASON_FITTING, "fit_cancelled");
        return;
      }
      try {
        const result = await fit_cell_cycle_model(row, modelId, { signal: controller.signal });
        result.bulkRegionProvenance = {
          mode: isShared ? "shared_median_normalized" : "independent",
          includedSamples: includedNames,
          excludedSamples: excludedNames,
          calibrationEvidence: dna_axis_calibration(row),
          sharedRegions: isShared ? deep_clone(shared) : null,
          minimumDetectionConfidence: SHARED_REGION_MIN_CONFIDENCE,
        };
        if (result?.cancelled) finish(row, "cancelled", result.convergenceReason || "Fit cancelled", "fit_cancelled");
        else if (result?.errorCode === "no_valid_model" || result?.computed === false) {
          finish(row, "fit_failed", result?.convergenceReason || result?.message || "No valid model result", result?.errorCode || "no_valid_model");
        } else if (result?.validForReporting === false) {
          const reason = result.validityReasons?.map((entry) => entry.message || entry.code).join("; ") || "Result is not valid for reporting";
          finish(row, "fit_failed", reason, "invalid_for_reporting");
        } else if (result?.converged) finish(row, "converged_reportable", result.convergenceReason || "Converged");
        else finish(row, "computed_nonconverged", result?.convergenceReason || "Computed result did not converge", "nonconverged");
      } catch (error) {
        const stored = {
          code: error?.code ?? "bulk_fit_failed",
          message: error?.message ?? String(error),
        };
        get_modeling_state(row).lastFitError = stored;
        finish(row, "fit_failed", stored.message, stored.code);
      } finally {
        completed += 1;
        update_progress(45 + (55 * completed) / Math.max(1, fit_list.length), `Fitting ${model_label(modelId)}`, row.name, "", progress_operation);
      }
    });
    outcomes.forEach((outcome, name) => {
      if (outcome.status === "pending") {
        const row = rows.find((candidate) => candidate.name === name);
        finish(row, controller.signal.aborted ? "cancelled" : "skipped",
          controller.signal.aborted ? CANCEL_REASON_FITTING : "Sample did not reach the fit stage");
      }
    });
    if (rows.length > 1) switch_to_ridge_view();
    const degraded = degraded_qc_names(rows);
    const summary = summarize_bulk_fit_outcomes(outcomes);
    const details = [...outcomes.values()]
      .filter((outcome) => outcome.status !== "converged_reportable")
      .map((outcome) => `${outcome.sample}: ${outcome.reason}`)
      .join(" | ");
    set_fit_status(`Auto-fit outcomes: ${summary.message}.${details ? ` ${details}` : ""}`, summary.failed > 0 || summary.cancelled > 0);
    set_status_bar(
      `Auto-fit ${summary.message}; ` +
        `${includedNames.length} shared a robust region proposal, ${excludedNames.length} fit independently` +
        `${degraded.length ? `; degraded QC: ${degraded.join(", ")}` : ""}.`,
      summary.success === 0, null, progress_operation,
    );
    if (summary.success + summary.failed + summary.skipped + summary.cancelled !== summary.attempted) {
      throw new Error("Bulk-fit outcome accounting invariant failed");
    }
  } catch (error) {
    outcomes.forEach((outcome, name) => {
      if (outcome.status === "pending") {
        const row = rows.find((candidate) => candidate.name === name);
        finish(row, "skipped", `Cohort operation failed before this sample completed: ${error.message}`, "cohort_failed");
      }
    });
    const summary = summarize_bulk_fit_outcomes(outcomes);
    set_fit_status(`Auto-fit failed unexpectedly: ${error.message}. Outcomes: ${summary.message}.`, true);
    set_status_bar(`Auto-fit failed unexpectedly: ${error.message}. Outcomes: ${summary.message}.`, true, null, progress_operation, error);
  } finally {
    hide_progress(300, progress_operation);
    busy = false;
    refresh_panel();
    render_density_plot();
    document.dispatchEvent(new CustomEvent("cell-cycle-fit-changed"));
  }
}

// Timepoint for a plotted sample in the CLOCCS series: the first number in its
// name (e.g. "release_T30" -> 30), else its plot order. If parsed times aren't
// all distinct, fall back to plot order for every sample so no two timepoints
// collide.
function derive_cloccs_timepoints(rows) {
  const parsed = rows.map((row) => {
    const match = String(row.name).match(/-?\d+(\.\d+)?/);
    return match ? Number(match[0]) : null;
  });
  const allParsed = parsed.every((value) => Number.isFinite(value));
  const distinct = new Set(parsed).size === parsed.length;
  if (allParsed && distinct) return parsed;
  return rows.map((_, index) => index);
}

// A per-sample fluorescence initialization (alpha1 = 1C, alpha2 = 2C-1C, tau)
// for CLOCCS. Prefers the reviewed G1/G2 peak regions when present; otherwise
// estimates the 1C peak from the histogram's dominant low-DNA bin and assumes
// 2C = 2*1C. This is the CLOCCS analogue of the spec's DJF-based initializer.
function estimate_cloccs_fluorescence_init(row, histogram) {
  const regions = get_modeling_state(row)?.peakSelection?.regions;
  const binWidth = histogram.binWidth || 1;
  if (regions?.g1 && regions?.g2) {
    const alpha1 = 0.5 * (regions.g1.left + regions.g1.right);
    const g2Center = 0.5 * (regions.g2.left + regions.g2.right);
    return { alpha1, alpha2: Math.max(binWidth, g2Center - alpha1), tau: Math.max(binWidth, 0.05 * alpha1) };
  }
  // Dominant bin in the lower ~60% of the DNA axis ~ the 1C (G1) peak.
  const centers = histogram.binCenters;
  const counts = histogram.counts;
  const limit = Math.max(1, Math.floor(centers.length * 0.6));
  let bestBin = 0;
  for (let bin = 1; bin < limit; bin += 1) if (counts[bin] > counts[bestBin]) bestBin = bin;
  const alpha1 = Math.max(binWidth, centers[bestBin]);
  return { alpha1, alpha2: alpha1, tau: Math.max(binWidth, 0.05 * alpha1) };
}

function render_cloccs_strain(outcome) {
  if (!outcome.result) {
    return `<p class="cell_cycle_cloccs_strain">${escape_html(outcome.strain)}: not fit (${escape_html(outcome.error)})</p>`;
  }
  const theta = outcome.result.theta;
  // UI-01/LEGACY-01: CLOCCS never passes through apply_result_contract() --
  // its output has no native .validForReporting -- but it is exactly the kind
  // of unvalidated model that contract exists to flag (see the "Unverified
  // model" note render_cloccs_result() already prints, right above this
  // table). A synthetic wrapper with validForReporting: false routes every
  // CLOCCS timepoint fraction through the SAME format_fraction_cell() every
  // other surface uses, so every number here always carries the ⚠ -- not just
  // the ones from a non-converged strain.
  const cloccsResult = { validForReporting: false, converged: outcome.result.diagnostics.converged };
  const rows = outcome.result.timepointResults
    .map((tp) => `<tr><td>${escape_html(String(tp.timeMinutes))}</td>` +
      `<td>${render_fraction_value(cloccsResult, tp.phaseFractions.g1)}</td>` +
      `<td>${render_fraction_value(cloccsResult, tp.phaseFractions.s)}</td>` +
      `<td>${render_fraction_value(cloccsResult, tp.phaseFractions.g2)}</td></tr>`)
    .join("");
  const dispersion = outcome.result.diagnostics.dispersion;
  const dispersionLine = dispersion && dispersion.starts > 1
    ? `<p class="cell_cycle_cloccs_params">Multi-start: ${dispersion.starts} starts · ${(dispersion.agreementFraction * 100).toFixed(0)}% agree on the optimum · λ spread cv ${dispersion.lambda.cv.toFixed(2)}${dispersion.agreementFraction < 0.6 ? " ⚠ weakly identified" : ""}</p>`
    : "";
  const convergenceQualifier = cloccsResult.converged ? "cc_qualifier" : "cc_qualifier cc_qualifier--warn";
  return (
    `<p class="cell_cycle_cloccs_strain">${escape_html(outcome.strain)} — ` +
    `<span class="${convergenceQualifier}">${cloccsResult.converged ? "converged" : "did not converge"}</span></p>` +
    `<table class="cell_cycle_cloccs_table"><thead><tr><th>t</th><th>%G1</th><th>%S</th><th>%G2/M</th></tr></thead><tbody>${rows}</tbody></table>` +
    `<p class="cell_cycle_cloccs_params">λ ${theta.lambda.toFixed(1)} min · μ0 ${theta.mu0.toFixed(1)} · δ ${theta.delta.toFixed(1)} · ` +
    `γ1 ${theta.gamma1.toFixed(3)} · γ2 ${theta.gamma2.toFixed(3)} · σV ${theta.sigmaV.toFixed(3)}</p>` +
    dispersionLine
  );
}

function render_cloccs_result(outcomes, mapping = {}) {
  if (!cell_cycle_fit_result) return;
  const sourceNote = mapping.usedMetadataTime
    ? `Timepoints from column "${escape_html(mapping.timepointColumn)}"${mapping.strainColumn ? `, strains from "${escape_html(mapping.strainColumn)}"` : " (one strain)"}.`
    : "Timepoints inferred from sample order — map a timepoint metadata column for a meaningful fit.";
  cell_cycle_fit_result.hidden = false;
  cell_cycle_fit_result.innerHTML =
    `<p class="cell_cycle_fit_selected_model">CLOCCS (Unverified)</p>` +
    `<p class="cell_cycle_unverified_note">⚠ Unverified model: not yet validated against external or annotated data. Do not use for scientific conclusions.</p>` +
    `<p class="cell_cycle_cloccs_source">${sourceNote}</p>` +
    outcomes.map(render_cloccs_strain).join("");
}

// Joint CLOCCS fit over every plotted sample, treated as one strain's timepoint
// series. Bounded iteration budget and run synchronously; CLOCCS is UNVERIFIED,
// so the result is presented with a prominent caveat and never written to the
// authoritative metadata columns.
async function run_cloccs_joint_fit(rows) {
  busy = true;
  set_controls_disabled(true);
  const progress_operation = show_progress("Fitting CLOCCS (Unverified)");
  try {
    const pipeline = await load_pipeline();
    const range = clamp_range_to_analysis_domain(pipeline.shared_histogram_range(rows));
    const binCount = plot_bin_count();

    // Timepoint and strain come from the mapped metadata columns -- the same
    // columns the metadata table already shows (extracted by the metadata wizard
    // from filenames, or imported). If no timepoint column is mapped, fall back
    // to sample name/order so a fit is still possible, with a clear note.
    const timepointColumn = cloccs_timepoint_column?.value || "";
    const strainColumn = cloccs_strain_column?.value || "";
    const timeMap = metadata_value_map(timepointColumn);
    const strainMap = metadata_value_map(strainColumn);
    const orderTimes = derive_cloccs_timepoints(rows);

    // One prepared sample per plotted row, tagged with its strain.
    const prepared = [];
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      update_progress((30 * index) / rows.length, "Preparing timepoints", row.name, "", progress_operation);
      pipeline.ensure_histogram_current(row, { binCount, range });
      const stored = get_state(row.name)?.histogram;
      if (!stored?.edges) continue;
      const histogram = histogramFromEdgesCounts(stored.edges, Array.from(stored.counts ?? stored.y));
      const timeMinutes = timeMap ? parse_timepoint(timeMap.get(row.name), orderTimes[index]) : orderTimes[index];
      const strain = strainMap ? String(strainMap.get(row.name) ?? "All plotted") : "All plotted";
      prepared.push({
        strain,
        sample: {
          sampleId: row.name,
          timeMinutes,
          histogram,
          fluorescenceInit: estimate_cloccs_fluorescence_init(row, histogram),
        },
      });
    }

    // Group into one time series per strain; each strain is fit independently.
    const strainGroups = new Map();
    for (const item of prepared) {
      if (!strainGroups.has(item.strain)) strainGroups.set(item.strain, []);
      strainGroups.get(item.strain).push(item.sample);
    }

    // The joint fit runs in a Web Worker (cloccs_client.js) so it never freezes
    // the UI, with multi-start dispersion diagnostics and a Cancel button that
    // interrupts at a round boundary.
    let cancelledByUser = false;
    const outcomes = [];
    let strainIndex = 0;
    for (const [strain, samples] of strainGroups) {
      strainIndex += 1;
      if (samples.length < 2) {
        outcomes.push({ strain, error: `only ${samples.length} timepoint — a series needs at least 2` });
        continue;
      }
      samples.sort((a, b) => a.timeMinutes - b.timeMinutes);
      const series = {
        strain,
        samples,
        uniqueTimepoints: [...new Set(samples.map((sample) => sample.timeMinutes))].sort((a, b) => a - b),
      };
      const base = 30 + (65 * (strainIndex - 1)) / strainGroups.size;
      const span = 65 / strainGroups.size;
      const handle = run_cloccs_fit(series, CLOCCS_FIT_CONFIG, {
        onProgress: (progress) => {
          const fraction = progress.starts ? (progress.start + 1) / progress.starts : 0;
          update_progress(base + span * fraction, "Fitting CLOCCS (Unverified)", `${strain} — start ${progress.start + 1}/${progress.starts}`, "", progress_operation);
        },
      });
      show_progress_cancel(() => {
        cancelledByUser = true;
        handle.cancel();
      });
      try {
        const result = await handle.promise;
        if (result?.cancelled) {
          cancelledByUser = true;
          break;
        }
        outcomes.push({ strain, result });
      } catch (error) {
        outcomes.push({ strain, error: error.message });
      }
      if (cancelledByUser) break;
    }

    const fittedCount = outcomes.filter((outcome) => outcome.result).length;
    if (cancelledByUser && !fittedCount) {
      set_fit_status("CLOCCS fit cancelled.", true);
      set_status_bar("CLOCCS fit cancelled.", "warning", null, progress_operation);
      return;
    }
    if (!fittedCount) {
      set_fit_status("CLOCCS could not fit any strain — each needs at least two plotted timepoints.", true);
      set_status_bar("CLOCCS needs at least two plotted timepoints per strain.", true, null, progress_operation);
      return;
    }
    render_cloccs_result(outcomes, { timepointColumn, strainColumn, usedMetadataTime: Boolean(timeMap) });
    const usedTime = timeMap ? `column "${timepointColumn}"` : "sample order (no timepoint column mapped)";
    set_status_bar(
      `CLOCCS (Unverified) fit ${fittedCount} strain${fittedCount === 1 ? "" : "s"} using ${usedTime}. ` +
        "This model is unverified — validate before any scientific use.",
      false, null, progress_operation,
    );
  } catch (error) {
    set_fit_status(`CLOCCS fit failed: ${error.message}`, true);
    set_status_bar(`CLOCCS fit failed: ${error.message}`, true, null, progress_operation, error);
  } finally {
    hide_progress(300, progress_operation);
    busy = false;
    set_controls_disabled(false);
  }
}

// Propagate the active sample's exact regions to every plotted sample and fit
// them all with the selected model (a manual-consensus alternative to Auto-Fit
// All's averaged regions). Only meaningful when the samples share the same
// DNA-content axis, so it confirms first. Reuses the same per-row apply+fit as
// the bulk path; each sample can still be reviewed/adjusted afterward.
async function on_apply_all_click() {
  if (busy) return;
  if (!peak_region_draft_valid()) return set_fit_status("Fix the invalid peak-region values before fitting.", true);
  const active = active_peak_review_row();
  const regions = active && get_modeling_state(active).peakSelection.regions;
  if (!regions) return;
  const rows = plottable_rows();
  if (rows.length <= 1) {
    set_status_bar("Only one sample is plotted — nothing to apply this sample's regions to.", true);
    return;
  }
  const calibrations = rows.map((row) => dna_axis_calibration(row));
  if (!calibrations[0] || calibrations.some((evidence) => !calibration_matches(calibrations[0], evidence))) {
    set_status_bar(
      "Cannot apply absolute regions to all samples: their DNA-axis calibration evidence is missing or differs. Use Fit All Samples to fit them independently.",
      true,
    );
    return;
  }
  if (!window.confirm(
    `Apply ${active.name}'s G1/G2 regions to all ${rows.length} plotted samples and fit them?\n\n` +
    "PhaseFinder verified matching channel, $PnR, representation, amplification, compensation, and instrument metadata. " +
    "Each sample can still be adjusted afterward.",
  )) return;
  if (!approve_degraded_qc(rows)) {
    set_status_bar("Bulk fit cancelled; required QC remains unavailable.", true);
    return;
  }

  const modelId = selected_model_id();
  const shared = {
    g1: { left: regions.g1.left, right: regions.g1.right },
    g2: { left: regions.g2.left, right: regions.g2.right },
  };
  busy = true;
  set_controls_disabled(true);
  const progress_operation = show_progress(`Applying regions & fitting ${model_label(modelId)}`);
  let fitted = 0;
  let failed = 0;
  try {
    const pipeline = await load_pipeline();
    const range = clamp_range_to_analysis_domain(pipeline.shared_histogram_range(rows));
    const binCount = plot_bin_count();

    // Sync setup: rebuild each histogram and apply + accept the shared regions,
    // collecting the samples that are ready to fit.
    const fit_list = [];
    for (const row of rows) {
      get_modeling_state(row).lastFitError = null;
      try {
        pipeline.ensure_histogram_current(row, { binCount, range });
        update_peak_regions(row, {
          g1: { left: shared.g1.left, right: shared.g1.right },
          g2: { left: shared.g2.left, right: shared.g2.right },
        }, { source: "shared", minimumGap: -0.01 });
        accept_peak_regions(row);
        fit_list.push(row);
      } catch (error) {
        get_modeling_state(row).lastFitError = {
          code: error?.code ?? "bulk_fit_failed",
          message: error?.message ?? String(error),
        };
        failed += 1;
      }
    }

    // Fit the prepared samples across the worker pool in parallel.
    let completed = 0;
    await run_with_limit(fit_list, fit_pool_size(), async (row) => {
      try {
        const result = await fit_cell_cycle_model(row, modelId);
        result.bulkRegionProvenance = {
          mode: "manual_shared",
          sourceSample: active.name,
          includedSamples: rows.map((candidate) => candidate.name),
          excludedSamples: [],
          calibrationEvidence: dna_axis_calibration(row),
          sharedRegions: deep_clone(shared),
        };
        fitted += 1;
      } catch (error) {
        get_modeling_state(row).lastFitError = {
          code: error?.code ?? "bulk_fit_failed",
          message: error?.message ?? String(error),
        };
        failed += 1;
      } finally {
        completed += 1;
        update_progress((100 * completed) / Math.max(1, fit_list.length), `Fitting ${model_label(modelId)}`, row.name, "", progress_operation);
      }
    });
    if (rows.length > 1) switch_to_ridge_view();
    const degraded = degraded_qc_names(rows);
    set_status_bar(
      `Applied ${active.name}'s regions to ${rows.length} samples and fit ${fitted}${failed ? `, ${failed} failed` : ""}` +
        `${degraded.length ? `; degraded QC: ${degraded.join(", ")}` : ""}.`,
      fitted === 0, null, progress_operation,
    );
  } catch (error) {
    set_fit_status(`Apply-to-all failed: ${error.message}`, true);
    set_status_bar(`Apply-to-all failed: ${error.message}`, true, null, progress_operation, error);
  } finally {
    hide_progress(300, progress_operation);
    busy = false;
    refresh_panel();
    render_density_plot();
    document.dispatchEvent(new CustomEvent("cell-cycle-fit-changed"));
  }
}

function on_model_change() {
  const row = active_peak_review_row();
  // The placeholder is not a model -- never store it as one.
  if (row && has_model_selected()) set_model_settings(row, { modelId: selected_model_id() });
  // CLOCCS (joint series) needs the timepoint/strain column mapping; show and
  // populate it from the live metadata table only while CLOCCS is selected.
  sync_cloccs_mapping_visibility();
  refresh_panel();
}

// Shows the CLOCCS timepoint/strain column mapping only while a joint-series
// model is selected, and (re)populates it from the live metadata columns. Safe
// to call on every panel refresh: fill_column_select preserves the user's
// current column choices.
function sync_cloccs_mapping_visibility() {
  const is_joint = JOINT_SERIES_MODELS.has(selected_model_id());
  if (cloccs_mapping) cloccs_mapping.hidden = !is_joint;
  if (is_joint) populate_cloccs_mapping();
}

// The metadata columns worth offering as a timepoint/strain source: everything
// in the file table except the sample name and the derived cell-cycle columns.
function metadata_columns_for_cloccs() {
  const frame = get_file_table();
  if (!frame) return [];
  return frame.columns.filter((column) => column !== "name" && !column.startsWith("cellCycleFit:"));
}

// Fills one column <select> from the metadata columns, keeping the user's prior
// choice if it still exists, else auto-selecting the first column whose name
// matches `autoRegex` (e.g. a "timepoint" or "strain" column).
function fill_column_select(select, columns, autoRegex, includeNone) {
  if (!select) return;
  const previous = select.value;
  select.innerHTML = "";
  if (includeNone) {
    const none = document.createElement("option");
    none.value = "";
    none.textContent = "— none (one strain) —";
    select.appendChild(none);
  }
  let autoPick = "";
  for (const column of columns) {
    const option = document.createElement("option");
    option.value = column;
    option.textContent = column;
    select.appendChild(option);
    if (!autoPick && autoRegex.test(column)) autoPick = column;
  }
  if (columns.includes(previous)) select.value = previous;
  else if (autoPick) select.value = autoPick;
}

function populate_cloccs_mapping() {
  const columns = metadata_columns_for_cloccs();
  fill_column_select(cloccs_timepoint_column, columns, /time|hour|min|elapsed/i, false);
  fill_column_select(cloccs_strain_column, columns, /strain|genotype|cell.?line|condition/i, true);
}

// name -> value lookup for one metadata column, aligned through the frame's
// "name" column.
function metadata_value_map(columnName) {
  const frame = get_file_table();
  if (!frame || !columnName) return null;
  const names = frame.col("name");
  const values = frame.col(columnName);
  const map = new Map();
  for (let index = 0; index < names.length; index += 1) map.set(names[index], values[index]);
  return map;
}

// Parses a timepoint metadata cell to a number (the first signed number in it,
// e.g. "T30" -> 30, "1.5 h" -> 1.5); falls back to the sample's plot order when
// the cell has no number.
function parse_timepoint(raw, fallbackIndex) {
  if (raw == null) return fallbackIndex;
  const match = String(raw).match(/-?\d+(\.\d+)?/);
  return match ? Number(match[0]) : fallbackIndex;
}

export function init_modeling_ui() {
  if (initialized) return;
  initialized = true;

  if (cell_cycle_model_select) cell_cycle_model_select.addEventListener("change", on_model_change);
  if (cell_cycle_fit_current_button) cell_cycle_fit_current_button.addEventListener("click", on_fit_current_click);
  if (cell_cycle_fit_all_button) cell_cycle_fit_all_button.addEventListener("click", on_fit_all_click);
  if (peak_regions_apply_all_button) peak_regions_apply_all_button.addEventListener("click", on_apply_all_click);
  if (cell_cycle_domain_sensitivity_button) cell_cycle_domain_sensitivity_button.addEventListener("click", on_check_domain_sensitivity_click);

  init_qc_critical_review({
    active_row: active_peak_review_row,
    // Re-running the fit is left to the user rather than fired automatically:
    // acknowledging a 50%+ event loss is a decision, and following it with an
    // immediate unattended fit would blur the acknowledgement into the result.
    on_acknowledged: () => refresh_panel(),
  });

  document.addEventListener("fcs-selection-change", refresh_panel);
  document.addEventListener("cell-cycle-focus-change", refresh_panel);
  document.addEventListener("cell-cycle-regions-changed", refresh_panel);
  document.addEventListener("cell-cycle-region-draft-change", refresh_panel);
  document.addEventListener("pf-plot-complete", refresh_panel);

  refresh_panel();
}
