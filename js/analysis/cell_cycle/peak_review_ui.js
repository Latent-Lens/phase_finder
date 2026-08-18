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
// refresh a row's DNA-content histogram before detecting peaks against it.
//
// active_peak_review_row() picks the sample under review; refresh_panel() keeps
// the panel in sync with it; on_detect_peaks_click() runs detection;
// on_region_input_change(), on_reset_click(), and on_accept_click() handle edits;
// init_peak_review_ui() wires the controls. The remaining helpers read/write the
// four region inputs and format the status text.

import {
  detect_peaks_button,
  peak_review_focus,
  peak_review_status,
  peak_region_g1_left,
  peak_region_g1_right,
  peak_region_g2_left,
  peak_region_g2_right,
  peak_region_error,
  peak_regions_reset_button,
  peak_regions_accept_button,
} from "../../ui/dom.js";
import { plottable_rows, plot_bin_count, clamp_range_to_analysis_domain } from "../../plotting/data.js";
import { focused_file_id } from "../../data_structs/table_state.js";
import { set_status_bar } from "../../ui/status_channels.js";
import { load_pipeline } from "../pipeline/pipeline_loader.js";
import { get_state } from "../pipeline/pipeline_state.js";
import {
  detect_peak_regions,
  update_peak_regions,
  accept_peak_regions,
  reset_peak_regions,
} from "./modeling_state.js";
import { validatePeakRegions } from "./peak_regions.js";

let initialized = false;
let region_draft = null;

const PEAK_STATUS_LABELS = {
  detected: "Detected",
  low_confidence: "Low confidence — review closely",
  inferred_g2: "G2/M inferred",
};

/*

Purpose:
	The sample the Identify Peaks panel (and the plot's region-handle overlay, see
	plotting/peak_region_overlay.js) is currently reviewing: unambiguous with exactly
	one file checked, or whichever row was clicked into focus (see
	data_structs/table_state.js's focused_file_id) when several are checked.

Input:
	(none)

Output:
	row [object|null]: the sample under review, or null when it's ambiguous

*/
export function active_peak_review_row() {
  const rows = plottable_rows();
  if (rows.length === 1) return rows[0];
  if (focused_file_id) return rows.find((row) => row.id === focused_file_id) ?? null;
  return null;
}

/*

Purpose:
	Fires the "cell-cycle-regions-changed" event so the plot overlay and the sidebar
	stay in sync without importing each other; the re-render it triggers (wired in
	main.js) is what redraws the overlay with the committed regions.

Input:
	(none)

Output:
	(none) [void]

*/
function notify_regions_changed(detail = {}) {
  document.dispatchEvent(new CustomEvent("cell-cycle-regions-changed", { detail }));
}

/*

Purpose:
	The four region-boundary input elements keyed by boundary.

Input:
	(none)

Output:
	inputs [object]: { g1_left, g1_right, g2_left, g2_right } DOM elements

*/
function region_inputs() {
  return {
    g1_left: peak_region_g1_left,
    g1_right: peak_region_g1_right,
    g2_left: peak_region_g2_left,
    g2_right: peak_region_g2_right,
  };
}

/*

Purpose:
	Enables or disables the four region inputs and the Reset/Accept buttons together.

Input:
	disabled [boolean]: whether to disable them

Output:
	(none) [void]

*/
function set_region_inputs_disabled(disabled) {
  Object.values(region_inputs()).forEach((el) => {
    if (el) el.disabled = disabled;
  });
  if (peak_regions_reset_button) peak_regions_reset_button.disabled = disabled;
  if (peak_regions_accept_button) peak_regions_accept_button.disabled = disabled || !peak_region_draft_valid();
}

/*

Purpose:
	Shows or clears the region-error message under the inputs.

Input:
	message [string]: the error text, or "" / falsy to hide it

Output:
	(none) [void]

*/
function show_region_error(message, invalid_keys = []) {
  Object.entries(region_inputs()).forEach(([key, input]) => {
    if (input) input.setAttribute("aria-invalid", invalid_keys.includes(key) ? "true" : "false");
  });
  if (!peak_region_error) return;
  peak_region_error.textContent = message || "";
  peak_region_error.hidden = !message;
}

function clone_regions(regions) {
  return regions ? { g1: { ...regions.g1 }, g2: { ...regions.g2 } } : null;
}

function invalid_region_keys(regions) {
  const values = {
    g1_left: regions?.g1?.left,
    g1_right: regions?.g1?.right,
    g2_left: regions?.g2?.left,
    g2_right: regions?.g2?.right,
  };
  const keys = Object.entries(values).filter(([, value]) => !Number.isFinite(value)).map(([key]) => key);
  if (values.g1_left >= values.g1_right) keys.push("g1_left", "g1_right");
  if (values.g2_left >= values.g2_right) keys.push("g2_left", "g2_right");
  if (values.g1_right > values.g2_left) keys.push("g1_right", "g2_left");
  return [...new Set(keys)];
}

export function peak_region_draft_valid(row = active_peak_review_row()) {
  return !region_draft || region_draft.rowName !== row?.name || region_draft.valid;
}

export function current_peak_region_draft(row) {
  if (region_draft?.rowName === row?.name && region_draft.valid) return clone_regions(region_draft.regions);
  return clone_regions(get_state(row?.name)?.modeling?.peakSelection?.regions);
}

function publish_draft_validity() {
  document.dispatchEvent(new CustomEvent("cell-cycle-region-draft-change", {
    detail: { valid: peak_region_draft_valid() },
  }));
}

export function commit_peak_region_draft(row, regions, { preserveOverlay = false } = {}) {
  region_draft = { rowName: row.name, regions: clone_regions(regions), valid: false, error: "" };
  try {
    validatePeakRegions(regions);
    update_peak_regions(row, regions, { source: "manual" });
    region_draft.valid = true;
    fill_region_inputs(regions);
    show_region_error("");
    notify_regions_changed({ preserveOverlay });
  } catch (error) {
    region_draft.error = error.message;
    show_region_error(error.message, invalid_region_keys(regions));
  }
  if (peak_regions_accept_button) peak_regions_accept_button.disabled = !region_draft.valid;
  publish_draft_validity();
  return region_draft.valid;
}

/*

Purpose:
	Fills the four region inputs from a regions object, rounded to 2 decimals.

Input:
	regions [object]: { g1: {left,right}, g2: {left,right} }

Output:
	(none) [void]

*/
function fill_region_inputs(regions) {
  if (!regions) return;
  if (peak_region_g1_left) peak_region_g1_left.value = String(regions.g1.left);
  if (peak_region_g1_right) peak_region_g1_right.value = String(regions.g1.right);
  if (peak_region_g2_left) peak_region_g2_left.value = String(regions.g2.left);
  if (peak_region_g2_right) peak_region_g2_right.value = String(regions.g2.right);
}

/*

Purpose:
	Reads the four region inputs into a regions object of numbers.

Input:
	(none)

Output:
	regions [object]: { g1: {left,right}, g2: {left,right} }

*/
function read_region_inputs() {
  const num = (el) => Number.parseFloat(el?.value);
  return {
    g1: { left: num(peak_region_g1_left), right: num(peak_region_g1_right) },
    g2: { left: num(peak_region_g2_left), right: num(peak_region_g2_right) },
  };
}

/*

Purpose:
	Formats the peak-detection status line (label, confidence, and any reasons) for
	display.

Input:
	peakDetection [object]: the modeling peakDetection state

Output:
	text [string]: the status line, or "" when there's no status

*/
function status_text(peakDetection) {
  if (!peakDetection || peakDetection.status == null) return "";
  const confidence = Math.round((peakDetection.confidence ?? 0) * 100);
  const label = PEAK_STATUS_LABELS[peakDetection.status] || peakDetection.status;
  const reasons = peakDetection.reasons?.length ? ` — ${peakDetection.reasons.join("; ")}` : "";
  return `${label} (${confidence}% confidence)${reasons}`;
}

/*

Purpose:
	Re-syncs the whole panel to the current sample under review: the focus label, the
	Detect Peaks button, the status line, and the region inputs (enabled and filled
	only when regions exist), surfacing a stale-regions warning after a bin change.

Input:
	(none)

Output:
	(none) [void]: updates the panel DOM

*/
function refresh_panel() {
  const row = active_peak_review_row();
  const rows = plottable_rows();

  if (!row) {
    // Several samples plotted with none singled out. Detection still applies --
    // it runs on all of them (see on_detect_peaks_click) -- but the four region
    // inputs edit exactly one sample, so those stay disabled until a row is
    // singled out. Clicking a table row does NOT do that (it only toggles
    // selection/plotting) -- the only control that calls set_focused_file_id()
    // is the Ridge view's per-sample "Manual Review" button
    // (js/plotting/render.js's enter_ridge_review()). Both the pre-detection
    // hint and the post-detection status name that control explicitly instead
    // of the previous "click a row", which silently did nothing (UI-09).
    const bulk = rows.length > 1;
    if (peak_review_focus) {
      peak_review_focus.textContent = bulk
        ? `${rows.length} samples checked — Detect Peaks runs on all of them; switch View to Ridge and use a sample's Manual Review button to review or edit one.`
        : "Plot a channel and check a sample in the table to identify peaks.";
    }
    if (detect_peaks_button) {
      detect_peaks_button.disabled = !bulk;
      detect_peaks_button.textContent = bulk ? "Detect Peaks (all samples)" : "Detect Peaks";
    }
    // Self-explain the disabled/blank fields below (UI-09) instead of leaving
    // them looking like a blank failed form: reuse the existing status line
    // rather than adding any new markup or CSS.
    if (peak_review_status) {
      peak_review_status.textContent = bulk
        ? "No single sample selected, so these fields stay blank — switch View to Ridge and use a sample's Manual Review button to see or edit its regions."
        : "";
      peak_review_status.hidden = !bulk;
    }
    set_region_inputs_disabled(true);
    show_region_error("");
    return;
  }

  if (peak_review_focus) {
    peak_review_focus.textContent = rows.length > 1 ? `Reviewing: ${row.name}` : row.name;
  }
  if (detect_peaks_button) {
    detect_peaks_button.disabled = false;
    detect_peaks_button.textContent = "Detect Peaks";
  }

  const state = get_state(row.name);
  const modeling = state?.modeling;

  if (!modeling || !modeling.peakSelection.regions) {
    if (peak_review_status) peak_review_status.hidden = true;
    set_region_inputs_disabled(true);
    return;
  }

  if (peak_review_status) {
    const text = status_text(modeling.peakDetection);
    peak_review_status.textContent = text;
    peak_review_status.hidden = !text;
  }
  set_region_inputs_disabled(false);
  if (region_draft?.rowName !== row.name) {
    region_draft = { rowName: row.name, regions: clone_regions(modeling.peakSelection.regions), valid: true, error: "" };
    fill_region_inputs(region_draft.regions);
  }
  show_region_error(region_draft.error, region_draft.valid ? [] : invalid_region_keys(region_draft.regions));
  if (peak_regions_accept_button) peak_regions_accept_button.disabled = !region_draft.valid;

  // A histogram change (e.g. the Bins control, see bin_settings_sync.js) marks
  // the still-displayed regions stale: they were detected against a different
  // histogram than the plot now shows. Surface that so the user re-detects
  // rather than trusting/fitting mismatched regions -- the region x-bounds
  // themselves are preserved and remain editable in the meantime.
  if (modeling.peakSelection.stale) {
    show_region_error("Bin count changed — re-detect peaks to refresh these regions.");
  }
}

/*

Purpose:
	Runs automatic peak detection. With one sample under review (either the only
	one plotted, or the row clicked into focus) it detects for that sample. With
	several plotted and none singled out, it detects for ALL of them rather than
	doing nothing -- detection is per-sample and independent, so there is no
	reason to make the user focus each row in turn just to get a starting point.

	Each sample is detected independently and a failure on one is reported
	without abandoning the rest: a sample whose histogram has no resolvable
	peak pair should not block its neighbours.

Input:
	(none)

Output:
	(none) [Promise<void>]: stores detected regions and refreshes the panel

*/
async function on_detect_peaks_click() {
  const focused = active_peak_review_row();
  const targets = focused ? [focused] : plottable_rows();
  if (!targets.length) return;

  detect_peaks_button.disabled = true;
  try {
    const pipeline = await load_pipeline();
    const rows = plottable_rows();
    // Build the detection histogram over the explicit analysis domain, so events
    // outside the current x-axis (a manual zoom/override) aren't considered.
    const range = clamp_range_to_analysis_domain(pipeline.shared_histogram_range(rows));

    const failures = [];
    for (const row of targets) {
      try {
        pipeline.ensure_histogram_current(row, { binCount: plot_bin_count(), range });
        detect_peak_regions(row);
      } catch (error) {
        failures.push(`${row.name}: ${error.message}`);
      }
    }
    region_draft = null;
    notify_regions_changed();

    const detected = targets.length - failures.length;
    if (!detected) {
      set_status_bar(`Peak detection failed: ${failures[0]}`, true);
    } else if (failures.length) {
      set_status_bar(
        `Peaks detected for ${detected} of ${targets.length} samples; ${failures.length} failed (${failures[0]}).`,
        true,
      );
    } else if (targets.length === 1) {
      set_status_bar(`Peaks detected for ${targets[0].name}.`);
    } else {
      // UI-09: "click a row" used to send the user to a control that does
      // nothing -- clicking a table row never focuses a sample for review
      // (see the refresh_panel() !row branch above). Name the control that
      // actually does: the Ridge view's per-sample "Manual Review" button.
      set_status_bar(
        `Peaks detected for all ${targets.length} plotted samples. Switch View to Ridge and use a sample's Manual Review button to review one.`,
      );
    }
  } catch (error) {
    set_status_bar(`Peak detection failed: ${error.message}`, true);
  } finally {
    refresh_panel();
  }
}

/*

Purpose:
	Commits an edited region input to the sample's regions; on an invalid entry,
	leaves the typed values in place and shows the error instead of reverting.

Input:
	(none)

Output:
	(none) [void]

*/
function on_region_input_change() {
  const row = active_peak_review_row();
  if (!row) return;
  commit_peak_region_draft(row, read_region_inputs());
}

/*

Purpose:
	Resets the sample's regions to the detected values.

Input:
	(none)

Output:
	(none) [void]

*/
function on_reset_click() {
  const row = active_peak_review_row();
  if (!row) return;
  try {
    reset_peak_regions(row);
    region_draft = null;
    notify_regions_changed();
  } catch (error) {
    set_status_bar(error.message, true);
  }
  refresh_panel();
}

/*

Purpose:
	Accepts the sample's current regions (marking them reviewed) and reports it.

Input:
	(none)

Output:
	(none) [void]

*/
function on_accept_click() {
  const row = active_peak_review_row();
  if (!row || !commit_peak_region_draft(row, read_region_inputs())) return;
  accept_peak_regions(row);
  set_status_bar(`Peak regions accepted for ${row.name}.`);
  refresh_panel();
}

/*

Purpose:
	Wires the Identify Peaks panel's controls and refresh events once.

Input:
	(none)

Output:
	(none) [void]

*/
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
