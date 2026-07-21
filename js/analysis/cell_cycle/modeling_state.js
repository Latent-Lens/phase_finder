// Peak-region state transitions for the model-neutral modeling workflow.
// Operates on the modeling.peakDetection/peakSelection state
// (js/analysis/pipeline_state.js's create_modeling_state()) using the
// multi-scale detector and region validator. Kept separate from
// pipeline_state.js: that module owns the generic state schema and
// invalidation primitives; this module owns peak-detection-specific
// behavior built on top of them.
//
// Implements the "Required public operations" from the modeling plan §4.2
// that concern peak regions: detect_peak_regions, select_peak_pair,
// update_peak_regions, accept_peak_regions, reset_peak_regions.

import { get_or_create_state, invalidate_model_results } from "../pipeline_state.js";
import { detectCellCyclePeakPair, proposeAutomaticPeakRegions } from "./peak_detection.js";
import { validatePeakRegions } from "./peak_regions.js";

function require_histogram(state) {
  if (!state.histogram) {
    throw new Error("Build the Stage 4 histogram before working with peak regions.");
  }
  return state.histogram;
}

function pair_id(index) {
  return `pair-${index}`;
}

/**
 * Runs the multi-scale detector against the row's current histogram and
 * stores its output in modeling.peakDetection. Replaces the automatic region
 * proposal unconditionally, but only overwrites the *active* selection
 * (modeling.peakSelection.regions) when the user hasn't already made a
 * manual edit -- a rerun (e.g. after a QC change) must not silently discard
 * a region the user already reviewed.
 */
export function detect_peak_regions(row, options = {}) {
  const state = get_or_create_state(row);
  const histogram = require_histogram(state);
  const result = detectCellCyclePeakPair(histogram.edges, histogram.counts ?? histogram.y, options);
  const modeling = state.modeling;

  const idOf = (pair) => (pair ? pair_id(result.pairs.indexOf(pair)) : null);

  modeling.peakDetection = {
    detectorId: "multiscale_v1",
    status: result.detection.status,
    confidence: result.detection.confidence,
    reasons: result.detection.reasons,
    candidates: result.candidates,
    pairs: result.pairs.map((pair, index) => ({ ...pair, id: pair_id(index) })),
    selectedPairId: idOf(result.detection.selectedPair),
    alternatives: result.detection.alternatives.map((pair) => ({ ...pair, id: idOf(pair) })),
    configuration: result.configuration,
  };
  modeling.histogramFingerprint = histogram.fingerprint ?? null;

  modeling.peakSelection.automaticRegions = result.autoPeakRegions;
  if (modeling.peakSelection.source === "automatic") {
    modeling.peakSelection.regions = result.autoPeakRegions;
    modeling.peakSelection.initialCenters = {
      g1: result.detection.g1Candidate?.x ?? null,
      g2: result.detection.g2Candidate?.x ?? null,
    };
  }
  modeling.peakSelection.stale = false;
  modeling.peakSelection.reviewed = false;
  modeling.revision += 1;

  return modeling.peakDetection;
}

/** Switches the active regions to one of the detector's ranked alternative pairs. */
export function select_peak_pair(row, pairId) {
  const state = get_or_create_state(row);
  const histogram = require_histogram(state);
  const modeling = state.modeling;
  const pair = modeling.peakDetection?.pairs?.find((candidate) => candidate.id === pairId);
  if (!pair) {
    throw new Error(`No detected pair with id "${pairId}". Run detect_peak_regions() first.`);
  }

  const regions = proposeAutomaticPeakRegions(histogram.edges, {
    g1Index: pair.g1.index,
    g2Index: pair.g2.index,
    g1Candidate: pair.g1,
    g2Candidate: pair.g2,
  });

  modeling.peakDetection.selectedPairId = pairId;
  modeling.peakSelection.automaticRegions = regions;
  modeling.peakSelection.regions = regions;
  modeling.peakSelection.source = "alternative";
  modeling.peakSelection.reviewed = false;
  modeling.peakSelection.stale = false;
  modeling.peakSelection.revision += 1;
  invalidate_model_results(state, "alternative peak pair selected");
  return modeling.peakSelection;
}

/**
 * Applies a user-edited region pair (e.g. from dragging a handle or typing
 * exact limits). Validates ordering (L1 < R1 <= L2 < R2) before accepting --
 * an invalid edit throws and leaves the previous regions untouched. Callers
 * whose four values don't share the same precision (e.g. a UI redisplaying
 * regions rounded to 2 decimals while only one field was actually edited) can
 * pass a small negative minimumGap to tolerate that rounding noise at a
 * touching G1/G2 boundary without relaxing genuine ordering violations.
 */
export function update_peak_regions(row, regions, { source = "manual", minimumGap } = {}) {
  const state = get_or_create_state(row);
  const validated = validatePeakRegions(regions, { minimumGap });
  const modeling = state.modeling;

  modeling.peakSelection.regions = validated;
  modeling.peakSelection.source = source;
  modeling.peakSelection.reviewed = true;
  modeling.peakSelection.stale = false;
  modeling.peakSelection.revision += 1;
  invalidate_model_results(state, "peak regions edited");
  return modeling.peakSelection;
}

/** Marks the current regions as explicitly reviewed, without changing them. */
export function accept_peak_regions(row) {
  const state = get_or_create_state(row);
  const peakSelection = state.modeling.peakSelection;
  peakSelection.reviewed = true;
  peakSelection.stale = false;
  return peakSelection;
}

/** Discards any manual edit and restores the detector's automatic proposal. */
export function reset_peak_regions(row) {
  const state = get_or_create_state(row);
  const modeling = state.modeling;
  if (!modeling.peakSelection.automaticRegions) {
    throw new Error("Run detect_peak_regions() before resetting to automatic regions.");
  }

  modeling.peakSelection.regions = modeling.peakSelection.automaticRegions;
  modeling.peakSelection.source = "automatic";
  modeling.peakSelection.reviewed = false;
  modeling.peakSelection.stale = false;
  modeling.peakSelection.revision += 1;
  invalidate_model_results(state, "peak regions reset to automatic");
  return modeling.peakSelection;
}
