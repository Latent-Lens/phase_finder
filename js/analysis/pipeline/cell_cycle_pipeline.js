// Orchestrator for the cell-cycle QC + modeling pipeline. Each apply_*() entry
// point runs exactly one stage, stores its diagnostics on the per-sample
// state, composes/clears the QC-filter masks, and invalidates downstream
// products; optional missing-channel stages leave a null mask. The five
// stages, in order, are structural QC, Time QC, the Cell Gate, the Singlet
// Gate, and the DNA histogram; modeling runs off the finished histogram through
// the model registry. apply_structural_qc_fast() and apply_time_qc_fast() reuse
// the eager background precompute (precompute_prefilter_qc()); update_cell_gate()
// edits the Cell Gate ellipse; shared_histogram_range() derives one bin range
// spanning several samples so a batch build shares identical bins;
// reset_qc_gates() clears all QC masks;
// pipeline_filter_funnel() and pipeline_table_stats() produce the metadata-table
// summaries. Numeric work lives in the imported per-stage modules; this file
// only sequences them and manages state.

import { plottable_rows } from "../../plotting/data.js";
import * as structuralQc from "../qc/structural_qc.js";
import * as timeQc from "../qc/acquisition_time_qc.js";
import * as peakTrackingTimeQc from "../qc/peak_tracking_time_qc.js";
import * as cellGate from "../gating/scatter_gmm_gate.js";
import * as singletGate from "../gating/pulse_geometry_gate.js";
import * as dnaHistogram from "./dna_histogram.js";
import {
  pipeline_states,
  get_state,
  get_active_model_result,
  get_or_create_state,
  clear_state,
  combined_mask_before,
  set_filter_mask,
  invalidate_after,
  recompute_final_mask,
  build_filtered_view,
  invalidate_histogram_dependents,
  invalidate_model_results,
  invalidate_model_config_result,
} from "./pipeline_state.js";
import { rotateCovariance2D } from "../math/linalg2d.js";
import { resolve_pnr_for_dataset } from "../qc/structural_qc_settings.js";
import { register_default_models, get_model } from "../cell_cycle/model_registry.js";
import { MINIMUM_MODELING_EVENTS, MINIMUM_NONEMPTY_BINS } from "../cell_cycle/result_contract.js";

// This module is already lazy-loaded as a whole (see pipeline_loader.js), so
// registering the (currently one-entry) model set here at load time carries
// no extra critical-path cost.
register_default_models();

export { structuralQc, timeQc, cellGate, singletGate, dnaHistogram };
export { peakTrackingTimeQc };
export {
  pipeline_states,
  get_state,
  get_or_create_state,
  clear_state,
  recompute_final_mask,
  invalidate_histogram_dependents,
  invalidate_model_results,
  invalidate_model_config_result,
};

/*

Purpose:
	Returns row.data, throwing a clear error when no DNA-area channel is loaded and
	plotted (the precondition every stage shares).

Input:
	row [object]: the sample row

Output:
	data [object]: row.data (throws when the DNA-area channel is missing)

*/
function require_row_data(row) {
  if (!row || !row.data || !row.data.channels?.DNA_A) {
    throw new Error("Load and plot a DNA-area channel before running the DJF pipeline.");
  }
  return row.data;
}

/*

Purpose:
	Wraps one stage's output in the common return envelope every apply_*()
	shares.

Input:
	stage_index [number]: the stage's index
	row [object]: the sample row
	result [object]: the stage's result
	state [object]: the per-sample pipeline state

Output:
	envelope [object]: { stageIndex, name, channel, result, state }

*/
function stage_result(stage_index, row, result, state) {
  return {
    stageIndex: stage_index,
    name: row.name,
    channel: row.data.channel_key,
    result,
    state,
  };
}

/*

Purpose:
	Deep-copies a scatter GMM component (mean and covariance arrays) so an edited
	gate never mutates the fitted component it was derived from.

Input:
	component [object|null]: a scatter component

Output:
	clone [object|null]: an independent copy, or null

*/
function clone_scatter_component(component) {
  if (!component) return null;
  return {
    ...component,
    mean: Array.from(component.mean ?? []),
    covariance: Array.from(
      component.covariance ?? [],
      row => Array.from(row ?? []),
    ),
  };
}

/*

Purpose:
	Validates and coerces a cell-gate center to a finite [FSC-A, SSC-A] pair.

Input:
	mean [array]: the candidate center

Output:
	center [array]: [fsc, ssc] as numbers (throws when not finite)

*/
function validate_scatter_gate_center(mean) {
  if (
    !mean ||
    mean.length !== 2 ||
    !Number.isFinite(mean[0]) ||
    !Number.isFinite(mean[1])
  ) {
    throw new RangeError("The cell-gate center must contain finite FSC-A and SSC-A values.");
  }
  return [Number(mean[0]), Number(mean[1])];
}

/*

Purpose:
	Validates a cell-gate coverage fraction (strictly between 0 and 1).

Input:
	coverage [number]: the coverage fraction

Output:
	coverage [number]: the coerced value (throws when out of range)

*/
function validate_scatter_gate_coverage(coverage) {
  const value = Number(coverage);
  if (!Number.isFinite(value) || !(value > 0) || !(value < 1)) {
    throw new RangeError("The cell-gate coverage must be greater than 0 and less than 1.");
  }
  return value;
}

/*

Purpose:
	Converts a coverage fraction into the squared-Mahalanobis threshold that
	captures it. For two dimensions the squared Mahalanobis distance follows
	chi-square(2), whose inverse CDF has this closed form.

Input:
	coverage [number]: the target coverage fraction

Output:
	threshold [number]: the squared-Mahalanobis threshold

*/
function scatter_threshold_for_coverage(coverage) {
  return -2 * Math.log1p(-validate_scatter_gate_coverage(coverage));
}

/*

Purpose:
	Counts the retained (truthy) entries in a mask.

Input:
	mask [array]: an event mask

Output:
	count [number]: the number of retained events

*/
function count_retained(mask) {
  let count = 0;
  for (const retained of mask ?? []) count += retained ? 1 : 0;
  return count;
}

/*

Purpose:
	Stores a structural-QC result on the state, installs its mask as QC filter 0,
	invalidates downstream products, and returns the stage envelope.

Input:
	row [object]: the sample row
	result [object]: the structural-QC result

Output:
	envelope [object]: the stage result envelope

*/
function commit_structural_qc(row, result) {
  const state = get_or_create_state(row);
  state.structuralQC = result;
  state.structuralMask = result.structuralMask;
  set_filter_mask(row, 0, result.structuralMask);
  invalidate_after(row, state, 0);
  return stage_result(0, row, result, state);
}

/*

Purpose:
	Stores a Time QC result on the state, installs its mask as QC filter 1 (null
	when skipped), invalidates downstream products, and returns the envelope.

Input:
	row [object]: the sample row
	result [object]: the Time QC result

Output:
	envelope [object]: the stage result envelope

*/
function commit_time_qc(row, result) {
  const state = get_or_create_state(row);
  state.timeQC = result;
  set_filter_mask(row, 1, result.skipped ? null : result.timeQCMask);
  invalidate_after(row, state, 1);
  return stage_result(1, row, result, state);
}

/*

Purpose:
	Runs structural QC for a sample and commits it (stage 0).

Input:
	row [object]: the sample row
	options [object]: { pnr } saturation overrides -- defaults to the live
	                  Structural QC settings (structural_qc_settings.js) merged
	                  with this dataset's own $PnR values when omitted

Output:
	envelope [object]: the stage result envelope

*/
export function apply_structural_qc(row, options = {}) {
  const data = require_row_data(row);
  const pnr = options.pnr ?? resolve_pnr_for_dataset(data.pnr);
  const result = structuralQc.runStructuralQC(data, pnr);
  return commit_structural_qc(row, result);
}

// Time QC has two interchangeable methods (see
// docs/plans/peak_tracking_time_qc_implementation_spec.md). Both return the same
// Time QC result contract -- mask/timeQCMask plus retained/rejected counts -- so
// everything downstream is unaware of which one ran. "robust-summary" stays the
// default, so an options object that never mentions a method behaves exactly as
// it did before peak tracking existed.
export const TIME_QC_METHODS = Object.freeze(["robust-summary", "peak-tracking"]);
export const DEFAULT_TIME_QC_METHOD = "robust-summary";

/*

Purpose:
	Dispatches Time QC to the selected method (robust-summary or peak-tracking),
	tagging the result with its method.

Input:
	data [object]: row.data
	structuralMask [array|null]: the structural mask, or null
	options [object]: { method, ...method-specific settings }

Output:
	result [object]: the Time QC result (throws on an unsupported method)

*/
function run_time_qc(data, structuralMask, options = {}) {
  const method = options.method || DEFAULT_TIME_QC_METHOD;
  let result;
  if (method === "peak-tracking") {
    result = peakTrackingTimeQc.runPeakTrackingTimeQC(data, structuralMask, options);
  } else if (method === DEFAULT_TIME_QC_METHOD) {
    result = { ...timeQc.runTimeQC(data, structuralMask, options), method: DEFAULT_TIME_QC_METHOD };
  } else {
    throw new Error(`Unsupported Time QC method: ${method}`);
  }
  // QC-02 provenance: the exact resolved config, its cache-identity hash, the
  // algorithm version, and the input identity this result was computed against,
  // so a session/report can prove which configuration produced which mask.
  const resolved = resolve_time_qc_config(options);
  result.optionsUsed = result.optionsUsed ?? resolved.settings;
  result.algorithmVersion = result.algorithmVersion ?? resolved.algorithmVersion;
  result.configHash = time_qc_cache_key(options, Boolean(structuralMask));
  result.inputIdentity = {
    channelKey: data?.channel_key ?? null,
    eventCount: data?.eventCount ?? null,
    structuralActive: Boolean(structuralMask),
  };
  return result;
}

/*

Purpose:
	Runs Time QC for a sample using its current structural mask and commits it
	(stage 1).

Input:
	row [object]: the sample row
	options [object]: the Time QC options (method + settings)

Output:
	envelope [object]: the stage result envelope

*/
export function apply_time_qc(row, options = {}) {
  const data = require_row_data(row);
  const structuralMask = data.masks?.structural ?? null;
  const result = run_time_qc(data, structuralMask, options);
  return commit_time_qc(row, result);
}

// ── Eager structural / Time QC precompute cache ──────────────────────────────
// Structural QC has no dependency, so it has exactly one correct result per row.
// Time QC depends on one thing -- whether structural QC is active -- so it has
// two possible correct results per row (scored with or without the structural
// mask). Both are cheap and common enough to compute eagerly, in the
// background, as soon as a channel is plotted, rather than only ever on
// demand when the user checks a Pre-model QC box. Keyed by row name like
// pipeline_states, and invalidated the same way (channel/event-count change).
// The Cell and Singlet gates are not cached here: their dependency space grows
// combinatorially (up to 4 and 8 variants), so they stay computed on demand.
const qc_precompute_cache = new Map();

/*

Purpose:
	Returns this row's precompute-cache entry, replacing it with a fresh one when
	the channel or event count no longer matches.

Input:
	row [object]: the sample row
	data [object]: row.data

Output:
	entry [object]: { channelKey, eventCount, structuralQc, timeQc }

*/
function get_precompute_entry(row, data) {
  const existing = qc_precompute_cache.get(row.name);
  if (existing && existing.channelKey === data.channel_key && existing.eventCount === data.eventCount) {
    return existing;
  }
  const fresh = {
    channelKey: data.channel_key,
    eventCount: data.eventCount,
    structuralQc: null,
    timeQc: new Map(),
    // Fitted-gate caches keyed by composed-input-mask hash + gate options, so
    // re-applying a gate whose upstream is unchanged reuses the prior fit.
    scatterGate: new Map(),
    singletGate: new Map(),
  };
  qc_precompute_cache.set(row.name, fresh);
  return fresh;
}

/*

Purpose:
	Clears the eager structural/Time QC precompute cache for every row, forcing
	the next apply_structural_qc_fast()/apply_time_qc_fast() to recompute from
	scratch. Time QC is conditioned on the structural mask (see
	precompute_prefilter_qc), so a Structural QC settings change (its saturation
	ceiling overrides, see structural_qc_settings.js) invalidates both, not just
	Structural QC's own cached result.

Input:
	(none)

Output:
	(none) [void]

*/
export function invalidate_qc_precompute_cache() {
  qc_precompute_cache.clear();
}

// Order-independent JSON: object keys sorted recursively, so two semantically
// identical configs with different key insertion order hash to the same string
// (QC-02). Undefined values normalize to null so their presence is stable.
function stable_stringify(value) {
  if (Array.isArray(value)) return `[${value.map(stable_stringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable_stringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

/*

Purpose:
	QC-02: builds the ONE canonical resolved Time QC configuration for a method.
	It merges the method's full default option set with the caller's overrides, so
	every analysis-affecting field is present and nothing can be silently omitted
	from the cache key (which is how `includeEventRateCheck` and several peak-
	tracking settings were previously dropped). The method's algorithm version is
	stamped, and selected channels are sorted so selection order never changes
	identity. These option sets contain no presentation-only fields.

Input:
	options [object]: the Time QC options (may be partial; e.g. {} for precompute)

Output:
	config [object]: { method, algorithmVersion, settings, channels? }

*/
export function resolve_time_qc_config(options = {}) {
  const method = options?.method || DEFAULT_TIME_QC_METHOD;
  if (method === "peak-tracking") {
    const { method: _method, channels, ...rest } = options;
    return {
      method: "peak-tracking",
      algorithmVersion: peakTrackingTimeQc.PEAK_TRACKING_ALGORITHM_VERSION,
      channels: [...(channels ?? peakTrackingTimeQc.DEFAULT_PEAK_TRACKING_CHANNELS)].map(String).sort(),
      settings: { ...peakTrackingTimeQc.DEFAULT_PEAK_TRACKING_OPTIONS, ...rest },
    };
  }
  const { method: _method, ...rest } = options;
  return {
    method: "robust-summary",
    algorithmVersion: timeQc.ROBUST_SUMMARY_ALGORITHM_VERSION,
    settings: { ...timeQc.DEFAULT_ROBUST_SUMMARY_OPTIONS, ...rest },
  };
}

/*

Purpose:
	Builds the Time QC cache key from the canonical resolved config (method, all
	effective options, algorithm version, and selected channels) plus whether the
	structural mask conditioned the run, hashed order-independently. Any changed
	effective option produces a different key (cache miss); any equivalent config
	produces the same key (cache hit).

Input:
	options [object]: the Time QC options
	structuralActive [boolean]: whether the structural mask conditioned this run

Output:
	key [string]: the cache key

*/
export function time_qc_cache_key(options, structuralActive) {
  return `${stable_stringify(resolve_time_qc_config(options))}|s=${structuralActive ? 1 : 0}`;
}

// Fast content hash (FNV-1a) of an event mask for the fitted-gate caches: a null
// mask (all-pass / absent) hashes to a fixed sentinel, and the length is included
// so masks of different lengths never collide. O(n) with a tiny per-byte constant
// -- negligible next to the GMM/ridge fit the cache guards.
function hash_mask(mask) {
  if (!mask) return "none";
  let hash = 0x811c9dc5;
  for (let index = 0; index < mask.length; index += 1) {
    hash = Math.imul(hash ^ mask[index], 0x01000193);
  }
  return `${mask.length}:${(hash >>> 0).toString(16)}`;
}

/*

Purpose:
	Cache key for a Cell Gate (scatter GMM) fit. The GMM is estimated from the
	events surviving the structural and Time QC masks, so those two mask contents
	plus the gate options fully determine the fit -- re-applying with an unchanged
	upstream (e.g. adding only the Singlet gate) reuses the cached fit instead of
	re-fitting. The channel data itself is pinned by the precompute entry's
	(channelKey, eventCount) identity, so it need not enter the key.

Input:
	structuralMask [array|null]: the structural mask conditioning the fit
	timeQCMask [array|null]: the Time QC mask conditioning the fit
	options [object]: the Cell Gate options

Output:
	key [string]: the cache key

*/
export function cell_gate_cache_key(structuralMask, timeQCMask, options) {
  return `${hash_mask(structuralMask)}|${hash_mask(timeQCMask)}|${stable_stringify(options)}`;
}

/*

Purpose:
	Cache key for a Singlet Gate (pulse-geometry ridge) fit. The ridge is estimated
	from the composed upstream mask (structural AND Time QC AND Cell Gate), so that
	one mask's content plus the gate options fully determine the fit.

Input:
	inputMask [array|null]: the composed upstream mask the ridge is fit over
	options [object]: the Singlet Gate options

Output:
	key [string]: the cache key

*/
export function singlet_gate_cache_key(inputMask, options) {
  return `${hash_mask(inputMask)}|${stable_stringify(options)}`;
}

/*

Purpose:
	Eagerly fills the structural / Time QC cache for every row, without touching
	row.data.masks or pipeline state -- pure precompute, safe to run in the
	background before the user has checked any QC box. Call after a channel finishes
	plotting. Only the robust-summary method is precomputed (it is cheap and the
	usual default); peak tracking runs a per-bin per-channel KDE, too expensive to
	speculatively run, so it is computed and cached on first use.

Input:
	rows [array]: the sample rows to precompute

Output:
	(none) [void]: fills the module's precompute cache

*/
export function precompute_prefilter_qc(rows) {
  for (const row of rows) {
    let data;
    try {
      data = require_row_data(row);
    } catch (_) {
      continue; // this row's channel data isn't loaded yet
    }
    const entry = get_precompute_entry(row, data);

    if (!entry.structuralQc) {
      try {
        entry.structuralQc = structuralQc.runStructuralQC(data, resolve_pnr_for_dataset(data.pnr));
      } catch (error) {
        entry.structuralQc = { error };
      }
    }
    const structuralMask = entry.structuralQc && !entry.structuralQc.error ? entry.structuralQc.structuralMask : null;

    for (const withStructural of [false, true]) {
      if (withStructural && !structuralMask) continue; // no valid structural mask to condition on
      const key = time_qc_cache_key({}, withStructural);
      if (entry.timeQc.has(key)) continue;
      try {
        entry.timeQc.set(key, run_time_qc(data, withStructural ? structuralMask : null, {}));
      } catch (error) {
        entry.timeQc.set(key, { error });
      }
    }
  }
}

/*

Purpose:
	Runs structural QC (stage 0) reusing the eager precompute's result when it's
	still valid, falling back to a fresh run otherwise.

Input:
	row [object]: the sample row

Output:
	envelope [object]: the stage result envelope

*/
export function apply_structural_qc_fast(row) {
  const data = require_row_data(row);
  const entry = get_precompute_entry(row, data);
  if (!entry.structuralQc || entry.structuralQc.error) return apply_structural_qc(row);
  return commit_structural_qc(row, entry.structuralQc);
}

/*

Purpose:
	Runs Time QC (stage 1) reusing a cached result for this method + settings
	when one exists; a miss computes and stores it, so toggling Time QC off and back
	on (or switching methods and back) stays instant even for peak tracking, which
	is never precomputed eagerly.

Input:
	row [object]: the sample row
	options [object]: the Time QC options

Output:
	envelope [object]: the stage result envelope

*/
export function apply_time_qc_fast(row, options = {}) {
  const data = require_row_data(row);
  const structuralActive = Boolean(data.masks?.structural);
  const entry = get_precompute_entry(row, data);
  const key = time_qc_cache_key(options, structuralActive);
  const cached = entry.timeQc.get(key);
  if (cached && !cached.error) return commit_time_qc(row, cached);

  const structuralMask = data.masks?.structural ?? null;
  const result = run_time_qc(data, structuralMask, options);
  entry.timeQc.set(key, result);
  return commit_time_qc(row, result);
}

/*

Purpose:
	Runs the Cell Gate (stage 2): fits the FSC/SSC GMM, records the fitted
	component/threshold as the editable baseline, installs its mask as QC filter 2,
	and invalidates downstream products.

Input:
	row [object]: the sample row
	options [object]: the Cell Gate options

Output:
	envelope [object]: the stage result envelope

*/
// Fits the Cell Gate on the current structural + Time QC survivors. Pure compute
// (no state/mask side effects), so its result can be memoized on the precompute
// entry and installed later by commit_cell_gate().
function fit_cell_gate(data, options) {
  return cellGate.gateMainBiologicalCloud(
    data,
    data.masks?.structural ?? null,
    data.masks?.timeQC ?? null,
    options,
  );
}

// Installs a (possibly cached) raw Cell Gate fit. The fitted-baseline fields are
// stamped on a fresh shallow copy so a cached fit shared across re-applies is
// never mutated; the mask is installed as QC filter 2 (withheld when
// skipped/review-required) and downstream products are invalidated.
function commit_cell_gate(row, state, rawResult) {
  const result = { ...rawResult };
  if (!result.skipped && result.mainComponent) {
    result.fittedMainComponent = clone_scatter_component(result.mainComponent);
    result.fittedThreshold = result.threshold;
    result.rotation = 0;
    result.manualOverride = null;
    result.gateSource = "fitted";
  }
  state.scatterGate = result;
  // An ambiguous fitted component remains visible in the inspector, but does
  // not silently become an authoritative biological gate. Any manual edit is
  // an explicit review and installs the resulting mask via update_cell_gate().
  set_filter_mask(row, 2, result.skipped || result.reviewRequired ? null : result.scatterMask);
  invalidate_after(row, state, 2);
  return stage_result(2, row, result, state);
}

export function apply_cell_gate(row, options = {}) {
  const data = require_row_data(row);
  const state = get_or_create_state(row);
  return commit_cell_gate(row, state, fit_cell_gate(data, options));
}

/*

Purpose:
	Cached Cell Gate: reuses a prior fit whenever the composed input (structural +
	Time QC masks) and gate options are unchanged, so re-applying the pre-model QC
	set after only a downstream change does not re-fit the GMM. A cache miss fits
	and stores. The install side effects (state, mask, invalidation) always run.

Input:
	row [object]: the sample row
	options [object]: the Cell Gate options

Output:
	envelope [object]: the stage result envelope

*/
export function apply_cell_gate_fast(row, options = {}) {
  const data = require_row_data(row);
  const state = get_or_create_state(row);
  const entry = get_precompute_entry(row, data);
  const cache = entry.scatterGate ?? (entry.scatterGate = new Map());
  const key = cell_gate_cache_key(data.masks?.structural ?? null, data.masks?.timeQC ?? null, options);
  let raw = cache.get(key);
  if (!raw) {
    raw = fit_cell_gate(data, options);
    cache.set(key, raw);
  }
  return commit_cell_gate(row, state, raw);
}

/*

Purpose:
	Translates, resizes, or rotates the Cell Gate's fitted ellipse and makes it
	authoritative. Translation changes the center; coverage changes the squared
	Mahalanobis threshold while keeping the covariance's axis ratio; rotation
	reorients the covariance's principal axes -- all three always computed from the
	fitted covariance plus the current absolute values (never compounded), so each
	can be edited independently and "Reset fitted gate" clears all three. The mask
	is recomputed from the original scatter points, then the Singlet Gate and every
	downstream product are invalidated.

Input:
	row [object]: the sample row
	edit [object]: { mean, coverage, rotation, reset }

Output:
	envelope [object]: the stage result envelope (throws when no gate exists)

*/
export function update_cell_gate(
  row,
  { mean = null, coverage = null, rotation = null, reset = false } = {},
) {
  const data = require_row_data(row);
  const state = get_or_create_state(row);
  const result = state.scatterGate;
  if (!result || result.skipped || !result.mainComponent) {
    throw new Error("Apply the Cell Gate before editing it.");
  }

  const fittedComponent = clone_scatter_component(
    result.fittedMainComponent ?? result.mainComponent,
  );
  const currentComponent = clone_scatter_component(result.mainComponent);
  const center = reset
    ? validate_scatter_gate_center(fittedComponent.mean)
    : mean == null
      ? validate_scatter_gate_center(currentComponent.mean)
      : validate_scatter_gate_center(mean);
  const fittedThreshold = Number(result.fittedThreshold ?? result.threshold);
  const threshold = reset
    ? fittedThreshold
    : coverage == null
      ? Number(result.threshold)
      : scatter_threshold_for_coverage(coverage);
  const nextRotation = reset
    ? 0
    : rotation == null
      ? Number(result.rotation ?? 0)
      : Number(rotation);
  if (!Number.isFinite(nextRotation)) {
    throw new RangeError("The cell-gate rotation must be a finite number of radians.");
  }
  const nextComponent = {
    ...(reset ? fittedComponent : currentComponent),
    mean: center,
    covariance: rotateCovariance2D(fittedComponent.covariance, nextRotation),
  };
  const { mask, mahalanobisDistanceSquared } = cellGate.createScatterGateMask(
    data.eventCount,
    result.scatterPoints,
    nextComponent,
    threshold,
  );

  const components = [...result.components];
  if (
    Number.isInteger(result.mainComponentIndex) &&
    result.mainComponentIndex >= 0 &&
    result.mainComponentIndex < components.length
  ) {
    components[result.mainComponentIndex] = nextComponent;
  }
  const updatedResult = {
    ...result,
    components,
    mainComponent: nextComponent,
    fittedMainComponent: fittedComponent,
    fittedThreshold,
    threshold,
    rotation: nextRotation,
    scatterMask: mask,
    mask,
    mahalanobisDistanceSquared,
    retainedEventCount: count_retained(mask),
    manualOverride: reset
      ? null
      : {
          mean: [...center],
          threshold,
          coverage: 1 - Math.exp(-threshold / 2),
          rotation: nextRotation,
        },
    gateSource: reset ? "fitted" : "manual",
  };

  state.scatterGate = updatedResult;
  set_filter_mask(row, 2, mask);
  invalidate_after(row, state, 2);
  return stage_result(2, row, updatedResult, state);
}

/*

Purpose:
	Runs the optional Singlet Gate (stage 3): fits the pulse-geometry ridge over
	the composed upstream mask, installs its mask as QC filter 3 (null when skipped),
	and invalidates downstream products.

Input:
	row [object]: the sample row
	options [object]: the Singlet Gate options

Output:
	envelope [object]: the stage result envelope

*/
// Installs a (possibly cached) raw Singlet Gate fit onto a fresh shallow copy so
// a shared cached fit is never mutated; the mask is installed as QC filter 3
// (withheld when skipped/review-required) and downstream products invalidated.
function commit_singlet_gate(row, state, rawResult) {
  const result = { ...rawResult };
  state.singletResult = result;
  // The source returns a copied input mask when geometry is unavailable. The
  // pipeline stores null for a skipped optional gate so mask provenance stays
  // explicit; recomputing final still preserves all prior masks.
  set_filter_mask(row, 3, result.skipped || result.reviewRequired ? null : result.singletMask);
  invalidate_after(row, state, 3);
  return stage_result(3, row, result, state);
}

export function apply_singlet_gate(row, options = {}) {
  const data = require_row_data(row);
  const state = get_or_create_state(row);
  const inputMask = combined_mask_before(row, 3);
  return commit_singlet_gate(row, state, singletGate.gateByPulseGeometry(data, inputMask, options));
}

/*

Purpose:
	Cached Singlet Gate: reuses a prior fit whenever the composed upstream mask
	(structural AND Time QC AND Cell Gate) and gate options are unchanged, so
	re-applying the pre-model QC set does not re-fit the ridge when nothing upstream
	moved. A cache miss fits and stores. Install side effects always run.

Input:
	row [object]: the sample row
	options [object]: the Singlet Gate options

Output:
	envelope [object]: the stage result envelope

*/
export function apply_singlet_gate_fast(row, options = {}) {
  const data = require_row_data(row);
  const state = get_or_create_state(row);
  const entry = get_precompute_entry(row, data);
  const cache = entry.singletGate ?? (entry.singletGate = new Map());
  const inputMask = combined_mask_before(row, 3);
  const key = singlet_gate_cache_key(inputMask, options);
  let raw = cache.get(key);
  if (!raw) {
    raw = singletGate.gateByPulseGeometry(data, inputMask, options);
    cache.set(key, raw);
  }
  return commit_singlet_gate(row, state, raw);
}

/*

Purpose:
	Deterministic identity string for a histogram: sample name, DNA channel,
	gated-view revision, bin count, and range. Identical inputs produce the same
	fingerprint whether or not a histogram was built, so ensure_histogram_current()
	can compare requested against stored without rebuilding to check.

Input:
	row [object]: the sample row
	spec [object]: { binCount, range, dnaChannel }
	revision [number]: the gated-view revision

Output:
	fingerprint [string]: the identity string

*/
function build_histogram_fingerprint(row, { binCount, range, dnaChannel }, revision) {
  const rangeKey = range ? `${range[0]}:${range[1]}` : "auto";
  return [row.name, dnaChannel ?? "", revision, binCount ?? "auto", rangeKey].join("|");
}

/*

Purpose:
	Builds the DNA-content histogram (stage 4) from the gated view (upstream
	filters have already removed their events), stamps it with the gated-view
	revision and fingerprint, stores it, and invalidates downstream products.

Input:
	row [object]: the sample row
	options [object]: { binCount, range, ... }

Output:
	envelope [object]: the stage result envelope

*/
export function apply_dna_histogram(row, options = {}) {
  const data = require_row_data(row);
  const state = get_or_create_state(row);
  recompute_final_mask(row);
  // Bin the gated view directly: prior filters have already deleted their events
  // from it, so no mask is applied here (identical to masking the originals).
  const filtered = build_filtered_view(row);
  const dnaChannel = data.channel_key ?? null;
  const result = dnaHistogram.generateHistogram(filtered.channels.DNA_A, null, {
    ...options,
    dnaChannel,
    dnaMetadata: data.parameterMetadata?.DNA_A ?? null,
  });
  // revision is read after build_filtered_view() (which itself bumps it), so
  // it reflects the exact gated view this histogram was binned from --
  // stamped onto the result itself so later callers (peak detection, model
  // fitting, ensure_histogram_current()) can verify identity without a
  // separate sidecar.
  const revision = data.filteredViewRevision || 0;
  result.revision = revision;
  result.fingerprint = build_histogram_fingerprint(
    row,
    { binCount: options.binCount ?? null, range: options.range ? [...options.range] : null, dnaChannel },
    revision,
  );
  state.histogram = result;
  invalidate_after(row, state, 4);
  return stage_result(4, row, result, state);
}

/*

Purpose:
	Like apply_dna_histogram(), but skips rebuilding (and so skips invalidating every
	downstream stage) when the stored histogram's fingerprint already matches the
	requested bin count, range, and gated-view revision. Called before peak
	detection/fitting and by the background precompute, so repeated calls with
	unchanged inputs are free instead of silently deleting downstream results.

Input:
	row [object]: the sample row
	options [object]: { binCount, range, ... }

Output:
	envelope [object]: the stage result envelope

*/
export function ensure_histogram_current(row, options = {}) {
  const data = require_row_data(row);
  const state = get_or_create_state(row);
  const dnaChannel = data.channel_key ?? null;
  const requested = build_histogram_fingerprint(
    row,
    { binCount: options.binCount ?? null, range: options.range ? [...options.range] : null, dnaChannel },
    data.filteredViewRevision || 0,
  );
  if (state.histogram && state.histogram.fingerprint === requested) {
    return stage_result(4, row, state.histogram, state);
  }
  return apply_dna_histogram(row, options);
}

/*

Purpose:
	Resolves the rows to operate on: the given rows, or all plottable rows when none
	are given.

Input:
	rows [iterable|null]: explicit rows, or null for all plottable rows

Output:
	rows [array]: the resolved rows

*/
function target_rows(rows) {
  return rows == null ? plottable_rows() : Array.from(rows);
}

/*

Purpose:
	Computes one DNA-content range spanning the retained events of several samples,
	so a batch histogram build shares identical bins (widening a degenerate range).

Input:
	rows [iterable|null]: the samples (defaults to all plottable rows)

Output:
	range [array]: [minimum, maximum] (throws when no finite retained events exist)

*/
export function shared_histogram_range(rows) {
  const targets = target_rows(rows);
  let minimum = Infinity;
  let maximum = -Infinity;
  let retainedCount = 0;

  for (const row of targets) {
    const data = require_row_data(row);
    const mask = recompute_final_mask(row);
    for (let eventIndex = 0; eventIndex < data.channels.DNA_A.length; eventIndex += 1) {
      if (!mask[eventIndex]) continue;
      const value = data.channels.DNA_A[eventIndex];
      if (!Number.isFinite(value)) continue;
      minimum = Math.min(minimum, value);
      maximum = Math.max(maximum, value);
      retainedCount += 1;
    }
  }

  if (!retainedCount) {
    throw new Error("No finite retained DNA events are available to build the histogram.");
  }
  if (!(maximum > minimum)) {
    const span = Math.max(Math.abs(minimum) * 1e-6, 1);
    minimum -= span / 2;
    maximum += span / 2;
  }
  return [minimum, maximum];
}

/*

Purpose:
	Clears all four QC gate masks and the pipeline state for a sample, so the
	Pre-model QC checkboxes can re-apply only the currently checked gates from a
	clean slate. The gated view and final mask are recomputed to all-pass.

Input:
	row [object]: the sample row

Output:
	(none) [void]

*/
export function reset_qc_gates(row) {
  clear_state(row?.name);
  if (row && row.data && row.data.masks) {
    for (const name of ["structural", "timeQC", "scatter", "singlet"]) {
      row.data.masks[name] = null;
    }
    recompute_final_mask(row);
    build_filtered_view(row);
  }
}

export function record_qc_failure(row, filterIndex, error) {
  const state = get_or_create_state(row);
  const product = ["structuralQC", "timeQC", "scatterGate", "singletResult"][filterIndex];
  if (!product) throw new Error(`Unknown QC filter index: ${filterIndex}`);
  const failure = {
    failed: true,
    status: "failed",
    reason: error?.message ?? String(error),
    error: { code: error?.code ?? "QC_STAGE_FAILED", message: error?.message ?? String(error) },
  };
  Object.defineProperty(failure, "cause", { value: error, enumerable: false });
  state[product] = failure;
  set_filter_mask(row, filterIndex, null);
  invalidate_after(row, state, filterIndex);
  invalidate_model_results(state, `QC stage ${filterIndex} failed`);
  return state[product];
}

const FILTER_DEFINITIONS = [
  { key: "structural", label: "Structural" },
  { key: "timeQC", label: "Time QC" },
  { key: "scatter", label: "Scatter" },
  { key: "singlet", label: "Singlet" },
];

/*

Purpose:
	Per-filter event funnel: how many events each mask removed relative to the events
	that entered that filter. Derived from the composed masks rather than each
	filter's own counts, so it stays correct regardless of per-filter mask semantics
	and reports a null-mask (skipped/optional) filter as removing nothing. Needs no
	report, so each filter's loss can be written to the table as soon as it runs.

Input:
	row [object]: the sample row

Output:
	funnel [object|null]: { name, eventCount, filters: [{ key, label, entered, lost,
	                     skipped }] }, or null when the sample has no loaded data

*/
export function pipeline_filter_funnel(row) {
  if (!row?.data) return null;

  const eventCount = row.data.eventCount ?? 0;
  const masks = row.data.masks || {};
  const alive = new Uint8Array(eventCount).fill(1);
  let entered = eventCount;
  const filters = [];

  for (const { key, label } of FILTER_DEFINITIONS) {
    const mask = masks[key];
    if (!mask) {
      filters.push({ key, label, entered, lost: 0, skipped: true });
      continue;
    }
    let keptAfter = 0;
    for (let index = 0; index < eventCount; index += 1) {
      if (alive[index] && !mask[index]) alive[index] = 0;
      if (alive[index]) keptAfter += 1;
    }
    filters.push({ key, label, entered, lost: entered - keptAfter, skipped: false });
    entered = keptAfter;
  }

  return { name: row.name, eventCount, filters };
}

/*

Purpose:
	Full metadata-table summary: the per-filter funnel plus the G1/S/G2-M cell-cycle
	percentages. Returns null until the sample has a fit report, so the cell-cycle
	columns only populate for samples that completed the pipeline.

Input:
	row [object]: the sample row

Output:
	stats [object|null]: the funnel plus { fractions: { g1, s, g2 } }, or null

*/
export function pipeline_table_stats(row) {
  const state = get_state(row?.name);
  const fit = get_active_model_result(state);
  if (!fit?.phaseFractions) return null;
  const funnel = pipeline_filter_funnel(row);
  if (!funnel) return null;

  const percent = (fraction) => (Number.isFinite(fraction) ? 100 * fraction : NaN);
  return {
    ...funnel,
    fractions: {
      g1: percent(fit.phaseFractions.g1),
      s: percent(fit.phaseFractions.s),
      g2: percent(fit.phaseFractions.g2),
    },
  };
}
