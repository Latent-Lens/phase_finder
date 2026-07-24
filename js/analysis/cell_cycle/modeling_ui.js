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
  peak_regions_apply_all_button,
} from "../../ui/dom.js";
import {
  plottable_rows,
  plot_bin_count,
  clamp_range_to_axis_override,
  set_plot_view_mode,
  plot_view_mode_select,
} from "../../plotting/data.js";
import { render_density_plot } from "../../plotting/render.js";
import { set_status_bar, show_progress, update_progress, hide_progress } from "../../ui/status_channels.js";
import { load_pipeline } from "../pipeline_loader.js";
import { active_peak_review_row } from "./peak_review_ui.js";
import {
  get_modeling_state,
  fit_cell_cycle_model,
  set_model_settings,
  detect_peak_regions,
  update_peak_regions,
  accept_peak_regions,
} from "./modeling_state.js";

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

// A bulk fit is inherently multi-sample review, so switch the plot to the ridge
// view (stacked small-multiples) automatically once it runs.
function switch_to_ridge_view() {
  set_plot_view_mode("ridge");
  if (plot_view_mode_select) plot_view_mode_select.value = "ridge";
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
  // Fit All is a bulk auto-fit over every plotted sample (auto-detect + average
  // + fit), so it's enabled whenever anything is plotted -- even with several
  // samples checked and none singled out as the active review row. The model
  // dropdown is likewise enabled whenever there's something to fit.
  const plotted_count = plottable_rows().length;
  const has_plotted = plotted_count > 0;
  if (cell_cycle_fit_all_button) cell_cycle_fit_all_button.disabled = !has_plotted;
  if (cell_cycle_model_select) cell_cycle_model_select.disabled = !has_plotted;
  // "Apply to All" needs the active sample's regions and at least one other
  // plotted sample to copy them to.
  if (peak_regions_apply_all_button) {
    const active_regions = row && get_modeling_state(row).peakSelection.regions;
    peak_regions_apply_all_button.disabled = !active_regions || plotted_count <= 1;
  }

  if (!row) {
    if (cell_cycle_fit_current_button) cell_cycle_fit_current_button.disabled = true;
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
    cell_cycle_fit_current_button.disabled = !modeling.peakSelection.regions || modeling.peakSelection.stale;
  }
  if (modeling.peakSelection.regions && modeling.peakSelection.stale) {
    set_fit_status("Bin count changed — re-detect peaks before fitting.", true);
  } else if (cell_cycle_fit_status && cell_cycle_fit_status.textContent.startsWith("Bin count changed")) {
    set_fit_status("");
  }

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
    render_density_plot();
    document.dispatchEvent(new CustomEvent("cell-cycle-fit-changed"));
  }
}

// Bulk auto-fit across every plotted sample: auto-detect each sample's G1/G2
// regions, average the four bounds across the batch, apply those averaged
// (consensus) regions to every sample, then fit each with the selected model.
// A shared region definition keeps the batch comparable; per-sample review/
// adjust afterward still overrides it. Regions are built over the visible
// x-range at the current bins (clamp_range_to_axis_override), same as single fit.
async function on_fit_all_click() {
  if (busy) return;
  const modelId = selected_model_id();
  const rows = plottable_rows();
  if (!rows.length) {
    set_status_bar("Plot at least one sample before fitting.", true);
    return;
  }

  busy = true;
  set_controls_disabled(true);
  show_progress(`Auto-fitting ${model_label(modelId)}`);
  let detected = 0;
  let fitted = 0;
  let failed = 0;
  try {
    const pipeline = await load_pipeline();
    const range = clamp_range_to_axis_override(pipeline.shared_histogram_range(rows));
    const binCount = plot_bin_count();

    // Phase 1: auto-detect regions for every plotted sample; collect the bounds.
    const boundsList = [];
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      update_progress((45 * index) / rows.length, "Auto-detecting peaks", row.name);
      try {
        pipeline.ensure_histogram_current(row, { binCount, range });
        detect_peak_regions(row);
        const regions = get_modeling_state(row).peakSelection.regions;
        if (regions?.g1 && regions?.g2) {
          boundsList.push(regions);
          detected += 1;
        }
      } catch (_) {
        failed += 1;
      }
    }
    if (!boundsList.length) {
      set_status_bar("Could not detect peaks on any plotted sample.", true);
      return;
    }

    // Average the four region bounds across the samples that detected.
    const mean = (select) => boundsList.reduce((sum, regions) => sum + select(regions), 0) / boundsList.length;
    const averaged = {
      g1: { left: mean((r) => r.g1.left), right: mean((r) => r.g1.right) },
      g2: { left: mean((r) => r.g2.left), right: mean((r) => r.g2.right) },
    };
    const ordered = averaged.g1.left < averaged.g1.right
      && averaged.g1.right <= averaged.g2.left
      && averaged.g2.left < averaged.g2.right;
    if (!ordered) {
      set_status_bar(
        "Averaged peak regions aren't well-ordered — the samples' peaks vary too much for one shared region. Review per-sample.",
        true,
      );
      return;
    }

    // Phase 2: apply the averaged regions to every sample and fit.
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      update_progress(45 + (55 * index) / rows.length, `Fitting ${model_label(modelId)}`, row.name);
      try {
        update_peak_regions(row, {
          g1: { left: averaged.g1.left, right: averaged.g1.right },
          g2: { left: averaged.g2.left, right: averaged.g2.right },
        }, { source: "averaged", minimumGap: -0.01 });
        accept_peak_regions(row);
        await fit_cell_cycle_model(row, modelId);
        fitted += 1;
      } catch (_) {
        failed += 1;
      }
    }
    if (rows.length > 1) switch_to_ridge_view();
    set_status_bar(
      `Auto-fit ${fitted} of ${rows.length} sample${rows.length === 1 ? "" : "s"} with averaged regions` +
        ` (G1 ${averaged.g1.left.toFixed(0)}–${averaged.g1.right.toFixed(0)}, G2 ${averaged.g2.left.toFixed(0)}–${averaged.g2.right.toFixed(0)})` +
        `${failed ? `; ${failed} failed` : ""}.`,
      fitted === 0,
    );
  } finally {
    hide_progress(300);
    busy = false;
    refresh_panel();
    render_density_plot();
    document.dispatchEvent(new CustomEvent("cell-cycle-fit-changed"));
  }
}

// Propagate the active sample's exact regions to every plotted sample and fit
// them all with the selected model (a manual-consensus alternative to Auto-Fit
// All's averaged regions). Only meaningful when the samples share the same
// DNA-content axis, so it confirms first. Reuses the same per-row apply+fit as
// the bulk path; each sample can still be reviewed/adjusted afterward.
async function on_apply_all_click() {
  if (busy) return;
  const active = active_peak_review_row();
  const regions = active && get_modeling_state(active).peakSelection.regions;
  if (!regions) return;
  const rows = plottable_rows();
  if (rows.length <= 1) {
    set_status_bar("Only one sample is plotted — nothing to apply this sample's regions to.", true);
    return;
  }
  if (!window.confirm(
    `Apply ${active.name}'s G1/G2 regions to all ${rows.length} plotted samples and fit them?\n\n` +
    "This only makes sense if the samples share the same DNA-content axis/calibration. " +
    "Each sample can still be adjusted afterward.",
  )) return;

  const modelId = selected_model_id();
  const shared = {
    g1: { left: regions.g1.left, right: regions.g1.right },
    g2: { left: regions.g2.left, right: regions.g2.right },
  };
  busy = true;
  set_controls_disabled(true);
  show_progress(`Applying regions & fitting ${model_label(modelId)}`);
  let fitted = 0;
  let failed = 0;
  try {
    const pipeline = await load_pipeline();
    const range = clamp_range_to_axis_override(pipeline.shared_histogram_range(rows));
    const binCount = plot_bin_count();
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      update_progress((100 * index) / rows.length, `Fitting ${model_label(modelId)}`, row.name);
      try {
        pipeline.ensure_histogram_current(row, { binCount, range });
        update_peak_regions(row, {
          g1: { left: shared.g1.left, right: shared.g1.right },
          g2: { left: shared.g2.left, right: shared.g2.right },
        }, { source: "shared", minimumGap: -0.01 });
        accept_peak_regions(row);
        await fit_cell_cycle_model(row, modelId);
        fitted += 1;
      } catch (_) {
        failed += 1;
      }
    }
    if (rows.length > 1) switch_to_ridge_view();
    set_status_bar(
      `Applied ${active.name}'s regions to ${rows.length} samples and fit ${fitted}${failed ? `, ${failed} failed` : ""}.`,
      fitted === 0,
    );
  } finally {
    hide_progress(300);
    busy = false;
    refresh_panel();
    render_density_plot();
    document.dispatchEvent(new CustomEvent("cell-cycle-fit-changed"));
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
  if (peak_regions_apply_all_button) peak_regions_apply_all_button.addEventListener("click", on_apply_all_click);

  document.addEventListener("fcs-selection-change", refresh_panel);
  document.addEventListener("cell-cycle-focus-change", refresh_panel);
  document.addEventListener("cell-cycle-regions-changed", refresh_panel);
  document.addEventListener("pf-plot-complete", refresh_panel);

  refresh_panel();
}
