// DOMAIN-01: the analysis domain and bin grid are scientific inputs, not display
// settings, so this module treats them as such in two ways.
//
// 1. domainCoverageAudit() -- cheap, runs on every fit. Turns the histogram's
//    own provenance (underflow/overflow/binnedCount) and each component's
//    in-domain versus total area into two explicit numbers: what fraction of the
//    OBSERVED events the domain excluded, and what fraction of the MODELLED mass
//    falls outside it. Both are compared against documented thresholds so a
//    result computed on a domain that hid a meaningful part of the sample is
//    qualified rather than silently reported.
//
// 2. analyzeDomainSensitivity() -- expensive, opt-in. Refits the same sample
//    across the supported bin counts and a set of bounded domain perturbations
//    and reports how far the phase fractions and the model choice actually moved.
//    A fit whose answer depends on the arbitrary part of its domain is not a
//    measurement of the sample, and this is what shows that.
//
// Nothing here re-derives a model equation; it only re-runs the caller's fit
// function at perturbed inputs and compares the answers.

import { generateHistogram } from "../pipeline/dna_histogram.js";

// ---------------------------------------------------------------------------
// Documented thresholds (DOMAIN-01 box: "define warning/invalid thresholds for
// excluded observed events and modeled mass"). These are declared policy, NOT
// calibrated probabilities -- they say what PhaseFinder treats as acceptable,
// and each has a stated rationale so a reviewer can disagree with a number
// rather than guess at an implicit one.
// ---------------------------------------------------------------------------

// Observed events pushed outside the analysis domain (underflow + overflow).
// Below 0.5% the excluded tail cannot move a phase fraction by more than a
// rounding digit even if every excluded event belonged to one phase. Above 5%
// the domain has removed a material part of the sample and the fractions are no
// longer fractions OF THE SAMPLE.
export const EXCLUDED_OBSERVED_WARNING_FRACTION = 0.005;
export const EXCLUDED_OBSERVED_INVALID_FRACTION = 0.05;

// Fitted component mass lying outside the analysis domain. The warning level
// matches diagnostics.js's per-component tailMassWarning threshold so the two
// agree. Above 10% the reported total-area fractions are dominated by
// extrapolated, unobserved mass.
export const MODELLED_TAIL_WARNING_FRACTION = 0.02;
export const MODELLED_TAIL_INVALID_FRACTION = 0.10;

// Sensitivity tolerances (DOMAIN-01 box: "block/qualify results whose phase
// fractions/model choice exceed documented sensitivity tolerances"). A phase
// fraction that moves by more than 2 percentage points purely from re-binning
// within the supported range is not resolved to the precision it is displayed
// at; beyond 5pp it is not a measurement at all. Both are stated in the same
// units the UI shows.
export const FRACTION_SENSITIVITY_WARNING_PP = 2;
export const FRACTION_SENSITIVITY_INVALID_PP = 5;

const worst = (...statuses) => statuses.includes("invalid")
  ? "invalid"
  : statuses.includes("warning") ? "warning" : "ok";

function classify(value, warningAt, invalidAt) {
  if (!Number.isFinite(value)) return "unknown";
  if (value >= invalidAt) return "invalid";
  if (value >= warningAt) return "warning";
  return "ok";
}

/*

Purpose:
	Records exactly how much of the sample and of the fitted model the chosen
	analysis domain left out, and classifies both against the documented
	thresholds above. Runs on every fit -- it reads numbers the histogram and the
	components already carry and does no refitting.

Input:
	spec [object]: { histogramProvenance (the result's stored domain/bin/
	               underflow/overflow block), components (the normalized result's
	               component array, each with totalArea and observedDomainArea) }

Output:
	audit [object]: { excludedObserved: { count, fraction, status },
	                  modelledTail: { fraction, status, byComponent },
	                  componentTailCoverage, status, warnings }

*/
export function domainCoverageAudit({ histogramProvenance, components = [] } = {}) {
  const provenance = histogramProvenance ?? {};
  const underflow = Number(provenance.underflow) || 0;
  const overflow = Number(provenance.overflow) || 0;
  const retained = Number(provenance.retainedCount) || 0;
  const excludedCount = underflow + overflow;
  const excludedFraction = retained > 0 ? excludedCount / retained : NaN;
  const excludedStatus = classify(
    excludedFraction, EXCLUDED_OBSERVED_WARNING_FRACTION, EXCLUDED_OBSERVED_INVALID_FRACTION);

  // Per-component coverage: what fraction of the component's own fitted area the
  // observed domain actually contains. A decomposition component whose
  // "totalArea" IS its in-domain sum trivially reports 1.
  const componentTailCoverage = {};
  const byComponent = {};
  let worstTail = 0;
  for (const component of components) {
    const total = Number(component?.totalArea);
    const inDomain = Number(component?.observedDomainArea);
    if (!(total > 0) || !Number.isFinite(inDomain)) continue;
    const coverage = Math.min(1, Math.max(0, inDomain / total));
    componentTailCoverage[component.id] = coverage;
    const tail = 1 - coverage;
    byComponent[component.id] = {
      coverage,
      tailFraction: tail,
      status: classify(tail, MODELLED_TAIL_WARNING_FRACTION, MODELLED_TAIL_INVALID_FRACTION),
    };
    if (tail > worstTail) worstTail = tail;
  }
  const tailStatus = Object.keys(byComponent).length
    ? classify(worstTail, MODELLED_TAIL_WARNING_FRACTION, MODELLED_TAIL_INVALID_FRACTION)
    : "unknown";

  const warnings = [];
  if (excludedStatus === "warning" || excludedStatus === "invalid") {
    warnings.push({
      code: excludedStatus === "invalid" ? "domain_excludes_observed_events" : "domain_excludes_some_observed_events",
      severity: excludedStatus === "invalid" ? "error" : "warning",
      message: `The analysis domain excluded ${excludedCount} of ${retained} retained events `
        + `(${(excludedFraction * 100).toFixed(2)}%${underflow ? `, ${underflow} below` : ""}${overflow ? `, ${overflow} above` : ""}); `
        + "the reported fractions describe only the events inside the domain.",
    });
  }
  if (tailStatus === "invalid") {
    warnings.push({
      code: "modelled_mass_outside_domain",
      severity: "error",
      message: `A fitted component places ${(worstTail * 100).toFixed(1)}% of its area outside the analysis domain; `
        + "the total-area phase fractions are dominated by unobserved extrapolation.",
    });
  }

  return {
    excludedObserved: { count: excludedCount, underflow, overflow, retained, fraction: excludedFraction, status: excludedStatus },
    modelledTail: { fraction: worstTail, status: tailStatus, byComponent },
    componentTailCoverage,
    status: worst(excludedStatus, tailStatus),
    thresholds: {
      excludedObservedWarning: EXCLUDED_OBSERVED_WARNING_FRACTION,
      excludedObservedInvalid: EXCLUDED_OBSERVED_INVALID_FRACTION,
      modelledTailWarning: MODELLED_TAIL_WARNING_FRACTION,
      modelledTailInvalid: MODELLED_TAIL_INVALID_FRACTION,
    },
    warnings,
  };
}

// The bin counts and domain perturbations a sensitivity run sweeps by default.
// Bin counts span the supported UI range around the typical default; the domain
// perturbations shrink/grow the domain by a fraction of its width from each
// side, which is the kind of change a user makes when they set an explicit axis
// range rather than accepting the full DNA support.
export const DEFAULT_SENSITIVITY_BIN_COUNTS = Object.freeze([64, 128, 256]);
export const DEFAULT_DOMAIN_PERTURBATIONS = Object.freeze([
  { label: "baseline", left: 0, right: 0 },
  { label: "trim 2% left", left: 0.02, right: 0 },
  { label: "trim 2% right", left: 0, right: 0.02 },
  { label: "trim 2% both", left: 0.02, right: 0.02 },
]);

/*

Purpose:
	DOMAIN-01 sensitivity analysis. Refits the same events across several bin
	counts and bounded domain perturbations and reports how far the reported
	answer moved, so a fit whose phase fractions or model choice depend on the
	arbitrary part of the domain can be qualified or blocked rather than reported
	at full apparent precision.

	Deliberately opt-in: it costs one full fit per variant, so callers run it when
	they need the evidence (a reviewer, a validation run, an export gate), not on
	every keystroke.

Input:
	spec [object]: {
	  values [array]: the retained DNA values to re-bin (NOT a prebuilt histogram
	    -- re-binning is the point),
	  domain [object]: { min, max } the baseline analysis domain,
	  fitFn [function]: (histogram) -> { phaseFractions, modelId } for one variant,
	  binCounts [array]: bin counts to sweep,
	  perturbations [array]: [{ label, left, right }] fractions of the domain
	    width to trim from each side }

Output:
	analysis [object]: { variants, baseline, maxShiftPercentagePoints, byPhase,
	                     modelChoices, modelChoiceStable, status, warnings }

*/
export function analyzeDomainSensitivity({
  values,
  domain,
  fitFn,
  binCounts = DEFAULT_SENSITIVITY_BIN_COUNTS,
  perturbations = DEFAULT_DOMAIN_PERTURBATIONS,
} = {}) {
  if (typeof fitFn !== "function") throw new TypeError("analyzeDomainSensitivity requires a fitFn.");
  if (!values?.length) throw new TypeError("analyzeDomainSensitivity requires the retained DNA values.");
  const min = Number(domain?.min);
  const max = Number(domain?.max);
  if (!Number.isFinite(min) || !Number.isFinite(max) || !(max > min)) {
    throw new RangeError("analyzeDomainSensitivity requires a finite domain with max > min.");
  }
  const width = max - min;

  const variants = [];
  for (const perturbation of perturbations) {
    const variantMin = min + width * (perturbation.left ?? 0);
    const variantMax = max - width * (perturbation.right ?? 0);
    if (!(variantMax > variantMin)) continue;
    for (const binCount of binCounts) {
      const histogram = generateHistogram(values, null, { binCount, range: [variantMin, variantMax] });
      let outcome = null;
      let error = null;
      try {
        outcome = fitFn(histogram);
      } catch (thrown) {
        error = thrown?.message ?? String(thrown);
      }
      variants.push({
        label: `${perturbation.label} @ ${binCount} bins`,
        binCount,
        domain: { min: variantMin, max: variantMax },
        phaseFractions: outcome?.phaseFractions ?? null,
        modelId: outcome?.modelId ?? null,
        error,
      });
    }
  }

  const usable = variants.filter((variant) => variant.phaseFractions && !variant.error);
  const baseline = usable[0] ?? null;
  const byPhase = { g1: 0, s: 0, g2: 0 };
  if (baseline) {
    for (const key of ["g1", "s", "g2"]) {
      let spread = 0;
      for (const variant of usable) {
        const shift = Math.abs((variant.phaseFractions[key] ?? NaN) - (baseline.phaseFractions[key] ?? NaN));
        if (Number.isFinite(shift) && shift > spread) spread = shift;
      }
      byPhase[key] = 100 * spread;
    }
  }
  const maxShiftPercentagePoints = Math.max(byPhase.g1, byPhase.s, byPhase.g2);

  const modelChoices = [...new Set(usable.map((variant) => variant.modelId).filter(Boolean))];
  const modelChoiceStable = modelChoices.length <= 1;

  const fractionStatus = usable.length < 2
    ? "unknown"
    : classify(maxShiftPercentagePoints, FRACTION_SENSITIVITY_WARNING_PP, FRACTION_SENSITIVITY_INVALID_PP);
  const modelStatus = modelChoiceStable ? "ok" : "warning";

  const warnings = [];
  if (fractionStatus === "warning" || fractionStatus === "invalid") {
    warnings.push({
      code: fractionStatus === "invalid" ? "domain_sensitivity_excessive" : "domain_sensitivity_material",
      severity: fractionStatus === "invalid" ? "error" : "warning",
      message: `Re-binning and bounded domain trims move a phase fraction by up to `
        + `${maxShiftPercentagePoints.toFixed(1)} percentage points `
        + `(tolerance: warn at ${FRACTION_SENSITIVITY_WARNING_PP}pp, block at ${FRACTION_SENSITIVITY_INVALID_PP}pp); `
        + "the reported precision is not supported by the data.",
    });
  }
  if (!modelChoiceStable) {
    warnings.push({
      code: "domain_sensitivity_model_choice",
      severity: "warning",
      message: `Automatic model selection is not stable across the sweep (chose ${modelChoices.join(", ")}); `
        + "the selected model is an artifact of the bin grid or domain, not of the data.",
    });
  }

  return {
    variants,
    baseline,
    byPhase,
    maxShiftPercentagePoints,
    modelChoices,
    modelChoiceStable,
    status: worst(fractionStatus, modelStatus),
    tolerances: {
      fractionWarningPercentagePoints: FRACTION_SENSITIVITY_WARNING_PP,
      fractionInvalidPercentagePoints: FRACTION_SENSITIVITY_INVALID_PP,
    },
    warnings,
  };
}
