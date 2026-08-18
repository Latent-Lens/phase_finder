// The Time QC method dialog: offered when the user turns on the "2. Time" QC
// filter, and reachable afterwards from the "Change…" link under the QC buttons.
//
// It picks between the two Time QC methods (see time_qc_settings.js), chooses
// which channels are evaluated, and exposes each method's parameters behind an
// "Advanced settings" disclosure -- the spec's Phase 1 shape: a normal user
// selects a method and runs it without touching a single number.
//
// The dialog only edits configuration. Running the QC filter is the caller's job:
// Apply resolves the open() promise with the chosen settings, Cancel resolves
// with null so the caller can leave the filter off.
//
// open_time_qc_method_modal() opens the dialog and resolves with the chosen
// settings (or null); init_time_qc_modal() wires listeners once. Internally,
// fill_form() and commit_form() move state to and from the form,
// render_channel_checkboxes() and read_channels() handle the channel list,
// selected_method() and sync_method_visibility() track the chosen method, and
// close() resolves the open() promise.

import {
  TIME_QC_METHODS,
  TIME_QC_CHANNEL_OPTIONS,
  get_time_qc_state,
  get_default_time_qc_state,
  set_time_qc_state,
  validate_time_qc_state,
} from "./time_qc_settings.js";

const modal = document.querySelector("#time_qc_method_modal");
const channels_container = document.querySelector("#time_qc_channels");
const robust_settings = document.querySelector("#time_qc_robust_settings");
const peak_settings = document.querySelector("#time_qc_peak_settings");
const event_rate_input = document.querySelector("#time_qc_event_rate");
const note = document.querySelector("#time_qc_method_note");
const apply_button = document.querySelector("#time_qc_method_apply");

// Advanced numeric fields, mapped to where each one lives in the state.
const NUMERIC_FIELDS = [
  ["#time_qc_target_bin_size", "robustSummaryOptions", "targetBinSize"],
  ["#time_qc_z_threshold", "robustSummaryOptions", "threshold"],
  ["#time_qc_min_events", "peakTrackingOptions", "minimumEventsPerBin"],
  ["#time_qc_max_bins", "peakTrackingOptions", "maximumBins"],
  ["#time_qc_overlap", "peakTrackingOptions", "overlapFraction"],
  ["#time_qc_peak_height", "peakTrackingOptions", "minimumRelativePeakHeight"],
  ["#time_qc_tree_gain", "peakTrackingOptions", "isolationTreeGainThreshold"],
  ["#time_qc_mad_multiplier", "peakTrackingOptions", "madMultiplier"],
  ["#time_qc_min_run", "peakTrackingOptions", "minimumGoodRunBins"],
];

const isolation_tree_input = document.querySelector("#time_qc_isolation_tree");

let initialized = false;
let resolve_open = null;
let draft = null;
let active_method = TIME_QC_METHODS.ROBUST_SUMMARY;

/*

Purpose:
	Returns the method the dialog's radio buttons currently select, defaulting to
	robust-summary.

Input:
	(none)

Output:
	method [string]: the selected Time QC method id

*/
function selected_method() {
  const checked = modal?.querySelector("input[name='time_qc_method']:checked");
  return checked ? checked.value : TIME_QC_METHODS.ROBUST_SUMMARY;
}

/*

Purpose:
	Shows only the active method's parameters (and its explanatory note), so the
	dialog never implies a setting is in effect when it isn't.

Input:
	(none)

Output:
	(none) [void]: toggles the settings groups and note text

*/
function sync_method_visibility() {
  const peak_tracking = selected_method() === TIME_QC_METHODS.PEAK_TRACKING;
  if (robust_settings) robust_settings.hidden = peak_tracking;
  if (peak_settings) peak_settings.hidden = !peak_tracking;
  if (note) {
    note.textContent = peak_tracking
      ? "Peak-tracking QC is more sensitive to population shifts that may not strongly change the overall median. It takes longer to run and can be overly aggressive when a selected channel genuinely changes during acquisition."
      : "Robust summary QC scores each acquisition bin's event rate, medians, and IQRs against the run as a whole, and rejects bins that fall outside the robust z-score threshold.";
  }
}

/*

Purpose:
	Rebuilds the channel checkboxes from the configured options, checking the ones
	currently selected.

Input:
	selected [array]: the currently selected channel keys

Output:
	(none) [void]: replaces the checkbox list in the DOM

*/
function render_channel_checkboxes(selected) {
  if (!channels_container) return;
  channels_container.innerHTML = "";
  const chosen = new Set(selected);
  for (const option of TIME_QC_CHANNEL_OPTIONS) {
    const label = document.createElement("label");
    label.className = "time_qc_checkbox";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.value = option.key;
    input.checked = chosen.has(option.key);
    input.dataset.timeQcChannel = option.key;
    const text = document.createElement("span");
    text.textContent = option.label;
    label.append(input, text);
    channels_container.append(label);
  }
}

/*

Purpose:
	Reads which channels are currently checked in the dialog.

Input:
	(none)

Output:
	channels [array]: the checked channel keys

*/
function read_channels() {
  if (!channels_container) return [];
  return [...channels_container.querySelectorAll("input[data-time-qc-channel]")]
    .filter((input) => input.checked)
    .map((input) => input.value);
}

/*

Purpose:
	Loads the live Time QC state into the form (method, channels, numeric fields,
	toggles) and syncs which method's settings are visible.

Input:
	state [object]: the Time QC configuration to display

Output:
	(none) [void]: populates the form controls

*/
function fill_form(state) {
  modal?.querySelectorAll("input").forEach((input) => input.setCustomValidity(""));
  draft = {
    method: state.method,
    selectedChannels: [...state.selectedChannels],
    robustSummaryOptions: { ...state.robustSummaryOptions },
    peakTrackingOptions: { ...state.peakTrackingOptions },
  };
  active_method = state.method;
  const method_input = modal?.querySelector(`input[name='time_qc_method'][value='${state.method}']`);
  if (method_input) method_input.checked = true;
  render_channel_checkboxes(state.selectedChannels);

  for (const [selector, group, key] of NUMERIC_FIELDS) {
    const input = document.querySelector(selector);
    if (input) input.value = state[group][key];
  }
  if (isolation_tree_input) isolation_tree_input.checked = Boolean(state.peakTrackingOptions.isolationTreeEnabled);
  // Both methods have an event-rate check; the dialog shows one control for it
  // and writes it to whichever method is active on apply.
  if (event_rate_input) {
    event_rate_input.checked = state.method === TIME_QC_METHODS.PEAK_TRACKING
      ? Boolean(state.peakTrackingOptions.includeEventRateCheck)
      : Boolean(state.robustSummaryOptions.includeEventRateCheck);
  }
  sync_method_visibility();
}

/*

Purpose:
	Reads the form and writes it back into the shared Time QC state (method,
	channels, and each method's numeric/toggle settings).

Input:
	(none)

Output:
	state [object]: the updated Time QC configuration

*/
function save_form_to_draft(method = active_method) {
  if (!draft) return;
  draft.selectedChannels = read_channels();

  for (const [selector, group, key] of NUMERIC_FIELDS) {
    const input = document.querySelector(selector);
    if (!input) continue;
    draft[group][key] = Number(input.value);
  }
  if (isolation_tree_input) draft.peakTrackingOptions.isolationTreeEnabled = isolation_tree_input.checked;
  if (event_rate_input) {
    const group = method === TIME_QC_METHODS.PEAK_TRACKING ? "peakTrackingOptions" : "robustSummaryOptions";
    draft[group].includeEventRateCheck = event_rate_input.checked;
  }
}

function switch_method() {
  save_form_to_draft(active_method);
  active_method = selected_method();
  draft.method = active_method;
  if (event_rate_input) {
    const group = active_method === TIME_QC_METHODS.PEAK_TRACKING ? "peakTrackingOptions" : "robustSummaryOptions";
    event_rate_input.checked = Boolean(draft[group].includeEventRateCheck);
  }
  sync_method_visibility();
}

const ERROR_CONTROLS = {
  method: "input[name='time_qc_method']",
  selectedChannels: "#time_qc_channels input",
  targetBinSize: "#time_qc_target_bin_size",
  threshold: "#time_qc_z_threshold",
  minimumEventsPerBin: "#time_qc_min_events",
  maximumBins: "#time_qc_max_bins",
  overlapFraction: "#time_qc_overlap",
  minimumRelativePeakHeight: "#time_qc_peak_height",
  isolationTreeGainThreshold: "#time_qc_tree_gain",
  madMultiplier: "#time_qc_mad_multiplier",
  minimumGoodRunBins: "#time_qc_min_run",
};

function commit_form() {
  save_form_to_draft(active_method);
  draft.method = selected_method();
  modal.querySelectorAll("input").forEach((input) => input.setCustomValidity(""));
  const checked = validate_time_qc_state(draft);
  if (!checked.valid) {
    const [field, message] = Object.entries(checked.errors)[0];
    const control = modal.querySelector(ERROR_CONTROLS[field] || "input");
    control?.setCustomValidity(message);
    control?.reportValidity();
    return null;
  }

  return set_time_qc_state(checked.value);
}

/*

Purpose:
	Hides the dialog and resolves the pending open() promise with the given result.

Input:
	result [object|null]: the value to resolve with (committed state, or null)

Output:
	(none) [void]

*/
function close(result) {
  if (modal) modal.hidden = true;
  const resolve = resolve_open;
  resolve_open = null;
  resolve?.(result);
}

/*

Purpose:
	Wires the dialog's listeners (method radios, backdrop/close/cancel/reset/apply
	buttons, keyboard) once.

Input:
	(none)

Output:
	(none) [void]

*/
function init() {
  if (initialized || !modal) return;
  initialized = true;

  modal.querySelectorAll("input[name='time_qc_method']").forEach((input) => {
    input.addEventListener("change", switch_method);
  });
  modal.querySelector(".stats_modal_backdrop")?.addEventListener("click", () => close(null));
  document.querySelector("#time_qc_method_close")?.addEventListener("click", () => close(null));
  document.querySelector("#time_qc_method_cancel")?.addEventListener("click", () => close(null));
  document.querySelector("#time_qc_method_reset")?.addEventListener("click", () => {
    fill_form(get_default_time_qc_state());
  });
  apply_button?.addEventListener("click", () => {
    const committed = commit_form();
    if (committed) close(committed);
  });
  modal.addEventListener("keydown", (event) => {
    if (event.key === "Escape") close(null);
    else if (event.key === "Enter" && event.target.tagName !== "BUTTON") {
      const committed = commit_form();
      if (committed) close(committed);
    }
  });
}

/*

Purpose:
	Opens the Time QC method dialog, prefilled from the current configuration,
	and resolves once the user applies or dismisses it.

Input:
	options [object]: { applyLabel } — the confirm button's text, so the dialog
	                  can read "Run Time QC" when turning the filter on and
	                  "Apply" when only changing an already-applied method

Output:
	settings [Promise<object|null>]: the committed Time QC state, or null if the
	                                 user cancelled (leave the filter unchanged)

*/
export function open_time_qc_method_modal({ applyLabel = "Run Time QC" } = {}) {
  init();
  if (!modal) return Promise.resolve(null);
  // A second open while one is pending would strand the first promise.
  if (resolve_open) close(null);

  fill_form(get_time_qc_state());
  if (apply_button) apply_button.textContent = applyLabel;
  modal.hidden = false;
  modal.querySelector("input[name='time_qc_method']:checked")?.focus();

  return new Promise((resolve) => {
    resolve_open = resolve;
  });
}

/*

Purpose:
	Exposed so the entry bootstrap can wire the dialog's listeners once at startup.

Input:
	(none)

Output:
	(none) [void]

*/
export function init_time_qc_modal() {
  init();
}
