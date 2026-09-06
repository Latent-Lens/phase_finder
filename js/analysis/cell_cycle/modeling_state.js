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

import { get_or_create_state, invalidate_model_results } from "../pipeline/pipeline_state.js";
import { detectCellCyclePeakPair, proposeAutomaticPeakRegions } from "./peak_detection.js";
import { validatePeakRegions } from "./peak_regions.js";
import { get_model, list_models } from "./model_registry.js";
import { run_fit_in_worker, run_domain_sensitivity_in_worker, run_resample_uncertainty_in_worker } from "./fit_client.js";
import { apply_result_contract, model_preflight } from "./result_contract.js";
import { domainCoverageAudit, analyzeDomainSensitivity } from "./domain_sensitivity.js";
import { resampleUncertainty } from "./resampling.js";
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

// STATE-01: which models can actually CONSUME the ratio/CV settings.
//
// These settings constrain peak means and widths, so a model consumes them only
// if it actually OPTIMIZES those parameters. Dean-Jett and Watson Classic fit
// the peaks jointly, so the constraints shape their fits.
//
// Watson Pragmatic is a closed-form decomposition: it derives each peak directly
// from its reviewed region and runs no optimizer, so a ratio band or an equal-CV
// rule has nothing to act on. Dean-Jett-Fox is in the same position for a
// different reason: it measures both peaks from their clean flanks and holds
// them FIXED, optimizing only the S phase, so a constraint on peak means and
// widths constrains parameters the optimizer never moves. Folding those settings
// into either model's config would make the result key claim a difference the
// numbers do not have, and would make a restored session imply a constraint that
// was never applied. The fitted G2:G1 ratio is still reported as a diagnostic by
// constraint_audit.js -- it is evaluated, just not enforced.
const RATIO_CV_CONSUMING_MODELS = new Set(["dean_jett", "watson_classic"]);

const DEFAULT_RATIO_CV_SETTINGS = Object.freeze({
  ratioMode: "bounded", cvMode: "free", lockedRatio: 2, ratioRange: [1.65, 2.25],
});

/*

Purpose:
	Whether a ratio/CV settings block differs from the defaults -- i.e. whether
	the user (or a restored session) is asking for something the model may not be
	able to honour.

Input:
	settings [object]: the row's modeling settings

Output:
	changed [boolean]: true when any ratio/CV setting is non-default

*/
function ratio_cv_settings_changed(settings) {
  if (!settings) return false;
  return settings.ratioMode !== DEFAULT_RATIO_CV_SETTINGS.ratioMode
    || settings.cvMode !== DEFAULT_RATIO_CV_SETTINGS.cvMode
    || settings.lockedRatio !== DEFAULT_RATIO_CV_SETTINGS.lockedRatio
    || stable_json(settings.ratioRange) !== stable_json(DEFAULT_RATIO_CV_SETTINGS.ratioRange);
}

/*

Purpose:
	Reports which of the row's settings the chosen model will actually apply, so
	the caller can record the not-applied ones as provenance instead of letting
	them silently vanish (or, worse, letting them change the result key while
	changing nothing else).

Input:
	modelId [string]: a registered model id
	settings [object]: the row's modeling settings

Output:
	report [object]: { applied [array], notApplied [array], reason [string|null] }

*/
export function settings_applicability(modelId, settings) {
  const keys = ["ratioMode", "ratioRange", "lockedRatio", "cvMode"];
  if (RATIO_CV_CONSUMING_MODELS.has(modelId)) {
    return { applied: keys, notApplied: [], reason: null };
  }
  const changed = ratio_cv_settings_changed(settings);
  return {
    applied: [],
    notApplied: changed ? keys : [],
    reason: changed
      ? `${modelId} does not optimize the G1/G2 peak means or widths — it determines them directly from the reviewed peak regions — so the ratio and CV settings cannot affect its fit. Edit the peak regions to move the peaks; the fitted G2:G1 ratio is still reported as a diagnostic.`
      : null,
  };
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

  // Only a model that can act on these settings gets them merged into its
  // config -- and therefore into the config hash and the result key.
  const supported = RATIO_CV_CONSUMING_MODELS.has(modelId) ? clean : {};
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
  // QC-01: qcAcknowledgements rides the same route as qcWaivers -- read off the
  // pipeline state for this sample unless the caller overrides. Without this the
  // contract's critical-removal gate was a dead end: it read the field and
  // nothing on any path ever supplied it.
  const {
    onProgress, signal,
    qcWaivers = state.qcWaivers ?? {},
    qcAcknowledgements = state.qcAcknowledgements ?? {},
    requiredQc, minimumRetainedEvents, ...overrides
  } = options;
  const config = resolve_model_configuration(modelId, modeling.settings, overrides);
  const preflight = model_preflight(state, {
    minimumRetainedEvents, qcWaivers, qcAcknowledgements, requiredQc, configuration: config,
  });
  if (!preflight.passed) {
    const error = new Error(preflight.reasons[0].message);
    error.code = preflight.reasons[0].code;
    error.preflight = preflight;
    throw error;
  }

  const requestId = (modeling.fitRequestId ?? 0) + 1;
  modeling.fitRequestId = requestId;
  const inputRevision = modeling.revision;
  const inputHistogram = state.histogram;

  const worker = run_fit_in_worker(modelId, histogram, config, { peakRegions, onProgress });
  if (signal?.aborted) worker?.cancel();
  const abort = () => worker?.cancel();
  signal?.addEventListener?.("abort", abort, { once: true });
  let rawResult = worker
    ? await worker.promise
    : entry.normalizeResult(entry.fit({ histogram, peakRegions, config }));
  signal?.removeEventListener?.("abort", abort);
  if (modeling.fitRequestId !== requestId || modeling.revision !== inputRevision || state.histogram !== inputHistogram) {
    const error = new Error("Fit inputs changed before this result completed; the stale result was discarded.");
    error.code = "FIT_INPUTS_CHANGED";
    throw error;
  }
  if (signal?.aborted) rawResult = { ...rawResult, cancelled: true };
  const result = apply_result_contract(rawResult, preflight);
  result.appliedConfiguration = deep_clone(config);
  result.peakRegions = deep_clone(peakRegions);
  result.configHash = digest(config);
  result.channelEligibility = state.channelEligibility ? deep_clone(state.channelEligibility) : null;
  // DOMAIN-01: the analysis domain and bin grid are scientific inputs, so the
  // exact grid the fit ran on -- and how much of the sample and of the fitted
  // model it left out -- is stored with the result rather than being
  // reconstructible only from whatever the UI happens to show now.
  result.histogramProvenance = {
    domain: { ...modeling.fitDomain },
    binEdges: Array.from(histogram?.edges ?? []),
    binCount: histogram?.binCount ?? (histogram?.edges?.length ? histogram.edges.length - 1 : null),
    counts: Array.from(histogram?.counts ?? histogram?.y ?? []),
    underflow: histogram?.underflow ?? 0,
    overflow: histogram?.overflow ?? 0,
    binnedCount: histogram?.binnedCount ?? 0,
    retainedCount: histogram?.retainedCount ?? 0,
    componentTailCoverage: null,
  };
  // STATE-01: record which of the row's settings this model actually applied,
  // so a setting that cannot bite is visible as not-applied provenance rather
  // than silently vanishing. It is deliberately NOT an error: a session saved
  // with non-default ratio/CV values must still restore.
  const applicability = settings_applicability(modelId, modeling.settings);
  result.settingsApplicability = applicability;
  if (applicability.notApplied.length) {
    result.warnings = [...(result.warnings ?? []), {
      code: "model_settings_not_applied",
      severity: "info",
      message: `${applicability.notApplied.join(", ")} were not applied: ${applicability.reason}`,
    }];
  }

  const coverage = domainCoverageAudit({
    histogramProvenance: result.histogramProvenance,
    components: result.components ?? [],
  });
  result.histogramProvenance.componentTailCoverage = coverage.componentTailCoverage;
  result.domainCoverage = coverage;
  if (coverage.warnings.length) result.warnings = [...(result.warnings ?? []), ...coverage.warnings];
  // A domain that excluded a material part of the sample, or a model whose mass
  // is mostly outside it, does not produce a reportable fraction OF THE SAMPLE.
  if (coverage.status === "invalid") {
    result.validForReporting = false;
    result.invalid = true;
    result.scientificallyValid = false;
    result.validityReasons = [
      ...(result.validityReasons ?? []),
      ...coverage.warnings.map((warning) => ({ code: warning.code, message: warning.message, detail: coverage })),
    ];
  }

  const resultKey = build_result_key(modelId, entry, row, state, config);
  modeling.resultsByKey[resultKey] = result;
  modeling.activeResultKey = result.validForReporting ? resultKey : null;
  modeling.lastDiagnosticResultKey = result.validForReporting ? null : resultKey;
  modeling.settings.modelId = modelId;
  modeling.revision += 1;
  return result;
}

/*

Purpose:
	DOMAIN-01 sensitivity sub-item: actually runs analyzeDomainSensitivity()
	(domain_sensitivity.js) against a completed fit result and folds its verdict
	into that result, using the exact qualify/block convention
	fit_cell_cycle_model() already applies for domainCoverageAudit() above --
	a "warning"/"unknown" status only appends to result.warnings, an "invalid"
	status also flips validForReporting/invalid/scientificallyValid to false and
	appends to validityReasons, and demotes the row's activeResultKey the same
	way a failed coverage audit does.

	Deliberately NOT called from fit_cell_cycle_model()'s hot path: the sweep
	refits the sample once per bin count x domain perturbation (12 fits with the
	defaults), so wiring it into every interactive fit would make Fit Current /
	Fit All Samples multiply their own latency by roughly that factor. Instead
	this is a separate, opt-in call a caller makes on a result it already has --
	e.g. once before an export or a "final" review, not on every peak-region
	tweak -- exactly like analyzeDomainSensitivity()'s own header describes its
	intended usage. It runs the whole sweep inside the shared fit worker pool
	(run_domain_sensitivity_in_worker(), fit_worker.js's "domain_sensitivity"
	message) so that cost lands off the UI thread the same way a single fit does,
	falling back to a synchronous main-thread sweep (blocking the UI for the
	sweep's full duration) only in fit_client.js's documented no-worker case.

Input:
	row [object]: the sample row the result was fit against
	result [object]: a result previously returned by fit_cell_cycle_model() for
	                 this row (mutated in place and also returned)
	options [object]: optional { binCounts, perturbations (forwarded to
	                  analyzeDomainSensitivity(), default when omitted),
	                  onProgress, signal (AbortSignal) }

Output:
	result [Promise<object>]: the same result object, with domainSensitivity set
	                          and warnings/validity updated per the verdict
	                          (throws if the row's fit inputs changed underneath
	                          this call, or if `result` isn't a real fit result)

*/
export async function assess_domain_sensitivity(row, result, options = {}) {
  if (!result?.modelId) {
    throw new TypeError("assess_domain_sensitivity requires a contracted fit result (with modelId).");
  }
  const entry = get_model(result.modelId);
  if (!entry) {
    throw new Error(`Unknown cell-cycle model "${result.modelId}".`);
  }
  const domain = result.histogramProvenance?.domain;
  if (!Number.isFinite(domain?.min) || !Number.isFinite(domain?.max)) {
    throw new TypeError(
      "assess_domain_sensitivity requires a result with a stored histogramProvenance.domain (min/max).",
    );
  }
  // The retained DNA values this result's histogram was binned from. Read
  // directly off row.data.filtered rather than recomputing via
  // build_filtered_view(row): that helper bumps data.filteredViewRevision as a
  // side effect, which would desync ensure_histogram_current()'s freshness
  // check and force a spurious histogram rebuild (and downstream invalidation)
  // on the next stage call. build_filtered_view() already ran as part of
  // producing this result's histogram, so the filtered view is already here.
  const values = Array.from(row?.data?.filtered?.channels?.DNA_A ?? []);
  if (!values.length) {
    throw new TypeError("assess_domain_sensitivity requires the row's filtered DNA_A channel (fit the row first).");
  }

  const state = get_or_create_state(row);
  const modeling = state.modeling;
  const { binCounts, perturbations, onProgress, signal } = options;

  // Same staleness guard fit_cell_cycle_model() uses around its own await: the
  // sweep can take several fit-durations, long enough for a newer fit (or a
  // gating change that rebuilds the histogram) to land on this row first.
  const inputRevision = modeling.revision;
  const inputHistogram = state.histogram;

  const spec = {
    modelId: result.modelId,
    values,
    domain,
    peakRegions: result.peakRegions,
    config: result.appliedConfiguration,
    binCounts,
    perturbations,
  };
  const worker = run_domain_sensitivity_in_worker(spec, { onProgress });
  if (signal?.aborted) worker?.cancel();
  const abort = () => worker?.cancel();
  signal?.addEventListener?.("abort", abort, { once: true });
  const analysis = worker
    ? await worker.promise
    : analyzeDomainSensitivity({
      values,
      domain,
      binCounts,
      perturbations,
      fitFn: (histogram) => {
        const rawVariantResult = entry.fit({ histogram, peakRegions: result.peakRegions, config: result.appliedConfiguration });
        const normalized = entry.normalizeResult(rawVariantResult);
        return { phaseFractions: normalized.phaseFractions, modelId: normalized.modelId ?? result.modelId };
      },
    });
  signal?.removeEventListener?.("abort", abort);

  if (modeling.revision !== inputRevision || state.histogram !== inputHistogram) {
    const error = new Error(
      "Fit inputs changed before this sensitivity analysis completed; the stale result was discarded.",
    );
    error.code = "FIT_INPUTS_CHANGED";
    throw error;
  }

  result.domainSensitivity = analysis;
  if (analysis.warnings.length) result.warnings = [...(result.warnings ?? []), ...analysis.warnings];
  // Same hard-block convention as domainCoverageAudit() above: fractions that
  // moved past the documented invalid tolerance are not a reportable
  // measurement OF THE SAMPLE, regardless of how clean the fit itself looked.
  if (analysis.status === "invalid") {
    result.validForReporting = false;
    result.invalid = true;
    result.scientificallyValid = false;
    result.validityReasons = [
      ...(result.validityReasons ?? []),
      ...analysis.warnings.map((warning) => ({ code: warning.code, message: warning.message, detail: analysis })),
    ];
    const resultKey = Object.keys(modeling.resultsByKey).find((key) => modeling.resultsByKey[key] === result);
    if (resultKey && modeling.activeResultKey === resultKey) {
      modeling.activeResultKey = null;
      modeling.lastDiagnosticResultKey = resultKey;
    }
  }
  return result;
}

// Duplicated (not shared) from fit_worker.js's own build_resampling_fit_fn:
// this is the no-worker fallback used only when fit_client.js could not
// create a worker at all, and it needs the SAME per-model closure the worker
// builds -- one call per replicate, returning one { modelId, comparisonGroup,
// phaseFractions, bic, converged, parameters } outcome per supplied model, with
// a model that throws on a perturbed variant reported as non-converged for
// that model only rather than losing every other model's outcome for the
// replicate. Kept private and duplicated rather than imported from
// fit_worker.js because that module registers a "message" listener on `self`
// at load time, which would attach to the main thread's `window` instead of a
// worker's scope if imported here.
function resampling_fit_fn(models) {
  const entries = (models ?? []).map(({ modelId, config }) => {
    const entry = get_model(modelId);
    if (!entry) throw new Error(`Unknown model "${modelId}".`);
    return { modelId, config, entry };
  });
  return ({ histogram, peakRegions }) => entries.map(({ modelId, config, entry }) => {
    try {
      const rawVariantResult = entry.fit({ histogram, peakRegions, config });
      const normalized = entry.normalizeResult(rawVariantResult);
      return {
        modelId: normalized.modelId ?? modelId,
        comparisonGroup: normalized.comparisonGroup ?? entry.comparisonGroup ?? null,
        phaseFractions: normalized.phaseFractions ?? null,
        bic: Number.isFinite(normalized.diagnostics?.bic) ? normalized.diagnostics.bic : null,
        converged: normalized.converged === true,
        parameters: normalized.parameters ?? null,
      };
    } catch (thrown) {
      return {
        modelId, comparisonGroup: entry.comparisonGroup ?? null,
        phaseFractions: null, bic: null, converged: false, parameters: null,
      };
    }
  });
}

// A resampling warning that must withhold the number, using the exact same
// predicate result_contract.js's apply_result_contract() applies to its own
// warnings -- so a critical resampling warning demotes a result the same way
// a critical fit-quality warning already does, rather than inventing a second
// notion of "critical" for this one caller.
function resampling_warning_critical(warning) {
  return warning?.nonreportable === true || warning?.severity === "critical" || warning?.severity === "error";
}

/*

Purpose:
	UNC-01: actually runs resampleUncertainty() (resampling.js) against a
	completed fit result and folds its bundle into that result, using the same
	qualify/block convention assess_domain_sensitivity() above already applies
	-- the bundle's warnings are merged into result.warnings via the same
	{id/code, severity, nonreportable, message} vocabulary GATE-02 qualifies
	everywhere else, and a critical/nonreportable warning also flips
	validForReporting/invalid/scientificallyValid to false and demotes the
	row's activeResultKey, exactly like a failed domain-sensitivity or coverage
	verdict does.

	Resamples the active model's whole comparisonGroup (not just the active
	model alone) when the model has one: resampleUncertainty()'s `selection`
	box (model-selection frequency/instability) is degenerate -- always
	frequency 1.0 -- for a single model, and rankableOutcomes() in
	resampling.js already restricts BIC ranking to one non-null comparisonGroup,
	so resampling exactly that group is what makes `selection` a real
	measurement instead of a formality. A null comparisonGroup (e.g.
	watson_pragmatic) is never AIC/BIC-ranked against anything, so it resamples
	alone. cloccs is excluded up front: it is fitScope "joint_series" and does
	not accept the {histogram, peakRegions, config} call shape every per-sample
	model here does.

	Deliberately NOT called from fit_cell_cycle_model()'s hot path, for the same
	reason assess_domain_sensitivity() is not: resampleUncertainty() is far more
	expensive than a single fit (one refit per model per replicate; the
	register measures whole-bundle costs in minutes for the cheaper models and
	tens of minutes when Dean-Jett-Fox is in the comparison group), so this is a
	separate, opt-in call a caller makes deliberately (an export, a validation
	run, a reviewer's request) on a result it already has.

Input:
	row [object]: the sample row the result was fit against
	result [object]: a result previously returned by fit_cell_cycle_model() for
	                 this row (mutated in place and also returned)
	options [object]: optional { replicates, seed, intervalLevel,
	                  intervalMethod, perturbations (all forwarded to
	                  resampleUncertainty(), defaulting when omitted),
	                  onProgress, signal (AbortSignal) }

Output:
	result [Promise<object>]: the same result object, with result.resampling set
	                          to the bundle and warnings/validity updated per its
	                          contents (throws if the row's fit inputs changed
	                          underneath this call, if `result` isn't a real fit
	                          result, or if the model is a joint-series model)

*/
export async function assess_resampling_uncertainty(row, result, options = {}) {
  if (!result?.modelId) {
    throw new TypeError("assess_resampling_uncertainty requires a contracted fit result (with modelId).");
  }
  const entry = get_model(result.modelId);
  if (!entry) {
    throw new Error(`Unknown cell-cycle model "${result.modelId}".`);
  }
  if (entry.fitScope !== "per_sample") {
    throw new Error(
      `"${entry.label ?? result.modelId}" is a joint time-series model — it cannot be resampled per sample.`,
    );
  }
  const domain = result.histogramProvenance?.domain;
  if (!Number.isFinite(domain?.min) || !Number.isFinite(domain?.max)) {
    throw new TypeError(
      "assess_resampling_uncertainty requires a result with a stored histogramProvenance.domain (min/max).",
    );
  }
  // Same rationale as assess_domain_sensitivity(): read the retained values
  // directly off the already-filtered view rather than recomputing it, so
  // this call does not desync ensure_histogram_current()'s freshness check.
  const values = Array.from(row?.data?.filtered?.channels?.DNA_A ?? []);
  if (!values.length) {
    throw new TypeError("assess_resampling_uncertainty requires the row's filtered DNA_A channel (fit the row first).");
  }

  const state = get_or_create_state(row);
  const modeling = state.modeling;
  const { replicates, seed, intervalLevel, intervalMethod, perturbations, onProgress, signal } = options;

  // Same staleness guard fit_cell_cycle_model() and assess_domain_sensitivity()
  // use around their own awaits: a resampling sweep is by far the slowest
  // operation this module runs, giving a newer fit or a gating change every
  // opportunity to land on this row first.
  const inputRevision = modeling.revision;
  const inputHistogram = state.histogram;

  const peers = entry.comparisonGroup
    ? list_models().filter((candidate) => candidate.fitScope === "per_sample" && candidate.comparisonGroup === entry.comparisonGroup)
    : [entry];
  const models = peers.map((candidate) => ({
    modelId: candidate.id,
    // Reuse the already-resolved configuration for the active model itself
    // (identical to what it was actually fit with); resolve every peer's
    // configuration the same way fit_cell_cycle_model() does, from the row's
    // current settings.
    config: candidate.id === result.modelId
      ? result.appliedConfiguration
      : resolve_model_configuration(candidate.id, modeling.settings),
  }));

  const spec = {
    models, values, domain, binCount: result.histogramProvenance?.binCount ?? null,
    peakRegions: result.peakRegions, replicates, seed, intervalLevel, intervalMethod, perturbations,
  };
  const worker = run_resample_uncertainty_in_worker(spec, { onProgress });
  if (signal?.aborted) worker?.cancel();
  const abort = () => worker?.cancel();
  signal?.addEventListener?.("abort", abort, { once: true });
  const bundle = worker
    ? await worker.promise
    : resampleUncertainty({
      ...spec,
      fitFn: resampling_fit_fn(models),
      shouldCancel: () => signal?.aborted === true,
      onProgress,
    });
  signal?.removeEventListener?.("abort", abort);

  if (modeling.revision !== inputRevision || state.histogram !== inputHistogram) {
    const error = new Error(
      "Fit inputs changed before this resampling analysis completed; the stale result was discarded.",
    );
    error.code = "FIT_INPUTS_CHANGED";
    throw error;
  }

  result.resampling = bundle;
  if (bundle.warnings.length) result.warnings = [...(result.warnings ?? []), ...bundle.warnings];
  // Same hard-block convention as domainCoverageAudit()/assess_domain_sensitivity()
  // above: a resampling warning marked critical/nonreportable (too few usable
  // replicates, too high a failure rate, an interval that could not be
  // computed, or a fraction too uncertain to report) means the number is not
  // reportable OF THE SAMPLE, regardless of how clean the point estimate looked.
  if (bundle.warnings.some(resampling_warning_critical)) {
    result.validForReporting = false;
    result.invalid = true;
    result.scientificallyValid = false;
    result.validityReasons = [
      ...(result.validityReasons ?? []),
      ...bundle.warnings.filter(resampling_warning_critical)
        .map((warning) => ({ code: warning.id, message: warning.message, detail: bundle })),
    ];
    const resultKey = Object.keys(modeling.resultsByKey).find((key) => modeling.resultsByKey[key] === result);
    if (resultKey && modeling.activeResultKey === resultKey) {
      modeling.activeResultKey = null;
      modeling.lastDiagnosticResultKey = resultKey;
    }
  }
  return result;
}
