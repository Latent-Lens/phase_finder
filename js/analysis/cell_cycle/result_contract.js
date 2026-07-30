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
});

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
const QC_CRITICAL_REMOVAL_PERCENT = 50;

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

  const qc = {
    structural: qc_outcome(state?.structuralQC, qcWaivers.structural),
    time: qc_outcome(state?.timeQC, qcWaivers.time),
    scatter: qc_outcome(state?.scatterGate, qcWaivers.scatter),
    singlet: qc_outcome(state?.singletResult, qcWaivers.singlet),
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
    // rather than passing with only a transient warning.
    if (Number.isFinite(outcome.percentRemoved) && outcome.percentRemoved > QC_CRITICAL_REMOVAL_PERCENT && !qcAcknowledgements[name]) {
      reasons.push(issue(
        RESULT_REASON.QC_CRITICAL_REMOVAL,
        `${name} QC removed ${Math.round(outcome.percentRemoved)}% of events — acknowledge this critical loss before reporting.`,
        { name, percentRemoved: outcome.percentRemoved },
      ));
    }
  }
  if (!configuration || typeof configuration !== "object" || Array.isArray(configuration) || has_nonfinite_number(configuration)) {
    reasons.push(issue(RESULT_REASON.CONFIG_INVALID, "Model configuration must be an object containing only finite numbers."));
  }

  return {
    passed: reasons.length === 0,
    reasons,
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

export function apply_result_contract(rawResult, preflight) {
  const result = { ...rawResult };
  const reasons = [...(preflight?.reasons ?? [])];
  const cancelled = result.cancelled === true;
  const optimizerConverged = result.kind === "decomposition" ? null : result.converged === true;
  const expected = result.expectedCounts ?? [];
  const finite = (Array.isArray(expected) || ArrayBuffer.isView(expected))
    && expected.length > 0 && [...expected].every((value) => Number.isFinite(value) && value >= 0);
  const diagnostics = result.diagnostics ?? {};
  const diagnosticsFinite = !has_nan_number(diagnostics)
    && ["deviance", "bic", "reducedDeviance"].every(
      (key) => diagnostics[key] === undefined || Number.isFinite(diagnostics[key]),
    );

  if (cancelled) reasons.push(issue(RESULT_REASON.FIT_CANCELLED, "Fitting was cancelled."));
  if (optimizerConverged === false) reasons.push(issue(RESULT_REASON.OPTIMIZER_NOT_CONVERGED, "The optimizer did not converge.", { terminationReason: result.terminationReason ?? result.convergenceReason ?? null }));
  if (!finite || !diagnosticsFinite) reasons.push(issue(
    RESULT_REASON.RESULT_NONFINITE,
    !finite ? "Expected counts are missing, negative, or non-finite." : "Diagnostics contain a non-finite number.",
  ));
  if (!valid_fractions(result.phaseFractions)) reasons.push(issue(RESULT_REASON.FRACTIONS_INVALID, "Phase fractions are missing or invalid."));

  // SCI-03/GATE-01 honesty (fix for the VALID-01 DJF S-overfit): a fit that
  // converged to a boundary-degenerate optimum -- a biological peak whose CV was
  // driven to its upper bound -- is computed and "converged" but its phase
  // fractions are not trustworthy. Mark it limited-reliability so it is NOT
  // valid for reporting (it stays a diagnostic preview, not an authoritative
  // result), rather than silently presenting the degenerate numbers.
  const degeneratePeakCv = optimizerConverged === null ? null : peak_cv_at_upper_bound(result);
  if (degeneratePeakCv) reasons.push(issue(
    RESULT_REASON.FIT_PEAK_DEGENERATE,
    `The ${degeneratePeakCv === "g1CV" ? "G1" : "G2"} peak width hit its upper CV bound — the component is a broad slab, not a resolved peak, so the phase fractions are unreliable.`,
    { parameter: degeneratePeakCv, value: result.parameters?.[degeneratePeakCv], bound: result.bounds?.[degeneratePeakCv] ?? null },
  ));

  const scientificallyValid = !cancelled && finite && diagnosticsFinite && valid_fractions(result.phaseFractions)
    && optimizerConverged !== false;
  const limitedReliability = Boolean(degeneratePeakCv);
  return {
    ...result,
    computed: !cancelled,
    optimizerConverged,
    scientificallyValid,
    limitedReliability,
    validForReporting: Boolean(preflight?.passed && scientificallyValid && !limitedReliability),
    cancelled,
    invalid: !preflight?.passed || !scientificallyValid,
    validityReasons: reasons,
    preflight,
  };
}

export function is_reportable_result(result) {
  return result?.validForReporting === true;
}
