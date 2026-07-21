// Sidebar "Identify Peaks" panel: lets the user detect, review, and manually
// adjust the G1 and G2/M peak regions for one sample at a time, ahead of
// choosing a model (M3) to fit against them. The reviewed sample is whichever
// row is checked in the metadata table -- unambiguous with exactly one
// checked file, or whichever row the user clicked into focus (see
// data_structs/table_state.js's focused_file_id) when several are checked at
// once. There is no separate sample picker here by design.
//
// Reads/writes modeling_state.js's peak-region state functions directly
// (they only touch pipeline_state.js, not the heavy lazy-loaded DJF pipeline
// module), and only reaches for the lazy pipeline on demand -- to build/
// refresh a row's Stage 4 histogram before detecting peaks against it.

import {
  detect_peaks_button,
  peak_review_focus,
  peak_review_status,
  peak_pair_alternatives,
  peak_region_g1_left,
  peak_region_g1_right,
  peak_region_g2_left,
  peak_region_g2_right,
  peak_region_error,
  peak_regions_reset_button,
  peak_regions_accept_button,
} from "../../ui/dom.js";
import { plottable_rows, plot_bin_count } from "../../plotting/data.js";
import { focused_file_id } from "../../data_structs/table_state.js";
import { set_status_bar } from "../../ui/status_channels.js";
import { load_pipeline } from "../pipeline_loader.js";
import { get_state } from "../pipeline_state.js";
import {
  detect_peak_regions,
  select_peak_pair,
  update_peak_regions,
  accept_peak_regions,
  reset_peak_regions,
} from "./modeling_state.js";

let initialized = false;

const PEAK_STATUS_LABELS = {
  detected: "Detected",
  low_confidence: "Low confidence — review closely",
  inferred_g2: "G2/M inferred",
};

/**
 * The sample the Identify Peaks panel (and the plot's region-handle overlay,
 * see plotting/peak_region_overlay.js) is currently reviewing: unambiguous
 * with exactly one file checked, or whichever row was clicked into focus (see
 * data_structs/table_state.js's focused_file_id) when several are checked.
 */
export function active_peak_review_row() {
  const rows = plottable_rows();
  if (rows.length === 1) return rows[0];
  if (focused_file_id) return rows.find((row) => row.id === focused_file_id) ?? null;
  return null;
}

// Lets the plot overlay (which commits its own drag edits directly) and the
// sidebar stay in sync without either module importing the other -- the plot
// re-render this triggers (wired in main.js) is what actually redraws the
// overlay with the committed regions.
function notify_regions_changed() {
  document.dispatchEvent(new CustomEvent("cell-cycle-regions-changed"));
}

function region_inputs() {
  return {
    g1_left: peak_region_g1_left,
    g1_right: peak_region_g1_right,
    g2_left: peak_region_g2_left,
    g2_right: peak_region_g2_right,
  };
}

function set_region_inputs_disabled(disabled) {
  Object.values(region_inputs()).forEach((el) => {
    if (el) el.disabled = disabled;
  });
  if (peak_regions_reset_button) peak_regions_reset_button.disabled = disabled;
  if (peak_regions_accept_button) peak_regions_accept_button.disabled = disabled;
}

function show_region_error(message) {
  if (!peak_region_error) return;
  peak_region_error.textContent = message || "";
  peak_region_error.hidden = !message;
}

function fill_region_inputs(regions) {
  if (!regions) return;
  if (peak_region_g1_left) peak_region_g1_left.value = regions.g1.left.toFixed(2);
  if (peak_region_g1_right) peak_region_g1_right.value = regions.g1.right.toFixed(2);
  if (peak_region_g2_left) peak_region_g2_left.value = regions.g2.left.toFixed(2);
  if (peak_region_g2_right) peak_region_g2_right.value = regions.g2.right.toFixed(2);
}

function read_region_inputs() {
  const num = (el) => Number.parseFloat(el?.value);
  return {
    g1: { left: num(peak_region_g1_left), right: num(peak_region_g1_right) },
    g2: { left: num(peak_region_g2_left), right: num(peak_region_g2_right) },
  };
}

function status_text(peakDetection) {
  if (!peakDetection || peakDetection.status == null) return "";
  const confidence = Math.round((peakDetection.confidence ?? 0) * 100);
  const label = PEAK_STATUS_LABELS[peakDetection.status] || peakDetection.status;
  const reasons = peakDetection.reasons?.length ? ` — ${peakDetection.reasons.join("; ")}` : "";
  return `${label} (${confidence}% confidence)${reasons}`;
}

function render_alternatives(row, peakDetection) {
  if (!peak_pair_alternatives) return;
  const alternatives = peakDetection?.alternatives ?? [];
  if (!row || !alternatives.length) {
    peak_pair_alternatives.hidden = true;
    peak_pair_alternatives.innerHTML = "";
    return;
  }
  peak_pair_alternatives.hidden = false;
  peak_pair_alternatives.innerHTML = [
    `<span class="peak_pair_alternatives_label">Other candidate pairs:</span>`,
    ...alternatives.map(
      (pair) => `<button type="button" class="peak_pair_alternative_button" data-pair-id="${pair.id}">${pair.id}</button>`,
    ),
  ].join("");
  peak_pair_alternatives.querySelectorAll(".peak_pair_alternative_button").forEach((button) => {
    button.addEventListener("click", () => {
      try {
        select_peak_pair(row, button.dataset.pairId);
        notify_regions_changed();
      } catch (error) {
        set_status_bar(error.message, true);
      }
      refresh_panel();
    });
  });
}

function refresh_panel() {
  const row = active_peak_review_row();
  const rows = plottable_rows();

  if (!row) {
    if (peak_review_focus) {
      peak_review_focus.textContent = rows.length > 1
        ? `${rows.length} samples checked — click a row in the table to identify its peaks.`
        : "Plot a channel and check a sample in the table to identify peaks.";
    }
    if (detect_peaks_button) detect_peaks_button.disabled = true;
    if (peak_review_status) peak_review_status.hidden = true;
    render_alternatives(null, null);
    set_region_inputs_disabled(true);
    show_region_error("");
    return;
  }

  if (peak_review_focus) {
    peak_review_focus.textContent = rows.length > 1 ? `Reviewing: ${row.name}` : row.name;
  }
  if (detect_peaks_button) detect_peaks_button.disabled = false;

  const state = get_state(row.name);
  const modeling = state?.modeling;
  show_region_error("");

  if (!modeling || !modeling.peakSelection.regions) {
    if (peak_review_status) peak_review_status.hidden = true;
    render_alternatives(row, null);
    set_region_inputs_disabled(true);
    return;
  }

  if (peak_review_status) {
    const text = status_text(modeling.peakDetection);
    peak_review_status.textContent = text;
    peak_review_status.hidden = !text;
  }
  render_alternatives(row, modeling.peakDetection);
  set_region_inputs_disabled(false);
  fill_region_inputs(modeling.peakSelection.regions);
}

async function on_detect_peaks_click() {
  const row = active_peak_review_row();
  if (!row) return;
  detect_peaks_button.disabled = true;
  try {
    const pipeline = await load_pipeline();
    const rows = plottable_rows();
    const shared_range = pipeline.shared_histogram_range(rows);
    pipeline.ensure_histogram_current(row, { binCount: plot_bin_count(), range: shared_range });
    detect_peak_regions(row);
    notify_regions_changed();
    set_status_bar(`Peaks detected for ${row.name}.`);
  } catch (error) {
    set_status_bar(`Peak detection failed: ${error.message}`, true);
  } finally {
    refresh_panel();
  }
}

function on_region_input_change() {
  const row = active_peak_review_row();
  if (!row) return;
  try {
    // The four inputs are redisplayed rounded to 2 decimals (see
    // fill_region_inputs); only the just-edited field reflects the user's
    // exact new value, so a touching G1/G2 boundary needs a little slack to
    // avoid a spurious ordering failure from rounding alone.
    update_peak_regions(row, read_region_inputs(), { source: "manual", minimumGap: -0.01 });
    notify_regions_changed();
  } catch (error) {
    // Leave the user's typed values in place so they can see and fix the
    // invalid entry -- refresh_panel() would otherwise overwrite them with
    // the last valid (unchanged) stored regions.
    show_region_error(error.message);
    return;
  }
  refresh_panel();
}

function on_reset_click() {
  const row = active_peak_review_row();
  if (!row) return;
  try {
    reset_peak_regions(row);
    notify_regions_changed();
  } catch (error) {
    set_status_bar(error.message, true);
  }
  refresh_panel();
}

function on_accept_click() {
  const row = active_peak_review_row();
  if (!row) return;
  accept_peak_regions(row);
  set_status_bar(`Peak regions accepted for ${row.name}.`);
  refresh_panel();
}

export function init_peak_review_ui() {
  if (initialized) return;
  initialized = true;

  if (detect_peaks_button) detect_peaks_button.addEventListener("click", on_detect_peaks_click);
  if (peak_regions_reset_button) peak_regions_reset_button.addEventListener("click", on_reset_click);
  if (peak_regions_accept_button) peak_regions_accept_button.addEventListener("click", on_accept_click);
  Object.values(region_inputs()).forEach((el) => {
    if (el) el.addEventListener("change", on_region_input_change);
  });

  document.addEventListener("fcs-selection-change", refresh_panel);
  document.addEventListener("cell-cycle-focus-change", refresh_panel);
  document.addEventListener("cell-cycle-regions-changed", refresh_panel);
  document.addEventListener("pf-plot-complete", refresh_panel);

  refresh_panel();
}
