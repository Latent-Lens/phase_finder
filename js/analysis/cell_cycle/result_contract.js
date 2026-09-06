// Authoritative validity contract shared by every per-sample model entry point
// and result consumer.  A computed curve is not automatically a reportable
// scientific result: input preconditions and output quality are recorded
// independently, with machine-readable reasons.

import { validatePeakRegions } from "./peak_regions.js";

export const RESULT_REASON = Object.freeze({
  HISTOGRAM_MISSING: "histogram_missing",
  HISTOGRAM_STALE: "histogram_stale",
  HISTOGRAM_INVALID: "histogram_invalid",
  REGIONS_MISSING: "regions_missing",
  REGIONS_UNREVIEWED: "regions_unreviewed",
  REGIONS_STALE: "regions_stale",
  DNA_INELIGIBLE: "dna_ineligible",
  EVENTS_INSUFFICIENT: "events_insufficient",
  HISTOGRAM_SUPPORT_INSUFFICIENT: "histogram_support_insufficient",
  PEAK_SUPPORT_INSUFFICIENT: "peak_support_insufficient",
  QC_NOT_PASSED: "qc_not_passed",
  QC_CRITICAL_REMOVAL: "qc_critical_removal",
  CONFIG_INVALID: "configuration_invalid",
  CONSTRAINT_INVALID: "constraint_invalid",
  FIT_CANCELLED: "fit_cancelled",
  OPTIMIZER_NOT_CONVERGED: "optimizer_not_converged",
  RESULT_NONFINITE: "result_nonfinite",
  FRACTIONS_INVALID: "fractions_invalid",
  FIT_PEAK_DEGENERATE: "fit_peak_degenerate",
  REGIONS_AMBIGUOUS_SINGLE_PEAK: "regions_ambiguous_single_peak",
});

// GATE-01. apply_result_contract() is the ONLY function that stamps a result
// with this version, and it refuses to run without a preflight bundle. A result
// therefore carries the stamp if and only if it went through both halves of the
// contract, so a consumer can positively verify that -- rather than relying on
// `validForReporting` being absent-and-therefore-falsy on a raw model output,
// which is indistinguishable from a result whose validator simply never ran.
export const RESULT_CONTRACT_VERSION = 2;

/*

Purpose:
	Whether a result object carries the current contract stamp, i.e. it was
	produced by apply_result_contract() with a real preflight rather than being a
	raw registry normalizeResult() output handed straight to a consumer.

Input:
	result [object]: any candidate result

Output:
	contracted [boolean]: true when the result went through the contract

*/
export function is_contracted_result(result) {
  return result?.contractVersion === RESULT_CONTRACT_VERSION;
}

/*

Purpose:
	GATE-01 enforcement for a consumer boundary: refuses a result that never went
	through the shared preflight/validator, with a structured error naming the
	offending entry point. Use at any place that is about to treat a result as a
	scientific answer (activate it, display fractions, export it).

Input:
	result [object]: the candidate result
	context [string]: the entry point's name, for the error message

Output:
	result [object]: the same result, when it is contracted (throws otherwise)

*/
export function assert_result_contracted(result, context = "result consumer") {
  if (is_contracted_result(result)) return result;
  const error = new Error(
    `${context} received a model result that never went through the shared preflight/result validator. `
    + "Every UI, worker, session-restore, and direct model entry point must call model_preflight() + apply_result_contract().",
  );
  error.code = "RESULT_NOT_CONTRACTED";
  error.detail = { modelId: result?.modelId ?? null, context };
  throw error;
}

const NONCONVERGED_TERMINATIONS = new Set([
  "boundary_stall",
  "cancelled",
  "max_iterations",
  "numerical_failure",
  "step_stall",
]);

const issue = (code, message, detail = null) => ({ code, message, detail });

// QC-00 mandatory model-boundary thresholds, enforced regardless of any optional
// QC stage. A DNA histogram with too few eligible events cannot support peak
// detection or a stable fit; a channel that produced a large fraction of
// negative/non-finite DNA is not a valid linear DNA-content channel.
export const MINIMUM_MODELING_EVENTS = 100;
export const MINIMUM_NONEMPTY_BINS = 5;
export const MINIMUM_PEAK_SUPPORT_EVENTS = 10;
const MAX_INELIGIBLE_DNA_FRACTION = 0.25;

// QC-01 fail-closed policy. A required stage is only acceptable when it actually
// applied cleanly (with or without loss) or was explicitly waived with a reason;
// any other outcome for a required stage blocks reporting. Removing more than
// this fraction of events on any stage is a critical event loss that must be
// acknowledged before the result can be reported.
export const QC_ACCEPTABLE_STATUSES = Object.freeze(["applied", "passed_no_loss", "waived"]);
export const QC_CRITICAL_REMOVAL_PERCENT = 50;

function finite_histogram(histogram) {
  const counts = histogram?.counts ?? histogram?.y;
  return Array.isArray(counts) || ArrayBuffer.isView(counts)
    ? counts.length > 0 && [...counts].every((value) => Number.isFinite(value) && value >= 0)
    : false;
}

// QC-01 canonical per-stage outcome. Maps a stage product (or its absence) to
// one of the explicit statuses: waived, not_run, cancelled, unavailable,
// skipped_optional, failed, degraded, applied, passed_no_loss -- with the event-
// loss fraction and any warnings/reason preserved so the model boundary can fail
// closed and a batch matrix can render the exact outcome and mask provenance.
export function qc_outcome(product, waiver) {
  // A waiver only counts when it carries a reason/provenance (QC-01): a selected
  // stage that cannot run may be waived, but only deliberately and on the record.
  if (waiver && waiver.reason) return { status: "waived", reason: waiver.reason, waiver };
  if (!product) return { status: "not_run" };
  if (product.cancelled) return { status: "cancelled", reason: product.reason ?? product.status ?? null };

  // Per-stage removal fraction, from whichever counts the stage recorded.
  const rejected = Number(product.rejectedEventCount);
  const retained = Number(product.retainedEventCount);
  const evaluated = Number(product.evaluatedEventCount);
  const denom = Number.isFinite(evaluated) && evaluated > 0
    ? evaluated
    : (Number.isFinite(rejected) && Number.isFinite(retained) ? rejected + retained : NaN);
  const percentRemoved = Number.isFinite(product.percentRemoved)
    ? product.percentRemoved
    : (Number.isFinite(rejected) && Number.isFinite(denom) && denom > 0 ? (100 * rejected) / denom : null);
  const warnings = Array.isArray(product.warnings) ? product.warnings : [];

  if (product.skipped) {
    // A stage that could not run records a reason (missing channel, too few
    // events); an explicitly-off optional stage carries no such failure reason.
    const unavailable = Boolean(product.reason)
      || /insufficient|no |missing|unavailable|too few/i.test(product.status ?? "");
    return { status: unavailable ? "unavailable" : "skipped_optional", reason: product.reason ?? product.status ?? null };
  }

  const failed = product.failed === true || product.valid === false || product.error != null
    || /fail|error/i.test(product.status ?? "");
  if (failed) return { status: "failed", reason: product.error?.message ?? product.status ?? null, percentRemoved };

  const degraded = warnings.length > 0 || product.limitedReliability === true
    || /review|degraded|limited|not[_ ]evaluable/i.test(product.status ?? "");
  if (degraded) return { status: "degraded", reason: product.status ?? null, percentRemoved, warnings };

  const removed = Number.isFinite(rejected) && rejected > 0;
  return { status: removed ? "applied" : "passed_no_loss", reason: null, percentRemoved };
}

function has_nonfinite_number(value) {
  if (typeof value === "number") return !Number.isFinite(value);
  if (Array.isArray(value)) return value.some(has_nonfinite_number);
  if (value && typeof value === "object") return Object.values(value).some(has_nonfinite_number);
  return false;
}

function has_nan_number(value) {
  if (typeof value === "number") return Number.isNaN(value);
  if (Array.isArray(value)) return value.some(has_nan_number);
  if (value && typeof value === "object") return Object.values(value).some(has_nan_number);
  return false;
}

/*

Purpose:
	QC-01 step 4, the one the checklist singles out as "the one to get right":
	an acknowledgement that survives a configuration change silently
	re-authorizes a different analysis.

	Rather than trying to enumerate every event that ought to invalidate an
	acknowledgement (a QC option toggled, a threshold moved, a different file
	reconnected to the same row, a stage re-run on a different upstream mask),
	this binds the acknowledgement to the *outcome it acknowledged*. The key
	below is derived from the stage product itself: its config hash where the
	stage records one, and the event counts it actually produced. Change the QC
	configuration or the file bytes and the stage re-runs, its counts move, its
	key changes, and the stored acknowledgement no longer matches -- so it stops
	authorizing without anything having to remember to revoke it.

	That is deliberately the inverse of a revocation list. A revocation list is
	only as complete as the last person to think of a new invalidation trigger;
	a match on identity fails closed by construction, because an acknowledgement
	that does not name the current outcome simply is not an acknowledgement of it.

	What the key covers: the stage's own configuration (via `configHash`, which
	the pipeline already computes for the cached stages) and the evaluated /
	rejected / retained counts, which are a function of the file bytes, every
	upstream mask, and the stage's own thresholds. What it does NOT cover: a
	change that leaves all three counts and the config hash identical. Two
	different configurations that reject exactly the same number of exactly the
	same events are the same removal decision for the purpose of this
	acknowledgement, so treating them as interchangeable is correct, not a gap.

Input:
	name [string]: the QC stage name ("structural" | "time" | "scatter" | "singlet")
	product [object|null]: the raw stage product from pipeline state

Output:
	key [string|null]: a stable identity for this stage outcome, or null when
	                   there is no product to acknowledge

*/
export function qc_acknowledgement_key(name, product) {
  if (!product || typeof product !== "object") return null;
  const count = (value) => (Number.isFinite(Number(value)) ? String(Number(value)) : "?");
  return [
    name,
    product.configHash ?? "-",
    count(product.evaluatedEventCount),
    count(product.rejectedEventCount),
    count(product.retainedEventCount),
  ].join("|");
}

/*

Purpose:
	QC-01: decides whether a stored acknowledgement actually authorizes the
	critical event loss the current stage outcome represents. Accepts only an
	acknowledgement that names this exact outcome (see qc_acknowledgement_key).

	A bare truthy value is deliberately NOT accepted. Before QC-01 the contract
	tested `!qcAcknowledgements[name]`, so any truthy placeholder -- `true`, an
	empty object, a leftover from a previous configuration -- would have opened
	the gate. Requiring the key makes an acknowledgement unforgeable by accident.

Input:
	acknowledgement [object|null]: the stored record for this stage
	key [string|null]: the current outcome's identity

Output:
	authorized [boolean]: true only when the record acknowledges THIS outcome

*/
export function qc_acknowledgement_authorizes(acknowledgement, key) {
  if (!acknowledgement || typeof acknowledgement !== "object" || !key) return false;
  return acknowledgement.key === key && Boolean(acknowledgement.acknowledgedAt);
}

export function model_preflight(state, {
  minimumRetainedEvents = MINIMUM_MODELING_EVENTS,
  qcWaivers = {},
  qcAcknowledgements = {},
  requiredQc = null,
  configuration = {},
} = {}) {
  const reasons = [];
  const requiredStages = requiredQc ?? state?.requiredQc ?? ["structural"];
  const histogram = state?.histogram;
  const modeling = state?.modeling;
  const selection = modeling?.peakSelection;

  if (!histogram) reasons.push(issue(RESULT_REASON.HISTOGRAM_MISSING, "Build the histogram before fitting."));
  else if (!finite_histogram(histogram)) reasons.push(issue(RESULT_REASON.HISTOGRAM_INVALID, "Histogram counts must be finite and non-negative."));

  // QC-00: a channel that produced a large fraction of negative/non-finite DNA is
  // not a valid linear DNA-content channel. This reads the histogram's recorded
  // eligibility tally, so it enforces the same hard boundary whether or not the
  // optional Structural QC stage ran.
  if (histogram && Number.isFinite(histogram.maskRetainedCount) && histogram.maskRetainedCount > 0) {
    const ineligible = (histogram.rejectedNegative ?? 0) + (histogram.rejectedNonfinite ?? 0)
      + (histogram.rejectedSaturated ?? 0);
    const fraction = ineligible / histogram.maskRetainedCount;
    if (fraction > MAX_INELIGIBLE_DNA_FRACTION) {
      reasons.push(issue(
        RESULT_REASON.DNA_INELIGIBLE,
        `${Math.round(fraction * 100)}% of DNA events are negative or non-finite — this channel is not a valid linear DNA-content channel.`,
        { rejectedNegative: histogram.rejectedNegative ?? 0, rejectedNonfinite: histogram.rejectedNonfinite ?? 0, rejectedSaturated: histogram.rejectedSaturated ?? 0, maskRetained: histogram.maskRetainedCount },
      ));
    }
  }
  if (histogram && modeling?.histogramFingerprint && histogram.fingerprint
      && modeling.histogramFingerprint !== histogram.fingerprint) {
    reasons.push(issue(RESULT_REASON.HISTOGRAM_STALE, "Peak selection belongs to a different histogram revision."));
  }
  if (!selection?.regions) reasons.push(issue(RESULT_REASON.REGIONS_MISSING, "Identify G1/G2 peak regions before fitting."));
  else {
    try {
      validatePeakRegions(selection.regions);
    } catch (error) {
      reasons.push(issue(RESULT_REASON.CONSTRAINT_INVALID, error.message));
    }
  }
  if (selection?.regions && !selection.reviewed) reasons.push(issue(RESULT_REASON.REGIONS_UNREVIEWED, "Review and accept the peak regions before fitting."));
  if (selection?.stale) reasons.push(issue(RESULT_REASON.REGIONS_STALE, "Peak regions are stale for the current histogram."));
  if (!state?.channelKey) reasons.push(issue(RESULT_REASON.DNA_INELIGIBLE, "No eligible DNA channel is active."));
  if (state?.channelEligibility?.eligible === false) {
    reasons.push(issue(
      state.channelEligibility.code ?? RESULT_REASON.DNA_INELIGIBLE,
      state.channelEligibility.message ?? "The selected DNA channel is incompatible with linear DNA modeling.",
      { channelEligibility: state.channelEligibility },
    ));
  } else if (
    state?.channelEligibility?.transform?.applied === true
    || state?.channelEligibility?.compensation?.applied === true
    || (state?.channelEligibility?.transform?.applicationCount ?? 0) !== 0
    || (state?.channelEligibility?.compensation?.applicationCount ?? 0) !== 0
  ) {
    reasons.push(issue(
      "fcs_transform_state_invalid",
      "The selected DNA channel was transformed or compensated outside PhaseFinder's raw-linear input contract.",
      { channelEligibility: state.channelEligibility },
    ));
  }

  const retained = histogram ? [...(histogram.counts ?? histogram.y ?? [])].reduce((sum, value) => sum + value, 0) : 0;
  if (histogram && retained < minimumRetainedEvents) {
    reasons.push(issue(RESULT_REASON.EVENTS_INSUFFICIENT, `At least ${minimumRetainedEvents} retained events are required.`, { retained, minimumRetainedEvents }));
  }
  if (histogram) {
    const counts = [...(histogram.counts ?? histogram.y ?? [])];
    const nonempty = counts.filter((value) => value > 0).length;
    if (nonempty < MINIMUM_NONEMPTY_BINS) {
      reasons.push(issue(
        RESULT_REASON.HISTOGRAM_SUPPORT_INSUFFICIENT,
        `At least ${MINIMUM_NONEMPTY_BINS} nonempty histogram bins are required before peak detection or fitting.`,
        { nonemptyBins: nonempty, minimum: MINIMUM_NONEMPTY_BINS },
      ));
    }
    const centers = histogram.centers ?? histogram.x;
    if (selection?.regions && centers?.length === counts.length) {
      for (const name of ["g1", "g2"]) {
        const region = selection.regions[name];
        const support = counts.reduce((sum, count, index) =>
          sum + (centers[index] >= region.left && centers[index] <= region.right ? count : 0), 0);
        if (support < MINIMUM_PEAK_SUPPORT_EVENTS) {
          reasons.push(issue(
            RESULT_REASON.PEAK_SUPPORT_INSUFFICIENT,
            `${name.toUpperCase()} requires at least ${MINIMUM_PEAK_SUPPORT_EVENTS} events inside its reviewed region.`,
            { peak: name, support, minimum: MINIMUM_PEAK_SUPPORT_EVENTS },
          ));
        }
      }
    }
  }

  // QC-01: keep the raw stage products alongside their derived outcomes. The
  // acknowledgement key is computed from the product (config hash + event
  // counts), not from the outcome, because qc_outcome() deliberately discards
  // the counts once it has turned them into a percentage.
  const QC_PRODUCTS = {
    structural: state?.structuralQC ?? null,
    time: state?.timeQC ?? null,
    scatter: state?.scatterGate ?? null,
    singlet: state?.singletResult ?? null,
  };
  const qc = {
    structural: qc_outcome(QC_PRODUCTS.structural, qcWaivers.structural),
    time: qc_outcome(QC_PRODUCTS.time, qcWaivers.time),
    scatter: qc_outcome(QC_PRODUCTS.scatter, qcWaivers.scatter),
    singlet: qc_outcome(QC_PRODUCTS.singlet, qcWaivers.singlet),
  };
  for (const [name, outcome] of Object.entries(qc)) {
    const required = requiredStages.includes(name);
    if (required && !QC_ACCEPTABLE_STATUSES.includes(outcome.status)) {
      // Fail closed: a required stage is only trustworthy when it applied cleanly
      // or was explicitly waived. skipped/unavailable/degraded/failed/cancelled
      // all block, so an unrun-but-required gate can't slip through.
      const verb = outcome.status === "failed" || outcome.status === "cancelled"
        ? outcome.status
        : `is ${outcome.status.replace(/_/g, " ")}`;
      reasons.push(issue(RESULT_REASON.QC_NOT_PASSED, `Required ${name} QC ${verb}.`, { name, outcome }));
    } else if (!required && (outcome.status === "failed" || outcome.status === "cancelled")) {
      // Even an optional gate that FAILED or was CANCELLED leaves its mask in an
      // unknown state -- refuse to trust whatever survived.
      reasons.push(issue(RESULT_REASON.QC_NOT_PASSED, `${name} QC ${outcome.status} — its event mask cannot be trusted.`, { name, outcome }));
    }
    // Critical event loss on ANY stage must be acknowledged before reporting,
    // rather than passing with only a transient warning. QC-01: the
    // acknowledgement must name THIS outcome -- see qc_acknowledgement_key()
    // above for why identity-matching is used instead of a revocation list.
    // The blocking reason carries `acknowledgementKey` so the review UI can
    // write a record that will actually match, without re-deriving the key.
    if (Number.isFinite(outcome.percentRemoved) && outcome.percentRemoved > QC_CRITICAL_REMOVAL_PERCENT) {
      const key = qc_acknowledgement_key(name, QC_PRODUCTS[name]);
      if (!qc_acknowledgement_authorizes(qcAcknowledgements[name], key)) {
        const stale = Boolean(qcAcknowledgements[name]?.acknowledgedAt) && key
          && qcAcknowledgements[name].key !== key;
        reasons.push(issue(
          RESULT_REASON.QC_CRITICAL_REMOVAL,
          stale
            ? `${name} QC removed ${Math.round(outcome.percentRemoved)}% of events — the previous acknowledgement was for a different QC configuration or a different file and no longer applies. Review and acknowledge this loss again before reporting.`
            : `${name} QC removed ${Math.round(outcome.percentRemoved)}% of events — acknowledge this critical loss before reporting.`,
          { name, percentRemoved: outcome.percentRemoved, acknowledgementKey: key, staleAcknowledgement: stale },
        ));
      }
    }
  }
  if (!configuration || typeof configuration !== "object" || Array.isArray(configuration) || has_nonfinite_number(configuration)) {
    reasons.push(issue(RESULT_REASON.CONFIG_INVALID, "Model configuration must be an object containing only finite numbers."));
  }

  return {
    passed: reasons.length === 0,
    reasons,
    // AMBIG-01/D9: carried through (not a blocking reason -- a human already
    // reviewed and accepted these regions, possibly deliberately, e.g. a
    // Nocodazole-arrested single-population sample) so apply_result_contract()
    // can qualify the resulting fit with a warning rather than silently losing
    // the fact that G1 was assumed from a single visible peak.
    peakDetectionStatus: modeling?.peakDetection?.status ?? null,
    histogramFingerprint: histogram?.fingerprint ?? null,
    regionRevision: selection?.revision ?? null,
    retainedEventCount: retained,
    qc,
  };
}

function valid_fractions(fractions) {
  if (!fractions) return false;
  const values = [fractions.g1, fractions.s, fractions.g2];
  return values.every((value) => Number.isFinite(value) && value >= 0 && value <= 1)
    && Math.abs(values.reduce((sum, value) => sum + value, 0) - 1) <= 1e-6;
}

// A biological peak whose fitted CV sits at its UPPER bound is a broad slab, not
// a resolved DNA peak: a real G1/G2 peak has a CV well under the ~0.30 ceiling,
// so a Gaussian driven to that ceiling has degenerated (typically letting the
// flexible S phase absorb the peak's mass -- the S-overfit failure VALID-01
// surfaced on real G2-heavy data). Returns the first such peak key, or null. The
// lower CV bound is deliberately NOT treated this way: a tight peak legitimately
// sits near the CV floor.
function peak_cv_at_upper_bound(result) {
  const bounds = result.bounds ?? {};
  const params = result.parameters ?? {};
  for (const key of ["g1CV", "g2CV"]) {
    const bound = bounds[key];
    const value = params[key];
    if (Array.isArray(bound) && Number.isFinite(bound[1]) && Number.isFinite(value)
        && value >= bound[1] * (1 - 1e-3)) {
      return key;
    }
  }
  return null;
}

function critical_warning(warning) {
  return warning?.nonreportable === true || warning?.severity === "critical" || warning?.severity === "error";
}

function material_warning(warning) {
  return Boolean(warning) && (critical_warning(warning) || warning.severity !== "info");
}

export function apply_result_contract(rawResult, preflight) {
  // GATE-01: the validator half cannot run without the preflight half. Passing
  // no preflight used to silently produce a stamped-looking result with an empty
  // reason list -- exactly the "computed therefore valid" shortcut this contract
  // exists to prevent.
  if (!preflight || typeof preflight !== "object" || typeof preflight.passed !== "boolean") {
    const error = new TypeError(
      "apply_result_contract() requires the model_preflight() bundle for this fit; a result cannot be validated without its input preconditions.",
    );
    error.code = "PREFLIGHT_MISSING";
    throw error;
  }
  const result = { ...rawResult };
  const reasons = [...(preflight?.reasons ?? [])];
  const cancelled = result.cancelled === true;
  const terminationReason = result.terminationReason ?? result.convergenceReason ?? null;
  const optimizerConverged = result.kind === "decomposition"
    ? null
    : result.converged === true && !NONCONVERGED_TERMINATIONS.has(terminationReason);
  const expected = result.expectedCounts ?? [];
  const finite = (Array.isArray(expected) || ArrayBuffer.isView(expected))
    && expected.length > 0 && [...expected].every((value) => Number.isFinite(value) && value >= 0);
  const diagnostics = result.diagnostics ?? {};
  const diagnosticsFinite = !has_nan_number(diagnostics)
    && ["deviance", "bic", "reducedDeviance"].every(
      (key) => diagnostics[key] === undefined || Number.isFinite(diagnostics[key]),
    );

  if (cancelled) reasons.push(issue(RESULT_REASON.FIT_CANCELLED, "Fitting was cancelled."));
  if (optimizerConverged === false) reasons.push(issue(RESULT_REASON.OPTIMIZER_NOT_CONVERGED, "The optimizer did not converge.", { terminationReason }));
  if (!finite || !diagnosticsFinite) reasons.push(issue(
    RESULT_REASON.RESULT_NONFINITE,
    !finite ? "Expected counts are missing, negative, or non-finite." : "Diagnostics contain a non-finite number.",
  ));
  if (!valid_fractions(result.phaseFractions)) reasons.push(issue(RESULT_REASON.FRACTIONS_INVALID, "Phase fractions are missing or invalid."));

  // SCI-03/GATE-01 honesty (fix for the VALID-01 DJF S-overfit): a fit that
  // converged to a boundary-degenerate optimum -- a biological peak whose CV was
  // driven to its upper bound -- is computed and "converged" but its phase
  // fractions are not trustworthy. Keep the coherent numbers available, but
  // mark them scientifically invalid and carry the caveat with every fraction.
  const degeneratePeakCv = optimizerConverged === null ? null : peak_cv_at_upper_bound(result);
  if (degeneratePeakCv) reasons.push(issue(
    RESULT_REASON.FIT_PEAK_DEGENERATE,
    `The ${degeneratePeakCv === "g1CV" ? "G1" : "G2"} peak width hit its upper CV bound — the component is a broad slab, not a resolved peak, so the phase fractions are unreliable.`,
    { parameter: degeneratePeakCv, value: result.parameters?.[degeneratePeakCv], bound: result.bounds?.[degeneratePeakCv] ?? null },
  ));

  // FlowJo-style reporting: whether to TRUST a fit is ultimately the user's call,
  // so we always present the fractions we actually computed -- whenever they are
  // a coherent, finite distribution that sums to 1 -- and rely on the warnings
  // and the goodness-of-fit statistic to let the user judge. Convergence and
  // peak-degeneracy no longer WITHHOLD the number; they ride along as warnings.
  // Only the genuine absence of a usable number -- a cancelled fit, non-finite
  // output, or fractions that do not form a valid distribution -- leaves nothing
  // to report. (scientificallyValid / limitedReliability are still computed for
  // the detailed diagnostic view and for callers that want the stricter signal.)
  const hasReportableNumber = !cancelled && finite && diagnosticsFinite
    && valid_fractions(result.phaseFractions);
  const goodnessOfFit = Number.isFinite(diagnostics.reducedDeviance) ? diagnostics.reducedDeviance : null;

  // Surface the contract's own quality concerns as warnings so they travel with
  // the reported fractions (the fit's fitQualityWarnings -- reduced deviance,
  // autocorrelation, weak identifiability -- are already in result.warnings).
  const warnings = [...(result.warnings ?? [])];
  // Keep the uncertainty producer's policy fields, including when a caller
  // supplied a flattened warning without `nonreportable`. Distinct parameter
  // or phase messages sharing an ID remain separate warnings.
  for (const warning of result.uncertainty?.warnings ?? []) {
    const index = warnings.findIndex((entry) => (entry.id ?? entry.code) === (warning.id ?? warning.code)
      && entry.message === warning.message);
    if (index < 0) warnings.push(warning);
    else warnings[index] = { ...warnings[index], ...warning };
  }
  if (result.constraintAudit?.violationCount > 0) {
    const message = "The fit violates its declared parameter or phase constraints; the fractions are unreliable.";
    reasons.push(issue(RESULT_REASON.CONSTRAINT_INVALID, message, result.constraintAudit.violations));
    warnings.push({ code: RESULT_REASON.CONSTRAINT_INVALID, severity: "error", message });
  }
  if (optimizerConverged === false) warnings.push({
    code: RESULT_REASON.OPTIMIZER_NOT_CONVERGED, severity: "warning",
    message: `The optimizer did not converge (${terminationReason ?? "unknown"}); treat the fractions with caution.`,
  });
  if (degeneratePeakCv) warnings.push({
    code: RESULT_REASON.FIT_PEAK_DEGENERATE, severity: "warning",
    message: `The ${degeneratePeakCv === "g1CV" ? "G1" : "G2"} peak width hit its upper CV bound — the component is a broad slab, not a resolved peak, so its phase fractions may be unreliable.`,
  });
  // AMBIG-01: reviewing and accepting an inferred_g2 selection does not resolve
  // the underlying ambiguity -- it only means a human looked at the same guess
  // (single peak -> assumed G1, G2/M placed by expected ratio) and chose to
  // proceed. Qualify rather than refuse: this may be the correct call (e.g. a
  // deliberately arrested sample), so the contract does not block it, but a
  // consumer reading only warnings should not lose the fact that G1 was assumed.
  if (preflight?.peakDetectionStatus === "inferred_g2") warnings.push({
    code: RESULT_REASON.REGIONS_AMBIGUOUS_SINGLE_PEAK, severity: "warning",
    message: "Only one peak was detected for this sample; G1 was assumed and G2/M was inferred from the expected ratio — confirm the regions are correct, since the sample could be G2-arrested instead.",
  });

  // Quality warnings qualify rather than hide coherent numbers. Critical or
  // nonreportable uncertainty does rule out the stronger scientific-validity
  // claim; an informational settings note alone does neither.
  const scientificallyValid = !cancelled && finite && diagnosticsFinite
    && valid_fractions(result.phaseFractions) && optimizerConverged !== false
    && !degeneratePeakCv && !warnings.some(critical_warning);
  const limitedReliability = optimizerConverged === false || warnings.some(material_warning);

  return {
    ...result,
    contractVersion: RESULT_CONTRACT_VERSION,
    converged: optimizerConverged === null ? result.converged : optimizerConverged,
    computed: !cancelled,
    optimizerConverged,
    scientificallyValid,
    limitedReliability,
    goodnessOfFit,
    warnings,
    validForReporting: hasReportableNumber,
    cancelled,
    invalid: !hasReportableNumber,
    validityReasons: reasons,
    preflight,
  };
}

export function is_reportable_result(result) {
  // GATE-01: reportable requires BOTH the contract stamp and the verdict. An
  // un-contracted object cannot be reportable no matter what fields it carries.
  return is_contracted_result(result) && result.validForReporting === true;
}

export function result_reporting_summary(result) {
  if (!result) return { reportable: false, status: "No result", reason: "", phaseFractions: null };
  // GATE-01: an un-contracted result is summarized as not reportable, but its
  // own recorded reasons are still shown -- several tests and diagnostic views
  // build a bare summary object deliberately, and they should read honestly
  // rather than throw.
  const reportable = is_reportable_result(result);
  const caveat = fraction_trust_reason(result);
  const reason = result.validityReasons?.map((entry) => entry.message || entry.code).join("; ")
    || (reportable ? caveat : "")
    || result.convergenceReason
    || caveat
    || "No reason recorded";
  return {
    reportable,
    status: reportable ? (caveat ? "Reportable with warnings" : "Reportable") : result.cancelled ? "Cancelled" : result.converged ? "Not reportable" : "Not converged",
    reason,
    phaseFractions: reportable ? result.phaseFractions : null,
  };
}

/*

Purpose:
	UI-01: the single source of truth for WHY a phase fraction should not be
	read as authoritative. Lives here, in the DOM-free result contract, rather
	than in js/ui/ because three different layers need it -- the metadata table
	and sidebar (js/ui/cell_cycle_columns.js), the accessible plot summary and
	SVG <desc> (js/plotting/render.js), and the HTML/PDF report
	(js/plotting/plot_export.js). Importing it from js/ui/ closed a real
	import cycle (render.js -> cell_cycle_columns.js -> table_render.js ->
	render.js). Sharing the warning policy keeps these surfaces consistent.

	Reporting validity precedes convergence, then critical and material warnings,
	then the scientific/reliability flags. Informational notes alone do not qualify
	fractions.

	Do NOT widen the explicit false checks to "!== true". A result missing the field
	entirely (no fit yet) is not the same claim as one explicitly marked
	invalid, and absence of validation must never be reported as validation.

Input:
	result [object|null|undefined]: a normalized cell-cycle result

Output:
	reason [string]: a short human-readable reason, or "" when the fraction
	carries no trust caveat

*/
export function fraction_trust_reason(result) {
  if (result?.validForReporting === false) return "unvalidated result";
  if (result?.converged === false) return "fit did not converge";
  if (result?.warnings?.some(critical_warning)) return "fit has critical reliability warnings";
  if (result?.warnings?.some(material_warning)) return "fit has reliability warnings";
  if (result?.limitedReliability === true) return "fit has limited reliability";
  if (result?.scientificallyValid === false) return "fit is not scientifically valid";
  return "";
}
