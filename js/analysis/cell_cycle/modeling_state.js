// Peak-region and model-fit state transitions for the model-neutral modeling
// workflow. Operates on the modeling.peakDetection/peakSelection/settings/
// resultsByKey state (js/analysis/pipeline_state.js's create_modeling_state())
// using the multi-scale detector, region validator, and registered models.
// Exposes the peak-region operations detect_peak_regions, select_peak_pair,
// update_peak_regions, accept_peak_regions, and reset_peak_regions, plus the
// fitting operations get_modeling_state, set_model_settings, and
// fit_cell_cycle_model. Kept separate from pipeline_state.js: that module owns
// the generic state schema and invalidation primitives; this owns the
// modeling-specific behavior built on top of them.

import { get_or_create_state, invalidate_model_results } from "../pipeline_state.js";
import { detectCellCyclePeakPair, proposeAutomaticPeakRegions } from "./peak_detection.js";
import { validatePeakRegions } from "./peak_regions.js";
import { get_model } from "./model_registry.js";
import { run_fit_in_worker } from "./fit_client.js";
import { apply_result_contract, model_preflight } from "./result_contract.js";
import { deep_clone } from "../../util/clone.js";

/*

Purpose:
	Returns the row's current histogram, throwing a clear error when none has
	been built yet (the precondition for every peak/fit operation here).

Input:
	state [object]: the row's pipeline state

Output:
	histogram [object]: state.histogram (throws when it is absent)

*/
function require_histogram(state) {
  if (!state.histogram) {
    throw new Error("Build the histogram before working with peak regions.");
  }
  return state.histogram;
}

// Stable id for the nth detected peak pair.
function pair_id(index) {
  return `pair-${index}`;
}

function width_evidence(candidate, side, fallbackSigmaBins) {
  const sideWidth = candidate?.[side === "g1" ? "sigmaLeftBins" : "sigmaRightBins"];
  if (Number.isFinite(sideWidth)) return { method: "prominence_crossing", sigmaBins: sideWidth, fallback: false, fallbackReason: null };
  if (Number.isFinite(candidate?.sigmaBins)) return { method: "prominence_width", sigmaBins: candidate.sigmaBins, fallback: false, fallbackReason: null };
  return { method: "fallback_default", sigmaBins: fallbackSigmaBins, fallback: true, fallbackReason: "candidate_width_unavailable" };
}

export function peak_detection_requires_review(peakDetection, regions = null) {
  const reasons = [];
  if (peakDetection?.status !== "detected") reasons.push(peakDetection?.status ?? "not_detected");
  const selectedPair = peakDetection?.pairs?.find((pair) => pair.id === peakDetection.selectedPairId);
  if (peakDetection?.alternatives?.length
      && Number(selectedPair?.scoreMargin) <= Number(peakDetection?.configuration?.marginScale ?? 0.08)) {
    reasons.push("ambiguous_alternatives");
  }
  if (regions?.g1?.source === "inferred" || regions?.g2?.source === "inferred") reasons.push("inferred_region");
  if (peakDetection?.regionEvidence?.g1?.fallback || peakDetection?.regionEvidence?.g2?.fallback) reasons.push("width_fallback");
  return { required: reasons.length > 0, reasons: [...new Set(reasons)] };
}

/*

Purpose:
	Runs the multi-scale detector against the row's current histogram and stores
	its output in modeling.peakDetection. Replaces the automatic region proposal
	unconditionally, but overwrites the ACTIVE selection only when the user has
	not already made a manual edit -- a rerun (e.g. after a QC change) must not
	silently discard a region the user reviewed.

Input:
	row [object]: the sample row
	options [object]: detector options forwarded to detectCellCyclePeakPair

Output:
	peakDetection [object]: the stored detection result (status, confidence,
	                        pairs, alternatives, ...)

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
    regionEvidence: {
      g1: width_evidence(result.detection.g1Candidate, "g1", result.detection.fallbackSigmaBins),
      g2: width_evidence(result.detection.g2Candidate, "g2", result.detection.fallbackSigmaBins),
    },
    configuration: result.configuration,
  };
  modeling.histogramFingerprint = histogram.fingerprint ?? null;

  modeling.peakSelection.automaticRegions = result.autoPeakRegions;
  const replacingAutomaticSelection = modeling.peakSelection.source === "automatic";
  if (replacingAutomaticSelection) {
    modeling.peakSelection.regions = result.autoPeakRegions;
    modeling.peakSelection.initialCenters = {
      g1: result.detection.g1Candidate?.x ?? null,
      g2: result.detection.g2Candidate?.x ?? null,
    };
    modeling.peakSelection.reviewed = false;
    invalidate_model_results(state, "automatic peak regions redetected");
  }
  modeling.peakSelection.stale = false;
  modeling.revision += 1;

  return modeling.peakDetection;
}

/*

Purpose:
	Switches the active regions to one of the detector's ranked alternative peak
	pairs and invalidates any cached fit results.

Input:
	row [object]: the sample row
	pairId [string]: the id of a detected pair (from detect_peak_regions)

Output:
	peakSelection [object]: the updated selection (throws when pairId is unknown)

*/
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

/*

Purpose:
	Applies a user-edited region pair (from dragging a handle or typing exact
	limits), validating ordering (L1 < R1 <= L2 < R2) before accepting -- an
	invalid edit throws and leaves the previous regions untouched. Marks the
	selection reviewed and invalidates cached fits.

Input:
	row [object]: the sample row
	regions [object]: { g1, g2 } edited regions
	options [object]: { source (default "manual"), minimumGap } -- a small
	                  negative minimumGap tolerates rounding noise at a touching
	                  G1/G2 boundary without relaxing real ordering violations

Output:
	peakSelection [object]: the updated selection (throws on an invalid edit)

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
  modeling.histogramFingerprint = state.histogram?.fingerprint ?? null;
  invalidate_model_results(state, "peak regions edited");
  return modeling.peakSelection;
}

/*

Purpose:
	Marks the current regions as explicitly reviewed, without changing them.

Input:
	row [object]: the sample row

Output:
	peakSelection [object]: the selection, now flagged reviewed and not stale

*/
export function accept_peak_regions(row) {
  const state = get_or_create_state(row);
  const peakSelection = state.modeling.peakSelection;
  peakSelection.reviewed = true;
  peakSelection.stale = false;
  return peakSelection;
}

/*

Purpose:
	Discards any manual edit and restores the detector's automatic region
	proposal, invalidating cached fits.

Input:
	row [object]: the sample row

Output:
	peakSelection [object]: the restored selection (throws when detection has not
	                        run, so there is no automatic proposal to restore)

*/
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

/*

Purpose:
	Returns the row's model-neutral modeling state.

Input:
	row [object]: the sample row

Output:
	modeling [object]: the row's modeling state (created if absent)

*/
export function get_modeling_state(row) {
  return get_or_create_state(row).modeling;
}

/*

Purpose:
	Merges a patch into the row's model settings (e.g. ratio/CV mode, locked
	ratio) without touching histogram, detection, regions, or cached results.
	Changing a constraint isn't proactively invalidated at fine grain here: the
	next fit computes a fresh result key, so a stale settings/result pairing is
	never displayed even though the old entry isn't deleted.

Input:
	row [object]: the sample row
	patch [object]: partial settings to merge

Output:
	settings [object]: the row's merged model settings

*/
export function set_model_settings(row, patch) {
  const modeling = get_or_create_state(row).modeling;
  const supported = new Set(["modelId", "ratioMode", "ratioRange", "lockedRatio", "cvMode", "contaminants", "ploidyCount"]);
  const unknown = Object.keys(patch).find((key) => !supported.has(key));
  if (unknown) throw new Error(`Unsupported model setting "${unknown}".`);
  const changed = Object.entries(patch).some(([key, value]) => stable_json(modeling.settings[key]) !== stable_json(value));
  Object.assign(modeling.settings, patch);
  if (changed) {
    modeling.activeResultKey = null;
    modeling.modelComparison = null;
    modeling.lastInvalidationReason = "model settings changed";
    modeling.revision += 1;
  }
  return modeling.settings;
}

function merge_config(base, patch) {
  const result = { ...base };
  for (const [key, value] of Object.entries(patch ?? {})) {
    result[key] = value && typeof value === "object" && !Array.isArray(value)
      ? merge_config(result[key] ?? {}, value)
      : value;
  }
  return result;
}

function assert_known_config(patch, template, prefix = "") {
  for (const [key, value] of Object.entries(patch ?? {})) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (!(key in (template ?? {}))) throw new Error(`Unsupported model configuration "${path}".`);
    if (value && typeof value === "object" && !Array.isArray(value)) {
      assert_known_config(value, template[key], path);
    }
  }
}

export function resolve_model_configuration(modelId, settings, overrides = {}) {
  const entry = get_model(modelId);
  if (!entry) throw new Error(`Unknown cell-cycle model "${modelId}".`);
  const contaminants = Object.values(settings?.contaminants ?? {}).some((value) => value !== "off");
  if (contaminants || (settings?.ploidyCount ?? 1) !== 1) {
    throw new Error(`Model "${modelId}" does not support the configured contaminants or ploidy count.`);
  }
  const fitted = {
    ratioMode: settings?.ratioMode,
    fitRatioRange: settings?.ratioRange ? [...settings.ratioRange] : undefined,
    lockedRatio: settings?.lockedRatio,
    cvMode: settings?.cvMode,
  };
  const clean = Object.fromEntries(Object.entries(fitted).filter(([, value]) => value !== undefined));
  if (modelId === "auto_dj_djf") {
    const unknown = Object.keys(overrides).find((key) => !["dj", "djf", "selection"].includes(key));
    if (unknown) throw new Error(`Unsupported model configuration "${unknown}".`);
    assert_known_config(overrides.dj, get_model("dean_jett").defaultConfig, "dj");
    assert_known_config(overrides.djf, get_model("dean_jett_fox").defaultConfig, "djf");
    return merge_config(entry.defaultConfig, {
      dj: merge_config(clean, overrides.dj),
      djf: merge_config(clean, overrides.djf),
      selection: overrides.selection ?? entry.defaultConfig.selection,
    });
  }
  const supported = modelId === "dean_jett" || modelId === "dean_jett_fox" ? clean : {};
  if (!Object.keys(supported).length) {
    const changed = settings && (settings.ratioMode !== "bounded"
      || settings.cvMode !== "free"
      || settings.lockedRatio !== 2
      || stable_json(settings.ratioRange) !== stable_json([1.65, 2.25]));
    if (changed) throw new Error(`Model "${modelId}" does not support ratio or CV settings.`);
  }
  assert_known_config(overrides, entry.defaultConfig);
  return merge_config(merge_config(entry.defaultConfig, supported), overrides);
}

function stable_json(value) {
  if (Array.isArray(value) || ArrayBuffer.isView(value)) return `[${[...value].map(stable_json).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable_json(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function digest(value) {
  const text = stable_json(value);
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) hash = Math.imul(hash ^ text.charCodeAt(index), 16777619);
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/*

Purpose:
	Deterministic cache key for one (model, histogram, regions) combination. The
	fit-domain and configuration-hash components are deferred until an
	advanced-controls UI exists to vary them, so today every fit for a given
	model/histogram/regions triple overwrites the same key.

Input:
	modelId [string]: the model id
	modeling [object]: the row's modeling state (for the histogram fingerprint
	                   and region revision)
	histogram [object]: the current histogram (fingerprint fallback)

Output:
	key [string]: the result cache key

*/
function build_result_key(modelId, entry, row, state, config) {
  const modeling = state.modeling;
  const histogram = state.histogram;
  const masks = row?.data?.masks ?? {};
  return [
    `${modelId}@${entry.version ?? "unversioned"}`,
    `config=${digest(config)}`,
    `content=${digest(row?.data?.channels?.DNA_A ?? [])}`,
    `row=${row?.id ?? ""}`,
    `channel=${state.channelKey ?? ""}`,
    `masks=${digest([masks.structural, masks.timeQC, masks.scatter, masks.singlet, masks.final])}`,
    `hist=${modeling.histogramFingerprint ?? histogram?.fingerprint ?? ""}`,
    `bins=${digest([histogram?.edges ?? [], histogram?.counts ?? histogram?.y ?? []])}`,
    `regions=${modeling.peakSelection.revision}:${modeling.peakSelection.reviewed ? "reviewed" : "unreviewed"}`,
    `domain=${digest(modeling.fitDomain)}`,
  ].join("|");
}

/*

Purpose:
	Fits a model against the row's current histogram and accepted G1/G2 peak
	regions, storing the normalized result in modeling.resultsByKey and making it
	the active result. Runs off the UI thread via the shared fit worker when
	available, falling back to a synchronous main-thread fit only when worker
	creation itself failed (fit_client.js's documented fallback).

Input:
	row [object]: the sample row
	modelId [string]: a registered model id
	options [object]: { onProgress, ...config } forwarded to the fit

Output:
	result [Promise<object>]: the normalized fit result (throws when the
	                          histogram, regions, or model id is missing/unknown)

*/
export async function fit_cell_cycle_model(row, modelId, options = {}) {
  const state = get_or_create_state(row);
  const modeling = state.modeling;
  const entry = get_model(modelId);
  if (!entry) {
    throw new Error(`Unknown cell-cycle model "${modelId}".`);
  }
  // Joint time-series models (CLOCCS) are fit over a whole strain's timepoints,
  // never a single sample. Reject them here so every per-sample entry point --
  // the Fit Current button, a bin-change recompute, a ridge-region edit, a
  // session restore -- gets one clear message instead of a raw model throw.
  if (entry.fitScope === "joint_series") {
    throw new Error(
      `"${entry.label ?? modelId}" is a joint time-series model — fit it over all plotted timepoints (Fit All Samples), not a single sample.`,
    );
  }

  const histogram = state.histogram;
  modeling.fitDomain = {
    min: histogram?.min ?? null,
    max: histogram?.max ?? null,
    binCount: histogram?.binCount ?? null,
  };
  const peakRegions = modeling.peakSelection.regions;
  const { onProgress, signal, qcWaivers = state.qcWaivers ?? {}, requiredQc, minimumRetainedEvents, ...overrides } = options;
  const config = resolve_model_configuration(modelId, modeling.settings, overrides);
  const preflight = model_preflight(state, { minimumRetainedEvents, qcWaivers, requiredQc, configuration: config });
  if (!preflight.passed) {
    const error = new Error(preflight.reasons[0].message);
    error.code = preflight.reasons[0].code;
    error.preflight = preflight;
    throw error;
  }

  const worker = run_fit_in_worker(modelId, histogram, config, { peakRegions, onProgress });
  if (signal?.aborted) worker?.cancel();
  const abort = () => worker?.cancel();
  signal?.addEventListener?.("abort", abort, { once: true });
  let rawResult = worker
    ? await worker.promise
    : entry.normalizeResult(entry.fit({ histogram, peakRegions, config }));
  signal?.removeEventListener?.("abort", abort);
  if (signal?.aborted) rawResult = { ...rawResult, cancelled: true };
  const result = apply_result_contract(rawResult, preflight);
  result.appliedConfiguration = config;
  result.channelEligibility = state.channelEligibility ? deep_clone(state.channelEligibility) : null;
  result.histogramProvenance = {
    domain: { ...modeling.fitDomain },
    binEdges: Array.from(histogram?.edges ?? []),
    counts: Array.from(histogram?.counts ?? histogram?.y ?? []),
    underflow: histogram?.underflow ?? 0,
    overflow: histogram?.overflow ?? 0,
    binnedCount: histogram?.binnedCount ?? 0,
    retainedCount: histogram?.retainedCount ?? 0,
    componentTailCoverage: null,
  };

  const resultKey = build_result_key(modelId, entry, row, state, config);
  modeling.resultsByKey[resultKey] = result;
  modeling.activeResultKey = result.validForReporting ? resultKey : null;
  modeling.lastDiagnosticResultKey = result.validForReporting ? null : resultKey;
  modeling.settings.modelId = modelId;
  modeling.revision += 1;
  return result;
}
