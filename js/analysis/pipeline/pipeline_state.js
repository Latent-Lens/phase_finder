// Per-sample state and mask composition for the cell-cycle pipeline. State is
// keyed by filename for the public debugging API, while each entry records its
// active channel key so changing DNA channels cannot reuse stale masks or fits.
// pipeline_states holds the entries; get_state(), get_or_create_state(),
// clear_state(), and state_matches_row() manage them; empty_state() and
// create_modeling_state() build a fresh entry. The mask layer -- combine_masks(),
// all_pass_mask(), combined_mask_before(), recompute_final_mask(),
// set_filter_mask(), and build_filtered_view() -- composes the four QC-filter
// masks into the final mask and the compacted "gated" channel view.
// invalidate_after(), invalidate_histogram_dependents(),
// invalidate_model_results(), and invalidate_model_config_result() clear
// downstream products when an upstream input changes.
//
// GATE_STATES / derive_gate_state() (QC-02, AD-3): the gate-state vocabulary
// every pre-model QC surface (sidebar toggle buttons, metadata table status
// column) renders from. Before this, "did the gate succeed" was read off
// `aria-pressed`, which only ever meant "is the toggle on" -- there was no
// third state for "the gate ran but produced a result that needs review"
// (e.g. the scatter gate's `reviewRequired`), so a reviewed-but-incomplete
// gate rendered identically to a cleanly-applied one in the sidebar while the
// table reported it as incomplete. derive_gate_state() is the single place
// that classifies a stage product into GATE_STATES, built on top of
// qc_outcome() (the existing single source of truth for stage status used by
// the result contract) rather than re-deriving pass/fail from the product's
// raw fields a second time -- every caller (pipeline_ui.js's sidebar buttons
// and metadata-table column) must call this function instead of inspecting
// `product.failed` / `product.skipped` / `product.reviewRequired` directly,
// so the two surfaces cannot disagree about a given gate's state.

import { is_reportable_result, qc_outcome } from "../cell_cycle/result_contract.js";

export const pipeline_states = new Map();

// "not-run"/"running" are UI-only states with no qc_outcome() equivalent
// (derive_gate_state() returns them directly, from the toggle/busy flags);
// every other GATE_STATES value is one of qc_outcome()'s possible statuses,
// funneled down to the six the sidebar/table vocabulary distinguishes.
export const GATE_STATES = ["not-run", "running", "applied", "needs-review", "failed", "skipped"];

// qc_outcome() status -> GATE_STATES. "cancelled" reads as "failed": per
// qc_outcome()'s own contract comment, a cancelled stage's mask is left in an
// unknown state and cannot be trusted, the same as a genuine failure.
// "waived" reads as "applied": a waiver only counts when a human explicitly
// recorded a reason (qc_outcome()'s waiver branch), so it is a resolved,
// accepted state, not one still awaiting review.
const OUTCOME_STATUS_TO_GATE_STATE = {
  not_run: "not-run",
  applied: "applied",
  passed_no_loss: "applied",
  waived: "applied",
  degraded: "needs-review",
  unavailable: "skipped",
  skipped_optional: "skipped",
  failed: "failed",
  cancelled: "failed",
};

// Severity order used to pick one state when several samples disagree about a
// single gate (worst first): a sidebar button aggregates every plotted
// sample's state for that gate into one, and this is the priority used to
// pick which one wins.
const GATE_STATE_SEVERITY = ["failed", "needs-review", "running", "skipped", "not-run", "applied"];

/*

Purpose:
	Classifies one stage product into the GATE_STATES vocabulary -- the single
	derivation both the sidebar toggle buttons and the metadata table's QC status
	column must read from, so a gate cannot render "applied" in one surface and
	"incomplete" in the other. Delegates the actual pass/fail/degraded reading to
	qc_outcome() (the result contract's existing classification) instead of
	re-inspecting the product's raw fields.

Input:
	product [object|null]: the stage's product (e.g. state.scatterGate), or null
	options [object]: { active [boolean]: whether the gate's toggle is on;
	                    running [boolean]: whether an apply is currently in
	                    flight for this gate; waiver [object|undefined]: an
	                    explicit acknowledgement, passed through to qc_outcome() }

Output:
	state [string]: one of GATE_STATES

*/
export function derive_gate_state(product, { active = false, running = false, waiver } = {}) {
  if (!active) return "not-run";
  if (running) return "running";
  const outcome = qc_outcome(product, waiver);
  return OUTCOME_STATUS_TO_GATE_STATE[outcome.status] ?? "not-run";
}

/*

Purpose:
	Picks the single worst GATE_STATES value out of several (e.g. one gate's
	state across every plotted sample), by GATE_STATE_SEVERITY.

Input:
	states [array]: GATE_STATES values

Output:
	state [string]: the worst one present, or "not-run" when `states` is empty

*/
export function aggregate_gate_state(states) {
  for (const candidate of GATE_STATE_SEVERITY) {
    if (states.includes(candidate)) return candidate;
  }
  return "not-run";
}

// Maps each operation index to the state field it produces, so invalidate_after
// can clear every downstream product. Index 0 names the structural filter's
// primary diagnostic (structuralQC); its structuralMask copy is never read (the
// filters read the mask from row.data.masks.structural) and is cleared with that
// mask, not here.
const STATE_FIELDS_IN_ORDER = [
  "structuralQC",
  "timeQC",
  "scatterGate",
  "singletResult",
  "histogram",
  "peaks",
  "baseFit",
  "extendedFit",
  "report",
];

const FILTER_MASK_FIELDS = ["structural", "timeQC", "scatter", "singlet"];

/*

Purpose:
	Builds the default model-neutral modeling state (peak detection, peak regions,
	model settings, cached fit results) that the Identify Peaks / model-dropdown
	workflow reads and writes. Lives alongside the current structuralQC/peaks/baseFit
	fields, not in place of them.

Input:
	(none)

Output:
	state [object]: a fresh modeling-state object

*/
function create_modeling_state() {
  return {
    schemaVersion: 1,
    histogramFingerprint: null,
    fitDomain: null,

    peakDetection: {
      detectorId: "multiscale_v1",
      status: null, // detected | low_confidence | inferred_g2
      confidence: 0,
      reasons: [],
      candidates: [],
      pairs: [],
      selectedPairId: null,
      alternatives: [],
      regionEvidence: null,
      configuration: {},
    },

    peakSelection: {
      automaticRegions: null,
      regions: null,
      source: "automatic", // automatic | alternative | manual
      reviewed: false,
      stale: false,
      revision: 0,
      initialCenters: null,
    },

    settings: {
      // No model until the user picks one. This used to default to
      // "auto_dj_djf", a model the user never chose and which the selector did
      // not even offer; the Auto selection policy has since been retired.
      modelId: null,
      ratioMode: "bounded",
      ratioRange: [1.65, 2.25],
      lockedRatio: 2,
      cvMode: "free",
      contaminants: { debris: "off", aggregate: "off", subG1: "off" },
      ploidyCount: 1,
    },

    resultsByKey: {},
    modelComparison: null,
    activeResultKey: null,
    fitRequestId: 0,
    revision: 0,
  };
}

/*

Purpose:
	Invalidates everything that depends on the histogram after its fingerprint
	changes (QC/bins/range/fit-domain): flags the peak regions stale (the user
	chooses to keep or reset them rather than losing them silently) and clears every
	cached fit, since each was fit against the old histogram.

Input:
	state [object]: the per-sample pipeline state
	reason [string]: a note recorded for debugging

Output:
	(none) [void]: mutates state.modeling in place

*/
export function invalidate_histogram_dependents(state, reason = "") {
  const modeling = state?.modeling;
  if (!modeling) return;
  modeling.peakSelection.stale = true;
  modeling.resultsByKey = {};
  modeling.activeResultKey = null;
  modeling.modelComparison = null;
  modeling.lastInvalidationReason = reason;
  modeling.revision += 1;
}

/*

Purpose:
	Clears every cached fit result regardless of model, without touching detection
	or regions. Used when regions are actually edited/accepted (not merely marked
	stale by a histogram change).

Input:
	state [object]: the per-sample pipeline state
	reason [string]: a note recorded for debugging

Output:
	(none) [void]: mutates state.modeling in place

*/
export function invalidate_model_results(state, reason = "") {
  const modeling = state?.modeling;
  if (!modeling) return;
  modeling.resultsByKey = {};
  modeling.activeResultKey = null;
  modeling.modelComparison = null;
  modeling.lastInvalidationReason = reason;
  modeling.revision += 1;
}

/*

Purpose:
	Removes only the cached results belonging to one model, preserving every other
	model's cached fits -- switching the model dropdown back and forth (or changing
	one model's constraint) never discards unrelated work.

Input:
	state [object]: the per-sample pipeline state
	modelId [string]: the model whose cached results to drop
	reason [string]: a note recorded for debugging

Output:
	(none) [void]: mutates state.modeling in place

*/
export function invalidate_model_config_result(state, modelId, reason = "") {
  const modeling = state?.modeling;
  if (!modeling) return;
  for (const key of Object.keys(modeling.resultsByKey)) {
    if (modeling.resultsByKey[key]?.modelId === modelId) {
      delete modeling.resultsByKey[key];
    }
  }
  if (modeling.activeResultKey && modeling.resultsByKey[modeling.activeResultKey] === undefined) {
    modeling.activeResultKey = null;
  }
  modeling.lastInvalidationReason = reason;
  modeling.revision += 1;
}

/*

Purpose:
	Builds a fresh, empty per-sample state entry: identity fields (row id, name,
	active channel key, event count), null slots for every operation's product, and
	a fresh modeling state.

Input:
	row [object]: the sample row (reads id, name, data)

Output:
	state [object]: the empty state entry

*/
function empty_state(row) {
  return {
    rowId: row && row.id ? row.id : null,
    name: row && row.name ? row.name : "",
    channelKey: row && row.data ? row.data.channel_key : null,
    channelEligibility: row?.data?.parameterMetadata?.DNA_A?.eligibility ?? null,
    eventCount: row && row.data ? row.data.eventCount : 0,
    structuralQC: null,
    structuralMask: null,
    timeQC: null,
    scatterGate: null,
    singletResult: null,
    histogram: null,
    peaks: null,
    baseFit: null,
    extendedFit: null,
    report: null,
    lastRunIndex: null,
    modeling: create_modeling_state(),
  };
}

/*

Purpose:
	Returns the stored state entry for a sample name, or null when none exists.

Input:
	name [string]: the sample filename

Output:
	state [object|null]: the stored state, or null

*/
export function get_state(name) {
  return pipeline_states.get(name) || null;
}

// The sole authoritative model result. Legacy stage 6-8 compatibility slots are
// deliberately excluded (LEGACY-01: the bridge is exploratory/unvalidated and
// the result contract refuses it outright).
//
// GATE-01: is_reportable_result() requires the contract stamp as well as the
// verdict, so a raw registry normalizeResult() output written straight into
// resultsByKey -- by a test, a debug call, or a future code path that forgot the
// validator -- cannot become the authoritative result.
export function get_active_model_result(state) {
  const modeling = state?.modeling;
  const result = modeling?.activeResultKey
    ? modeling.resultsByKey?.[modeling.activeResultKey] ?? null
    : null;
  return is_reportable_result(result) ? result : null;
}

/*

Purpose:
	Whether an existing state entry still describes `row` -- same active channel,
	same event count, and (when both are known) same row id. Used both to reuse
	state on writes and to gate stale state from display, so the two never drift.

Input:
	state [object]: a stored state entry
	row [object]: the current sample row

Output:
	matches [boolean]: true when the entry still describes the row

*/
export function state_matches_row(state, row) {
  if (!state || !row || !row.data) return false;
  if (state.channelKey !== row.data.channel_key) return false;
  if (state.eventCount !== row.data.eventCount) return false;
  if (state.rowId && row.id && state.rowId !== row.id) return false;
  return true;
}

/*

Purpose:
	Returns the sample's state entry, creating a fresh one when none exists or the
	stored one no longer matches the row (channel/event-count/id change).

Input:
	row [object]: the sample row (must have name and data)

Output:
	state [object]: the reused or newly created state entry

*/
export function get_or_create_state(row) {
  if (!row || !row.name || !row.data) {
    throw new Error("A loaded sample with row.data is required.");
  }

  const previous = pipeline_states.get(row.name);
  if (!previous || !state_matches_row(previous, row)) {
    const state = empty_state(row);
    pipeline_states.set(row.name, state);
    return state;
  }
  return previous;
}

/*

Purpose:
	Clears one sample's state entry, or every entry when no name is given.

Input:
	name [string|null]: the sample name, or null/undefined to clear all

Output:
	(none) [void]

*/
export function clear_state(name) {
  if (name == null) {
    pipeline_states.clear();
    return;
  }
  pipeline_states.delete(name);
}

/*

Purpose:
	Logical-ANDs any number of equal-length event masks into one (an event is kept
	only when every mask keeps it). Null masks are ignored.

Input:
	input_masks [array]: masks (or nested arrays of masks); nulls ignored

Output:
	mask [Uint8Array|null]: the combined mask, or null when none were given (throws
	                        on a length mismatch)

*/
export function combine_masks(...input_masks) {
  const masks = input_masks.flat().filter((mask) => mask != null);
  if (!masks.length) return null;

  const length = masks[0].length;
  if (!Number.isInteger(length)) throw new Error("Pipeline masks must be array-like.");
  const combined = new Uint8Array(length);
  combined.fill(1);

  for (const mask of masks) {
    if (mask.length !== length) {
      throw new Error(`Pipeline mask length mismatch: expected ${length}, received ${mask.length}.`);
    }
    for (let index = 0; index < length; index += 1) {
      if (!mask[index]) combined[index] = 0;
    }
  }
  return combined;
}

/*

Purpose:
	Builds an all-pass (all-ones) mask of a given length.

Input:
	event_count [number]: the mask length

Output:
	mask [Uint8Array]: an all-ones mask (throws on an invalid count)

*/
export function all_pass_mask(event_count) {
  const count = Number(event_count);
  if (!Number.isInteger(count) || count < 0) {
    throw new Error(`Invalid event count for mask: ${event_count}`);
  }
  const mask = new Uint8Array(count);
  mask.fill(1);
  return mask;
}

/*

Purpose:
	Composes the QC-filter masks that precede a given operation into one mask (so a
	filter sees only events its upstream filters kept), falling back to all-pass.

Input:
	row [object]: the sample row (reads data.masks, data.eventCount)
	operation_index [number]: the operation whose upstream masks to combine

Output:
	mask [Uint8Array]: the combined upstream mask (or all-pass)

*/
export function combined_mask_before(row, operation_index) {
  const masks = row && row.data && row.data.masks ? row.data.masks : {};
  const count = row && row.data ? row.data.eventCount : 0;
  const relevant = FILTER_MASK_FIELDS
    .slice(0, Math.max(0, Math.min(FILTER_MASK_FIELDS.length, operation_index)))
    .map((name) => masks[name])
    .filter(Boolean);
  return combine_masks(relevant) || all_pass_mask(count);
}

/*

Purpose:
	Recomputes row.data.masks.final as the AND of all four QC-filter masks (or
	all-pass when none are set), and stores it.

Input:
	row [object]: the sample row

Output:
	mask [Uint8Array]: the recomputed final mask

*/
export function recompute_final_mask(row) {
  if (!row || !row.data) throw new Error("A loaded sample with row.data is required.");
  if (!row.data.masks) row.data.masks = {};
  const masks = FILTER_MASK_FIELDS.map((name) => row.data.masks[name]).filter(Boolean);
  row.data.masks.final = combine_masks(masks) || all_pass_mask(row.data.eventCount);
  return row.data.masks.final;
}

// Channels carried through the progressively filtered ("gated") view.
const FILTERED_CHANNELS = ["DNA_A", "DNA_H", "DNA_W", "FSC_A", "SSC_A", "Time"];

/*

Purpose:
	Rebuilds the gated view: a second, compacted copy of the channel arrays holding
	only the events surviving the composed masks so far. The originals stay intact
	(indices are still raw event indices), so each operation that reads the gated
	view receives data with earlier-filtered events already removed, while the mask
	layer keeps working for the scatter inspector and re-runs. originalIndex[i] maps
	a gated-view row back to its raw event index. Called whenever a mask changes, so
	the view shrinks with each filter; bumps filteredViewRevision so the histogram
	build can tell the view actually changed.

Input:
	row [object]: the sample row

Output:
	filtered [object|null]: { eventCount, originalIndex, channels }, or null when
	                        there is no final mask

*/
export function build_filtered_view(row) {
  if (!row || !row.data) return null;
  const data = row.data;
  // Bumped on every call (both branches below) so ensure_histogram_current()
  // can detect that the gated view actually changed, instead of unconditionally
  // rebuilding the histogram (and invalidating its downstream products) every time.
  data.filteredViewRevision = (data.filteredViewRevision || 0) + 1;
  const mask = data.masks?.final;
  const channels = data.channels || {};
  if (!mask) {
    data.filtered = null;
    return null;
  }

  const originalIndex = [];
  for (let index = 0; index < mask.length; index += 1) {
    if (mask[index]) originalIndex.push(index);
  }

  const filteredChannels = {};
  for (const key of FILTERED_CHANNELS) {
    const source = channels[key];
    if (!source) {
      filteredChannels[key] = null;
      continue;
    }
    const compacted = new Float64Array(originalIndex.length);
    for (let i = 0; i < originalIndex.length; i += 1) {
      compacted[i] = source[originalIndex[i]];
    }
    filteredChannels[key] = compacted;
  }

  data.filtered = {
    sourceMask: mask,
    eventCount: originalIndex.length,
    originalIndex: Int32Array.from(originalIndex),
    channels: filteredChannels,
  };
  return data.filtered;
}

/*

Purpose:
	Stores one QC filter's event mask (only the four QC filters own a mask), then
	recomputes the final mask and rebuilds the gated view.

Input:
	row [object]: the sample row
	operation_index [number]: which QC filter (0-3)
	mask [array|null]: the filter's mask, or null to clear it

Output:
	mask [Uint8Array]: the recomputed final mask (throws on an out-of-range index or
	                   length mismatch)

*/
export function set_filter_mask(row, operation_index, mask) {
  if (!Number.isInteger(operation_index) || operation_index < 0 || operation_index > 3) {
    throw new Error(`Only the four QC filters own an event mask (index ${operation_index}).`);
  }
  if (!row || !row.data) throw new Error("A loaded sample with row.data is required.");
  if (!row.data.masks) row.data.masks = {};
  if (mask != null && mask.length !== row.data.eventCount) {
    throw new Error(
      `QC filter mask length mismatch: expected ${row.data.eventCount}, received ${mask.length}.`,
    );
  }
  row.data.masks[FILTER_MASK_FIELDS[operation_index]] = mask;
  const final = recompute_final_mask(row);
  build_filtered_view(row);
  return final;
}

/*

Purpose:
	After an operation completes, clears every downstream state product and every
	downstream QC-filter mask, rebuilding the final mask and gated view only when a
	mask was actually cleared, and records the last completed operation index.

Input:
	row [object]: the sample row
	state [object]: the per-sample state (created if missing)
	completed_index [number]: the index of the operation that just completed

Output:
	state [object]: the updated state entry

*/
export function invalidate_after(row, state, completed_index) {
  if (!state) state = get_or_create_state(row);
  for (let index = completed_index + 1; index < STATE_FIELDS_IN_ORDER.length; index += 1) {
    state[STATE_FIELDS_IN_ORDER[index]] = null;
  }

  if (row && row.data && row.data.masks) {
    // Only the four QC filters own a mask; completing a later operation has
    // nothing to clear here; rebuilding the gated view anyway would bump
    // filteredViewRevision for no reason and defeat ensure_histogram_current().
    let mask_cleared = false;
    for (let index = completed_index + 1; index < FILTER_MASK_FIELDS.length; index += 1) {
      if (row.data.masks[FILTER_MASK_FIELDS[index]] != null) mask_cleared = true;
      row.data.masks[FILTER_MASK_FIELDS[index]] = null;
    }
    if (mask_cleared) {
      recompute_final_mask(row);
      build_filtered_view(row);
    }
  }
  state.lastRunIndex = completed_index;
  return state;
}
