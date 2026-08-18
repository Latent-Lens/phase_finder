// The Time QC method the pre-modeling QC filter runs, and its per-method
// settings. Kept in one small module (rather than inside pipeline_ui.js) because
// three unrelated places need it: the QC runner that passes it to the Time QC
// operation, the method dialog that edits it, and the session writer that
// persists it.
//
// See docs/plans/peak_tracking_time_qc_implementation_spec.md. "robust-summary"
// is the pre-existing method and stays the default, so a session that never
// touches this behaves exactly as it did before peak tracking existed.
//
// get_time_qc_state(), set_time_qc_state(), and reset_time_qc_state() read and
// update the live configuration; time_qc_method_options() flattens it into the
// options object the Time QC operation takes; time_qc_method_label() names the
// method for the UI; get_time_qc_session_config() and
// apply_time_qc_session_config() serialize it to and from a session file.
// default_state() and the to_number()/to_boolean()/drop_undefined() coercion
// helpers are internal.

import {
  DEFAULT_PEAK_TRACKING_OPTIONS,
  DEFAULT_PEAK_TRACKING_CHANNELS,
  PEAK_TRACKING_ALGORITHM_VERSION,
} from "./peak_tracking_time_qc.js";

export const TIME_QC_METHODS = Object.freeze({
  ROBUST_SUMMARY: "robust-summary",
  PEAK_TRACKING: "peak-tracking",
});

// Channels offered for evaluation, in the order the dialog lists them. The
// internal keys are the pipeline's channel names; the labels are what a
// cytometrist reads on the panel.
export const TIME_QC_CHANNEL_OPTIONS = Object.freeze([
  { key: "DNA_A", label: "DNA-A" },
  { key: "FSC_A", label: "FSC-A" },
  { key: "SSC_A", label: "SSC-A" },
]);

export const DEFAULT_ROBUST_SUMMARY_OPTIONS = Object.freeze({
  targetBinSize: 500,
  threshold: 4,
  includeEventRateCheck: true,
});

/*

Purpose:
	Builds the default Time QC configuration (robust-summary method, default channels
	and per-method options).

Input:
	(none)

Output:
	state [object]: a fresh default configuration

*/
function default_state() {
  return {
    method: TIME_QC_METHODS.ROBUST_SUMMARY,
    selectedChannels: [...DEFAULT_PEAK_TRACKING_CHANNELS],
    robustSummaryOptions: { ...DEFAULT_ROBUST_SUMMARY_OPTIONS },
    peakTrackingOptions: { ...DEFAULT_PEAK_TRACKING_OPTIONS },
  };
}

export function get_default_time_qc_state() {
  return default_state();
}

let state = default_state();

/*

Purpose:
	Reads the current Time QC configuration. Returns a copy so a caller can't
	mutate the live state by holding on to it.

Input:
	(none)

Output:
	state [object]: { method, selectedChannels, robustSummaryOptions, peakTrackingOptions }

*/
export function get_time_qc_state() {
  return {
    method: state.method,
    selectedChannels: [...state.selectedChannels],
    robustSummaryOptions: { ...state.robustSummaryOptions },
    peakTrackingOptions: { ...state.peakTrackingOptions },
  };
}

/*

Purpose:
	Merges a patch into the Time QC configuration, ignoring an unsupported
	method rather than leaving the state in a shape the Time QC operation can't dispatch on.

Input:
	patch [object]: any subset of the state shape

Output:
	state [object]: the updated configuration

*/
export function set_time_qc_state(patch = {}) {
  const candidate = {
    method: patch.method ?? state.method,
    selectedChannels: patch.selectedChannels ?? state.selectedChannels,
    robustSummaryOptions: { ...state.robustSummaryOptions, ...(patch.robustSummaryOptions || {}) },
    peakTrackingOptions: { ...state.peakTrackingOptions, ...(patch.peakTrackingOptions || {}) },
  };
  const checked = validate_time_qc_state(candidate);
  if (!checked.valid) {
    const error = new TypeError(Object.values(checked.errors)[0]);
    error.fieldErrors = checked.errors;
    throw error;
  }
  state = checked.value;
  return get_time_qc_state();
}

export function validate_time_qc_state(candidate) {
  const errors = {};
  const value = {
    method: candidate?.method,
    selectedChannels: Array.isArray(candidate?.selectedChannels) ? [...candidate.selectedChannels] : [],
    robustSummaryOptions: { ...(candidate?.robustSummaryOptions || {}) },
    peakTrackingOptions: { ...(candidate?.peakTrackingOptions || {}) },
  };
  const number = (field, input, { min, max = Infinity, integer = false }) => {
    if (!Number.isFinite(input) || input < min || input > max || (integer && !Number.isInteger(input))) {
      errors[field] = `${field} must be ${integer ? "a whole number" : "a number"} from ${min}${max < Infinity ? ` to ${max}` : " or greater"}.`;
    }
  };

  if (!Object.values(TIME_QC_METHODS).includes(value.method)) errors.method = "Choose a supported Time QC method.";
  const allowed = new Set(TIME_QC_CHANNEL_OPTIONS.map((option) => option.key));
  if (!value.selectedChannels.length || value.selectedChannels.some((channel) => !allowed.has(channel))) {
    errors.selectedChannels = "Choose at least one supported channel.";
  }
  value.selectedChannels = [...new Set(value.selectedChannels)];

  const robust = value.robustSummaryOptions;
  number("targetBinSize", robust.targetBinSize, { min: 50, integer: true });
  number("threshold", robust.threshold, { min: 1, max: 20 });

  const peak = value.peakTrackingOptions;
  number("minimumEventsPerBin", peak.minimumEventsPerBin, { min: 20, integer: true });
  number("maximumBins", peak.maximumBins, { min: 10, integer: true });
  number("overlapFraction", peak.overlapFraction, { min: 0, max: 0.95 });
  number("minimumRelativePeakHeight", peak.minimumRelativePeakHeight, { min: 0.05, max: 0.95 });
  number("isolationTreeGainThreshold", peak.isolationTreeGainThreshold, { min: 0, max: 1 });
  number("madMultiplier", peak.madMultiplier, { min: 1, max: 50 });
  number("minimumGoodRunBins", peak.minimumGoodRunBins, { min: 1, integer: true });
  if (Number.isFinite(peak.minimumGoodRunBins) && Number.isFinite(peak.maximumBins)
      && peak.minimumGoodRunBins > peak.maximumBins) {
    errors.minimumGoodRunBins = "Minimum good-run bins cannot exceed maximum bins.";
  }
  for (const [field, input] of [
    ["robustIncludeEventRateCheck", robust.includeEventRateCheck],
    ["isolationTreeEnabled", peak.isolationTreeEnabled],
    ["peakIncludeEventRateCheck", peak.includeEventRateCheck],
  ]) {
    if (typeof input !== "boolean") errors[field] = `${field} must be true or false.`;
  }
  return { valid: Object.keys(errors).length === 0, value, errors };
}

/*

Purpose:
	Restores the shipped defaults (used by session reset and the dialog's Reset).

Input:
	(none)

Output:
	state [object]: the reset configuration

*/
export function reset_time_qc_state() {
  state = default_state();
  return get_time_qc_state();
}

/*

Purpose:
	Flattens the configuration into the single options object the Time QC operation takes,
	so callers never have to know which method's settings apply.

Input:
	(none)

Output:
	options [object]: `method` plus that method's settings

*/
export function time_qc_method_options() {
  if (state.method === TIME_QC_METHODS.PEAK_TRACKING) {
    return {
      method: TIME_QC_METHODS.PEAK_TRACKING,
      channels: [...state.selectedChannels],
      ...state.peakTrackingOptions,
    };
  }
  return { method: TIME_QC_METHODS.ROBUST_SUMMARY, ...state.robustSummaryOptions };
}

/*

Purpose:
	Human-readable method name for status messages and the result summary.

Input:
	method [string]: the method id (defaults to the current method)

Output:
	label [string]: the display name

*/
export function time_qc_method_label(method = state.method) {
  return method === TIME_QC_METHODS.PEAK_TRACKING ? "Peak-tracking QC" : "Robust summary QC";
}

/*

Purpose:
	The reproducibility record for the session file and reports: the method, the
	channels it evaluated, the settings it used, and the algorithm version, so a
	result can be traced back to exactly how it was produced.

Input:
	(none)

Output:
	config [object]: flat, serializable Time QC configuration

*/
export function get_time_qc_session_config() {
  const peak_tracking = state.method === TIME_QC_METHODS.PEAK_TRACKING;
  return {
    method: state.method,
    selected_channels: [...state.selectedChannels],
    // SCI-12 changes n/duration to the unbiased (n-1)/duration estimator. At
    // the 150-event minimum the correction is <0.7%, below the existing 1%
    // rate-spread floor, so thresholds stay unchanged but provenance is bumped.
    algorithm_version: peak_tracking ? PEAK_TRACKING_ALGORITHM_VERSION : "robust-summary-v2",
    ...(peak_tracking
      ? {
          minimum_events_per_bin: state.peakTrackingOptions.minimumEventsPerBin,
          maximum_bins: state.peakTrackingOptions.maximumBins,
          overlap_fraction: state.peakTrackingOptions.overlapFraction,
          minimum_relative_peak_height: state.peakTrackingOptions.minimumRelativePeakHeight,
          isolation_tree_enabled: state.peakTrackingOptions.isolationTreeEnabled,
          isolation_tree_gain_threshold: state.peakTrackingOptions.isolationTreeGainThreshold,
          mad_multiplier: state.peakTrackingOptions.madMultiplier,
          minimum_good_run_bins: state.peakTrackingOptions.minimumGoodRunBins,
          include_event_rate_check: state.peakTrackingOptions.includeEventRateCheck,
        }
      : {
          target_bin_size: state.robustSummaryOptions.targetBinSize,
          z_threshold: state.robustSummaryOptions.threshold,
          include_event_rate_check: state.robustSummaryOptions.includeEventRateCheck,
        }),
  };
}

/*

Purpose:
	Restores a saved Time QC configuration from a session file, tolerating a file
	written before this feature existed (or by a newer version with fields this
	build doesn't know) by falling back to the defaults per field.

Input:
	config [object]: the `[time_qc]` section of a session file

Output:
	state [object]: the restored configuration

*/
export function apply_time_qc_session_config(config) {
  if (!config) return get_time_qc_state();
  const patch = get_default_time_qc_state();
  patch.method = config.method;
  if (Array.isArray(config.selected_channels) && config.selected_channels.length) {
    patch.selectedChannels = config.selected_channels;
  }
  if (config.method === TIME_QC_METHODS.PEAK_TRACKING) {
    patch.peakTrackingOptions = { ...patch.peakTrackingOptions, ...drop_undefined({
      minimumEventsPerBin: to_number(config.minimum_events_per_bin),
      maximumBins: to_number(config.maximum_bins),
      overlapFraction: to_number(config.overlap_fraction),
      minimumRelativePeakHeight: to_number(config.minimum_relative_peak_height),
      isolationTreeEnabled: to_boolean(config.isolation_tree_enabled),
      isolationTreeGainThreshold: to_number(config.isolation_tree_gain_threshold),
      madMultiplier: to_number(config.mad_multiplier),
      minimumGoodRunBins: to_number(config.minimum_good_run_bins),
      includeEventRateCheck: to_boolean(config.include_event_rate_check),
    }) };
  } else {
    patch.robustSummaryOptions = { ...patch.robustSummaryOptions, ...drop_undefined({
      targetBinSize: to_number(config.target_bin_size),
      threshold: to_number(config.z_threshold),
      includeEventRateCheck: to_boolean(config.include_event_rate_check),
    }) };
  }
  return set_time_qc_state(patch);
}

/*

Purpose:
	Coerces a value to a finite number, or undefined when it isn't finite (so
	drop_undefined can omit it).

Input:
	value [any]: the value to coerce

Output:
	number [number|undefined]: the finite number, or undefined

*/
function to_number(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

/*

Purpose:
	Coerces a value to a boolean from true/false or the strings "true"/"false", or
	undefined otherwise.

Input:
	value [any]: the value to coerce

Output:
	boolean [boolean|undefined]: the boolean, or undefined

*/
function to_boolean(value) {
  if (value === true || value === false) return value;
  if (value === "true") return true;
  if (value === "false") return false;
  return undefined;
}

/*

Purpose:
	Returns a copy of an object with the undefined-valued keys removed, so a partial
	patch never overwrites live settings with undefined.

Input:
	object [object]: the object to filter

Output:
	result [object]: the object without undefined values

*/
function drop_undefined(object) {
  const result = {};
  for (const [key, value] of Object.entries(object)) {
    if (value !== undefined) result[key] = value;
  }
  return result;
}
