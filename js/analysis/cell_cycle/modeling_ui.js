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
} from "../../ui/dom.js";
import { plottable_rows } from "../../plotting/data.js";
import { set_status_bar, show_progress, update_progress, hide_progress } from "../../ui/status_channels.js";
import { active_peak_review_row } from "./peak_review_ui.js";
import { get_modeling_state, fit_cell_cycle_model, set_model_settings } from "./modeling_state.js";

let initialized = false;
let busy = false;

const MODEL_LABELS = {
  auto_dj_djf: "Automatic — Dean–Jett / Dean–Jett–Fox",
  dean_jett: "Dean–Jett",
  dean_jett_fox: "Dean–Jett–Fox",
  watson_pragmatic: "Watson Pragmatic",
};

function model_label(modelId) {
  return MODEL_LABELS[modelId] ?? modelId;
}

function selected_model_id() {
  return cell_cycle_model_select?.value || "auto_dj_djf";
}

function set_fit_status(message, isError = false) {
  if (!cell_cycle_fit_status) return;
  cell_cycle_fit_status.textContent = message || "";
  cell_cycle_fit_status.hidden = !message;
  cell_cycle_fit_status.classList.toggle("cell_cycle_fit_not_converged", Boolean(isError));
}

function set_controls_disabled(disabled) {
  if (cell_cycle_model_select) cell_cycle_model_select.disabled = disabled;
  if (cell_cycle_fit_current_button) cell_cycle_fit_current_button.disabled = disabled;
  if (cell_cycle_fit_all_button) cell_cycle_fit_all_button.disabled = disabled;
}

function percent(fraction) {
  return Number.isFinite(fraction) ? `${(fraction * 100).toFixed(1)}%` : "—";
}

function escape_html(value) {
  return String(value).replace(/[&<>"']/g, (char) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]
  ));
}

function render_result(result) {
  if (!cell_cycle_fit_result) return;
  if (!result) {
    cell_cycle_fit_result.hidden = true;
    cell_cycle_fit_result.innerHTML = "";
    return;
  }

  const warnings = result.warnings ?? [];
  const convergenceText = result.converged ? "Converged" : `Not converged (${escape_html(result.convergenceReason ?? "unknown")})`;
  // auto_dj_djf's normalized result carries the selected submodel's own id
  // (plan §4.5's modelId field is overwritten to "auto_dj_djf" by
  // model_selection.js, with the real winner recorded in modelComparison).
  const selectedNote = result.modelComparison
    ? `<p class="cell_cycle_fit_selected_model">Selected: ${escape_html(model_label(result.modelComparison.selectedModelId))}</p>`
    : "";

  cell_cycle_fit_result.hidden = false;
  cell_cycle_fit_result.innerHTML = `
    <div class="cell_cycle_fit_result_header">
      <span>${escape_html(result.modelLabel ?? model_label(result.modelId))}</span>
      <span class="cell_cycle_fit_convergence${result.converged ? "" : " cell_cycle_fit_not_converged"}">${convergenceText}</span>
    </div>
    <dl class="cell_cycle_fit_fractions">
      <div class="cell_cycle_fit_fraction_row"><dt>G1</dt><dd>${percent(result.phaseFractions?.g1)}</dd></div>
      <div class="cell_cycle_fit_fraction_row"><dt>S</dt><dd>${percent(result.phaseFractions?.s)}</dd></div>
      <div class="cell_cycle_fit_fraction_row"><dt>G2/M</dt><dd>${percent(result.phaseFractions?.g2)}</dd></div>
    </dl>
    ${selectedNote}
    <p class="cell_cycle_fit_warnings${warnings.length ? " cell_cycle_fit_has_warnings" : ""}">${
      warnings.length ? `${warnings.length} warning${warnings.length === 1 ? "" : "s"}` : "No warnings."
    }</p>
  `;
}

function refresh_panel() {
  const row = active_peak_review_row();
  if (!row) {
    set_controls_disabled(true);
    render_result(null);
    return;
  }

  const modeling = get_modeling_state(row);
  set_controls_disabled(false);
  // fit_cell_cycle_model() itself validates the histogram/regions preconditions
  // with a clear error message on click; the button only needs to reflect
  // the one precondition visible from here (accepted regions exist).
  if (cell_cycle_fit_current_button) cell_cycle_fit_current_button.disabled = !modeling.peakSelection.regions;

  if (cell_cycle_model_select && cell_cycle_model_select.value !== modeling.settings.modelId) {
    cell_cycle_model_select.value = modeling.settings.modelId;
  }

  const activeResult = modeling.activeResultKey ? modeling.resultsByKey[modeling.activeResultKey] : null;
  render_result(activeResult);
}

async function on_fit_current_click() {
  if (busy) return;
  const row = active_peak_review_row();
  if (!row) return;
  const modelId = selected_model_id();

  busy = true;
  set_controls_disabled(true);
  show_progress(`Fitting ${model_label(modelId)}`);
  try {
    const result = await fit_cell_cycle_model(row, modelId);
    render_result(result);
    set_fit_status(
      `${model_label(modelId)} fit for ${row.name}: ${result.converged ? "converged" : "did not converge"}.`,
      !result.converged,
    );
    set_status_bar(`Cell-cycle model fit for ${row.name}.`);
  } catch (error) {
    set_fit_status(error.message, true);
    set_status_bar(`Model fit failed: ${error.message}`, true);
  } finally {
    hide_progress(300);
    busy = false;
    refresh_panel();
  }
}

async function on_fit_all_click() {
  if (busy) return;
  const modelId = selected_model_id();
  const reviewed = plottable_rows().filter((row) => {
    const modeling = get_modeling_state(row);
    return Boolean(modeling.peakSelection.regions) && modeling.peakSelection.reviewed && !modeling.peakSelection.stale;
  });
  if (!reviewed.length) {
    set_status_bar("No samples have reviewed/accepted peak regions yet — use Identify Peaks and Accept first.", true);
    return;
  }

  busy = true;
  set_controls_disabled(true);
  show_progress(`Fitting ${model_label(modelId)}`);
  let succeeded = 0;
  let failed = 0;
  try {
    for (let index = 0; index < reviewed.length; index += 1) {
      const row = reviewed[index];
      update_progress((100 * index) / reviewed.length, `Fitting ${model_label(modelId)}`, row.name);
      try {
        await fit_cell_cycle_model(row, modelId);
        succeeded += 1;
      } catch (_) {
        failed += 1;
      }
    }
    set_status_bar(
      `Fit ${succeeded} sample${succeeded === 1 ? "" : "s"}${failed ? `, ${failed} failed` : ""}.`,
      failed > 0 && succeeded === 0,
    );
  } finally {
    hide_progress(300);
    busy = false;
    refresh_panel();
  }
}

function on_model_change() {
  const row = active_peak_review_row();
  if (row) set_model_settings(row, { modelId: selected_model_id() });
  refresh_panel();
}

export function init_modeling_ui() {
  if (initialized) return;
  initialized = true;

  if (cell_cycle_model_select) cell_cycle_model_select.addEventListener("change", on_model_change);
  if (cell_cycle_fit_current_button) cell_cycle_fit_current_button.addEventListener("click", on_fit_current_click);
  if (cell_cycle_fit_all_button) cell_cycle_fit_all_button.addEventListener("click", on_fit_all_click);

  document.addEventListener("fcs-selection-change", refresh_panel);
  document.addEventListener("cell-cycle-focus-change", refresh_panel);
  document.addEventListener("cell-cycle-regions-changed", refresh_panel);
  document.addEventListener("pf-plot-complete", refresh_panel);

  refresh_panel();
}
